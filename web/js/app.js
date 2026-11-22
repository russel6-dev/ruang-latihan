import { db } from './db.js';
import { api, settings, loadSettings, saveSettings, repoName } from './api.js';
import { Player, lowerBound } from './player.js';

const $ = (id) => document.getElementById(id);
const player = new Player();

const STEM_INFO = {
  vocals: { label: 'Vokal', color: '#f472b6' },
  drums: { label: 'Drum', color: '#f59e0b' },
  bass: { label: 'Bass', color: '#60a5fa' },
  guitar: { label: 'Gitar', color: '#34d399' },
  piano: { label: 'Piano/Keys', color: '#a78bfa' },
  other: { label: 'Lainnya', color: '#94a3b8' },
};

const PRESETS = {
  full: { tracks: {} },
  guitar: { tracks: { guitar: { mute: true } } },
  bass: { tracks: { bass: { mute: true }, drums: { vol: 1.2 } } },
  drums: { tracks: { drums: { mute: true }, bass: { vol: 1.2 } }, metro: true },
};

const STAGE_TEXT = {
  setup: 'Menyiapkan server GitHub',
  convert: 'Menyiapkan file',
  separate: 'Memisahkan instrumen',
  beats: 'Mendeteksi tempo',
  encode: 'Mengemas hasil',
};

let current = null; // lagu yang sedang dibuka
let waveCache = null;

