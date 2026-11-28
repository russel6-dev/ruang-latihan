// Uji kecepatan pisah instrumen di HP (Demucs htdemucs_6s via ONNX Runtime Web).
import { specChannel, ispecChannel } from './dsp.js';

const $ = (id) => document.getElementById(id);
const MODEL_DIR = '../models/';
const CACHE = 'rl-model-v1';
const LABEL = { vocals: 'Vokal', drums: 'Drum', bass: 'Bass', guitar: 'Gitar', piano: 'Piano/Keys', other: 'Lainnya' };

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let info = null, session = null, engine = '', gpuName = '-';
let duration = 30;
const forceCpu = new URLSearchParams(location.search).has('cpu');
const tick = () => new Promise((r) => setTimeout(r, 30)); // kasih waktu layar buat update
const fmtS = (s) => (s >= 60 ? `${Math.floor(s / 60)} mnt ${Math.round(s % 60)} dtk` : `${s.toFixed(1)} dtk`);

// ---------------- 1. kemampuan HP
async function checkDevice() {
  $('cores').textContent = `${navigator.hardwareConcurrency || '?'} core`;
  $('mem').textContent = navigator.deviceMemory ? `±${navigator.deviceMemory} GB+` : 'nggak diketahui';
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) {
      const i = adapter.info || {};
      gpuName = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') || 'ada';
      $('gpu').innerHTML = `<span class="ok">✅ Bisa</span> <small>${gpuName}</small>`;
    } else {
      $('gpu').innerHTML = '<span class="bad">❌ Nggak tersedia</span> <small>(pakai CPU, lebih lambat)</small>';
    }
  } catch {
    $('gpu').innerHTML = '<span class="bad">❌ Nggak tersedia</span>';
  }
}

// ---------------- 2. model
async function fetchCached(url, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) { onProgress?.(1); return new Uint8Array(await hit.arrayBuffer()); }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Gagal unduh ${url} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress?.(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  await cache.put(url, new Response(buf));
  return buf;
}

async function loadModel() {
  $('loadModel').disabled = true;
  try {
    info = await (await fetch(MODEL_DIR + 'demucs.json', { cache: 'no-store' })).json();
    const totalMB = Object.values(info.sizes).reduce((a, b) => a + b, 0) / 1048576;
    const files = ['demucs.onnx', ...info.files.filter((f) => f.startsWith('demucs.data'))];
    const bufs = {};
    let done = 0;
    for (const f of files) {
      bufs[f] = await fetchCached(MODEL_DIR + f, (p) => {
        const mb = (done + p * info.sizes[f]) / 1048576;
        $('modelBar').style.width = `${(mb / totalMB) * 100}%`;
        $('modelInfo').textContent = `Mengunduh model… ${mb.toFixed(0)} / ${totalMB.toFixed(0)} MB`;
      });
      done += info.sizes[f];
    }
    $('modelInfo').textContent = 'Menyiapkan model di HP…';
    const externalData = files.slice(1).map((f) => ({ path: f, data: bufs[f] }));
    const tryCreate = (ep) => ort.InferenceSession.create(bufs['demucs.onnx'], { executionProviders: [ep], externalData, graphOptimizationLevel: 'all' });
    try {
      if (!navigator.gpu || forceCpu) throw new Error('no webgpu');
      session = await tryCreate('webgpu');
      engine = 'GPU HP (WebGPU)';
    } catch (err) {
      console.warn('WebGPU gagal, pakai CPU', err);
      session = await tryCreate('wasm');
      engine = `CPU HP (WASM, ${ort.env.wasm.numThreads} thread)`;
    }
    $('modelBar').style.width = '100%';
    $('modelInfo').innerHTML = `<span class="ok">✅ Model siap</span> · ${totalMB.toFixed(0)} MB · mesin: <b>${engine}</b>`;
    $('pick').disabled = false;
  } catch (err) {
    $('modelInfo').innerHTML = `<span class="bad">❌ ${err.message}</span>`;
    $('loadModel').disabled = false;
  }
}

// ---------------- 3. proses
async function decode(file) {
  const data = await file.arrayBuffer();
  // OfflineAudioContext: nggak butuh izin suara & nggak bisa "ketahan" (suspended) di Android
  const ac = new OfflineAudioContext(2, 1, info.samplerate);
  const buf = await Promise.race([
    ac.decodeAudioData(data),
    new Promise((_, no) => setTimeout(() => no(new Error('Lagu nggak kebaca dalam 60 detik. Coba file MP3 lain.')), 60000)),
  ]);
  const n = Math.min(buf.length, Math.round(duration * info.samplerate));
  const l = buf.getChannelData(0).slice(0, n);
  const r = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(0, n);
  return [l, r];
}

