import type { BilibiliSubtitleSegment } from '../shared/protocol'

export type SubtitleWindow = {
  index: number
  start: number
  segments: BilibiliSubtitleSegment[]
}

/** Select the latest cue that has started and a small, bottom-aligned history. */
export function selectSubtitleWindow(
  segments: BilibiliSubtitleSegment[],
  playbackTime: number | undefined,
  historyRows = 4,
): SubtitleWindow | null {
  const first = segments[0]
  if (playbackTime === undefined || !Number.isFinite(playbackTime)
    || first === undefined || playbackTime < first.start) return null

  // Tracks are time ordered. Binary search avoids scanning and rebuilding the
  // complete transcript on every 250 ms clock tick.
  let low = 0
  let high = segments.length - 1
  let index = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const segment = segments[middle]
    if (segment === undefined) break
    if (segment.start <= playbackTime) {
      index = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const start = Math.max(0, index - Math.max(0, historyRows))
  return { index, start, segments: segments.slice(start, index + 1) }
}
