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
import { loadModelApiKey, loadSettings } from '../shared/settings-store'
import { trackNeedsChineseTranslation, translateSubtitleBatch } from '../shared/translate'

type WorkerRequest = PageContextRuntimeMessage | ResolvePageSnapshotMessage | GetTabStateMessage | ToggleTranscriptionMessage | ToggleCurrentTranscriptionMessage | CaptureCurrentFrameMessage | GetCurrentVideoTimeMessage | PageSubtitleTracksMessageEnvelope | AsrStartFromPanelMessage | AsrEventMessage | AsrSessionMessage

const storageKey = (tabId: number) => `tab:${tabId}`
// The queue serializes fast local state mutations only. Network calls never
// run inside it: a stalled Bilibili/Host request used to block every later
// operation for the tab, freezing the side panel on a previous video until a
// restart.
const tabOperations = new TabOperationQueue()
const subtitleSyncs = new Map<string, Promise<void>>()
const publishRevisions = new Map<number, number>()

/** Tab owning the single offscreen ASR session, if any. */
let asrTabId: number | null = null
let clockPollTimer: ReturnType<typeof setInterval> | undefined

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
  if (value.type === 'PAGE_SUBTITLE_TRACKS' && isPageSubtitleTracksMessageEnvelope(value)) return value.type
  if (value.type === 'MOMENTQ_ASR_START_FROM_PANEL') {
    return typeof value.tabId === 'number' && Number.isSafeInteger(value.tabId) && value.tabId >= 0
      && typeof value.streamId === 'string' && value.streamId !== ''
      ? value.type
      : null
  }
  if (value.type === 'MOMENTQ_ASR_EVENT' || value.type === 'MOMENTQ_ASR_SESSION') return value.type
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

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for MomentQ speech recognition',
  })
}

async function closeOffscreenIfIdle(): Promise<void> {
  if (asrTabId !== null) return
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument()
  } catch { /* the document may already be gone */ }
}

function stopClockPolling(): void {
  if (clockPollTimer !== undefined) {
    clearInterval(clockPollTimer)
    clockPollTimer = undefined
  }
}

