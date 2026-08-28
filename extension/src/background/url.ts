const BVID_PATH = /^\/video\/BV[0-9A-Za-z]{10}\/?$/
const LIVE_ROOM_PATH = /^\/[1-9]\d*\/?$/

export function isSupportedBilibiliUrl(input: string): boolean {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'live.bilibili.com') return LIVE_ROOM_PATH.test(url.pathname)
  if (url.hostname !== 'www.bilibili.com' || !BVID_PATH.test(url.pathname)) return false
  const parts = url.searchParams.getAll('p')
  if (parts.length === 0) return true
  const part = parts[0] ?? ''
  return parts.length === 1 && /^[1-9]\d*$/.test(part) && Number.isSafeInteger(Number(part))
}
