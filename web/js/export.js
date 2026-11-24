// Ekspor audio di HP: klik saja, sequencer saja, sesuai mixer, atau klik kiri + SQ kanan.
import { makeClick } from './player.js';

export const KINDS = {
  click: 'Klik',
  sq: 'SQ',
  mix: 'Mix',
  lr: 'Klik L + SQ R',
  cover: 'Cover',
  take: 'Rekaman',
};

/**
 * @param {object} o
 * @param {Object<string, AudioBuffer>} o.buffers  track hasil pemisahan
 * @param {Object<string, number>} o.gains        volume per track (0 = tidak ikut)
 * @param {{times:number[], info:object[]}} o.grid ketukan klik
 * @param {'click'|'sq'|'mix'|'lr'} o.kind
 * @param {boolean} o.withClick   (kind 'mix') sertakan klik
 * @param {boolean} o.countIn     tambah 1 bar hitungan di awal file
 * @param {number} o.clickVol
 * @param {number} o.duration
 * @param {(p:number)=>void} o.onProgress
 * @returns {Promise<AudioBuffer>}
 */
export async function renderMix(o) {
  const sr = 44100;
  const { times, info } = o.grid;

  // Hitungan masuk di awal file: 1 bar penuh, berakhir tepat 1 ketukan sebelum ketukan pertama lagu.
  let preroll = 0;
  const countClicks = [];
  if (o.countIn && times.length > 1) {
    const per = times[1] - times[0];
    const n = info[0].beats || 4;
    preroll = Math.max(0, n * per - times[0]);
    for (let k = 0; k < n; k++) countClicks.push({ t: preroll + times[0] - (n - k) * per, accent: k === 0 });
  }

  const wantClick = o.kind === 'click' || o.kind === 'lr' || (o.kind === 'mix' && o.withClick);
  const wantStems = o.kind !== 'click';
  const channels = o.kind === 'click' ? 1 : 2;
  const length = Math.ceil((preroll + o.duration + 0.5) * sr);
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate: sr });

  let clickOut, stemOut;
  if (o.kind === 'lr') {
    // kiri = klik, kanan = sequencer (mono)
    const merger = ctx.createChannelMerger(2);
    merger.connect(ctx.destination);
    clickOut = ctx.createGain();
    clickOut.channelCount = 1;
    clickOut.channelCountMode = 'explicit';
    clickOut.connect(merger, 0, 0);
    stemOut = ctx.createGain();
    stemOut.channelCount = 1;
    stemOut.channelCountMode = 'explicit';
    stemOut.channelInterpretation = 'speakers';
    stemOut.connect(merger, 0, 1);
  } else {
    clickOut = ctx.createGain();
    clickOut.connect(ctx.destination);
    stemOut = ctx.createGain();
    stemOut.connect(ctx.destination);
  }

  if (wantStems) {
    for (const [name, buf] of Object.entries(o.buffers)) {
      const g = o.gains[name] || 0;
      if (g <= 0) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = g;
      src.connect(gain).connect(stemOut);
      src.start(preroll);
    }
  }

  if (wantStems) {
    for (const x of o.extras || []) {
      if (!(x.gain > 0)) continue;
      const src = ctx.createBufferSource();
      src.buffer = x.buffer;
      const gain = ctx.createGain();
      gain.gain.value = x.gain;
      src.connect(gain);
      if (o.kind === 'lr') gain.connect(stemOut);
      else { const pan = ctx.createStereoPanner(); pan.pan.value = x.pan || 0; gain.connect(pan).connect(stemOut); }
      const at = preroll + x.startAt;
      if (at >= 0) src.start(at); else src.start(0, -at);
    }
  }

  if (wantClick || countClicks.length) {
    const accent = makeClick(ctx, 1760, 1.0);
    const normal = makeClick(ctx, 1180, 0.75);
    clickOut.gain.value = o.kind === 'mix' ? o.clickVol : 0.9;
    const play = (t, isAccent) => {
      if (t < 0) return;
      const s = ctx.createBufferSource();
      s.buffer = isAccent ? accent : normal;
      s.connect(clickOut);
      s.start(t);
    };
    for (const c of countClicks) play(c.t, c.accent);
    if (wantClick) times.forEach((t, i) => play(preroll + t, info[i].beat === 0));
  }

  // Laporan progress: hentikan sementara tiap ~5 detik audio.
  const total = length / sr;
  for (let t = 5; t < total; t += 5) {
    ctx.suspend(t).then(() => { o.onProgress?.(t / total); ctx.resume(); });
  }
  const out = await ctx.startRendering();
  normalize(out);
  return out;
}

