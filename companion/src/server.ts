/** Local HTTP + WebSocket surface for the browser extension. */

import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CompanionConfig } from './config'
import { baiduConfigured, configFilePath, loadStoredBaiduCredentials, saveStoredBaiduCredentials } from './config'
import { AsrSession } from './session'
import { isCompanionClientMessage } from '../../shared/src/companion-protocol'

export type CompanionServerHandle = {
  port: number
  close: () => Promise<void>
}

function log(event: string): void {
  console.log(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} ${event}`)
}

const MAX_FRAME_BYTES = 64 * 1024
const MAX_CONFIG_BODY_BYTES = 16 * 1024

function maskSecret(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}****${value.slice(-2)}`
}

/** Extension pages fetch these endpoints cross-origin; allow them explicitly. */
function corsHeaders(req: import('node:http').IncomingMessage): Record<string, string> {
  const origin = req.headers.origin
  if (origin === undefined) return {}
  let allowed = false
  try {
    const parsed = new URL(origin)
    allowed = parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:'
      || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))
  } catch {
    allowed = false
  }
  return allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}
}

function credentialInput(value: unknown): { appId: string; apiKey: string; secretKey: string; devPid?: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { appId?: unknown; apiKey?: unknown; secretKey?: unknown; devPid?: unknown }
  const { appId, apiKey, secretKey } = record
  const valid = (input: unknown): input is string => typeof input === 'string' && input.trim() !== '' && input.length <= 256
  if (!valid(appId) || !valid(apiKey) || !valid(secretKey)) return null
  if (record.devPid !== undefined && (typeof record.devPid !== 'number' || !Number.isSafeInteger(record.devPid) || record.devPid <= 0)) return null
  return {
    appId: appId.trim(),
    apiKey: apiKey.trim(),
    secretKey: secretKey.trim(),
    ...(record.devPid === undefined ? {} : { devPid: record.devPid }),
  }
}

