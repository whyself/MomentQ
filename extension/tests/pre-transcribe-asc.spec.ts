import { describe, expect, it } from 'vitest'
import { parseAudioSpecificConfig } from '../src/sidepanel/pre-transcribe'

// The AudioSpecificConfig is the codec's own 2-byte declaration of sample
// rate + channel count. A wrong mp4box track field there silently stretched
// the whole transcript timeline 2.756× in the field, so the parser is
// pinned to known-good real-world encodings.
//
// Bit layout (MSB-first), shown for each vector:
//   objectType(5) | frequencyIndex(4) | channelConfiguration(4)
// 0x12 0x10 = 00010010 00010000 → 00010 | 0100 | 0010 → AAC-LC 44100 stereo
describe('parseAudioSpecificConfig', () => {
  it('decodes the real Bilibili DASH stream (0x12 0x10 = AAC-LC 44.1 kHz stereo)', () => {
    expect(parseAudioSpecificConfig(Uint8Array.from([0x12, 0x10]))).toEqual({ sampleRate: 44_100, channels: 2 })
  })

  it('decodes a 48 kHz stereo config (0x11 0x90)', () => {
    // 00010001 10010000 → 00010 | 0011 | 0010 → 48000 Hz (index 3), 2 channels.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x11, 0x90]))).toEqual({ sampleRate: 48_000, channels: 2 })
  })

  it('decodes an explicit 5.1 config from the channel bits (0x12 0x30)', () => {
    // 00010010 00110000 → 00010 | 0100 | 0110 → 44100 Hz (index 4), 6 channels.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x12, 0x30]))).toEqual({ sampleRate: 44_100, channels: 6 })
  })

  it('decodes a 32 kHz stereo config (0x12 0x90)', () => {
    // 00010010 10010000 → 00010 | 0101 | 0010 → 32000 Hz (index 5), 2 channels.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x12, 0x90]))).toEqual({ sampleRate: 32_000, channels: 2 })
  })

  it('rejects a non-audio object type', () => {
    expect(parseAudioSpecificConfig(Uint8Array.from([0x00, 0x10]))).toBeNull()
    expect(parseAudioSpecificConfig(Uint8Array.from([0xff, 0xfe]))).toBeNull()
  })

  it('rejects truncated or missing input', () => {
    expect(parseAudioSpecificConfig(Uint8Array.from([0x12]))).toBeNull()
    expect(parseAudioSpecificConfig(new Uint8Array(0))).toBeNull()
    expect(parseAudioSpecificConfig(undefined)).toBeNull()
  })

  it('rejects out-of-range rate indices and channel counts', () => {
    // rate index 15 = "explicit 24-bit value" escape, not a table entry.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x1f, 0x10]))).toBeNull()
    // channelConfiguration 0 is undefined for these object types.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x13, 0x00]))).toBeNull()
    // channelConfiguration 9+ is reserved.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x12, 0x48]))).toBeNull()
  })
})
