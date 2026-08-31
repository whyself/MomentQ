/**
 * Pre-transcription (整视频预识别): fetch the video's full audio track from
 * Bilibili's DASH stream, decode it to PCM with WebCodecs, and transcribe it
 * sequentially with the local Whisper engine. Every segment lands on the
 * true media timeline — seek-proof by construction, unlike realtime capture.
 */

import * as MP4Box from 'mp4box'

export type DashAudio = {
  baseUrl: string
  codec: string
  /** AudioStreamBasicDescription: sample rate the decoder must run at. */
  sampleRate: number
  channels: number
  /** Raw opus/aac config bytes for AudioDecoder.description, if present. */
  description: Uint8Array | undefined
}

type Mp4FileLike = {
  onReady: (info: never) => void
  onSamples: (id: number, ref: unknown, samples: never) => void
  onFlush: () => void
  setExtractionOptions: (id: number, ref: unknown, options: { nbSamples: number }) => void
  start: () => void
  appendBuffer: (buffer: ArrayBuffer) => void
  flush: () => void
}
type SampleLike = {
  data: ArrayBuffer
  cts: number
  dts: number
  duration: number
  is_sync: boolean
}

/**
 * Pull the DASH audio selection for a cid through Bilibili's playurl API
 * (anonymous access works; fnval=16 asks for DASH).
 */
