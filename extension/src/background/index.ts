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
import { loadSettings } from '../shared/settings-store'

type WorkerRequest = PageContextRuntimeMessage | ResolvePageSnapshotMessage | GetTabStateMessage | ToggleTranscriptionMessage | ToggleCurrentTranscriptionMessage | CaptureCurrentFrameMessage | GetCurrentVideoTimeMessage | PageSubtitleTracksMessageEnvelope | AsrStartFromPanelMessage | AsrEventMessage | AsrSessionMessage

const storageKey = (tabId: number) => `tab:${tabId}`
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
  return await tabOperations.run(tabId, async () => {
    const state = await readState(tabId)
    if (state === null || state.transcription !== 'inactive') return await readState(tabId)
    const ownedBySubtitles = state.subtitleSource !== 'asr'
      && (state.subtitleSegments?.length ?? 0) > 0
    if (ownedBySubtitles) return state
    try {
      const settings = await loadSettings()
      const resolvedStreamId = streamId ?? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      // The content directory must exist before the companion persists rows.
      const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
      await client.ensureContent({ identity: state.context.identity, metadata: state.context.metadata })
      await ensureOffscreenDocument()
      const { transcriptPreview: _preview, transcriptionError: _error, ...withoutAsrUi } = state
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
        identity: state.context.identity,
        companionBaseUrl: settings.companionBaseUrl,
      })
      return await readState(tabId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return await deactivateTranscription(tabId, state, `无法开始转录：${reason}`)
    }
  })
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

async function applyContextUnlocked(tabId: number, context: BilibiliContext | null): Promise<MomentQTabState | null> {
  const previous = await readState(tabId)
  const next = reduceTabState(previous, { type: 'SET_CONTEXT', tabId, context })
  await writeState(tabId, next)
  if (JSON.stringify(previous) !== JSON.stringify(next)) publishState(tabId, next)
  if (context?.kind === 'vod') {
    const subtitleMatches = next?.context.kind === 'vod'
      && next.subtitleIdentity?.bvid === context.identity.bvid
      && next.subtitleIdentity.cid === context.identity.cid
      && (next.subtitleSegments?.length ?? 0) > 0
    // Do not permanently mark a content key as initialized: extension reloads
    // and tab navigation can clear the in-memory tab state while the same
    // video remains open. Hydrate the state again whenever its matching track
    // is absent.
    if (!subtitleMatches) await syncBilibiliSubtitle(tabId, context)
  }
  return await readState(tabId)
}

async function syncBilibiliSubtitle(tabId: number, context: Extract<BilibiliContext, { kind: 'vod' }>): Promise<void> {
  // Scope the in-flight import to the tab as well as the content. Two tabs
  // watching the same episode must each receive their own MomentQTabState.
  const key = `${tabId}:${context.identity.bvid}:${context.identity.cid}`
  const previous = subtitleSyncs.get(key)
  if (previous !== undefined) return await previous
  const current = (async (): Promise<void> => {
    const existing = await readState(tabId)
    // While recognition owns this content's transcript, a re-discovered
    // Bilibili track must not silently replace accumulated ASR rows.
    if (existing?.subtitleSource === 'asr') return
    const settings = await loadSettings()
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    const segments = await fetchBilibiliSubtitle(context.identity.bvid, context.identity.cid)
    if (segments === null || segments.length === 0) return
    // Never erase a valid durable transcript before the replacement track has
    // been fetched and validated. A temporary API failure must not make an
    // existing session lose all subtitles.
    await client.ensureContent({ identity: context.identity, metadata: context.metadata })
    await client.syncTranscript(context.identity, 'bilibili', segments)
    const state = await readState(tabId)
    if (state?.context.kind === 'vod'
      && state.context.identity.bvid === context.identity.bvid
      && state.context.identity.cid === context.identity.cid) {
      await stopAsrSession()
      const { transcriptPreview: _preview, ...withoutPreview } = state
      const next = {
        ...withoutPreview,
        transcription: 'inactive' as const,
        subtitleSource: 'bilibili' as const,
        subtitleSegments: segments.slice(-5000),
        subtitleIdentity: { bvid: context.identity.bvid, cid: context.identity.cid },
      }
      await writeState(tabId, next)
      publishState(tabId, next)
    }
  })().catch(() => undefined)
  subtitleSyncs.set(key, current)
  try {
    await current
  } finally {
    if (subtitleSyncs.get(key) === current) subtitleSyncs.delete(key)
  }
}

