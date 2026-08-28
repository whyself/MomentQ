import type { MomentQTabState, TabStateChangedMessage } from '../shared/protocol'
import { isPageMessageEnvelope, isPageSubtitleTracksMessageEnvelope } from '../shared/protocol'
import { pageSnapshotToRuntimeMessage } from './relay'
import { mountTranscriptionControl } from './transcription-control'

// The background re-injects this file into tabs that predate an extension
// reload. Within one extension instance the isolated world persists, so this
// flag keeps a re-injection from registering every listener twice.
const bridge = globalThis as { __momentqContentBridge?: boolean }
if (bridge.__momentqContentBridge !== true) {
  bridge.__momentqContentBridge = true

  function currentVideo(): HTMLVideoElement | null {
    const candidates = [...document.querySelectorAll('video')]
      .filter(video => Number.isFinite(video.currentTime))
      .map(video => {
        const box = video.getBoundingClientRect()
        const style = window.getComputedStyle(video)
        const visible = style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && box.width > 0 && box.height > 0
        const area = visible ? box.width * box.height : 0
        // Visible area is authoritative; playback state only breaks an exact
        // size tie. This keeps a tiny autoplay preview from beating the paused
        // main player while the user is reading a frame.
        return { video, score: area * 2 + (video.paused ? 0 : 1) }
      })
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
    return candidates[0]?.video ?? null
  }

  const control = mountTranscriptionControl(async () => {
    const state = await chrome.runtime.sendMessage({ type: 'MOMENTQ_TOGGLE_CURRENT_TRANSCRIPTION' })
      .catch(() => null) as MomentQTabState | null
    control.update(state)
  })

  // Use a shortcut that Edge does not reserve for its page screenshot. Capture
  // at the page level first so the browser shortcut never gets a chance to run.
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if (!event.altKey || !event.shiftKey || key !== 'c') return
    event.preventDefault()
    event.stopPropagation()
    void chrome.runtime.sendMessage({ type: 'MOMENTQ_CAPTURE_CURRENT_FRAME' }).then((data: unknown) => {
      if (typeof data === 'string' && data.startsWith('data:image/')) {
        void chrome.runtime.sendMessage({ type: 'MOMENTQ_FRAME_CAPTURED', dataUrl: data }).catch(() => {})
      }
    }).catch(() => {})
  }, true)

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin
      || (!isPageMessageEnvelope(event.data) && !isPageSubtitleTracksMessageEnvelope(event.data))) return

    if (isPageSubtitleTracksMessageEnvelope(event.data)) {
      void chrome.runtime.sendMessage(event.data).catch(() => {})
      return
    }

    const message = pageSnapshotToRuntimeMessage(event.data.payload)
    if (message === null) return
    void chrome.runtime.sendMessage(message).then((state: MomentQTabState | null) => {
      control.update(state)
    }).catch(() => {
      // The extension may be reloaded while an already-injected content script is alive.
    })
  })

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return false
    const update = message as Partial<TabStateChangedMessage>
    if (update.type !== 'MOMENTQ_TAB_STATE_CHANGED' || !Object.hasOwn(update, 'state')) return false
    const state = update.state as MomentQTabState | null
    control.update(state)
    if (state?.context.kind === 'vod') {
      window.postMessage({
        source: 'momentq-content', version: 1, type: 'MOMENTQ_RESOLVED_VOD',
        payload: { bvid: state.context.identity.bvid, cid: state.context.identity.cid },
      }, location.origin)
    }
    return false
  })

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message === 'object' && message !== null
      && (message as { type?: unknown }).type === 'MOMENTQ_GET_CURRENT_VIDEO_TIME') {
      const video = currentVideo()
      sendResponse(video !== null && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : null)
      return false
    }
    if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'MOMENTQ_CAPTURE_VIDEO_FRAME') return false
    const video = currentVideo()
    if (video === null || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
      sendResponse(null)
      return false
    }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      sendResponse(canvas.toDataURL('image/png'))
    } catch {
      sendResponse(null)
    }
    return false
  })
}