// ---------- utilitas ----------
function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function loading(text) {
  $('loading').hidden = !text;
  if (text) $('loadingText').textContent = text;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- daftar lagu ----------
async function renderLibrary() {
  const songs = await db.listSongs();
  const box = $('songs');
  box.innerHTML = '';
  for (const song of songs) {
    const card = document.createElement('div');
    card.className = 'song-card';
    card.innerHTML = `
      <button class="song-main">
        <span class="song-title">${esc(song.title)}</span>
        <span class="song-meta">${Math.round(song.bpm)} BPM · ${fmt(song.duration)}</span>
      </button>
      <button class="icon-btn del" aria-label="Hapus">
        <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>
      </button>`;
    card.querySelector('.song-main').onclick = () => openSong(song.id);
    card.querySelector('.del').onclick = async () => {
      if (!confirm(`Hapus "${song.title}" dari HP?`)) return;
      await db.deleteSong(song);
      renderLibrary();
    };
    box.appendChild(card);
  }
  const jobs = (await db.get('jobs')) || [];
  $('empty').hidden = songs.length > 0 || jobs.length > 0 || uploads.size > 0;
}

// ---------- upload & proses ----------
const uploads = new Map(); // id lokal -> {title, progress}
const jobViews = new Map(); // jobId -> state tampilan
const polling = new Set();

function renderJobs() {
  const box = $('jobs');
  box.innerHTML = '';
  for (const [, u] of uploads) {
    box.appendChild(jobCard(u.title, `Mengupload… ${Math.round(u.progress * 100)}%`, u.progress));
  }
  for (const [jobId, v] of jobViews) {
    const card = jobCard(v.title, v.text, v.progress, v.error);
    if (v.error || v.cancellable) {
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.textContent = v.error ? 'Tutup' : 'Batal';
      btn.onclick = () => dropJob(jobId, !v.error);
      card.appendChild(btn);
    }
    box.appendChild(card);
  }
}

function jobCard(title, text, progress, error = false) {
  const el = document.createElement('div');
  el.className = 'job-card' + (error ? ' error' : '');
  el.innerHTML = `
    <div class="job-title">${esc(title)}</div>
    <div class="job-text">${esc(text)}</div>
    ${error ? '' : `<div class="progress"><div style="width:${Math.round((progress || 0) * 100)}%"></div></div>`}`;
  return el;
}

async function addJob(entry) {
  const jobs = (await db.get('jobs')) || [];
  jobs.push(entry);
  await db.set('jobs', jobs);
}

async function dropJob(jobId, cancelOnServer) {
  const jobs = ((await db.get('jobs')) || []).filter((j) => j.id !== jobId);
  await db.set('jobs', jobs);
  jobViews.delete(jobId);
  polling.delete(jobId);
  if (cancelOnServer) api.remove(jobId, true);
  renderJobs();
  renderLibrary();
}

async function handleFile(file) {
  if (!file) return;
  const localId = Math.random().toString(36).slice(2);
  const title = file.name.replace(/\.[^.]+$/, '');
  uploads.set(localId, { title, progress: 0 });
  renderJobs();
  renderLibrary();
  try {
    const job = await api.upload(file, title, (p) => {
      uploads.set(localId, { title, progress: p });
      renderJobs();
    });
    uploads.delete(localId);
    const entry = { id: job.id, sha: job.sha, title, created: Date.now() };
    await addJob(entry);
    jobViews.set(job.id, { title, text: 'Menunggu server GitHub…', progress: 0, cancellable: true });
    renderJobs();
    poll(entry);
  } catch (err) {
    uploads.delete(localId);
    renderJobs();
    renderLibrary();
    toast(`Upload gagal: ${err.message}`, 6000);
    if (err.status === 401 || err.status === 404) openSettings();
  }
}

async function poll(entry) {
  const { id: jobId, sha, title } = entry;
  if (polling.has(jobId)) return;
  polling.add(jobId);
  let failures = 0;
  let round = 0;
  while (polling.has(jobId)) {
    round++;
    try {
      // Sesekali cek juga apakah proses di GitHub Actions berhenti sebelum sempat lapor.
      const s = await api.status(jobId, sha, round % 6 === 0);
      failures = 0;
      if (s.status === 'done') {
        await download(jobId, title);
        break;
      }
      if (s.status === 'error') {
        jobViews.set(jobId, { title, text: `Gagal: ${s.message || 'error'}`, error: true });
        renderJobs();
        break;
      }
      const elapsed = ` · ${fmt((Date.now() - entry.created) / 1000)}`;
      let text;
      if (s.status === 'queued') text = `Menunggu server GitHub…${elapsed}`;
      else if (s.stage === 'setup') text = `${STAGE_TEXT.setup}…${elapsed}`;
      else text = `${STAGE_TEXT[s.stage] || 'Memproses'}… ${Math.round(s.progress * 100)}%${elapsed}`;
      jobViews.set(jobId, { title, text, progress: s.progress, cancellable: true });
      renderJobs();
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 422) {
        jobViews.set(jobId, {
          title,
          text: err.status === 404 || err.status === 422 ? 'Prosesnya nggak ketemu lagi di GitHub. Upload ulang ya.' : err.message,
          error: true,
        });
        renderJobs();
        break;
      }
      failures++;
      const prev = jobViews.get(jobId) || { title, progress: 0 };
      jobViews.set(jobId, { ...prev, text: 'Menghubungi GitHub… (cek internet)' });
      renderJobs();
    }
    await new Promise((r) => setTimeout(r, failures ? Math.min(5000 * failures, 30000) : 5000));
  }
  polling.delete(jobId);
}

async function download(jobId, title) {
  const result = await api.result(jobId);
  const songId = jobId;
  for (let i = 0; i < result.stems.length; i++) {
    const stem = result.stems[i];
    jobViews.set(jobId, { title, text: `Mengunduh track ${i + 1}/${result.stems.length}…`, progress: i / result.stems.length });
    renderJobs();
    const blob = await api.stem(jobId, stem);
    await db.putStem(songId, stem, blob);
  }
  const song = {
    id: songId,
    title: result.title || title,
    duration: result.duration,
    bpm: result.bpm,
    beats: result.beats,
    stems: result.stems,
    created: Date.now(),
    grid: { mode: 'auto', factor: 1, parity: 0, offset: 0, downbeat: result.downbeat, autoDownbeat: result.downbeat, bpb: result.beats_per_bar || 4, bpm: result.bpm, phase: result.beats[0] || 0 },
    tracks: {},
    preset: 'full',
    metro: { on: false, vol: 0.8, countIn: true },
  };
  await db.putSong(song);
  navigator.storage?.persist?.().catch(() => {});
  api.remove(jobId);
  await dropJob(jobId, false);
  toast(`"${song.title}" siap dilatih!`);
}

