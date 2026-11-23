"""Deteksi peta tempo sebuah lagu.

Hasil utama: daftar *bagian* (section). Tiap bagian punya tempo rata (BPM), birama, waktu ketukan "1"
pertamanya, daftar bar ganjil, dan tanda apakah ada jeda sebelum bagian itu dimulai.
Aplikasi di HP membangun klik dari peta ini, jadi klik selalu stabil (tidak ikut goyang
mengikuti genjrengan/vokal), tapi tetap bisa berganti tempo dan birama.

Langkah:
1. Ketukan kasar dari beat tracker (dengan tempo yang boleh berubah sepanjang lagu).
2. Tandai ketukan yang ada pukulan drum (dari track drum hasil pemisahan) dan presisikan HANYA
   ketukan itu ke pukulan drum terdekat. Bagian tanpa drum tidak dipakai untuk mengukur tempo.
3. Pecah ketukan-ber-drum jadi bagian-bagian di titik jeda / perubahan tempo; tiap bagian
   di-fit garis lurus (tempo rata + fase).
4. Per bagian: tentukan birama (3 atau 4) dan posisi ketukan "1" per bar (boleh ada bar ganjil).
"""

from __future__ import annotations

import numpy as np
import librosa
import scipy.ndimage

SR = 22050
HOP = 512
FINE_HOP = 128


# ---------------------------------------------------------------- utilitas

def _norm01(x: np.ndarray) -> np.ndarray:
    x = x - np.min(x)
    p = np.max(x)
    return x / p if p > 0 else x


def _z(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    if len(v) == 0:
        return v
    s = v.std()
    return (v - v.mean()) / (s + 1e-9)


def _fit_grid(times: np.ndarray, period_guess: float) -> tuple[float, float, np.ndarray, float]:
    """Fit t = a + p*k (k bilangan bulat). Return (a, p, k, std residu)."""
    p = period_guess
    a = times[0]
    k = np.zeros(len(times))
    for _ in range(3):
        k = np.round((times - a) / p)
        if len(np.unique(k)) < 2:
            break
        p, a = np.polyfit(k, times, 1)
    res = times - (a + p * k)
    return float(a), float(p), k.astype(int), float(np.std(res))


# ---------------------------------------------------------------- tahap 1–2: ketukan kasar & drum

def _drum_activity(d: np.ndarray | None, n_frames: int) -> np.ndarray:
    """True per frame kalau drum sedang main."""
    if d is None:
        return np.ones(n_frames, dtype=bool)
    rms = librosa.feature.rms(y=d, frame_length=2048, hop_length=HOP)[0]
    rms = scipy.ndimage.maximum_filter1d(rms, size=int(1.8 * SR / HOP))  # tahan antar-pukulan (tempo lambat)
    ref = np.percentile(rms, 90) + 1e-9
    act = rms > 0.12 * ref
    act = scipy.ndimage.binary_opening(act, structure=np.ones(int(0.8 * SR / HOP)))
    out = np.zeros(n_frames, dtype=bool)
    m = min(n_frames, len(act))
    out[:m] = act[:m]
    return out


def _track(onset: np.ndarray) -> np.ndarray:
    """Beat tracking dengan tempo yang boleh berubah (dihaluskan supaya nggak loncat-loncat)."""
    tempo = librosa.feature.tempo(onset_envelope=onset, sr=SR, hop_length=HOP, aggregate=None,
                                  ac_size=6.0, std_bpm=1.0, start_bpm=120)
    win = max(3, int(5.0 * SR / HOP)) | 1
    tempo = scipy.ndimage.median_filter(tempo, size=win, mode="nearest")
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SR, hop_length=HOP, bpm=tempo,
                                        tightness=200, trim=False)
    return librosa.frames_to_time(frames, sr=SR, hop_length=HOP)


def _refine_to_drums(d: np.ndarray, beats: np.ndarray, active: np.ndarray, window: float = 0.06) -> np.ndarray:
    """Presisikan ketukan ber-drum ke pukulan drum terdekat (resolusi ±3 ms)."""
    env = librosa.onset.onset_strength(y=d, sr=SR, hop_length=FINE_HOP, n_fft=1024)
    times = librosa.frames_to_time(np.arange(len(env)), sr=SR, hop_length=FINE_HOP) - FINE_HOP / SR
    out = beats.copy()
    noise = np.median(env) + 1e-9
    for i, b in enumerate(beats):
        if not active[i]:
            continue
        lo, hi = np.searchsorted(times, [b - window, b + window])
        if hi - lo < 3:
            continue
        seg = env[lo:hi]
        k = int(np.argmax(seg))
        if seg[k] > 4 * noise:
            out[i] = times[lo + k]
    return out


