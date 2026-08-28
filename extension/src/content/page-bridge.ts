import type { BilibiliPageSnapshot, PageMessageEnvelope, PageSubtitleTracksMessageEnvelope } from '../shared/protocol'
import { parseSubtitleIndex, subtitleTracks, subtitleUrlsFromWebResponse } from '../shared/bilibili-subtitle'
import { selectVodPage } from './page-snapshot'

declare global {
  interface Window {
    __INITIAL_STATE__?: unknown
    __playinfo__?: unknown
    __MOMENTQ_PAGE_BRIDGE_V1__?: boolean
  }
}

let resolvedVodIdentity: { bvid: string; cid: string } | undefined;
let lastBridgeUrl = '';

// MAIN-world scripts share Bilibili's global scope. The IIFE below plus the
// IIFE library build keep every binding, including the bundled shared subtitle
// parsers, private so minified names cannot collide with page globals.
(() => {

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    const currentRecord = record(current)
    if (!currentRecord) return undefined
    current = currentRecord[key]
  }
  return current
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstId(...values: unknown[]): string | number | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed)) return parsed
    }
  }
  return undefined
}

function compact<T extends UnknownRecord>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}

function metaContent(selector: string): string | undefined {
  return firstString(document.querySelector<HTMLMetaElement>(selector)?.content)
}

function canonicalUrl(): string | undefined {
  return firstString(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href)
}

function isoDateTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString()
  }
  if (typeof value === 'string') {
    if (/^[1-9]\d*$/.test(value)) return new Date(Number(value) * 1000).toISOString()
    const epoch = Date.parse(value)
    if (Number.isFinite(epoch)) return new Date(epoch).toISOString()
  }
  return undefined
}

function vodSnapshot(initial: unknown, playInfo: unknown): BilibiliPageSnapshot {
  const videoData = at(initial, 'videoData')
  const pagesValue = at(videoData, 'pages')
  const pages = Array.isArray(pagesValue) ? pagesValue : []
  const requestedPage = firstPositiveInteger(new URL(location.href).searchParams.get('p'))
  const playerCid = firstId(at(playInfo, 'data', 'cid'), at(videoData, 'cid'), at(initial, 'cid'))
  const aid = firstId(at(playInfo, 'data', 'aid'), at(videoData, 'aid'), at(initial, 'aid'))
  const selectedPage = selectVodPage(pages, requestedPage, playerCid)
  const owner = at(videoData, 'owner')
  const creatorName = firstString(at(owner, 'name'), at(initial, 'upData', 'name'), metaContent('meta[name="author"]'))
  const creatorId = firstId(at(owner, 'mid'), at(initial, 'upData', 'mid'))

  return compact({
    url: location.href,
    canonicalUrl: canonicalUrl(),
    title: firstString(at(videoData, 'title'), at(initial, 'h1Title'), metaContent('meta[property="og:title"]'), document.title),
    creator: creatorName ? compact({ id: creatorId, name: creatorName }) : undefined,
    vod: compact({
      bvid: firstString(at(initial, 'bvid'), at(videoData, 'bvid')),
      aid,
      cid: selectedPage.cid,
      pageNumber: selectedPage.pageNumber,
      pageCount: pages.length > 0 ? pages.length : firstPositiveInteger(at(videoData, 'videos')),
      partTitle: selectedPage.partTitle,
    }),
  }) as BilibiliPageSnapshot
}

