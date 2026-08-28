import { describe, expect, it } from 'vitest'
import { MediaClock, SEEK_TOLERANCE_SECONDS } from '../src/clock'

/** Bytes of 16 kHz / 16-bit mono PCM for one second of audio. */
const ONE_SECOND_BYTES = 32_000

describe('MediaClock', () => {
  it('projects nothing before the first clock anchor', () => {
    const clock = new MediaClock()
    clock.feedAudio(ONE_SECOND_BYTES)
    expect(clock.project(0.1)).toBeUndefined()
  })

  it('maps stream-relative audio time to media time', () => {
    const clock = new MediaClock()
    clock.observe(10)
    clock.feedAudio(2 * ONE_SECOND_BYTES)
    expect(clock.project(0)).toBeCloseTo(10, 5)
    expect(clock.project(2)).toBeCloseTo(12, 5)
  })

  it('absorbs playback rate changes through consecutive anchors', () => {
    const clock = new MediaClock()
    clock.observe(10)
    clock.feedAudio(ONE_SECOND_BYTES) // 1 s of audio while media advanced 2 s (2x rate)
    clock.observe(12)
    clock.feedAudio(ONE_SECOND_BYTES) // another 1 s of audio at the same rate
    expect(clock.project(2)).toBeCloseTo(14, 5)
  })

  it('keeps projecting through silence (paused video) without drifting', () => {
    const clock = new MediaClock()
    clock.observe(10)
    clock.feedAudio(ONE_SECOND_BYTES)
    // No audio arrives while the video is paused; the clock still reads 11.
    expect(clock.observe(11)).toBe('anchored')
    expect(clock.project(1)).toBeCloseTo(11, 5)
  })

  it('reports a seek and re-anchors to the new playhead', () => {
    const clock = new MediaClock()
    clock.observe(10)
    clock.feedAudio(ONE_SECOND_BYTES)
    clock.observe(11)
    clock.feedAudio(ONE_SECOND_BYTES)
    // Playback jumps back to 3 s while the stream sits at 2 s of audio.
    expect(clock.observe(3)).toBe('seek')
    expect(clock.project(2)).toBeCloseTo(3, 5)
    clock.feedAudio(ONE_SECOND_BYTES)
    expect(clock.project(3)).toBeCloseTo(4, 5)
  })

  it('treats small clock jitter as noise, not a seek', () => {
    const clock = new MediaClock()
    clock.observe(10)
    clock.feedAudio(ONE_SECOND_BYTES)
    expect(clock.observe(11 + SEEK_TOLERANCE_SECONDS - 0.2)).toBe('anchored')
  })
})