# ---------------------------------------------------------------- tahap 3: bagian & tempo

def _pieces(t: np.ndarray) -> list[np.ndarray]:
    """Pecah deretan ketukan ber-drum di titik jeda dan perubahan tempo."""
    if len(t) < 2:
        return [t] if len(t) else []
    ibi = np.diff(t)
    med = scipy.ndimage.median_filter(ibi, size=min(9, len(ibi)) | 1, mode="nearest")
    cuts = set(np.where(ibi > 1.7 * med)[0] + 1)  # jeda / drum berhenti
    # perubahan tempo: bandingkan median 6 ketukan sebelum & sesudah
    w = 6
    score = np.zeros(len(t))
    for i in range(w, len(ibi) - w + 1):
        a, b = np.median(ibi[i - w:i]), np.median(ibi[i:i + w])
        score[i] = abs(np.log(b / a))
    for i in range(w, len(ibi) - w + 1):
        if score[i] > np.log(1.07) and score[i] == score[max(0, i - w):i + w].max():
            cuts.add(i)
    edges = [0] + sorted(c for c in cuts if 0 < c < len(t)) + [len(t)]
    return [t[a:b] for a, b in zip(edges[:-1], edges[1:]) if b > a]


def _sections(active_beats: np.ndarray) -> list[dict]:
    pieces = [p for p in _pieces(active_beats) if len(p) >= 2]
    fits = []
    for p in pieces:
        period = float(np.median(np.diff(p)))
        a, per, k, err = _fit_grid(p, period)
        fits.append({"first": float(p[0]), "last": float(p[-1]), "a": a, "p": per, "n": len(p),
                     "err": err, "times": p})
    # Bagian kependekan (< 6 ketukan) digabung ke tetangga (biasanya fill/salah deteksi).
    fits = [f for f in fits if f["n"] >= 6] or fits
    merged: list[dict] = []
    for f in fits:
        if merged:
            g = merged[-1]
            same_tempo = abs(f["p"] - g["p"]) / g["p"] < 0.02
            # apakah pukulan pertama bagian baru jatuh pas di grid bagian lama?
            pred = (f["first"] - g["a"]) / g["p"]
            on_grid = abs(pred - round(pred)) < 0.15
            if same_tempo and on_grid:
                times = np.concatenate([g["times"], f["times"]])
                a, per, k, err = _fit_grid(times, g["p"])
                merged[-1] = {"first": g["first"], "last": f["last"], "a": a, "p": per, "n": len(times),
                              "err": err, "times": times}
                continue
        merged.append(f)
    for i, f in enumerate(merged):
        f["gap"] = bool(i > 0 and f["first"] - merged[i - 1]["last"] > 1.6 * merged[i - 1]["p"])
    return merged


def _env_at(env: np.ndarray, times: np.ndarray, radius: int = 2) -> np.ndarray:
    fr = librosa.time_to_frames(times, sr=SR, hop_length=HOP)
    out = np.zeros(len(times))
    for i, f in enumerate(fr):
        lo, hi = max(0, f - radius), min(len(env), f + radius + 1)
        out[i] = env[lo:hi].max() if hi > lo else 0.0
    return out


def _fix_octave(f: dict, env: np.ndarray) -> dict:
    """Pilih tempo yang benar di antara x0.5 / x1 / x2.

    Tempo yang benar: di ketukannya kick/snare kuat, di tengah-tengah antar-ketukan lemah.
    Kalau kebaca setengah, "tengah"-nya justru kena snare (kuat). Kalau kebaca dobel, separuh
    "ketukannya" jatuh di sela (lemah).
    """
    best = None
    current = None
    for mult in (0.5, 1.0, 2.0):
        P = f["p"] * mult
        if not 40 <= 60 / P <= 260:
            continue
        for phase in ((0.0,) if mult <= 1 else (0.0, f["p"])):
            a = f["a"] + phase
            k0 = int(np.ceil((f["first"] - a) / P - 0.01))
            k1 = int(np.floor((f["last"] - a) / P + 0.01))
            if k1 - k0 < 3:
                continue
            g = a + P * np.arange(k0, k1 + 1)
            on, off = _env_at(env, g), _env_at(env, g + P / 2)
            # 25% ketukan terlemah harus tetap kuat (kalau kebaca dobel, separuh ketukan jatuh di sela)
            score = float(np.percentile(on, 25) - np.median(off))
            if mult == 1.0:
                current = score
            if best is None or score > best[0]:
                best = (score, P, a)
    # Ganti tempo hasil tracker hanya kalau alternatifnya jelas lebih meyakinkan.
    if best and current is not None and best[0] > 1.2 * max(current, 1e-9) + 1e-9 and best[1] != f["p"]:
        f = {**f, "p": best[1], "a": best[2]}
    return f