function liveSnapshot(initial: unknown): BilibiliPageSnapshot {
  const roomData = at(initial, 'roomInfoRes', 'data')
  const roomInfo = at(roomData, 'room_info')
  const roomInit = at(initial, 'roomInitRes', 'data')
  const anchorBase = at(roomData, 'anchor_info', 'base_info')
  const creatorName = firstString(at(anchorBase, 'uname'), metaContent('meta[name="author"]'))
  const creatorId = firstId(at(anchorBase, 'uid'))
  const pathRoomId = /^\/([1-9]\d*)/.exec(location.pathname)?.[1]

  return compact({
    url: location.href,
    canonicalUrl: canonicalUrl(),
    title: firstString(at(roomInfo, 'title'), metaContent('meta[property="og:title"]'), document.title),
    creator: creatorName ? compact({ id: creatorId, name: creatorName }) : undefined,
    live: compact({
      roomId: pathRoomId,
      canonicalRoomId: firstId(at(roomInfo, 'room_id'), at(roomInit, 'room_id')),
      liveStartTime: isoDateTime(at(roomInfo, 'live_start_time')),
    }),
  }) as BilibiliPageSnapshot
}

function readSnapshot(): BilibiliPageSnapshot {
  if (lastBridgeUrl === '') lastBridgeUrl = window.location.href
  if (window.location.href !== lastBridgeUrl) {
    lastBridgeUrl = window.location.href
    resolvedVodIdentity = undefined
  }
  const pathBvid = /^\/video\/([^/?]+)/.exec(location.pathname)?.[1]
  if (pathBvid !== undefined && resolvedVodIdentity !== undefined && resolvedVodIdentity.bvid !== pathBvid) {
    resolvedVodIdentity = undefined
  }
  const snapshot = location.hostname === 'live.bilibili.com'
    ? liveSnapshot(window.__INITIAL_STATE__)
    : vodSnapshot(window.__INITIAL_STATE__, window.__playinfo__)
  if (snapshot.vod !== undefined && resolvedVodIdentity !== undefined) {
    snapshot.vod = { ...snapshot.vod, ...resolvedVodIdentity }
  }
  return snapshot
}

let subtitleRequestKey = ''
let subtitleInflightKey = ''
let subtitleRequest: AbortController | undefined
let pageFetch: typeof window.fetch = window.fetch.bind(window)
let subtitlePositionTimer: number | undefined
let subtitleAutoRequestKey = ''
let subtitleFetchHookInstalled = false

function postSubtitleTracks(snapshot: BilibiliPageSnapshot, tracks: string[], status: 'available' | 'absent' = 'available'): void {
  const bvid = snapshot.vod?.bvid
  const cid = snapshot.vod?.cid
  if (bvid === undefined || cid === undefined
    || (status === 'available' && tracks.length === 0)
    || (status === 'absent' && tracks.length !== 0)) return
  const envelope: PageSubtitleTracksMessageEnvelope = {
    source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE_TRACKS',
    payload: { bvid, cid: String(cid), status, tracks },
  }
  window.postMessage(envelope, location.origin)
  // One explicit request per resolved content identity is sufficient. The
  // previous code left this key unset and every DOM mutation fetched and
  // re-imported the list again, racing different player/preload responses.
  subtitleRequestKey = `${bvid}:${String(cid)}`
}

