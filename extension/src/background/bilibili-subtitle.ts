import type { TranscriptSegment } from '../shared/host-client'
import { normalizeSubtitleBody, parseSubtitleIndex, subtitleTracks } from '../shared/bilibili-subtitle'

export type BilibiliSubtitleReport = {
  segments: TranscriptSegment[] | null
  /**
   * True only when a validated index response exposed no tracks and did not
   * ask for login; only then may callers treat absence as authoritative.
   */
  definitiveEmpty: boolean
  /** What the validated index actually exposed, for panel diagnostics. */
  diagnostic: string | null
}

/** Fetch the best available Bilibili subtitle track for one VOD page. */
export async function fetchBilibiliSubtitle(
  bvid: string,
  cid: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<BilibiliSubtitleReport> {
  try {
    // Current Bilibili players expose AI/native tracks through WBI first. The
    // legacy endpoint remains a compatibility fallback for older pages.
    const indexUrls = [
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
    ]
    let definitiveEmpty = false
    let diagnostic: string | null = null
    for (const indexUrl of indexUrls) {
      // A stalled connection would park the whole pipeline forever; bound it.
      const indexResponse = await request(indexUrl, { credentials: 'include', signal: AbortSignal.timeout(10_000) })
      if (!indexResponse.ok) {
        diagnostic = `索引 HTTP ${indexResponse.status}`
        continue
      }
      const payload = await indexResponse.json()
      const index = parseSubtitleIndex(payload)
      // Identity is mandatory. A stale/cached player response must never be
      // relabelled as the requested video merely because its URL was current.
      if (index === null || index.bvid !== bvid || index.cid !== cid) continue
      // The extension's query is unsigned; its AI tracks can be poisoned
      // server-side (translations attached to the wrong video). Only
      // official tracks are trusted from this channel — AI tracks arrive
      // through the player's own signed responses via the page tap.
      const officialTracks = subtitleTracks(payload, true)
      diagnostic = officialTracks.length > 0
        ? `官方轨 ${officialTracks.length} 条`
        : index.tracks.length > 0
          ? `仅 AI 轨 ${index.tracks.length} 条（未签名通道不导入，等待播放器确认）`
          : index.needLogin ? '无轨道（B 站提示字幕需登录生成）' : '无轨道'
      for (const url of officialTracks) {
        const response = await request(url, { credentials: 'include', signal: AbortSignal.timeout(10_000) })
        if (!response.ok) continue
        const segments = normalizeSubtitleBody(await response.json())
        if (segments.length > 0) return { segments, definitiveEmpty: false, diagnostic: `${diagnostic}，已取到 ${segments.length} 行` }
      }
      definitiveEmpty ||= index.definitiveEmpty
    }
    return { segments: null, definitiveEmpty, diagnostic }
  } catch (error) {
    return { segments: null, definitiveEmpty: false, diagnostic: `获取异常: ${error instanceof Error ? error.message : 'unknown'}` }
  }
}

/** Read a subtitle JSON URL discovered in the page world. */
export async function fetchSubtitleTrackUrl(
  url: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<TranscriptSegment[] | null> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'subtitle.bilibili.com' || parsed.hostname.endsWith('.hdslb.com'))) return null
    const response = await request(parsed.toString(), { credentials: 'include' })
    if (!response.ok) return null
    const segments = normalizeSubtitleBody(await response.json())
    return segments.length > 0 ? segments : null
  } catch {
    return null
  }
}
