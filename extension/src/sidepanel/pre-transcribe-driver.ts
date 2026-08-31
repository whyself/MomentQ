/**
 * Pre-transcription driver: full-video offline ASR. Downloads the DASH
 * audio, decodes it to 16 kHz mono, transcribes sequential 30 s windows on
 * the TRUE media timeline, and persists each window through the existing
 * syncTranscript path. Seek-proof by construction: nothing depends on the
 * playhead.
 */

import { decodeAudioToPcm16k, fetchDashAudio } from './pre-transcribe'
import { transcribeChunk, type WhisperModel } from './asr-whisper'

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
}): Promise<void> {
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
    const reply = await chrome.runtime.sendMessage({ type: 'MOMENTQ_PROXY_FETCH', url: dash.baseUrl }) as
      { ok?: unknown; value?: { base64?: unknown }; error?: { message?: unknown } } | null
    if (reply === null || reply.ok !== true || typeof reply.value?.base64 !== 'string') {
      const detail = reply?.error && typeof reply.error.message === 'string' ? reply.error.message : '未知错误'
      throw new Error(detail)
    }
    const binary = atob(reply.value.base64)
    fileBytes = new ArrayBuffer(binary.length)
    const view = new Uint8Array(fileBytes)
    for (let index = 0; index < binary.length; index += 1) view[index] = binary.charCodeAt(index)
  } catch (error) {
    throw new Error(`音频下载失败（${dash.baseUrl.split('/')[2]}）：${error instanceof Error ? error.message : String(error)}`)
  }
  throwIfCancelled()

  onProgress({ fraction: 0.18, stage: 'decoding', message: '正在解码音频…' })
  const { pcm } = await decodeAudioToPcm16k(fileBytes, dash, (seconds) => {
    const total = durationSeconds ?? seconds
    const fraction = total > 0 ? 0.18 + 0.12 * Math.min(1, seconds / total) : 0.22
    onProgress({ fraction, stage: 'decoding', message: `解码中 ${Math.round(seconds)}s…` })
  })
  throwIfCancelled()
  if (pcm.length === 0) throw new Error('解码后没有音频数据')

  const windows = Math.ceil(pcm.length / WINDOW_SAMPLES)
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
    const text = (await transcribeChunk(window, model, () => {})).trim()
    if (text !== '') await onSegments([{ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, text }])
  }
  onProgress({ fraction: 1, stage: 'done', message: '预识别完成' })
}
