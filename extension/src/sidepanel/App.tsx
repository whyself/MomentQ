import { useCallback, useEffect, useRef, useState } from 'react'
import type { MomentQTabState } from '../shared/protocol'
import { MomentQClient, type MessageStreamEvent, type SubmitMessageResult } from '../shared/host-client'
import { fetchCompanionConfig } from '../shared/companion-client'
import { loadSettings } from '../shared/settings-store'
import type { ExtensionSettings } from '../shared/settings'
import { ConversationView } from './ConversationView'
import { pausePanelSession, panelSessionTabId, sessionClock, startPanelSession, stopPanelSession } from './asr-session'
import { SettingsView } from './SettingsView'
import { applyTheme } from './theme'
import './composition.css'
import './subtitle.css'
import './stale-overlay.css'
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
      // Name the tab explicitly: falling back to the last-focused window let
      // a dual-window setup read the OTHER window's video clock.
      const value = await chrome.runtime.sendMessage({
        type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME',
        tabId: state.tabId,
      }).catch(() => null)
      if (!disposed && typeof value === 'number' && Number.isFinite(value)) {
        setPlaybackClock({ key, seconds: value })
        sessionClock(value)
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
    if (settings.asrProvider === 'whisper-local') {
      setAsrConfigured(true)
      return
    }
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
    const liveTime = await chrome.runtime.sendMessage({
      type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME',
      tabId: state.tabId,
    }).catch(() => null)
    const stamp = playbackStamp(typeof liveTime === 'number' ? liveTime : playbackTime)
    const contextualText = stamp === null ? text : `${text}\n\n[当前视频播放时间：${stamp}]`
    return await client.streamMessage(state.context.identity, contextualText, onEvent, signal)
  }

  async function captureCurrentFrame(): Promise<string | null> {
    const current = stateRef.current
    return await sendWithRetry({
      type: 'MOMENTQ_CAPTURE_CURRENT_FRAME',
      ...(current === null ? {} : { tabId: current.tabId }),
    }) as string | null
  }

  // Answer timestamps seek the video directly: the panel talks to the content
  // script over tabs messaging, no background round-trip needed.
  const seekTo = useCallback((seconds: number) => {
    const current = state
    if (current === null) return
    try {
      void chrome.tabs.sendMessage(current.tabId, { type: 'MOMENTQ_SEEK_VIDEO', seconds })
        .catch(() => {})
    } catch { /* tabs bridge unavailable */ }
  }, [state?.tabId])

  const clearSession = useCallback(async () => {
    const current = state
    if (current === null || settings === null) return
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({
      identity: current.context.identity,
      metadata: current.context.metadata,
    })
    await client.deleteSession(current.context.identity)
  }, [state, settings])

  // One toggle at a time: a double-click must not ride two background
  // toggles and land on the opposite of what the user wanted.
  const toggleInFlight = useRef(false)
  function toggleTranscription(): void {
    if (state === null) return
    if (toggleInFlight.current) return
    toggleInFlight.current = true
    void (async () => {
      try {
        setTranscriptionNotice(null)
        // Every start funnels through the background so state flips exactly
        // once; the background then requests the capture here, where the id is
        // both minted and consumed.
        const bounded = (promise: Promise<unknown>): Promise<unknown> => Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('面板等待后台响应超时')), 15_000)),
        ])
        await bounded(sendWithRetry({
          type: 'MOMENTQ_TOGGLE_TRANSCRIPTION',
          tabId: state.tabId,
        }))
      } catch (error) {
        setTranscriptionNotice(`转录操作失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        toggleInFlight.current = false
      }
    })()
  }

  // Panel-run capture session lifecycle. On this Edge build a capture stream
  // id is only consumable in the context that minted it, so the panel is the
  // sole mint-and-consume surface: the background flips state and requests a
  // start here; every entry (menu, shortcut, toolbar, panel button) funnels
  // through that request. Confirms via MOMENTQ_ASR_SESSION (watchdog-covered).
  const stateRef = useRef(state)
  stateRef.current = state
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  useEffect(() => {
    const beginPanelCapture = async (tabId: number, consumer: 'panel' | undefined): Promise<void> => {
      const current = stateRef.current
      const config = settingsRef.current
      if (current === null) return
      let streamId: string | null = null
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      } catch {
        streamId = null
      }
      if (streamId === null) {
        void chrome.runtime.sendMessage({
          type: 'MOMENTQ_ASR_PANEL_CAPTURE_FAILED',
          tabId,
          message: '浏览器要求先在当前页面调用一次扩展：请右键视频页面选择「MomentQ：开始/暂停语音转录」、按 Alt+Shift+T，或点击浏览器工具栏图标后重试。',
        }).catch(() => {})
        return
      }
      // Local Whisper is hosted by this panel document (model + WebGPU), and
      // a 'panel' consumer means offscreen already failed for this start.
      // Everything else hands the minted id to the background, which delivers
      // it to the offscreen host: closing the panel then never ends the
      // session.
      if (consumer === 'panel' || config?.asrProvider === 'whisper-local') {
        try {
          await startPanelSession({
            tabId,
            streamId,
            identity: current.context.identity,
            companionBaseUrl: config?.companionBaseUrl ?? 'http://127.0.0.1:3090',
            engine: config?.asrProvider === 'whisper-local' ? 'whisper' : 'baidu',
            whisperModel: config?.whisperModel ?? 'base',
          })
        } catch {
          await stopPanelSession()
        }
        return
      }
      await chrome.runtime.sendMessage({
        type: 'MOMENTQ_ASR_START_FROM_PANEL',
        tabId,
        streamId,
      }).catch(() => {})
    }
    const listener = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
      if (typeof message !== 'object' || message === null) return false
      const record = message as { type?: unknown; tabId?: unknown; consumer?: unknown }
      if (record.type === 'MOMENTQ_ASR_REQUEST_START') {
        if (typeof record.tabId === 'number') {
          void beginPanelCapture(record.tabId, record.consumer === 'panel' ? 'panel' : undefined)
        }
        return false
      }
      // Pause/resume/stop name their target tab: with several windows each
      // running a panel, a global broadcast would act on the wrong session.
      const targetsUs = typeof record.tabId !== 'number' || record.tabId === panelSessionTabId()
      if (record.type === 'MOMENTQ_ASR_PAUSE') {
        if (targetsUs) pausePanelSession(true)
        return false
      }
      if (record.type === 'MOMENTQ_ASR_RESUME') {
        if (targetsUs) pausePanelSession(false)
        return false
      }
      if (record.type === 'MOMENTQ_ASR_STOP') {
        if (targetsUs) void stopPanelSession()
        return false
      }
      if (record.type === 'MOMENTQ_ASR_QUERY') {
        // Inline answer: the ack watchdog and SW-restart recovery both depend
        // on this reply arriving as a response, not as a side broadcast.
        try {
          sendResponse({ type: 'MOMENTQ_ASR_SESSION', tabId: panelSessionTabId() })
        } catch { /* dead context */ }
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(listener)
    const onUnload = (): void => { void stopPanelSession() }
    window.addEventListener('pagehide', onUnload)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
      window.removeEventListener('pagehide', onUnload)
      void stopPanelSession()
    }
  }, [])

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
        {...(hasChromeRuntime && typeof chrome !== 'undefined' && chrome.tabs !== undefined ? { onSeekTo: seekTo } : {})}
        onClearSession={clearSession}
        {...(asrConfigured === null ? {} : { asrConfigured })}
        transcriptionNotice={transcriptionNotice}
        settings={settings === null ? null : (
          <SettingsView
            settings={settings}
            onSettingsChange={setSettings}
            currentIdentity={state?.context.identity}
            currentTabId={state?.tabId}
          />
        )}
      />
    </main>
  )
}
