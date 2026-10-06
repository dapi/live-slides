// Turns microphone audio into 100 ms chunks of 16 kHz 16-bit mono PCM.
const TARGET_RATE = 16000;
const CHUNK = 1600;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = new Int16Array(CHUNK);
    this.filled = 0;
    this.sumSquares = 0;
    this.step = sampleRate / TARGET_RATE; // 1 when the context already runs at 16 kHz
    this.position = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Linear resampling covers browsers that ignore the requested 16 kHz context rate.
    for (; this.position < input.length; this.position += this.step) {
      const index = Math.floor(this.position);
      const next = Math.min(index + 1, input.length - 1);
      const sample = input[index] + (input[next] - input[index]) * (this.position - index);
      const clamped = Math.max(-1, Math.min(1, sample));
      this.sumSquares += clamped * clamped;
      this.out[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.filled === CHUNK) {
        const pcm = this.out.buffer.slice(0);
        this.port.postMessage({ pcm, level: Math.sqrt(this.sumSquares / CHUNK) }, [pcm]);
        this.filled = 0;
        this.sumSquares = 0;
      }
    }
    this.position -= input.length;
    return true;
  }
}

registerProcessor("pcm", PcmProcessor);
