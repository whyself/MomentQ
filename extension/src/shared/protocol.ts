export type BilibiliPageSnapshot = {
  url: string
  canonicalUrl?: string
  title?: string
  creator?: {
    id?: string | number
    name?: string
  }
  vod?: {
    bvid?: string
    aid?: string | number
    cid?: string | number
    pageNumber?: number
    pageCount?: number
    partTitle?: string
    durationSeconds?: number
  }
  live?: {
    roomId?: string | number
    canonicalRoomId?: string | number
    liveStartTime?: string
  }
}

export type BilibiliContext =
  | {
      kind: 'vod'
      identity: {
        kind: 'vod'
        bvid: string
        cid: string
      }
      metadata: {
        title: string
        creator: { id?: string; name: string }
        part?: { number: number; title?: string }
        durationSeconds?: number
      }
      url: string
    }
  | {
      kind: 'live'
      identity: {
        kind: 'live'
        canonicalRoomId: string
        liveStartTime: string
      }
      metadata: {
        title: string
        creator: { id?: string; name: string }
      }
      url: string
    }

export type PageMessageEnvelope = {
  source: 'momentq-page'
  version: 1
  type: 'PAGE_SNAPSHOT'
  payload: BilibiliPageSnapshot
}

export type BilibiliSubtitleSegment = {
  start: number
  end: number
  text: string
}
// Structural match of the Host's TranscriptSegment: both Bilibili subtitle
// imports (source "bilibili") and future ASR output (source "asr") persist the
// same { start, end, text } rows through MomentQClient.syncTranscript.

export type PageSubtitleTracksMessageEnvelope = {
  source: 'momentq-page'
  version: 1
  type: 'PAGE_SUBTITLE_TRACKS'
  payload: {
    bvid: string
    cid: string
    /** A validated index response either exposes tracks or proves absence. */
    status: 'available' | 'absent'
    tracks: string[]
    /** 'player' = captured from the player's own signed response (AI tracks trusted); 'probe' = the page's unsigned query (official tracks only). */
    origin?: 'player' | 'probe'
  }
}

export type PageContextRuntimeMessage = {
  type: 'MOMENTQ_PAGE_CONTEXT'
  context: BilibiliContext | null
}

export type ResolvePageSnapshotMessage = {
  type: 'MOMENTQ_RESOLVE_PAGE_SNAPSHOT'
  snapshot: BilibiliPageSnapshot
}

export type TranscriptionState = 'inactive' | 'active' | 'paused'

/** Where the current subtitleSegments came from; ASR finals land here too. */
export type SubtitleSource = 'bilibili' | 'asr'

export type MomentQTabState = {
  tabId: number
  context: BilibiliContext
  transcription: TranscriptionState
  /** Complete subtitle track or accumulated ASR finals for this content. */
  subtitleSegments?: BilibiliSubtitleSegment[]
  /** Identity of subtitleSegments; the UI must never render across a mismatch. */
  subtitleIdentity?: { bvid: string; cid: string }
  /** Provenance of subtitleSegments; set to 'asr' while recognition owns it. */
  subtitleSource?: SubtitleSource
  /** True when the displayed track came from the player's own signed response. */
  subtitleTrusted?: boolean
  /** Last subtitle-index probe result, shown when the video shows no track. */
  subtitleDiagnostic?: string
  /** In-flight ASR partial sentence, display-only until a final lands. */
  transcriptPreview?: string
  /** Last ASR/capture failure worth surfacing in the side panel. */
  transcriptionError?: string
}

export type GetTabStateMessage = {
  type: 'MOMENTQ_GET_TAB_STATE'
  tabId: number
}

export type ToggleTranscriptionMessage = {
  type: 'MOMENTQ_TOGGLE_TRANSCRIPTION'
  tabId: number
}

export type ToggleCurrentTranscriptionMessage = {
  type: 'MOMENTQ_TOGGLE_CURRENT_TRANSCRIPTION'
}

export type CaptureCurrentFrameMessage = {
  type: 'MOMENTQ_CAPTURE_CURRENT_FRAME'
  /** Panel → background: the tab whose video to capture (else active tab). */
  tabId?: number
}