async function resumeJobs() {
  const jobs = (await db.get('jobs')) || [];
  for (const j of jobs) {
    jobViews.set(j.id, { title: j.title, text: 'Mengecek status…', progress: 0 });
    poll(j);
  }
  renderJobs();
}

// ---------- grid ketukan ----------
function computeBeats(song) {
  const g = song.grid;
  let b;
  if (g.mode === 'manual') {
    const per = 60 / g.bpm;
    b = [];
    for (let t = ((g.phase % per) + per) % per; t < song.duration; t += per) b.push(t);
  } else {
    b = song.beats.slice();
    if (g.factor === 2) {
      const o = [];
      for (let i = 0; i < b.length; i++) {
        o.push(b[i]);
        if (i + 1 < b.length) o.push((b[i] + b[i + 1]) / 2);
      }
      b = o;
    } else if (g.factor === 0.5) {
      b = b.filter((_, i) => i % 2 === g.parity);
    }
  }
  if (g.offset) b = b.map((t) => t + g.offset);
  return b;
}

function currentBpm(song) {
  const g = song.grid;
  return g.mode === 'manual' ? g.bpm : song.bpm * g.factor;
}

function applyGrid(save = true) {
  const g = current.grid;
  current.computed = computeBeats(current);
  player.setGrid(current.computed, g.bpb, g.downbeat);
  $('bpmLabel').textContent = `${currentBpm(current).toFixed(1).replace(/\.0$/, '')} BPM`;
  $('offLabel').textContent = `${Math.round(g.offset * 1000)} ms`;
  $('factorLabel').textContent = g.mode === 'manual' ? 'manual' : ({ 1: 'normal', 2: '×2', 0.5: '÷2' }[g.factor]);
  $('half').disabled = g.mode === 'manual' || g.factor === 0.5;
  $('double').disabled = g.mode === 'manual' || g.factor === 2;
  $('manualRow').hidden = g.mode !== 'manual';
  $('bpmManual').textContent = g.bpm.toFixed(1).replace(/\.0$/, '');
  for (const b of $('bpbSeg').children) b.classList.toggle('on', Number(b.dataset.v) === g.bpb);
  renderDots();
  waveCache = null;
  if (save) saveSong();
}

function shiftDownbeat(d) {
  const g = current.grid;
  g.downbeat = (((g.downbeat + d) % g.bpb) + g.bpb) % g.bpb;
  applyGrid();
}

function setFactor(next) {
  const g = current.grid;
  if (g.factor === 1 && next === 2) g.downbeat = 2 * g.downbeat;
  else if (g.factor === 2 && next === 1) g.downbeat = Math.floor(g.downbeat / 2);
  else if (g.factor === 1 && next === 0.5) { g.parity = g.downbeat % 2; g.downbeat = Math.floor(g.downbeat / 2); }
  else if (g.factor === 0.5 && next === 1) g.downbeat = 2 * g.downbeat + g.parity;
  else return;
  g.factor = next;
  g.downbeat %= g.bpb;
  applyGrid();
}

let taps = [];
function tap() {
  const g = current.grid;
  const playing = player.playing && !player.countingIn;
  const t = playing ? player.position : performance.now() / 1000;
  if (taps.length && (t - taps[taps.length - 1] > 2.5 || t < taps[taps.length - 1])) taps = [];
  taps.push(t);
  $('tapBtn').classList.remove('hit');
  void $('tapBtn').offsetWidth;
  $('tapBtn').classList.add('hit');
  if (taps.length < 4) {
    $('tapBtn').textContent = `TAP ${taps.length}/4`;
    return;
  }
  // Regresi linear: waktu tap = phase + i * periode
  const n = taps.length;
  const xs = taps.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = taps.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (taps[i] - my); den += (xs[i] - mx) ** 2; }
  const per = num / den;
  if (!(per > 0.2 && per < 2)) return;
  g.mode = 'manual';
  g.bpm = Math.round((60 / per) * 10) / 10;
  g.offset = 0;
  if (playing) {
    g.phase = my - mx * per; // ketukan tap pertama
    const beats = computeBeats(current);
    const first = lowerBound(beats, taps[0] - per / 2);
    g.downbeat = ((first % g.bpb) + g.bpb) % g.bpb;
  } else if (!Number.isFinite(g.phase)) {
    g.phase = current.beats[0] || 0;
  }
  $('tapBtn').textContent = `TAP · ${g.bpm} BPM`;
  applyGrid();
}

