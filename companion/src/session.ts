/**
 * One recognition session: the orchestration between one browser WebSocket,
 * the Baidu upstream, and Host transcript persistence.
 *
 * Audio arrives as raw 16k/16bit/mono PCM; clock messages anchor it to the
 * media timeline; Baidu owns sentence segmentation; finalized rows are
 * accumulated in stream order and replace-synced into the Host transcript
 * (same `transcript.jsonl` shape as Bilibili subtitle imports).
 */

import type { TranscriptSegment } from '../../dsh/packages/bundle/src/sdk'
import { MomentQClient } from '../../dsh/packages/bundle/src/sdk'
import type { CompanionClientMessage, CompanionServerMessage } from '../../shared/src/companion-protocol'
import type { AsrContentIdentity } from '../../shared/src/companion-protocol'
import { MediaClock, SEEK_TOLERANCE_SECONDS } from './clock'
import { CONNECTION_MAX_AGE_MS, openBaiduStream, type BaiduStream, type BaiduStreamConfig } from './baidu'

export type AsrSessionCallbacks = {
  send: (message: CompanionServerMessage) => void
}

export type AsrSessionDependencies = {
  identity: AsrContentIdentity
  baidu: BaiduStreamConfig
  hostBaseUrl: string
  provider: string
  fetcher?: typeof fetch | undefined
  now?: (() => number) | undefined
  socketFactory?: ((url: string) => import('ws').WebSocket) | undefined
}

export class AsrSession {
  private readonly clock = new MediaClock()
  private readonly segments: TranscriptSegment[] = []
  private stream: BaiduStream | undefined
  private connecting: Promise<void> | undefined
  private audioQueue: Buffer[] = []
  /** Stream-relative audio position where the in-flight sentence began. */
  private sentenceOpenAudio: number = 0
  private sawClock = false
  private persistChain: Promise<void> = Promise.resolve()
  private stopped = false
  private lastConnectAttemptMs = 0
  private connectBackoffMs = 0
  private hadConnectFailure = false
  private seeded: Promise<void> | undefined

  constructor(
    private readonly dependencies: AsrSessionDependencies,
    private readonly callbacks: AsrSessionCallbacks,
  ) {}

  /** Handle one validated JSON control frame from the browser. */
  async handleClientMessage(message: CompanionClientMessage): Promise<void> {
    if (this.stopped) return
    if (message.type === 'start') {
      await this.seedFromPersistedTranscript()
      await this.ensureStream()
      this.callbacks.send({ type: 'ready', provider: this.dependencies.provider })
      return
    }
    if (message.type === 'clock') {
      this.sawClock = true
      if (this.clock.observe(message.mediaTime) === 'seek') {
        // Discard the in-flight sentence and any rows recorded past the new
        // playhead so a re-watched region is not duplicated in the transcript.
        this.sentenceOpenAudio = this.clock.currentAudio()
        const cutoff = message.mediaTime + SEEK_TOLERANCE_SECONDS
        while (this.segments.length > 0) {
          const last = this.segments[this.segments.length - 1]
          if (last === undefined || last.end <= cutoff) break
          this.segments.pop()
        }
      }
      return
    }
    if (message.type === 'stop') await this.stop()
  }

  /** Feed one binary PCM frame. */
  async feedAudio(chunk: Buffer): Promise<void> {
    if (this.stopped) return
    this.clock.feedAudio(chunk.length)
    await this.ensureStream()
    if (this.stream !== undefined) {
      this.stream.sendAudio(chunk)
      return
    }
    // Upstream still connecting (or just failed): buffer briefly so the
    // first words of a sentence are not lost, dropping the oldest frames
    // beyond a small window.
    this.audioQueue.push(chunk)
    while (this.audioQueue.length > 50) this.audioQueue.shift()
  }

  /** Finish the upstream run, flush persistence, and close the session. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Ask the upstream to finalize the trailing sentence and drain events
    // briefly before closing.
    const stream = this.stream
    this.stream = undefined
    if (stream !== undefined) await stream.finish()
    await this.persist()
  }

  /**
   * Seed the in-memory rows from the persisted transcript so continuing a
   * previous session APPENDS instead of replacing (the first persist would
   * otherwise erase everything transcribed before the reopen). Only an 'asr'
   * provenance seeds: an official Bilibili import has different content.
   */
  private seedFromPersistedTranscript(): Promise<void> {
    if (this.seeded === undefined) {
      this.seeded = (async () => {
        try {
          const client = new MomentQClient({ baseUrl: this.dependencies.hostBaseUrl, fetch: this.dependencies.fetcher })
          const persisted = await client.getTranscript(this.dependencies.identity)
          if (persisted.source !== 'asr' || this.segments.length > 0) return
          this.segments.push(...persisted.segments)
        } catch {
          // Seeding is an upgrade, not a requirement: an unreachable Host
          // leaves a fresh session that behaves exactly as before.
        }
      })()
    }
    return this.seeded
  }

  private async ensureStream(): Promise<void> {    if (this.stream !== undefined || this.stopped) return
    if (this.connecting === undefined) {
      // Exponential backoff between upstream attempts: an extended Baidu
      // outage must not turn every audio frame into a dial plus an error
      // frame pair (log flood + UI flood).
      const nowMs = this.dependencies.now?.() ?? Date.now()
      const waitMs = Math.max(0, this.lastConnectAttemptMs + this.connectBackoffMs - nowMs)
      this.lastConnectAttemptMs = nowMs + waitMs
      this.connecting = (waitMs > 0
        ? new Promise<void>(resolve => setTimeout(resolve, waitMs))
        : Promise.resolve())
        .then(() => this.connectStream())
        .finally(() => { this.connecting = undefined })
    }
    await this.connecting
  }

