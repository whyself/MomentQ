/** Display-only Simplified-Chinese translation of a fetched subtitle track. */

import type { BilibiliSubtitleSegment } from './protocol'

/** True when a track's text is not already Chinese and benefits from one. */
export function trackNeedsChineseTranslation(
  segments: readonly BilibiliSubtitleSegment[],
): boolean {
  const sample = segments.slice(0, 80).map(segment => segment.text).join('')
  const compact = sample.replace(/\s+/g, '')
  if ([...compact].length < 12) return false
  // Kana anywhere means Japanese: Han share alone cannot separate the two.
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(sample)) return true
  const han = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length
  return han / [...compact].length < 0.25
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>
}

const TRANSLATION_SYSTEM_PROMPT = '你是字幕翻译器。把 JSON 字符串数组里的每条字幕翻译成简洁自然的简体中文口语，保留原意，不逐字直译，不添加解释或罗马字。只输出一个 JSON 字符串数组，长度必须与输入完全一致，顺序对应。'

/**
 * Translate one batch of subtitle lines to Simplified Chinese. Tolerant of
 * fenced or annotated model output: only the outermost JSON array is parsed,
 * and missing entries come back as empty strings rather than failing.
 */
export async function translateSubtitleBatch(
  lines: readonly string[],
  apiKey: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string[]> {
  const response = await request('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      stream: false,
      messages: [
        { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(lines) },
      ],
    }),
  })
  if (!response.ok) throw new Error(`subtitle translation HTTP ${response.status}`)
  const data = await response.json() as ChatCompletionResponse
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('subtitle translation response has no content')
  const start = content.indexOf('[')
  const end = content.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('subtitle translation response is not a JSON array')
  let parsed: unknown
  try {
    parsed = JSON.parse(content.slice(start, end + 1))
  } catch (error) {
    throw new Error('subtitle translation response is not valid JSON', { cause: error })
  }
  if (!Array.isArray(parsed)) throw new Error('subtitle translation response is not an array')
  return lines.map((_, index) => {
    const value = parsed[index]
    return typeof value === 'string' ? value.trim() : ''
  })
}