// ---------- pemutar ----------
async function openSong(id) {
  const song = await db.getSong(id);
  if (!song) return;
  loading('Menyiapkan audio…');
  try {
    await player.init(Number(settings.rate) || 44100);
    const blobs = {};
    for (const stem of song.stems) {
      const blob = await db.getStem(song.id, stem);
      if (blob) blobs[stem] = blob;
    }
    await player.load(blobs, (p) => loading(`Menyiapkan audio… ${Math.round(p * 100)}%`));
  } catch (err) {
    loading(null);
    toast(`Gagal membuka lagu: ${err.message}`, 5000);
    return;
  }
  loading(null);
  current = song;
  taps = [];
  $('tapBtn').textContent = 'TAP';
  for (const name of song.stems) player.setTrack(name, { vol: 1, mute: false, solo: false, ...song.tracks[name] });
  player.setMetronome({ on: song.metro.on, vol: song.metro.vol });
  $('metroOn').checked = song.metro.on;
  $('countIn').checked = song.metro.countIn;
  $('metroVol').value = Math.round(song.metro.vol * 100);
  $('timeTotal').textContent = fmt(player.duration);
  renderTracks();
  renderPresets();
  applyGrid(false);
  peaksCache = null;
  showView('player', song.title);
}

function renderTracks() {
  const box = $('tracks');
  box.innerHTML = '';
  for (const name of current.stems) {
    const info = STEM_INFO[name] || { label: name, color: '#999' };
    const t = player.tracks[name];
    const row = document.createElement('div');
    row.className = 'track' + (t.mute ? ' muted' : '');
    row.style.setProperty('--c', info.color);
    row.innerHTML = `
      <span class="track-name">${info.label}</span>
      <button class="tbtn m ${t.mute ? 'on' : ''}">M</button>
      <button class="tbtn s ${t.solo ? 'on' : ''}">S</button>
      <input type="range" min="0" max="150" value="${Math.round(t.vol * 100)}">
      <span class="track-vol">${Math.round(t.vol * 100)}</span>`;
    const [mBtn, sBtn] = row.querySelectorAll('button');
    const range = row.querySelector('input');
    mBtn.onclick = () => { updateTrack(name, { mute: !player.tracks[name].mute }); };
    sBtn.onclick = () => { updateTrack(name, { solo: !player.tracks[name].solo }); };
    range.oninput = () => {
      row.querySelector('.track-vol').textContent = range.value;
      updateTrack(name, { vol: range.value / 100 }, false);
    };
    range.onchange = () => saveSong();
    box.appendChild(row);
  }
  const anySolo = Object.values(player.tracks).some((t) => t.solo);
  box.classList.toggle('has-solo', anySolo);
  for (const [i, name] of current.stems.entries()) {
    box.children[i].classList.toggle('soloed', !!player.tracks[name].solo);
  }
}

function updateTrack(name, patch, rerender = true) {
  player.setTrack(name, patch);
  current.tracks[name] = { ...player.tracks[name] };
  current.preset = 'custom';
  renderPresets();
  if (rerender) { renderTracks(); saveSong(); }
}

function applyPreset(key) {
  const p = PRESETS[key];
  for (const name of current.stems) {
    player.setTrack(name, { vol: 1, mute: false, solo: false, ...(p.tracks[name] || {}) });
    current.tracks[name] = { ...player.tracks[name] };
  }
  if (p.metro) {
    current.metro.on = true;
    $('metroOn').checked = true;
    player.setMetronome({ on: true });
  }
  current.preset = key;
  renderTracks();
  renderPresets();
  saveSong();
}

function renderPresets() {
  for (const b of $('presets').children) b.classList.toggle('on', b.dataset.preset === current.preset);
}

function renderDots() {
  const box = $('beatDots');
  box.innerHTML = '';
  for (let i = 0; i < current.grid.bpb; i++) {
    const d = document.createElement('span');
    if (i === 0) d.className = 'accent';
    box.appendChild(d);
  }
}

