import { describe, expect, it, vi } from 'vitest'
import type { BilibiliSubtitleSegment } from '../src/shared/protocol'
import { trackNeedsChineseTranslation, translateSubtitleBatch } from '../src/shared/translate'

const segment = (text: string): BilibiliSubtitleSegment => ({ start: 0, end: 1, text })

describe('subtitle translation gating', () => {
  it('skips Chinese tracks', () => {
    expect(trackNeedsChineseTranslation([
      segment('大多数人可能会本能地想到这个闪避其实很好躲'),
      segment('下意识认为这个闪避躲不掉，其实只要预判就行'),
    ])).toBe(false)
  })

  it('translates English and Japanese tracks', () => {
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

describe('subtitle batch translation', () => {
  it('parses the model JSON array and pads missing entries', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '好的，以下是翻译：\n["大多数人", "可能会", 3, null]' } }],
    }), { status: 200 }))
    await expect(translateSubtitleBatch(['most folks', 'might', 'instinctively', 'think'], 'sk-test', request))
      .resolves.toEqual(['大多数人', '可能会', '', ''])
  })

  it('tolerates fenced model output', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n["大多数人可能", "会本能地想"]\n```' } }],
    }), { status: 200 }))
    await expect(translateSubtitleBatch(['Most folks might', 'instinctively think'], 'sk-test', request))
      .resolves.toEqual(['大多数人可能', '会本能地想'])
  })

  it('fails loudly on non-array or empty responses so the batch stays untranslated', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '我不会翻译' } }],
    }), { status: 200 }))
    await expect(translateSubtitleBatch(['most folks'], 'sk-test', request)).rejects.toThrow(/JSON array/)

    const httpError = vi.fn<typeof fetch>().mockResolvedValue(new Response('rate limited', { status: 429 }))
    await expect(translateSubtitleBatch(['most folks'], 'sk-test', httpError)).rejects.toThrow(/429/)
  })

  it('authorizes with the configured model key against DeepSeek', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '["好"]' } }],
    }), { status: 200 }))
    await translateSubtitleBatch(['ok'], 'sk-test-key', request)
    const [url, init] = request.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key')
  })
})
