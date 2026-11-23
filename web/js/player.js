// Mesin audio: 6 track sinkron + metronome yang nempel ke ketukan lagu.
// Semua dijadwalkan pakai jam AudioContext supaya presisi (bukan setTimeout).

const LOOKAHEAD = 0.15; // detik penjadwalan ke depan
const TICK_MS = 25;

export function makeClick(ctx, freq, amp) {
  const len = Math.round(ctx.sampleRate * 0.04);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    const env = Math.exp(-t / 0.009);
    const tone = Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2.01 * t);
    const noise = i < ctx.sampleRate * 0.002 ? (Math.random() * 2 - 1) * 0.5 : 0;
    d[i] = amp * env * (tone * 0.7 + noise);
  }
  return buf;
}

export function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class Player {
  constructor() {
    this.ctx = null;
    this.rate = 0;
    this.buffers = {};
    this.gains = {};
    this.sources = [];
    this.clicks = new Set();
    this.visual = [];
    this.duration = 0;
    this.playing = false;
    this.pos = 0;
    this.startPos = 0;
    this.startCtx = 0;
    this.nextBeat = 0;
    this.timer = null;
    this.tracks = {};
    this.metro = { on: false, vol: 0.8 };
    this.beats = [];
    this.info = [];
    this.onEnded = null;
  }

  async init(rate) {
    if (this.ctx && this.rate === rate) {
      if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
      return;
    }
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.rate = rate;
    this.ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.clickGain = this.ctx.createGain();
    this.clickGain.gain.value = this.metro.vol;
    this.clickGain.connect(this.ctx.destination);
    this.clickBufs = [makeClick(this.ctx, 1760, 1.0), makeClick(this.ctx, 1180, 0.75)];
  }

  unload() {
    this.stopNodes();
    this.playing = false;
    for (const g of Object.values(this.gains)) g.disconnect();
    this.buffers = {};
    this.gains = {};
    this.extra = null;
    this.duration = 0;
    this.pos = 0;
  }

  async load(blobs, onProgress) {
    this.unload();
    const names = Object.keys(blobs);
    let done = 0;
    for (const name of names) {
      const data = await blobs[name].arrayBuffer();
      this.buffers[name] = await this.ctx.decodeAudioData(data);
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.gains[name] = g;
      this.duration = Math.max(this.duration, this.buffers[name].duration);
      onProgress?.(++done / names.length);
    }
    this.applyGains(true);
  }

  // Ringkasan gelombang suara (campuran semua track) untuk digambar.
  peaks(bins) {
    const bufs = Object.values(this.buffers);
    const out = new Float32Array(bins);
    if (!bufs.length) return out;
    const chans = bufs.map((b) => b.getChannelData(0));
    const len = Math.min(...chans.map((c) => c.length));
    const per = len / bins;
    const step = Math.max(1, Math.floor(per / 200));
    let max = 0;
    for (let b = 0; b < bins; b++) {
      const s0 = Math.floor(b * per), s1 = Math.floor((b + 1) * per);
      let peak = 0;
      for (let i = s0; i < s1; i += step) {
        let v = 0;
        for (const c of chans) v += c[i];
        v = Math.abs(v);
        if (v > peak) peak = v;
      }
      out[b] = peak;
      if (peak > max) max = peak;
    }
    if (max > 0) for (let b = 0; b < bins; b++) out[b] /= max;
    return out;
  }

  // Track tambahan (rekaman): mulai di posisi lagu startAt (detik), boleh di tengah lagu.
  setExtra(buffer, startAt = 0) {
    if (!this.gains.take) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.gains.take = g;
    }
    const was = this.playing;
    if (was) this.pause();
    this.extra = buffer ? { buffer, startAt } : null;
    this.applyGains(true);
    if (was) this.play(false);
  }

  setTrack(name, patch) {
    this.tracks[name] = { vol: 1, mute: false, solo: false, ...this.tracks[name], ...patch };
    this.applyGains();
  }

  applyGains(instant = false) {
    if (!this.ctx) return;
    const anySolo = Object.values(this.tracks).some((t) => t.solo);
    for (const [name, g] of Object.entries(this.gains)) {
      const t = this.tracks[name] || { vol: 1 };
      let v = t.mute || (anySolo && !t.solo) ? 0 : t.vol;
      if (name === 'take' && !this.extra) v = 0;
      if (instant) g.gain.value = v;
      else g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
    }
  }

  setMetronome(patch) {
    Object.assign(this.metro, patch);
    if (this.clickGain) this.clickGain.gain.setTargetAtTime(this.metro.vol, this.ctx.currentTime, 0.01);
  }

  // times = detik tiap ketukan; info[i] = {bar, beat (0 = ketukan "1"), beats (panjang bar), ...}
  setGrid(times, info) {
    this.beats = times;
    this.info = info;
    if (this.playing) {
      const horizon = this.startPos + (this.ctx.currentTime + LOOKAHEAD - this.startCtx);
      this.nextBeat = lowerBound(beats, horizon);
    }
  }

  inBar(i) {
    return this.info?.[i]?.beat ?? 0;
  }

  barLength(i) {
    return this.info?.[i]?.beats ?? 4;
  }

  periodAt(i) {
    const b = this.beats;
    if (i + 1 < b.length && i >= 0) return b[i + 1] - b[i];
    if (i > 0 && i < b.length) return b[i] - b[i - 1];
    return 0.5;
  }

  get position() {
    if (!this.playing) return this.pos;
    const t = this.startPos + (this.ctx.currentTime - this.startCtx);
    return Math.min(Math.max(t, this.startPos), this.duration);
  }

  get countingIn() {
    return this.playing && this.ctx.currentTime < this.startCtx;
  }

  async play(countIn = false) {
    if (this.playing || !this.duration) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    let p = this.pos;
    if (p >= this.duration - 0.05) p = 0;

    const now = this.ctx.currentTime + 0.08;
    const idx = lowerBound(this.beats, p - 0.002);
    let startCtx = now;
    if (countIn && idx < this.beats.length) {
      // Hitungan masuk: selalu 1 bar penuh "1-2-3-4" dengan tempo di posisi mulai.
      const per = this.periodAt(idx);
      const n = this.barLength(idx);
      for (let j = 0; j < n; j++) this.scheduleClick(now + j * per, j, true, -1, n);
      startCtx = Math.max(now, now + n * per - (this.beats[idx] - p));
    }

    this.startPos = p;
    this.startCtx = startCtx;
    for (const [name, buf] of Object.entries(this.buffers)) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gains[name]);
      src.start(startCtx, p);
      this.sources.push(src);
    }
    if (this.extra && this.gains.take) {
      const q = p - this.extra.startAt;
      if (q < this.extra.buffer.duration) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.extra.buffer;
        src.connect(this.gains.take);
        if (q >= 0) src.start(startCtx, q); else src.start(startCtx - q, 0);
        this.sources.push(src);
      }
    }
    this.nextBeat = idx;
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const ahead = now + LOOKAHEAD;
    while (this.nextBeat < this.beats.length) {
      const i = this.nextBeat;
      const t = this.startCtx + (this.beats[i] - this.startPos);
      if (t > ahead) break;
      if (t >= now - 0.02) {
        if (this.metro.on) this.scheduleClick(t, this.inBar(i), false, i, this.barLength(i));
        else this.visual.push({ t, n: this.inBar(i), count: false, i, len: this.barLength(i) });
      }
      this.nextBeat++;
    }
    if (this.position >= this.duration - 0.005) {
      this.stopNodes();
      this.playing = false;
      this.pos = 0;
      this.onEnded?.();
    }
  }

  scheduleClick(t, n, count, i = -1, len = 4) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.clickBufs[n === 0 ? 0 : 1];
    src.connect(this.clickGain);
    src.start(t);
    src.onended = () => this.clicks.delete(src);
    this.clicks.add(src);
    this.visual.push({ t, n, count, i, len });
  }

  // Ketukan yang sedang terdengar sekarang (untuk lampu indikator).
  currentBeat() {
    if (!this.playing) return null;
    const heard = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    let cur = null;
    while (this.visual.length && this.visual[0].t <= heard) cur = this.visual.shift();
    if (cur) this.lastBeat = cur;
    return this.lastBeat || null;
  }

  stopNodes() {
    clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sources) { try { s.stop(); } catch { /* sudah berhenti */ } s.disconnect(); }
    for (const s of this.clicks) { try { s.stop(); } catch { /* sudah berhenti */ } s.disconnect(); }
    this.sources = [];
    this.clicks.clear();
    this.visual = [];
    this.lastBeat = null;
  }

  pause() {
    if (!this.playing) return;
    this.pos = this.position;
    this.stopNodes();
    this.playing = false;
  }

  seek(t) {
    const was = this.playing;
    if (was) { this.stopNodes(); this.playing = false; }
    this.pos = Math.min(Math.max(t, 0), this.duration);
    if (was) this.play(false);
  }
}
