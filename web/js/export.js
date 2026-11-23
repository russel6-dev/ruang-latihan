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

  if (wantStems && o.extra && o.extra.gain > 0) {
    const src = ctx.createBufferSource();
    src.buffer = o.extra.buffer;
    const gain = ctx.createGain();
    gain.gain.value = o.extra.gain;
    src.connect(gain).connect(stemOut);
    const at = preroll + o.extra.startAt;
    if (at >= 0) src.start(at); else src.start(0, -at);
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
 * Cover: rekaman kamu menggantikan gitar asli + backing.
 * o = { buffers, guitarName, take: {buffer, startAt, gain}, from, to,
 *       otherLevel (0..1), autoBalance, compressor, reverb, fadeIn, fadeOut, onProgress }
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

  for (const [name, buf] of Object.entries(o.buffers)) {
    if (name === o.guitarName) continue;
    const g = ctx.createGain();
    g.gain.value = name === 'other' ? o.otherLevel : 1;
    if (g.gain.value <= 0) continue;
    g.connect(master);
    place(buf, 0, g);
  }

  // Rekaman: seimbangkan dengan gitar asli, kompresor ringan, reverb ringan.
  const take = o.take;
  let balance = 1;
  if (o.autoBalance && o.buffers[o.guitarName]) {
    const a = Math.max(from, take.startAt), b = Math.min(to, take.startAt + take.buffer.duration);
    const ref = rms(o.buffers[o.guitarName], a, b);
    const mine = rms(take.buffer, a - take.startAt, b - take.startAt);
    if (ref > 0 && mine > 0) balance = Math.min(8, Math.max(0.1, ref / mine));
  }
  const tg = ctx.createGain();
  tg.gain.value = balance * (take.gain ?? 1);
  let chain = tg;
  if (o.compressor) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.006; comp.release.value = 0.18;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.35;
    tg.connect(comp).connect(makeup);
    chain = makeup;
  }
  chain.connect(master);
  if (o.reverb) {
    const conv = ctx.createConvolver();
    conv.buffer = reverbIR(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    chain.connect(conv).connect(wet).connect(master);
  }
  place(take.buffer, take.startAt, tg);

  // Fade
  const fi = o.fadeIn ? Math.min(1.5, len / 4) : 0;
  const fo = o.fadeOut ? Math.min(3, len / 3) : 0;
  master.gain.setValueAtTime(fi ? 0 : 1, 0);
  if (fi) master.gain.linearRampToValueAtTime(1, fi);
  if (fo) { master.gain.setValueAtTime(1, len - fo); master.gain.linearRampToValueAtTime(0, len); }

  for (let t = 5; t < len; t += 5) ctx.suspend(t).then(() => { o.onProgress?.(t / len); ctx.resume(); });
  const out = await ctx.startRendering();
  loudness(out);
  return { buffer: out, balance };
}

// Volume akhir standar sosmed (±-14 LUFS, dikira-kira dari RMS) tanpa pecah.
function loudness(buf) {
  let sum = 0, n = 0, peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 2) { sum += d[i] * d[i]; n++; const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  const r = Math.sqrt(sum / Math.max(1, n));
  if (!r) return;
  const target = Math.pow(10, -15 / 20);
  let g = target / r;
  // limiter sederhana: kompres puncak di atas 0.9 secara halus
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

// ---------------------------------------------------------------- video cover (MP4)

/**
 * Rakit video: rekaman kamera + audio cover. Berjalan real-time (selama durasi klip).
 * o = { videoBlob, videoStartAt (posisi lagu saat detik 0 video), from, to, audio (AudioBuffer cover dari 'from'),
 *       mime, size: {w,h}, onProgress }
 */
export async function composeVideo(o) {
  const url = URL.createObjectURL(o.videoBlob);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('Video rekaman nggak bisa dibuka')); });
  const vt0 = o.from - o.videoStartAt;
  video.currentTime = Math.max(0, vt0);
  await new Promise((res) => { video.onseeked = res; setTimeout(res, 3000); });

  const canvas = document.createElement('canvas');
  canvas.width = o.size.w; canvas.height = o.size.h;
  const g = canvas.getContext('2d');
  const draw = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (!vw || !vh) return;
    const k = Math.max(canvas.width / vw, canvas.height / vh); // isi penuh (crop tepi)
    const w = vw * k, h = vh * k;
    g.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
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
  let running = true;
  const loop = () => {
    if (!running) return;
    draw();
    o.onProgress?.(Math.min(1, (ac.currentTime - startAt) / dur));
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
  };
  rec.start(1000);
  // kalau video mulai setelah 'from', tahan di frame pertama sampai waktunya
  const lead = Math.max(0, -vt0);
  await ac.resume();
  const startAt = ac.currentTime + 0.15;
  src.start(startAt);
  setTimeout(() => video.play().catch(() => {}), (0.15 + lead) * 1000);
  loop();
  const tick = setInterval(() => { draw(); }, 1000 / 30); // jaga gambar tetap jalan meski callback video telat
  await new Promise((res) => setTimeout(res, (0.15 + dur + 0.1) * 1000));
  running = false;
  clearInterval(tick);
  rec.stop();
  await stopped;
  video.pause();
  URL.revokeObjectURL(url);
  ac.close();
  return new Blob(parts, { type: o.mime.split(';')[0] });
}
