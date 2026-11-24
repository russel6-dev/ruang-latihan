// Mode rekaman: panel di layar lagu, layar saat merekam, kalibrasi, daftar take, pemulihan.
import { db } from './db.js';
import { Recorder, TakeWriter, wavHeader, openCamera, pickCameraMime } from './recorder.js';

const $ = (id) => document.getElementById(id);

export function createRecUi(app) {
  const { player, settings, saveSettings, toast, busySet, busyEnd, keepAwake, fmt } = app;
  const recorder = new Recorder(player);
  let takes = [];
  let selected = null;     // take yang lagi diatur (geser rekaman/video)
  let buffers = new Map(); // id -> AudioBuffer (hanya take yang nyala)
  let rec = null;          // state saat merekam
  let clipUntil = 0;

  settings.latency = settings.latency || {};
  settings.rec = { setup: 'usb', video: 'none', quality: '1080', role: 'guitar', ...(settings.rec || {}) };
  if (settings.videoLag === undefined) settings.videoLag = 0;

  const song = () => app.getCurrent();
  const setupKey = () => settings.rec.setup;
  const latencyFor = () => settings.latency[setupKey()];

  // ---------------- input & meter
  recorder.onMeter = (peak) => {
    const db = peak > 0 ? 20 * Math.log10(peak) : -90;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    if (peak > 0.97) clipUntil = performance.now() + 1500;
    const clip = performance.now() < clipUntil;
    for (const id of ['recMeter', 'ovMeter']) {
      const el = $(id);
      if (!el) continue;
      el.style.width = `${pct}%`;
      el.classList.toggle('clip', clip);
    }
    $('recClip').hidden = !clip;
  };

  async function openInput() {
    try {
      const info = await recorder.open();
      $('recInputName').textContent = info.label;
      $('recInputBtn').hidden = true;
      $('recMeterWrap').hidden = false;
      const warn = [];
      if (!info.processingOff) warn.push('⚠️ HP ini nggak mau matiin peredam suara bawaan — sustain gitar bisa kepotong. Kalau kedengeran aneh, coba setup lain.');
      if (info.sampleRate && info.sampleRate !== player.ctx.sampleRate) warn.push(`Input ${info.sampleRate / 1000} kHz, aplikasi ${player.ctx.sampleRate / 1000} kHz (otomatis disesuaikan).`);
      $('recWarn').textContent = warn.join('\n');
      return info;
    } catch (err) {
      $('recInputName').textContent = `❌ ${err.name === 'NotAllowedError' ? 'Izin mic ditolak — izinkan di pengaturan Chrome' : err.message}`;
      throw err;
    }
  }

  function renderSetup() {
    for (const b of $('recSetupSeg').children) b.classList.toggle('on', b.dataset.v === settings.rec.setup);
    for (const b of $('recVideoSeg').children) b.classList.toggle('on', b.dataset.v === settings.rec.video);
    for (const b of $('recQualitySeg').children) b.classList.toggle('on', b.dataset.v === settings.rec.quality);
    for (const b of $('recRoleSeg').children) b.classList.toggle('on', b.dataset.v === settings.rec.role);
    $('recQualityRow').hidden = settings.rec.video === 'none';
    const L = latencyFor();
    $('recLatency').textContent = L === undefined ? 'belum dikalibrasi' : `${Math.round(L * 1000)} ms`;
    $('recSetupHint').innerHTML = settings.rec.setup === 'usb'
      ? 'Colok Pocket Amp ke HP pakai kabel USB-C data. <b>Headphone dicolok ke Pocket Amp.</b> LOOPBACK harus <b>mati</b> waktu rekam.'
      : 'HP ditaruh ±30–50 cm dari speaker ampli. <b>Pakai earphone kabel tanpa mic</b> supaya lagu nggak ikut kerekam.';
  }

  // ---------------- daftar take (multitrack)
  async function loadSong() {
    takes = await db.listTakes(song().id);
    // migrasi take versi lama (sebelum multitrack)
    for (const t of takes) {
      if (t.on !== undefined) continue;
      t.on = song().activeTake ? t.id === song().activeTake : t === takes[takes.length - 1];
      Object.assign(t, { role: 'guitar', vol: song().tracks?.take?.vol ?? 1, mute: false, solo: false, pan: 0 });
      await db.putTake(t);
    }
    selected = takes.find((t) => t.id === song().selectedTake) || takes[takes.length - 1] || null;
    buffers = new Map();
    await syncPlayer();
    renderSetup();
    renderTakes();
  }

  const effStart = (t) => t.startAt + (t.offset || 0) / 1000;
  const effVideoStart = (t) => t.videoStartAt + (t.videoOffset || 0) / 1000;
  const onTakes = () => takes.filter((t) => t.on);

  async function syncPlayer() {
    const on = onTakes();
    for (const id of [...buffers.keys()]) if (!on.some((t) => t.id === id)) buffers.delete(id); // lepas memori
    for (const t of on) {
      if (buffers.has(t.id)) continue;
      const blob = await db.getBlob(`take:${t.id}`);
      if (blob) buffers.set(t.id, await player.ctx.decodeAudioData(await blob.arrayBuffer()));
    }
    const live = on.filter((t) => buffers.has(t.id));
    player.setExtras(live.map((t) => ({ id: t.id, buffer: buffers.get(t.id), startAt: effStart(t), pan: t.pan || 0 })));
    for (const k of Object.keys(player.tracks)) if (k.startsWith('take:') && !live.some((t) => `take:${t.id}` === k)) delete player.tracks[k];
    for (const t of live) player.setTrack(`take:${t.id}`, { vol: t.vol ?? 1, mute: !!t.mute, solo: !!t.solo });
    app.renderTracks();
  }

  // Dipanggil mixer: ubah volume/mute/solo/pan take (disimpan per take).
  async function updateTakeMix(id, patch) {
    const t = takes.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    if ('pan' in patch) player.setPan(id, t.pan);
    else player.setTrack(`take:${id}`, { vol: t.vol ?? 1, mute: !!t.mute, solo: !!t.solo });
    clearTimeout(t._save);
    t._save = setTimeout(() => { const { _save, ...rest } = t; db.putTake(rest); }, 300);
  }

  async function setOn(t, on) {
    t.on = on;
    await db.putTake(stripTake(t));
    await syncPlayer();
    renderTakes();
  }

  const stripTake = (t) => { const { _save, ...rest } = t; return rest; };

  // Nyalakan semua take favorit (atau semua take kalau belum ada favorit), matikan track asli yang digantikan.
  async function useAllTakes() {
    if (!takes.length) { toast('Belum ada take di lagu ini'); return; }
    const favs = takes.filter((t) => t.fav);
    const pick = favs.length ? favs : takes;
    for (const t of takes) { t.on = pick.includes(t); t.mute = false; t.solo = false; await db.putTake(stripTake(t)); }
    await syncPlayer();
    app.muteStems([...new Set(pick.map((t) => t.role).filter((r) => r && r !== 'extra'))]);
    renderTakes();
    toast(`${pick.length} take dinyalain${favs.length ? ' (yang ⭐)' : ''}, track asli yang digantiin dimatiin.`);
  }

  function renderTakes() {
    const box = $('takeList');
    box.innerHTML = '';
    $('takeEmpty').hidden = takes.length > 0;
    $('takesAll').hidden = takes.length === 0;
    for (const t of takes) {
      const el = document.createElement('div');
      el.className = 'take' + (t.on ? ' live' : '') + (selected?.id === t.id ? ' sel' : '');
      el.innerHTML = `
        <label class="take-on" title="Nyalakan di mixer"><input type="checkbox" ${t.on ? 'checked' : ''}><span></span></label>
        <button class="take-main">
          <span class="take-name">${t.fav ? '⭐ ' : ''}${escapeHtml(t.name)}${t.hasVideo ? ' 🎥' : ''}</span>
          <span class="take-meta">${ROLE_LABEL[t.role] || 'Gitar'} · mulai ${fmt(Math.max(0, t.startAt))} · ${fmt(t.duration)}</span>
        </button>
        <div class="take-tools">
          <select class="take-role" aria-label="Alat / menggantikan track">
            ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${t.role === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="icon-btn small" data-a="play" aria-label="Putar dari awal take">▶</button>
          <button class="icon-btn small" data-a="fav" aria-label="Favorit">${t.fav ? '★' : '☆'}</button>
          <button class="icon-btn small" data-a="ren" aria-label="Ganti nama">✎</button>
          <button class="icon-btn small" data-a="del" aria-label="Hapus">🗑</button>
        </div>`;
      el.querySelector('.take-on input').onchange = (e) => setOn(t, e.target.checked);
      el.querySelector('.take-main').onclick = () => { selected = t; song().selectedTake = t.id; app.saveSong(); renderTakes(); };
      el.querySelector('.take-role').onchange = async (e) => { t.role = e.target.value; await db.putTake(stripTake(t)); renderTakes(); app.renderTracks(); };
      el.querySelector('[data-a=play]').onclick = async () => {
        if (!t.on) await setOn(t, true);
        selected = t;
        renderTakes();
        player.seek(Math.max(0, t.startAt - 1));
        if (!player.playing) app.togglePlay();
      };
      el.querySelector('[data-a=fav]').onclick = async () => { t.fav = !t.fav; await db.putTake(stripTake(t)); renderTakes(); };
      el.querySelector('[data-a=ren]').onclick = async () => {
        const name = prompt('Nama take:', t.name);
        if (name && name.trim()) { t.name = name.trim().slice(0, 60); await db.putTake(stripTake(t)); renderTakes(); app.renderTracks(); }
      };
      el.querySelector('[data-a=del]').onclick = async () => {
        if (!confirm(`Hapus "${t.name}"? Nggak bisa dibalikin.`)) return;
        await db.deleteTake(t);
        takes = takes.filter((x) => x.id !== t.id);
        if (selected?.id === t.id) selected = takes[takes.length - 1] || null;
        await syncPlayer();
        renderTakes();
      };
      box.appendChild(el);
    }
    const a = selected;
    $('takeAdjust').hidden = !a;
    if (a) {
      $('takeAdjustName').textContent = a.name;
      $('takeOffset').textContent = `${a.offset || 0} ms`;
      $('videoAdjust').hidden = !a.hasVideo;
      $('videoOffsetLabel').textContent = `${a.videoOffset || 0} ms`;
    }
  }

  async function nudgeTake(ms) {
    if (!selected) return;
    selected.offset = (selected.offset || 0) + ms;
    await db.putTake(stripTake(selected));
    if (selected.on) await syncPlayer();
    renderTakes();
  }

  async function nudgeVideo(ms) {
    if (!selected) return;
    selected.videoOffset = (selected.videoOffset || 0) + ms;
    await db.putTake(stripTake(selected));
    renderTakes();
  }

  // ---------------- kalibrasi
  async function calibrate() {
    const method = $('calDlg').dataset.method || 'loopback';
    $('calResult').textContent = 'Siap-siap…';
    $('calGo').disabled = true;
    try {
      await openInput();
      if (player.playing) player.pause();
      const r = await recorder.calibrate(method, (k, n) => { $('calResult').textContent = `Klik ${k}/${n}…`; });
      if (!r.found) {
        $('calResult').textContent = method === 'loopback'
          ? '❌ Klik nggak kedengeran di input. Pastikan LOOPBACK di Pocket Amp NYALA dan Pocket Amp terhubung, lalu coba lagi.'
          : '❌ Ketukan nggak kedengeran. Ketuk senar lebih keras (atau naikin volume Pocket Amp/ampli), lalu coba lagi.';
      } else if (!r.ok) {
        $('calResult').textContent = `⚠️ Hasil nggak stabil (ketemu ${r.found}/${r.n}, selisih ${Math.round(r.spread * 1000)} ms). Coba lagi${method === 'tap' ? ' — ketuk pas barengan klik' : ''}.`;
      } else {
        settings.latency[setupKey()] = r.latency;
        saveSettings();
        renderSetup();
        $('calResult').textContent = `✅ Delay ${Math.round(r.latency * 1000)} ms (stabil ±${Math.max(1, Math.round(r.spread * 500))} ms). Disimpan.${method === 'loopback' ? '\n👉 Sekarang MATIKAN LOOPBACK di Pocket Amp sebelum rekam.' : ''}`;
      }
    } catch (err) {
      $('calResult').textContent = `❌ ${err.message}`;
    } finally {
      $('calGo').disabled = false;
    }
  }

  function renderCalMethod() {
    const m = $('calDlg').dataset.method || 'loopback';
    for (const b of $('calMethodSeg').children) b.classList.toggle('on', b.dataset.v === m);
    $('calSteps').innerHTML = m === 'loopback'
      ? '<li>Colok Pocket Amp, pakai headphone di Pocket Amp.</li><li><b>Nyalain LOOPBACK</b> di Pocket Amp.</li><li>Ketuk <b>Mulai</b>, diam aja (jangan main gitar) selama 8 klik.</li><li>Setelah selesai, <b>matiin LOOPBACK</b> lagi.</li>'
      : '<li>Redam semua senar pakai tangan kiri.</li><li>Ketuk <b>Mulai</b>, lalu petik senar yang diredam ("cek") <b>pas barengan</b> tiap klik yang kamu dengar (8 kali).</li><li>Ulangi kalau hasilnya belum stabil.</li>';
  }

  // ---------------- merekam
  async function startRecording() {
    const s = song();
    if (!s || rec) return;
    if (player.playing) player.pause();
    let info;
    try { info = await openInput(); } catch { return; }

    // baterai
    try {
      const bat = await navigator.getBattery?.();
      if (bat && !bat.charging && bat.level < 0.2 && !confirm(`Baterai HP tinggal ${Math.round(bat.level * 100)}%. Rekaman${settings.rec.video !== 'none' ? ' + kamera' : ''} boros baterai. Tetap rekam?`)) return;
    } catch { /* abaikan */ }

    // ruang penyimpanan
    try {
      const est = await navigator.storage?.estimate?.();
      const free = est ? est.quota - est.usage : Infinity;
      const need = settings.rec.video !== 'none' ? 400e6 : 60e6;
      if (free < need && !confirm('Ruang penyimpanan aplikasi hampir penuh. Hapus take lama dulu? (OK = tetap rekam)')) return;
    } catch { /* abaikan */ }

    // loopback / suara HP bocor ke input
    $('recStatus').textContent = 'Ngecek input…';
    try {
      const lb = await recorder.checkLoopback();
      if (lb.detected) {
        const msg = settings.rec.setup === 'usb'
          ? 'Suara dari HP ikut masuk ke rekaman — kayaknya LOOPBACK di Pocket Amp masih NYALA.\nMatiin dulu supaya lagu & klik nggak ikut kerekam.\n\nOK = rekam aja, Batal = berhenti'
          : 'Mic HP nangkep suara lagu dari speaker HP.\nPakai earphone kabel supaya lagu nggak ikut kerekam.\n\nOK = rekam aja, Batal = berhenti';
        if (!confirm(msg)) { $('recStatus').textContent = ''; return; }
      }
    } catch { /* lanjut */ }
    $('recStatus').textContent = '';

    let L = latencyFor();
    if (L === undefined) {
      const est = (player.ctx.outputLatency || player.ctx.baseLatency || 0.02) + 0.03;
      if (!confirm(`Setup ini belum dikalibrasi, rekaman bisa telat ±50–150 ms dari lagu.\nKamu masih bisa geser manual nanti.\n\nOK = rekam aja (pakai perkiraan ${Math.round(est * 1000)} ms), Batal = kalibrasi dulu`)) {
        openCalibration();
        return;
      }
      L = est;
    }

    const id = `t${Date.now().toString(36)}`;
    const sr = player.ctx.sampleRate;
    const number = takes.length + 1;
    rec = { id, L, sr, number, role: settings.rec.role, videoChunks: 0, video: settings.rec.video, quality: settings.rec.quality, startedAt: Date.now() };

    // kamera (opsional)
    if (rec.video !== 'none') {
      try {
        rec.cam = await openCamera(rec.video, rec.quality);
        $('ovVideo').srcObject = rec.cam;
        $('ovVideo').hidden = false;
        await $('ovVideo').play().catch(() => {});
        const mime = pickCameraMime();
        rec.videoMime = mime;
        rec.vrec = new MediaRecorder(rec.cam, { mimeType: mime || undefined, videoBitsPerSecond: rec.quality === '720' ? 4_000_000 : 7_000_000 });
        rec.vsaving = Promise.resolve();
        rec.vrec.ondataavailable = (e) => {
          if (!e.data.size) return;
          const i = rec.videoChunks++;
          rec.vsaving = rec.vsaving.then(() => db.putBlob(`vchunk:${id}:${i}`, e.data));
        };
        rec.vrec.onstart = () => { rec.vStartCtx = player.ctx.currentTime; };
      } catch (err) {
        if (!confirm(`Kamera nggak bisa dibuka (${err.message}). Rekam audio aja?`)) { rec = null; return; }
        rec.video = 'none';
      }
    } else {
      $('ovVideo').hidden = true;
    }

    rec.writer = new TakeWriter(null, sr, (i, blob) => db.putBlob(`rchunk:${id}:${i}`, blob));
    await db.set('recording', { id, songId: song().id, sr, number, L, role: rec.role, created: Date.now(), video: rec.video !== 'none', videoMime: rec.videoMime, quality: rec.quality });

    // Overdub: take lain yang nyala tetap kedengeran di headphone (nggak ikut kerekam selama LOOPBACK mati).
    showOverlay(true);
    busySet('rec', `Lagi merekam "${song().title}"…`);
    keepAwake(true);
    recorder.startCapture((ch) => {
      if (rec.writer.channels == null) {
        rec.writer.channels = Math.min(2, ch.length);
        db.get('recording').then((m) => m && db.set('recording', { ...m, channels: rec.writer.channels }));
      }
      rec.writer.push(ch);
    });
    if (rec.vrec) rec.vrec.start(1000);
    await player.play(s.metro.countIn);
    rec.startPos = player.startPos;
    rec.startCtx = player.startCtx;
    await db.set('recording', { ...(await db.get('recording')), startPos: rec.startPos, startCtx: rec.startCtx });
    player.onEnded = () => stopRecording();
    tickOverlay();
  }

  function tickOverlay() {
    if (!rec) return;
    const secs = (Date.now() - rec.startedAt) / 1000;
    $('ovTime').textContent = fmt(secs);
    $('ovBar').textContent = player.countingIn ? 'Count-in…' : $('barInfo').textContent;
    requestAnimationFrame(tickOverlay);
  }

  async function stopRecording() {
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    const r = rec;
    player.onEnded = () => keepAwake(false);
    player.pause();
    $('ovStop').disabled = true;
    $('ovStatus').textContent = 'Nyimpen rekaman…';
    const cap = await recorder.stopCapture();
    const chunks = await r.writer.finish();
    if (r.vrec && r.vrec.state !== 'inactive') {
      await new Promise((res) => { r.vrec.onstop = res; r.vrec.stop(); setTimeout(res, 4000); });
      await r.vsaving;
    }
    r.cam?.getTracks().forEach((t) => t.stop());

    const startAt = r.startPos + (cap?.startFrame ?? 0) / r.sr - r.L - r.startCtx;
    const take = await finalizeTake({
      id: r.id, songId: song().id, number: r.number, sr: r.sr, channels: r.writer.channels || 1, role: r.role,
      frames: r.writer.frames, chunks, startAt, L: r.L,
      video: r.video !== 'none' && r.videoChunks > 0, videoChunks: r.videoChunks, videoMime: r.videoMime, quality: r.quality,
      videoStartAt: r.vStartCtx !== undefined ? r.startPos + (r.vStartCtx - r.startCtx) - (settings.videoLag || 0) / 1000 : startAt,
    });
    rec = null;
    showOverlay(false);
    $('ovStop').disabled = false;
    keepAwake(false);
    takes.push(take);
    selected = take;
    song().selectedTake = take.id;
    await syncPlayer();
    renderTakes();
    busyEnd('rec', true, `✅ ${take.name} tersimpan`, 'Aplikasi boleh ditutup. Dengerin hasilnya di mixer.');
  }

  async function finalizeTake(o) {
    const keys = [];
    for (let i = 0; i < o.chunks; i++) keys.push(`rchunk:${o.id}:${i}`);
    const parts = [];
    for (const k of keys) { const b = await db.getBlob(k); if (b) parts.push(b); }
    const bytes = parts.reduce((n, b) => n + b.size, 0);
    const frames = Math.floor(bytes / (2 * o.channels));
    await db.putBlob(`take:${o.id}`, new Blob([wavHeader(frames, o.channels, o.sr), ...parts], { type: 'audio/wav' }));
    await db.deleteBlobs(keys);
    let hasVideo = false;
    if (o.video) {
      const vkeys = [];
      for (let i = 0; i < o.videoChunks; i++) vkeys.push(`vchunk:${o.id}:${i}`);
      const vparts = [];
      for (const k of vkeys) { const b = await db.getBlob(k); if (b) vparts.push(b); }
      if (vparts.length) {
        await db.putBlob(`video:${o.id}`, new Blob(vparts, { type: (o.videoMime || 'video/webm').split(';')[0] }));
        hasVideo = true;
      }
      await db.deleteBlobs(vkeys);
    }
    const take = {
      id: o.id, songId: o.songId, name: `Take ${o.number}${o.recovered ? ' (dipulihkan)' : ''}`, created: Date.now(),
      startAt: o.startAt, duration: frames / o.sr, sampleRate: o.sr, channels: o.channels, latency: o.L,
      offset: 0, fav: false, hasVideo, videoStartAt: o.videoStartAt, videoOffset: 0, videoMime: o.videoMime, quality: o.quality,
      on: true, role: o.role || 'guitar', vol: 1, mute: false, solo: false, pan: 0,
    };
    await db.putTake(take);
    await db.set('recording', null);
    return take;
  }

  // Rekaman yang kepotong (aplikasi ketutup / HP mati saat merekam) dipulihkan dari potongan yang sudah tersimpan.
  async function recover() {
    const r = await db.get('recording');
    if (!r) return;
    const rkeys = await db.blobKeys(`rchunk:${r.id}:`);
    const vkeys = await db.blobKeys(`vchunk:${r.id}:`);
    if (!rkeys.length) { await db.set('recording', null); await db.deleteBlobs(vkeys); return; }
    const ch = r.channels || 1;
    const startAt = r.startPos ?? 0;
    rkeys.sort((a, b) => Number(a.split(':')[2]) - Number(b.split(':')[2]));
    await finalizeTake({
      id: r.id, songId: r.songId, number: r.number ?? '', sr: r.sr, channels: ch, chunks: rkeys.length, startAt, L: r.L, role: r.role,
      video: r.video && vkeys.length > 0, videoChunks: vkeys.length, videoMime: r.videoMime, quality: r.quality,
      videoStartAt: startAt, recovered: true,
    });
    toast('Rekaman yang kepotong berhasil dipulihkan (cek posisinya, mungkin perlu digeser).', 6000);
  }

  function showOverlay(on) {
    $('recOverlay').hidden = !on;
    document.body.classList.toggle('recording', on);
    $('ovStatus').textContent = '';
    if (!on) { $('ovVideo').srcObject = null; }
  }

  function openCalibration() {
    $('calDlg').dataset.method = settings.rec.setup === 'usb' ? 'loopback' : 'tap';
    renderCalMethod();
    $('calResult').textContent = '';
    $('calDlg').showModal();
  }

  // ---------------- event
  function bind() {
    $('recInputBtn').onclick = () => openInput().catch(() => {});
    $('recSetupSeg').onclick = (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      settings.rec.setup = v; saveSettings(); renderSetup();
    };
    $('recVideoSeg').onclick = (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      settings.rec.video = v; saveSettings(); renderSetup();
    };
    $('recQualitySeg').onclick = (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      settings.rec.quality = v; saveSettings(); renderSetup();
    };
    $('recCalBtn').onclick = openCalibration;
    $('calMethodSeg').onclick = (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      $('calDlg').dataset.method = v; renderCalMethod();
    };
    $('calGo').onclick = calibrate;
    $('recBtn').onclick = startRecording;
    $('ovStop').onclick = stopRecording;
    $('takeMinus').onclick = () => nudgeTake(-10);
    $('takePlus').onclick = () => nudgeTake(10);
    $('videoMinus').onclick = () => nudgeVideo(-20);
    $('videoPlus').onclick = () => nudgeVideo(20);
    $('recRoleSeg').onclick = (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (!v) return;
      settings.rec.role = v; saveSettings(); renderSetup();
      if (v === 'vocals' && settings.rec.setup === 'usb') toast('Vokal: pakai setup "Mic HP" + earphone (kecuali kamu punya mic USB).', 4500);
    };
    $('takesAll').onclick = useAllTakes;
    $('videoDefault').onclick = () => {
      if (!selected) return;
      settings.videoLag = (settings.videoLag || 0) - (selected.videoOffset || 0);
      saveSettings();
      toast('Disimpan: rekaman video berikutnya otomatis digeser segini.');
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && rec) stopRecording();
    });
  }

  bind();

  return {
    loadSong,
    recover,
    unload: async () => { if (rec) await stopRecording(); await recorder.close(); takes = []; selected = null; buffers = new Map(); },
    // take yang nyala + buffer-nya (untuk mixer & ekspor)
    liveTakes: () => onTakes().filter((t) => buffers.has(t.id)).map((t) => ({ ...stripTake(t), buffer: buffers.get(t.id), startAt: effStart(t), rawStartAt: t.startAt })),
    get hasTakes() { return takes.length > 0; },
    updateTakeMix,
    effStart,
    effVideoStart,
    isRecording: () => !!rec,
  };
}

export const ROLE_LABEL = {
  guitar: '🎸 Gitar',
  bass: 'Bass',
  vocals: '🎤 Vokal',
  extra: 'Gitar tambahan',
  piano: 'Keys',
  drums: 'Drum',
  other: 'Lainnya',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
