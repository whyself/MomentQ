import { describe, expect, it } from 'vitest'
import { buildSegments, type WhisperSegment } from '../src/shared/asr-whisper'
import { isSilent } from '../src/shared/whisper-live'

// Whisper's onnx-community exports carry no cross-attention outputs, so the
// only timestamps the local engine can produce are the model's own
// end-of-phrase token chunks. buildSegments is where those chunks become
// the sentence lines the subtitle row shows. Lines break ONLY on the
// model's own sentence-end punctuation (semantic, no gap/length heuristics)
// — that behavior is pinned here.
type Chunk = { text?: string; timestamp?: [number, number | null] | number | null }

const segments = (chunks: Chunk[], maxSeconds?: number): WhisperSegment[] =>
  buildSegments({ chunks }, maxSeconds)

describe('buildSegments', () => {
  it('merges chunks with small gaps into one comma-joined, period-closed sentence', () => {
    const lines = segments([
      { text: '今天我们来讨论', timestamp: [0, 1.2] },
      { text: '分布式系统的基础', timestamp: [1.3, 2.8] },
      { text: '先从一个例子开始', timestamp: [2.9, 4.0] },
    ])
    expect(lines).toEqual([
      { text: '今天我们来讨论，分布式系统的基础，先从一个例子开始。', start: 0, end: 4 },
    ])
  })

  it('never breaks on a silence gap alone — only the model punctuation breaks', () => {
    const lines = segments([
      { text: '这句话到此结束了', timestamp: [0, 1.0] },
      { text: '新的一句话', timestamp: [2.2, 3.5] },
    ])
    expect(lines).toEqual([
      { text: '这句话到此结束了，新的一句话。', start: 0, end: 3.5 },
    ])
  })

  it('keeps a short fragment joined across a long gap (mid-phrase timestamp tokens)', () => {
    // The base model drops a timestamp token mid-phrase; a 2 s pause must
    // not break a new line — without sentence punctuation it is still the
    // same sentence.
    const lines = segments([
      { text: '这句话结束了', timestamp: [0, 1.0] },
      { text: '新的一句话', timestamp: [3.0, 4.0] },
    ])
    expect(lines).toEqual([
      { text: '这句话结束了，新的一句话。', start: 0, end: 4 },
    ])
  })

  it('does not double punctuation the model already emitted', () => {
    const lines = segments([
      { text: '第一句，', timestamp: [0, 1.0] },
      { text: '接着说，', timestamp: [1.1, 2.0] },
      { text: '说完结束。', timestamp: [2.2, 3.5] },
    ])
    expect(lines).toEqual([
      { text: '第一句，接着说，说完结束。', start: 0, end: 3.5 },
    ])
  })

  it('upgrades a trailing clause comma to a period on the final flush', () => {
    const lines = segments([
      { text: '第一句话到这里，', timestamp: [0, 1.5] },
    ])
    expect(lines).toEqual([
      { text: '第一句话到这里。', start: 0, end: 1.5 },
    ])
  })

  it('treats an existing sentence end as a line boundary even inside a chunk run', () => {
    // Chunk A ends a sentence, chunk B follows within the gap threshold:
    // B still opens a fresh sentence line, and A is closed as-is.
    const lines = segments([
      { text: '前面一句。', timestamp: [0, 1.0] },
      { text: '后面一句', timestamp: [1.1, 2.0] },
    ])
    expect(lines).toEqual([
      { text: '前面一句。', start: 0, end: 1 },
      { text: '后面一句。', start: 1.1, end: 2 },
    ])
  })

  it('strips U+FFFD and drops empty chunks', () => {
    const lines = segments([
      { text: '正常内容', timestamp: [0, 1.0] },
      { text: '\uFFFD\uFFFD', timestamp: [1.05, 1.15] },
      { text: '  ', timestamp: [1.2, 1.3] },
      { text: '乱\uFFFD码也留下', timestamp: [1.35, 2.0] },
    ])
    expect(lines).toEqual([
      { text: '正常内容，乱码也留下。', start: 0, end: 2 },
    ])
  })

  it('treats a null end on the final chunk as end == start', () => {
    const lines = segments([
      { text: '第一句话已经讲完。', timestamp: [0, 2.0] },
      { text: '结尾', timestamp: [3.0, null] },
    ])
    expect(lines).toEqual([
      { text: '第一句话已经讲完。', start: 0, end: 2 },
      { text: '结尾。', start: 3, end: 3 },
    ])
  })

  it('clamps every line to maxSeconds', () => {
    const lines = segments([
      { text: '开头的一段铺垫啊。', timestamp: [0, 1.0] },
      { text: '超出边界的结尾', timestamp: [10, 31.5] },
    ], 30)
    expect(lines[1]).toEqual({ text: '超出边界的结尾。', start: 10, end: 30 })
  })

  it('never forces a line break at 30 characters — an unpunctuated run stays one line', () => {
    const lines = segments([
      { text: '一二三四五六七八九十', timestamp: [0, 2.0] },
      { text: '十一十二十三十四十五', timestamp: [2.1, 4.0] },
      { text: '十六十七十八十九二十', timestamp: [4.1, 6.0] },
      { text: '二十一二十二', timestamp: [6.1, 7.0] },
    ])
    expect(lines).toEqual([
      { text: '一二三四五六七八九十，十一十二十三十四十五，十六十七十八十九二十，二十一二十二。', start: 0, end: 7 },
    ])
  })

  it('never forces a line break at 12 seconds — a long unpunctuated run stays one line', () => {
    const lines = segments([
      { text: '第一段内容', timestamp: [0, 2.7] },
      { text: '第二段内容', timestamp: [3.0, 5.7] },
      { text: '第三段内容', timestamp: [6.0, 8.7] },
      { text: '第四段内容', timestamp: [9.0, 11.7] },
      { text: '最后一段', timestamp: [12.0, 14.7] },
    ])
    expect(lines).toEqual([
      { text: '第一段内容，第二段内容，第三段内容，第四段内容，最后一段。', start: 0, end: 14.7 },
    ])
  })

  it('falls back to one untimed line when a backend answers without chunks', () => {
    expect(segments([], 12.5)).toEqual([])
    expect(segments([], undefined)).toEqual([])
    expect(buildSegments({ text: '  只有整段文本 \uFFFD ' }, 12.5)).toEqual([
      { text: '只有整段文本', start: 0, end: 12.5 },
    ])
    expect(buildSegments({ text: '   ' }, 12.5)).toEqual([])
  })

  it('returns [] for an empty result', () => {
    expect(buildSegments({})).toEqual([])
    expect(buildSegments({ text: '', chunks: [] })).toEqual([])
  })
})

