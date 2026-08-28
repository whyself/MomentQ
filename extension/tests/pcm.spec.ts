import { describe, expect, it } from 'vitest'
import { floatToInt16, int16ToBuffer, isSilent, resampleLinear, rmsOf, SILENCE_RMS_THRESHOLD } from '../src/offscreen/pcm'

function constant(samples: number, value: number): Float32Array {
  return new Float32Array(samples).fill(value)
}

describe('offscreen PCM helpers', () => {
  it('detects silence below the RMS threshold and sound above it', () => {
    expect(rmsOf(new Float32Array(1600))).toBe(0)
    expect(isSilent(constant(1600, 0.00001))).toBe(true)
    expect(SILENCE_RMS_THRESHOLD).toBeLessThan(0.001)
    expect(isSilent(constant(1600, 0.05))).toBe(false)
  })

  it('converts float samples to 16-bit PCM with clamping', () => {
    const converted = floatToInt16(new Float32Array([0, 0.5, -0.5, 2, -2]))
    expect([...converted]).toEqual([0, 16384, -16384, 32767, -32768])
  })

  it('serializes 16-bit samples as little-endian bytes', () => {
    const bytes = int16ToBuffer(new Int16Array([1, -1, 256]))
    expect([...bytes]).toEqual([1, 0, 255, 255, 0, 1])
  })

  it('resamples linearly only when rates differ', () => {
    const samples = new Float32Array([0, 1, 2, 3])
    expect(resampleLinear(samples, 16_000, 16_000)).not.toBe(samples)
    expect([...resampleLinear(samples, 16_000, 16_000)]).toEqual([0, 1, 2, 3])
    // Halving the output rate keeps every other sample.
    const down = resampleLinear(samples, 32_000, 16_000)
    expect(down.length).toBe(2)
    expect(down[0]).toBeCloseTo(0)
    expect(down[down.length - 1]).toBeCloseTo(2)
    expect(resampleLinear(new Float32Array(0), 48_000, 16_000).length).toBe(0)
    expect(resampleLinear(samples, 0, 16_000).length).toBe(0)
  })
})