  private async connectStream(): Promise<void> {
    try {
      console.log(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} 连接百度实时 ASR…`)
      const stream = await openBaiduStream(this.dependencies.baidu, {
        onEvent: event => this.handleUpstreamEvent(event),
        onError: () => this.handleUpstreamFailure(),
      }, {
        fetcher: this.dependencies.fetcher,
        now: this.dependencies.now,
        socketFactory: this.dependencies.socketFactory,
      })
      console.log(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} 百度实时 ASR 已连接`)
      this.connectBackoffMs = 0
      if (this.stopped) {
        await stream.cancel()
        return
      }
      this.stream = stream
      for (const chunk of this.audioQueue.splice(0)) stream.sendAudio(chunk)
      // A reconnect after a mid-session failure must tell the extension the
      // upstream is back, clearing the interruption note in the panel.
      if (this.hadConnectFailure) {
        this.hadConnectFailure = false
        this.callbacks.send({ type: 'ready', provider: this.dependencies.provider })
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      this.connectBackoffMs = this.connectBackoffMs === 0 ? 1_000 : Math.min(this.connectBackoffMs * 2, 30_000)
      // Baidu drops a session that received no audio for ~10s (err_no 4002
      // "backend timeout") — the signature of starting on a paused/muted
      // video. Say that instead of the opaque protocol text.
      const friendly = /closed during handshake|backend timeout|4002|handshake timed out/i.test(raw)
        ? '未检测到音频输入：请确认视频正在播放且有声音，然后重新开始转录'
        : raw
      console.error(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} 百度连接失败（${Math.round(this.connectBackoffMs / 1000)}s 后重试）：`, friendly)
      // Leave the session alive: the extension keeps streaming and the next
      // frame retries the connection instead of killing the whole capture.
      this.callbacks.send({
        type: 'error',
        code: 'provider-connect',
        message: friendly,
      })
    }
  }

  private handleUpstreamEvent(event: import('./baidu').BaiduStreamEvent): void {
    if (event.kind === 'partial') {
      this.callbacks.send({ type: 'partial', text: event.text })
      return
    }
    if (event.kind === 'final') this.finalizeSentence(event.text)
    if (event.kind === 'finished' || event.kind === 'started') return
  }

  private handleUpstreamFailure(): void {
    // Close the broken connection FOR REAL: leaving it open let late
    // MID_TEXT frames from the dead stream interleave with the reconnect's
    // output. Audio keeps queueing and the next frame reopens the upstream.
    const stream = this.stream
    this.stream = undefined
    // Reset the sentence anchor so the next stream's first sentence does not
    // project its start back into pre-failure time.
    this.sentenceOpenAudio = this.clock.currentAudio()
    if (stream !== undefined) stream.cancel()
    this.hadConnectFailure = true
  }

  private finalizeSentence(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    const openAudio = this.sentenceOpenAudio
    this.sentenceOpenAudio = this.clock.currentAudio()
    if (!this.sawClock) return
    const start = this.clock.project(openAudio)
    const end = this.clock.project(this.clock.currentAudio())
    if (start === undefined || end === undefined) return
    const segment: TranscriptSegment = {
      start: Math.max(0, Math.round(start * 100) / 100),
      end: Math.max(Math.max(0, Math.round(start * 100) / 100), Math.round(end * 100) / 100),
      text: trimmed,
    }
    // Renew the upstream connection proactively between sentences.
    const stream = this.stream
    if (stream !== undefined && stream.ageMs() > CONNECTION_MAX_AGE_MS) {
      this.stream = undefined
      void stream.finish()
    }
    // Coverage semantics: each time range is held once, latest recognition
    // wins. Re-watching a region (or a clock hiccup) must not stack duplicate
    // rows on top of the seeded history.
    const overlapping = (candidate: TranscriptSegment): boolean =>
      candidate.start < segment.end && candidate.end > segment.start
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const candidate = this.segments[index]
      if (candidate === undefined) continue
      if (candidate.end <= segment.start) break
      if (overlapping(candidate)) this.segments.splice(index, 1)
    }
    this.segments.push(segment)
    this.segments.sort((left, right) => left.start - right.start)
    this.callbacks.send({ type: 'final', text: segment.text, start: segment.start, end: segment.end })
    this.persist()
  }

  /** Replace-sync the accumulated rows into the Host transcript, serialized. */
  private persist(): Promise<void> {
    const previous = this.persistChain
    const next = previous.catch(() => {}).then(async () => {
      if (this.stopped && this.segments.length === 0) return
      const client = new MomentQClient({ baseUrl: this.dependencies.hostBaseUrl, fetch: this.dependencies.fetcher })
      await client.syncTranscript(this.dependencies.identity, 'asr', this.segments)
      this.callbacks.send({ type: 'persisted', segments: this.segments.length })
    }).catch(() => {
      this.callbacks.send({ type: 'error', code: 'host-sync', message: 'MomentQ Host sync failed' })
    })
    this.persistChain = next
    return next
  }
}