function normalize(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  if (peak > 0.98) {
    const k = 0.98 / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
}

export function toWav(buf) {
  const nch = buf.numberOfChannels;
  const len = buf.length;
  const bytes = 44 + len * nch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nch, true);
  view.setUint32(24, buf.sampleRate, true); view.setUint32(28, buf.sampleRate * nch * 2, true);
  view.setUint16(32, nch * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, len * nch * 2, true);
  const chans = Array.from({ length: nch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

export function toMp3(buf, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3worker.js', import.meta.url));
    const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) onProgress?.(e.data.progress);
      if (e.data.done) { worker.terminate(); resolve(e.data.blob); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Encoder MP3 gagal')); };
    worker.postMessage({ channels, sampleRate: buf.sampleRate, kbps: buf.numberOfChannels > 1 ? 192 : 128 },
      channels.map((c) => c.buffer));
  });
}

export function estimateSize(kind, format, duration) {
  const ch = kind === 'click' ? 1 : 2;
  const secs = duration + 3;
  const bytes = format === 'wav' ? secs * 44100 * 2 * ch : secs * (ch > 1 ? 192 : 128) * 125;
  return bytes / 1048576;
}


// ---------------------------------------------------------------- cover

function rms(buf, from, to) {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  let sum = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    // abaikan bagian diam (supaya jeda tidak menurunkan rata-rata)
    for (let i = a; i < b; i += 4) { const v = d[i]; if (Math.abs(v) > 0.003) { sum += v * v; n++; } }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function reverbIR(ctx, seconds = 1.8) {
  const len = Math.round(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let seed = 1234 + c * 999;
    for (let i = 0; i < len; i++) {
      seed = (seed * 16807) % 2147483647;
      const r = seed / 2147483647 * 2 - 1;
      d[i] = r * Math.pow(1 - i / len, 3.2);
    }
  }
  return ir;
}

/**
 * Cover: take-take kamu menggantikan track asli sesuai labelnya, plus backing sisanya.
 * o = { buffers (track asli; {} untuk "rekaman saja"), takes: [{buffer, startAt, gain, pan, role}],
 *       from, to, otherLevel, autoBalance, compressor, reverb, fadeIn, fadeOut, onProgress }
 * role: 'guitar' | 'bass' | 'vocals' | 'drums' | 'piano' | 'other' (menggantikan track itu) | 'extra' (tambahan)
 */
export async function renderCover(o) {
  const sr = 44100;
  const from = o.from, to = o.to;
  const len = Math.max(1, to - from);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(len * sr), sampleRate: sr });
  const master = ctx.createGain();
  master.connect(ctx.destination);

  const place = (buffer, startAt, node) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(node);
    const at = startAt - from; // posisi di file hasil
    if (at >= 0) src.start(at); else if (-at < buffer.duration) src.start(0, -at);
  };

  const replaced = new Set(o.takes.map((t) => t.role).filter((r) => r && r !== 'extra'));
  for (const [name, buf] of Object.entries(o.buffers)) {
    if (replaced.has(name)) continue;
    const g = ctx.createGain();
    g.gain.value = name === 'other' ? o.otherLevel : 1;
    if (g.gain.value <= 0) continue;
    g.connect(master);
    place(buf, 0, g);
  }

  let rev = null;
  const reverbBus = () => {
    if (!rev) {
      const conv = ctx.createConvolver();
      conv.buffer = reverbIR(ctx);
      rev = ctx.createGain();
      rev.gain.value = 1;
      rev.connect(conv).connect(master);
    }
    return rev;
  };

  const balances = [];
  for (const t of o.takes) {
    // Seimbangkan dengan track asli yang digantikan (gitar tambahan: dibandingkan ke gitar asli).
    let balance = 1;
    const refName = t.role === 'extra' ? 'guitar' : t.role;
    if (o.autoBalance && o.buffers[refName]) {
      const a = Math.max(from, t.startAt), b = Math.min(to, t.startAt + t.buffer.duration);
      const ref = rms(o.buffers[refName], a, b);
      const mine = rms(t.buffer, a - t.startAt, b - t.startAt);
      if (ref > 0 && mine > 0) balance = Math.min(8, Math.max(0.1, ref / mine));
      if (t.role === 'extra') balance *= 0.8;
    }
    balances.push(balance);
    const vocal = t.role === 'vocals';
    const tg = ctx.createGain();
    tg.gain.value = balance * (t.gain ?? 1);
    let chain = tg;
    if (vocal) {
      // buang dengung rendah (AC, kipas, getaran meja)
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7;
      chain.connect(hp);
      chain = hp;
    }
    if (o.compressor) {
      const comp = ctx.createDynamicsCompressor();
      if (vocal) { comp.threshold.value = -24; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.12; }
      else { comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.18; }
      comp.knee.value = 8;
      const makeup = ctx.createGain();
      makeup.gain.value = vocal ? 1.6 : 1.35;
      chain.connect(comp).connect(makeup);
      chain = makeup;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = t.pan || 0;
    chain.connect(pan).connect(master);
    if (o.reverb) {
      const send = ctx.createGain();
      send.gain.value = vocal ? 0.22 : 0.16;
      pan.connect(send).connect(reverbBus());
    }
    place(t.buffer, t.startAt, tg);
  }

  // Fade
  const fi = o.fadeIn ? Math.min(1.5, len / 4) : 0;
  const fo = o.fadeOut ? Math.min(3, len / 3) : 0;
  master.gain.setValueAtTime(fi ? 0 : 1, 0);
  if (fi) master.gain.linearRampToValueAtTime(1, fi);
  if (fo) { master.gain.setValueAtTime(1, len - fo); master.gain.linearRampToValueAtTime(0, len); }

  for (let t = 5; t < len; t += 5) ctx.suspend(t).then(() => { o.onProgress?.(t / len); ctx.resume(); });
  const out = await ctx.startRendering();
  loudness(out);
  return { buffer: out, balances };
}