let saveTimer;
function saveSong() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!current) return;
    const { computed, ...song } = current;
    db.putSong(song).catch(() => {});
  }, 300);
}

// ---------- gambar gelombang ----------
let peaksCache = null;
function drawWave() {
  const canvas = $('wave');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    waveCache = null;
  }
  const W = canvas.width, H = canvas.height;
  if (!waveCache) {
    const bins = Math.floor(W / (3 * dpr));
    if (!peaksCache || peaksCache.length !== bins) peaksCache = player.peaks(bins);
    const mk = (color, tick) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = color;
      const bw = W / bins;
      for (let i = 0; i < bins; i++) {
        const ph = Math.max(2 * dpr, peaksCache[i] * (H - 14 * dpr));
        g.fillRect(i * bw + 0.5 * dpr, (H - ph) / 2 + 4 * dpr, Math.max(1, bw - 1 * dpr), ph);
      }
      // garis ketukan 1 di tiap bar
      g.fillStyle = tick;
      const beats = current.computed;
      for (let i = 0; i < beats.length; i++) {
        if (player.inBar(i) !== 0) continue;
        const x = (beats[i] / player.duration) * W;
        g.fillRect(x, 0, 1 * dpr, 5 * dpr);
      }
      return c;
    };
    waveCache = { dim: mk('#3a3f4b', '#5b6170'), lit: mk('#ffb020', '#ffd27a') };
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(waveCache.dim, 0, 0);
  const x = (player.position / (player.duration || 1)) * W;
  ctx.drawImage(waveCache.lit, 0, 0, x, H, 0, 0, x, H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - dpr, 0, 2 * dpr, H);
}

function frame() {
  if (current && !$('playerView').hidden) {
    drawWave();
    const pos = player.position;
    $('timeNow').textContent = fmt(pos);
    document.body.classList.toggle('playing', player.playing);
    const beats = current.computed;
    const idx = Math.max(0, lowerBound(beats, pos + 0.001) - 1);
    const bar = Math.floor((idx - current.grid.downbeat) / current.grid.bpb) + 1;
    const b = player.currentBeat();
    $('barInfo').textContent = player.countingIn
      ? 'Count-in…'
      : `Bar ${Math.max(1, bar)} · ${player.inBar(idx) + 1}`;
    const dots = $('beatDots').children;
    for (let i = 0; i < dots.length; i++) {
      const on = b && b.n === i && player.ctx.currentTime - b.t < 0.18;
      dots[i].classList.toggle('lit', !!on);
      dots[i].classList.toggle('count', !!(on && b.count));
    }
  }
  requestAnimationFrame(frame);
}

function seekFromEvent(e) {
  const rect = $('wave').getBoundingClientRect();
  const r = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  player.seek(r * player.duration);
}

// ---------- layar tetap nyala saat latihan ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* nggak didukung */ }
}

async function togglePlay() {
  if (player.playing) {
    player.pause();
    keepAwake(false);
  } else {
    await player.play(current.metro.countIn);
    keepAwake(true);
  }
}

// ---------- navigasi ----------
function showView(view, title) {
  const isPlayer = view === 'player';
  $('libraryView').hidden = isPlayer;
  $('playerView').hidden = !isPlayer;
  $('backBtn').hidden = !isPlayer;
  $('title').textContent = isPlayer ? title : 'Ruang Latihan';
  if (isPlayer && history.state?.view !== 'player') history.pushState({ view: 'player' }, '');
  window.scrollTo(0, 0);
}

function closePlayer() {
  player.pause();
  keepAwake(false);
  saveSong();
  current = null;
  player.unload();
  showView('library');
  renderLibrary();
}

// ---------- pengaturan ----------
async function openSettings() {
  $('setRepo').value = settings.repo;
  $('setRepo').placeholder = repoName() || 'pemilik/ruang-latihan';
  $('setToken').value = settings.token;
  $('setRate').value = String(settings.rate);
  $('settingsDlg').showModal();
  checkConnection();
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    $('storageInfo').textContent = `Penyimpanan terpakai: ${(est.usage / 1048576).toFixed(0)} MB dari ±${(est.quota / 1073741824).toFixed(1)} GB`;
  }
}

