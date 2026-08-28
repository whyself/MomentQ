/**
 * Pure PCM helpers for the offscreen capture pipeline. The AudioContext is
 * created at 16 kHz so the browser already resamples; these helpers cover
 * silence gating and Float32 → Int16 conversion before the WebSocket send.
 */

/** RMS below this is treated as silence (pause, muted tab, dead air). */
export const SILENCE_RMS_THRESHOLD = 1e-4

export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let total = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0
    total += value * value
  }
  return Math.sqrt(total / samples.length)
}

export function isSilent(samples: Float32Array, threshold = SILENCE_RMS_THRESHOLD): boolean {
  return rmsOf(samples) < threshold
}

/** Convert float samples in [-1, 1] to little-endian 16-bit PCM. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    output[index] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
  }
  return output
}

export function int16ToBuffer(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = samples.length * 2
  const output = new Uint8Array(bytes)
  const view = new DataView(output.buffer)
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true)
  }
  return output
}

/**
 * Linear-interpolation resampler used only when the browser refuses to run
 * the capture AudioContext at 16 kHz. Chunk boundaries introduce tiny
 * discontinuities, so this is a fallback, not the primary path.
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) return new Float32Array(0)
  if (fromRate === toRate || samples.length === 0) return samples.slice()
  const ratio = fromRate / toRate
  const outputLength = Math.max(0, Math.floor(samples.length / ratio))
  const output = new Float32Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const lower = Math.floor(position)
    const upper = Math.min(samples.length - 1, lower + 1)
    const weight = position - lower
    output[index] = (samples[lower] ?? 0) * (1 - weight) + (samples[upper] ?? 0) * weight
  }
  return output
}
