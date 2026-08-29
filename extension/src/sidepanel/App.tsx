import { useCallback, useEffect, useState } from 'react'
import type { MomentQTabState } from '../shared/protocol'
import { MomentQClient, type MessageStreamEvent, type SubmitMessageResult } from '../shared/host-client'
import { fetchCompanionConfig } from '../shared/companion-client'
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

declare const __MOMENTQ_BUILD_VERSION__: string

export function App({ subscribe }: {
  subscribe: (publish: (state: MomentQTabState | null) => void) => () => void
}) {
  const [state, setState] = useState<MomentQTabState | null>(null)
  const [settings, setSettings] = useState<ExtensionSettings | null>(null)
  const [capturedFrame, setCapturedFrame] = useState<string | null>(null)
  const [playbackClock, setPlaybackClock] = useState<{ key: string; seconds: number } | null>(null)
  // A reloaded extension keeps this panel document executing the previous
  // build. Detect it by asking the live background for its manifest version:
  // an unreachable background or a version mismatch means this document is
  // stale and must be closed and reopened.
  const [staleBuild, setStaleBuild] = useState(false)
  useEffect(() => {
    let active = true
    const check = (): void => {
      try {
        void chrome.runtime.sendMessage({ type: 'MOMENTQ_PING' })
          .then(reply => {
            const version = (reply as { version?: unknown } | null)?.version
            if (active) setStaleBuild(version !== __MOMENTQ_BUILD_VERSION__)
          })
          .catch(() => { if (active) setStaleBuild(true) })
      } catch {
        if (active) setStaleBuild(true)
      }
    }
    check()
    const timer = window.setInterval(check, 10_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])
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

  const [asrConfigured, setAsrConfigured] = useState<boolean | null>(null)
  const [transcriptionNotice, setTranscriptionNotice] = useState<string | null>(null)
  // A cold-starting service worker can drop the first message ("message
  // channel closed before a response was received"); one retry after a beat
  // rides out the load window.
  const sendWithRetry = async (message: unknown): Promise<unknown> => {
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (error) {
      if (!(error instanceof Error) || !/message channel closed/i.test(error.message)) throw error
      await new Promise(resolve => setTimeout(resolve, 400))
      return await chrome.runtime.sendMessage(message)
    }
  }
  useEffect(() => {
    if (settings === null) return
    let active = true
    fetchCompanionConfig(settings.companionBaseUrl)
      .then(view => { if (active) setAsrConfigured(view.baidu.configured) })
      .catch(() => { if (active) setAsrConfigured(null) })
    return () => { active = false }
  }, [settings])

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
      setTranscriptionNotice(null)
      // Every start attempt is bounded on both ends: the background race
      // rejects by 12s, and this panel-side race guarantees the click always
      // resolves into either a state refresh or a visible notice.
      const bounded = (promise: Promise<unknown>): Promise<unknown> => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('面板等待后台响应超时')), 15_000)),
      ])
      try {
        if (state.transcription === 'inactive') {
          // The click is the gesture; the TARGETED form is the only one
          // whose stream id survives the handoff to the offscreen consumer
          // (the no-target id is bound to the calling context and dies in
          // offscreen with "Error starting tab capture"). The targeted form
          // additionally needs the extension invoked on this page — the
          // context-menu entry or a toolbar-icon click grants that.
          let streamId: string | null = null
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId })
          } catch {
            streamId = null
          }
          if (streamId === null) {
            // Let the background try with whatever invocation state exists
            // and, when it is rejected too, record the reason on the tab
            // state — the panel shows why.
            await bounded(sendWithRetry({
              type: 'MOMENTQ_TOGGLE_TRANSCRIPTION',
              tabId: state.tabId,
            }))
            return
          }
          await bounded(sendWithRetry({
            type: 'MOMENTQ_ASR_START_FROM_PANEL',
            tabId: state.tabId,
            streamId,
          }))
          return
        }
        await bounded(sendWithRetry({
          type: 'MOMENTQ_TOGGLE_TRANSCRIPTION',
          tabId: state.tabId,
        }))
      } catch (error) {
        setTranscriptionNotice(`转录操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
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
      {staleBuild && (
        <div className="momentq-stale-overlay" role="alert">
          <div className="momentq-stale-card">
            <div className="momentq-stale-title">扩展已更新</div>
            <div className="momentq-stale-text">
              此侧边栏仍在运行旧版本（面板 v{__MOMENTQ_BUILD_VERSION__}）。请关闭本侧边栏后重新打开。
            </div>
          </div>
        </div>
      )}
      <ConversationView
        state={state}
        capturedFrame={capturedFrame}
        playbackTime={playbackTime}
        onLoadHistory={loadHistory}
        onCaptureFrame={captureCurrentFrame}
        onSubmit={submitMessage}
        {...(hasChromeRuntime ? { onToggleTranscription: toggleTranscription } : {})}
        {...(asrConfigured === null ? {} : { asrConfigured })}
        transcriptionNotice={transcriptionNotice}
        settings={settings === null ? null : (
          <SettingsView settings={settings} onSettingsChange={setSettings} />
        )}
      />
    </main>
  )
}