// Volume akhir standar sosmed (±-14 LUFS, dikira-kira dari RMS) tanpa pecah.
function loudness(buf) {
  let sum = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 2) { sum += d[i] * d[i]; n++; }
  }
  const r = Math.sqrt(sum / Math.max(1, n));
  if (!r) return;
  const g = Math.pow(10, -15 / 20) / r;
  const ceiling = 0.97;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      let v = d[i] * g;
      const a = Math.abs(v);
      if (a > 0.9) v = Math.sign(v) * (0.9 + (ceiling - 0.9) * Math.tanh((a - 0.9) / (ceiling - 0.9)));
      d[i] = v;
    }
  }
}

// ---------------------------------------------------------------- video cover (MP4, split screen)

// Kotak-kotak untuk 1–4 video di layar vertikal.
export function layoutRects(n, W, H) {
  const h2 = H / 2, w2 = W / 2;
  if (n <= 1) return [[0, 0, W, H]];
  if (n === 2) return [[0, 0, W, h2], [0, h2, W, h2]];
  if (n === 3) return [[0, 0, W, h2], [0, h2, w2, h2], [w2, h2, w2, h2]];
  return [[0, 0, w2, h2], [w2, 0, w2, h2], [0, h2, w2, h2], [w2, h2, w2, h2]];
}

