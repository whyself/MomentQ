/**
 * Offscreen document: owns the tab-capture MediaStream and, per engine,
 * either the companion WebSocket (Baidu realtime ASR) or the local Whisper
 * runtime (transformers.js + WebGPU in this document). Either way the
 * session — and with it the capture, the model cache and the recognition —
 * survives the side panel closing; the panel document hosts a session only
 * when this context cannot consume the minted capture id (the Edge
 * tab-capture quirk).
 *
 * Audio is captured in a 16 kHz AudioContext (the browser resamples the tab
 * stream) and kept audible through a monitor <audio> (the document is
 * created with the AUDIO_PLAYBACK reason). Baidu frames go out as raw
 * 16-bit PCM; whisper chunks are queued and transcribed sequentially.
 * Result events are relayed verbatim to the background service worker.
 */

import type {
  AsrStartMessage,
  AsrSessionMessage,
  AsrClockMessage,
} from '../shared/protocol'
import { isCompanionServerMessage } from '../../../shared/src/companion-protocol'
import { floatToInt16, int16ToBuffer, resampleLinear } from './pcm'
import { WhisperLiveSession } from '../shared/whisper-live'

type RunningSession = {
  tabId: number
  stream: MediaStream
  context: AudioContext
  socket: WebSocket | undefined
  whisper: WhisperLiveSession | undefined
  monitor: HTMLAudioElement
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
    // A panel-minted id can be bound to the minting context (Edge refuses
    // the cross-context handoff); when none arrives, mint here so the id is
    // created AND consumed in this same document.
    const streamId = request.streamId
      ?? await chrome.tabCapture.getMediaStreamId({ targetTabId: request.tabId })
    const captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
    } as unknown as MediaStreamConstraints)
    const context = new AudioContext({ sampleRate: 16_000 })
    await context.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'))
    const source = context.createMediaStreamSource(captureStream)
    const node = new AudioWorkletNode(context, 'momentq-capture')

    // Tab capture routes the tab's audio into this document; without an
    // explicit re-play the user watches a silent video. An audio element is
    // audible here (the document is created with the AUDIO_PLAYBACK reason).
    const monitor = new Audio()
    monitor.srcObject = captureStream
    void monitor.play().catch(() => {})

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
        void stopSession()
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

    // Local Whisper: the engine lives in THIS document — model + WebGPU —
    // so closing the side panel never interrupts a local-engine session.
    // The model loads lazily on the first utterance; audio accumulates in
    // the runtime's bounded queue meanwhile.
    const whisper: WhisperLiveSession | undefined = request.engine === 'whisper'
      ? new WhisperLiveSession(request.whisperModel, event => reportEvent(request.tabId, event))
      : undefined

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data
      if (chunk === undefined) return
      const atRate = context.sampleRate !== 16_000
        ? resampleLinear(chunk, context.sampleRate, 16_000)
        : chunk
      if (whisper !== undefined) {
        // Never silence-gate: the queue + seek handling inside the runtime
        // is the only place that may decide what to transcribe.
        whisper.feed(atRate)
        return
      }
      if (socket === undefined) return
      // Never silence-gate: withholding frames while the video plays (soft
      // passages, music) starves the Baidu stream and kills the session
      // with err 4002 — the frames must keep flowing unconditionally.
      sendAudioFrame(socket, atRate)
    }
    source.connect(node)
    // The worklet is a sink; do not connect it to destination (that would
    // echo tab audio back into the speakers).

    session = { tabId: request.tabId, stream: captureStream, context, socket, whisper, monitor }
    postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: request.tabId, owner: 'offscreen' })
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
  // Detach BEFORE closing: an intentional stop must not fall into the
  // onclose path and get reported to the user as a companion loss.
  current.whisper?.dispose()
  try {
    if (current.socket !== undefined) {
      current.socket.onclose = null
      current.socket.onmessage = null
      current.socket.onerror = null
      if (current.socket.readyState === WebSocket.OPEN) {
        current.socket.send(JSON.stringify({ type: 'stop' }))
      }
      current.socket.close()
    }
  } catch { /* the socket may already be gone */ }
  for (const track of current.stream.getTracks()) track.stop()
  current.monitor.pause()
  current.monitor.srcObject = null
  await current.context.close().catch(() => {})
  postToBackground({ type: 'MOMENTQ_ASR_SESSION', tabId: null, stoppedTabId: current.tabId, owner: 'offscreen' })
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
    if (session === undefined || session.tabId !== clock.tabId) return false
    if (session.whisper !== undefined) {
      // The background relays the video clock every 250 ms: it keeps the
      // anchoring alive even when the panel (and its own poll) is closed.
      session.whisper.clock(clock.mediaTime)
    } else if (session.socket !== undefined && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'clock', mediaTime: clock.mediaTime }))
    }
    return false
  }
  if (type === 'MOMENTQ_ASR_PAUSE') {
    if (session?.whisper !== undefined) {
      // Track disabling would feed silence into the chunker; hold the buffer
      // instead so resumed speech continues the same timeline.
      session.whisper.setPaused(true)
    } else {
      session?.stream.getAudioTracks().forEach(track => { track.enabled = false })
    }
    return false
  }
  if (type === 'MOMENTQ_ASR_RESUME') {
    if (session?.whisper !== undefined) {
      session.whisper.setPaused(false)
    } else {
      session?.stream.getAudioTracks().forEach(track => { track.enabled = true })
    }
    return false
  }
  if (type === 'MOMENTQ_ASR_STOP') {
    void stopSession()
    return false
  }
  if (type === 'MOMENTQ_ASR_PING') {
    // Pure liveness: answered whether or not a session runs, so the
    // background can confirm the listener exists before handing work over.
    sendResponse({ type: 'MOMENTQ_ASR_PONG' })
    return false
  }
  if (type === 'MOMENTQ_ASR_QUERY') {
    // Only a HOSTING document claims the session. Answering "tabId:null"
    // while idle would race the panel's answer and read as "the session
    // ended", closing the live document after a service-worker restart.
    if (session === undefined) return false
    const answer: AsrSessionMessage = { type: 'MOMENTQ_ASR_SESSION', tabId: session.tabId, owner: 'offscreen' }
    sendResponse(answer)
    return false
  }
  return false
})
