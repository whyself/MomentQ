import { reduceTabState, TabOperationQueue } from './state'
import { isSupportedBilibiliUrl } from './url'
import { resolveSnapshotViaBilibiliApi } from './bilibili-api'
import { sameContentLocation } from './content-location'
import { resolveCurrentVodContext } from './vod-refresh'
import { parseBilibiliLocation } from '../shared/bilibili'
import type {
  BilibiliContext,
  GetTabStateMessage,
  MomentQTabState,
  PageContextRuntimeMessage,
  TabStateChangedMessage,
  ToggleTranscriptionMessage,
  ToggleCurrentTranscriptionMessage,
  CaptureCurrentFrameMessage,
  GetCurrentVideoTimeMessage,
  ClearAsrSubtitlesMessage,
  ResolvePageSnapshotMessage,
  PageSubtitleTracksMessageEnvelope,
  BilibiliSubtitleSegment,
  AsrStartFromPanelMessage,
  AsrEventMessage,
  AsrSessionMessage,
} from '../shared/protocol'
import { isBilibiliPageSnapshot, isPageSubtitleTracksMessageEnvelope } from '../shared/protocol'
import { isCompanionServerMessage } from '../../../shared/src/companion-protocol'
import { fetchBilibiliSubtitle, fetchSubtitleTrackUrl } from './bilibili-subtitle'
import { MomentQClient } from '../shared/host-client'
import { loadSettings } from '../shared/settings-store'
import { trackNeedsChineseTranslation, transcriptExceedsHost } from '../shared/bilibili-subtitle'

type WorkerRequest = PageContextRuntimeMessage | ResolvePageSnapshotMessage | GetTabStateMessage | ToggleTranscriptionMessage | ToggleCurrentTranscriptionMessage | CaptureCurrentFrameMessage | GetCurrentVideoTimeMessage | ClearAsrSubtitlesMessage | PageSubtitleTracksMessageEnvelope | AsrStartFromPanelMessage | AsrEventMessage | AsrSessionMessage | { type: 'MOMENTQ_ASR_PANEL_CAPTURE_FAILED'; tabId?: unknown; message?: unknown }

const storageKey = (tabId: number) => `tab:${tabId}`
// The queue serializes fast local state mutations only. Network calls never
// run inside it: a stalled Bilibili/Host request used to block every later
// operation for the tab, freezing the side panel on a previous video until a
// restart.
const tabOperations = new TabOperationQueue()
const subtitleSyncs = new Map<string, Promise<void>>()
const publishRevisions = new Map<number, number>()

/** Record the latest subtitle-index probe outcome for the panel to show. */
async function writeProbeResult(tabId: number, bvid: string, cid: string, diagnostic: string): Promise<void> {
  // The build tag lets a screenshot prove which version produced the line.
  const version = chrome.runtime.getManifest().version
  await tabOperations.run(tabId, async () => {
    const state = await readState(tabId)
    if (state?.context.kind !== 'vod'
      || state.context.identity.bvid !== bvid
      || state.context.identity.cid !== cid) return
    const next: MomentQTabState = { ...state, subtitleDiagnostic: `v${version} · ${diagnostic}` }
    await writeState(tabId, next)
    publishState(tabId, next)
  })
}

/** Tab owning the single offscreen ASR session, if any. */
let asrTabId: number | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestType(value: unknown): WorkerRequest['type'] | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'MOMENTQ_PAGE_CONTEXT'
    || value.type === 'MOMENTQ_GET_TAB_STATE'
    || value.type === 'MOMENTQ_RESOLVE_PAGE_SNAPSHOT'
    || value.type === 'MOMENTQ_TOGGLE_TRANSCRIPTION'
    || value.type === 'MOMENTQ_TOGGLE_CURRENT_TRANSCRIPTION'
    || value.type === 'MOMENTQ_CAPTURE_CURRENT_FRAME') return value.type
  if (value.type === 'MOMENTQ_GET_CURRENT_VIDEO_TIME') return value.type
  if (value.type === 'MOMENTQ_CLEAR_ASR_SUBTITLES') return value.type
  if (value.type === 'PAGE_SUBTITLE_TRACKS' && isPageSubtitleTracksMessageEnvelope(value)) return value.type
  if (value.type === 'MOMENTQ_ASR_START_FROM_PANEL') {
    return typeof value.tabId === 'number' && Number.isSafeInteger(value.tabId) && value.tabId >= 0
      && typeof value.streamId === 'string' && value.streamId !== ''
      ? value.type
      : null
  }
  if (value.type === 'MOMENTQ_ASR_EVENT' || value.type === 'MOMENTQ_ASR_SESSION'
    || value.type === 'MOMENTQ_ASR_PANEL_CAPTURE_FAILED') return value.type
  return null
}

async function readState(tabId: number): Promise<MomentQTabState | null> {
  const key = storageKey(tabId)
  const stored = await chrome.storage.session.get(key)
  const value: unknown = stored[key]
  return isRecord(value) && value.tabId === tabId ? value as MomentQTabState : null
}

async function writeState(tabId: number, state: MomentQTabState | null): Promise<void> {
  const key = storageKey(tabId)
  if (state === null) await chrome.storage.session.remove(key)
  else await chrome.storage.session.set({ [key]: state })
}

function publishState(tabId: number, state: MomentQTabState | null): void {
  const previous = publishRevisions.get(tabId) ?? 0
  const revision = Math.max(Date.now() * 1_000, previous + 1)
  publishRevisions.set(tabId, revision)
  const message: TabStateChangedMessage = { type: 'MOMENTQ_TAB_STATE_CHANGED', tabId, state, revision }
  void chrome.runtime.sendMessage(message).catch(() => {})
  void chrome.tabs.sendMessage(tabId, message).catch(() => {})
}

// --- ASR session plumbing (background ↔ offscreen) ---

function sendToOffscreen(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {})
}

/** Tabs whose capture session was handed to the offscreen document. */
const offscreenStarted = new Set<number>()

/** Create the offscreen document when the first session needs it. */
async function ensureOffscreenDocument(): Promise<boolean> {
  try {
    if (await chrome.offscreen.hasDocument()) return true
  } catch {
    return false
  }
  try {
    // AUDIO_PLAYBACK lets the document re-play the captured stream so the
    // user keeps hearing the video while tab capture routes it away.
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'MomentQ 标签页音频转录：在侧边栏关闭后持续采集',
    })
    return true
  } catch {
    // A concurrent creation reports "already exists" — that is success.
    return await chrome.offscreen.hasDocument().catch(() => false)
  }
}