function stats(chs) {
  const n = chs[0].length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (chs[0][i] + chs[1][i]) / 2;
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = (chs[0][i] + chs[1][i]) / 2 - mean; v += d * d; }
  return { mean, std: Math.sqrt(v / Math.max(1, n - 1)) || 1 };
}

async function run(file) {
  const L = info.length, T = info.frames, bins = info.bins, S = info.sources.length;
  $('pick').disabled = true;
  $('resultCard').hidden = true;
  $('dontClose').hidden = false;
  let wake = null;
  navigator.wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => {});
  const t00 = performance.now();
  let stage = 'Membaca lagu…';
  const show = () => { $('runStatus').textContent = `${stage} · ${fmtS((performance.now() - t00) / 1000)}`; };
  const timer = setInterval(() => {
    show();
    // Potongan pertama di GPU kelamaan -> tawarkan CPU
    if (engine.startsWith('GPU') && firstPending && performance.now() - tFirst > 150000) $('useCpu').hidden = false;
  }, 1000);
  let firstPending = false, tFirst = 0;
  try {
    show(); await tick();
    const chs = await decode(file);
    const N = chs[0].length;
    const { mean, std } = stats(chs);
    const norm = chs.map((c) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = (c[i] - mean) / std; return o; });

    const stride = Math.floor(0.75 * L);
    const offsets = [];
    for (let o = 0; o < N; o += stride) offsets.push(o);
    const half = Math.floor(L / 2);
    const weight = new Float32Array(L);
    for (let i = 0; i < half; i++) weight[i] = i + 1;
    for (let i = half; i < L; i++) weight[i] = L - i;
    const wmax = Math.max(half, L - half);
    for (let i = 0; i < L; i++) weight[i] /= wmax;

    const out = Array.from({ length: S }, () => [new Float32Array(N), new Float32Array(N)]);
    const sumW = new Float32Array(N);
    const songSec = N / info.samplerate;
    const t0 = performance.now();
    let first = 0, modelMs = 0;
    firstPending = true; tFirst = t0;
    stage = `✅ Lagu terbaca (${Math.round(songSec)} dtk)\nPotongan 1/${offsets.length}: ${engine.startsWith('GPU') ? 'GPU lagi nyiapin diri (sekali aja, bisa 1–3 menit)…' : 'memproses…'}`;
    show(); await tick();
    for (let k = 0; k < offsets.length; k++) {
      const off = offsets[k];
      const cl = Math.min(L, N - off), delta = L - cl, start = off - Math.floor(delta / 2);
      const mix = new Float32Array(2 * L);
      for (let c = 0; c < 2; c++) for (let i = 0; i < L; i++) { const j = start + i; if (j >= 0 && j < N) mix[c * L + i] = norm[c][j]; }
      const mag = new Float32Array(4 * bins * T);
      for (let c = 0; c < 2; c++) specChannel(mix.subarray(c * L, (c + 1) * L), mag, c, T);
      const tm = performance.now();
      const res = await session.run({ mix: new ort.Tensor('float32', mix, [1, 2, L]), mag: new ort.Tensor('float32', mag, [1, 4, bins, T]) });
      modelMs += performance.now() - tm;
      const spec = res.spec.data, wave = res.wave.data;
      const tr = Math.floor(delta / 2);
      for (let s = 0; s < S; s++) {
        for (let c = 0; c < 2; c++) {
          const base = ((s * 4) + c * 2) * bins * T;
          const x = ispecChannel(spec, base, base + bins * T, T, L);
          const wbase = (s * 2 + c) * L;
          const dst = out[s][c];
          for (let i = 0; i < cl; i++) dst[off + i] += weight[i] * (wave[wbase + tr + i] + x[tr + i]);
        }
      }
      for (let i = 0; i < cl; i++) sumW[off + i] += weight[i];
      if (k === 0) { first = performance.now() - t0; firstPending = false; $('useCpu').hidden = true; }
      $('runBar').style.width = `${((k + 1) / offsets.length) * 100}%`;
      stage = k + 1 < offsets.length ? `Memproses potongan ${k + 2}/${offsets.length}` : 'Merapikan hasil…';
      show(); await tick();
    }
    const total = (performance.now() - t0) / 1000;
    for (let s = 0; s < S; s++) for (let c = 0; c < 2; c++) {
      const d = out[s][c];
      for (let i = 0; i < N; i++) d[i] = (d[i] / sumW[i]) * std + mean;
    }
    showResult({ total, first: first / 1000, chunks: offsets.length, modelMs, N, out });
  } catch (err) {
    console.error(err);
    $('runStatus').innerHTML = `<span class="bad">❌ Gagal (${stage.split('\n').pop()}): ${err.message}</span>`;
    if (engine.startsWith('GPU')) $('useCpu').hidden = false;
  } finally {
    clearInterval(timer);
    $('dontClose').hidden = true;
    $('pick').disabled = false;
    try { await wake?.release(); } catch { /* abaikan */ }
  }
}

