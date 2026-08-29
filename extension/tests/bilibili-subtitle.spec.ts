import { describe, expect, it } from 'vitest'
import { fetchBilibiliSubtitle } from '../src/background/bilibili-subtitle'
import { parseSubtitleIndex, subtitleTracks, trackNeedsChineseTranslation, transcriptExceedsHost } from '../src/shared/bilibili-subtitle'

describe('timeline sanity gate', () => {
  const cue = (end: number) => ({ start: 0, end, text: 'x' })

  it('rejects tracks that run past the host duration', () => {
    // Measured poison cases: 475.8s track on a 328s host, 289.2s on 61s.
    expect(transcriptExceedsHost([cue(475.8)], 328)).toBe(true)
    expect(transcriptExceedsHost([cue(289.2)], 61)).toBe(true)
  })

  it('accepts healthy tracks within tolerance', () => {
    // Healthy corpus maximum ratio is exactly 1.0 (430.8s on a 431s host).
    expect(transcriptExceedsHost([cue(430.8)], 431)).toBe(false)
    expect(transcriptExceedsHost([cue(1521.7)], 1522)).toBe(false)
  })

  it('skips the gate when the duration is unknown', () => {
    expect(transcriptExceedsHost([cue(9_999)], undefined)).toBe(false)
    expect(transcriptExceedsHost([cue(9_999)], 0)).toBe(false)
  })
})

const segment = (text: string) => ({ start: 0, end: 1, text })

describe('subtitle language gating', () => {
  it('treats Chinese tracks as final', () => {
    expect(trackNeedsChineseTranslation([
      segment('大多数人可能会本能地想到这个闪避其实很好躲'),
      segment('下意识认为这个闪避躲不掉，其实只要预判就行'),
    ])).toBe(false)
  })

  it('keeps English and Japanese tracks waiting for the ai-zh translation', () => {
    expect(trackNeedsChineseTranslation([
      segment('Most folks might instinctively think this dodge is easy to read'),
      segment('but it actually punishes anyone who panics'),
    ])).toBe(true)
    expect(trackNeedsChineseTranslation([
      segment('「無敵じゃん」とか言うけど、この回避は実は割りやすいんだよな'),
      segment('一個使うとエネルギーが三分の二減るし'),
    ])).toBe(true)
  })

  it('leaves near-empty tracks alone', () => {
    expect(trackNeedsChineseTranslation([segment('Hi.')])).toBe(false)
    expect(trackNeedsChineseTranslation([])).toBe(false)
  })
})

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
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toEqual({
      segments: [
        { start: 0, end: 1.5, text: '第一行' },
        { start: 1.5, end: 2.5, text: '第二行' },
      ],
      definitiveEmpty: false,
      diagnostic: '官方轨 2 条，已取到 2 行',
    })
    expect(calls).toEqual([
      'https://api.bilibili.com/x/player/wbi/v2?bvid=BV1xx&cid=42',
      'https://aisubtitle.hdslb.com/zh.json',
    ])
    expect(init).toMatchObject([
      { credentials: 'include' },
      { credentials: 'include' },
    ])
  })

  it('reports a validated empty index as definitive absence', async () => {
    const request: typeof fetch = async () => new Response(JSON.stringify({
      code: 0,
      data: { bvid: 'BV1xx', cid: 42, need_login_subtitle: false, subtitle: { subtitles: [] } },
    }), { status: 200 })
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toEqual({
      segments: null,
      definitiveEmpty: true,
      diagnostic: '无轨道',
    })
  })

  it('never imports AI-only tracks through the unsigned channel', async () => {
    const request: typeof fetch = async (input) => {
      if (String(input).includes('/x/player/wbi/v2')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            bvid: 'BV1xx', cid: 42,
            subtitle: { subtitles: [
              // Poisoned server-side AI track from an unrelated video.
              { lan: 'ai-zh', lan_doc: '中文（自动翻译）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/poison.json' },
            ] },
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ body: [{ from: 0, to: 1, content: '别的视频' }] }), { status: 200 })
    }
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toEqual({
      segments: null,
      definitiveEmpty: false,
      diagnostic: '仅 AI 轨（未签名通道不导入）: ai-zh(中文（自动翻译）)',
    })
  })

  it('fails closed for non-Bilibili subtitle URLs and missing tracks', async () => {
    const request: typeof fetch = async () => new Response(JSON.stringify({
      code: 0, data: { bvid: 'BV1xx', cid: 42, subtitle: { subtitles: [{ subtitle_url: 'https://evil.example/sub.json' }] } },
    }), { status: 200 })
    // The identity validates, but the only track URL fails the host
    // allowlist, so the video counts as having no usable track.
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toEqual({
      segments: null,
      definitiveEmpty: true,
      diagnostic: '无轨道',
    })
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
    await expect(fetchBilibiliSubtitle('BV1xx', '42', request)).resolves.toEqual({
      segments: null,
      definitiveEmpty: false,
      diagnostic: null,
    })
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

  it('ranks Chinese above English above Japanese regardless of official status', () => {
    const jaOfficial = { lan: 'ja', lan_doc: '日语', ai_type: 0, subtitle_url: '//aisubtitle.hdslb.com/ja.json' }
    const enAi = { lan: 'en', lan_doc: '英语（自动生成）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/en.json' }
    const zhAi = { lan: 'ai-zh', lan_doc: '中文（自动翻译）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/zh.json' }
    const jaAi = { lan: 'ai-ja', lan_doc: '日语（自动生成）', ai_type: 1, subtitle_url: '//aisubtitle.hdslb.com/ai-ja.json' }
    const payload = (tracks: unknown[]) => ({ data: { subtitle: { subtitles: tracks } } })
    const expected = [
      'https://aisubtitle.hdslb.com/zh.json',
      'https://aisubtitle.hdslb.com/en.json',
      'https://aisubtitle.hdslb.com/ja.json',
      'https://aisubtitle.hdslb.com/ai-ja.json',
    ]

    expect(subtitleTracks(payload([jaOfficial, enAi, zhAi, jaAi]))).toEqual(expected)
    expect(subtitleTracks(payload([jaAi, zhAi, enAi, jaOfficial]))).toEqual(expected)
  })
})
