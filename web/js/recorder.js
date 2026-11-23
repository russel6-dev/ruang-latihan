// Perekam: input dari USB interface (mis. M-VAVE Pocket Amp) atau mic HP.
// Semua waktu memakai jam AudioContext yang sama dengan pemutar lagu, jadi rekaman bisa sinkron presisi.

import { makeClick } from './player.js';

export class Recorder {
  constructor(player) {
    this.player = player;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.onMeter = null;
    this.capturing = null; // { resolveStart, chunks, frames, onChunk }
  }

  get ctx() { return this.player.ctx; }

  // Buka input. Fitur HP yang merusak suara musik (peredam bising/gema, volume otomatis) dimatikan.
  async open() {
    if (this.stream && this.stream.getAudioTracks()[0]?.readyState === 'live') return this.info();
    await this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        sampleRate: { ideal: this.ctx.sampleRate },
      },
    });
    if (!this.workletReady) {
      await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
      this.workletReady = true;
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max' });
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // tidak diputar balik (monitoring langsung dari ampli/Pocket Amp)
    this.source.connect(this.node).connect(sink).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    return this.info();
  }

  info() {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return null;
    const s = track.getSettings ? track.getSettings() : {};
    return {
      label: track.label || 'Input audio',
      sampleRate: s.sampleRate || null,
      channels: s.channelCount || null,
      processingOff: !(s.echoCancellation || s.noiseSuppression || s.autoGainControl),
      processing: { echo: !!s.echoCancellation, noise: !!s.noiseSuppression, agc: !!s.autoGainControl },
    };
  }

  async close() {
    try { this.source?.disconnect(); this.node?.disconnect(); } catch { /* sudah putus */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node = null;
    this.source = null;
  }

  onMessage(d) {
    if (d.meter !== undefined) this.onMeter?.(d.meter);
    const c = this.capturing;
    if (!c) return;
    if (d.startFrame !== undefined) c.startFrame = d.startFrame;
    if (d.chunk) { c.frames += d.chunk[0].length; c.onChunk?.(d.chunk); }
    if (d.stopped) c.resolveStop?.();
  }

  // Mulai menangkap. onChunk(channels: Float32Array[]) dipanggil tiap ±0,4 detik.
  startCapture(onChunk) {
    this.capturing = { frames: 0, startFrame: null, onChunk };
    this.node.port.postMessage('start');
  }

  async stopCapture() {
    const c = this.capturing;
    if (!c) return null;
    await new Promise((resolve) => { c.resolveStop = resolve; this.node.port.postMessage('stop'); setTimeout(resolve, 1500); });
    this.capturing = null;
    return { startFrame: c.startFrame, frames: c.frames };
  }

  // Tangkap sementara ke memori (dipakai cek loopback & kalibrasi).
  async captureFor(seconds, during) {
    const chunks = [];
    this.startCapture((ch) => chunks.push(ch[0]));
    await during?.();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { startFrame, frames } = await this.stopCapture();
    const data = new Float32Array(frames);
    let o = 0;
    for (const ch of chunks) { data.set(ch.subarray(0, Math.min(ch.length, frames - o)), o); o += ch.length; }
    return { data, startTime: (startFrame ?? 0) / this.ctx.sampleRate };
  }

  // Cek apakah suara dari HP ikut masuk ke input (LOOPBACK Pocket Amp nyala, atau speaker HP kedengeran mic).
  async checkLoopback() {
    const ctx = this.ctx;
    const f = 997;
    let toneStart = 0;
    const res = await this.captureFor(1.0, async () => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = f;
      g.gain.value = 0.25;
      osc.connect(g).connect(ctx.destination);
      toneStart = ctx.currentTime + 0.35;
      osc.start(toneStart);
      osc.stop(toneStart + 0.4);
    });
    const sr = ctx.sampleRate;
    const at = (t) => Math.max(0, Math.round((t - res.startTime) * sr));
    const before = goertzel(res.data, at(res.startTime + 0.05), at(toneStart - 0.05), f, sr);
    const during = goertzel(res.data, at(toneStart + 0.1), at(toneStart + 0.35), f, sr);
    const ratio = during / (before + 1e-12);
    return { detected: during > 1e-5 && ratio > 30, level: Math.sqrt(during) };
  }

  // Kalibrasi delay: bunyikan 8 klik, cari kapan masing-masing masuk lagi ke input.
  // method 'loopback' (Pocket Amp LOOPBACK nyala) atau 'tap' (ketuk senar diredam bareng klik).
  async calibrate(method, onTick) {
    const ctx = this.ctx;
    const n = 8;
    const gap = 0.6;
    const click = makeClick(ctx, 1760, 1.0);
    const times = [];
    const res = await this.captureFor(0.8 + n * gap + 0.6, async () => {
      const t0 = ctx.currentTime + 0.8;
      for (let k = 0; k < n; k++) {
        const s = ctx.createBufferSource();
        s.buffer = click;
        s.connect(ctx.destination);
        s.start(t0 + k * gap);
        times.push(t0 + k * gap);
        setTimeout(() => onTick?.(k + 1, n), (t0 + k * gap - ctx.currentTime) * 1000);
      }
    });
    const sr = ctx.sampleRate;
    const d = res.data;
    // amplop kasar (abs)
    let noise = 0;
    const pre = Math.min(d.length, Math.round(0.5 * sr));
    for (let i = 0; i < pre; i++) noise = Math.max(noise, Math.abs(d[i]));
    const delays = [];
    for (const t of times) {
      const a = Math.round((t - res.startTime) * sr);
      const b = Math.min(d.length, a + Math.round((method === 'tap' ? 0.45 : 0.35) * sr));
      if (a < 0 || a >= d.length) continue;
      let peak = 0;
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(d[i]));
      if (peak < Math.max(0.01, noise * 4)) continue;
      const thr = Math.max(noise * 3, peak * 0.3);
      for (let i = a; i < b; i++) {
        if (Math.abs(d[i]) >= thr) { delays.push((i - a) / sr); break; }
      }
    }
    if (delays.length < 5) return { ok: false, found: delays.length, n };
    delays.sort((x, y) => x - y);
    const med = delays[delays.length >> 1];
    const spread = delays[delays.length - 2] - delays[1];
    const limit = method === 'tap' ? 0.06 : 0.01;
    return { ok: spread <= limit, latency: med, spread, found: delays.length, n };
  }
}