async function readJsonBody(req: import('node:http').IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body exceeds the limit')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startCompanionServer(
  config: CompanionConfig,
  options: {
    fetcher?: typeof fetch | undefined
    now?: (() => number) | undefined
    socketFactory?: ((url: string) => WebSocket) | undefined
    configFilePath?: string | undefined
  } = {},
): Promise<CompanionServerHandle> {
  // Credentials saved from the settings page live in a local file; env vars
  // keep precedence so headless setups are unaffected.
  const stored = await loadStoredBaiduCredentials(options.configFilePath ?? configFilePath())
  if (stored !== null) {
    config.baidu.appId ??= stored.appId
    config.baidu.apiKey ??= stored.apiKey
    config.baidu.secretKey ??= stored.secretKey
  }
  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0] ?? '/'
    const cors = corsHeaders(request)
    const sendJson = (status: number, body: unknown): void => {
      const content = JSON.stringify(body)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(content),
        ...cors,
      })
      response.end(content)
    }
    if (request.method === 'OPTIONS' && (path === '/health' || path === '/config' || path === '/log' || path === '/proxy/audio')) {
      response.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }
    if (request.method === 'GET' && (path === '/health' || path === '/health/')) {
      sendJson(200, {
        ok: true,
        provider: config.provider,
        configured: baiduConfigured(config.baidu),
        configApi: true,
      })
      return
    }
    if (path === '/config' || path === '/config/') {
      // The settings page reads a redacted view; credentials set here are
      // stored on this machine only and never echoed back in clear.
      if (request.method === 'GET') {
        const baidu = config.baidu
        sendJson(200, {
          ok: true,
          value: {
            provider: config.provider,
            baidu: {
              configured: baiduConfigured(config.baidu),
              appId: baidu.appId ?? null,
              apiKeyMasked: maskSecret(baidu.apiKey),
              apiKeyLength: baidu.apiKey?.length ?? null,
              secretKeySet: baidu.secretKey !== undefined,
              secretKeyLength: baidu.secretKey?.length ?? null,
              devPid: baidu.devPid,
            },
          },
        })
        return
      }
      if (request.method === 'POST') {
        if ((request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? '') !== 'application/json') {
          sendJson(415, { ok: false, error: { code: 'invalid-request', message: 'JSON required' } })
          return
        }
        let input: ReturnType<typeof credentialInput>
        try {
          input = credentialInput(await readJsonBody(request, MAX_CONFIG_BODY_BYTES))
        } catch {
          sendJson(400, { ok: false, error: { code: 'invalid-request', message: 'MomentQ companion received an invalid config body' } })
          return
        }
        if (input === null) {
          sendJson(400, { ok: false, error: { code: 'invalid-request', message: 'appId / apiKey / secretKey 都是必填的字符串' } })
          return
        }
        // The upstream casts appId to a number for the START frame; a
        // non-numeric value would surface as a cryptic Baidu error later.
        if (!/^\d+$/.test(input.appId)) {
          sendJson(400, { ok: false, error: { code: 'invalid-request', message: 'App ID 必须是纯数字' } })
          return
        }
        config.baidu = {
          appId: input.appId,
          apiKey: input.apiKey,
          secretKey: input.secretKey,
          devPid: input.devPid ?? config.baidu.devPid,
        }
        try {
          await saveStoredBaiduCredentials(options.configFilePath ?? configFilePath(), {
            appId: config.baidu.appId!,
            apiKey: config.baidu.apiKey!,
            secretKey: config.baidu.secretKey!,
            devPid: config.baidu.devPid,
          })
        } catch (error) {
          // A disk failure must not masquerade as a user input error.
          console.error(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} 凭据写入失败：`, error instanceof Error ? error.message : String(error))
          sendJson(500, { ok: false, error: { code: 'storage-failed', message: '凭据无法写入本机磁盘：请检查文件权限与剩余空间' } })
          return
        }
        sendJson(200, { ok: true, value: { saved: true } })
        return
      }
      sendJson(405, { ok: false, error: { code: 'invalid-request', message: 'GET or POST required' } })
      return
    }
    // Audio fetch proxy for offline pre-transcription: the Bilibili CDN
    // requires both a browser UA and a bilibili.com Referer, and the
    // extension's contexts can set neither (both are protected headers).
    // Node has full header control, and this stays on the user's machine.
    if (path === '/proxy/audio' || path === '/proxy/audio/') {
      if (request.method !== 'GET') {
        sendJson(405, { ok: false, error: { code: 'invalid-request', message: 'GET required' } })
        return
      }
      const target = new URL(request.url ?? '/', 'http://x').searchParams.get('url')
      if (target === null || !/^https:\/\/([^/]*\.)?(bilivideo\.com|akamaized\.net)\//.test(target)) {
        sendJson(400, { ok: false, error: { code: 'invalid-request', message: 'url must be a Bilibili CDN audio URL' } })
        return
      }
      try {
        const upstream = await (options.fetcher ?? fetch)(target, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            referer: 'https://www.bilibili.com/',
          },
        })
        if (!upstream.ok || upstream.body === null) {
          sendJson(502, { ok: false, error: { code: 'upstream-failed', message: `CDN returned HTTP ${upstream.status}` } })
          return
        }
        // Chromium logs a console warning for every response that lacks
        // Content-Length ("Unable to determine content-length…"). Buffer the
        // audio (a few dozen MB on the local loopback) so the browser always
        // receives an explicit length.
        const reader = upstream.body.getReader()
        const chunks: Buffer[] = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(Buffer.from(value))
        }
        const body = Buffer.concat(chunks)
        response.writeHead(200, {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'content-length': String(body.length),
          ...(request.headers.origin === undefined ? {} : { 'access-control-allow-origin': request.headers.origin }),
        })
        response.end(body)
      } catch (error) {
        if (!response.headersSent) {
          sendJson(502, { ok: false, error: { code: 'upstream-failed', message: error instanceof Error ? error.message : String(error) } })
        } else {
          response.end()
        }
      }
      return
    }
    // Browser-side telemetry: the extension reports its ASR pipeline failures
    // here so local logs carry the exact in-browser error text.
    if (path === '/log' || path === '/log/') {
      if (request.method === 'POST') {
        // Cross-site fetch with a JSON content-type would trigger CORS
        // preflight (which we reject); only same-origin-style simple
        // requests skip it, so the content-type must be pinned here too.
        if ((request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? '') !== 'application/json') {
          sendJson(415, { ok: false, error: { code: 'invalid-request', message: 'JSON required' } })
          return
        }
        try {
          const parsed: unknown = await readJsonBody(request, MAX_CONFIG_BODY_BYTES)
          const message = typeof parsed === 'object' && parsed !== null
            && typeof (parsed as { message?: unknown }).message === 'string'
            ? (parsed as { message: string }).message.slice(0, 2_000)
            : ''
          if (message !== '') log(`[extension] ${message.replace(/[\r\n]+/g, ' | ')}`)
          sendJson(200, { ok: true, value: { logged: true } })
        } catch {
          sendJson(400, { ok: false, error: { code: 'invalid-request', message: 'invalid log body' } })
        }
        return
      }
      sendJson(405, { ok: false, error: { code: 'invalid-request', message: 'POST required' } })
      return
    }
    sendJson(404, { ok: false, error: { code: 'not-found', message: 'unknown MomentQ companion endpoint' } })
  })
  // WebSocket upgrades are gated on Origin: browsers do NOT apply CORS to
  // WebSocket dialing, so without this every web page the user visits could
  // open ws://127.0.0.1:3090 and burn the user's paid Baidu quota (a valid
  // `start` + arbitrary audio is all it takes). Only extension pages pass.
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  server.on('upgrade', (request, socket, head) => {
    let allowed = false
    try {
      const parsed = new URL(request.headers.origin ?? '')
      allowed = parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:'
    } catch {
      allowed = false
    }
    if (!allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request)
    })
  })

  webSocketServer.on('connection', (socket: WebSocket) => {
    log('extension WebSocket 已连接')
    let session: AsrSession | undefined
    socket.on('close', () => {
      log('extension WebSocket 已断开')
      void session?.stop()
    })
    socket.on('error', () => {
      log('extension WebSocket 错误')
      void session?.stop()
    })
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        void session?.feedAudio(Buffer.from(data as ArrayBuffer))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(data.toString())
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid-message', message: 'MomentQ companion received an invalid message' }))
        return
      }
      if (!isCompanionClientMessage(message)) {
        socket.send(JSON.stringify({ type: 'error', code: 'invalid-message', message: 'MomentQ companion received an invalid message' }))
        return
      }
      if (message.type === 'start') {
        if (session !== undefined) return
        log(`收到 start（${message.identity.kind}）`)
        if (!baiduConfigured(config.baidu)) {
          log('拒绝：百度凭据缺失（provider-not-configured）')
          socket.send(JSON.stringify({
            type: 'error',
            code: 'provider-not-configured',
            message: '百度 ASR 未配置：请在 companion 进程环境提供 BAIDU_ASR_APP_ID / BAIDU_ASR_API_KEY / BAIDU_ASR_SECRET_KEY',
          }))
          socket.close()
          return
        }
        session = new AsrSession({
          identity: message.identity,
          baidu: {
            appId: config.baidu.appId!,
            apiKey: config.baidu.apiKey!,
            secretKey: config.baidu.secretKey!,
            devPid: config.baidu.devPid,
          },
          hostBaseUrl: config.hostBaseUrl,
          provider: config.provider,
          fetcher: options.fetcher,
          now: options.now,
          socketFactory: options.socketFactory,
        }, {
          send: message => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
          },
        })
      }
      if (session !== undefined) void session.handleClientMessage(message)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address !== null ? address.port : config.port
      resolve({
        port: boundPort,
        close: async () => {
          for (const client of webSocketServer.clients) client.terminate()
          await new Promise<void>(resolveClose => webSocketServer.close(() => resolveClose()))
          // Upgraded WebSocket sockets keep the HTTP server's close callback
          // pending; force any stragglers shut.
          server.closeAllConnections()
          await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        },
      })
    })
  })
}
