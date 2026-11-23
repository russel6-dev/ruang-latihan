// Penangkap suara input per sampel, dengan nomor frame AudioContext (untuk sinkron presisi).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.started = false;
    this.chunks = [];
    this.count = 0;
    this.peak = 0;
    this.meterFrames = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.on = true;
        this.started = false;
      } else if (e.data === 'stop') {
        this.flush();
        this.on = false;
        this.port.postMessage({ stopped: true });
      }
    };
  }

  flush() {
    if (!this.count) return;
    const nch = this.chunks[0].length;
    const out = [];
    for (let c = 0; c < nch; c++) {
      const a = new Float32Array(this.count);
      let o = 0;
      for (const ch of this.chunks) { a.set(ch[c], o); o += ch[c].length; }
      out.push(a);
    }
    this.port.postMessage({ chunk: out }, out.map((a) => a.buffer));
    this.chunks = [];
    this.count = 0;
  }

  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length && inp[0].length) {
      const len = inp[0].length;
      for (let c = 0; c < inp.length; c++) {
        const d = inp[c];
        for (let i = 0; i < len; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > this.peak) this.peak = v; }
      }
      this.meterFrames += len;
      if (this.meterFrames >= 2048) {
        this.port.postMessage({ meter: this.peak });
        this.peak = 0;
        this.meterFrames = 0;
      }
      if (this.on) {
        if (!this.started) {
          this.started = true;
          this.port.postMessage({ startFrame: currentFrame });
        }
        this.chunks.push(Array.from(inp, (d) => d.slice()));
        this.count += len;
        if (this.count >= 16384) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
