/**
 * Pre-transcription driver: full-video offline ASR. Downloads the DASH
 * audio, decodes it to 16 kHz mono, transcribes sequential 30 s windows on
 * the TRUE media timeline, and persists each window through the existing
 * syncTranscript path. Seek-proof by construction: nothing depends on the
 * playhead.
 */

import { decodeAudioToPcm16k, fetchDashAudio } from './pre-transcribe'
import { transcribeSegments, type WhisperModel, type WhisperSegment } from '../shared/asr-whisper'
import { loadSettings } from '../shared/settings-store'

export type PreTranscribeProgress = {
  /** 0..1 across the whole pipeline (download+decode 0..0.3, ASR 0.3..1). */
  fraction: number
  stage: 'downloading' | 'decoding' | 'transcribing' | 'done'
  /** Human-readable line for the subtitle ticker. */
  message: string
}

export type PreTranscribeHandle = { cancel: () => void }

const WINDOW_SECONDS = 30
const SAMPLE_RATE = 16_000
const WINDOW_SAMPLES = WINDOW_SECONDS * SAMPLE_RATE
/**
 * Lecture speech runs ~4-6 Chinese chars/s (healthy windows measured at
 * ~150 chars / 30 s). Below this density the window almost always means
 * whisper emitted EOS early and dropped the rest — measured in the field:
 * 19 chars for 30 s of continuous lecture, with the missing middle audible
 * in the video. Such windows are retried as two 15 s halves: the cut lands
 * at a different utterance point and each half starts on a cleaner boundary.
 */
const MIN_CHARS_PER_SECOND = 2

/**
 * Run the whole pipeline. `onSegments` receives each completed window as
 * media-time-true segments, ready for the Host's syncTranscript (append).
 * Cancellation is cooperative: the audio download and each transcription
 * window check the flag between steps.
 */
