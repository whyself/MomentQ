/**
 * Baidu realtime speech recognition upstream connection.
 *
 * One instance wraps one WebSocket to Baidu: OAuth token, START handshake,
 * binary PCM frames, partial/final sentence events, and graceful FINISH.
 * The endpoint and socket constructor are injectable so tests can run a
 * fake upstream without network access.
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

export type BaiduStreamEvent =
  | { kind: 'started' }
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'finished' }

export type BaiduStreamCallbacks = {
  onEvent: (event: BaiduStreamEvent) => void
  onError: (error: Error) => void
}

export type BaiduStreamConfig = {
  appId: string
  apiKey: string
  secretKey: string
  devPid: number
}

const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
const REALTIME_URL = 'wss://vop.baidu.com/realtime_asr'
const STARTED_TIMEOUT_MS = 25_000
const FINISH_GRACE_MS = 3_000
/** Renew the connection before Baidu's long-connection ceiling (plan: ~1 h). */
export const CONNECTION_MAX_AGE_MS = 55 * 60_000

type TokenCache = { accessToken: string; expiresAtMs: number }
const tokenCaches = new Map<string, TokenCache>()

/** Exchange API key/secret for an OAuth access token, cached until near expiry. */
export async function fetchBaiduAccessToken(
  config: BaiduStreamConfig,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  now: () => number = Date.now,
): Promise<string> {
  const cached = tokenCaches.get(config.apiKey)
  if (cached !== undefined && now() < cached.expiresAtMs) return cached.accessToken
  const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(config.apiKey)}&client_secret=${encodeURIComponent(config.secretKey)}`
  const response = await fetcher(url)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(`[momentq-companion] 百度 token 请求失败 HTTP ${response.status}：${body.slice(0, 300)}`)
    throw new Error(`Baidu token request failed with status ${response.status}`)
  }
  const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown }
  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    console.error('[momentq-companion] 百度 token 响应无 access_token：',
      `${String(payload.error ?? '?')} ${String(payload.error_description ?? '')}`.slice(0, 300))
    throw new Error('Baidu token response has no access_token')
  }
  const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : 2_592_000
  tokenCaches.set(config.apiKey, {
    accessToken: payload.access_token,
    expiresAtMs: now() + (expiresIn - 60) * 1000,
  })
  return payload.access_token
}

type IncomingFrame = { type?: unknown; data?: unknown }

/** Parse one upstream JSON frame into a stream event, or undefined when ignorable. */
export function parseBaiduFrame(raw: string): BaiduStreamEvent | { kind: 'error'; message: string } | undefined {
  // Measured: the server frames carry a trailing newline that breaks a naive
  // JSON.parse — strip whitespace first.
  let frame: IncomingFrame
  try {
    frame = JSON.parse(raw.trim()) as IncomingFrame
  } catch {
    return undefined
  }
  // Official realtime protocol: the server only ever sends MID_TEXT
  // (interim), FIN_TEXT (final / error) and HEARTBEAT. There is no
  // handshake-confirmation frame; "ready" is simply "START sent, audio
  // flowing". (https://ai.baidu.com/ai-doc/SPEECH/jlbxejt2i)
  if (frame.type === 'HEARTBEAT') return undefined
  if (frame.type === 'MID_TEXT' || frame.type === 'FIN_TEXT') {
    const envelope = frame as { type?: unknown; err_no?: unknown; err_msg?: unknown; result?: unknown }
    if (typeof envelope.err_no === 'number' && envelope.err_no !== 0) {
      return { kind: 'error', message: `Baidu ASR error ${envelope.err_no}: ${String(envelope.err_msg ?? '')}`.trim() }
    }
    const text = extractResultText(envelope.result)
    if (text === '') return undefined
    return envelope.type === 'FIN_TEXT' ? { kind: 'final', text } : { kind: 'partial', text }
  }
  return undefined
}

/** The result field is a plain string or a list of {src} fragments. */
function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result.trim()
  if (Array.isArray(result)) {
    return result.map(item => {
      if (typeof item === 'string') return item
      if (typeof item === 'object' && item !== null && typeof (item as { src?: unknown }).src === 'string') {
        return (item as { src: string }).src
      }
      return ''
    }).join('').trim()
  }
  return ''
}

export type BaiduStream = {
  sendAudio: (chunk: Buffer) => void
  finish: () => Promise<void>
  cancel: () => void
  ageMs: () => number
}

/** Connect, perform the START handshake, and return a ready stream. */
export async function openBaiduStream(
  config: BaiduStreamConfig,
  callbacks: BaiduStreamCallbacks,
  options: {
    fetcher?: typeof fetch | undefined
    now?: (() => number) | undefined
    socketFactory?: ((url: string) => WebSocket) | undefined
  } = {},
): Promise<BaiduStream> {
  const now = options.now ?? Date.now
  // Preflight the credentials through the OAuth endpoint so a misconfigured
  // key fails here with a clear error instead of an opaque WebSocket close.
  await fetchBaiduAccessToken(config, options.fetcher, now)
  const socket = (options.socketFactory ?? ((url: string) => new WebSocket(url)))(
    `${REALTIME_URL}?sn=${randomUUID()}`,
  )
  console.log(`[momentq-companion] 百度 WSS 已拨号：${REALTIME_URL.replace(/\?.*/, '')} (devPid ${config.devPid})`)
  socket.on('open', () => {
    console.log('[momentq-companion] 百度 WSS 已连上，等待 STARTED 确认帧…')
  })
  const openedAt = now()

  const sendJson = (value: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }

  // One message listener routes every frame: before STARTED it resolves the
  // handshake, afterwards it forwards recognition events exactly once.
  let resolveStarted: (() => void) | undefined
  let rejectStarted: ((error: Error) => void) | undefined
  const startedPromise = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
    const timer = setTimeout(
      () => reject(new Error('Baidu ASR STARTED handshake timed out')),
      STARTED_TIMEOUT_MS,
    )
    socket.once('close', () => {
      clearTimeout(timer)
      reject(new Error('Baidu ASR connection closed during handshake'))
    })
    socket.once('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return
    const event = parseBaiduFrame(data.toString())
    if (event === undefined) return
    if (event.kind === 'error') {
      callbacks.onError(new Error(event.message))
      return
    }
    callbacks.onEvent(event)
  })
  socket.on('error', (error: Error) => { callbacks.onError(error) })

  socket.on('open', () => {
    console.log(`[momentq-companion] 已发送 START（devPid ${config.devPid}），音频即刻上行`)
    sendJson({
      type: 'START',
      data: {
        appid: Number(config.appId),
        appkey: config.apiKey,
        dev_pid: config.devPid,
        cuid: `momentq-${randomUUID()}`,
        format: 'pcm',
        sample: 16_000,
      },
    })
    // Official protocol has no confirmation frame: readiness IS "START sent,
    // audio flowing". Resolving here lets the queued audio ship immediately —
    // the server drops the connection if no audio arrives within ~5s.
    resolveStarted?.()
    resolveStarted = undefined
  })

  await startedPromise

  return {
    sendAudio: (chunk: Buffer) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk)
    },
    finish: (): Promise<void> => new Promise((resolve) => {
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        socket.removeAllListeners()
        // The upstream must not outlive the session even if it never
        // acknowledges the FINISH frame.
        socket.terminate()
        resolve()
      }, FINISH_GRACE_MS)
      socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      sendJson({ type: 'FINISH', data: {} })
    }),
    cancel: () => {
      sendJson({ type: 'CANCEL', data: {} })
      socket.removeAllListeners()
      socket.close()
    },
    ageMs: () => now() - openedAt,
  }
}
