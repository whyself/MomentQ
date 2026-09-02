/**
 * Side-panel capture session — the FALLBACK host. The primary home of every
 * capture session is the offscreen document (it survives the panel closing);
 * on some Edge builds a tab-capture stream id is only consumable in the
 * context that minted it, and that is the panel: when the background's
 * offscreen start fails it retries with consumer:'panel', and this surface
 * hosts the session the old way — closing the panel then ends it, but
 * starting works.
 *
 * Two engines can live behind this one surface:
 *  - 'baidu'   streams 16 kHz PCM to the local companion → Baidu realtime ASR
 *  - 'whisper' runs the shared local-Whisper runtime (transformers.js,
 *              WebGPU) in this document
 *
 * The floating page ball and the panel button pause/resume via the background.
 */

import type {
  BilibiliContext,
} from '../shared/protocol'
import { isCompanionServerMessage } from '../../../shared/src/companion-protocol'
import { floatToInt16, int16ToBuffer, resampleLinear } from '../offscreen/pcm'
import { WhisperLiveSession } from '../shared/whisper-live'
import type { WhisperModel } from '../shared/asr-whisper'

export type PanelSessionStart = {
  tabId: number
  streamId: string
  identity: BilibiliContext['identity']
  companionBaseUrl: string
  engine: 'baidu' | 'whisper'
  whisperModel: WhisperModel
}

type RunningSession = {
  tabId: number
  stream: MediaStream
  context: AudioContext
  socket: WebSocket | undefined
  whisper: WhisperLiveSession | undefined
}

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
    // The runtime owns the pause guard and seek detection.
    session.whisper.clock(seconds)
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
  current.whisper?.dispose()
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
    session.whisper.setPaused(paused)
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

    const whisper: WhisperLiveSession | undefined = request.engine === 'whisper'
      ? new WhisperLiveSession(request.whisperModel, event => reportEvent(request.tabId, event))
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
      // sequentially (queue bounds, seek detection and staleness guards
      // live in the runtime — the same instance the offscreen host uses).
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const chunk = event.data
        if (chunk === undefined || whisper === undefined) return
        const atRate = context.sampleRate !== 16_000
          ? resampleLinear(chunk, context.sampleRate, 16_000)
          : chunk
        whisper.feed(atRate)
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

function sendAudioFrame(socket: WebSocket, samples: Float32Array): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(int16ToBuffer(floatToInt16(samples)))
}

function toWebSocketUrl(companionBaseUrl: string): string {
  const parsed = new URL(companionBaseUrl)
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsed.host}`
}