async function publishSubtitle(snapshot: BilibiliPageSnapshot): Promise<void> {
  const bvid = snapshot.vod?.bvid
  const cid = snapshot.vod?.cid
  if (bvid === undefined || cid === undefined) return
  const key = `${bvid}:${String(cid)}`
  if (key === subtitleRequestKey || key === subtitleInflightKey) return
  subtitleInflightKey = key
  subtitleRequest?.abort()
  const controller = new AbortController()
  subtitleRequest = controller
  try {
    // The WBI endpoint is what current Bilibili pages use for AI/native
    // subtitles. Keep the legacy endpoint as a compatibility fallback.
    let definitiveEmpty = false
    for (const endpoint of ['x/player/wbi/v2', 'x/player/v2']) {
      const indexResponse = await pageFetch(
        `https://api.bilibili.com/${endpoint}?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`,
        { credentials: 'include', signal: controller.signal },
      )
      if (!indexResponse.ok) continue
      const index = parseSubtitleIndex(await indexResponse.json())
      // The response body, not the request URL or current DOM, owns its
      // identity. Bilibili can resolve a navigation/preload request late.
      if (index === null || index.bvid !== bvid || index.cid !== String(cid)) continue
      if (index.tracks.length > 0) {
        postSubtitleTracks(snapshot, index.tracks)
        return
      }
      definitiveEmpty ||= index.definitiveEmpty
    }

    // New AI subtitles expose a URL-less `ai-zh` entry in videoData.subtitle.
    // The player resolves that entry through the protobuf subtitle-web API.
    const aid = snapshot.vod?.aid
    if (aid !== undefined) {
      const subtitleViewUrl = `https://api.bilibili.com/x/v2/subtitle/web/view?oid=${encodeURIComponent(String(cid))}&pid=${encodeURIComponent(String(aid))}&context_ext=${encodeURIComponent('{"video_type":1}')}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`
      const subtitleViewResponse = await pageFetch(subtitleViewUrl, { credentials: 'include', signal: controller.signal })
      if (subtitleViewResponse.ok) {
        const tracks = subtitleUrlsFromWebResponse(await subtitleViewResponse.arrayBuffer())
        if (tracks.length > 0) {
          const current = readSnapshot()
          if (current.vod?.bvid === bvid && String(current.vod.cid) === String(cid)) postSubtitleTracks(current, tracks)
          return
        }
      }
    }
    if (definitiveEmpty) postSubtitleTracks(snapshot, [], 'absent')
  } catch {
    // Navigation aborts and missing subtitle tracks are expected.
  } finally {
    if (subtitleRequest === controller) subtitleRequest = undefined
    if (subtitleInflightKey === key) subtitleInflightKey = ''
  }
}

function installSubtitleNetworkTap(): void {
  if (subtitleFetchHookInstalled) return
  const originalFetch = window.fetch.bind(window)
  pageFetch = originalFetch
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const promise = originalFetch(input, init)
    promise.then(response => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!/subtitle|subtitles|player\/(?:v2|wbi\/v2)/i.test(raw)) return
      void response.clone().json().then(payload => {
        const snapshot = readSnapshot()
        const payloadBvid = firstString(at(payload, 'data', 'bvid'))
        const payloadCid = firstId(at(payload, 'data', 'cid'))
        if ((payloadBvid !== undefined && payloadBvid !== snapshot.vod?.bvid)
          || (payloadCid !== undefined && String(payloadCid) !== String(snapshot.vod?.cid))) return
        const tracks = subtitleTracks(payload)
        if (tracks.length > 0) postSubtitleTracks(snapshot, tracks)
      }).catch(() => {})
    }).catch(() => {})
    return promise
  }
  subtitleFetchHookInstalled = true
}

function requestBilibiliSubtitleLoad(snapshot: BilibiliPageSnapshot): void {
  const bvid = snapshot.vod?.bvid
  const cid = snapshot.vod?.cid
  if (bvid === undefined || cid === undefined) return
  const key = `${bvid}:${String(cid)}`
  // One forced load per identity: skip when a click attempt already ran or a
  // track result (available or definitive absence) has been posted.
  if (subtitleAutoRequestKey === key || subtitleRequestKey === key) return
  const itemSelector = '.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]'
  const clickVisibleItem = (attempt: number): void => {
    const item = [...document.querySelectorAll<HTMLElement>(itemSelector)].find(node => {
      const style = window.getComputedStyle(node)
      const box = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
    })
    if (item !== undefined) {
      item.click()
      return
    }
    if (attempt < 10) window.setTimeout(() => clickVisibleItem(attempt + 1), 150)
  }
  const button = document.querySelector<HTMLElement>('.bpx-player-ctrl-subtitle')
  if (button === null) return
  subtitleAutoRequestKey = key
  const item = [...document.querySelectorAll<HTMLElement>(itemSelector)].find(node => {
    const style = window.getComputedStyle(node)
    const box = node.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
  })
  if (item !== undefined) {
    item.click()
    return
  }
  button.click()
  clickVisibleItem(0)
}

