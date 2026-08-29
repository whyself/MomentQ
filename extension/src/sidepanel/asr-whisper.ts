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

let pipelinePromise: Promise<WhisperPipeline> | undefined

const MODEL_IDS = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
  'large-turbo': 'onnx-community/whisper-large-v3-turbo',
} as const

export type WhisperModel = keyof typeof MODEL_IDS

const cacheKeys = new Map<string, Promise<WhisperPipeline>>()

/**
 * Lazy pipeline with ORT wasm served from the extension origin. Prefers the
 * WebGPU backend when the browser exposes one (large models are only
 * practical there) and falls back to WASM q8 → WASM fp32. A warm-up
 * inference on silence forces ORT session creation inside the fallback
 * chain, so quantization incompatibilities surface at load time.
 */
export function ensureWhisper(model: WhisperModel, onStatus: (status: string) => void): Promise<WhisperPipeline> {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator
  const key = `${model}:${hasWebGPU ? 'webgpu' : 'wasm'}`
  const cached = cacheKeys.get(key)
  if (cached !== undefined) return cached
  const promise = (async () => {
    const module = await import('@huggingface/transformers') as unknown as {
      env: { allowLocalModels: boolean; backends: { onnx: { wasm: { wasmPaths: string } } } }
      pipeline: (task: 'automatic-speech-recognition', model: string, options: {
        dtype?: string | Record<string, string>
        device?: string
        progress_callback?: (info: { status?: string; file?: string; progress?: number }) => void
      }) => Promise<WhisperPipeline>
    }
    module.env.allowLocalModels = false
    module.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')
    const hubId = MODEL_IDS[model]
    const progress = (info: { status?: string; file?: string; progress?: number }): void => {
      if (info.status === 'progress' && typeof info.progress === 'number'
        && (info.file ?? '').endsWith('.onnx')) {
        onStatus(`本地模型加载 ${Math.round(info.progress)}%`)
      } else if (info.status === 'ready') {
        onStatus('本地模型就绪')
      }
    }
    const load = async (dtype: string | Record<string, string>, device: string): Promise<WhisperPipeline> => {
      const asr = await module.pipeline('automatic-speech-recognition', hubId, {
        dtype, device, progress_callback: progress,
      })
      await asr(new Float32Array(1_600), { language: 'zh', task: 'transcribe' })
      return asr
    }
    if (hasWebGPU) {
      onStatus('检测到 WebGPU，优先使用显卡加速')
      try {
        return await load({ encoder_model: 'fp32', decoder_model_merged: 'q4' }, 'webgpu')
      } catch {
        try {
          return await load('fp32', 'webgpu')
        } catch {
          onStatus('WebGPU 不可用，回退 CPU 推理')
        }
      }
    }
    try {
      return await load('q8', 'wasm')
    } catch {
      return await load('fp32', 'wasm')
    }
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
