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

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < bytes.length && shift < 70) {
    const byte = bytes[cursor++] ?? 0
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: cursor }
    shift += 7
  }
  return null
}

/** Extract signed subtitle URLs from Bilibili's protobuf subtitle-web reply. */
export function subtitleUrlsFromBinary(value: ArrayBuffer | Uint8Array): string[] {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  const urls = new Set<string>()
  const decoder = new TextDecoder()
  const scan = (start: number, end: number, depth: number): void => {
    if (depth > 5) return
    let offset = start
    while (offset < end) {
      const key = readVarint(bytes, offset)
      if (key === null) return
      offset = key.next
      const wire = key.value & 7
      if (wire === 0) {
        const scalar = readVarint(bytes, offset)
        if (scalar === null) return
        offset = scalar.next
      } else if (wire === 1) {
        offset += 8
      } else if (wire === 2) {
        const length = readVarint(bytes, offset)
        if (length === null) return
        offset = length.next
        const childEnd = Math.min(end, offset + length.value)
        const text = decoder.decode(bytes.subarray(offset, childEnd))
        const normalized = subtitleUrl(text)
        if (normalized !== undefined) urls.add(normalized)
        if (depth < 5) scan(offset, childEnd, depth + 1)
        offset = childEnd
      } else if (wire === 5) {
        offset += 4
      } else {
        return
      }
    }
  }
  scan(0, bytes.length, 0)
  return [...urls]
}

/** Parse the subtitle-web response, which is protobuf on current Bilibili pages. */
export function subtitleUrlsFromWebResponse(value: unknown): string[] {
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) return subtitleUrlsFromBinary(value)
  return subtitleTracks(value)
}

function subtitleScore(item: RecordValue): number {
  const lan = (text(item.lan) ?? '').toLowerCase()
  const language = `${lan} ${text(item.lan_doc) ?? ''}`.toLowerCase()
  const chinese = /(^|[-_])zh($|[-_])|中文|中英|简体|繁体/.test(language) ? 1_000 : 0
  const nativeChinese = /^(zh-cn|zh-hans|zh-sg|zh-tw|zh-hant)$/.test(lan) ? 400 : 0
  const aiChinese = lan === 'ai-zh' ? 300 : 0
  const official = item.ai_type === 0 ? 200 : 0
  return chinese + nativeChinese + aiChinese + official
}

export function subtitleTracks(value: unknown): string[] {
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
  const tracks = candidates.flatMap(candidate => Array.isArray(candidate) ? candidate : [])
    .map(record)
    .filter((item): item is RecordValue => item !== null)
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
  return {
    bvid,
    cid,
    tracks,
    definitiveEmpty: tracks.length === 0 && data.need_login_subtitle !== true,
  }
}

export function normalizeSubtitleBody(value: unknown): BilibiliSubtitleSegment[] {
  const root = record(value)
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
