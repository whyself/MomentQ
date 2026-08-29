/**
 * Side-panel capture session: the panel page is an extension surface with
 * its own click gesture, and consuming the tab-capture stream in the SAME
 * context that acquired the stream id is the pattern Edge actually honors
 * (its offscreen document fails with "Error starting tab capture").
 *
 * Two engines live behind this one surface:
 *  - 'baidu'   streams 16 kHz PCM to the local companion → Baidu realtime ASR
 *  - 'whisper' runs transformers.js Whisper locally in this document (the
 *              offline fallback: no companion, no cloud key, no proxy)
 *
 * The floating page ball and the panel button pause/resume via the background.
 */

import type {
  BilibiliContext,
} from '../shared/protocol'
import { isCompanionServerMessage } from '../../../shared/src/companion-protocol'
import { floatToInt16, int16ToBuffer, resampleLinear } from '../offscreen/pcm'
import { transcribeChunk, type WhisperModel } from './asr-whisper'

export type PanelSessionStart = {
  tabId: number
  streamId: string
  identity: BilibiliContext['identity']
  companionBaseUrl: string
  engine: 'baidu' | 'whisper'
  whisperModel: WhisperModel
}

type WhisperRuntime = {
  model: WhisperModel
  pending: Float32Array
  processing: boolean
  paused: boolean
  totalSamples: number
  lastMediaSeconds: number | null
}

type RunningSession = {
  tabId: number
  stream: MediaStream
  context: AudioContext
  socket: WebSocket | undefined
  whisper: WhisperRuntime | undefined
}

const WHISPER_CHUNK_SAMPLES = 5 * 16_000

let session: RunningSession | undefined

function postToBackground(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {})
}

function reportEvent(tabId: number, event: import('../../../shared/src/companion-protocol').CompanionServerMessage): void {
  postToBackground({ type: 'MOMENTQ_ASR_EVENT', tabId, event })
}

/** Feed the media clock that anchors transcript rows to the video. */
export function sessionClock(seconds: number): void {
  if (session === undefined) return
  if (session.whisper !== undefined) {
    session.whisper.lastMediaSeconds = seconds
    return
  }
  if (session.socket !== undefined && session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({ type: 'clock', mediaTime: seconds }))
  }
}

export function panelSessionTabId(): number | null {
  return session?.tabId ?? null
}

export async function stopPanelSession(): Promise<void> {
  const current = session
  if (current === undefined) return
  session = undefined
  if (current.socket !== undefined) {
    try {
      if (current.socket.readyState === WebSocket.OPEN) {
        current.socket.send(JSON.stringify({ type: 'stop' }))
      }
      current.socket.close()
    } catch { /* the socket may already be gone */ }
  }
  for (const track of current.stream.getTracks()) track.stop()
  await current.context.close().catch(() => {})
  postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: null })
}

export function pausePanelSession(paused: boolean): void {
  if (session === undefined) return
  if (session.whisper !== undefined) {
    // Track disabling would feed silence into the chunker; hold the buffer
    // instead so resumed speech continues the same timeline.
    session.whisper.paused = paused
    return
  }
  session.stream.getAudioTracks().forEach(track => { track.enabled = !paused })
}