function goertzel(data, from, to, f, sr) {
  to = Math.min(to, data.length);
  if (to - from < 64) return 0;
  const w = (2 * Math.PI * f) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = data[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / ((to - from) ** 2);
}

// ---------------- penulis WAV bertahap (disimpan ke HP selama merekam)

export class TakeWriter {
  constructor(channels, sampleRate, saveChunk) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.saveChunk = saveChunk; // async (index, blob)
    this.pending = [];
    this.pendingFrames = 0;
    this.index = 0;
    this.frames = 0;
    this.saving = Promise.resolve();
  }

  push(chs) {
    const nch = this.channels;
    const len = chs[0].length;
    const out = new Int16Array(len * nch);
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nch; c++) {
        const v = Math.max(-1, Math.min(1, (chs[c] || chs[0])[i]));
        out[i * nch + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    this.pending.push(out);
    this.pendingFrames += len;
    this.frames += len;
    if (this.pendingFrames >= this.sampleRate * 3) this.flush();
  }

  flush() {
    if (!this.pending.length) return this.saving;
    const blob = new Blob(this.pending, { type: 'application/octet-stream' });
    const idx = this.index++;
    this.pending = [];
    this.pendingFrames = 0;
    this.saving = this.saving.then(() => this.saveChunk(idx, blob));
    return this.saving;
  }

  async finish() {
    await this.flush();
    return this.index;
  }
}

export function wavHeader(frames, channels, sampleRate) {
  const view = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  const bytes = frames * channels * 2;
  str(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, bytes, true);
  return new Blob([view]);
}

// ---------------- kamera

export function pickVideoMime() {
  const prefs = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return prefs.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

export function pickCameraMime() {
  const prefs = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return prefs.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

export async function openCamera(facing, quality) {
  const long = quality === '720' ? 1280 : 1920;
  const short = quality === '720' ? 720 : 1080;
  // Minta portrait; HP biasanya memberi frame tegak saat dipegang tegak.
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing === 'back' ? 'environment' : 'user', width: { ideal: short }, height: { ideal: long }, frameRate: { ideal: 30 } },
  });
}
