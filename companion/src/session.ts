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

  constructor(
    private readonly dependencies: AsrSessionDependencies,
    private readonly callbacks: AsrSessionCallbacks,
  ) {}

  /** Handle one validated JSON control frame from the browser. */
  async handleClientMessage(message: CompanionClientMessage): Promise<void> {
    if (this.stopped) return
    if (message.type === 'start') {
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

  private async ensureStream(): Promise<void> {
    if (this.stream !== undefined || this.stopped) return
    this.connecting ??= this.connectStream().finally(() => { this.connecting = undefined })
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
      if (this.stopped) {
        await stream.cancel()
        return
      }
      this.stream = stream
      for (const chunk of this.audioQueue.splice(0)) stream.sendAudio(chunk)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      console.error(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} 百度连接失败：`, raw)
      // Baidu drops a session that received no audio for ~10s (err_no 4002
      // "backend timeout") — the signature of starting on a paused/muted
      // video. Say that instead of the opaque protocol text.
      const friendly = /closed during handshake|backend timeout|4002/i.test(raw)
        ? '未检测到音频输入：请确认视频正在播放且有声音，然后重新开始转录'
        : raw
      console.error(`[momentq-companion] ${new Date().toISOString().slice(11, 23)} 百度连接失败：`, friendly)
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
    // Drop the broken connection; audio keeps queueing and the next frame
    // reopens the upstream so recognition resumes mid-session.
    this.stream = undefined
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
    this.segments.push(segment)
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
