/**
 * Offscreen document: owns the tab-capture MediaStream and the companion
 * WebSocket so recognition keeps running while the side panel is closed.
 *
 * Audio is captured in a 16 kHz AudioContext (the browser resamples the tab
 * stream), silence-gated so a paused video stops feeding the recognition
 * stream, and sent as raw 16-bit PCM frames. Companion result messages are
 * relayed verbatim to the background service worker.
 */

import type {
  AsrStartMessage,
  AsrSessionMessage,
  AsrClockMessage,
} from '../shared/protocol'
import { isCompanionServerMessage } from '../../../shared/src/companion-protocol'
import { floatToInt16, int16ToBuffer, isSilent, resampleLinear } from './pcm'

type RunningSession = {
  tabId: number
  stream: MediaStream
  context: AudioContext
  socket: WebSocket
}

let session: RunningSession | undefined

function postToBackground(message: AsrSessionMessage | import('../shared/protocol').AsrEventMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {})
}

function reportEvent(tabId: number, event: import('../../../shared/src/companion-protocol').CompanionServerMessage): void {
  postToBackground({ type: 'MOMENTQ_ASR_EVENT', tabId, event })
}

async function startSession(request: AsrStartMessage): Promise<void> {
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

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data
      if (chunk === undefined || isSilent(chunk)) return
      if (context.sampleRate !== 16_000) {
        // Defensive fallback when the context could not run at 16 kHz.
        const resampled = resampleLinear(chunk, context.sampleRate, 16_000)
        sendAudioFrame(socket, resampled)
        return
      }
      sendAudioFrame(socket, chunk)
    }
    source.connect(node)
    // The worklet is a sink; do not connect it to destination (that would
    // echo tab audio back into the speakers).

    session = { tabId: request.tabId, stream: captureStream, context, socket }
    postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: request.tabId })
  } catch (error) {
    reportEvent(request.tabId, {
      type: 'error',
      code: 'capture-start',
      message: error instanceof Error ? error.message : '音频捕获启动失败',
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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return false
  const type = (message as { type?: unknown }).type
  if (type === 'MOMENTQ_ASR_START') {
    void startSession(message as AsrStartMessage)
    return false
  }
  if (type === 'MOMENTQ_ASR_CLOCK') {
    const clock = message as AsrClockMessage
    if (session !== undefined && session.tabId === clock.tabId
      && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'clock', mediaTime: clock.mediaTime }))
    }
    return false
  }
  if (type === 'MOMENTQ_ASR_PAUSE') {
    session?.stream.getAudioTracks().forEach(track => { track.enabled = false })
    return false
  }
  if (type === 'MOMENTQ_ASR_RESUME') {
    session?.stream.getAudioTracks().forEach(track => { track.enabled = true })
    return false
  }
  if (type === 'MOMENTQ_ASR_STOP') {
    void stopSession()
    return false
  }
  if (type === 'MOMENTQ_ASR_QUERY') {
    // Answer in-band: the caller awaits this value to learn that the
    // offscreen listener is alive before sending MOMENTQ_ASR_START.
    const answer: AsrSessionMessage = { type: 'MOMENTQ_ASR_SESSION', tabId: session?.tabId ?? null }
    sendResponse(answer)
    return false
  }
  return false
})