def _snap_fit(f: dict, env: np.ndarray, env_times: np.ndarray) -> dict:
    """Fit ulang: tempelkan grid ke puncak pukulan terdekat, lalu regresi garis lurus."""
    P, a = f["p"], f["a"]
    k0 = int(np.ceil((f["first"] - a) / P - 0.2))
    k1 = int(np.floor((f["last"] - a) / P + 0.2))
    noise = np.median(env) + 1e-9
    ks, ts = [], []
    for k in range(k0, k1 + 1):
        t = a + P * k
        lo, hi = np.searchsorted(env_times, [t - 0.15 * P, t + 0.15 * P])
        if hi - lo < 2:
            continue
        j = int(np.argmax(env[lo:hi]))
        if env[lo + j] > 4 * noise:
            ks.append(k)
            ts.append(env_times[lo + j])
    if len(ks) < 4:
        return f
    ks, ts = np.array(ks), np.array(ts)
    p, a2 = np.polyfit(ks, ts, 1)
    res = ts - (a2 + p * ks)
    keep = np.abs(res) < max(0.025, 2.5 * res.std())
    if keep.sum() >= 4:
        p, a2 = np.polyfit(ks[keep], ts[keep], 1)
        res = ts[keep] - (a2 + p * ks[keep])
    return {**f, "p": float(p), "a": float(a2), "err": float(np.std(res))}


def _grid_err(f: dict, t: float) -> float:
    k = (t - f["a"]) / f["p"]
    return abs(k - round(k)) * f["p"]


def _fix_boundaries(secs: list[dict]) -> list[dict]:
    """Geser batas antar-bagian (tanpa jeda) ke ketukan pertama yang lebih cocok dengan tempo baru."""
    for i in range(1, len(secs)):
        prev, cur = secs[i - 1], secs[i]
        if cur["gap"]:
            continue
        tail = [t for t in prev["times"] if t < cur["first"]][-12:]
        moved = None
        for t in reversed(tail):
            ec, ep = _grid_err(cur, t), _grid_err(prev, t)
            if ec < 0.03 and ec <= ep + 0.01:  # sama-sama cocok -> milik bagian baru
                moved = t
            else:
                break
        if moved is not None:
            cur["first"] = float(moved)
            earlier = [t for t in prev["times"] if t < moved]
            if earlier:
                prev["last"] = float(earlier[-1])
    return secs


def _extend_edges(secs: list[dict], env: np.ndarray, env_times: np.ndarray, duration: float) -> list[dict]:
    """Perpanjang tiap bagian ke belakang/depan selama pukulan drum masih pas di grid-nya."""
    noise = np.median(env) + 1e-9

    def hit(t: float, P: float) -> float | None:
        lo, hi = np.searchsorted(env_times, [t - 0.06 * P, t + 0.06 * P])
        if hi - lo < 1:
            return None
        j = int(np.argmax(env[lo:hi]))
        return float(env_times[lo + j]) if env[lo + j] > 4 * noise else None

    for i, f in enumerate(secs):
        P = f["p"]
        floor = secs[i - 1]["last"] + 0.5 * secs[i - 1]["p"] if i > 0 else 0.0
        ceil = secs[i + 1]["first"] - 0.5 * P if i + 1 < len(secs) else duration
        for direction in (-1, 1):
            edge = f["first"] if direction < 0 else f["last"]
            misses, k = 0, 1
            while misses < 2:
                t = edge + direction * k * P
                if t <= floor or t >= ceil:
                    break
                h = hit(t, P)
                if h is None:
                    misses += 1
                else:
                    misses = 0
                    if direction < 0:
                        f["first"] = h
                    else:
                        f["last"] = h
                k += 1
    return secs


def _merge_same(secs: list[dict]) -> list[dict]:
    out: list[dict] = []
    for f in secs:
        if out:
            g = out[-1]
            same_tempo = abs(f["p"] - g["p"]) / g["p"] < 0.02
            pred = (f["first"] - g["a"]) / g["p"]
            if same_tempo and abs(pred - round(pred)) < 0.15:
                n = g["n"] + f["n"]
                out[-1] = {**g, "last": f["last"], "n": n, "err": max(g["err"], f["err"]),
                           "times": np.concatenate([g["times"], f["times"]])}
                continue
        out.append(f)
    return out


# ---------------------------------------------------------------- tahap 4: birama & ketukan "1"