export async function runPreTranscription(options: {
  bvid: string
  cid: string
  durationSeconds: number | undefined
  model: WhisperModel
  onProgress: (progress: PreTranscribeProgress) => void
  onSegments: (segments: Array<{ start: number; end: number; text: string }>) => Promise<void> | void
  isCancelled: () => boolean
}): Promise<{ skipped: number }> {
  const { bvid, cid, durationSeconds, model, onProgress, onSegments, isCancelled } = options
  const throwIfCancelled = (): void => {
    if (isCancelled()) throw new Error('已取消预识别')
  }

  onProgress({ fraction: 0.02, stage: 'downloading', message: '正在获取音频地址…' })
  let dash: Awaited<ReturnType<typeof fetchDashAudio>>
  try {
    dash = await fetchDashAudio(bvid, cid)
  } catch (error) {
    throw new Error(`获取音频地址：${error instanceof Error ? error.message : String(error)}`)
  }
  throwIfCancelled()

  onProgress({ fraction: 0.05, stage: 'downloading', message: '正在下载音频…' })
  let fileBytes: ArrayBuffer
  try {
    // The Bilibili CDN requires UA + bilibili.com Referer — both protected
    // headers in every extension context. The local companion (Node) has
    // full header control and proxies the download.
    const settings = await loadSettings()
    const proxyUrl = `${settings.companionBaseUrl.replace(/\/$/, '')}/proxy/audio?url=${encodeURIComponent(dash.baseUrl)}`
    const audioResponse = await fetch(proxyUrl)
    if (!audioResponse.ok) {
      const detail = await audioResponse.json().catch(() => null) as { error?: { message?: unknown } } | null
      const message = detail?.error?.message
      throw new Error(typeof message === 'string' ? message : `HTTP ${audioResponse.status}`)
    }
    fileBytes = await audioResponse.arrayBuffer()
  } catch (error) {
    throw new Error(`音频下载失败（${dash.baseUrl.split('/')[2]}）：${error instanceof Error ? error.message : String(error)}。请确认已运行 scripts\start-local.cmd`)
  }
  throwIfCancelled()

  onProgress({ fraction: 0.18, stage: 'decoding', message: '正在解码音频…' })
  const { pcm, durationSeconds: decodedSeconds, impliedSampleRate } = await decodeAudioToPcm16k(fileBytes, dash, (seconds) => {
    const total = durationSeconds ?? seconds
    const fraction = total > 0 ? 0.18 + 0.12 * Math.min(1, seconds / total) : 0.22
    onProgress({ fraction, stage: 'decoding', message: `解码中 ${Math.round(seconds)}s…` })
  })
  throwIfCancelled()
  if (pcm.length === 0) throw new Error('解码后没有音频数据')
  // Field diagnostics: the rate the decoder ACTUALLY produced (frames / media
  // clock) vs what the container declared. A mismatch here is exactly the
  // signature of the 2.756× timeline stretch.
  console.info(`[momentq] 解码完成：${Math.round(pcm.length / 16_000)}s @16kHz，实际采样率 ${Math.round(impliedSampleRate)} Hz，媒体时钟 ${Math.round(decodedSeconds)}s`)
  // The decoded media duration must track the page's known duration. A large
  // divergence is the signature of a broken sample rate (measured in the
  // field: 44.1 kHz passed as 16 kHz stretched the timeline 2.756×, putting
  // every cue ~21 min past a 7 min video). Fail loudly instead of saving a
  // silently wrong transcript.
  if (durationSeconds && decodedSeconds > 0) {
    const deviation = Math.abs(decodedSeconds - durationSeconds) / durationSeconds
    if (deviation > 0.2) {
      throw new Error(`解码出的音频时长 ${Math.round(decodedSeconds)}s 与页面时长 ${Math.round(durationSeconds)}s 偏差过大（${Math.round(deviation * 100)}%），请重新运行预识别`)
    }
  }

  const windows = Math.ceil(pcm.length / WINDOW_SAMPLES)
  let skipped = 0
  for (let index = 0; index < windows; index += 1) {
    throwIfCancelled()
    const startSample = index * WINDOW_SAMPLES
    const window = pcm.subarray(startSample, Math.min(startSample + WINDOW_SAMPLES, pcm.length))
    const start = startSample / SAMPLE_RATE
    const end = (startSample + window.length) / SAMPLE_RATE
    const base = 0.3
    const span = 0.7
    const fraction = base + span * (index / windows)
    onProgress({
      fraction,
      stage: 'transcribing',
      message: `识别中 ${Math.floor(start / 60)}:${String(Math.floor(start % 60)).padStart(2, '0')} / ${Math.floor(end / 60)}:${String(Math.floor(end % 60)).padStart(2, '0')}（${index + 1}/${windows} 段）`,
    })
    // One window yields several timed sentence lines (whisper's own
    // end-of-phrase chunks, gap-segmented and punctuated — U+FFFD is
    // stripped inside buildSegments, and the Host still refuses any batch
    // that carries it). A window that is nothing but silence or corruption
    // is skipped instead of persisted as garbage.
    const windowSeconds = window.length / SAMPLE_RATE
    const charCount = (list: WhisperSegment[]): number =>
      list.reduce((sum, segment) => sum + segment.text.length, 0)
    let segments = await transcribeSegments(window, model, () => {})
    let totalChars = charCount(segments)
    // Sparse-window retry: whisper emits EOS early on some 30 s windows and
    // silently drops the rest (see MIN_CHARS_PER_SECOND). Split the window
    // into two 15 s halves and keep the retry only when it recovered
    // strictly more speech — a genuinely quiet window must never be swapped
    // for worse output.
    if (totalChars > 0 && totalChars / windowSeconds < MIN_CHARS_PER_SECOND) {
      onProgress({
        fraction,
        stage: 'transcribing',
        message: `第 ${index + 1} 段识别偏短（${totalChars} 字），拆分重试中…`,
      })
      const half = Math.floor(window.length / 2)
      const halfSeconds = half / SAMPLE_RATE
      const parts = [window.subarray(0, half), window.subarray(half)]
      const retried: WhisperSegment[] = []
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        throwIfCancelled()
        const part = parts[partIndex]
        if (part === undefined) continue
        // The second half's chunk times are relative to the half's own start;
        // shift them onto the window timeline before merging.
        const offset = partIndex * halfSeconds
        for (const segment of await transcribeSegments(part, model, () => {})) {
          retried.push({ text: segment.text, start: segment.start + offset, end: segment.end + offset })
        }
      }
      const retriedChars = charCount(retried)
      if (retriedChars > totalChars) {
        console.warn(`[momentq] 第 ${index + 1} 段（${Math.round(start)}-${Math.round(end)}s）识别偏短 ${totalChars} 字，拆半重试后 ${retriedChars} 字`)
        segments = retried
        totalChars = retriedChars
      } else {
        console.warn(`[momentq] 第 ${index + 1} 段（${Math.round(start)}-${Math.round(end)}s）识别偏短 ${totalChars} 字，拆半重试未改善（${retriedChars} 字），保留原结果`)
      }
    }
    if (totalChars === 0) {
      skipped += 1
      console.warn(`[momentq] 预识别跳过第 ${index + 1} 段（${Math.round(start)}-${Math.round(end)}s）：识别结果为空或含乱码`)
      continue
    }
    // Window-relative → media-true, rounded to centiseconds; clamped to the
    // window so a late chunk timestamp can never overlap the next window.
    await onSegments(segments.map(segment => ({
      start: Math.round((start + segment.start) * 100) / 100,
      end: Math.round(Math.min(start + segment.end, end) * 100) / 100,
      text: segment.text,
    })))
  }
  onProgress({ fraction: 1, stage: 'done', message: '预识别完成' })
  return { skipped }
}
