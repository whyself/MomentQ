/**
 * Local Whisper fallback engine (transformers.js). Loaded lazily on first
 * use; model weights download from the HuggingFace hub on first run and are
 * cached by the browser afterwards. Everything runs inside the side-panel
 * document — no companion, no cloud key, no proxy dependency.
 */

type WhisperPipeline = ((
  audio: Float32Array,
  options: { language?: string; task?: string },
) => Promise<{ text?: string }>)

const MODEL_IDS = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
  'large-turbo': 'onnx-community/whisper-large-v3-turbo',
} as const

export type WhisperModel = keyof typeof MODEL_IDS

// Weight bytes per tier on the WebGPU path (encoder + merged q4 decoder).
// Used for the adapter preflight so an impossible load fails BEFORE a
// multi-GB download, with the exact numbers in the message.
const WEBGPU_WEIGHT_BYTES = {
  base: 260 * 1024 * 1024,
  small: 600 * 1024 * 1024,
  'large-turbo': 1_640 * 1024 * 1024,
} as const

const cacheKeys = new Map<string, Promise<WhisperPipeline>>()

/**
 * The fp32 encoder of whisper-large-v3-turbo ships as ONE 2.55 GB
 * external-data file; reading it allocates a single ArrayBuffer of that
 * size, which no browser page heap survives ("RangeError: Array buffer
 * allocation failed" — confirmed in the wild). The author's reference
 * WebGPU demo (webml-community/whisper-large-v3-turbo-webgpu) therefore
 * uses fp16 for turbo — half the bytes, GPU-native precision, quality
 * neutral — and fp32 for the smaller tiers. Match it exactly.
 */
function webgpuDtype(model: WhisperModel): Record<string, string> {
  return model === 'large-turbo'
    ? { encoder_model: 'fp16', decoder_model_merged: 'q4' }
    : { encoder_model: 'fp32', decoder_model_merged: 'q4' }
}

function describeLoadError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (/Array buffer allocation|out of memory|ArrayBuffer allocation/i.test(raw)) {
    return `${raw} —— 页面内存装不下模型权重。关闭其他标签页/窗口后重试；仍失败请在设置改用较低档位（fp32 完整精度编码器单文件 2.55GB，超出浏览器单页上限，这不是 Bug 而是物理上限）。`
  }
  return raw
}

// Stray rejections from inside transformers.js/ORT escape as "Uncaught (in
// promise)" without ever settling the awaited pipeline call — the exact way
// the OOM first surfaced. While a load (or inference) is active, route any
// unhandled rejection into the pending stage so it fails fast with the real
// reason instead of hanging until the stage timeout.
type ActiveGuard = { onStatus: (status: string) => void; abort: (reason: unknown) => void }
let activeGuard: ActiveGuard | null = null
if (typeof self !== 'undefined' && 'onunhandledrejection' in self) {
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    if (activeGuard === null) return
    const reason = event.reason
    // Only fatal resource failures: unrelated stray promises in the panel
    // (port disconnects, ping races) must not abort a healthy download.
    const fatal = reason instanceof RangeError
      || /Array buffer allocation|out of memory|ArrayBuffer allocation/i.test(
        reason instanceof Error ? reason.message : String(reason))
    if (!fatal) return
    activeGuard.onStatus(`加载异常退出：${describeLoadError(reason)}`)
    activeGuard.abort(reason)
    activeGuard = null
  })
}

/**
 * Lazy pipeline with ORT wasm served from the extension origin. The GPU is
 * probed up front and named; every stage is narrated and bounded; failures
 * report the exact stage and reason. Nothing degrades silently.
 */