async function syncPageSubtitleTracks(tabId: number, message: PageSubtitleTracksMessageEnvelope): Promise<void> {
  const state = await readState(tabId)
  if (state?.context.kind !== 'vod'
    || state.context.identity.bvid !== message.payload.bvid
    || state.context.identity.cid !== message.payload.cid) return
  // While recognition owns this content's transcript, neither a proven
  // absence nor a late track may wipe or replace its accumulated rows.
  if (state.subtitleSource === 'asr' || state.transcription !== 'inactive') return
  if (message.payload.status === 'absent') {
    const settings = await loadSettings()
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({ identity: state.context.identity, metadata: state.context.metadata })
    await client.syncTranscript(state.context.identity, 'bilibili', [])
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
    return
  }
  // The background API import is authoritative. Page-world discovery is only
  // a fallback for a track that is still absent; repeated Bilibili player
  // responses must never replace an already committed track for this CID.
  if (state.subtitleIdentity?.bvid === message.payload.bvid
    && state.subtitleIdentity.cid === message.payload.cid
    && (state.subtitleSegments?.length ?? 0) > 0) return
  const context = state.context
  for (const track of message.payload.tracks) {
    const segments = await fetchSubtitleTrackUrl(track)
    if (segments === null) continue
    const settings = await loadSettings()
    const client = new MomentQClient({ baseUrl: settings.hostBaseUrl })
    await client.ensureContent({ identity: context.identity, metadata: context.metadata })
    await client.syncTranscript(context.identity, 'bilibili', segments)
    const current = await readState(tabId)
    if (current?.context.kind !== 'vod'
      || current.context.identity.bvid !== message.payload.bvid
      || current.context.identity.cid !== message.payload.cid) return
    // Another background/page request may have won while this URL was being
    // downloaded. First valid commit wins; later responses are discarded.
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
    return
  }
}

function applyContext(tabId: number, context: BilibiliContext | null): Promise<MomentQTabState | null> {
  return tabOperations.run(tabId, () => applyContextUnlocked(tabId, context))
}

async function readOrResolveStateUnlocked(tabId: number): Promise<MomentQTabState | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const url = tab?.url
  const stored = await readState(tabId)
  if (url !== undefined && stored !== null && sameContentLocation(url, stored.context.url)) return stored
  if (url === undefined || parseBilibiliLocation(url)?.kind !== 'vod') {
    return stored === null ? null : applyContextUnlocked(tabId, null)
  }
  const context = await resolveCurrentVodContext(url, {
    resolve: currentUrl => resolveSnapshotViaBilibiliApi({ url: currentUrl }),
    currentUrl: async () => (await chrome.tabs.get(tabId).catch(() => null))?.url,
  })
  return context === null ? stored : applyContextUnlocked(tabId, context)
}

async function refreshVodContextUnlocked(tabId: number, url: string): Promise<MomentQTabState | null> {
  const stored = await readState(tabId)
  if (stored !== null && sameContentLocation(url, stored.context.url)) return stored
  const context = await resolveCurrentVodContext(url, {
    resolve: currentUrl => resolveSnapshotViaBilibiliApi({ url: currentUrl }),
    currentUrl: async () => (await chrome.tabs.get(tabId).catch(() => null))?.url,
  })
  // A later navigation may overtake this queued refresh. Never publish a
  // transient null (or clear the previous frame/subtitle UI) while resolving.
  return context === null ? await readState(tabId) : applyContextUnlocked(tabId, context)
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
    return tabOperations.run(tabId, async () => {
      await syncPageSubtitleTracks(tabId, message)
      return await readState(tabId)
    })
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
      const videoFrame = await chrome.tabs.sendMessage(active.id, { type: 'MOMENTQ_CAPTURE_VIDEO_FRAME' }).catch(() => null)
      if (typeof videoFrame === 'string' && videoFrame.startsWith('data:image/')) return videoFrame
    }
    return null
  }

  if (type === 'MOMENTQ_GET_CURRENT_VIDEO_TIME') {
    const active = sender.tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    if (active?.id === undefined) return null
    const value = await chrome.tabs.sendMessage(active.id, { type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME' }).catch(() => null)
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }

  const tabId = message.tabId
  if (!Number.isSafeInteger(tabId) || typeof tabId !== 'number' || tabId < 0) return null
  return type === 'MOMENTQ_GET_TAB_STATE'
    ? tabOperations.run(tabId, () => readOrResolveStateUnlocked(tabId))
    : toggleTranscription(tabId)
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
    void tabOperations.run(tabId, () => refreshVodContextUnlocked(tabId, changeInfo.url!))
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

async function configureSidePanel(): Promise<void> {
  // A disabled option from an older build can persist across a service-worker
  // restart. Explicitly overwrite it so upgraded installs regain the action.
  await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true })
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}

void configureSidePanel()
void restoreAsrSession()
