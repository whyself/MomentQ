import type { BilibiliContext, BilibiliPageSnapshot } from './protocol'

export type ParsedBilibiliLocation =
  | { kind: 'vod'; bvid: string; requestedPart?: number }
  | { kind: 'live'; roomId: string }

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/
const DECIMAL_ID_PATTERN = /^[1-9]\d*$/
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function decimalId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  return typeof value === 'string' && DECIMAL_ID_PATTERN.test(value) ? value : null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function creatorMetadata(snapshot: BilibiliPageSnapshot): { id?: string; name: string } | null {
  const name = nonEmptyString(snapshot.creator?.name)
  if (!name) return null
  const id = decimalId(snapshot.creator?.id)
  return id ? { id, name } : { name }
}

function normalizedUrl(input: string): string | null {
  try {
    const url = new URL(input)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function normalizedIsoDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = ISO_DATE_TIME_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[7] === 'Z' ? 0 : Number(match[8])
  const offsetMinute = match[7] === 'Z' ? 0 : Number(match[9])
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0
  if (year === 0 || day < 1 || day > daysInMonth || hour > 23
    || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute > 0)) return null
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null
}

export function parseBilibiliLocation(input: string | URL): ParsedBilibiliLocation | null {
  let url: URL
  try {
    url = input instanceof URL ? input : new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  if (url.hostname === 'www.bilibili.com') {
    const match = /^\/video\/([^/]+)\/?$/.exec(url.pathname)
    const bvid = match?.[1]
    if (!bvid || !BVID_PATTERN.test(bvid)) return null

    const partValues = url.searchParams.getAll('p')
    if (partValues.length === 0) return { kind: 'vod', bvid }
    if (partValues.length !== 1 || !DECIMAL_ID_PATTERN.test(partValues[0] ?? '')) return null
    const requestedPart = Number(partValues[0])
    if (!Number.isSafeInteger(requestedPart)) return null
    return { kind: 'vod', bvid, requestedPart }
  }

  if (url.hostname === 'live.bilibili.com') {
    const match = /^\/([1-9]\d*)\/?$/.exec(url.pathname)
    return match?.[1] ? { kind: 'live', roomId: match[1] } : null
  }

  return null
}

export function normalizeBilibiliContext(snapshot: BilibiliPageSnapshot): BilibiliContext | null {
  const parsed = parseBilibiliLocation(snapshot.url)
  const url = normalizedUrl(snapshot.url)
  const title = nonEmptyString(snapshot.title)
  const creator = creatorMetadata(snapshot)
  if (!parsed || !url || !title || !creator) return null

  if (parsed.kind === 'vod') {
    if (snapshot.vod?.bvid !== undefined && snapshot.vod.bvid !== parsed.bvid) return null
    const cid = decimalId(snapshot.vod?.cid)
    if (!cid) return null

    const pageCount = positiveInteger(snapshot.vod?.pageCount)
    const snapshotPage = positiveInteger(snapshot.vod?.pageNumber)
    // Bilibili's SPA can briefly expose a zero-based `p` query while the
    // player reports the one-based page number. Trust the player's CID when
    // the values differ by exactly one; reject unrelated snapshots.
    if (parsed.requestedPart !== undefined && snapshotPage !== null
      && parsed.requestedPart !== snapshotPage
      && parsed.requestedPart + 1 !== snapshotPage) return null
    const currentPage = snapshotPage ?? parsed.requestedPart ?? null
    const part = pageCount !== null && pageCount > 1
      && currentPage !== null && currentPage <= pageCount
      ? (() => {
          const partTitle = nonEmptyString(snapshot.vod?.partTitle)
          return partTitle ? { number: currentPage, title: partTitle } : { number: currentPage }
        })()
      : undefined

    return {
      kind: 'vod',
      identity: { kind: 'vod', bvid: parsed.bvid, cid },
      metadata: part ? { title, creator, part } : { title, creator },
      url,
    }
  }

  const snapshotRoomId = snapshot.live?.roomId === undefined
    ? parsed.roomId
    : decimalId(snapshot.live.roomId)
  const canonicalRoomId = decimalId(snapshot.live?.canonicalRoomId)
  const liveStartTime = normalizedIsoDateTime(snapshot.live?.liveStartTime)
  if (snapshotRoomId !== parsed.roomId || !canonicalRoomId
    || liveStartTime === null) {
    return null
  }

  return {
    kind: 'live',
    identity: {
      kind: 'live',
      canonicalRoomId,
      liveStartTime,
    },
    metadata: { title, creator },
    url,
  }
}
