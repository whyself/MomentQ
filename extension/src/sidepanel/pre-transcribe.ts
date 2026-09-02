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
  sampleRate: number
  channels: number
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
 * Resolve the DASH audio via the BACKGROUND service worker: it carries
 * host_permissions for api.bilibili.com, while this panel document's fetch
 * is subject to CORS (the reported "Failed to fetch").
 */
export async function fetchDashAudio(bvid: string, cid: string): Promise<DashAudio> {
  const reply = await chrome.runtime.sendMessage({
    type: 'MOMENTQ_RESOLVE_DASH_AUDIO',
    bvid,
    cid,
  }) as { ok?: unknown; value?: unknown; error?: { message?: unknown } } | null
  if (reply === null || reply.ok !== true || typeof reply.value !== 'object' || reply.value === null) {
    const detail = reply?.error && typeof reply.error.message === 'string' ? reply.error.message : '未知错误'
    throw new Error(`获取音频地址失败：${detail}`)
  }
  const value = reply.value as { baseUrl?: unknown; codec?: unknown }
  if (typeof value.baseUrl !== 'string' || value.baseUrl === '') {
    throw new Error('获取音频地址失败：响应缺少音频流')
  }
  return {
    baseUrl: value.baseUrl,
    codec: typeof value.codec === 'string' ? value.codec : 'mp4a.40.2',
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
): Promise<{ pcm: Float32Array; durationSeconds: number; impliedSampleRate: number }> {
  // 1) Demux: extract AAC description + samples via mp4box.
  const extraction = await demuxAudio(fileBytes)
  if (extraction.samples.length === 0) throw new Error('音频文件中没有可解码的帧')
  // The mp4box track fields (sample_rate, channel_count) are what resample and
  // the decoder config trust; a wrong value there silently stretches the whole
  // timeline (2.756× measured in the field — a 44.1 kHz stream resampled as
  // 16 kHz, every cue 21 min past a 7 min video). The AudioSpecificConfig is
  // the codec's own 2-byte declaration, so cross-check and override on drift.
  const asc = parseAudioSpecificConfig(extraction.description)
  if (asc !== null) {
    if (extraction.sampleRate !== asc.sampleRate) {
      console.warn(`[momentq] 音轨声明 ${extraction.sampleRate || '未知'} Hz，AudioSpecificConfig 为 ${asc.sampleRate} Hz，以后者为准`)
      extraction.sampleRate = asc.sampleRate
    }
    if (extraction.channels !== asc.channels) {
      console.warn(`[momentq] 音轨声明 ${extraction.channels || '未知'} 声道，AudioSpecificConfig 为 ${asc.channels}，以后者为准`)
      extraction.channels = asc.channels
    }
  }
  if (extraction.sampleRate <= 0) extraction.sampleRate = dash.sampleRate
  if (extraction.channels <= 0) extraction.channels = dash.channels
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
    // Batch flush: draining every 500 chunks lets the output callbacks fire
    // while each decoded AudioData is fully alive. Decoding all ~20k chunks
    // before a single flush left the queued outputs reclaimed by the time
    // the copy pass ran (every numberOfFrames read 0 — measured), which
    // silently produced an empty PCM track.
    if (decodedAudio.length % 500 === 0) {
      await decoder.flush().catch(() => {})
    }
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

  // 3) Mix every AudioData down to mono, in presentation order.
  decodedAudio.sort((left, right) => left.timestamp - right.timestamp)
  const chunks: Float32Array[] = []
  let total = 0
  let durationUs = 0
  for (const audio of decodedAudio) {
    const frames = audio.numberOfFrames
    // copyTo sizes the destination in BYTES for f32 (4 per frame) and the
    // allocation must account for the source's channel count — allocating
    // frames*4 for a stereo source still fails because both PLANES count.
    // Allocate from the format's own frame size and read plane 0 only.
    const channels = Math.max(1, audio.numberOfChannels)
    // Measured mix: MOST chunks are f32-planar but SOME are interleaved;
    // a planar multi-channel read on those throws 'Invalid planeIndex'.
    // Branch per chunk, and fall back to channel 0 on any plane error
    // (a stereo half-mix is far better than failing the whole video).
    const planeBytes = audio.allocationSize({ planeIndex: 0, format: 'f32' })
    const plane0 = new Float32Array(planeBytes / 4)
    audio.copyTo(plane0, { planeIndex: 0, format: 'f32' })
    // Measured on real Edge with this decoder: plane 0 requested as f32 on
    // an f32-planar stereo source returns the WHOLE clip INTERLEAVED
    // (2048 floats for 1024 frames), not one plane. Trust the arithmetic —
    // floats === frames * channels means interleaved — and average channel
    // pairs down to exactly `frames` mono samples. Keeping both channels'
    // worth of floats as 'samples' doubled every timestamp (the reported
    // 927s for a 464s video, exact 2x).
    let mono: Float32Array
    if (channels > 1 && plane0.length === frames * channels) {
      mono = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0
        for (let channel = 0; channel < channels; channel += 1) {
          sum += plane0[frame * channels + channel] ?? 0
        }
        mono[frame] = sum / channels
      }
    } else {
      mono = plane0
    }
    audio.close()
    chunks.push(mono)
    total += frames
    durationUs += audio.duration ?? 0
    onProgress(durationUs / 1_000_000)
  }
  // 4) Resample to 16 kHz with a rate derived from OBSERVATION: the decoder's
  // frame count against the media clock (sum of AudioData durations, derived
  // from the chunk timestamps we fed in). Trusting the declared rate (track
  // box or AudioSpecificConfig) is what stretched the timeline 2.756× in the
  // field — the track held its raw 44.1 kHz frame count, re-labelled 16 kHz.
  // The observed ratio yields the true media span regardless of that.
  const mediaSeconds = durationUs / 1_000_000
  const declaredRate = extraction.sampleRate || dash.sampleRate
  let actualRate = declaredRate
  if (mediaSeconds > 0) {
    const implied = total / mediaSeconds
    if (implied > 0 && Math.abs(implied - declaredRate) / declaredRate > 0.05) {
      console.warn(`[momentq] 声明采样率 ${declaredRate} Hz，解码器实际输出 ${Math.round(implied)} Hz，按实际值重采样`)
      actualRate = implied
    }
  }
  if (!(actualRate > 8_000 && actualRate < 96_000)) {
    throw new Error(`无法确定音频采样率（实测 ${Math.round(actualRate)} Hz），不能安全生成字幕`)
  }
  const resampled: Float32Array[] = []
  let resampledTotal = 0
  for (const chunk of chunks) {
    const out = resample(chunk, actualRate, 16_000)
    resampled.push(out)
    resampledTotal += out.length
  }
  // Final consistency: the 16 kHz track must span the same media duration as
  // the media clock — otherwise some rate assumption is wrong and the cues
  // will not match the video (the "every cue 21 min late" failure mode).
  const pcmSeconds = resampledTotal / 16_000
  if (mediaSeconds > 0 && Math.abs(pcmSeconds - mediaSeconds) / mediaSeconds > 0.02) {
    throw new Error(`解码音频时长不一致（${Math.round(pcmSeconds)}s vs 媒体时钟 ${Math.round(mediaSeconds)}s），字幕会与视频错位，请重新运行预识别`)
  }
  const pcm = new Float32Array(resampledTotal)
  let offset = 0
  for (const chunk of resampled) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  return { pcm, durationSeconds: mediaSeconds, impliedSampleRate: actualRate }
}

