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

export type BilibiliContextResolver = (
  snapshot: BilibiliPageSnapshot,
) => Promise<BilibiliContext | null>

/**
 * Resolved contexts are immutable per bvid, and Bilibili rate-limits the
 * view endpoint hard. On SPA navigations the page's __INITIAL_STATE__ can
 * stay stale indefinitely, so resolution retries on every debounced page
 * publish — cache successes forever and throttle repeated attempts for the
 * same bvid, or the request storm trips the limit and the side panel sticks
 * to the previous video until a full page reload.
 */
export const CONTEXT_CACHE_LIMIT = 50
export const DEFAULT_VIEW_RETRY_INTERVAL_MS = 5_000

export function createBilibiliContextResolver(options: {
  request?: typeof fetch
  now?: () => number
  retryIntervalMs?: number
} = {}): BilibiliContextResolver {
  const request = options.request ?? fetch
  const now = options.now ?? Date.now
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_VIEW_RETRY_INTERVAL_MS
  const cache = new Map<string, BilibiliContext>()
  const lastAttempts = new Map<string, number>()

  return async (snapshot: BilibiliPageSnapshot): Promise<BilibiliContext | null> => {
    const existing = normalizeBilibiliContext(snapshot)
    if (existing !== null) return existing

    const location = parseBilibiliLocation(snapshot.url)
    if (location?.kind !== 'vod') return null

    // Multi-part videos resolve per part: keying by bvid alone made every
    // part switch reuse the first-resolved part's context.
    const cacheKey = `${location.bvid}:${location.requestedPart ?? snapshot.vod?.cid ?? 'default'}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      cache.delete(cacheKey)
      cache.set(cacheKey, cached)
      return cached
    }

    const lastAttempt = lastAttempts.get(location.bvid)
    const nowMs = now()
    if (lastAttempt !== undefined && nowMs - lastAttempt < retryIntervalMs) return null
    lastAttempts.set(location.bvid, nowMs)

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

    const context = normalizeBilibiliContext({
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
    if (context === null) return null
    cache.set(cacheKey, context)
    if (cache.size > CONTEXT_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return context
  }
}

export const resolveSnapshotViaBilibiliApi: BilibiliContextResolver = createBilibiliContextResolver()
