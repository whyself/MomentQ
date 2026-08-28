import { describe, expect, it } from 'vitest'
import { selectSubtitleWindow } from '../src/sidepanel/subtitle-window'

const segments = Array.from({ length: 8 }, (_, index) => ({
  start: index * 2,
  end: index * 2 + 1.5,
  text: `字幕 ${index}`,
}))

describe('subtitle ticker window', () => {
  it('renders nothing until a real playback clock reaches the first cue', () => {
    expect(selectSubtitleWindow(segments, undefined)).toBeNull()
    expect(selectSubtitleWindow(segments, 0)).toMatchObject({ index: 0, start: 0 })
  })

  it('keeps only the current cue and four previous cues', () => {
    const window = selectSubtitleWindow(segments, 14.5)
    expect(window).toEqual({ index: 7, start: 3, segments: segments.slice(3, 8) })
  })

  it('moves only forward at a shared cue boundary', () => {
    expect(selectSubtitleWindow(segments, 3.999)?.index).toBe(1)
    expect(selectSubtitleWindow(segments, 4)?.index).toBe(2)
  })
})
