"""Deteksi tempo, ketukan, dan ketukan pertama (downbeat) dari sebuah lagu."""

from __future__ import annotations

import numpy as np
import librosa

SR = 22050
HOP = 512


def _norm(x: np.ndarray) -> np.ndarray:
    x = x - np.min(x)
    peak = np.max(x)
    return x / peak if peak > 0 else x


def _extend(beats: np.ndarray, duration: float) -> np.ndarray:
    """Perpanjang grid ke awal & akhir lagu (intro/outro tanpa drum)."""
    if len(beats) < 4:
        return beats
    head = float(np.median(np.diff(beats[:8])))
    tail = float(np.median(np.diff(beats[-8:])))
    before = []
    t = beats[0] - head
    while t >= 0:
        before.append(t)
        t -= head
    after = []
    t = beats[-1] + tail
    while t < duration:
        after.append(t)
        t += tail
    return np.concatenate([np.array(before[::-1]), beats, np.array(after)])


def _refine(y: np.ndarray, beats: np.ndarray, window: float = 0.07) -> np.ndarray:
    """Geser tiap ketukan ke puncak serangan (attack) terdekat, dengan resolusi ±3 ms.

    Beat tracker bekerja di frame kasar (~23 ms) dan cenderung sedikit telat; tanpa langkah ini
    klik metronome bisa kedengeran 'flam' dengan pukulan drum aslinya.
    """
    hop = 128
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=hop, n_fft=1024, center=True)
    times = librosa.frames_to_time(np.arange(len(env)), sr=SR, hop_length=hop)
    # onset_strength = selisih spektrum; puncaknya ~1 frame setelah serangan
    times = times - hop / SR
    out = beats.copy()
    noise = np.median(env) + 1e-9
    for i, b in enumerate(beats):
        lo, hi = np.searchsorted(times, [b - window, b + window])
        if hi - lo < 3:
            continue
        seg = env[lo:hi]
        k = int(np.argmax(seg))
        if seg[k] > 3 * noise:
            out[i] = times[lo + k]
    return out


def _downbeat(y: np.ndarray, beats: np.ndarray, bpb: int = 4) -> int:
    """Tebak ketukan mana yang "1": di situ biasanya akor/nada bass ganti, dan kick paling tebal."""
    frames = np.clip(librosa.time_to_frames(beats, sr=SR, hop_length=HOP), 0, None)
    # 1) Pergantian harmoni: bandingkan chroma sebelum vs sesudah tiap ketukan.
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    frames = np.clip(frames, 0, chroma.shape[1] - 1)
    # Kolom j = potongan [beat j-1, beat j); kolom 0 = sebelum beat pertama.
    sync = librosa.util.sync(chroma, frames, aggregate=np.median, pad=True)
    sync = sync / (np.linalg.norm(sync, axis=0, keepdims=True) + 1e-9)
    change = np.zeros(len(beats))
    m = min(sync.shape[1] - 1, len(beats))
    change[:m] = 1 - np.sum(sync[:, :m] * sync[:, 1:m + 1], axis=0)  # ganti akor tepat di beat j
    # 2) Energi frekuensi rendah (kick + bass) tepat di ketukan.
    low = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, fmax=200, n_mels=32)
    low_b = low[np.clip(frames, 0, len(low) - 1)]

    def norm(v):
        v = v - v.mean()
        return v / (v.std() + 1e-9)

    score = norm(change) + 0.6 * norm(low_b)
    totals = [float(np.mean(score[k::bpb])) for k in range(bpb)]
    return int(np.argmax(totals))


def analyze(mix_path: str, drums_path: str | None = None) -> dict:
    y, _ = librosa.load(mix_path, sr=SR, mono=True)
    duration = len(y) / SR

    onset = _norm(librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median))

    # Kalau track drum hasil pemisahan cukup jelas, pakai juga — beat jadi lebih stabil.
    if drums_path:
        d, _ = librosa.load(drums_path, sr=SR, mono=True)
        n = min(len(d), len(y))
        if n and np.sqrt(np.mean(d[:n] ** 2)) > 0.08 * np.sqrt(np.mean(y[:n] ** 2)):
            od = _norm(librosa.onset.onset_strength(y=d, sr=SR, hop_length=HOP))
            m = min(len(od), len(onset))
            onset = _norm(0.4 * onset[:m] + 0.6 * od[:m])

    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SR, hop_length=HOP, trim=False)
    beats = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    beats = beats[beats < duration]

    if len(beats) >= 4:
        beats = _refine(y, beats)
        # BPM rata-rata keseluruhan lagu (lebih akurat daripada median selisih per frame)
        bpm = 60.0 * (len(beats) - 1) / float(beats[-1] - beats[0])
        beats = _extend(beats, duration)
    else:
        # Lagu tanpa beat jelas: kasih grid 120 BPM, user bisa koreksi manual.
        beats = np.arange(0.0, duration, 0.5)
        bpm = 120.0

    downbeat = _downbeat(y, beats)

    return {
        "duration": round(duration, 3),
        "bpm": round(bpm, 1),
        "beats": [round(float(b), 4) for b in beats],
        "downbeat": downbeat,
        "beats_per_bar": 4,
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
