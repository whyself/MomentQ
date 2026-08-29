import type { BilibiliSubtitleSegment } from './protocol'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function subtitleUrl(value: unknown): string | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    return url.protocol === 'https:' && (url.hostname === 'subtitle.bilibili.com' || url.hostname === 'aisubtitle.hdslb.com' || url.hostname === 'aisubtitle.biliapi.com' || url.hostname.endsWith('.hdslb.com'))
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function subtitleScore(item: RecordValue): number {
  const lan = (text(item.lan) ?? '').toLowerCase()
  const language = `${lan} ${text(item.lan_doc) ?? ''}`.toLowerCase()
  // Fetch priority: Chinese, then English, then Japanese; other languages
  // follow. A Japanese official track must not beat an English AI track, so
  // language rank dominates and official status only orders within one
  // language.
  const rank = /(^|[-_])zh($|[-_])|中文|中英|简体|繁体/.test(language) ? 0
    : /(^|[-_])en($|[-_])|英语|英文|english/.test(language) ? 1
    : /(^|[-_])ja($|[-_])|日语|日文|japanese/.test(language) ? 2
    : 3
  const official = item.ai_type === 0 ? 1 : 0
  return (3 - rank) * 1_000 + official
}

export function subtitleTracks(value: unknown, officialOnly = false): string[] {
  const root = record(value)
  const data = record(root?.data)
  const videoData = record(root?.videoData)
  const candidates: unknown[] = [
    record(data?.subtitle)?.subtitles,
    record(data?.subtitle)?.list,
    record(data?.subtitle)?.body,
    record(root?.subtitle)?.subtitles,
    record(root?.subtitle)?.list,
    record(root?.subtitle)?.body,
    record(videoData?.subtitle)?.subtitles,
    record(videoData?.subtitle)?.list,
    record(videoData?.subtitle)?.body,
  ]
  // Unsigned index queries (the extension's own fetch) can return poisoned
  // AI tracks — translations the player never offers. Only human-authored
  // tracks (ai_type absent or 0) are trusted from that channel; AI tracks
  // must come from the player's own signed responses, which the tap sees.
  const tracks = candidates.flatMap(candidate => Array.isArray(candidate) ? candidate : [])
    .map(record)
    .filter((item): item is RecordValue => item !== null)
    .filter(item => !officialOnly || item.ai_type === undefined || item.ai_type === 0)
  return tracks.sort((left, right) => {
    const score = subtitleScore(right) - subtitleScore(left)
    if (score !== 0) return score
    // Bilibili can return equal-scoring tracks in a different order on each
    // request. A URL tie-break keeps the chosen track deterministic.
    return (text(left.subtitle_url) ?? '').localeCompare(text(right.subtitle_url) ?? '')
  })
    .map(track => subtitleUrl(track.subtitle_url))
    .filter((url): url is string => url !== undefined)
}

export type SubtitleIndex = {
  bvid: string
  cid: string
  tracks: string[]
  /** Human-readable lan/lan_doc labels, for UI diagnostics. */
  trackLabels: string[]
  /** True when Bilibili says subtitle generation needs a login. */
  needLogin: boolean
  /** Empty is authoritative only when Bilibili does not require login. */
  definitiveEmpty: boolean
}

/** Parse one player-index response without allowing callers to relabel it. */
export function parseSubtitleIndex(value: unknown): SubtitleIndex | null {
  const root = record(value)
  const data = record(root?.data)
  if (root?.code !== 0 || data === null) return null
  const bvid = text(data.bvid)
  const rawCid = data.cid
  const cid = typeof rawCid === 'number' && Number.isFinite(rawCid)
    ? String(rawCid)
    : text(rawCid)
  if (bvid === undefined || cid === undefined) return null
  const tracks = subtitleTracks(value)
  const rawTracks = [
    ...flatMapTrackRecords(record(root?.subtitle)),
    ...flatMapTrackRecords(record(data?.subtitle)),
    ...flatMapTrackRecords(record(record(root?.videoData)?.subtitle)),
  ]
  const trackLabels = rawTracks
    .map(item => `${text(item.lan) ?? '?'}(${text(item.lan_doc) ?? '?'})`)
  const needLogin = data.need_login_subtitle === true
  return {
    bvid,
    cid,
    tracks,
    trackLabels,
    needLogin,
    definitiveEmpty: tracks.length === 0 && !needLogin,
  }
}

function flatMapTrackRecords(subtitle: RecordValue | null): RecordValue[] {
  const candidates: unknown[] = [
    subtitle?.subtitles,
    subtitle?.list,
    subtitle?.body,
  ]
  return candidates.flatMap(candidate => Array.isArray(candidate) ? candidate : [])
    .map(record)
    .filter((item): item is RecordValue => item !== null)
}

/**
 * True when a track's text is not Simplified Chinese. Bilibili generates its
 * own "中文（自动翻译）" (ai-zh) track lazily for foreign videos, so a
 * non-Chinese import must stay retryable until the translated track appears.
 */
export function trackNeedsChineseTranslation(
  segments: readonly BilibiliSubtitleSegment[],
): boolean {
  const sample = segments.slice(0, 80).map(segment => segment.text).join('')
  const compact = sample.replace(/\s+/g, '')
  if ([...compact].length < 12) return false
  // Kana anywhere means Japanese: a Han share alone cannot separate the two.
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(sample)) return true
  const han = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length
  return han / [...compact].length < 0.25
}

/**
 * Timeline sanity gate. A track whose cues run past the host video's duration
 * cannot belong to it — Bilibili's logged-in index occasionally serves a
 * rotating foreign track for trackless videos under a perfectly valid
 * identity, and duration overrun is the one physical impossibility that
 * catches it (measured: poisoned tracks overrun 45%–374%; healthy tracks
 * never exceed the host). Returns false when the duration is unknown.
 */
export function transcriptExceedsHost(
  segments: readonly { start: number; end: number }[],
  durationSeconds: number | undefined,
): boolean {
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false
  const tolerance = Math.max(5, durationSeconds * 0.02)
  return segments.some(segment => segment.end > durationSeconds + tolerance)
}

export function normalizeSubtitleBody(value: unknown): BilibiliSubtitleSegment[] {  const root = record(value)
  const data = record(root?.data)
  const subtitle = record(root?.subtitle)
  const body = Array.isArray(root?.body) ? root.body
    : Array.isArray(data?.body) ? data.body
    : Array.isArray(subtitle?.body) ? subtitle.body
    : Array.isArray(value) ? value : []
  const segments: BilibiliSubtitleSegment[] = []
  for (const item of body) {
    const row = record(item)
    if (row === null) continue
    const start = typeof row.from === 'number' ? row.from : Number(row.from)
    const end = typeof row.to === 'number' ? row.to : Number(row.to)
    const content = text(row.content)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || content === undefined) continue
    segments.push({ start, end, text: content })
  }
  return segments
}