/**
 * Rakit video: 1–4 rekaman kamera (split screen) + audio cover. Berjalan real-time (selama durasi klip).
 * o = { videos: [{blob, startAt (posisi lagu saat detik 0 video), label}], showLabels,
 *       from, audio (AudioBuffer cover mulai dari 'from'), mime, size: {w,h}, onProgress }
 */
export async function composeVideo(o) {
  const vids = [];
  for (const v of o.videos.slice(0, 4)) {
    const url = URL.createObjectURL(v.blob);
    const el = document.createElement('video');
    el.src = url;
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('Video rekaman nggak bisa dibuka')); });
    const vt0 = o.from - v.startAt; // detik video saat klip mulai
    el.currentTime = Math.max(0, vt0);
    await new Promise((res) => { el.onseeked = res; setTimeout(res, 3000); });
    vids.push({ el, url, vt0, label: v.label });
  }

  const canvas = document.createElement('canvas');
  canvas.width = o.size.w; canvas.height = o.size.h;
  const g = canvas.getContext('2d');
  const rects = layoutRects(vids.length, canvas.width, canvas.height);
  const gap = vids.length > 1 ? Math.round(canvas.width / 270) : 0;
  const fontPx = Math.round(canvas.width / 30);
  const draw = () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    vids.forEach((v, i) => {
      const [x, y, w, h] = rects[i];
      const vw = v.el.videoWidth, vh = v.el.videoHeight;
      if (!vw || !vh) return;
      const rx = x + gap / 2, ry = y + gap / 2, rw = w - gap, rh = h - gap;
      const k = Math.max(rw / vw, rh / vh); // isi penuh kotak (crop tepi)
      const sw = rw / k, sh = rh / k;
      g.drawImage(v.el, (vw - sw) / 2, (vh - sh) / 2, sw, sh, rx, ry, rw, rh);
      if (o.showLabels && v.label) {
        g.font = `700 ${fontPx}px system-ui, sans-serif`;
        const tw = g.measureText(v.label).width;
        const pad = fontPx * 0.45;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(rx + pad, ry + rh - fontPx * 1.9, tw + pad * 2, fontPx * 1.45);
        g.fillStyle = '#fff';
        g.fillText(v.label, rx + pad * 2, ry + rh - fontPx * 0.85);
      }
    });
  };
  draw();

  const ac = new AudioContext({ sampleRate: o.audio.sampleRate });
  const dest = ac.createMediaStreamDestination();
  const src = ac.createBufferSource();
  src.buffer = o.audio;
  src.connect(dest);
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: o.mime, videoBitsPerSecond: o.size.h >= 1920 ? 8_000_000 : 5_000_000, audioBitsPerSecond: 192_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  const dur = o.audio.duration;
  await ac.resume();
  rec.start(1000);
  const startAt = ac.currentTime + 0.15;
  src.start(startAt);
  const timers = vids.map((v) => setTimeout(() => v.el.play().catch(() => {}), (0.15 + Math.max(0, -v.vt0)) * 1000));

  // Gambar ~30 fps; video yang melenceng > 80 ms dari jam audio dikoreksi.
  let lastFix = 0;
  const tick = setInterval(() => {
    const t = ac.currentTime - startAt;
    if (t > 0.5 && t - lastFix > 2) {
      lastFix = t;
      for (const v of vids) {
        const want = v.vt0 + t;
        if (want > 0 && !v.el.paused && Math.abs(v.el.currentTime - want) > 0.08) v.el.currentTime = want;
      }
    }
    draw();
    o.onProgress?.(Math.min(1, Math.max(0, t / dur)));
  }, 1000 / 30);
  await new Promise((res) => setTimeout(res, (0.15 + dur + 0.1) * 1000));
  clearInterval(tick);
  timers.forEach(clearTimeout);
  rec.stop();
  await stopped;
  for (const v of vids) { v.el.pause(); URL.revokeObjectURL(v.url); }
  ac.close();
  return new Blob(parts, { type: o.mime.split(';')[0] });
}