type Extraction = {
  samples: Array<{ data: Uint8Array; cts: number; dts: number; duration: number; is_sync: boolean }>
  timescale: number
  sampleRate: number
  channels: number
  description: Uint8Array | undefined
}

/**
 * Extract the AAC AudioSpecificConfig (the `description` WebCodecs needs)
 * by scanning the raw bytes for the esds box's DecoderSpecificInfo record
 * (tag 0x05). mp4box does not surface it on the track info. Measured against
 * a real Bilibili m4s: the ASC is 2 bytes (0x1210 = AAC-LC 44.1kHz stereo).
 */
function extractAudioSpecificConfig(bytes: Uint8Array): Uint8Array | undefined {
  const limit = Math.min(bytes.length - 4, 4096)
  for (let index = 4; index < limit; index += 1) {
    if (bytes[index] === 0x65 && bytes[index + 1] === 0x73 && bytes[index + 2] === 0x64 && bytes[index + 3] === 0x73) {
      for (let cursor = index + 4; cursor < index + 64 && cursor < bytes.length - 1; cursor += 1) {
        if (bytes[cursor] === 0x05) {
          const length = bytes[cursor + 1] ?? 0
          if (length > 0 && length < 16) {
            return bytes.slice(cursor + 2, cursor + 2 + length)
          }
          return undefined
        }
      }
      return undefined
    }
  }
  return undefined
}

