// Ekspor audio di HP: klik saja, sequencer saja, sesuai mixer, atau klik kiri + SQ kanan.
import { makeClick } from './player.js';

export const KINDS = {
  click: 'Klik',
  sq: 'SQ',
  mix: 'Mix',
  lr: 'Klik L + SQ R',
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