function installSubtitlePositionPublisher(): void {
  if (subtitlePositionTimer !== undefined || location.hostname === 'live.bilibili.com') return
  subtitlePositionTimer = window.setInterval(() => {
    const snapshot = readSnapshot()
    const bvid = snapshot.vod?.bvid
    const cid = snapshot.vod?.cid
    const video = document.querySelector('video')
    if (bvid === undefined || cid === undefined || video === null || !Number.isFinite(video.currentTime)) return
    window.postMessage({
      source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE_POSITION',
      payload: { bvid, cid: String(cid), currentTime: Math.max(0, video.currentTime) },
    }, location.origin)
  }, 250)
}

function installBridge(): void {
  if (window.__MOMENTQ_PAGE_BRIDGE_V1__) return
  window.__MOMENTQ_PAGE_BRIDGE_V1__ = true
  // Do not tap every player request: Bilibili preloads adjacent playlist
  // entries and those responses are not the currently playing CID. Only the
  // explicit request below for the resolved current identity is accepted.
  // The side panel reads HTMLVideoElement.currentTime directly. Publishing
  // the clock through the page bridge creates a stale-CID race on playlist
  // navigation, so it is intentionally not installed here.

  let debounceTimer: number | undefined
  let maxWaitTimer: number | undefined
  const publish = () => {
    const snapshot = readSnapshot()
    const envelope: PageMessageEnvelope = {
      source: 'momentq-page',
      version: 1,
      type: 'PAGE_SNAPSHOT',
      payload: snapshot,
    }
    window.postMessage(envelope, location.origin)
    void publishSubtitle(snapshot)
  }
  const flush = () => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    if (maxWaitTimer !== undefined) window.clearTimeout(maxWaitTimer)
    debounceTimer = undefined
    maxWaitTimer = undefined
    publish()
  }
  const schedule = () => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(flush, 200)
    maxWaitTimer ??= window.setTimeout(flush, 1_000)
  }

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method]
    history[method] = function (...args: Parameters<History['pushState']>): void {
      original.apply(this, args)
      schedule()
    }
  }
  window.addEventListener('popstate', schedule)
  window.addEventListener('hashchange', schedule)
  installSubtitleNetworkTap()
  // Keep the clock publisher enabled so the side panel can align the ticker
  // even when the player was initialized after document_start.
  installSubtitlePositionPublisher()
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const value = event.data
    if (event.source !== window || event.origin !== location.origin
      || typeof value !== 'object' || value === null) return
    const payload = (value as { source?: unknown; type?: unknown; payload?: unknown }).payload
    if ((value as { source?: unknown }).source !== 'momentq-content'
      || (value as { type?: unknown }).type !== 'MOMENTQ_RESOLVED_VOD'
      || typeof payload !== 'object' || payload === null) return
    const ids = payload as { bvid?: unknown; cid?: unknown }
    if (typeof ids.bvid !== 'string' || typeof ids.cid !== 'string') return
    resolvedVodIdentity = { bvid: ids.bvid, cid: ids.cid }
    const snapshot = readSnapshot()
    const resolved: BilibiliPageSnapshot = {
      ...snapshot,
      vod: { ...(snapshot.vod ?? {}), bvid: ids.bvid, cid: ids.cid },
    }
    void publishSubtitle(resolved)
  })
  new MutationObserver(schedule).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['content', 'href'],
  })
  // Bilibili assigns __INITIAL_STATE__ after document_start without a DOM
  // mutation. Retry briefly until aid/cid are available, then request the
  // player's subtitle resource once for this content identity.
  window.setInterval(() => {
    installSubtitleNetworkTap()
    const snapshot = readSnapshot()
    if (snapshot.vod?.bvid !== undefined && snapshot.vod.cid !== undefined) {
      void publishSubtitle(snapshot)
      requestBilibiliSubtitleLoad(snapshot)
    }
  }, 750)
  publish()
}

installBridge()
})()
