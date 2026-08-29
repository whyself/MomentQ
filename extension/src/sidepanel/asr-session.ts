/**
 * Side-panel capture session: the panel page is an extension surface with
 * its own click gesture, and consuming the tab-capture stream in the SAME
 * context that acquired the stream id is the pattern Edge actually honors
 * (its offscreen document fails with "Error starting tab capture").
 *
 * Recognition therefore lives here for as long as the panel is open; the
 * floating page ball and the panel button pause/resume via the background.
 */

import type {
  BilibiliContext,
} from '../shared/protocol'
import { isCompanionServerMessage } from '../../../shared/src/companion-protocol'
import { floatToInt16, int16ToBuffer, resampleLinear } from '../offscreen/pcm'

export type PanelSessionStart = {
  tabId: number
  streamId: string
  identity: BilibiliContext['identity']
  companionBaseUrl: string
}

type RunningSession = {
  tabId: number
  stream: MediaStream
  context: AudioContext
  socket: WebSocket
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
  if (session !== undefined && session.socket.readyState === WebSocket.OPEN) {
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
  try {
    if (current.socket.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: 'stop' }))
    }
    current.socket.close()
  } catch { /* the socket may already be gone */ }
  for (const track of current.stream.getTracks()) track.stop()
  await current.context.close().catch(() => {})
  postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: null })
}

export function pausePanelSession(paused: boolean): void {
  session?.stream.getAudioTracks().forEach(track => { track.enabled = !paused })
}

export async function startPanelSession(request: PanelSessionStart): Promise<void> {
  await stopSession()
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

    const socket = new WebSocket(toWebSocketUrl(request.companionBaseUrl))
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
      void stopSession()
    }

    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve()
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('无法连接本地 companion')), { once: true })
    })

    socket.send(JSON.stringify({
      type: 'start',
      identity: request.identity,
    }))

    // Official pacing: 5120-byte (160ms) binary PCM frames shipped at 1x
    // realtime, and NEVER withhold frames during silence — the server drops
    // a connection that sees no audio for ~5s, so gating on silence kills
    // paused/silent passages.
    let sampleBuffer = new Float32Array(0)
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data
      if (chunk === undefined) return
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
    source.connect(node)
    // Tab capture diverts the tab's audio: reconnect it to the output so the
    // user still hears the video while it is being transcribed.
    source.connect(context.destination)

    session = { tabId: request.tabId, stream: captureStream, context, socket }
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
    await stopSession()
  }
}

function sendAudioFrame(socket: WebSocket, samples: Float32Array): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(int16ToBuffer(floatToInt16(samples)))
}

async function stopSession(): Promise<void> {
  const current = session
  session = undefined
  if (current === undefined) return
  try {
    if (current.socket.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: 'stop' }))
    }
    current.socket.close()
  } catch { /* the socket may already be gone */ }
  for (const track of current.stream.getTracks()) track.stop()
  await current.context.close().catch(() => {})
  postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: null })
}

function toWebSocketUrl(companionBaseUrl: string): string {
  const parsed = new URL(companionBaseUrl)
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsed.host}`
}

