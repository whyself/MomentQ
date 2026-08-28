import type { BilibiliPageSnapshot, PageMessageEnvelope, PageSubtitleMessageEnvelope, PageSubtitleTracksMessageEnvelope } from '../shared/protocol'
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

// MAIN-world scripts share Bilibili's global scope. Keep every runtime
// binding private so minified names cannot collide with page globals.
(() => {

type UnknownRecord = Record<string, unknown>

function subtitleRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : null
}

function subtitleText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function subtitleUrl(value: unknown): string | undefined {
  const raw = subtitleText(value)
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    return url.protocol === 'https:' && (url.hostname === 'subtitle.bilibili.com' || url.hostname === 'aisubtitle.hdslb.com' || url.hostname === 'aisubtitle.biliapi.com' || url.hostname.endsWith('.hdslb.com')) ? url.toString() : undefined
  } catch { return undefined }
}

function subtitleUrlsFromWebResponse(value: ArrayBuffer): string[] {
  const bytes = new Uint8Array(value)
  const urls = new Set<string>()
  const decoder = new TextDecoder()
  const readVarint = (offset: number): { value: number; next: number } | null => {
    let result = 0
    let shift = 0
    let cursor = offset
    while (cursor < bytes.length && shift < 70) {
      const byte = bytes[cursor++] ?? 0
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return { value: result, next: cursor }
      shift += 7
    }
    return null
  }
  const scan = (start: number, end: number, depth: number): void => {
    if (depth > 5) return
    let offset = start
    while (offset < end) {
      const key = readVarint(offset)
      if (key === null) return
      offset = key.next
      const wire = key.value & 7
      if (wire === 0) {
        const scalar = readVarint(offset)
        if (scalar === null) return
        offset = scalar.next
      } else if (wire === 1) offset += 8
      else if (wire === 2) {
        const length = readVarint(offset)
        if (length === null) return
        offset = length.next
        const childEnd = Math.min(end, offset + length.value)
        const normalized = subtitleUrl(decoder.decode(bytes.subarray(offset, childEnd)))
        if (normalized !== undefined) urls.add(normalized)
        scan(offset, childEnd, depth + 1)
        offset = childEnd
      } else if (wire === 5) offset += 4
      else return
    }
  }
  scan(0, bytes.length, 0)
  return [...urls]
}

function subtitleTracks(value: unknown): string[] {
  const root = subtitleRecord(value)
  const data = subtitleRecord(root?.data)
  const videoData = subtitleRecord(root?.videoData)
  const candidates: unknown[] = [
    subtitleRecord(data?.subtitle)?.subtitles,
    subtitleRecord(data?.subtitle)?.list,
    subtitleRecord(data?.subtitle)?.body,
    subtitleRecord(root?.subtitle)?.subtitles,
    subtitleRecord(root?.subtitle)?.list,
    subtitleRecord(root?.subtitle)?.body,
    subtitleRecord(videoData?.subtitle)?.subtitles,
    subtitleRecord(videoData?.subtitle)?.list,
    subtitleRecord(videoData?.subtitle)?.body,
  ]
  return candidates.flatMap(candidate => Array.isArray(candidate) ? candidate : [])
    .map(subtitleRecord)
    .filter((item): item is UnknownRecord => item !== null)
    .sort((left, right) => {
      const score = (item: UnknownRecord): number => {
        const lan = (subtitleText(item.lan) ?? '').toLowerCase()
        const language = `${lan} ${subtitleText(item.lan_doc) ?? ''}`.toLowerCase()
        return (/((^|[-_])zh($|[-_]))|中文|中英|简体|繁体/.test(language) ? 1_000 : 0)
          + (/^(zh-cn|zh-hans|zh-sg|zh-tw|zh-hant)$/.test(lan) ? 400 : 0)
          + (lan === 'ai-zh' ? 300 : 0)
          + (item.ai_type === 0 ? 200 : 0)
      }
      const difference = score(right) - score(left)
      if (difference !== 0) return difference
      return (subtitleText(left.subtitle_url) ?? '').localeCompare(subtitleText(right.subtitle_url) ?? '')
    })
    .map(track => {
      const raw = subtitleText(track.subtitle_url)
      if (raw === undefined) return undefined
      try {
        const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
        return url.protocol === 'https:' && (url.hostname === 'subtitle.bilibili.com' || url.hostname === 'aisubtitle.hdslb.com' || url.hostname === 'aisubtitle.biliapi.com' || url.hostname.endsWith('.hdslb.com')) ? url.toString() : undefined
      } catch { return undefined }
    })
    .filter((url): url is string => url !== undefined)
}

