/**
 * Media-clock anchoring for streaming ASR.
 *
 * The recognition stream consumes wall-time audio (tab capture plays in real
 * time), while transcript rows must carry media-timeline timestamps. Clock
 * messages from the extension anchor `audio-relative seconds -> media time`
 * every ~250 ms; projection interpolates between anchors, so playback rate
 * changes are absorbed by consecutive anchors without an explicit rate.
 */

/** Media-time jump (seconds) larger than this is treated as a seek. */
export const SEEK_TOLERANCE_SECONDS = 1.0

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2

type Anchor = { audio: number; media: number; rate: number }

const MAX_ANCHORS = 8
const MIN_ANCHOR_INTERVAL_SECONDS = 0.05

export class MediaClock {
  private audioSeconds = 0
  private anchors: Anchor[] = []

  /** Account for one binary PCM frame; frames may be dropped during silence. */
  feedAudio(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return
    this.audioSeconds += bytes / BYTES_PER_SAMPLE / SAMPLE_RATE
  }

  /** Stream-relative audio seconds consumed so far. */
  currentAudio(): number {
    return this.audioSeconds
  }

  /**
   * Observe the media clock at the current audio position. Returns 'seek'
   * when playback jumped; callers should drop the in-flight sentence and
   * trim transcript rows that now lie ahead of the playhead.
   */
  observe(mediaTime: number): 'anchored' | 'seek' {
    if (!Number.isFinite(mediaTime) || mediaTime < 0) return 'anchored'
    const projected = this.project(this.audioSeconds)
    if (projected !== undefined && Math.abs(projected - mediaTime) > SEEK_TOLERANCE_SECONDS) {
      this.anchors = [{ audio: this.audioSeconds, media: mediaTime, rate: this.currentRate() }]
      return 'seek'
    }
    this.pushAnchor(this.audioSeconds, mediaTime)
    return 'anchored'
  }

  /**
   * Media time for a stream-relative audio position; undefined until the
   * first clock anchor arrives, so early sentences are discarded rather than
   * guessed. Audio before the first anchor clamps to that anchor: at most a
   * fraction of a second of lead-in that would otherwise be unanchorable.
   */
  project(audio: number): number | undefined {
    const first = this.anchors[0]
    if (first === undefined || !Number.isFinite(audio)) return undefined
    if (audio <= first.audio) return first.media
    let anchor = first
    for (const candidate of this.anchors) {
      if (candidate.audio <= audio) anchor = candidate
      else break
    }
    return anchor.media + (audio - anchor.audio) * anchor.rate
  }

  private currentRate(): number {
    return this.anchors[this.anchors.length - 1]?.rate ?? 1
  }

  private pushAnchor(audio: number, media: number): void {
    const previous = this.anchors[this.anchors.length - 1]
    let rate = this.currentRate()
    if (previous !== undefined) {
      const audioDelta = audio - previous.audio
      if (audioDelta > MIN_ANCHOR_INTERVAL_SECONDS) {
        const implied = (media - previous.media) / audioDelta
        if (Number.isFinite(implied) && implied > 0) rate = Math.min(Math.max(implied, 0.1), 10)
      }
    }
    this.anchors.push({ audio, media, rate })
    if (this.anchors.length > MAX_ANCHORS) this.anchors.shift()
  }
}