describe('isSilent (whisper silence gate)', () => {
  it('skips digital silence (a paused video) and empty audio', () => {
    expect(isSilent(new Float32Array(5 * 16_000))).toBe(true)
    expect(isSilent(new Float32Array(0))).toBe(true)
  })

  it('skips near-silent noise below both thresholds', () => {
    const noise = new Float32Array(5 * 16_000)
    for (let i = 0; i < noise.length; i += 4) noise[i] = i % 8 === 0 ? 0.001 : -0.001
    expect(isSilent(noise)).toBe(true)
  })

  it('still transcribes quiet speech: the peak alone defeats the gate', () => {
    const quiet = new Float32Array(5 * 16_000)
    quiet[1_600] = 0.03
    quiet[1_604] = -0.03
    expect(isSilent(quiet)).toBe(false)
  })

  it('still transcribes loud continuous speech', () => {
    const speech = new Float32Array(5 * 16_000)
    for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(i / 8) * 0.1
    expect(isSilent(speech)).toBe(false)
  })

  it('still transcribes a sparse-speech window (mostly quiet, one loud passage)', () => {
    const sparse = new Float32Array(30 * 16_000)
    const start = 20 * 16_000
    for (let i = 0; i < 5 * 16_000; i++) sparse[start + i] = Math.sin(i / 8) * 0.08
    expect(isSilent(sparse)).toBe(false)
  })
})
