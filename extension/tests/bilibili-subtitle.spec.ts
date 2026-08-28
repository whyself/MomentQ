import { describe, expect, it } from 'vitest'
import { fetchBilibiliSubtitle } from '../src/background/bilibili-subtitle'
import { parseSubtitleIndex, subtitleTracks, subtitleUrlsFromBinary } from '../src/shared/bilibili-subtitle'

describe('Bilibili subtitle acquisition', () => {
  it('selects the Chinese track and normalizes subtitle JSON', async () => {
    const calls: string[] = []
    const init: RequestInit[] = []
    const request: typeof fetch = async (input, options) => {
      const url = String(input)
      calls.push(url)
      init.push(options ?? {})
      if (url.includes('/x/player/wbi/v2')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { bvid: 'BV1xx', cid: 42, subtitle: { subtitles: [
            { lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/en.json' },
            { lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//aisubtitle.hdslb.com/zh.json' },
          ] } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ body: [
        { from: 0, to: 1.5, content: ' 第一行 ' },
        { from: '1.5', to: '2.5', content: '第二行' },
        { from: -1, to: 2, content: '忽略' },
      ] }), { status: 200 })
    }
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toEqual([
      { start: 0, end: 1.5, text: '第一行' },
      { start: 1.5, end: 2.5, text: '第二行' },
    ])
    expect(calls).toEqual([
      'https://api.bilibili.com/x/player/wbi/v2?bvid=BV1xx&cid=42',
      'https://aisubtitle.hdslb.com/zh.json',
    ])
    expect(init).toEqual([
      { credentials: 'include' },
      { credentials: 'include' },
    ])
  })

  it('fails closed for non-Bilibili subtitle URLs and missing tracks', async () => {
    const request: typeof fetch = async () => new Response(JSON.stringify({
      code: 0, data: { bvid: 'BV1xx', cid: 42, subtitle: { subtitles: [{ subtitle_url: 'https://evil.example/sub.json' }] } },
    }), { status: 200 })
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toBeNull()
  })

  it('rejects a stale response instead of relabelling its track', async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({
        code: 0,
        data: {
          bvid: 'BV1OTHER', cid: 999,
          subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/wrong.json' }] },
        },
      }), { status: 200 })
    }
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toBeNull()
    expect(calls).not.toContain('https://aisubtitle.hdslb.com/wrong.json')
  })

  it('only treats an authenticated exact empty response as definitive absence', () => {
    expect(parseSubtitleIndex({ code: 0, data: {
      bvid: 'BV1xx', cid: 42, need_login_subtitle: false,
      subtitle: { subtitles: [] },
    }})).toMatchObject({ bvid: 'BV1xx', cid: '42', tracks: [], definitiveEmpty: true })
    expect(parseSubtitleIndex({ code: 0, data: {
      bvid: 'BV1xx', cid: 42, need_login_subtitle: true,
      subtitle: { subtitles: [] },
    }})).toMatchObject({ definitiveEmpty: false })
  })

  it('chooses the same preferred Chinese track when the API order changes', () => {
    const native = { lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//aisubtitle.hdslb.com/native.json' }
    const ai = { lan: 'ai-zh', lan_doc: '中文（自动生成）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/ai.json' }
    const english = { lan: 'en', lan_doc: 'English', ai_type: 0, subtitle_url: '//aisubtitle.hdslb.com/en.json' }
    const payload = (tracks: unknown[]) => ({ data: { subtitle: { subtitles: tracks } } })

    expect(subtitleTracks(payload([english, ai, native]))[0]).toBe('https://aisubtitle.hdslb.com/native.json')
    expect(subtitleTracks(payload([native, english, ai]))[0]).toBe('https://aisubtitle.hdslb.com/native.json')
  })

  it('extracts a URL-less AI track from the protobuf subtitle-web response', () => {
    const url = 'https://subtitle.bilibili.com/signed.json?auth_key=1'
    const encoded = new TextEncoder().encode(url)
    const entry = new Uint8Array(2 + encoded.length)
    entry[0] = 0x2a
    entry[1] = encoded.length
    entry.set(encoded, 2)
    const payload = new Uint8Array(2 + entry.length)
    payload[0] = 0x0a
    payload[1] = entry.length
    payload.set(entry, 2)
    expect(subtitleUrlsFromBinary(payload)).toEqual([url])
  })
})