export function ensureWhisper(model: WhisperModel, onStatus: (status: string) => void): Promise<WhisperPipeline> {
  const key = `${model}:${'gpu' in navigator ? 'webgpu' : 'wasm'}`
  const cached = cacheKeys.get(key)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const module = await import('@huggingface/transformers') as unknown as {
      env: { allowLocalModels: boolean; backends: { onnx: { wasm: { wasmPaths: string } } } }
      pipeline: (task: 'automatic-speech-recognition', model: string, options: {
        dtype?: string | Record<string, string>
        device?: string
        progress_callback?: (info: { status?: string; file?: string; progress?: number; loaded?: number; total?: number }) => void
      }) => Promise<WhisperPipeline>
    }
    module.env.allowLocalModels = false
    module.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')

    // Multi-file downloads (encoder + decoder + configs): a per-file percent
    // reads "100%" while the largest file is still streaming — the exact
    // "reached 100% but nothing happens" symptom. Aggregate by bytes.
    const files = new Map<string, { loaded: number; total: number }>()
    const progress = (info: { status?: string; file?: string; loaded?: number; total?: number }): void => {
      if (info.status === 'progress' && typeof info.file === 'string'
        && typeof info.loaded === 'number' && typeof info.total === 'number' && info.total > 0) {
        files.set(info.file, { loaded: info.loaded, total: info.total })
        let loaded = 0
        let total = 0
        for (const entry of files.values()) {
          loaded += entry.loaded
          total += entry.total
        }
        const percent = Math.floor((loaded / total) * 100)
        onStatus(`模型下载 ${percent}%（${(loaded / 1024 / 1024).toFixed(0)}/${(total / 1024 / 1024).toFixed(0)} MB · ${files.size} 个文件）`)
      } else if (info.status === 'done' && typeof info.file === 'string') {
        // Never let a per-file notice mask the aggregate: the encoder is the
        // long pole and its absence made "已下载 decoder…" look like a stall.
        let loaded = 0
        let total = 0
        for (const entry of files.values()) {
          loaded += entry.loaded
          total += entry.total
        }
        const percent = total > 0 ? Math.floor((loaded / total) * 100) : 0
        onStatus(`已下载 ${info.file.split('/').pop()} · 整体 ${percent}%（${files.size} 个文件进行中/完成）`)
      }
    }

    // Face the backend head-on: probe the GPU first and say exactly what the
    // browser provides (or why it refuses), INCLUDING the hard limits the
    // load depends on — the fp16 turbo encoder needs a GPU buffer near
    // 1.3 GB and the f16 shader feature. Failing here costs seconds, not a
    // multi-GB download.
    const probeWebGPU = async (): Promise<{
      ok: boolean
      detail: string
      maxBufferBytes?: number | undefined
      hasF16?: boolean | undefined
    }> => {
      const gpu = (navigator as unknown as {
        gpu?: {
          requestAdapter: () => Promise<{
            requestDevice: () => Promise<{ destroy?: () => void }>
            info?: { vendor?: string; architecture?: string; device?: string }
            limits?: { maxBufferSize?: number }
            features?: { has: (feature: string) => boolean }
          } | null>
        }
      }).gpu
      if (gpu === undefined) return { ok: false, detail: '浏览器未暴露 navigator.gpu' }
      try {
        const adapter = await gpu.requestAdapter()
        if (adapter === null) {
          return { ok: false, detail: 'requestAdapter() 返回空（驱动可能禁用了 WebGPU，查看 edge://gpu）' }
        }
        const info = adapter.info ?? {}
        const label = [info.vendor, info.architecture, info.device].filter(Boolean).join(' ') || '未知型号'
        const device = await adapter.requestDevice()
        device.destroy?.()
        return {
          ok: true,
          detail: label,
          maxBufferBytes: adapter.limits?.maxBufferSize,
          hasF16: adapter.features?.has('shader-f16') ?? false,
        }
      } catch (error) {
        return { ok: false, detail: `初始化失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    // Session creation and WebGPU shader compilation can take minutes on the
    // first run of a large model — bound each stage, narrate it, and fail
    // with the exact stage instead of hanging at "100%". The stray-rejection
    // guard races every stage too: an ORT promise that dies unhandled fails
    // the stage immediately with its real reason.
    const stageTimeouts = (stage: string): number => {
      if (model !== 'large-turbo') return stage.includes('下载') || stage.includes('加载') ? 300_000 : 180_000
      // Turbo: the fp16 encoder alone is 1.27 GB — slow proxies need more
      // than the default 10 minutes just to stream it.
      return stage.includes('下载') || stage.includes('加载') ? 1_200_000 : 600_000
    }
    const withStage = async (stage: string, attempt: () => Promise<WhisperPipeline>): Promise<WhisperPipeline> => {
      onStatus(stage)
      const timeoutMs = stageTimeouts(stage)
      let timer: ReturnType<typeof setTimeout> | undefined
      let abortLoad: (reason: unknown) => void = () => {}
      const aborted = new Promise<never>((_, reject) => { abortLoad = reject })
      const previousGuard = activeGuard
      activeGuard = { onStatus, abort: abortLoad }
      try {
        return await new Promise<WhisperPipeline>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${stage} — 超过 ${Math.round(timeoutMs / 60_000)} 分钟未完成`)), timeoutMs)
          void Promise.race([attempt(), aborted]).then(resolve, reject)
        })
      } catch (error) {
        throw new Error(`${stage}失败：${describeLoadError(error)}`)
      } finally {
        clearTimeout(timer)
        activeGuard = previousGuard
      }
    }
    const load = async (backendLabel: string, dtype: string | Record<string, string>, device: string): Promise<WhisperPipeline> => {
      const asr = await withStage(`${backendLabel}：下载/加载模型…`, () =>
        module.pipeline('automatic-speech-recognition', MODEL_IDS[model], {
          dtype, device, progress_callback: progress,
        }))
      await withStage(`${backendLabel}：初始化推理会话（首次编译可能数分钟）…`, async () => {
        await asr(new Float32Array(1_600), { language: 'zh', task: 'transcribe' })
        return asr
      })
      return asr
    }

    if ('gpu' in navigator) {
      onStatus('探测显卡（WebGPU）…')
      const gpu = await probeWebGPU()
      if (gpu.ok) {
        const weightBytes = WEBGPU_WEIGHT_BYTES[model]
        if (gpu.maxBufferBytes !== undefined && gpu.maxBufferBytes < weightBytes) {
          throw new Error(`显卡单缓冲上限 ${(gpu.maxBufferBytes / 1024 / 1024).toFixed(0)} MB，装不下该档权重（约 ${(weightBytes / 1024 / 1024).toFixed(0)} MB）：请在设置改用较低档位，或查看 edge://gpu 确认驱动。`)
        }
        const dtype = webgpuDtype(model)
        const precision = model === 'large-turbo' ? 'fp16 编码器 + q4 解码器（官方参考配置）' : 'fp32 编码器 + q4 解码器'
        if (model === 'large-turbo' && gpu.hasF16 === false) {
          throw new Error('精准档 fp16 编码器需要显卡 shader-f16 特性，当前适配器不支持（edge://gpu 查看）。请改用较低档位。')
        }
        onStatus(`使用显卡加速：${gpu.detail}`)
        const asr = await load(`WebGPU · ${gpu.detail}（${precision}）`, dtype, 'webgpu')
        onStatus(`模型就绪 · 显卡推理（${gpu.detail}）`)
        return asr
      }
      if (model === 'large-turbo') {
        throw new Error(`精准档需要 WebGPU，但当前不可用（${gpu.detail}）。请在 edge://gpu 确认状态或改用较低档位。`)
      }
      onStatus(`WebGPU 不可用（${gpu.detail}），本次改用 CPU 推理`)
    }
    const asr = await load('CPU（q8 量化）', 'q8', 'wasm')
    onStatus('模型就绪 · CPU 推理')
    return asr
  })()
  cacheKeys.set(key, promise)
  void promise.catch(() => cacheKeys.delete(key))
  return promise
}

/** Transcribe one 16 kHz mono chunk to trimmed text. */
export async function transcribeChunk(audio: Float32Array, model: WhisperModel, onStatus: (status: string) => void): Promise<string> {
  const asr = await ensureWhisper(model, onStatus)
  const result = await asr(audio, { language: 'zh', task: 'transcribe' })
  return (result.text ?? '').trim()
}
