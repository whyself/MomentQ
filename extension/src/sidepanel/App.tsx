import { useCallback, useEffect, useRef, useState } from 'react'
import type { MomentQTabState } from '../shared/protocol'
import { MomentQClient, type MessageStreamEvent, type SubmitMessageResult, type WireImage } from '../shared/host-client'
import { fetchCompanionConfig } from '../shared/companion-client'
import { loadSettings } from '../shared/settings-store'
import type { ExtensionSettings } from '../shared/settings'
import { ConversationView } from './ConversationView'
import { runPreTranscription, type PreTranscribeHandle } from './pre-transcribe-driver'
import { pausePanelSession, panelSessionTabId, sessionClock, startPanelSession, stopPanelSession } from './asr-session'
import { SettingsView } from './SettingsView'
import { applyTheme } from './theme'
import { playbackStamp, withVideoTimeSuffix } from './video-stamp'
import './message-extras.css'
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

  useEffect(() => {
    void loadSettings().then((value) => {
      setSettings(value)
      applyTheme(value.theme)
    })
  }, [])

  async function submitMessage(
    text: string,
    images: readonly { dataUrl: string; name: string }[],
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
    // The suffix is for the AGENT (stored with the message); the bubble
    // splits it off for display — see video-stamp.ts.
    const stamp = playbackStamp(typeof liveTime === 'number' ? liveTime : playbackTime)
    const wireImages = images.flatMap(({ dataUrl, name }): WireImage[] => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl)
      if (match === null) return []
      return [{ mediaType: match[1] as WireImage['mediaType'], data: match[2] ?? '', name }]
    })
    return await client.streamMessage(
      state.context.identity,
      withVideoTimeSuffix(text, stamp),
      wireImages,
      onEvent,
      signal,
    )
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

  // Full-video pre-transcription: offline ASR on the true media timeline.
  const [preTranscribe, setPreTranscribe] = useState<
    { running: boolean; message: string; fraction: number } | null
  >(null)
  const preTranscribeCancel = useRef<(() => void) | null>(null)
  const startPreTranscription = (): void => {
    const current = stateRef.current
    const config = settingsRef.current
    if (current?.context.kind !== 'vod' || preTranscribeCancel.current !== null) return
    let cancelled = false
    const handle: PreTranscribeHandle = { cancel: () => { cancelled = true } }
    preTranscribeCancel.current = handle.cancel
    setPreTranscribe({ running: true, message: '准备中…', fraction: 0 })
    void (async () => {
      try {
        if (current.context.kind !== 'vod') return
        const identity = current.context.identity
        // `all` is the cumulative transcript; `pending` is the unflushed tail
        // that re-triggers a flush. The Host's syncTranscript REPLACES the
        // whole transcript, so a flush must send `all` — a tail-only send
        // erased every earlier window (the on-disk transcript ended up being
        // just the last recognized window).
        const all: Array<{ start: number; end: number; text: string }> = []
        let pending: Array<{ start: number; end: number; text: string }> = []
        let flushTimer: ReturnType<typeof setTimeout> | undefined
        let flushRetrying = false
        let flushError: string | null = null
        const flush = async (): Promise<void> => {
          if (pending.length === 0 || flushRetrying) return
          flushRetrying = true
          try {
            // Routed through the background service worker: a panel-side
            // fetch fails intermittently while WebGPU inference hogs the
            // renderer, and the SW's network stack is immune to that.
            const reply = await sendWithRetry({
              type: 'MOMENTQ_PRETRANSCRIBE_SYNC',
              identity,
              metadata: current.context.metadata,
              segments: all,
            }) as { ok?: unknown; error?: { message?: unknown } } | null
            if (reply === null || reply.ok !== true) {
              const detail = reply?.error && typeof reply.error.message === 'string' ? reply.error.message : '未知错误'
              flushError = detail
              throw new Error(detail)
            }
            flushError = null
            pending = []
          } finally {
            flushRetrying = false
          }
        }
        const { skipped } = await runPreTranscription({
          bvid: identity.bvid,
          cid: identity.cid,
          durationSeconds: current.context.metadata.durationSeconds,
          model: config?.whisperModel ?? 'base',
          onProgress: progress => { setPreTranscribe({ running: true, message: progress.message, fraction: progress.fraction }) },
          onSegments: segments => {
            for (const segment of segments) {
              all.push(segment)
              pending.push(segment)
            }
            // Publish the cumulative batch into the tab state so the subtitle
            // ticker shows it while the run is in flight — the Host sync is
            // durable, but the UI only ever reads tab state. The background
            // replaces on same-identity redelivery, so a dropped-and-retried
            // message cannot stack windows.
            void sendWithRetry({
              type: 'MOMENTQ_PRETRANSCRIBE_SEGMENTS',
              tabId: current.tabId,
              bvid: identity.bvid,
              cid: identity.cid,
              segments: all,
            }).catch(() => {})
            // Persist per window so a cancelled run still keeps its tail.
            // The debounced call must swallow its own rejection: the final
            // retry loop below is the single place that reports failures,
            // and an unobserved flush would surface as "Uncaught (in
            // promise)" in the panel console.
            if (flushTimer === undefined) {
              flushTimer = setTimeout(() => { flushTimer = undefined; void flush().catch(() => {}) }, 1_500)
            }
          },
          isCancelled: () => cancelled,
        })
        for (let attempt = 0; attempt < 5 && pending.length > 0; attempt += 1) {
          await flush().catch(() => {})
          if (pending.length > 0) await new Promise(resolve => setTimeout(resolve, 1_500))
        }
        setPreTranscribe(
          pending.length === 0
            ? { running: false, message: skipped > 0 ? `预识别完成，字幕已保存（跳过 ${skipped} 段空/乱码识别）` : '预识别完成，字幕已保存', fraction: 1 }
            : { running: false, message: `预识别完成，但 ${pending.length} 段字幕保存失败（${flushError ?? '未知错误'}）：请确认 DSH Host 运行正常后重新预识别`, fraction: 1 },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/已取消/.test(message)) setPreTranscribe({ running: false, message: `预识别失败：${message}`, fraction: 0 })
        else setPreTranscribe(null)
      } finally {
        preTranscribeCancel.current = null
      }
    })()
  }
  const cancelPreTranscription = (): void => {
    // Running: cancel the pipeline (its catch clears the banner). Failed or
    // finished: the token is gone, so dismissing is a plain state clear.
    if (preTranscribeCancel.current !== null) preTranscribeCancel.current?.()
    else setPreTranscribe(null)
  }

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

  // Panel-run capture session lifecycle. The panel always MINTS the capture
  // id here (it owns the click gesture); by default it then hands the id to
  // the background for offscreen hosting, and consumes it itself only when
  // the background asked with consumer:'panel' — on this Edge build an id
  // is only consumable in the context that minted it, so that is the
  // offscreen-failure fallback. Every entry (menu, shortcut, toolbar, panel
  // button) funnels through this request. Confirms via MOMENTQ_ASR_SESSION
  // (watchdog-covered).
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
      // A 'panel' consumer means the offscreen start already failed for
      // this start: the panel consumes the id itself, hosting whichever
      // engine is configured (local Whisper included — model + WebGPU run in
      // this document as the fallback). Everything else hands the id to the
      // background, which delivers it to the offscreen host: closing the
      // panel then never ends the session.
      if (consumer === 'panel') {
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
        // Only a HOSTING panel claims the session. A "tabId:null" answer
        // while not hosting would race the offscreen's answer and read as
        // "the session ended" — closing the live offscreen document right
        // after a service-worker restart (the keep-alive killer).
        const hostedTabId = panelSessionTabId()
        if (hostedTabId !== null) {
          try {
            sendResponse({ type: 'MOMENTQ_ASR_SESSION', tabId: hostedTabId, owner: 'panel' })
          } catch { /* dead context */ }
        }
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
        preTranscribe={preTranscribe}
        {...(hasChromeRuntime ? { onStartPreTranscription: startPreTranscription, onCancelPreTranscription: cancelPreTranscription } : {})}
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
