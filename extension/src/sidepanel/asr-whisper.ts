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

/** Lazy pipeline with ORT wasm served from the extension origin. */
export function ensureWhisper(onStatus: (status: string) => void): Promise<WhisperPipeline> {
  pipelinePromise ??= (async () => {
    const module = await import('@huggingface/transformers') as unknown as {
      env: { allowLocalModels: boolean; backends: { onnx: { wasm: { wasmPaths: string } } } }
      pipeline: (task: 'automatic-speech-recognition', model: string, options: {
        dtype?: string | Record<string, string>
        progress_callback?: (info: { status?: string; file?: string; progress?: number }) => void
      }) => Promise<WhisperPipeline>
    }
    // MV3 pages cannot load remote scripts: point the ORT loader at the
    // wasm artifacts bundled under /ort (copied by scripts/copy-ort-assets).
    module.env.allowLocalModels = false
    module.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')
    // Whisper's merged decoder under uniform q8 trips an ORT quantization
    // bug ("Missing required scale ... weight_merged_0_scale"); the
    // documented working split is a float encoder with a q4 merged decoder.
    // Fall back to full fp32 if the hub lacks q4 artifacts for the revision.
    const load = async (dtype: unknown): Promise<WhisperPipeline> =>
      await module.pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
        ...(dtype as { dtype?: unknown }).dtype === undefined ? {} : { dtype: dtype as string | Record<string, string> },
        progress_callback: info => {
          if (info.status === 'progress' && typeof info.progress === 'number'
            && (info.file ?? '').endsWith('.onnx')) {
            onStatus(`本地模型加载 ${Math.round(info.progress)}%`)
          } else if (info.status === 'ready') {
            onStatus('本地模型就绪')
          }
        },
      })
    try {
      return await load({ encoder_model: 'fp32', decoder_model_merged: 'q4' })
    } catch {
      return await load('fp32')
    }
  })()
  return pipelinePromise
}

/** Transcribe one 16 kHz mono chunk to trimmed text. */
export async function transcribeChunk(audio: Float32Array, onStatus: (status: string) => void): Promise<string> {
  const asr = await ensureWhisper(onStatus)
  const result = await asr(audio, { language: 'zh', task: 'transcribe' })
  return (result.text ?? '').trim()
}