export type GetCurrentVideoTimeMessage = {
  type: 'MOMENTQ_GET_CURRENT_VIDEO_TIME'
  /** Panel → background: the tab whose clock to read (else active tab). */
  tabId?: number
}

/** Panel → background: resolve the DASH audio stream for offline ASR. */
export type ResolveDashAudioMessage = {
  type: 'MOMENTQ_RESOLVE_DASH_AUDIO'
  bvid: string
  cid: string
}

/** Panel → background: proxy-fetch a URL with browser-credible headers. */
export type ProxyFetchMessage = {
  type: 'MOMENTQ_PROXY_FETCH'
  url: string
}

/**
 * Panel → background: publish pre-transcription segments into the tab's
 * subtitle state so the ticker can show them immediately (the Host
 * syncTranscript call is durable but the UI only reads tab state). The panel
 * always sends the CUMULATIVE batch, so a duplicate delivery (SW restart,
 * retry) replaces instead of stacking.
 */
export type PreTranscribeSegmentsMessage = {
  type: 'MOMENTQ_PRETRANSCRIBE_SEGMENTS'
  tabId: number
  bvid: string
  cid: string
  segments: BilibiliSubtitleSegment[]
}

/** Panel → content script: seek the active video to an answer's timestamp. */
export type SeekVideoMessage = {
  type: 'MOMENTQ_SEEK_VIDEO'
  seconds: number
}

/** Settings → background: drop the tab's in-memory ASR subtitle state. */
export type ClearAsrSubtitlesMessage = {
  type: 'MOMENTQ_CLEAR_ASR_SUBTITLES'
  tabId: number
}

export type TabStateChangedMessage = {
  type: 'MOMENTQ_TAB_STATE_CHANGED'
  tabId: number
  state: MomentQTabState | null
  /** Monotonic per-tab publication id used to reject late messages. */
  revision?: number
}

// --- Internal ASR pipeline messages (background ↔ offscreen ↔ side panel) ---

/**
 * Side panel start: the panel owns the tabCapture user gesture, so it calls
 * chrome.tabCapture.getMediaStreamId() in its click handler and hands the
 * streamId to the background for the rest of the pipeline.
 */
export type AsrStartFromPanelMessage = {
  type: 'MOMENTQ_ASR_START_FROM_PANEL'
  tabId: number
  streamId: string
}

export type AsrStartMessage = {
  type: 'MOMENTQ_ASR_START'
  tabId: number
  streamId: string
  identity: BilibiliContext['identity']
  companionBaseUrl: string
}

export type AsrClockMessage = {
  type: 'MOMENTQ_ASR_CLOCK'
  tabId: number
  mediaTime: number
}

export type AsrPauseMessage = { type: 'MOMENTQ_ASR_PAUSE' }
export type AsrResumeMessage = { type: 'MOMENTQ_ASR_RESUME' }
export type AsrStopMessage = { type: 'MOMENTQ_ASR_STOP' }
export type AsrQueryMessage = { type: 'MOMENTQ_ASR_QUERY' }

/** Offscreen → background session answer (also used after service-worker restarts). */
export type AsrSessionMessage = {
  type: 'MOMENTQ_ASR_SESSION'
  tabId: number | null
  /** On tabId:null: the tab whose session actually ended (multi-tab handoff). */
  stoppedTabId?: number
  /** Which extension document owns the capture session. */
  owner?: 'panel' | 'offscreen'
}

/** Background → panel: mint a stream id and start (or hand off) a session. */
export type AsrRequestStartMessage = {
  type: 'MOMENTQ_ASR_REQUEST_START'
  tabId: number
  /**
   * 'panel' forces the panel document to consume the id itself (offscreen
   * fallback); absent lets the panel hand the id back for offscreen hosting.
   */
  consumer?: 'panel'
}

/** Background → panel: consume a panel-minted stream id in the panel document. */
export type AsrStartPanelSessionMessage = {
  type: 'MOMENTQ_ASR_START_PANEL_SESSION'
  tabId: number
  streamId: string
  identity: BilibiliContext['identity']
  companionBaseUrl: string
  engine: 'baidu' | 'whisper'
  whisperModel?: string
}

export type AsrEventMessage = {
  type: 'MOMENTQ_ASR_EVENT'
  tabId: number
  event: import('../../../shared/src/companion-protocol').CompanionServerMessage
}

type PlainRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: PlainRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isOptionalString(value: PlainRecord, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'string'
}

function isOptionalId(value: PlainRecord, key: string): boolean {
  return !Object.hasOwn(value, key)
    || typeof value[key] === 'string'
    || (typeof value[key] === 'number' && Number.isFinite(value[key]))
}

function isOptionalFiniteNumber(value: PlainRecord, key: string): boolean {
  return !Object.hasOwn(value, key)
    || (typeof value[key] === 'number' && Number.isFinite(value[key]))
}

function isCreator(value: unknown): boolean {
  return isPlainRecord(value)
    && hasOnlyKeys(value, ['id', 'name'])
    && isOptionalId(value, 'id')
    && isOptionalString(value, 'name')
}

function isVodSnapshot(value: unknown): boolean {
  return isPlainRecord(value)
    && hasOnlyKeys(value, ['bvid', 'aid', 'cid', 'pageNumber', 'pageCount', 'partTitle', 'durationSeconds'])
    && isOptionalString(value, 'bvid')
    && isOptionalId(value, 'aid')
    && isOptionalId(value, 'cid')
    && isOptionalFiniteNumber(value, 'pageNumber')
    && isOptionalFiniteNumber(value, 'pageCount')
    && isOptionalString(value, 'partTitle')
    && isOptionalFiniteNumber(value, 'durationSeconds')
}

function isLiveSnapshot(value: unknown): boolean {
  return isPlainRecord(value)
    && hasOnlyKeys(value, ['roomId', 'canonicalRoomId', 'liveStartTime'])
    && isOptionalId(value, 'roomId')
    && isOptionalId(value, 'canonicalRoomId')
    && isOptionalString(value, 'liveStartTime')
}

export function isBilibiliPageSnapshot(value: unknown): value is BilibiliPageSnapshot {
  if (!isPlainRecord(value)
    || !hasOnlyKeys(value, ['url', 'canonicalUrl', 'title', 'creator', 'vod', 'live'])
    || typeof value.url !== 'string'
    || !isOptionalString(value, 'canonicalUrl')
    || !isOptionalString(value, 'title')) return false
  if (Object.hasOwn(value, 'creator') && !isCreator(value.creator)) return false
  if (Object.hasOwn(value, 'vod') && !isVodSnapshot(value.vod)) return false
  if (Object.hasOwn(value, 'live') && !isLiveSnapshot(value.live)) return false
  return !(Object.hasOwn(value, 'vod') && Object.hasOwn(value, 'live'))
}

export function isPageMessageEnvelope(value: unknown): value is PageMessageEnvelope {
  return isPlainRecord(value)
    && hasOnlyKeys(value, ['source', 'version', 'type', 'payload'])
    && Object.hasOwn(value, 'source') && value.source === 'momentq-page'
    && Object.hasOwn(value, 'version') && value.version === 1
    && Object.hasOwn(value, 'type') && value.type === 'PAGE_SNAPSHOT'
    && Object.hasOwn(value, 'payload') && isBilibiliPageSnapshot(value.payload)
}

export function isPageSubtitleTracksMessageEnvelope(value: unknown): value is PageSubtitleTracksMessageEnvelope {
  return isPlainRecord(value)
    && hasOnlyKeys(value, ['source', 'version', 'type', 'payload'])
    && value.source === 'momentq-page' && value.version === 1 && value.type === 'PAGE_SUBTITLE_TRACKS'
    && isPlainRecord(value.payload)
    && hasOnlyKeys(value.payload, ['bvid', 'cid', 'status', 'tracks', 'origin'])
    && typeof value.payload.bvid === 'string' && value.payload.bvid.trim() !== ''
    && typeof value.payload.cid === 'string' && value.payload.cid.trim() !== ''
    && (value.payload.origin === undefined
      || value.payload.origin === 'player'
      || value.payload.origin === 'probe')
    && (value.payload.status === 'available' || value.payload.status === 'absent')
    && Array.isArray(value.payload.tracks)
    && ((value.payload.status === 'available' && value.payload.tracks.length > 0)
      || (value.payload.status === 'absent' && value.payload.tracks.length === 0))
    && value.payload.tracks.every(track => typeof track === 'string' && track.startsWith('https://'))
}

