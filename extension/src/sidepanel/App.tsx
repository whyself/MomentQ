import { useCallback, useEffect, useState } from 'react'
import type { MomentQTabState } from '../shared/protocol'
import { MomentQClient, type MessageStreamEvent, type SubmitMessageResult } from '../shared/host-client'
import { loadSettings } from '../shared/settings-store'
import type { ExtensionSettings } from '../shared/settings'
import { ConversationView } from './ConversationView'
import { SettingsView } from './SettingsView'
import { applyTheme } from './theme'
import './composition.css'
import './subtitle.css'
import '../vendor/deepseek-harness/packages/client/ui-theme/src/styles/base.css'
import '../vendor/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css'
import '../vendor/deepseek-harness/packages/client/ui-theme/src/styles/scrollbar.css'
import '../vendor/deepseek-harness/packages/client/ui-theme/src/styles/gradient-shadow-text.css'

export function App({ subscribe }: {
  subscribe: (publish: (state: MomentQTabState | null) => void) => () => void
}) {
  const [state, setState] = useState<MomentQTabState | null>(null)
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [capturedFrame, setCapturedFrame] = useState<string | null>(null)
  const [playbackClock, setPlaybackClock] = useState<{ key: string; seconds: number } | null>(null)
  const contentKey = state?.context.kind === 'vod'
    ? `${state.context.identity.bvid}:${state.context.identity.cid}`
    : null
  const playbackTime = playbackClock?.key === contentKey ? playbackClock.seconds : undefined

  useEffect(() => subscribe(setState), [subscribe])
  useEffect(() => {
    if (state === null) {
      setPlaybackClock(null)
      return
    }
    const key = state.context.kind === 'vod'
      ? `${state.context.identity.bvid}:${state.context.identity.cid}`
      : JSON.stringify(state.context.identity)
    let disposed = false
    let timer: number | undefined
    const poll = async () => {
      const value = await chrome.runtime.sendMessage({ type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' }).catch(() => null)
      if (!disposed && typeof value === 'number' && Number.isFinite(value)) {
        setPlaybackClock({ key, seconds: value })
      }
      if (!disposed) timer = window.setTimeout(() => { void poll() }, 250)
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [state?.context.kind === 'vod' ? state.context.identity.bvid : undefined, state?.context.kind === 'vod' ? state.context.identity.cid : undefined, state === null])
  useEffect(() => {
    const onFrame = (event: Event) => {
      const dataUrl = (event as CustomEvent<string>).detail
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) setCapturedFrame(dataUrl)
    }
    window.addEventListener('momentq-frame-captured', onFrame)
    return () => window.removeEventListener('momentq-frame-captured', onFrame)
  }, [])

  function playbackStamp(seconds: number | undefined): string | null {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null
    const whole = Math.floor(seconds)
    const minutes = Math.floor(whole / 60)
    const rest = whole % 60
    return `${minutes}:${String(rest).padStart(2, '0')}`
  }
  useEffect(() => {
    void loadSettings().then((value) => {
      setSettings(value)
      applyTheme(value.theme)
    })
  }, [])

  async function submitMessage(
    text: string,
    onEvent: (event: MessageStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<SubmitMessageResult> {
    if (state === null || settings === null) throw new Error('当前页面没有可用的视频或直播上下文')
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({
      identity: state.context.identity,
      metadata: state.context.metadata,
    })
    const liveTime = await chrome.runtime.sendMessage({ type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' }).catch(() => null)
    const stamp = playbackStamp(typeof liveTime === 'number' ? liveTime : playbackTime)
    const contextualText = stamp === null ? text : `${text}\n\n[当前视频播放时间：${stamp}]`
    return await client.streamMessage(state.context.identity, contextualText, onEvent, signal)
  }

  async function captureCurrentFrame(): Promise<string | null> {
    return await chrome.runtime.sendMessage({ type: 'MOMENTQ_CAPTURE_CURRENT_FRAME' }) as string | null
  }

  function toggleTranscription(): void {
    if (state === null) return
    void (async () => {
      if (state.transcription === 'inactive') {
        // chrome.tabCapture's user-gesture gate is satisfied inside this
        // click handler on an extension surface; the background completes
        // the pipeline with the handed-over stream id.
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId }).catch(() => null)
        if (streamId === null) return
        await chrome.runtime.sendMessage({
          type: 'MOMENTQ_ASR_START_FROM_PANEL',
          tabId: state.tabId,
          streamId,
        }).catch(() => {})
        return
      }
      await chrome.runtime.sendMessage({
        type: 'MOMENTQ_TOGGLE_TRANSCRIPTION',
        tabId: state.tabId,
      }).catch(() => {})
    })()
  }

  const loadHistory = useCallback(async (current: MomentQTabState) => {
    if (settings === null) return []
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({ identity: current.context.identity, metadata: current.context.metadata })
    return await client.getHistory(current.context.identity)
  }, [settings])

  const hasChromeRuntime = typeof chrome !== 'undefined' && chrome.runtime !== undefined
    && chrome.tabCapture !== undefined

  return (
    <main className="momentq-shell">
      <ConversationView
        state={state}
        capturedFrame={capturedFrame}
        playbackTime={playbackTime}
        onLoadHistory={loadHistory}
        onCaptureFrame={captureCurrentFrame}
        onSubmit={submitMessage}
        {...(hasChromeRuntime ? { onToggleTranscription: toggleTranscription } : {})}
        settings={settings === null ? null : (
          <SettingsView settings={settings} onSettingsChange={setSettings} />
        )}
      />
    </main>
  )
}
