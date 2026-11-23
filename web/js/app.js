import { db } from './db.js';
import { api, settings, loadSettings, saveSettings, repoName } from './api.js';
import { Player, lowerBound } from './player.js';
import { buildGrid, sectionIndexAt, sortedSections, mapFromLegacy } from './grid.js';
import { renderMix, renderCover, composeVideo, toWav, toMp3, estimateSize, KINDS } from './export.js';
import { createRecUi } from './rec-ui.js';
import { pickVideoMime } from './recorder.js';

const $ = (id) => document.getElementById(id);
const player = new Player();

const STEM_INFO = {
  vocals: { label: 'Vokal', color: '#f472b6' },
  drums: { label: 'Drum', color: '#f59e0b' },
  bass: { label: 'Bass', color: '#60a5fa' },
  guitar: { label: 'Gitar', color: '#34d399' },
  piano: { label: 'Piano/Keys', color: '#a78bfa' },
  other: { label: 'Lainnya', color: '#94a3b8' },
  take: { label: 'Rekaman', color: '#ef4444' },
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

const SEC_COLORS = ['#ffb020', '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#f87171'];

let current = null; // lagu yang sedang dibuka
let waveCache = null;

// ---------- utilitas ----------
function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const fmtMs = (t) => `${fmt(t)}.${String(Math.floor((Math.max(0, t) % 1) * 100)).padStart(2, '0')}`;
const r1 = (x) => Math.round(x * 10) / 10;
const clone = (x) => JSON.parse(JSON.stringify(x));

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

// ---------- banner "jangan ditutup" / "boleh ditutup" ----------
const busy = new Map(); // key -> teks
let safeTimer;

function busySet(key, text) {
  busy.set(key, text);
  clearTimeout(safeTimer);
  renderBanner();
}

function busyEnd(key, ok, title, text) {
  busy.delete(key);
  if (busy.size) { renderBanner(); return; }
  if (!ok) { $('banner').hidden = true; return; }
  const el = $('banner');
  el.className = 'banner ok';
  el.hidden = false;
  $('bannerTitle').textContent = title;
  $('bannerText').textContent = text;
  navigator.vibrate?.(60);
  clearTimeout(safeTimer);
  safeTimer = setTimeout(() => { if (!busy.size) el.hidden = true; }, 7000);
}

function renderBanner() {
  const el = $('banner');
  if (!busy.size) { el.hidden = true; return; }
  el.className = 'banner warn';
  el.hidden = false;
  $('bannerTitle').textContent = '⚠️ Jangan tutup atau minimize aplikasi dulu';
  $('bannerText').textContent = [...busy.values()].join('\n');
}

window.addEventListener('beforeunload', (e) => {
  if (busy.size) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- daftar lagu ----------
async function renderLibrary() {
  const songs = await db.listSongs();
  const box = $('songs');
  box.innerHTML = '';
  for (const song of songs) {
    const card = document.createElement('div');
    card.className = 'song-card';
    const secs = song.map?.sections?.length || 1;
    card.innerHTML = `
      <button class="song-main">
        <span class="song-title">${esc(song.title)}</span>
        <span class="song-meta">${Math.round(song.bpm)} BPM${secs > 1 ? ` · ${secs} bagian tempo` : ''} · ${fmt(song.duration)}</span>
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
const uploads = new Map(); // id lokal -> {title, progress, error, retry}
const jobViews = new Map(); // jobId -> state tampilan
const polling = new Set();

function renderJobs() {
  const box = $('jobs');
  box.innerHTML = '';
  for (const [localId, u] of uploads) {
    const card = jobCard(u.title, u.error ? u.error : `Mengupload… ${Math.round(u.progress * 100)}%`, u.progress, !!u.error);
    if (u.error) {
      if (u.retry) card.appendChild(smallBtn('Coba lagi', () => { uploads.delete(localId); u.retry(); }));
      card.appendChild(smallBtn('Tutup', () => { uploads.delete(localId); renderJobs(); renderLibrary(); }));
    }
    box.appendChild(card);
  }
  for (const [jobId, v] of jobViews) {
    const card = jobCard(v.title, v.text, v.progress, v.error);
    if (v.error || v.cancellable) card.appendChild(smallBtn(v.error ? 'Tutup' : 'Batal', () => dropJob(jobId, !v.error)));
    box.appendChild(card);
  }
}

function smallBtn(label, onclick) {
  const b = document.createElement('button');
  b.className = 'ghost small';
  b.textContent = label;
  b.onclick = onclick;
  return b;
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
  busy.delete(`dl:${jobId}`);
  renderBanner();
  if (cancelOnServer) api.remove(jobId, true);
  renderJobs();
  renderLibrary();
}

// Penanda upload yang sedang jalan (supaya ketahuan kalau aplikasi ditutup di tengah upload).
async function markUploading(localId, title, on) {
  const list = ((await db.get('uploading')) || []).filter((u) => u.localId !== localId);
  if (on) list.push({ localId, title });
  await db.set('uploading', list);
}

async function runUpload({ title, label, send, onSent }) {
  const localId = Math.random().toString(36).slice(2);
  const key = `up:${localId}`;
  uploads.set(localId, { title, progress: 0 });
  await markUploading(localId, title, true);
  renderJobs();
  renderLibrary();
  busySet(key, `${label} "${title}"… 0%`);
  try {
    const job = await send((p) => {
      uploads.set(localId, { title, progress: p });
      busySet(key, `${label} "${title}"… ${Math.round(p * 100)}%`);
      renderJobs();
    });
    uploads.delete(localId);
    await markUploading(localId, title, false);
    await onSent(job);
    busyEnd(key, true, '✅ Upload beres, aplikasi boleh ditutup',
      'Lagu lagi diproses di server GitHub. Buka lagi nanti, hasilnya diunduh otomatis.');
  } catch (err) {
    await markUploading(localId, title, false);
    busyEnd(key, false);
    uploads.set(localId, {
      title,
      progress: 0,
      error: document.hidden ? 'Upload tadi kepotong karena aplikasi di-minimize.' : `Upload gagal: ${err.message}`,
      retry: () => runUpload({ title, label, send, onSent }),
    });
    renderJobs();
    if (err.status === 401 || err.status === 404) openSettings();
  }
}

function handleFile(file) {
  if (!file) return;
  const title = file.name.replace(/\.[^.]+$/, '');
  runUpload({
    title,
    label: 'Lagi upload',
    send: (onP) => api.upload(file, title, onP),
    onSent: async (job) => {
      const entry = { id: job.id, sha: job.sha, title, created: Date.now(), kind: 'new' };
      await addJob(entry);
      jobViews.set(job.id, { title, text: 'Menunggu server GitHub…', progress: 0, cancellable: true });
      renderJobs();
      poll(entry);
    },
  });
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
      const s = await api.status(jobId, sha, round % 6 === 0);
      failures = 0;
      if (s.status === 'done') {
        if (entry.kind === 'reanalyze') await finishReanalyze(entry);
        else await download(jobId, title);
        break;
      }
      if (s.status === 'error') {
        jobViews.set(jobId, { title, text: `Gagal: ${s.message || 'error'}`, error: true });
        renderJobs();
        break;
      }
      const elapsed = ` · ${fmt((Date.now() - entry.created) / 1000)}`;
      const what = entry.kind === 'reanalyze' ? 'Proses ulang tempo: ' : '';
      let text;
      if (s.status === 'queued') text = `${what}Menunggu server GitHub…${elapsed}`;
      else if (s.stage === 'setup') text = `${what}${STAGE_TEXT.setup}…${elapsed}`;
      else text = `${what}${STAGE_TEXT[s.stage] || 'Memproses'}… ${Math.round(s.progress * 100)}%${elapsed}`;
      jobViews.set(jobId, { title, text, progress: s.progress, cancellable: true });
      renderJobs();
    } catch (err) {
      busyEnd(`dl:${jobId}`, false);
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

function mapFromResult(result) {
  return {
    mode: result.mode || 'steady',
    offset: 0,
    sections: (result.sections || []).map((s) => ({
      start: s.start, bpm: s.bpm, bpb: s.bpb, odd: s.odd || {}, gap: !!s.gap, countIn: s.countIn ?? 1, gapClick: 'silent',
    })),
  };
}

async function download(jobId, title) {
  const key = `dl:${jobId}`;
  busySet(key, `Lagi nyimpen "${title}" ke HP…`);
  const result = await api.result(jobId);
  for (let i = 0; i < result.stems.length; i++) {
    const stem = result.stems[i];
    jobViews.set(jobId, { title, text: `Mengunduh track ${i + 1}/${result.stems.length}…`, progress: i / result.stems.length });
    busySet(key, `Lagi nyimpen "${title}" ke HP… track ${i + 1} dari ${result.stems.length}`);
    renderJobs();
    const blob = await api.stem(jobId, stem);
    await db.putStem(jobId, stem, blob);
  }
  const map = result.sections ? mapFromResult(result) : null;
  const song = {
    id: jobId,
    title: result.title || title,
    duration: result.duration,
    bpm: result.bpm,
    beats: result.beats,
    drumBeats: result.drum_beats || [],
    stems: result.stems,
    created: Date.now(),
    map,
    autoMap: map ? clone(map) : null,
    tracks: {},
    preset: 'full',
    metro: { on: false, vol: 0.8, countIn: true },
  };
  if (!song.map) { song.map = mapFromLegacy(song); song.autoMap = clone(song.map); }
  await db.putSong(song);
  navigator.storage?.persist?.().catch(() => {});
  api.remove(jobId);
  await dropJob(jobId, false);
  busyEnd(key, true, `✅ "${song.title}" siap dilatih!`, 'Semua udah tersimpan di HP, aplikasi boleh ditutup.');
}

async function finishReanalyze(entry) {
  const result = await api.result(entry.id);
  const song = await db.getSong(entry.songId);
  if (song && result.sections) {
    song.map = mapFromResult(result);
    song.autoMap = clone(song.map);
    song.drumBeats = result.drum_beats || [];
    song.beats = result.beats;
    song.bpm = result.bpm;
    await db.putSong(song);
    if (current?.id === song.id) {
      Object.assign(current, { map: song.map, autoMap: song.autoMap, drumBeats: song.drumBeats, bpm: song.bpm });
      applyGrid(false);
    }
  }
  api.remove(entry.id);
  await dropJob(entry.id, false);
  toast(`Deteksi tempo "${entry.title}" udah diperbarui`, 4000);
}

async function resumeJobs() {
  const jobs = (await db.get('jobs')) || [];
  for (const j of jobs) {
    jobViews.set(j.id, { title: j.title, text: 'Mengecek status…', progress: 0 });
    poll(j);
  }
  // Upload yang kepotong karena aplikasi ditutup
  const cut = (await db.get('uploading')) || [];
  for (const u of cut) {
    uploads.set(u.localId, { title: u.title, progress: 0, error: `Upload "${u.title}" tadi nggak selesai (aplikasi ketutup). Pilih lagunya lagi ya.` });
  }
  await db.set('uploading', []);
  renderJobs();
  renderLibrary();
}

// ---------- peta tempo ----------
function applyGrid(save = true) {
  current.grid = buildGrid(current.map, current.duration, current.drumBeats || []);
  player.setGrid(current.grid.times, current.grid.info);
  waveCache = null;
  lastEditorKey = '';
  renderEditor();
  if (save) saveSong();
}

function curSecIndex() {
  return sectionIndexAt(current.map, player.position);
}

function secs() {
  current.map.sections = sortedSections(current.map);
  return current.map.sections;
}

function beatAtPosition() {
  const g = current.grid;
  const idx = Math.max(0, lowerBound(g.times, player.position + 0.001) - 1);
  return { idx, info: g.info[idx] };
}

function mainBpm() {
  const s = secs();
  if (!s.length) return 0;
  let best = s[0], bestLen = -1;
  s.forEach((sec, i) => {
    const len = (s[i + 1]?.start ?? current.duration) - sec.start;
    if (len > bestLen) { best = sec; bestLen = len; }
  });
  return best.bpm;
}

let lastEditorKey = '';
function renderEditor() {
  if (!current) return;
  const s = secs();
  const i = curSecIndex();
  const sec = s[i];
  const { info } = beatAtPosition();
  const key = `${i}|${info?.bar}|${JSON.stringify(current.map)}`;
  if (key === lastEditorKey) return;
  lastEditorKey = key;

  $('mapSummary').textContent = s.length > 1 ? `${s.length} bagian` : `${r1(sec.bpm)} BPM ${sec.bpb}/4`;
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.v === current.map.mode);
  $('offLabel').textContent = `${Math.round((current.map.offset || 0) * 1000)} ms`;

  const chips = $('secChips');
  chips.innerHTML = '';
  s.forEach((x, k) => {
    const c = document.createElement('button');
    c.className = 'chip' + (k === i ? ' on' : '');
    c.style.setProperty('--c', SEC_COLORS[k % SEC_COLORS.length]);
    c.innerHTML = `<b>${k + 1}</b> ${r1(x.bpm)} BPM · ${x.bpb}/4${x.gap ? ' · jeda' : ''}<small>${fmt(x.start)}</small>`;
    c.onclick = () => { player.seek(Math.max(0, x.start - (x.gap ? 2.5 : 0.05))); lastEditorKey = ''; renderEditor(); };
    chips.appendChild(c);
  });

  $('secTitle').textContent = `Bagian ${i + 1}${s.length > 1 ? ` dari ${s.length}` : ''} · ketukan "1" di ${fmtMs(sec.start)}`;
  $('secBpm').textContent = r1(sec.bpm).toFixed(1);
  for (const b of $('secBpb').children) b.classList.toggle('on', Number(b.dataset.v) === sec.bpb);
  $('gapRows').hidden = i === 0;
  $('secGap').checked = !!sec.gap;
  $('gapDetail').hidden = !sec.gap;
  for (const b of $('ciSeg').children) b.classList.toggle('on', Number(b.dataset.v) === (sec.countIn ?? 1));
  for (const b of $('gapClickSeg').children) b.classList.toggle('on', b.dataset.v === (sec.gapClick || 'silent'));
  $('secDelete').hidden = i === 0;

  const barRow = $('barRow');
  if (info && !info.count && info.lbar >= 0) {
    barRow.classList.remove('disabled');
    $('barLabel').textContent = `Bar ${info.bar}`;
    for (const b of $('barSeg').children) b.classList.toggle('on', Number(b.dataset.v) === info.beats);
  } else {
    barRow.classList.add('disabled');
    $('barLabel').textContent = info?.count ? 'Hitungan masuk' : 'Intro';
    for (const b of $('barSeg').children) b.classList.remove('on');
  }
  const odd = Object.entries(sec.odd || {});
  $('oddList').textContent = odd.length ? `Bar ganjil di bagian ini: ${odd.map(([k, v]) => `bar ke-${Number(k) + 1} (${v} ketukan)`).join(', ')}` : '';
  $('bpmLabel').textContent = `${r1(sec.bpm).toFixed(1).replace(/\.0$/, '')} BPM`;
}

function editSection(fn) {
  const s = secs();
  const i = curSecIndex();
  fn(s[i], i, s);
  current.map.sections = sortedSections(current.map);
  applyGrid();
}

function setSectionBpm(sec, bpm) {
  sec.bpm = Math.min(300, Math.max(30, Math.round(bpm * 1000) / 1000));
}

let taps = [];
function tap() {
  const playing = player.playing && !player.countingIn;
  const t = playing ? player.position : performance.now() / 1000;
  if (taps.length && (t - taps[taps.length - 1] > 2.5 || t < taps[taps.length - 1])) taps = [];
  taps.push(t);
  const btn = $('tapBtn');
  btn.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit');
  if (taps.length < 4) { btn.textContent = `TAP ${taps.length}/4`; return; }
  const n = taps.length;
  const mx = (n - 1) / 2;
  const my = taps.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (taps[i] - my); den += (i - mx) ** 2; }
  const per = num / den;
  if (!(per > 0.2 && per < 2)) return;
  editSection((sec, i, s) => {
    setSectionBpm(sec, 60 / per);
    if (playing) {
      // tap pertama = ketukan "1"
      const first = my - mx * per;
      const bar = per * sec.bpb;
      let start = first - Math.round((first - sec.start) / bar) * bar;
      const prevStart = i > 0 ? s[i - 1].start + 0.2 : -Infinity;
      while (start < prevStart) start += bar;
      sec.start = Math.max(0, start);
    }
  });
  btn.textContent = `TAP · ${r1(60 / per)} BPM`;
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
  if (!song.map) {
    song.map = mapFromLegacy(song);
    song.autoMap = clone(song.map);
    song.legacy = true;
  }
  current = song;
  taps = [];
  $('tapBtn').textContent = 'TAP';
  for (const name of song.stems) player.setTrack(name, { vol: 1, mute: false, solo: false, ...song.tracks[name] });
  player.setMetronome({ on: song.metro.on, vol: song.metro.vol });
  $('metroOn').checked = song.metro.on;
  $('countIn').checked = song.metro.countIn;
  $('metroVol').value = Math.round(song.metro.vol * 100);
  $('timeTotal').textContent = fmt(player.duration);
  $('legacyNote').hidden = !song.legacy;
  renderTracks();
  renderPresets();
  peaksCache = null;
  applyGrid(false);
  showView('player', song.title);
  recUi.loadSong().catch((err) => toast(`Gagal memuat rekaman: ${err.message}`));
}

function renderTracks() {
  const box = $('tracks');
  box.innerHTML = '';
  const names = [...current.stems, ...(recUi?.active ? ['take'] : [])];
  for (const name of names) {
    const info = STEM_INFO[name] || { label: name, color: '#999' };
    const t = player.tracks[name];
    const row = document.createElement('div');
    row.className = 'track' + (t.mute ? ' muted' : '') + (t.solo ? ' soloed' : '');
    row.style.setProperty('--c', info.color);
    row.innerHTML = `
      <span class="track-name">${info.label}</span>
      <button class="tbtn m ${t.mute ? 'on' : ''}">M</button>
      <button class="tbtn s ${t.solo ? 'on' : ''}">S</button>
      <input type="range" min="0" max="150" value="${Math.round(t.vol * 100)}">
      <span class="track-vol">${Math.round(t.vol * 100)}</span>`;
    const [mBtn, sBtn] = row.querySelectorAll('button');
    const range = row.querySelector('input');
    mBtn.onclick = () => updateTrack(name, { mute: !player.tracks[name].mute });
    sBtn.onclick = () => updateTrack(name, { solo: !player.tracks[name].solo });
    range.oninput = () => {
      row.querySelector('.track-vol').textContent = range.value;
      updateTrack(name, { vol: range.value / 100 }, false);
    };
    range.onchange = () => saveSong();
    box.appendChild(row);
  }
  box.classList.toggle('has-solo', Object.values(player.tracks).some((t) => t.solo));
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

function renderDots(n) {
  const box = $('beatDots');
  if (box.children.length === n) return;
  box.innerHTML = '';
  for (let i = 0; i < n; i++) {
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
    const { grid, legacy, ...song } = current;
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
  const D = player.duration || 1;
  if (!waveCache) {
    const bins = Math.floor(W / (3 * dpr));
    if (!peaksCache || peaksCache.length !== bins) peaksCache = player.peaks(bins);
    const band = 6 * dpr;
    const mk = (color, tick) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = color;
      const bw = W / bins;
      const area = H - band - 8 * dpr;
      for (let i = 0; i < bins; i++) {
        const ph = Math.max(2 * dpr, peaksCache[i] * (area - 6 * dpr));
        g.fillRect(i * bw + 0.5 * dpr, 6 * dpr + (area - ph) / 2, Math.max(1, bw - 1 * dpr), ph);
      }
      // garis ketukan "1" tiap bar
      g.fillStyle = tick;
      current.grid.info.forEach((b, i) => {
        if (b.beat !== 0) return;
        g.fillRect((current.grid.times[i] / D) * W, 0, 1 * dpr, 5 * dpr);
      });
      // pita warna per bagian tempo + tanda jeda
      const s = secs();
      s.forEach((sec, k) => {
        const x0 = k === 0 ? 0 : (sec.start / D) * W;
        const x1 = k + 1 < s.length ? (s[k + 1].start / D) * W : W;
        g.fillStyle = SEC_COLORS[k % SEC_COLORS.length];
        g.globalAlpha = 0.75;
        g.fillRect(x0, H - band, Math.max(1, x1 - x0 - 2 * dpr), band);
        g.globalAlpha = 1;
      });
      return c;
    };
    waveCache = { dim: mk('#3a3f4b', '#5b6170'), lit: mk('#ffb020', '#ffd27a') };
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(waveCache.dim, 0, 0);
  const x = (player.position / D) * W;
  if (x > 0) ctx.drawImage(waveCache.lit, 0, 0, x, H - 6 * dpr, 0, 0, x, H - 6 * dpr);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - dpr, 0, 2 * dpr, H);
}

function frame() {
  if (current && !$('playerView').hidden) {
    drawWave();
    const pos = player.position;
    $('timeNow').textContent = fmt(pos);
    document.body.classList.toggle('playing', player.playing);
    const { info } = beatAtPosition();
    const b = player.currentBeat();
    renderDots((b && player.ctx.currentTime - b.t < 1.5 ? b.len : info?.beats) || 4);
    if (player.countingIn) $('barInfo').textContent = 'Count-in…';
    else if (!info) $('barInfo').textContent = 'Bar 1';
    else if (info.count) $('barInfo').textContent = 'Hitungan masuk…';
    else $('barInfo').textContent = `Bar ${info.bar} · ${info.beat + 1}`;
    const dots = $('beatDots').children;
    for (let i = 0; i < dots.length; i++) {
      const on = b && b.n === i && player.ctx.currentTime - b.t < 0.18;
      dots[i].classList.toggle('lit', !!on);
      dots[i].classList.toggle('count', !!(on && b.count));
    }
    renderEditor();
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

// ---------- proses ulang deteksi ----------
async function reanalyze() {
  if (!confirm('Proses ulang deteksi tempo lagu ini?\n\nButuh internet, ±2–3 menit. Koreksi manual di Peta Tempo bakal diganti hasil deteksi baru.')) return;
  const song = current;
  const blobs = {};
  for (const stem of song.stems) {
    const blob = await db.getStem(song.id, stem);
    if (blob) blobs[stem] = blob;
  }
  runUpload({
    title: song.title,
    label: 'Lagi ngirim track buat proses ulang',
    send: (onP) => api.reanalyze(blobs, song.title, onP),
    onSent: async (job) => {
      const entry = { id: job.id, sha: job.sha, title: song.title, created: Date.now(), kind: 'reanalyze', songId: song.id };
      await addJob(entry);
      jobViews.set(job.id, { title: song.title, text: 'Proses ulang tempo: menunggu server GitHub…', progress: 0, cancellable: true });
      renderJobs();
      poll(entry);
      toast('Dikirim! Progress-nya kelihatan di daftar lagu.', 4000);
    },
  });
}

// ---------- ekspor ----------
const exportState = { kind: 'click', format: 'wav', stems: ['piano', 'other'], withClick: false, countIn: true, blob: null, name: '' };

function openExport() {
  const prefs = current.exportPrefs || {};
  Object.assign(exportState, { stems: ['piano', 'other'], ...prefs, blob: null });
  const take = recUi.active;
  for (const k of ['cover', 'take']) document.querySelector(`#exKindList label[data-k=${k}]`).hidden = !take;
  if (!take && (exportState.kind === 'cover' || exportState.kind === 'take')) exportState.kind = 'click';
  if (exportState.format === 'mp4' && !take?.hasVideo) exportState.format = 'mp3';
  if (take) {
    exportState.from = Math.max(0, take.startAt);
    exportState.to = Math.min(current.duration, take.startAt + take.duration);
    $('exFrom').value = fmtMs(exportState.from);
    $('exTo').value = fmtMs(exportState.to);
  }
  for (const [id, key, def] of [['coBalance', 'balance', true], ['coComp', 'comp', true], ['coReverb', 'reverb', false], ['coFadeIn', 'fadeIn', false], ['coFadeOut', 'fadeOut', true]]) {
    if (exportState[key] === undefined) exportState[key] = def;
    $(id).checked = exportState[key];
  }
  if (exportState.otherLevel === undefined) exportState.otherLevel = 1;
  for (const r of document.querySelectorAll('input[name=exKind]')) r.checked = r.value === exportState.kind;
  const box = $('exStems');
  box.innerHTML = '';
  for (const name of current.stems) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (exportState.stems.includes(name) ? ' on' : '');
    b.style.setProperty('--c', STEM_INFO[name]?.color || '#999');
    b.textContent = STEM_INFO[name]?.label || name;
    b.onclick = () => {
      const i = exportState.stems.indexOf(name);
      if (i >= 0) exportState.stems.splice(i, 1); else exportState.stems.push(name);
      b.classList.toggle('on', i < 0);
      updateExportUi();
    };
    box.appendChild(b);
  }
  $('exClick').checked = exportState.withClick;
  $('exCount').checked = exportState.countIn;
  $('exStatus').textContent = '';
  $('exDone').hidden = true;
  $('exGo').disabled = false;
  updateExportUi();
  $('exportDlg').showModal();
}

function updateExportUi() {
  const k = exportState.kind;
  const coverish = k === 'cover' || k === 'take';
  $('exStemsField').hidden = !(k === 'sq' || k === 'lr');
  $('exClickField').hidden = k !== 'mix';
  $('exCountField').hidden = coverish;
  $('coverOpts').hidden = !coverish;
  $('coOtherRow').hidden = k !== 'cover';
  $('coBalanceRow').hidden = k !== 'cover';
  for (const b of $('coOtherSeg').children) b.classList.toggle('on', Number(b.dataset.v) === exportState.otherLevel);
  const mp4 = $('exFormat').querySelector('[data-v=mp4]');
  mp4.hidden = !(k === 'cover' && recUi.active?.hasVideo);
  if (mp4.hidden && exportState.format === 'mp4') exportState.format = 'mp3';
  for (const b of $('exFormat').children) b.classList.toggle('on', b.dataset.v === exportState.format);
  const len = coverish ? Math.max(1, (exportState.to ?? current.duration) - (exportState.from ?? 0)) : current.duration;
  const mb = exportState.format === 'mp4' ? len * 1.05 : estimateSize(k === 'take' ? 'sq' : k, exportState.format, len);
  $('exSize').textContent = `Perkiraan ukuran file: ±${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  $('exGo').disabled = (k === 'sq' || k === 'lr') && !exportState.stems.length;
}

function exportGains() {
  const k = exportState.kind;
  const gains = {};
  const anySolo = Object.values(player.tracks).some((t) => t.solo);
  for (const name of current.stems) {
    if (k === 'mix') {
      const t = player.tracks[name] || { vol: 1 };
      gains[name] = t.mute || (anySolo && !t.solo) ? 0 : t.vol;
    } else {
      gains[name] = exportState.stems.includes(name) ? 1 : 0;
    }
  }
  return gains;
}

function parseTime(v, fallback) {
  const m = String(v).trim().match(/^(\d+):(\d{1,2}(?:[.,]\d+)?)$|^(\d+(?:[.,]\d+)?)$/);
  if (!m) return fallback;
  if (m[3] !== undefined) return Number(m[3].replace(',', '.'));
  return Number(m[1]) * 60 + Number(m[2].replace(',', '.'));
}

function takeGainForMix() {
  const t = player.tracks.take || { vol: 1 };
  const anySolo = Object.values(player.tracks).some((x) => x.solo);
  return t.mute || (anySolo && !t.solo) ? 0 : t.vol;
}

async function runCoverExport(name, status) {
  const k = exportState.kind;
  const take = recUi.active;
  const from = Math.max(0, Math.min(exportState.from, current.duration - 1));
  const to = Math.max(from + 1, Math.min(exportState.to, current.duration));
  const fmtKind = exportState.format;
  const share = fmtKind === 'mp4' ? 40 : fmtKind === 'mp3' ? 50 : 95;
  const { buffer, balance } = await renderCover({
    buffers: k === 'cover' ? player.buffers : {},
    guitarName: 'guitar',
    take: { buffer: recUi.activeBuffer, startAt: recUi.effStart(take), gain: player.tracks.take?.vol ?? 1 },
    from, to,
    otherLevel: exportState.otherLevel,
    autoBalance: k === 'cover' && exportState.balance,
    compressor: exportState.comp,
    reverb: exportState.reverb,
    fadeIn: exportState.fadeIn,
    fadeOut: exportState.fadeOut,
    onProgress: (p) => status(`Lagi bikin file "${name}"… ${Math.round(p * share)}%`),
  });
  if (k === 'cover' && exportState.balance) console.info('cover balance', balance);
  if (fmtKind === 'wav') return toWav(buffer);
  if (fmtKind === 'mp3') return toMp3(buffer, (p) => status(`Lagi bikin file "${name}"… ${50 + Math.round(p * 49)}%`));
  // MP4: video kamera + audio cover
  const videoBlob = await db.getBlob(`video:${take.id}`);
  if (!videoBlob) throw new Error('Video take ini nggak ketemu');
  const mime = pickVideoMime();
  if (!mime) throw new Error('HP ini nggak bisa bikin video dari browser');
  const size = take.quality === '720' ? { w: 720, h: 1280 } : { w: 1080, h: 1920 };
  status(`Lagi bikin video "${name}"… 40% — layar harus tetap nyala`);
  const blob = await composeVideo({
    videoBlob, videoStartAt: recUi.effVideoStart(take), from, to, audio: buffer, mime, size,
    onProgress: (p) => status(`Lagi bikin video "${name}"… ${40 + Math.round(p * 59)}% — layar harus tetap nyala`),
  });
  exportState.note = mime.startsWith('video/mp4')
    ? (mime.includes('mp4a') ? '' : ' (audio Opus — kalau IG/TikTok nolak, kabarin ya)')
    : ' (format WebM — IG/TikTok mungkin nolak, HP ini nggak bisa bikin MP4)';
  return blob;
}

async function runExport() {
  const k = exportState.kind;
  current.exportPrefs = {
    kind: k, format: exportState.format, stems: [...exportState.stems], withClick: exportState.withClick, countIn: exportState.countIn,
    balance: exportState.balance, comp: exportState.comp, reverb: exportState.reverb, fadeIn: exportState.fadeIn, fadeOut: exportState.fadeOut, otherLevel: exportState.otherLevel,
  };
  exportState.from = parseTime($('exFrom').value, exportState.from);
  exportState.to = parseTime($('exTo').value, exportState.to);
  exportState.note = '';
  saveSong();
  const safeTitle = current.title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Lagu';
  const take = recUi.active;
  const suffix = (k === 'cover' || k === 'take') && take ? ` (${take.name})` : '';
  const ext = exportState.format === 'mp4' ? (pickVideoMime().startsWith('video/mp4') ? 'mp4' : 'webm') : exportState.format;
  const name = `${safeTitle} - ${KINDS[k]}${suffix}.${ext}`;
  const key = 'export';
  $('exGo').disabled = true;
  $('exDone').hidden = true;
  const status = (t) => { $('exStatus').textContent = t; busySet(key, t); };
  try {
    player.pause();
    keepAwake(true);
    status(`Lagi bikin file "${name}"… 0%`);
    let blob;
    if (k === 'cover' || k === 'take') {
      blob = await runCoverExport(name, status);
    } else {
    const buf = await renderMix({
      buffers: player.buffers,
      gains: exportGains(),
      grid: current.grid,
      kind: k,
      withClick: exportState.withClick,
      countIn: exportState.countIn,
      clickVol: current.metro.vol,
      duration: player.duration,
      extra: recUi.activeBuffer ? { buffer: recUi.activeBuffer, startAt: recUi.effStart(recUi.active), gain: k === 'mix' ? takeGainForMix() : 0 } : null,
      onProgress: (p) => status(`Lagi bikin file "${name}"… ${Math.round(p * (exportState.format === 'mp3' ? 50 : 95))}%`),
    });
    if (exportState.format === 'mp3') {
      blob = await toMp3(buf, (p) => status(`Lagi bikin file "${name}"… ${50 + Math.round(p * 49)}%`));
    } else {
      blob = toWav(buf);
    }
    }
    exportState.blob = blob;
    exportState.name = name;
    saveBlob(blob, name);
    $('exStatus').textContent = `✅ "${name}" (${(blob.size / 1048576).toFixed(1)} MB) tersimpan di folder Download.${exportState.note || ''}`;
    $('exDone').hidden = false;
    busyEnd(key, true, '✅ File tersimpan di folder Download', 'Aplikasi boleh ditutup.');
  } catch (err) {
    $('exStatus').textContent = `Gagal bikin file: ${err.message}`;
    busyEnd(key, false);
  } finally {
    $('exGo').disabled = false;
    keepAwake(false);
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function shareBlob() {
  const { blob, name } = exportState;
  if (!blob) return;
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch { /* dibatalkan */ }
  } else {
    toast('HP ini nggak bisa share langsung. File udah ada di folder Download.', 4000);
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
  recUi.unload();
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

const cleanRepo = (v) => v.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');

// ---------- event ----------
function seg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.v !== undefined) fn(b.dataset.v);
  });
}

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

  // --- peta tempo
  seg('modeSeg', (v) => { current.map.mode = v; applyGrid(); toast(v === 'steady' ? 'Klik: tempo rata per bagian' : 'Klik: ngikutin pukulan drum'); });
  $('offMinus').onclick = () => { current.map.offset = Math.round(((current.map.offset || 0) - 0.01) * 1000) / 1000; applyGrid(); };
  $('offPlus').onclick = () => { current.map.offset = Math.round(((current.map.offset || 0) + 0.01) * 1000) / 1000; applyGrid(); };
  $('bpmM1').onclick = () => editSection((s) => setSectionBpm(s, s.bpm - 1));
  $('bpmM01').onclick = () => editSection((s) => setSectionBpm(s, s.bpm - 0.1));
  $('bpmP01').onclick = () => editSection((s) => setSectionBpm(s, s.bpm + 0.1));
  $('bpmP1').onclick = () => editSection((s) => setSectionBpm(s, s.bpm + 1));
  $('secHalf').onclick = () => editSection((s) => {
    setSectionBpm(s, s.bpm / 2);
    s.odd = Object.fromEntries(Object.entries(s.odd || {}).map(([k, v]) => [k, Math.max(1, Math.round(v / 2))]));
  });
  $('secDouble').onclick = () => editSection((s) => {
    setSectionBpm(s, s.bpm * 2);
    s.odd = Object.fromEntries(Object.entries(s.odd || {}).map(([k, v]) => [k, Math.min(7, v * 2)]));
  });
  seg('secBpb', (v) => editSection((s) => { s.bpb = Number(v); s.odd = {}; }));
  $('secBeatPrev').onclick = () => editSection((s) => { s.start = Math.max(0, s.start - 60 / s.bpm); });
  $('secBeatNext').onclick = () => editSection((s) => { s.start += 60 / s.bpm; });
  $('secMsPrev').onclick = () => editSection((s) => { s.start = Math.max(0, s.start - 0.01); });
  $('secMsNext').onclick = () => editSection((s) => { s.start += 0.01; });
  $('secGap').onchange = (e) => editSection((s) => { s.gap = e.target.checked; });
  seg('ciSeg', (v) => editSection((s) => { s.countIn = Number(v); }));
  seg('gapClickSeg', (v) => editSection((s) => { s.gapClick = v; }));
  $('secDelete').onclick = () => {
    const i = curSecIndex();
    if (i === 0 || !confirm(`Hapus bagian ${i + 1}? Tempo bagian sebelumnya bakal lanjut sampai sini.`)) return;
    current.map.sections.splice(i, 1);
    applyGrid();
  };
  $('secNew').onclick = () => {
    const s = secs();
    const i = curSecIndex();
    const pos = player.position;
    if (pos - s[i].start < 0.3) { toast('Geser dulu ke titik tempo berubah (ketukan "1" bagian baru)'); return; }
    s.push({ start: pos, bpm: s[i].bpm, bpb: s[i].bpb, odd: {}, gap: false, countIn: 1, gapClick: 'silent' });
    applyGrid();
    toast('Bagian baru dibuat. Atur BPM-nya, atau TAP sambil lagu diputar.', 4000);
  };
  seg('barSeg', (v) => {
    const { info } = beatAtPosition();
    if (!info || info.count || info.lbar < 0) return;
    const sec = secs()[info.sec];
    sec.odd = sec.odd || {};
    if (Number(v) === sec.bpb) delete sec.odd[info.lbar];
    else sec.odd[info.lbar] = Number(v);
    applyGrid();
  });
  $('tapBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
  $('mapReset').onclick = () => {
    if (!confirm('Buang semua koreksi dan balik ke hasil deteksi otomatis?')) return;
    current.map = clone(current.autoMap || mapFromLegacy(current));
    taps = [];
    $('tapBtn').textContent = 'TAP';
    applyGrid();
    toast('Peta tempo balik ke hasil deteksi');
  };
  $('mapReanalyze').onclick = reanalyze;
  $('legacyReanalyze').onclick = reanalyze;

  // --- ekspor
  $('exportBtn').onclick = openExport;
  document.querySelectorAll('input[name=exKind]').forEach((r) => {
    r.onchange = () => { exportState.kind = r.value; updateExportUi(); };
  });
  seg('exFormat', (v) => { exportState.format = v; updateExportUi(); });
  $('exClick').onchange = (e) => { exportState.withClick = e.target.checked; };
  $('exCount').onchange = (e) => { exportState.countIn = e.target.checked; };
  $('exGo').onclick = runExport;
  for (const [id, key] of [['coBalance', 'balance'], ['coComp', 'comp'], ['coReverb', 'reverb'], ['coFadeIn', 'fadeIn'], ['coFadeOut', 'fadeOut']]) {
    $(id).onchange = (e) => { exportState[key] = e.target.checked; };
  }
  seg('coOtherSeg', (v) => { exportState.otherLevel = Number(v); updateExportUi(); });
  $('exFromNow').onclick = () => { $('exFrom').value = fmtMs(player.position); };
  $('exToNow').onclick = () => { $('exTo').value = fmtMs(player.position); };
  $('exFrom').onchange = () => { exportState.from = parseTime($('exFrom').value, exportState.from); updateExportUi(); };
  $('exTo').onchange = () => { exportState.to = parseTime($('exTo').value, exportState.to); updateExportUi(); };
  $('exSave').onclick = () => exportState.blob && saveBlob(exportState.blob, exportState.name);
  $('exShare').onclick = shareBlob;

  // --- pengaturan
  $('settingsBtn').onclick = openSettings;
  $('checkBtn').onclick = () => {
    settings.token = $('setToken').value.trim();
    settings.repo = cleanRepo($('setRepo').value);
    checkConnection();
  };
  $('settingsDlg').addEventListener('close', () => {
    if ($('settingsDlg').returnValue !== 'save') return;
    settings.repo = cleanRepo($('setRepo').value);
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
const recUi = createRecUi({
  player, settings, saveSettings, toast, busySet, busyEnd, keepAwake, fmt,
  getCurrent: () => current, renderTracks: () => current && renderTracks(), saveSong, togglePlay,
});
recUi.recover().catch(() => {});
if (new URLSearchParams(location.search).has('debug')) window.__rl = { player, recUi };
bind();
resumeJobs();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
