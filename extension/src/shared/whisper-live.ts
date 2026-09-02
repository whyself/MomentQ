/**
 * Live local-Whisper engine: queues captured audio and transcribes it
 * strictly sequentially, reporting partial/final events through a reporter.
 * Hosted by whichever extension document owns the capture stream — the
 * offscreen document (primary, so the session survives the side panel
 * closing) or the panel document (fallback for browsers where the
 * tab-capture id is only consumable in the context that minted it).
 *
 * The runtime is engine-document agnostic on purpose: the same queue, seek
 * handling and staleness guards run in both hosts, so behavior does not
 * depend on which one the session landed in.
 */

import { transcribeSegments, type WhisperModel } from './asr-whisper'

/** Events this engine reports (a subset of the companion server messages). */
export type WhisperLiveReport =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; start: number; end: number }
  | { type: 'error'; code: string; message: string }

/** Worklet chunks arrive every 100 ms; start inference at ≥5 s of audio. */
const WHISPER_CHUNK_SAMPLES = 5 * 16_000
// Bounded waiting room for audio produced while inference is busy (above all
// during the first model download, which can run for many minutes). Beyond
// this window the OLDEST audio is dropped with a visible counter instead of
// silently losing the session's opening — or growing without bound.
const WHISPER_MAX_QUEUE_SAMPLES = 60 * 16_000
// Upper bound on one inference call: whisper's positional design caps
// accurate windows near 30 s, and merging more hurts latency for nothing.
const WHISPER_MAX_UTTERANCE_SAMPLES = 30 * 16_000

type QueuedChunk = { audio: Float32Array; /** Media time at chunk START. */ startMedia: number }

export class WhisperLiveSession {
  private queue: QueuedChunk[] = []
  private queuedSamples = 0
  private processing = false
  private paused = false
  private totalSamples = 0
  private lastMediaSeconds: number | null = null
  private droppedChunks = 0
  /**
   * Bumped on every seek: an utterance dequeued before the seek was captured
   * on an abandoned timeline, so its finals are dropped instead of persisted
   * (the source of the "seek scrambles subtitles" reports).
   */
  private seekGeneration = 0
  private disposed = false

  constructor(
    private readonly model: WhisperModel,
    private readonly report: (event: WhisperLiveReport) => void,
  ) {}

  /** Push one capture (16 kHz mono) in arrival order. */
  feed(audio: Float32Array): void {
    if (this.disposed || this.paused || audio.length === 0) return
    const startMedia = this.lastMediaSeconds ?? this.totalSamples / 16_000
    this.queue.push({ audio, startMedia })
    this.queuedSamples += audio.length
    this.totalSamples += audio.length
    if (this.queuedSamples >= WHISPER_CHUNK_SAMPLES) void this.pump()
  }

  /** Media-clock tick: anchor new chunks and detect seeks. */
  clock(seconds: number): void {
    if (this.disposed || this.paused) return
    // While transcription is paused the video keeps playing; freezing the
    // clock keeps the resumed chunks' timestamps aligned with the audio that
    // will actually be transcribed instead of skipping the paused span.
    const previous = this.lastMediaSeconds
    this.lastMediaSeconds = seconds
    if (previous === null) return
    // Normal playback advances ~1x; poll jitter is small. A jump backwards,
    // or forwards beyond what realtime capture could have produced since the
    // last tick, means the user seeked (or changed speed): the queued audio
    // was captured on a timeline that no longer exists.
    const drift = seconds - previous
    if (drift < -1.5 || drift > 8) {
      this.seekGeneration += 1
      this.queue = []
      this.queuedSamples = 0
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  /** Stop accepting audio and retire any in-flight attribution. */
  dispose(): void {
    this.disposed = true
    this.queue = []
    this.queuedSamples = 0
  }

  /** Drain the queue sequentially; bounded, ordered, never parallel. */
  private async pump(): Promise<void> {
    if (this.processing || this.disposed) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        if (this.disposed) return
        // The reader keeps falling behind: drop the OLDEST audio with a
        // visible counter rather than growing without bound.
        while (this.queuedSamples > WHISPER_MAX_QUEUE_SAMPLES && this.queue.length > 1) {
          const dropped = this.queue.shift()
          if (dropped === undefined) break
          this.queuedSamples -= dropped.audio.length
          this.droppedChunks += 1
          this.report({ type: 'partial', text: `推理跟不上播放，已跳过最早的 ${this.droppedChunks} 段音频` })
        }
        const pieces: QueuedChunk[] = []
        let samples = 0
        while (this.queue.length > 0 && samples < WHISPER_MAX_UTTERANCE_SAMPLES) {
          const next = this.queue.shift()
          if (next === undefined) break
          pieces.push(next)
          this.queuedSamples -= next.audio.length
          samples += next.audio.length
        }
        const epochAtDequeue = this.seekGeneration
        await this.transcribeUtterance(concatSamples(pieces.map(piece => piece.audio)), {
          startMedia: pieces[0]?.startMedia ?? 0,
          epochAtDequeue,
        })
      }
    } finally {
      this.processing = false
    }
  }

  private async transcribeUtterance(
    audio: Float32Array,
    span: { startMedia: number; epochAtDequeue: number },
  ): Promise<void> {
    try {
      // Pure silence (a PAUSED video, an interlude) makes whisper
      // hallucinate phrases that were never spoken — the "weird sentences on
      // pause" reports. Gate on audio energy before spending an inference on
      // a silent window; the peak second gate keeps sparse-speech windows
      // (mostly quiet with one loud passage) transcribed.
      if (isSilent(audio)) return
      this.report({ type: 'partial', text: '本地识别中…' })
      const segments = await transcribeSegments(audio, this.model, (status: string) => {
        this.report({ type: 'partial', text: status })
      })
      // Attribute finals only while this engine still owns the live session
      // on the same timeline: a slow inference must never land its text on a
      // switched video, and a seek during inference invalidates the whole
      // utterance — persisting it would scatter rows across wrong times.
      if (segments.length === 0 || this.disposed || this.seekGeneration !== span.epochAtDequeue) return
      // One final PER SENTENCE: each 5-30 s utterance arrives at the
      // subtitle row as its own timed lines instead of one unpunctuated
      // block, and a reader mid-utterance sees lines appear sentence by
      // sentence as the windows complete.
      for (const segment of segments) {
        const start = Math.max(0, span.startMedia + segment.start)
        const end = Math.max(start, span.startMedia + segment.end)
        this.report({ type: 'final', text: segment.text, start, end })
      }
    } catch (error) {
      if (this.disposed) return
      this.report({
        type: 'error',
        code: 'provider-connect',
        message: `本地 Whisper 识别失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}

/**
 * Digital silence from tab capture sits at/near zero; even quiet speech
 * peaks well above these (loud peaks are typically 0.05-0.3).
 */
const SILENCE_RMS = 0.002
const SILENCE_PEAK = 0.015

export function isSilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true
  let sumSquares = 0
  let peak = 0
  for (let i = 0; i < samples.length; i += 4) {
    // 4x sub-sampling of 16 kHz audio (4 kHz): a speech transient of ≥1 ms
    // spans 16 samples, so no peak escapes the stride — at a quarter of the
    // work.
    const v = samples[i] ?? 0
    sumSquares += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  const count = Math.ceil(samples.length / 4)
  return Math.sqrt(sumSquares / count) < SILENCE_RMS && peak < SILENCE_PEAK
}

function concatSamples(pieces: Float32Array[]): Float32Array {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const piece of pieces) {
    merged.set(piece, offset)
    offset += piece.length
  }
  return merged
}
