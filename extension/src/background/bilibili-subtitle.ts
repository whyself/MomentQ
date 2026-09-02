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
    // Only the WBI endpoint is queried. The legacy player endpoint is where
    // logged-in responses for trackless videos carried Bilibili's rotating
    // foreign tracks (measured 2026-08-29: every poisoned response came from
    // it, WBI stayed clean across both probe rounds), so it is never trusted
    // for track discovery on any channel.
    let definitiveEmpty = false
    let diagnostic: string | null = null
    // A stalled connection would park the whole pipeline forever; bound it.
    const indexResponse = await request(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
      { credentials: 'include', signal: AbortSignal.timeout(10_000) },
    )
    if (indexResponse.ok) {
      const payload = await indexResponse.json()
      const index = parseSubtitleIndex(payload)
      // Identity is mandatory. A stale/cached player response must never be
      // relabelled as the requested video merely because its URL was current.
      if (index !== null && index.bvid === bvid && index.cid === cid) {
        // Track trust policy, revised after the field report this comment's
        // history describes: this query IS credentialed (cookies included),
        // i.e. materially the same request the player itself makes — so its
        // AI tracks are imported too, behind the defenses that actually
        // matter: identity echo above, proven-trackless veto in the caller,
        // and the per-video duration gate applied to every import. The
        // player-tap remains as a redundant second channel. (The original
        // poison incident came from the LEGACY player endpoint, which stays
        // excluded here.)
        const trustedTracks = subtitleTracks(payload, false)
        diagnostic = trustedTracks.length > 0
          ? `字幕轨 ${trustedTracks.length} 条`
          : index.needLogin ? '无轨道（B 站提示字幕需登录生成）' : '无轨道'
        for (const url of trustedTracks) {
          const response = await request(url, { credentials: 'include', signal: AbortSignal.timeout(10_000) })
          if (!response.ok) continue
          const segments = normalizeSubtitleBody(await response.json())
          if (segments.length > 0) return { segments, definitiveEmpty: false, diagnostic: `${diagnostic}，已取到 ${segments.length} 行` }
        }
        definitiveEmpty = index.definitiveEmpty
      }
    } else {
      diagnostic = `索引 HTTP ${indexResponse.status}`
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
