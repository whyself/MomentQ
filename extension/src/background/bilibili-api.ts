import { normalizeBilibiliContext, parseBilibiliLocation } from '../shared/bilibili'
import type { BilibiliContext, BilibiliPageSnapshot } from '../shared/protocol'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function id(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function selectApiPage(
  pages: readonly unknown[],
  requestedPage: number | undefined,
  currentCid: string | number | undefined,
): { cid?: string | number; pageNumber?: number; partTitle?: string } {
  const records = pages.map(record).filter(page => page !== null)
  const selected = requestedPage === undefined
    ? records.find(page => currentCid !== undefined && String(page.cid) === String(currentCid))
    : records.find(page => positiveInteger(page.page) === requestedPage)
  const pageNumber = positiveInteger(selected?.page) ?? requestedPage
  const partTitle = string(selected?.part)
  const cid = selected === undefined && requestedPage !== undefined
    ? undefined
    : id(selected?.cid) ?? currentCid
  return {
    ...(cid === undefined ? {} : { cid }),
    ...(pageNumber === undefined ? {} : { pageNumber }),
    ...(partTitle === undefined ? {} : { partTitle }),
  }
}

export async function resolveSnapshotViaBilibiliApi(
  snapshot: BilibiliPageSnapshot,
  request: typeof fetch = fetch,
): Promise<BilibiliContext | null> {
  const existing = normalizeBilibiliContext(snapshot)
  if (existing !== null) return existing

  const location = parseBilibiliLocation(snapshot.url)
  if (location?.kind !== 'vod') return null

  let payload: unknown
  try {
    const response = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(location.bvid)}`)
    if (!response.ok) return null
    payload = await response.json()
  } catch {
    return null
  }

  const envelope = record(payload)
  const data = record(envelope?.data)
  const owner = record(data?.owner)
  if (envelope?.code !== 0 || data === null || data.bvid !== location.bvid) return null

  const pages = Array.isArray(data.pages) ? data.pages : []
  const selected = selectApiPage(pages, location.requestedPart, id(data.cid))
  const title = string(data.title) ?? snapshot.title
  const creatorName = string(owner?.name) ?? snapshot.creator?.name
  const creatorId = id(owner?.mid) ?? snapshot.creator?.id
  const pageCount = pages.length > 0 ? pages.length : positiveInteger(data.videos)

  return normalizeBilibiliContext({
    ...snapshot,
    ...(title === undefined ? {} : { title }),
    ...(creatorName === undefined ? {} : { creator: {
      ...(creatorId === undefined ? {} : { id: creatorId }),
      name: creatorName,
    } }),
    vod: {
      bvid: location.bvid,
      ...(selected.cid === undefined ? {} : { cid: selected.cid }),
      ...(selected.pageNumber === undefined ? {} : { pageNumber: selected.pageNumber }),
      ...(pageCount === undefined ? {} : { pageCount }),
      ...(selected.partTitle === undefined ? {} : { partTitle: selected.partTitle }),
    },
  })
}