def _downbeat_evidence(y: np.ndarray, beats: np.ndarray, chroma: np.ndarray, low: np.ndarray) -> np.ndarray:
    frames = np.clip(librosa.time_to_frames(beats, sr=SR, hop_length=HOP), 0, chroma.shape[1] - 1)
    # Pergantian akor di tiap ketukan: chroma 1 ketukan sebelum vs 1 ketukan sesudah.
    per = max(1, int(np.median(np.diff(frames)))) if len(frames) > 1 else 10
    change = np.zeros(len(beats))
    for j, f in enumerate(frames):
        before = chroma[:, max(0, f - per):f]
        after = chroma[:, f:min(chroma.shape[1], f + per)]
        if before.shape[1] == 0 or after.shape[1] == 0:
            continue
        b = np.median(before, axis=1)
        a = np.median(after, axis=1)
        change[j] = 1 - float(b @ a) / (np.linalg.norm(b) * np.linalg.norm(a) + 1e-9)
    low_b = low[np.clip(frames, 0, len(low) - 1)]
    s = _z(change) + 0.6 * _z(low_b)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    loud = rms[np.clip(frames, 0, len(rms) - 1)]
    s[loud < 0.05 * np.percentile(rms, 90)] = -4.0  # ketukan di bagian sunyi bukan "1"
    return s


def _meter(s: np.ndarray) -> int:
    """3/4 atau 4/4: lihat apakah 'bukti ketukan 1' berulang tiap 3(&6) atau tiap 4(&8) ketukan."""
    v = np.where(s > -3.9, s, np.nan)  # abaikan ketukan di bagian sunyi
    v = v - np.nanmean(v)

    def ac(k: int) -> float:
        if len(v) <= k + 4:
            return 0.0
        prod = v[:-k] * v[k:]
        return float(np.nanmean(prod)) if np.isfinite(prod).sum() > 4 else 0.0
    score3 = ac(3) + ac(6)
    score4 = ac(4) + ac(8)
    return 3 if score3 > score4 + 0.15 and score3 > 0 else 4


def _bars(s: np.ndarray, bpb: int, penalty: float = 5.0) -> list[int]:
    """Pilih posisi ketukan "1" (indeks) — bar normal panjangnya bpb, bar ganjil kena penalti."""
    n = len(s)
    if n == 0:
        return []
    lengths = [g for g in range(2, 8)]
    f = np.full(n, -np.inf)
    back = np.full(n, -1)
    for i in range(n):
        if i < bpb:
            f[i] = s[i]  # bar pertama boleh terpotong (pickup)
        for g in lengths:
            j = i - g
            if j < 0 or f[j] == -np.inf:
                continue
            v = f[j] + s[i] - (0 if g == bpb else penalty)
            if v > f[i]:
                f[i], back[i] = v, j
    end = int(np.argmax(f[max(0, n - bpb):])) + max(0, n - bpb)
    path = [end]
    while back[path[-1]] >= 0:
        path.append(int(back[path[-1]]))
    return path[::-1]


# ---------------------------------------------------------------- utama

