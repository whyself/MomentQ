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
  /** Audio awaiting inference, in arrival order. */
  queue: Float32Array[]
  queuedSamples: number
  processing: boolean
  paused: boolean
  totalSamples: number
  lastMediaSeconds: number | null
  droppedChunks: number
}

type RunningSession = {
  tabId: number
  stream: MediaStream
  context: AudioContext
  socket: WebSocket | undefined
  whisper: WhisperRuntime | undefined
}

const WHISPER_CHUNK_SAMPLES = 5 * 16_000
// Bounded waiting room for audio produced while inference is busy (above all
// during the first model download, which can run for many minutes). Beyond
// this window the OLDEST audio is dropped with a visible counter instead of
// silently losing the session's opening — or growing without bound.
const WHISPER_MAX_QUEUE_SAMPLES = 60 * 16_000
// Upper bound on one inference call: merging minutes of audio hurts both
// latency and timestamp accuracy.
const WHISPER_MAX_UTTERANCE_SAMPLES = 30 * 16_000

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
    // While transcription is paused the video keeps playing; freezing the
    // clock keeps the resumed chunks' timestamps aligned with the audio that
    // will actually be transcribed instead of skipping the paused span.
    if (session.whisper.paused) return
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
    const socket = current.socket
    // Detach BEFORE closing: an intentional stop must not fall into the
    // onclose path and get reported to the user as a companion loss.
    socket.onclose = null
    socket.onmessage = null
    socket.onerror = null
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stop' }))
      }
      socket.close()
    } catch { /* the socket may already be gone */ }
  }
  for (const track of current.stream.getTracks()) track.stop()
  await current.context.close().catch(() => {})
  // stoppedTabId lets the background deactivate THIS tab even when its global
  // session pointer has already moved to a newer tab (start-over-start handoff).
  postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: null, stoppedTabId: current.tabId })
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
    // Register the partial session immediately: EVERY failure below tears
    // down through stopPanelSession, which only sees the module-level
    // session — assigning it only at the end used to leak the stream tracks
    // and the AudioContext on each failed start.
    session = { tabId: request.tabId, stream: captureStream, context, socket: undefined, whisper: undefined }
    await context.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'))
    const source = context.createMediaStreamSource(captureStream)
    const node = new AudioWorkletNode(context, 'momentq-capture')

    let socket: WebSocket | undefined
    if (request.engine === 'baidu') {
      socket = new WebSocket(toWebSocketUrl(request.companionBaseUrl))
      socket.binaryType = 'arraybuffer'
      session.socket = socket
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
      await new Promise<void>((resolve, reject) => {
        if (socket !== undefined && socket.readyState === WebSocket.OPEN) return resolve()
        socket?.addEventListener('open', () => resolve(), { once: true })
        socket?.addEventListener('error', () => reject(new Error(
          '无法连接本地 companion：请先运行 scripts\start-local.cmd 启动服务（或在设置把语音识别切换为本地 Whisper，无需 companion）',
        )), { once: true })
      })
      // Attach the loss handler only AFTER a successful open: a failed dial
      // fires 'error' and then 'close', and only a healthy connection may
      // report 'companion-disconnected'.
      socket.onclose = () => {
        reportEvent(request.tabId, {
          type: 'error',
          code: 'companion-disconnected',
          message: '与本地 companion 的连接已断开，转录已停止',
        })
        void stopPanelSession()
      }
      socket.send(JSON.stringify({
        type: 'start',
        identity: request.identity,
      }))
    }

    const whisper: WhisperRuntime | undefined = request.engine === 'whisper'
      ? { model: request.whisperModel, queue: [], queuedSamples: 0, processing: false, paused: false, totalSamples: 0, lastMediaSeconds: null, droppedChunks: 0 }
      : undefined
    session.whisper = whisper

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
      // Local engine: queue audio in arrival order and transcribe strictly
      // sequentially. Nothing is dropped while the model loads — the bounded
      // queue holds up to 60s and drains once inference is ready.
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const chunk = event.data
        if (chunk === undefined || whisper === undefined) return
        if (whisper.paused) return
        const atRate = context.sampleRate !== 16_000
          ? resampleLinear(chunk, context.sampleRate, 16_000)
          : chunk
        whisper.queue.push(atRate)
        whisper.queuedSamples += atRate.length
        whisper.totalSamples += atRate.length
        if (whisper.queuedSamples >= WHISPER_CHUNK_SAMPLES) void pumpWhisper(request.tabId, whisper)
      }
    }
    source.connect(node)
    // Tab capture diverts the tab's audio: reconnect it to the output so the
    // user still hears the video while it is being transcribed.
    source.connect(context.destination)

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
    // `session` was registered before any fallible step, so this rollback
    // always reaches the created stream/context/socket.
    await stopPanelSession()
  }
}

/** Drain the whisper queue sequentially; bounded, ordered, never parallel. */
async function pumpWhisper(tabId: number, runtime: WhisperRuntime): Promise<void> {
  if (runtime.processing) return
  runtime.processing = true
  try {
    while (runtime.queue.length > 0) {
      if (session?.whisper !== runtime) return // session ended or replaced
      // The reader keeps falling behind: drop the OLDEST audio with a
      // visible counter rather than growing without bound.
      while (runtime.queuedSamples > WHISPER_MAX_QUEUE_SAMPLES && runtime.queue.length > 1) {
        const dropped = runtime.queue.shift()
        if (dropped === undefined) break
        runtime.queuedSamples -= dropped.length
        runtime.droppedChunks += 1
        reportEvent(tabId, { type: 'partial', text: `推理跟不上播放，已跳过最早的 ${runtime.droppedChunks} 段音频` })
      }
      const pieces: Float32Array[] = []
      let samples = 0
      while (runtime.queue.length > 0 && samples < WHISPER_MAX_UTTERANCE_SAMPLES) {
        const next = runtime.queue.shift()
        if (next === undefined) break
        pieces.push(next)
        runtime.queuedSamples -= next.length
        samples += next.length
      }
      await transcribeUtterance(tabId, concatSamples(pieces), runtime)
    }
  } finally {
    runtime.processing = false
  }
}

async function transcribeUtterance(tabId: number, audio: Float32Array, runtime: WhisperRuntime): Promise<void> {
  const chunkSeconds = audio.length / 16_000
  try {
    reportEvent(tabId, { type: 'partial', text: '本地识别中…' })
    const text = await transcribeChunk(audio, runtime.model, (status: string) => {
      reportEvent(tabId, { type: 'partial', text: status })
    })
    // Attribute finals only while this runtime still owns the live session:
    // a slow inference must never land its text on a switched video.
    if (text !== '' && session?.whisper === runtime) {
      const endMedia = runtime.lastMediaSeconds ?? runtime.totalSamples / 16_000
      const startMedia = Math.max(0, endMedia - chunkSeconds)
      reportEvent(tabId, { type: 'final', start: startMedia, end: endMedia, text })
    }
  } catch (error) {
    if (session?.whisper !== runtime) return
    reportEvent(tabId, {
      type: 'error',
      code: 'provider-connect',
      message: `本地 Whisper 识别失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

function concatSamples(pieces: Float32Array[]): Float32Array {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const piece of pieces) {
    merged.set(piece, offset)
    offset += piece.length
  }
  return merged
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