async function checkConnection() {
  const line = $('serverStatus');
  if (!settings.token) { line.textContent = 'Isi token GitHub dulu.'; return; }
  line.textContent = 'Cek koneksi ke GitHub…';
  try {
    const name = await api.check();
    line.textContent = `✅ Terhubung ke ${name}`;
  } catch (err) {
    line.textContent = `❌ ${err.message}`;
  }
}

// ---------- event ----------
function bind() {
  $('addBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    handleFile(file);
  };
  $('backBtn').onclick = () => history.back();
  window.addEventListener('popstate', () => { if (current) closePlayer(); });

  $('playBtn').onclick = togglePlay;
  $('rewindBtn').onclick = () => player.seek(0);
  player.onEnded = () => keepAwake(false);

  let dragging = false;
  const wave = $('wave');
  wave.addEventListener('pointerdown', (e) => { dragging = true; wave.setPointerCapture(e.pointerId); });
  wave.addEventListener('pointerup', (e) => { if (dragging) seekFromEvent(e); dragging = false; });
  wave.addEventListener('pointercancel', () => { dragging = false; });

  $('presets').onclick = (e) => {
    const key = e.target.closest('button')?.dataset.preset;
    if (key) applyPreset(key);
  };

  $('metroOn').onchange = (e) => {
    current.metro.on = e.target.checked;
    player.setMetronome({ on: current.metro.on });
    saveSong();
  };
  $('countIn').onchange = (e) => { current.metro.countIn = e.target.checked; saveSong(); };
  $('metroVol').oninput = (e) => {
    current.metro.vol = e.target.value / 100;
    player.setMetronome({ vol: current.metro.vol });
  };
  $('metroVol').onchange = () => saveSong();
  $('bpbSeg').onclick = (e) => {
    const v = Number(e.target.closest('button')?.dataset.v);
    if (!v) return;
    current.grid.bpb = v;
    current.grid.downbeat %= v;
    applyGrid();
  };

  $('dbPrev').onclick = () => shiftDownbeat(-1);
  $('dbNext').onclick = () => shiftDownbeat(1);
  $('offMinus').onclick = () => { current.grid.offset = Math.round((current.grid.offset - 0.01) * 1000) / 1000; applyGrid(); };
  $('offPlus').onclick = () => { current.grid.offset = Math.round((current.grid.offset + 0.01) * 1000) / 1000; applyGrid(); };
  $('half').onclick = () => setFactor(current.grid.factor === 2 ? 1 : 0.5);
  $('double').onclick = () => setFactor(current.grid.factor === 0.5 ? 1 : 2);
  $('bpmMinus').onclick = () => { current.grid.bpm = Math.max(30, Math.round((current.grid.bpm - 0.5) * 10) / 10); applyGrid(); };
  $('bpmPlus').onclick = () => { current.grid.bpm = Math.min(300, Math.round((current.grid.bpm + 0.5) * 10) / 10); applyGrid(); };
  $('tapBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
  $('gridReset').onclick = () => {
    const g = current.grid;
    Object.assign(g, { mode: 'auto', factor: 1, parity: 0, offset: 0, downbeat: (g.autoDownbeat ?? 0) % g.bpb });
    taps = [];
    $('tapBtn').textContent = 'TAP';
    applyGrid();
    toast('Grid balik ke deteksi otomatis');
  };

  $('settingsBtn').onclick = openSettings;
  $('checkBtn').onclick = () => {
    settings.token = $('setToken').value.trim();
    settings.repo = $('setRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    checkConnection();
  };
  $('settingsDlg').addEventListener('close', () => {
    if ($('settingsDlg').returnValue !== 'save') return;
    settings.repo = $('setRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    settings.token = $('setToken').value.trim();
    settings.rate = Number($('setRate').value);
    saveSettings();
    toast('Pengaturan disimpan');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && player.playing) keepAwake(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && current && !$('playerView').hidden && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });
}

// ---------- mulai ----------
loadSettings();
bind();
renderLibrary();
resumeJobs();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