function parseSubtitleIndex(value: unknown): {
  bvid: string
  cid: string
  tracks: string[]
  definitiveEmpty: boolean
} | null {
  const root = subtitleRecord(value)
  const data = subtitleRecord(root?.data)
  if (root?.code !== 0 || data === null) return null
  const bvid = subtitleText(data.bvid)
  const rawCid = data.cid
  const cid = typeof rawCid === 'number' && Number.isFinite(rawCid)
    ? String(rawCid)
    : subtitleText(rawCid)
  if (bvid === undefined || cid === undefined) return null
  const tracks = subtitleTracks(value)
  return {
    bvid,
    cid,
    tracks,
    definitiveEmpty: tracks.length === 0 && data.need_login_subtitle !== true,
  }
}

function normalizeSubtitleBody(value: unknown): { start: number; end: number; text: string }[] {
  const root = subtitleRecord(value)
  const data = subtitleRecord(root?.data)
  const body = Array.isArray(root?.body) ? root.body
    : Array.isArray(data?.body) ? data.body
    : Array.isArray(value) ? value : []
  const segments: { start: number; end: number; text: string }[] = []
  for (const item of body) {
    const row = subtitleRecord(item)
    if (row === null) continue
    const start = typeof row.from === 'number' ? row.from : Number(row.from ?? row.start)
    const end = typeof row.to === 'number' ? row.to : Number(row.to ?? row.end)
    const text = subtitleText(row.content ?? row.text)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || text === undefined) continue
    segments.push({ start, end, text })
  }
  return segments
}

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
let subtitleSamplerTimer: number | undefined
let subtitlePositionTimer: number | undefined
let subtitleAvailable = false
let subtitleAutoRequestKey = ''
let subtitleFetchHookInstalled = false
let subtitleXhrSendHook: typeof XMLHttpRequest.prototype.send | undefined

function postSubtitle(snapshot: BilibiliPageSnapshot, segments: ReturnType<typeof normalizeSubtitleBody>, complete = true): void {
  const bvid = snapshot.vod?.bvid
  const cid = snapshot.vod?.cid
  if (bvid === undefined || cid === undefined || segments.length === 0) return
  subtitleAvailable = true
  const envelope: PageSubtitleMessageEnvelope = {
    source: 'momentq-page', version: 1, type: 'PAGE_SUBTITLE',
    payload: { bvid, cid: String(cid), segments },
  }
  window.postMessage(envelope, location.origin)
  // A DOM-sampled line is only a fallback and must not suppress the later
  // request for the complete AI/native subtitle track.
  if (complete) subtitleRequestKey = `${bvid}:${String(cid)}`
}

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
  if (!subtitleFetchHookInstalled) {
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
          const segments = normalizeSubtitleBody(payload)
          if (segments.length > 0) postSubtitle(snapshot, segments)
          else {
            const tracks = subtitleTracks(payload)
            if (tracks.length > 0) postSubtitleTracks(snapshot, tracks)
          }
        }).catch(() => {})
      }).catch(() => {})
      return promise
    }
    subtitleFetchHookInstalled = true
  }

  // The Bilibili player uses XMLHttpRequest for the actual AI subtitle JSON
  // (aisubtitle.hdslb.com). Observe those responses as well as fetch; without
  // this hook the URL is visible in DevTools but never reaches MomentQ.
  if (subtitleXhrSendHook !== XMLHttpRequest.prototype.send) {
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]): void {
      ;(this as XMLHttpRequest & { __momentqSubtitleUrl?: string }).__momentqSubtitleUrl = String(url)
      originalOpen.apply(this, [method, url, ...rest] as any)
    }
    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
      const request = this as XMLHttpRequest & { __momentqSubtitleUrl?: string; __momentqSubtitleKey?: string }
      const raw = request.__momentqSubtitleUrl
      if (raw !== undefined && subtitleUrl(raw) !== undefined) {
        const snapshot = readSnapshot()
        const bvid = snapshot.vod?.bvid
        const cid = snapshot.vod?.cid
        if (bvid !== undefined && cid !== undefined) request.__momentqSubtitleKey = `${bvid}:${String(cid)}`
        request.addEventListener('load', () => {
          const current = readSnapshot()
          if (request.__momentqSubtitleKey === undefined
            || request.__momentqSubtitleKey !== `${current.vod?.bvid}:${String(current.vod?.cid)}`
            || request.status < 200 || request.status >= 300) return
          try {
            const rawBody = request.responseType === '' || request.responseType === 'text'
              ? request.responseText
              : request.response
            const segments = normalizeSubtitleBody(typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody)
            if (segments.length > 0) postSubtitle(current, segments)
          } catch {
            // Ignore non-JSON player resources.
          }
        }, { once: true })
      }
      originalSend.call(this, body)
    }
    subtitleXhrSendHook = XMLHttpRequest.prototype.send
  }
}