export async function fetchDashAudio(
  bvid: string,
  cid: string,
  fetcher: typeof fetch = fetch,
): Promise<DashAudio> {
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=16`
  const response = await fetcher(url, { credentials: 'include' })
  if (!response.ok) throw new Error(`Bilibili playurl HTTP ${response.status}`)
  const payload = await response.json() as {
    code?: number
    data?: {
      dash?: {
        audio?: Array<{ baseUrl?: string; base_url?: string; codecs?: string } >
      }
    }
  }
  if (payload.code !== 0) throw new Error(`Bilibili playurl code ${String(payload.code)}`)
  const streams = payload.data?.dash?.audio ?? []
  // Prefer the medium-bandwidth m4s track (first entry is usually the
  // 30216/30280 audio tier; quality is irrelevant for ASR).
  const picked = streams[streams.length - 1] ?? streams[0]
  const baseUrl = picked?.baseUrl ?? picked?.base_url
  if (baseUrl === undefined || baseUrl === '') throw new Error('Bilibili playurl returned no audio stream')
  return {
    baseUrl,
    codec: picked?.codecs ?? 'mp4a.40.2',
    sampleRate: 44_100,
    channels: 2,
    description: undefined,
  }
}

/**
 * Decode an fMP4 audio file to Float32 PCM at 16 kHz mono — the exact shape
 * the Whisper pipeline consumes. Uses WebCodecs' AudioDecoder (Edge 120+).
 */
export async function decodeAudioToPcm16k(
  fileBytes: ArrayBuffer,
  dash: DashAudio,
  onProgress: (seconds: number) => void,
): Promise<{ pcm: Float32Array; durationSeconds: number }> {
  // 1) Demux: extract AAC description + samples via mp4box.
  const extraction = await demuxAudio(fileBytes)
  if (extraction.samples.length === 0) throw new Error('音频文件中没有可解码的帧')
  const timescale = extraction.timescale || dash.sampleRate

  // 2) Decode every sample to AudioData.
  const config: AudioDecoderConfig = {
    codec: dash.codec,
    sampleRate: extraction.sampleRate || dash.sampleRate,
    numberOfChannels: extraction.channels,
    ...(extraction.description !== undefined ? { description: extraction.description } : {}),
  }
  const support = await AudioDecoder.isConfigSupported(config)
  if (!support.supported) throw new Error(`此浏览器不支持解码 ${dash.codec} 音频`)
  const decoder = new AudioDecoder({
    output: (data: AudioData) => decodedAudio.push(data),
    error: (error: DOMException) => { decodeError = error },
  })
  decoder.configure(config)
  const decodedAudio: AudioData[] = []
  let decodeError: DOMException | undefined
  for (const sample of extraction.samples) {
    decoder.decode(new EncodedAudioChunk({
      type: sample.is_sync ? 'key' : 'delta',
      timestamp: Math.round(sample.cts * 1_000_000 / timescale),
      duration: Math.round(sample.duration * 1_000_000 / timescale),
      data: sample.data,
    }))
    if (decodeError !== undefined) throw new Error(`音频解码失败：${decodeError.message}`)
    if (decoder.decodeQueueSize > 200) {
      // Backpressure: wait for the decoder to drain before feeding more.
      await new Promise<void>(resolve => {
        const timer = setInterval(() => {
          if (decoder.decodeQueueSize <= 100 || decoder.state === 'closed') {
            clearInterval(timer)
            resolve()
          }
        }, 50)
      })
    }
  }
  await decoder.flush()
  decoder.close()
  if (decodeError !== undefined) throw new Error(`音频解码失败：${decodeError.message}`)

  // 3) Mix every AudioData down to 16 kHz mono, in presentation order.
  decodedAudio.sort((left, right) => left.timestamp - right.timestamp)
  const chunks: Float32Array[] = []
  let total = 0
  let durationUs = 0
  for (const audio of decodedAudio) {
    const frames = audio.numberOfFrames
    const target = new Float32Array(frames)
    // Channel 0 only: mono downmix is unnecessary for ASR.
    audio.copyTo(target, { planeIndex: 0, format: 'f32' })
    audio.close()
    chunks.push(resample(target, extraction.sampleRate || dash.sampleRate, 16_000))
    total += frames
    durationUs += audio.duration ?? 0
    onProgress(durationUs / 1_000_000)
  }
  const pcm = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  return { pcm, durationSeconds: durationUs / 1_000_000 }
}

type Extraction = {
  samples: Array<{ data: Uint8Array; cts: number; dts: number; duration: number; is_sync: boolean }>
  timescale: number
  sampleRate: number
  channels: number
  description: Uint8Array | undefined
}

/** mp4box-driven demux of the DASH m4s audio track. */
function demuxAudio(fileBytes: ArrayBuffer): Promise<Extraction> {
  return new Promise((resolve, reject) => {
    const extraction: Extraction = { samples: [], timescale: 0, sampleRate: 0, channels: 0, description: undefined }
    const file = MP4Box.createFile() as unknown as Mp4FileLike
    type TrackInfo = {
      id: number
      timescale: number
      audio?: { sampleRate?: number; channelCount?: number }
    } & Record<string, unknown>
    file.onReady = ((info: { audioTracks: TrackInfo[] }) => {
      const track = info.audioTracks[0]
      if (track === undefined) {
        reject(new Error('音频文件中没有音轨'))
        return
      }
      extraction.timescale = track.timescale
      extraction.sampleRate = track.audio?.sampleRate ?? 0
      extraction.channels = track.audio?.channelCount ?? 0
      // AAC-specific: the AudioSpecificConfig rides in the esds box as a
      // Uint8Array on the track info.
      const description = (track as Record<string, unknown>).esds
      if (description instanceof Uint8Array) extraction.description = description
      file.setExtractionOptions(track.id, null, { nbSamples: 1000 })
      file.start()
    }) as never
    file.onSamples = ((_trackId: number, _ref: unknown, samples: SampleLike[]) => {
      for (const sample of samples) {
        extraction.samples.push({
          data: new Uint8Array(sample.data),
          cts: sample.cts,
          dts: sample.dts,
          duration: sample.duration,
          is_sync: sample.is_sync,
        })
      }
    }) as never
    file.onFlush = () => resolve(extraction)
    // mp4box requires fileStart = 0 on the buffer it appends.
    const buffer = fileBytes as ArrayBuffer & { fileStart: number }
    buffer.fileStart = 0
    file.appendBuffer(buffer)
    file.flush()
  })
}

/** Linear resample (same helper semantics as the capture path). */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input
  const ratio = from / to
  const outputLength = Math.floor(input.length / ratio)
  const output = new Float32Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const low = Math.min(Math.floor(position), input.length - 1)
    const high = Math.min(low + 1, input.length - 1)
    const fraction = position - low
    output[index] = (input[low] ?? 0) * (1 - fraction) + (input[high] ?? 0) * fraction
  }
  return output
}