/** The offscreen listener answers MOMENTQ_ASR_QUERY in-band with owner:'offscreen'. */
async function waitUntilOffscreenReady(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const reply = await chrome.runtime.sendMessage({ type: 'MOMENTQ_ASR_QUERY' })
      .catch(() => null) as AsrSessionMessage | null
    if (reply !== null && reply.type === 'MOMENTQ_ASR_SESSION' && reply.owner === 'offscreen') return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

let clockRelayTabId: number | null = null
let clockRelayTimer: ReturnType<typeof setInterval> | undefined

/**
 * The offscreen session anchors transcript rows to the video clock, and the
 * panel's own clock poll dies with the panel. The background relays the
 * media clock itself so closing the panel never orphans the anchoring.
 * (Each tick calls extension APIs, which also keeps the worker alive.)
 */
function startClockRelay(tabId: number): void {
  clockRelayTabId = tabId
  if (clockRelayTimer !== undefined) return
  clockRelayTimer = setInterval(() => {
    const current = clockRelayTabId
    if (current === null || asrTabId === null) {
      stopClockRelay()
      return
    }
    void chrome.tabs.sendMessage(current, { type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' })
      .then(value => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          sendToOffscreen({ type: 'MOMENTQ_ASR_CLOCK', tabId: current, mediaTime: value })
        }
      })
      .catch(() => {})
  }, 250)
}

function stopClockRelay(): void {
  clockRelayTabId = null
  if (clockRelayTimer !== undefined) {
    clearInterval(clockRelayTimer)
    clockRelayTimer = undefined
  }
}

/**
 * Browser-side telemetry: forward pipeline failures to the companion's log
 * endpoint so the local console carries the exact in-browser error text
 * (the service worker's own console is not persisted anywhere readable).
 */
function reportDiagnostic(message: string): void {
  void loadSettings().then(settings => {
    void fetch(`${settings.companionBaseUrl}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    }).catch(() => {})
  }).catch(() => {})
}

async function closeOffscreenIfIdle(): Promise<void> {
  if (asrTabId !== null) return
  // Bounded: a wedged offscreen API must not stall deactivate paths (they
  // run inside the per-tab queue and would block every later click).
  const bounded = <T,>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
    Promise.race([promise, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms))])
  try {
    if (await bounded(chrome.offscreen.hasDocument(), 2_500) === true) {
      await bounded(chrome.offscreen.closeDocument(), 2_500)
    }
  } catch { /* the document may already be gone */ }
}

/**
 * Tear down the capture pipeline. With a target tab, the teardown only
 * applies when that tab still owns the session — a newer tab's start must
 * never be killed by an older tab's late deactivation.
 */
async function stopAsrSession(targetTabId?: number): Promise<void> {
  if (targetTabId !== undefined && asrTabId !== targetTabId) return
  if (asrTabId === null) return
  const owner = asrTabId
  sendToOffscreen({ type: 'MOMENTQ_ASR_STOP', tabId: owner })
  asrTabId = null
  offscreenStarted.delete(owner)
  if (clockRelayTabId === owner) stopClockRelay()
  await closeOffscreenIfIdle()
}

/** Mark a tab's transcription inactive and tear its session down. */
async function deactivateTranscription(tabId: number, state: MomentQTabState, error?: string): Promise<MomentQTabState> {
  if (error !== undefined) reportDiagnostic(`转录停止：${error}`)
  const { transcriptPreview: _preview, transcriptionError: _error, ...withoutAsrUi } = state
  // subtitleSource stays as provenance for the imported finals; ownership is
  // keyed on the live transcription state, not on this field. A clean stop
  // also CLEARS any stale error so the panel does not show an old failure
  // above a fresh session.
  const next: MomentQTabState = {
    ...withoutAsrUi,
    transcription: 'inactive',
    ...(error === undefined ? {} : { transcriptionError: error }),
  }
  await writeState(tabId, next)
  publishState(tabId, next)
  await stopAsrSession(tabId)
  await closeOffscreenIfIdle()
  // Flush any unsynced local-engine finals so a Host answer can cite them.
  void syncAsrTranscript(tabId)
  return next
}

/**
 * Start transcription with a tab-capture stream id. The side panel passes
 * one it obtained inside its own click handler (the reliable gesture
 * surface); other entry points let the background try, which some surfaces
 * reject without a user gesture. The whole run is bounded: whatever hangs
 * converts into a visible error state instead of a dead click.
 */
const BEGIN_TIMEOUT_MS = 12_000
const START_ACK_TIMEOUT_MS = 8_000
const startAckTimers = new Map<number, ReturnType<typeof setTimeout>>()

function clearStartAckWatchdog(tabId: number): void {
  const timer = startAckTimers.get(tabId)
  if (timer !== undefined) {
    clearTimeout(timer)
    startAckTimers.delete(tabId)
  }
}

function armStartAckWatchdog(tabId: number): void {
  clearStartAckWatchdog(tabId)
  const timer = setTimeout(() => {
    startAckTimers.delete(tabId)
    if (asrTabId !== tabId) return
    // The panel never confirmed the session; ask it directly (it answers via
    // sendResponse) and surface the verdict instead of leaving the toggle
    // 'active' forever.
    void chrome.runtime.sendMessage({ type: 'MOMENTQ_ASR_QUERY' }).then(reply => {
      const sessionTab = (reply as { tabId?: number } | null)?.tabId
      if (asrTabId === tabId && sessionTab !== tabId) {
        void tabOperations.run(tabId, async () => {
          const state = await readState(tabId)
          if (state === null || state.transcription === 'inactive') return
          await deactivateTranscription(tabId, state, '采集会话未确认启动，请重试')
        })
      }
    }).catch(() => {})
  }, START_ACK_TIMEOUT_MS)
  startAckTimers.set(tabId, timer)
}

async function beginTranscription(
  tabId: number,
  streamId: string | undefined,
  mode: 'auto' | 'panel-only' = 'auto',
): Promise<MomentQTabState | null> {
  const initial = await readState(tabId)
  if (initial === null || initial.transcription !== 'inactive') return await readState(tabId)
  // NOTE: an existing Bilibili subtitle import does NOT block starting.
  // Bilibili subtitles are often partial; ASR finals append after the
  // imported segments, so the user can fill the gaps deliberately.
  const run = async (): Promise<MomentQTabState | null> => {
    const settings = await loadSettings()
    // The content directory must exist before the companion persists rows.
    // (MomentQClient bounds each call, so a wedged Host rejects instead of
    // hanging the click.)
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({ identity: initial.context.identity, metadata: initial.context.metadata })
    return await tabOperations.run(tabId, async () => {
      const current = await readState(tabId)
      if (current === null || current.transcription !== 'inactive') return await readState(tabId)
      const { transcriptPreview: _preview, transcriptionError: _error, ...withoutAsrUi } = current
      const next: MomentQTabState = {
        ...withoutAsrUi,
        transcription: 'active',
      }
      await writeState(tabId, next)
      publishState(tabId, next)
      asrTabId = tabId
      if (mode === 'auto' && streamId !== undefined
        && settings.asrProvider !== 'whisper-local'
        && await ensureOffscreenDocument()
        && await waitUntilOffscreenReady()) {
        // The panel minted the id in its click handler (the reliable gesture
        // surface); the OFFSCREEN document consumes it, so the session — and
        // transcription — survive closing the side panel. Confirms via
        // MOMENTQ_ASR_SESSION with owner:'offscreen' (watchdog-covered).
        offscreenStarted.add(tabId)
        sendToOffscreen({
          type: 'MOMENTQ_ASR_START',
          tabId,
          streamId,
          identity: current.context.identity,
          companionBaseUrl: settings.companionBaseUrl,
        })
        startClockRelay(tabId)
      } else {
        // No minted id, local Whisper (panel-hosted model), or a retry after
        // an offscreen failure: the panel mints and consumes in its own
        // document. Closing the panel ends this kind of session.
        void chrome.runtime.sendMessage({
          type: 'MOMENTQ_ASR_REQUEST_START',
          tabId,
          consumer: 'panel',
        }).catch(() => {})
      }
      armStartAckWatchdog(tabId)
      return await readState(tabId)
    })
  }
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('启动超时')), BEGIN_TIMEOUT_MS)),
    ])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    reportDiagnostic(`开始转录失败：${reason}`)
    const state = await readState(tabId) ?? initial
    return await tabOperations.run(tabId, () => deactivateTranscription(
      tabId,
      state,
      `无法开始转录（${reason}）。请重试或在 MomentQ 侧边栏再次点击。`,
    ))
  }
}

async function applyAsrEvent(message: AsrEventMessage): Promise<void> {
  const tabId = message.tabId
  if (!isCompanionServerMessage(message.event)) return
  await tabOperations.run(tabId, async () => {
    const state = await readState(tabId)
    // Events from an ended session (stale finals after a video switch, a
    // socket draining after a stop) must never touch the fresh state.
    if (state === null || state.transcription === 'inactive') return
    const event = message.event
    if (event.type === 'ready') {
      if (state.transcriptionError === undefined) return
      const { transcriptionError: _error, ...withoutError } = state
      await writeState(tabId, withoutError)
      publishState(tabId, withoutError)
      return
    }
    if (event.type === 'partial') {
      const next = { ...state, transcriptPreview: event.text, subtitleSource: 'asr' as const }
      await writeState(tabId, next)
      publishState(tabId, next)
      return
    }
    if (event.type === 'final') {
      const identity = state.context.identity
      const segment: BilibiliSubtitleSegment = { start: event.start, end: event.end, text: event.text }
      const { transcriptPreview: _preview, ...withoutPreview } = state
      const next: MomentQTabState = {
        ...withoutPreview,
        subtitleSource: 'asr',
        subtitleSegments: [...(state.subtitleSegments ?? []), segment].slice(-5000),
        ...(identity.kind === 'vod'
          ? { subtitleIdentity: { bvid: identity.bvid, cid: identity.cid } }
          : {}),
      }
      await writeState(tabId, next)
      publishState(tabId, next)
      scheduleAsrTranscriptSync(tabId)
      return
    }
    if (event.type === 'persisted') return
    // A lost upstream (Wi-Fi blip) is retried by the companion on the next
    // audio frame — killing the session here would end transcription on the
    // first hiccup. The next 'ready' clears the note.
    if (event.code === 'provider-connect') {
      reportDiagnostic(`转录中断，等待重连：${event.message}`)
      const next = { ...state, transcriptionError: event.message }
      await writeState(tabId, next)
      publishState(tabId, next)
      return
    }
    // Remaining errors end recognition; transient capture issues are
    // surfaced without tearing the session down.
    const fatal = event.code === 'provider-not-configured'
      || event.code === 'companion-disconnected'
      || event.code === 'capture-start'
    if (event.code === 'capture-start' && offscreenStarted.has(tabId)) {
      // The offscreen consumer could not start (Edge refusing the handoff).
      // Fall back ONCE to the panel document, which hosts the session the
      // old way — closing the panel then ends it, but starting works.
      offscreenStarted.delete(tabId)
      stopClockRelay()
      await deactivateTranscription(tabId, state, `后台会话启动失败（${event.message}），已回退到面板内采集`)
      void beginTranscription(tabId, undefined, 'panel-only').catch(() => {})
      return
    }
    if (fatal) await deactivateTranscription(tabId, state, event.message)
    else {
      reportDiagnostic(`转录错误：${event.message}`)
      const next = { ...state, transcriptionError: event.message }
      await writeState(tabId, next)
      publishState(tabId, next)
    }
  })
}

// The local Whisper engine has no server side to persist finals, so the
// background pushes them to the Host (throttled) — otherwise transcript.jsonl
// stays empty for local-engine sessions and answers lose their evidence.
const asrSyncTimers = new Map<number, ReturnType<typeof setTimeout>>()
const ASR_SYNC_INTERVAL_MS = 8_000

function scheduleAsrTranscriptSync(tabId: number): void {
  if (asrSyncTimers.has(tabId)) return
  asrSyncTimers.set(tabId, setTimeout(() => {
    asrSyncTimers.delete(tabId)
    void syncAsrTranscript(tabId)
  }, ASR_SYNC_INTERVAL_MS))
}

async function syncAsrTranscript(tabId: number): Promise<void> {
  try {
    const state = await readState(tabId)
    if (state?.context.kind !== 'vod' || state.subtitleSource !== 'asr') return
    if ((state.subtitleSegments?.length ?? 0) === 0) return
    const settings = await loadSettings()
    // The companion already persists baidu-engine finals; skip to avoid
    // double writes.
    if (settings.asrProvider !== 'whisper-local') return
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({ identity: state.context.identity, metadata: state.context.metadata })
    await client.syncTranscript(state.context.identity, 'asr', (state.subtitleSegments ?? []).slice(-5000))
  } catch {
    // Persistence is best-effort here; the next final reschedules it.
  }
}

async function applyAsrSession(message: AsrSessionMessage): Promise<void> {
  if (message.tabId !== null) {
    asrTabId = message.tabId
    clearStartAckWatchdog(message.tabId)
    if (message.owner === 'offscreen') {
      offscreenStarted.add(message.tabId)
      startClockRelay(message.tabId)
    }
    return
  }
  // The panel session ended. With stoppedTabId the panel tells us WHICH
  // session ended: during a start-over-start handoff the global pointer may
  // already name the new tab, and its fresh state must survive the old tab's
  // teardown.
  const stoppedTabId = message.stoppedTabId ?? null
  const tabId = stoppedTabId ?? asrTabId
  if (stoppedTabId === null || asrTabId === stoppedTabId) {
    asrTabId = null
    if (stoppedTabId !== null) {
      clearStartAckWatchdog(stoppedTabId)
      offscreenStarted.delete(stoppedTabId)
      stopClockRelay()
    }
  }
  if (tabId !== null) {
    await tabOperations.run(tabId, async () => {
      const state = await readState(tabId)
      if (state === null || state.transcription === 'inactive') return
      // An intentional stop is not an error: state clears without one.
      await deactivateTranscription(tabId, state)
    })
  }
  await closeOffscreenIfIdle()
}

/** After a service-worker restart, re-attach to a live offscreen session. */
async function restoreAsrSession(): Promise<void> {
  const reply = await chrome.runtime.sendMessage({ type: 'MOMENTQ_ASR_QUERY' }).catch(() => null) as AsrSessionMessage | null
  if (reply !== null && isRecord(reply) && reply.type === 'MOMENTQ_ASR_SESSION') {
    await applyAsrSession(reply)
  }
}

/**
 * Reloading the extension mid-recognition destroys the offscreen document,
 * and with it the only thing that would ever report the session's end. Tab
 * states then stay 'active'/'paused' forever and their 'asr' provenance
 * blocks every later subtitle import. At worker startup, after re-attaching
 * to any live session, retire every state that claims a session nobody owns.
 */
async function recoverOrphanedTranscription(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [])
  for (const tab of tabs) {
    const tabId = tab.id
    if (tabId === undefined || tabId === asrTabId) continue
    const state = await readState(tabId)
    if (state === null || state.transcription === 'inactive') continue
    await tabOperations.run(tabId, async () => {
      const current = await readState(tabId)
      if (current === null || current.transcription === 'inactive') return
      await deactivateTranscription(tabId, current)
    })
  }
}

/**
 * Tabs opened before an extension reload keep no live content script, which
 * starves the side panel of the playback clock (and thus the subtitle ticker)
 * until the page is refreshed. Re-inject on demand instead; the script is
 * guarded against double registration.
 */
async function ensureTabBridge(tabId: number): Promise<boolean> {
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' })
    .then(() => true)
    .catch(() => false)
  if (alive) return true
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['assets/content.js'] })
    return true
  } catch {
    // Unsupported page (chrome://, discarded tab, no host access).
    return false
  }
}

async function applyContextUnlocked(tabId: number, context: BilibiliContext | null): Promise<MomentQTabState | null> {
  const previous = await readState(tabId)
  const next = reduceTabState(previous, { type: 'SET_CONTEXT', tabId, context })
  // A part/video switch resets transcription to 'inactive' (identity change
  // drops preserve), and navigating OUT of Bilibili drops the whole state —
  // the capture session must be torn down in BOTH cases, or the panel keeps
  // transcribing whatever audio still flows while every control shows
  // "start" again.
  if (previous !== null && previous.transcription !== 'inactive'
    && (next === null || next.transcription === 'inactive')) {
    void stopAsrSession(tabId)
  }
  await writeState(tabId, next)
  if (JSON.stringify(previous) !== JSON.stringify(next)) publishState(tabId, next)
  if (context?.kind === 'vod') {
    // Detached: the authoritative Bilibili check runs on its own so a slow
    // request can never delay the next context switch for this tab.
    void syncBilibiliSubtitle(tabId, context)
  }
  return await readState(tabId)
}

function applyContext(tabId: number, context: BilibiliContext | null): Promise<MomentQTabState | null> {
  return tabOperations.run(tabId, () => applyContextUnlocked(tabId, context))
}

const verifiedSubtitleIdentities = new Set<string>()
/**
 * Identities whose WBI index provably carries no tracks (valid identity echo,
 * zero tracks, no login required). Any track that later surfaces for one of
 * these — whatever channel it rides, including the player tap — is
 * Bilibili's rotating foreign track for trackless videos; duration alone
 * cannot catch the short ones (measured: a 137s poison inside a 464s host).
 */
const provenTracklessIdentities = new Set<string>()
/** Non-definitive empties may be re-checked after this long (AI subtitles generate lazily). */
const SUBTITLE_RETRY_INTERVAL_MS = 45_000
const subtitleRetryNotBefore = new Map<string, number>()

/** Authoritative Bilibili subtitle check; runs outside the per-tab queue. */
async function syncBilibiliSubtitle(tabId: number, context: Extract<BilibiliContext, { kind: 'vod' }>): Promise<void> {
  const { bvid, cid } = context.identity
  // A positive import or a proven absence is final for this identity; a
  // non-definitive empty stays retryable (throttled) so lazily generated AI
  // tracks are picked up without a page refresh. In-flight dedupe is scoped
  // to the tab as well so two tabs on the same episode each get their own
  // MomentQTabState.
  const verifyKey = `${bvid}:${cid}`
  if (verifiedSubtitleIdentities.has(verifyKey)) return
  const retryNotBefore = subtitleRetryNotBefore.get(verifyKey)
  if (retryNotBefore !== undefined && Date.now() < retryNotBefore) return
  const key = `${tabId}:${bvid}:${cid}`
  const previous = subtitleSyncs.get(key)
  if (previous !== undefined) return await previous
  const current = (async (): Promise<void> => {
    const report = await fetchBilibiliSubtitle(bvid, cid)
    // Timeline sanity gate: a track running past the host video's duration
    // is Bilibili's rotating foreign track for trackless videos — duration
    // is the one identity check a mis-keyed track cannot fake. Reject and
    // treat it like any other non-definitive outcome.
    let imported = report.segments
    let diagnostic = report.diagnostic
    if (imported !== null && imported.length > 0
      && transcriptExceedsHost(imported, context.metadata.durationSeconds)) {
      const overrun = Math.max(...imported.map(segment => segment.end)).toFixed(0)
      diagnostic = `轨时间轴 ${overrun}s 超过视频时长 ${context.metadata.durationSeconds ?? '?'}s，已拒绝（疑似串台轨）`
      imported = null
    }
    if (imported !== null && imported.length > 0) {
      // Bilibili generates its "中文（自动翻译）" (ai-zh) track lazily. A
      // foreign track is imported now but stays retryable so the translated
      // track can replace it; a Chinese import is final.
      if (trackNeedsChineseTranslation(imported)) {
        subtitleRetryNotBefore.set(verifyKey, Date.now() + SUBTITLE_RETRY_INTERVAL_MS)
      } else {
        verifiedSubtitleIdentities.add(verifyKey)
      }
    } else if (report.definitiveEmpty) {
      // WBI says this identity has no tracks at all (identity echo validated,
      // no login required). From now on any track appearing for it is a
      // server-side poison, so record the veto for every channel.
      provenTracklessIdentities.add(verifyKey)
      verifiedSubtitleIdentities.add(verifyKey)
    } else {
      subtitleRetryNotBefore.set(verifyKey, Date.now() + SUBTITLE_RETRY_INTERVAL_MS)
      await writeProbeResult(tabId, bvid, cid, diagnostic ?? '无轨道')
      // No trusted track from the unsigned channel: drop any previously
      // imported panel segments for this identity so poisoned tracks do not
      // linger in the display until the next rebind.
      await tabOperations.run(tabId, async () => {
        const state = await readState(tabId)
        if (state?.context.kind !== 'vod'
          || state.context.identity.bvid !== bvid
          || state.context.identity.cid !== cid) return
        if (state.subtitleSource !== 'bilibili' || state.transcription !== 'inactive') return
        // Player-origin tracks (signed responses via the tap) are trusted;
        // only unsigned-channel imports get dropped here.
        if (state.subtitleTrusted === true) return
        if ((state.subtitleSegments?.length ?? 0) === 0) return
        const {
          subtitleSegments: _segments,
          subtitleIdentity: _identity,
          subtitleSource: _source,
          ...withoutSubtitle
        } = state
        const next = { ...withoutSubtitle, transcription: 'inactive' as const }
        await writeState(tabId, next)
        publishState(tabId, next)
      })
      return
    }
    const settings = await loadSettings()
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    // Flow reaching here means a validated import or a definitive absence;
    // both reconcile the durable transcript.
    const segments = imported ?? []
    // Surface the probe outcome before any Host dependency: a wedged Host
    // must never suppress the panel diagnostic.
    if (segments.length === 0) {
      await writeProbeResult(tabId, bvid, cid, diagnostic ?? '无轨道')
    }
    // ASR finals are this identity's transcript when the video has no
    // Bilibili track; a proven-empty probe must not erase them, durably or
    // from the panel. A real track still replaces them below.
    const current = await readState(tabId)
    const asrFinals = current?.context.kind === 'vod'
      && current.context.identity.bvid === bvid
      && current.context.identity.cid === cid
      && current.subtitleSource === 'asr'
      && (current.subtitleSegments?.length ?? 0) > 0
    // The same protection for a REOPENED video: the durable transcript is the
    // previous session's ASR work, and the empty bilibili import would wipe
    // it before the restore below ever runs.
    let persistedAsrSegments: BilibiliSubtitleSegment[] | null = null
    if (segments.length === 0) {
      if (asrFinals) {
        persistedAsrSegments = current?.subtitleSegments ?? null
      } else {
        try {
          const persisted = await client.getTranscript(context.identity)
          if (persisted.source === 'asr' && persisted.segments.length > 0) {
            persistedAsrSegments = persisted.segments.slice(-5000)
          }
        } catch {
          // An unreachable Host or not-yet-created content: nothing to keep.
        }
      }
    }
    if (!(segments.length === 0 && (asrFinals || persistedAsrSegments !== null))) {
      // Never erase a valid durable transcript before the replacement track has
      // been fetched and validated; a proven absence reconciles whatever is on
      // file for this identity — stale tab-state segments and a mislabelled
      // durable transcript alike.
      await client.ensureContent({ identity: context.identity, metadata: context.metadata })
      await client.syncTranscript(context.identity, 'bilibili', segments)
    }
    await tabOperations.run(tabId, async () => {
      const state = await readState(tabId)
      if (state?.context.kind !== 'vod'
        || state.context.identity.bvid !== bvid
        || state.context.identity.cid !== cid) return
      if (segments.length > 0) {
        await stopAsrSession()
        const { transcriptPreview: _preview, subtitleDiagnostic: _diagnostic, ...withoutStale } = state
        const next = {
          ...withoutStale,
          transcription: 'inactive' as const,
          subtitleSource: 'bilibili' as const,
          subtitleSegments: segments.slice(-5000),
          subtitleIdentity: { bvid, cid },
        }
        await writeState(tabId, next)
        publishState(tabId, next)
        return
      }
      // No usable track: surface the probe result so a genuinely trackless
      // video is distinguishable from a broken fetch.
      const probeNext: MomentQTabState = { ...state, subtitleDiagnostic: diagnostic ?? '无轨道' }
      await writeState(tabId, probeNext)
      publishState(tabId, probeNext)
      if (state.subtitleSource === 'asr' || state.transcription !== 'inactive') return
      if ((state.subtitleSegments?.length ?? 0) > 0) {
        const {
          subtitleSegments: _segments,
          subtitleIdentity: _identity,
          subtitleSource: _source,
          ...withoutSubtitle
        } = state
        const next = { ...withoutSubtitle, transcription: 'inactive' as const }
        await writeState(tabId, next)
        publishState(tabId, next)
        return
      }
      // Reopen restore: the persisted ASR transcript is the previous
      // transcription session's output. Surface it as this video's subtitles
      // so reopening continues where the last session left off — and so a
      // new transcription session appends to the same coverage.
      if (persistedAsrSegments === null || persistedAsrSegments.length === 0) return
      const { subtitleDiagnostic: _diagnostic, ...withoutDiagnostic } = state
      const restored: MomentQTabState = {
        ...withoutDiagnostic,
        subtitleSource: 'asr',
        subtitleSegments: persistedAsrSegments,
        subtitleIdentity: { bvid, cid },
      }
      await writeState(tabId, restored)
      publishState(tabId, restored)
    })
  })().catch((error: unknown) => {
    subtitleRetryNotBefore.delete(verifyKey)
    // A dead DSH Host used to vanish here silently: no subtitles and not
    // even the diagnostic. Surface whatever failed so the panel can say why.
    void writeProbeResult(tabId, bvid, cid, `同步失败：${error instanceof Error ? error.message : String(error)}`)
  })
  subtitleSyncs.set(key, current)
  try {
    await current
  } finally {
    if (subtitleSyncs.get(key) === current) subtitleSyncs.delete(key)
  }
}

/** Page-world track import; network runs outside the per-tab queue. */
async function syncPageSubtitleTracks(tabId: number, message: PageSubtitleTracksMessageEnvelope): Promise<void> {  const state = await readState(tabId)
  if (state?.context.kind !== 'vod'
    || state.context.identity.bvid !== message.payload.bvid
    || state.context.identity.cid !== message.payload.cid) return
  // Veto first: once the authoritative WBI probe proved this identity
  // trackless, a later "track" from any channel is Bilibili's rotating
  // foreign track — short variants slip past the duration gate, so this
  // record is the only defense. Treat it like an absent status.
  if (provenTracklessIdentities.has(`${message.payload.bvid}:${message.payload.cid}`)) {
    if (message.payload.status === 'available') {
      await writeProbeResult(
        tabId, message.payload.bvid, message.payload.cid,
        `已否决迟到的串台轨（WBI 已证实无轨，来源 ${message.payload.origin ?? 'player'}）`,
      )
    }
    return
  }
  // Only a live recognition session owns the transcript; an ended one keeps
  // its finals as provenance until a real track replaces them.
  if (state.transcription !== 'inactive') return
  const context = state.context
  const settings = await loadSettings()
  const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
  if (message.payload.status === 'absent') {
    // The background's authoritative probe already verified a real track for
    // this identity: a page-world "absent" (Bilibili's track list rotates)
    // must not erase a verified import past its final state.
    if (verifiedSubtitleIdentities.has(`${message.payload.bvid}:${message.payload.cid}`)) return
    const hasAsrFinals = state.subtitleSource === 'asr' && (state.subtitleSegments?.length ?? 0) > 0
    if (!hasAsrFinals) {
      // A persisted ASR transcript is durable provenance too: the page-world
      // rotation report must not erase it (the authoritative probe owns that
      // decision and restores it instead).
      let persistedAsr = false
      try {
        const persisted = await client.getTranscript(context.identity)
        persistedAsr = persisted.source === 'asr' && persisted.segments.length > 0
      } catch {
        // Host unreachable: keep the legacy reconcile behavior.
      }
      if (!persistedAsr) {
        await client.ensureContent({ identity: context.identity, metadata: context.metadata })
        await client.syncTranscript(context.identity, 'bilibili', [])
        await tabOperations.run(tabId, async () => {
          const current = await readState(tabId)
          if (current?.context.kind !== 'vod'
            || current.context.identity.bvid !== message.payload.bvid
            || current.context.identity.cid !== message.payload.cid) return
          const {
            subtitleSegments: _segments,
            subtitleIdentity: _identity,
            subtitleSource: _source,
            ...withoutSubtitle
          } = current
          const next = { ...withoutSubtitle, transcription: 'inactive' as const }
          await writeState(tabId, next)
          publishState(tabId, next)
        })
      }
    }
    return
  }
  // The background API import is authoritative. Page-world discovery is only
  // a fallback for a track that is still absent; repeated Bilibili player
  // responses must never replace an already committed track for this CID.
  if (state.subtitleIdentity?.bvid === message.payload.bvid
    && state.subtitleIdentity.cid === message.payload.cid
    && (state.subtitleSegments?.length ?? 0) > 0) return
  for (const track of message.payload.tracks) {
    const segments = await fetchSubtitleTrackUrl(track)
    if (segments === null) continue
    // Same timeline gate as the unsigned channel: even a player-served
    // track cannot run past the host video's duration.
    if (transcriptExceedsHost(segments, state.context.metadata.durationSeconds)) continue
    await client.ensureContent({ identity: context.identity, metadata: context.metadata })
    await client.syncTranscript(context.identity, 'bilibili', segments)
    await tabOperations.run(tabId, async () => {
      const current = await readState(tabId)
      if (current?.context.kind !== 'vod'
        || current.context.identity.bvid !== message.payload.bvid
        || current.context.identity.cid !== message.payload.cid) return
      // Another background/page request may have won while this URL was
      // being downloaded. First valid commit wins; later responses are
      // discarded.
      if (current.subtitleIdentity?.bvid === message.payload.bvid
        && current.subtitleIdentity.cid === message.payload.cid
        && (current.subtitleSegments?.length ?? 0) > 0) return
      await stopAsrSession()
      const { transcriptPreview: _preview, ...withoutPreview } = current
      const next = {
        ...withoutPreview,
        context,
        transcription: 'inactive' as const,
        subtitleSource: 'bilibili' as const,
        subtitleSegments: segments.slice(-5000) as BilibiliSubtitleSegment[],
        subtitleIdentity: { bvid: message.payload.bvid, cid: message.payload.cid },
        ...(message.payload.origin === 'player' ? { subtitleTrusted: true } : {}),
      }
      await writeState(tabId, next)
      publishState(tabId, next)
    })
    return
  }
}

async function readOrResolveState(tabId: number): Promise<MomentQTabState | null> {
  const stored = await readState(tabId)
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const url = tab?.url
  if (url !== undefined && stored !== null && sameContentLocation(url, stored.context.url)) {
    // Opening the panel is itself a re-check trigger: for a trackless video,
    // and for an imported foreign track still waiting on Bilibili's own ai-zh
    // translation. The sync is deduped and throttled, so this stays cheap.
    if (stored.context.kind === 'vod'
      && ((stored.subtitleSegments?.length ?? 0) === 0
        || trackNeedsChineseTranslation(stored.subtitleSegments ?? []))) {
      void syncBilibiliSubtitle(tabId, stored.context)
    }
    return stored
  }
  if (url === undefined || parseBilibiliLocation(url)?.kind !== 'vod') {
    return stored === null ? null : applyContext(tabId, null)
  }
  // Resolution hits the network; it stays outside the per-tab queue and
  // lands through applyContext, which only queues the state write.
  const context = await resolveCurrentVodContext(url, {
    resolve: currentUrl => resolveSnapshotViaBilibiliApi({ url: currentUrl }),
    currentUrl: async () => (await chrome.tabs.get(tabId).catch(() => null))?.url,
  })
  if (context === null) return stored
  // Same pod-navigation hazard as refreshVodContext: a p-less URL resolves
  // to part 1; never clobber a player-proven part binding with it.
  if (context.kind === 'vod' && context.metadata.part !== undefined) {
    const location = parseBilibiliLocation(url)
    if (location?.kind === 'vod' && location.requestedPart === undefined
      && stored?.context.kind === 'vod'
      && stored.context.identity.bvid === context.identity.bvid) {
      return stored
    }
  }
  return applyContext(tabId, context)
}

async function refreshVodContext(tabId: number, url: string): Promise<MomentQTabState | null> {
  const stored = await readState(tabId)
  if (stored !== null && sameContentLocation(url, stored.context.url)) return stored
  const context = await resolveCurrentVodContext(url, {
    resolve: currentUrl => resolveSnapshotViaBilibiliApi({ url: currentUrl }),
    currentUrl: async () => (await chrome.tabs.get(tabId).catch(() => null))?.url,
  })
  // A later navigation may overtake this refresh. Never publish a transient
  // null (or clear the previous frame/subtitle UI) while resolving.
  if (context === null) return await readState(tabId)
  // A p-less URL resolves to the video's first part, but pod navigation can
  // be playing any part. Overwriting a player-proven binding with the
  // part-1 resolution shows part-1 subtitles (or diagnostics) over whatever
  // part is actually playing — subtitles that "do not match the video".
  if (context.kind === 'vod' && context.metadata.part !== undefined) {
    const location = parseBilibiliLocation(url)
    if (location?.kind === 'vod' && location.requestedPart === undefined) {
      const previous = await readState(tabId)
      if (previous?.context.kind === 'vod' && previous.context.identity.bvid === context.identity.bvid) {
        return previous
      }
    }
  }
  return applyContext(tabId, context)
}

async function toggleTranscriptionUnlocked(tabId: number): Promise<MomentQTabState | null> {
  const previous = await readState(tabId)
  if (previous === null) return null
  if (previous.transcription === 'inactive') return await beginTranscription(tabId, undefined)
  const nextTranscription = previous.transcription === 'active' ? 'paused' as const : 'active' as const
  const next = reduceTabState(previous, { type: 'SET_TRANSCRIPTION', transcription: nextTranscription })
  if (next !== previous) {
    await writeState(tabId, next)
    publishState(tabId, next)
  }
  // Scoped: with several windows/panels open, a global pause/resume/stop
  // would act on whichever tab happens to own the live session.
  sendToOffscreen({
    type: nextTranscription === 'paused' ? 'MOMENTQ_ASR_PAUSE' : 'MOMENTQ_ASR_RESUME',
    tabId,
  })
  return next
}

function toggleTranscription(tabId: number): Promise<MomentQTabState | null> {
  return tabOperations.run(tabId, () => toggleTranscriptionUnlocked(tabId))
}

async function handleRequest(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<MomentQTabState | string | number | { cleared: boolean } | null> {
  const type = requestType(message)
  if (!type || !isRecord(message)) return null

  if (type === 'PAGE_SUBTITLE_TRACKS') {
    const tabId = sender.tab?.id
    if (tabId === undefined || !isPageSubtitleTracksMessageEnvelope(message)) return null
    await syncPageSubtitleTracks(tabId, message)
    return await readState(tabId)
  }

  if (type === 'MOMENTQ_ASR_START_FROM_PANEL') {
    const request = message as AsrStartFromPanelMessage
    return await beginTranscription(request.tabId, request.streamId)
  }

  if (type === 'MOMENTQ_ASR_EVENT') {
    const event = message as unknown as AsrEventMessage
    if (!isCompanionServerMessage(event.event)) return null
    await applyAsrEvent(event)
    return await readState(event.tabId)
  }

  if (type === 'MOMENTQ_ASR_SESSION') {
    await applyAsrSession(message as AsrSessionMessage)
    return null
  }

  if (type === 'MOMENTQ_ASR_PANEL_CAPTURE_FAILED') {
    const failure = message as { tabId?: unknown; message?: unknown }
    const tabId = failure.tabId
    if (typeof tabId === 'number' && Number.isSafeInteger(tabId)) {
      await tabOperations.run(tabId, async () => {
        const state = await readState(tabId)
        if (state === null || state.transcription === 'inactive') return
        await deactivateTranscription(tabId, state,
          typeof failure.message === 'string' ? failure.message : '标签页采集启动失败')
      })
    }
    return null
  }

  if (type === 'MOMENTQ_PAGE_CONTEXT') {
    const tabId = sender.tab?.id
    if (tabId === undefined || (!isRecord(message.context) && message.context !== null)) return null
    if (message.context !== null) {
      const currentTab = await chrome.tabs.get(tabId).catch(() => null)
      if (!sameContentLocation(currentTab?.url, (message.context as BilibiliContext).url)) return await readState(tabId)
      const previous = await readState(tabId)
      const incoming = message.context as BilibiliContext
      if (incoming.kind === 'vod') {
        // The player snapshot owns what is playing now. An identical identity
        // is a no-op; anything else re-verifies. A part switch often keeps a
        // p-less URL, so the visible URL alone cannot veto the rebind — the
        // previously accepted state must not swallow a changed player cid.
        if (previous !== null && previous.context.kind === 'vod'
          && previous.context.identity.bvid === incoming.identity.bvid
          && previous.context.identity.cid === incoming.identity.cid) return previous
        const verified = await resolveSnapshotViaBilibiliApi({
          url: currentTab?.url ?? incoming.url,
          title: incoming.metadata.title,
          creator: incoming.metadata.creator,
          vod: {
            bvid: incoming.identity.bvid,
            cid: incoming.identity.cid,
            ...(incoming.metadata.part?.number === undefined ? {} : { pageNumber: incoming.metadata.part.number }),
          },
        })
        if (verified?.kind === 'vod') return applyContext(tabId, verified)
        return previous
      }
    }
    return applyContext(tabId, message.context as BilibiliContext | null)
  }

  if (type === 'MOMENTQ_RESOLVE_PAGE_SNAPSHOT') {
    const tabId = sender.tab?.id
    if (tabId === undefined || !isBilibiliPageSnapshot(message.snapshot)) return null
    const snapshot = message.snapshot
    const context = await resolveSnapshotViaBilibiliApi(snapshot)
    const currentTab = await chrome.tabs.get(tabId).catch(() => null)
    if (!sameContentLocation(currentTab?.url, snapshot.url)) return null
    return applyContext(tabId, context)
  }

  if (type === 'MOMENTQ_TOGGLE_CURRENT_TRANSCRIPTION') {
    const tabId = sender.tab?.id
    return tabId === undefined ? null : toggleTranscription(tabId)
  }

  if (type === 'MOMENTQ_CAPTURE_CURRENT_FRAME') {
    const requestedTab = typeof message.tabId === 'number' && Number.isSafeInteger(message.tabId)
      ? message.tabId
      : undefined
    const active = sender.tab
      ?? (requestedTab !== undefined
        ? await chrome.tabs.get(requestedTab).catch(() => null)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0])
    if (active?.id !== undefined) {
      const grabFrame = (): Promise<string | null> => chrome.tabs.sendMessage(active.id!, { type: 'MOMENTQ_CAPTURE_VIDEO_FRAME' })
        .then((value: unknown) => typeof value === 'string' && value.startsWith('data:image/') ? value : null)
        .catch(() => null)
      const videoFrame = await grabFrame()
      if (videoFrame !== null) return videoFrame
      // No live bridge: re-inject once, then retry so frame capture works on
      // tabs that predate an extension reload.
      if (await ensureTabBridge(active.id)) {
        const retried = await grabFrame()
        if (retried !== null) return retried
      }
    }
    return null
  }

  if (type === 'MOMENTQ_GET_CURRENT_VIDEO_TIME') {
    // The panel names its own tab: falling back to the last-focused window
    // let a dual-window setup read the OTHER window's video clock.
    const requestedTab = typeof message.tabId === 'number' && Number.isSafeInteger(message.tabId)
      ? message.tabId
      : undefined
    const active = sender.tab
      ?? (requestedTab !== undefined
        ? await chrome.tabs.get(requestedTab).catch(() => null)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0])
    if (active?.id === undefined) return null
    const readTime = (): Promise<number | null> => chrome.tabs.sendMessage(active.id!, { type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' })
      .then((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
      .catch(() => null)
    const value = await readTime()
    if (value !== null) return value
    // The playback clock feeds the subtitle ticker; re-injecting the bridge
    // lets a panel opened on an existing video start ticking without a page
    // refresh.
    if (!await ensureTabBridge(active.id)) return null
    return await readTime()
  }

  const tabId = message.tabId
  if (!Number.isSafeInteger(tabId) || typeof tabId !== 'number' || tabId < 0) return null
  if (type === 'MOMENTQ_GET_TAB_STATE') {
    // Panel open: recover the content bridge on pre-reload tabs so the
    // playback clock (and thus subtitles) works without a page refresh.
    void ensureTabBridge(tabId)
    return await readOrResolveState(tabId)
  }
  if (type === 'MOMENTQ_CLEAR_ASR_SUBTITLES') {
    // The archive was just wiped in the Host; drop the tab's in-memory ASR
    // subtitle state so the ticker stops showing cleared rows. A live
    // transcription session keeps its rows (it would re-persist anyway).
    return await tabOperations.run(tabId, async () => {
      const state = await readState(tabId)
      if (state === null || state.subtitleSource !== 'asr' || state.transcription !== 'inactive') {
        return { cleared: false }
      }
      const {
        subtitleSegments: _segments,
        subtitleIdentity: _identity,
        subtitleSource: _source,
        ...withoutSubs
      } = state
      const next = { ...withoutSubs, transcription: 'inactive' as const }
      await writeState(tabId, next)
      publishState(tabId, next)
      return { cleared: true }
    })
  }
  return await toggleTranscription(tabId)
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Liveness + version probe for the side panel: a stale panel document that
  // survived an extension reload compares this against its baked build
  // version and tells the user to reopen the panel.
  if (isRecord(message) && message.type === 'MOMENTQ_PING') {
    sendResponse({ type: 'MOMENTQ_PONG', version: chrome.runtime.getManifest().version })
    return false
  }
  if (requestType(message) === null) return false
  void handleRequest(message, sender).then(sendResponse, () => sendResponse(null))
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  publishRevisions.delete(tabId)
  if (asrTabId === tabId) void stopAsrSession(tabId)
  clearStartAckWatchdog(tabId)
  offscreenStarted.delete(tabId)
  if (clockRelayTabId === tabId) stopClockRelay()
  void tabOperations.run(tabId, () => writeState(tabId, reduceTabState(null, { type: 'REMOVE_TAB' })))
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return
  if (!isSupportedBilibiliUrl(changeInfo.url)) {
    void applyContext(tabId, null)
    return
  }
  if (parseBilibiliLocation(changeInfo.url)?.kind === 'vod') {
    void refreshVodContext(tabId, changeInfo.url!)
  }
})

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-current-frame') {
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([tab]) => {
      const tabId = tab?.id
      if (tabId === undefined) return
      // A command has no sender tab; ask the content script in the active tab
      // to draw the HTMLVideoElement into a canvas and return a data URL.
      const frame = await chrome.tabs.sendMessage(tabId, { type: 'MOMENTQ_CAPTURE_VIDEO_FRAME' }).catch(() => null)
      if (typeof frame === 'string' && frame.startsWith('data:image/')) {
        await chrome.runtime.sendMessage({ type: 'MOMENTQ_FRAME_CAPTURED', dataUrl: frame }).catch(() => {})
      }
    }).catch(() => {})
    return
  }
  if (command === 'toggle-transcription') {
    // A keyboard command is an extension invocation + gesture on the active
    // tab — the same grant the context menu provides — so capture can start
    // directly from here.
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      const tabId = tab?.id
      if (tabId === undefined) return
      // The capture session lives in the side panel; if it is closed the
      // request would broadcast into the void for 8s before the watchdog
      // gives up silently. Open the panel so the user sees what happens.
      void chrome.sidePanel.open({ tabId }).catch(() => {})
      void toggleTranscription(tabId).then(state => {
        const failure = state?.transcriptionError
        if (failure !== undefined) reportDiagnostic(`快捷键转录失败：${failure}`)
      }).catch(() => {})
    })
    return
  }
  if (command !== 'open-side-panel') return
  void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    const tabId = tab?.id
    if (tabId === undefined) return
    return chrome.sidePanel.open({ tabId })
  })
})

/** Periodically re-check video tabs that still have no subtitle track. */
async function reconcileVideoSubtitles(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['https://www.bilibili.com/video/*'] }).catch(() => [])
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    const state = await readState(tab.id)
    if (state?.context.kind !== 'vod') continue
    if (state.transcription !== 'inactive') continue
    // A foreign-language track also stays subscribed: Bilibili's own ai-zh
    // translation is generated lazily and must replace the interim import.
    const segments = state.subtitleSegments ?? []
    if (segments.length > 0 && !trackNeedsChineseTranslation(segments)) continue
    await syncBilibiliSubtitle(tab.id, state.context)
  }
}

async function configureSidePanel(): Promise<void> {
  // A disabled option from an older build can persist across a service-worker
  // restart. Explicitly overwrite it so upgraded installs regain the action.
  await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true })
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}

void configureSidePanel()
void restoreAsrSession().then(() => { void recoverOrphanedTranscription() })
// A context-menu click is BOTH a user invocation and a gesture — the two
// things chrome.tabCapture demands. The Edge sidebar pin never grants them,
// which is why every panel-side start was rejected with "not invoked"; the
// in-page menu is the reliable entry point on the video itself.
chrome.contextMenus.removeAll().catch(() => {})
chrome.contextMenus.create({
  id: 'momentq-toggle-transcription',
  title: 'MomentQ：开始/暂停语音转录',
  contexts: ['page'],
  documentUrlPatterns: ['https://www.bilibili.com/video/*'],
}, () => void chrome.runtime.lastError)
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'momentq-toggle-transcription') return
  const tabId = tab?.id
  if (tabId === undefined) return
  // The capture session lives in the side panel; open it so a start from the
  // menu is visible instead of broadcasting into a closed panel.
  void chrome.sidePanel.open({ tabId }).catch(() => {})
  void toggleTranscription(tabId).then(state => {
    const failure = state?.transcriptionError
    if (failure !== undefined) reportDiagnostic(`菜单转录失败：${failure}`)
  }).catch(() => {})
})
// AI subtitles generate lazily after the player first asks for them; keep
// reconciling trackless video tabs so they appear without a page refresh.
setInterval(() => { void reconcileVideoSubtitles() }, 30_000)