function requestBilibiliSubtitleLoad(snapshot: BilibiliPageSnapshot): void {
  const bvid = snapshot.vod?.bvid
  const cid = snapshot.vod?.cid
  if (bvid === undefined || cid === undefined || subtitleAutoRequestKey === `${bvid}:${String(cid)}`) return
  const itemSelector = '.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]'
  const key = `${bvid}:${String(cid)}`
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

/**
 * New Bilibili AI subtitles are rendered by the player without exposing a
 * public subtitle URL. Sample the player's rendered line together with the
 * media clock so those captions can still become a timed transcript.
 */
function installSubtitleDomSampler(): void {
  if (subtitleSamplerTimer !== undefined || location.hostname === 'live.bilibili.com') return
  let key = ''
  let currentText = ''
  let currentStart = 0
  let segments: { start: number; end: number; text: string }[] = []
  let lastPosted = 0
  const tick = () => {
    const snapshot = readSnapshot()
    const bvid = snapshot.vod?.bvid
    const cid = snapshot.vod?.cid
    const video = document.querySelector('video')
    const panel = document.querySelector<HTMLElement>('.bpx-player-subtitle-wrap, .bpx-player-subtitle-panel, [class*="player-subtitle-wrap"]')
    if (bvid === undefined || cid === undefined || video === null || panel === null || !Number.isFinite(video.currentTime)) return
    const panelStyle = window.getComputedStyle(panel)
    const panelBox = panel.getBoundingClientRect()
    // Hidden menu nodes can retain stale text while captions are disabled.
    if (panelStyle.display === 'none' || panelStyle.visibility === 'hidden'
      || panelStyle.opacity === '0' || panelBox.width === 0 || panelBox.height === 0) {
      currentText = ''
      return
    }
    const nextKey = `${bvid}:${String(cid)}`
    if (nextKey !== key) {
      key = nextKey
      currentText = ''
      currentStart = video.currentTime
      segments = []
      lastPosted = 0
      subtitleAvailable = false
    }
    // Only accept a currently rendered caption node. Reading panel.textContent
    // also captures hidden menu labels/stale lines when subtitles are off.
    const caption = [...panel.querySelectorAll<HTMLElement>('[role="caption"]')]
      .find(node => {
        const style = window.getComputedStyle(node)
        const box = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && box.width > 0 && box.height > 0
      })
    if (caption === undefined) {
      currentText = ''
      return
    }
    const text = (caption.textContent ?? '').replace(/\s+/g, ' ').trim()
    const now = Math.max(0, video.currentTime)
    if (text === currentText) return
    if (currentText !== '' && now >= currentStart) segments.push({ start: currentStart, end: now, text: currentText })
    currentText = text
    currentStart = now
    if (segments.length > lastPosted) {
      lastPosted = segments.length
      postSubtitle(snapshot, segments.slice(), false)
    }
  }
  subtitleSamplerTimer = window.setInterval(tick, 250)
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
      if (subtitleAvailable === false) requestBilibiliSubtitleLoad(snapshot)
    }
  }, 750)
  publish()
}

installBridge()
})()