/**
 * Parse an AAC AudioSpecificConfig (ISO/IEC 13818-7). Bilibili's streams are
 * always the 2-byte form (0x12 0x10 = AAC-LC 44.1 kHz stereo); the result is
 * the codec's own declaration of rate + channel count, authoritative over the
 * mp4box track fields. Returns null on anything that is not a clean LC/HE
 * config (a SBR/PS extension past the first two bytes is fine — the fields
 * we read sit in front of it).
 */
export function parseAudioSpecificConfig(bytes: Uint8Array | undefined): { sampleRate: number; channels: number } | null {
  if (bytes === undefined || bytes.length < 2) return null
  // MSB-first bit reader; the two fields we need are the first 13 bits.
  let cursor = 0
  const next = (bits: number): number => {
    let value = 0
    for (let index = 0; index < bits; index += 1) {
      const byte = bytes[cursor >> 3]
      if (byte === undefined) return 0
      value = (value << 1) | ((byte >> (7 - (cursor & 7))) & 1)
      cursor += 1
    }
    return value
  }
  const objectType = next(5)
  if (objectType !== 2 && objectType !== 5) return null
  const rateIndex = next(4)
  const rates = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350]
  const sampleRate = rateIndex < 13 ? rates[rateIndex] : undefined
  if (sampleRate === undefined) return null
  const channels = next(4)
  if (channels < 1 || channels > 8) return null
  return { sampleRate, channels }
}

/** mp4box-driven demux of the DASH m4s audio track. */
function demuxAudio(fileBytes: ArrayBuffer): Promise<Extraction> {
  return new Promise((resolve, reject) => {
    const extraction: Extraction = { samples: [], timescale: 0, sampleRate: 0, channels: 0, description: undefined }
    // Completion by declared count: mp4box's onFlush never fires for a
    // streamed fMP4 appended in one buffer (verified on a real Bilibili
    // m4s — all samples arrive within seconds, flush hangs forever).
    let expected: number | null = null
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(extraction)
    }
    const file = MP4Box.createFile() as unknown as Mp4FileLike
    type TrackInfo = {
      id: number
      timescale: number
      nb_samples?: number
      audio?: { sample_rate?: number; channel_count?: number }
    }
    file.onReady = ((info: { audioTracks: TrackInfo[] }) => {
      const track = info.audioTracks[0]
      if (track === undefined) {
        reject(new Error('音频文件中没有音轨'))
        return
      }
      extraction.timescale = track.timescale
      extraction.sampleRate = track.audio?.sample_rate ?? 0
      extraction.channels = track.audio?.channel_count ?? 0
      extraction.description = extractAudioSpecificConfig(new Uint8Array(fileBytes))
      expected = track.nb_samples ?? null
      file.setExtractionOptions(track.id, null, { nbSamples: 1000 })
      file.start()
      // Safety net: a truncated stream may never reach the declared count.
      setTimeout(finish, 10_000)
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
      if (expected !== null && extraction.samples.length >= expected) finish()
    }) as never
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