export async function startPanelSession(request: PanelSessionStart): Promise<void> {
  await stopPanelSession()
  try {
    // The streamId from chrome.tabCapture.getMediaStreamId() without a
    // consumerTabId is only consumable inside extension contexts.
    const captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: request.streamId },
      },
    } as unknown as MediaStreamConstraints)
    const context = new AudioContext({ sampleRate: 16_000 })
    await context.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'))
    const source = context.createMediaStreamSource(captureStream)
    const node = new AudioWorkletNode(context, 'momentq-capture')

    let socket: WebSocket | undefined
    if (request.engine === 'baidu') {
      socket = new WebSocket(toWebSocketUrl(request.companionBaseUrl))
      socket.binaryType = 'arraybuffer'
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data !== 'string') return
        let value: unknown
        try {
          value = JSON.parse(event.data)
        } catch {
          return
        }
        if (isCompanionServerMessage(value)) reportEvent(request.tabId, value)
      }
      socket.onclose = () => {
        reportEvent(request.tabId, {
          type: 'error',
          code: 'companion-disconnected',
          message: '与本地 companion 的连接已断开，转录已停止',
        })
        void stopPanelSession()
      }
      await new Promise<void>((resolve, reject) => {
        if (socket !== undefined && socket.readyState === WebSocket.OPEN) return resolve()
        socket?.addEventListener('open', () => resolve(), { once: true })
        socket?.addEventListener('error', () => reject(new Error('无法连接本地 companion')), { once: true })
      })
      socket.send(JSON.stringify({
        type: 'start',
        identity: request.identity,
      }))
    }

    const whisper: WhisperRuntime | undefined = request.engine === 'whisper'
      ? { model: request.whisperModel, pending: new Float32Array(0), processing: false, paused: false, totalSamples: 0, lastMediaSeconds: null }
      : undefined

    if (request.engine === 'baidu') {
      // Official pacing: 5120-byte (160ms) binary PCM frames shipped at 1x
      // realtime, and NEVER withhold frames during silence — the server drops
      // a connection that sees no audio for ~5s, so gating on silence kills
      // paused/silent passages.
      let sampleBuffer = new Float32Array(0)
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const chunk = event.data
        if (chunk === undefined || socket === undefined) return
        const atRate = context.sampleRate !== 16_000
          ? resampleLinear(chunk, context.sampleRate, 16_000)
          : chunk
        const merged = new Float32Array(sampleBuffer.length + atRate.length)
        merged.set(sampleBuffer)
        merged.set(atRate, sampleBuffer.length)
        sampleBuffer = merged
        const frameSamples = 2_560 // 160ms at 16kHz mono
        while (sampleBuffer.length >= frameSamples) {
          sendAudioFrame(socket, sampleBuffer.slice(0, frameSamples))
          sampleBuffer = sampleBuffer.slice(frameSamples)
        }
      }
    } else {
      // Local engine: accumulate ~5s chunks and transcribe sequentially.
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const chunk = event.data
        if (chunk === undefined || whisper === undefined) return
        const atRate = context.sampleRate !== 16_000
          ? resampleLinear(chunk, context.sampleRate, 16_000)
          : chunk
        if (whisper.paused) return
        const merged = new Float32Array(whisper.pending.length + atRate.length)
        merged.set(whisper.pending)
        merged.set(atRate, whisper.pending.length)
        whisper.pending = merged
        whisper.totalSamples += atRate.length
        if (whisper.pending.length >= WHISPER_CHUNK_SAMPLES) {
          const audio = whisper.pending
          whisper.pending = new Float32Array(0)
          void runWhisperChunk(request.tabId, audio, whisper)
        }
      }
    }
    source.connect(node)
    // Tab capture diverts the tab's audio: reconnect it to the output so the
    // user still hears the video while it is being transcribed.
    source.connect(context.destination)

    session = { tabId: request.tabId, stream: captureStream, context, socket, whisper }
    postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: request.tabId })
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    reportEvent(request.tabId, {
      type: 'error',
      code: 'capture-start',
      message: /tab capture/i.test(raw)
        ? '标签页采集启动失败：采集授权可能已随页面刷新失效，请重新通过右键菜单启动'
        : raw,
    })
    await stopPanelSession()
  }
}

async function runWhisperChunk(tabId: number, audio: Float32Array, runtime: WhisperRuntime): Promise<void> {
  if (runtime.processing) {
    // A previous inference is still running; drop the chunk rather than
    // queue unbounded (chunks are 5s — next one catches up).
    return
  }
  runtime.processing = true
  const chunkSeconds = audio.length / 16_000
  try {
    reportEvent(tabId, { type: 'partial', text: '本地识别中…' })
    const text = await transcribeChunk(audio, runtime.model, (status: string) => {
      reportEvent(tabId, { type: 'partial', text: status })
    })
    if (text !== '') {
      const endMedia = runtime.lastMediaSeconds ?? runtime.totalSamples / 16_000
      const startMedia = Math.max(0, endMedia - chunkSeconds)
      reportEvent(tabId, { type: 'final', start: startMedia, end: endMedia, text })
    }
  } catch (error) {
    reportEvent(tabId, {
      type: 'error',
      code: 'provider-connect',
      message: `本地 Whisper 识别失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    runtime.processing = false
  }
}

function sendAudioFrame(socket: WebSocket, samples: Float32Array): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(int16ToBuffer(floatToInt16(samples)))
}

function toWebSocketUrl(companionBaseUrl: string): string {
  const parsed = new URL(companionBaseUrl)
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsed.host}`
}
