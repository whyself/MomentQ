// MomentQ tab-audio capture worklet (AudioWorklet, classic script).
// Runs inside a 16 kHz AudioContext so the browser resamples tab audio for
// us; the processor only mono-mixes and buffers ~100 ms of samples per
// message to keep postMessage traffic at ~10 frames per second.

class MomentQCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // 1600 samples at 16 kHz = 100 ms of audio.
    this.bufferSize = 1600
    this.buffer = new Float32Array(this.bufferSize)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (input !== undefined && input.length > 0 && (input[0]?.length ?? 0) > 0) {
      const frames = input[0].length
      for (let index = 0; index < frames; index += 1) {
        let mixed = 0
        for (const channel of input) {
          const sample = channel[index]
          if (sample !== undefined) mixed += sample
        }
        this.buffer[this.filled] = mixed
        this.filled += 1
        if (this.filled === this.bufferSize) {
          this.port.postMessage(this.buffer.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('momentq-capture', MomentQCaptureProcessor)