function startClockPolling(): void {
  if (clockPollTimer !== undefined) return
  // The side panel polls HTMLVideoElement.currentTime for its own ticker;
  // the recognition stream needs the same clock to anchor transcripts to
  // the media timeline, so poll the content script directly.
  clockPollTimer = setInterval(() => {
    const tabId = asrTabId
    if (tabId === null) {
      stopClockPolling()
      return
    }
    void chrome.tabs.sendMessage(tabId, { type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' })
      .then((value: unknown) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
        sendToOffscreen({ type: 'MOMENTQ_ASR_CLOCK', tabId, mediaTime: value })
      })
      .catch(() => {})
  }, 250)
}

/** Tear down the capture pipeline for the tab that owns it. */
async function stopAsrSession(): Promise<void> {
  if (asrTabId === null) return
  stopClockPolling()
  sendToOffscreen({ type: 'MOMENTQ_ASR_STOP' })
  asrTabId = null
  await closeOffscreenIfIdle()
}

/** Mark a tab's transcription inactive and tear its session down. */
async function deactivateTranscription(tabId: number, state: MomentQTabState, error?: string): Promise<MomentQTabState> {
  const { transcriptPreview: _preview, ...withoutPreview } = state
  const next: MomentQTabState = {
    ...withoutPreview,
    transcription: 'inactive',
    ...(error === undefined ? {} : { transcriptionError: error }),
  }
  await writeState(tabId, next)
  publishState(tabId, next)
  await stopAsrSession()
  await closeOffscreenIfIdle()
  return next
}

/**
 * Start transcription with a tab-capture stream id. The side panel passes
 * one it obtained inside its own click handler (the reliable gesture
 * surface); other entry points let the background try, which some surfaces
 * reject without a user gesture.
 */
async function beginTranscription(tabId: number, streamId: string | undefined): Promise<MomentQTabState | null> {
  const initial = await readState(tabId)
  if (initial === null || initial.transcription !== 'inactive') return await readState(tabId)
  const ownedBySubtitles = initial.subtitleSource !== 'asr'
    && (initial.subtitleSegments?.length ?? 0) > 0
  if (ownedBySubtitles) return initial
  try {
    const settings = await loadSettings()
    const resolvedStreamId = streamId ?? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
    // The content directory must exist before the companion persists rows.
    // Network stays outside the per-tab queue; the queued commit below only
    // re-validates and writes local state.
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({ identity: initial.context.identity, metadata: initial.context.metadata })
    await ensureOffscreenDocument()
    return await tabOperations.run(tabId, async () => {
      const current = await readState(tabId)
      if (current === null || current.transcription !== 'inactive') return await readState(tabId)
      const blockedNow = current.subtitleSource !== 'asr'
        && (current.subtitleSegments?.length ?? 0) > 0
      if (blockedNow) return current
      const { transcriptPreview: _preview, transcriptionError: _error, ...withoutAsrUi } = current
      const next: MomentQTabState = {
        ...withoutAsrUi,
        transcription: 'active',
      }
      await writeState(tabId, next)
      publishState(tabId, next)
      asrTabId = tabId
      startClockPolling()
      sendToOffscreen({
        type: 'MOMENTQ_ASR_START',
        tabId,
        streamId: resolvedStreamId,
        identity: current.context.identity,
        companionBaseUrl: settings.companionBaseUrl,
      })
      return await readState(tabId)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const state = await readState(tabId) ?? initial
    return await tabOperations.run(tabId, () => deactivateTranscription(tabId, state, `无法开始转录：${reason}`))
  }
}

async function applyAsrEvent(message: AsrEventMessage): Promise<void> {
  const tabId = message.tabId
  if (!isCompanionServerMessage(message.event)) return
  await tabOperations.run(tabId, async () => {
    const state = await readState(tabId)
    if (state === null) return
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
      return
    }
    if (event.type === 'persisted') return
    // Errors: a lost provider/companion ends recognition; transient capture
    // issues are surfaced without tearing the session down.
    const fatal = event.code === 'provider-not-configured'
      || event.code === 'companion-disconnected'
      || event.code === 'capture-start'
      || event.code === 'provider-connect'
    if (fatal) await deactivateTranscription(tabId, state, event.message)
    else {
      const next = { ...state, transcriptionError: event.message }
      await writeState(tabId, next)
      publishState(tabId, next)
    }
  })
}

async function applyAsrSession(message: AsrSessionMessage): Promise<void> {
  if (message.tabId !== null) {
    asrTabId = message.tabId
    startClockPolling()
    return
  }
  // The offscreen session ended (socket loss or stop). Deactivate the owning
  // tab's transcription state so the UI reflects reality.
  const tabId = asrTabId
  asrTabId = null
  stopClockPolling()
  if (tabId !== null) {
    await tabOperations.run(tabId, async () => {
      const state = await readState(tabId)
      if (state === null || state.transcription === 'inactive') return
      await deactivateTranscription(tabId, state, '转录已停止')
    })
  }
  await closeOffscreenIfIdle()
}

/** After a service-worker restart, re-attach to a live offscreen session. */
async function restoreAsrSession(): Promise<void> {
  const reply = await chrome.runtime.sendMessage({ type: 'MOMENTQ_ASR_QUERY' }).catch(() => null) as AsrSessionMessage | null
  if (reply !== null && isRecord(reply)) {
    await applyAsrSession(reply as AsrSessionMessage)
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
    if (report.segments !== null && report.segments.length > 0) {
      verifiedSubtitleIdentities.add(verifyKey)
    } else if (report.definitiveEmpty) {
      verifiedSubtitleIdentities.add(verifyKey)
    } else {
      subtitleRetryNotBefore.set(verifyKey, Date.now() + SUBTITLE_RETRY_INTERVAL_MS)
      return
    }
    const settings = await loadSettings()
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    const segments = report.segments ?? []
    // Never erase a valid durable transcript before the replacement track has
    // been fetched and validated; a proven absence reconciles whatever is on
    // file for this identity — stale tab-state segments and a mislabelled
    // durable transcript alike.
    await client.ensureContent({ identity: context.identity, metadata: context.metadata })
    await client.syncTranscript(context.identity, 'bilibili', segments)
    await tabOperations.run(tabId, async () => {
      const state = await readState(tabId)
      if (state?.context.kind !== 'vod'
        || state.context.identity.bvid !== bvid
        || state.context.identity.cid !== cid) return
      if (segments.length > 0) {
        await stopAsrSession()
        const { transcriptPreview: _preview, ...withoutPreview } = state
        const next = {
          ...withoutPreview,
          transcription: 'inactive' as const,
          subtitleSource: 'bilibili' as const,
          subtitleSegments: segments.slice(-5000),
          subtitleIdentity: { bvid, cid },
        }
        await writeState(tabId, next)
        publishState(tabId, next)
        void enrichWithChineseTranslation(tabId, { bvid, cid }, segments)
        return
      }
      if (state.subtitleSource === 'asr' || state.transcription !== 'inactive') return
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
  })().catch(() => {
    subtitleRetryNotBefore.delete(verifyKey)
  })
  subtitleSyncs.set(key, current)
  try {
    await current
  } finally {
    if (subtitleSyncs.get(key) === current) subtitleSyncs.delete(key)
  }
}

// Non-Chinese tracks are machine-translated for display in batches; each
// finished batch is merged into the tab state so Chinese lines appear
// progressively while the rest are still translating.
const TRANSLATION_BATCH_SIZE = 30
const TRANSLATION_CONCURRENCY = 3

async function commitTranslatedSegments(
  tabId: number,
  identity: { bvid: string; cid: string },
  segments: BilibiliSubtitleSegment[],
  translations: readonly string[],
): Promise<void> {
  const annotated = segments.map((segment, index) => {
    const zh = translations[index]
    return zh === undefined || zh === '' ? segment : { ...segment, zh }
  })
  await tabOperations.run(tabId, async () => {
    const state = await readState(tabId)
    if (state?.context.kind !== 'vod'
      || state.context.identity.bvid !== identity.bvid
      || state.context.identity.cid !== identity.cid
      || state.subtitleSource !== 'bilibili'
      || state.subtitleIdentity?.bvid !== identity.bvid
      || state.subtitleIdentity.cid !== identity.cid) return
    if ((state.subtitleSegments?.length ?? 0) !== segments.length) return
    const next: MomentQTabState = { ...state, subtitleSegments: annotated.slice(-5000) }
    await writeState(tabId, next)
    publishState(tabId, next)
  })
}

/**
 * Machine-translate a non-Chinese Bilibili track into Simplified Chinese
 * using the user's model key. Display-only: the durable transcript keeps the
 * original text, and a missing key or a failed batch simply leaves those
 * lines untranslated.
 */
async function enrichWithChineseTranslation(
  tabId: number,
  identity: { bvid: string; cid: string },
  segments: BilibiliSubtitleSegment[],
): Promise<void> {
  if (!trackNeedsChineseTranslation(segments)) return
  const apiKey = await loadModelApiKey().catch(() => '')
  if (apiKey === '') return
  const translations = new Array<string>(segments.length).fill('')
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < segments.length) {
      const start = cursor
      cursor += TRANSLATION_BATCH_SIZE
      const slice = segments.slice(start, start + TRANSLATION_BATCH_SIZE)
      try {
        const batch = await translateSubtitleBatch(slice.map(segment => segment.text), apiKey)
        batch.forEach((text, offset) => { translations[start + offset] = text })
        await commitTranslatedSegments(tabId, identity, segments, translations)
      } catch {
        // One failed batch leaves its lines untranslated; later batches continue.
      }
    }
  }
  await Promise.all(Array.from({ length: TRANSLATION_CONCURRENCY }, worker))
}

/** Page-world track import; network runs outside the per-tab queue. */
async function syncPageSubtitleTracks(tabId: number, message: PageSubtitleTracksMessageEnvelope): Promise<void> {  const state = await readState(tabId)
  if (state?.context.kind !== 'vod'
    || state.context.identity.bvid !== message.payload.bvid
    || state.context.identity.cid !== message.payload.cid) return
  // While recognition owns this content's transcript, neither a proven
  // absence nor a late track may wipe or replace its accumulated rows.
  if (state.subtitleSource === 'asr' || state.transcription !== 'inactive') return
  const context = state.context
  const settings = await loadSettings()
  const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
  if (message.payload.status === 'absent') {
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
      }
      await writeState(tabId, next)
      publishState(tabId, next)
      void enrichWithChineseTranslation(tabId, {
        bvid: message.payload.bvid,
        cid: message.payload.cid,
      }, segments as BilibiliSubtitleSegment[])
    })
    return
  }
}