def analyze(mix_path: str, drums_path: str | None = None) -> dict:
    y, _ = librosa.load(mix_path, sr=SR, mono=True)
    duration = len(y) / SR
    d = None
    if drums_path:
        d, _ = librosa.load(drums_path, sr=SR, mono=True)
        n = min(len(d), len(y))
        if n == 0 or np.sqrt(np.mean(d[:n] ** 2)) < 0.03 * np.sqrt(np.mean(y[:n] ** 2)):
            d = None  # lagu tanpa drum

    onset = _norm01(librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median))
    if d is not None:
        # Kick + snare (tanpa hi-hat) — penentu ketukan; hi-hat sering bikin tempo kebaca 2x lipat.
        od = _norm01(librosa.onset.onset_strength(y=d, sr=SR, hop_length=HOP, fmax=2500, n_mels=48))
        m = min(len(od), len(onset))
        onset = _norm01(0.25 * onset[:m] + 0.75 * od[:m])

    beats = _track(onset)
    beats = beats[beats < duration]
    act_frames = _drum_activity(d, len(onset))
    bf = np.clip(librosa.time_to_frames(beats, sr=SR, hop_length=HOP), 0, len(act_frames) - 1)
    active = act_frames[bf] if len(beats) else np.zeros(0, dtype=bool)
    if d is not None and len(beats):
        beats = _refine_to_drums(d, beats, active)
    if active.sum() < 8:  # nyaris nggak ada drum: pakai semua ketukan
        active = np.ones(len(beats), dtype=bool)

    secs = _sections(beats[active]) if len(beats) >= 4 else []
    if secs:
        src = d if d is not None else y
        # skala linear (bukan dB): hi-hat pelan nggak boleh dianggap sekuat kick/snare
        mel_lo = librosa.feature.melspectrogram(y=src, sr=SR, hop_length=HOP, fmax=2500, n_mels=48)
        env_lo = librosa.onset.onset_strength(S=np.sqrt(mel_lo), sr=SR)
        env_fine = librosa.onset.onset_strength(y=src, sr=SR, hop_length=FINE_HOP, n_fft=1024)
        fine_t = librosa.frames_to_time(np.arange(len(env_fine)), sr=SR, hop_length=FINE_HOP) - FINE_HOP / SR
        secs = [_snap_fit(_fix_octave(f, env_lo), env_fine, fine_t) for f in secs]
        # Setelah oktaf dibetulkan, bagian yang ternyata sama bisa digabung lagi.
        secs = _merge_same(secs)
        secs = [_snap_fit(f, env_fine, fine_t) for f in secs]
        # Buang bagian sampah: kependekan atau berantakan (sisa dengung, fill, salah deteksi).
        good = [f for f in secs if f["n"] >= 8 and not (f["err"] > 0.03 and f["n"] < 16)]
        secs = good or secs
        secs = _fix_boundaries(secs)
        secs = _extend_edges(secs, env_fine, fine_t, duration)
        for i, f in enumerate(secs):
            f["gap"] = bool(i > 0 and f["first"] - secs[i - 1]["last"] > 1.6 * secs[i - 1]["p"])
    if not secs:
        return {
            "version": 2, "duration": round(duration, 3), "bpm": 120.0, "mode": "steady",
            "sections": [{"start": 0.0, "bpm": 120.0, "bpb": 4, "odd": {}, "gap": False, "countIn": 1}],
            "drum_beats": [], "beats": [round(float(b), 4) for b in beats],
        }

    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    low = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, fmax=200, n_mels=32)

    out_secs = []
    for i, f in enumerate(secs):
        p, a = f["p"], f["a"]
        # rentang bagian: dari awal lagu (bagian pertama) atau pukulan pertamanya, sampai bagian berikut
        lo = 0.0 if i == 0 else f["first"] - 0.5 * p
        hi = secs[i + 1]["first"] - 0.5 * p if i + 1 < len(secs) else duration
        hi = min(hi, f["last"] + 0.5 * p)  # jangan analisis jeda / dengung setelah pukulan terakhir
        k0 = int(np.ceil((lo - a) / p))
        k1 = int(np.floor((hi - a) / p))
        grid = a + p * np.arange(k0, k1 + 1)
        grid = grid[(grid >= 0) & (grid < duration)]
        if len(grid) < 2:
            continue
        s = _downbeat_evidence(y, grid, chroma, low)
        bpb = _meter(s)
        downs = _bars(s, bpb)
        # Bar pertama yang kependekan = pickup (bukan bar ganjil): mulai dari ketukan "1" berikutnya.
        if len(downs) > 2 and downs[1] - downs[0] < bpb and i > 0:
            downs = downs[1:]
        start = float(grid[downs[0]]) if downs else float(grid[0])
        odd = {}
        for b in range(len(downs) - 1):
            g = downs[b + 1] - downs[b]
            last = b == len(downs) - 2
            if g != bpb and not last:  # bar terakhir sering terpotong (akhir lagu / sebelum jeda)
                odd[str(b)] = int(g)
        out_secs.append({
            "start": round(start, 4),
            "bpm": round(60.0 / p, 3),
            "bpb": bpb,
            "odd": odd,
            "gap": f["gap"],
            "countIn": 1,
            "err_ms": round(f["err"] * 1000, 1),
        })

    longest = max(secs, key=lambda f: f["last"] - f["first"])
    steady = all(f["err"] < 0.018 for f in secs)
    return {
        "version": 2,
        "duration": round(duration, 3),
        "bpm": round(60.0 / longest["p"], 2),
        "mode": "steady" if steady else "follow",
        "sections": out_secs,
        "drum_beats": [round(float(b), 4) for b in beats[active]] if d is not None else [],
        "beats": [round(float(b), 4) for b in beats],
    }


def warmup() -> None:
    """Panaskan numba (kompilasi pertama librosa bisa makan puluhan detik)."""
    import tempfile
    import soundfile as sf

    t = np.arange(SR * 6) / SR
    y = np.sin(2 * np.pi * 110 * t) * (np.mod(t, 0.5) < 0.05)
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sf.write(f.name, y, SR)
        analyze(f.name)