function wav(chs, sr) {
  const n = chs[0].length, buf = new DataView(new ArrayBuffer(44 + n * 4));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) buf.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); buf.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 2, true); buf.setUint32(24, sr, true);
  buf.setUint32(28, sr * 4, true); buf.setUint16(32, 4, true); buf.setUint16(34, 16, true); w(36, 'data'); buf.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { const v = Math.max(-1, Math.min(1, chs[c][i])); buf.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

function showResult(r) {
  const sec = r.N / info.samplerate;
  const restChunks = Math.max(1, r.chunks - 1);
  const avg = r.chunks > 1 ? (r.total - r.first) / restChunks : r.total;
  const stride = (0.75 * info.length) / info.samplerate;
  const chunks4 = Math.ceil(240 / stride);
  const est = r.first + avg * (chunks4 - 1);
  $('rEngine').textContent = engine;
  $('rTime').textContent = `${fmtS(r.total)} buat ${Math.round(sec)} detik lagu`;
  $('rChunk').textContent = fmtS(avg);
  $('rFirst').textContent = fmtS(r.first);
  $('rEst').textContent = `± ${fmtS(est)}`;
  const verdict = est < 180 ? ['ok', '👍 Cepat — layak dipakai buat versi gratis.']
    : est < 600 ? ['', '🙂 Lumayan — masih bisa buat versi gratis (ditinggal sebentar).']
      : ['bad', '🐢 Lambat — versi gratis kurang nyaman di HP ini.'];
  $('rVerdict').innerHTML = `<span class="${verdict[0]}">${verdict[1]}</span>`;
  const box = $('stems');
  box.innerHTML = '';
  info.sources.forEach((s, i) => {
    const url = URL.createObjectURL(wav(r.out[i], info.samplerate));
    box.insertAdjacentHTML('beforeend', `<div><label>${LABEL[s] || s}</label><audio controls preload="none" src="${url}"></audio></div>`);
  });
  $('report').value = [
    'HASIL UJI KECEPATAN (Latihan Band)',
    `HP: ${navigator.userAgent}`,
    `GPU: ${gpuName}`,
    `Mesin: ${engine}`,
    `Proses: ${Math.round(sec)} dtk lagu dalam ${r.total.toFixed(1)} dtk (${r.chunks} potongan)`,
    `Potongan pertama: ${r.first.toFixed(1)} dtk, rata-rata berikutnya: ${avg.toFixed(2)} dtk`,
    `Waktu model saja: ${(r.modelMs / 1000).toFixed(1)} dtk`,
    `Perkiraan lagu 4 menit: ${est.toFixed(0)} dtk`,
  ].join('\n');
  $('resultCard').hidden = false;
  $('runStatus').textContent = '✅ Selesai';
  $('resultCard').scrollIntoView({ behavior: 'smooth' });
}

// ---------------- event
$('loadModel').onclick = loadModel;
$('durSeg').onclick = (e) => {
  const v = Number(e.target.closest('button')?.dataset.v);
  if (!v) return;
  duration = v;
  for (const b of $('durSeg').children) b.classList.toggle('on', Number(b.dataset.v) === v);
};
$('pick').onclick = () => $('file').click();
$('useCpu').onclick = () => { location.href = `${location.pathname}?cpu`; };
$('file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) run(f); };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('report').value); $('copy').textContent = 'Tersalin ✅'; }
  catch { $('report').select(); document.execCommand('copy'); $('copy').textContent = 'Tersalin ✅'; }
};
checkDevice();