async function readOrResolveState(tabId: number): Promise<MomentQTabState | null> {
  const stored = await readState(tabId)
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const url = tab?.url
  if (url !== undefined && stored !== null && sameContentLocation(url, stored.context.url)) {
    // Opening the panel on a trackless video is itself a re-check trigger;
    // the sync is deduped and throttled, so this stays cheap.
    if (stored.context.kind === 'vod' && stored.subtitleSource !== 'asr'
      && (stored.subtitleSegments?.length ?? 0) === 0) {
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
  return context === null ? stored : applyContext(tabId, context)
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
  return context === null ? await readState(tabId) : applyContext(tabId, context)
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
  sendToOffscreen({ type: nextTranscription === 'paused' ? 'MOMENTQ_ASR_PAUSE' : 'MOMENTQ_ASR_RESUME' })
  return next
}

function toggleTranscription(tabId: number): Promise<MomentQTabState | null> {
  return tabOperations.run(tabId, () => toggleTranscriptionUnlocked(tabId))
}

async function handleRequest(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<MomentQTabState | string | number | null> {
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

  if (type === 'MOMENTQ_PAGE_CONTEXT') {
    const tabId = sender.tab?.id
    if (tabId === undefined || (!isRecord(message.context) && message.context !== null)) return null
    if (message.context !== null) {
      const currentTab = await chrome.tabs.get(tabId).catch(() => null)
      if (!sameContentLocation(currentTab?.url, (message.context as BilibiliContext).url)) return await readState(tabId)
      const previous = await readState(tabId)
      const incoming = message.context as BilibiliContext
      if (incoming.kind === 'vod') {
        // The visible URL is authoritative. If it already maps to an accepted
        // state, ignore every player snapshot for that URL; Bilibili preloads
        // neighboring CIDs and those transient values must never reach UI.
        if (previous !== null && sameContentLocation(currentTab?.url, previous.context.url)) return previous
        const verified = await resolveSnapshotViaBilibiliApi({
          url: currentTab?.url ?? incoming.url,
          title: incoming.metadata.title,
          creator: incoming.metadata.creator,
          vod: {
            bvid: incoming.identity.bvid,
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
    const active = sender.tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
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
    const active = sender.tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
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
  return await toggleTranscription(tabId)
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (requestType(message) === null) return false
  void handleRequest(message, sender).then(sendResponse, () => sendResponse(null))
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  publishRevisions.delete(tabId)
  if (asrTabId === tabId) void stopAsrSession()
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
    if (state.subtitleSource === 'asr') continue
    if ((state.subtitleSegments?.length ?? 0) > 0) continue
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
void restoreAsrSession()
// AI subtitles generate lazily after the player first asks for them; keep
// reconciling trackless video tabs so they appear without a page refresh.
setInterval(() => { void reconcileVideoSubtitles() }, 30_000)
