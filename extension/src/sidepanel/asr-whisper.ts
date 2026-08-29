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

const cacheKeys = new Map<string, Promise<WhisperPipeline>>()

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
    const hubId = MODEL_IDS[model]

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
    // browser provides (or why it refuses) instead of discovering a dead
    // adapter deep inside session creation.
    const probeWebGPU = async (): Promise<{ ok: boolean; detail: string }> => {
      const gpu = (navigator as unknown as {
        gpu?: {
          requestAdapter: () => Promise<{
            requestDevice: () => Promise<{ destroy?: () => void }>
            info?: { vendor?: string; architecture?: string; device?: string }
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
        return { ok: true, detail: label }
      } catch (error) {
        return { ok: false, detail: `初始化失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    // Session creation and WebGPU shader compilation can take minutes on the
    // first run of a large model — bound each stage, narrate it, and fail
    // with the exact stage instead of hanging at "100%".
    const LOAD_TIMEOUT_MS = model === 'large-turbo' ? 600_000 : 180_000
    const withStage = async (stage: string, attempt: () => Promise<WhisperPipeline>): Promise<WhisperPipeline> => {
      onStatus(stage)
      return await Promise.race([
        attempt(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${stage} — 超过 ${Math.round(LOAD_TIMEOUT_MS / 60_000)} 分钟未完成`)), LOAD_TIMEOUT_MS)),
      ])
    }
    const load = async (backendLabel: string, dtype: string | Record<string, string>, device: string): Promise<WhisperPipeline> => {
      const asr = await withStage(`${backendLabel}：加载模型…`, () =>
        module.pipeline('automatic-speech-recognition', hubId, {
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
        onStatus(`使用显卡加速：${gpu.detail}`)
        const asr = await load(`WebGPU · ${gpu.detail}（fp32 编码器 + q4 解码器）`, { encoder_model: 'fp32', decoder_model_merged: 'q4' }, 'webgpu')
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
