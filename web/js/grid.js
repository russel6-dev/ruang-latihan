// Peta tempo -> daftar ketukan klik.
//
// map = {
//   mode: 'steady' | 'follow',   // tempo rata per bagian, atau ikuti pukulan drum
//   offset: detik,               // geser halus semua klik
//   sections: [{
//     start,      // detik: ketukan "1" pertama bagian ini
//     bpm, bpb,   // tempo & jumlah ketukan per bar
//     odd: {barKe: jumlahKetukan},  // bar ganjil (indeks bar di dalam bagian, mulai 0)
//     gap,        // ada jeda sebelum bagian ini?
//     countIn,    // kalau ada jeda: berapa bar hitungan tempo baru sebelum masuk (0–2)
//     gapClick,   // kalau ada jeda: 'silent' (klik diam di sisa jeda) atau 'old' (tetap tempo lama)
//   }]
// }
//
// Hasil: { times: [detik], info: [{bar, beat, beats, sec, lbar, count}] }
//   bar   = nomor bar global (mulai 1), beat = posisi di bar (0 = ketukan "1"),
//   beats = panjang bar itu, sec = indeks bagian, lbar = indeks bar di dalam bagian,
//   count = true kalau ini hitungan masuk (tempo baru) di dalam jeda.

export function sortedSections(map) {
  return [...(map.sections || [])].sort((a, b) => a.start - b.start);
}

export function buildGrid(map, duration, drumBeats = []) {
  const secs = sortedSections(map);
  const out = [];
  if (!secs.length) return { times: [], info: [] };

  // Intro / pickup sebelum bagian pertama: hitung mundur dengan tempo bagian pertama.
  const s0 = secs[0];
  const p0 = 60 / s0.bpm;
  const pre = [];
  for (let j = 1; s0.start - j * p0 >= -0.02; j++) pre.push(j);
  for (let k = pre.length - 1; k >= 0; k--) {
    const j = pre[k];
    const back = Math.ceil(j / s0.bpb);
    out.push({ t: s0.start - j * p0, bar: -back, beat: (s0.bpb - (j % s0.bpb)) % s0.bpb, beats: s0.bpb, sec: 0, lbar: -back });
  }

  let gbar = 0;
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    const per = 60 / sec.bpm;
    const next = secs[i + 1];
    const S = next ? next.start : duration + per;
    const gapNext = !!(next && next.gap);
    const ci = gapNext ? Math.max(0, Math.min(4, next.countIn ?? 1)) : 0;
    const per2 = next ? 60 / next.bpm : per;
    const ciStart = gapNext ? S - ci * next.bpb * per2 : S;
    const limit = ciStart;
    const keepOld = gapNext && next.gapClick === 'old';

    let t = sec.start;
    let lb = 0;
    let used = -1;
    for (let guard = 0; guard < 100000; guard++) {
      const L = Number(sec.odd?.[lb]) || sec.bpb;
      const barEnd = t + L * per;
      if (gapNext && !keepOld && barEnd > limit + 0.25 * per) break; // cuma bar utuh sebelum jeda
      let stop = false;
      for (let j = 0; j < L; j++) {
        const tb = t + j * per;
        if (tb >= limit - 0.3 * per) { stop = true; break; }
        out.push({ t: tb, bar: gbar + lb, beat: j, beats: L, sec: i, lbar: lb });
        used = lb;
      }
      if (stop) break;
      t = barEnd;
      lb++;
      if (t >= limit - 0.3 * per) break;
    }
    gbar += used + 1;

    for (let c = 0; c < ci; c++) {
      for (let j = 0; j < next.bpb; j++) {
        out.push({ t: ciStart + (c * next.bpb + j) * per2, bar: gbar, beat: j, beats: next.bpb, sec: i + 1, lbar: c - ci, count: true });
      }
      gbar++;
    }
  }

  // Mode "ikuti drummer": tempelkan ke pukulan drum terdekat kalau dekat.
  if (map.mode === 'follow' && drumBeats.length) {
    for (const b of out) {
      if (b.count) continue;
      const per = 60 / secs[b.sec].bpm;
      const d = nearest(drumBeats, b.t);
      if (d !== null && Math.abs(d - b.t) < 0.12 * per) b.t = d;
    }
  }

  const off = map.offset || 0;
  const minBar = Math.min(...out.map((b) => b.bar));
  const kept = out
    .map((b) => ({ ...b, t: b.t + off, bar: b.bar - minBar + 1 }))
    .filter((b) => b.t >= -0.001 && b.t < duration)
    .sort((a, b) => a.t - b.t);
  return { times: kept.map((b) => b.t), info: kept };
}

function nearest(arr, x) {
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  let best = arr[lo];
  if (lo > 0 && Math.abs(arr[lo - 1] - x) < Math.abs(best - x)) best = arr[lo - 1];
  return best;
}

// Indeks bagian yang sedang aktif di waktu t (bagian terakhir yang start-nya <= t).
export function sectionIndexAt(map, t) {
  const secs = sortedSections(map);
  let idx = 0;
  for (let i = 0; i < secs.length; i++) if (secs[i].start <= t + 0.05) idx = i;
  return idx;
}

// Peta tempo dari lagu versi lama (sebelum ada fitur bagian).
export function mapFromLegacy(song) {
  const g = song.grid || {};
  const beats = song.beats || [];
  const bpb = g.bpb || 4;
  let start = beats[g.downbeat ?? 0] ?? 0;
  let bpm = song.bpm || 120;
  if (beats.length > 4) {
    const n = beats.length - 1;
    bpm = (60 * n) / (beats[n] - beats[0]);
  }
  return { mode: 'steady', offset: 0, sections: [{ start, bpm: Math.round(bpm * 100) / 100, bpb, odd: {}, gap: false, countIn: 1, gapClick: 'silent' }] };
}
