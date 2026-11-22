"""Pemisah instrumen. Pakai Demucs (htdemucs_6s) — 6 track:
vocals, drums, bass, guitar, piano, other.

SEPARATOR=fake dipakai cuma buat tes lokal tanpa model AI (pakai filter ffmpeg).
"""

from __future__ import annotations

import os
import subprocess
import threading
import types
from pathlib import Path
from typing import Callable

STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
MODEL_NAME = os.environ.get("DEMUCS_MODEL", "htdemucs_6s")
MODE = os.environ.get("SEPARATOR", "demucs")

_model = None
_lock = threading.Lock()


def _get_model():
    global _model
    with _lock:
        if _model is None:
            import torch
            from demucs.pretrained import get_model

            torch.set_num_threads(int(os.environ.get("TORCH_THREADS", str(os.cpu_count() or 2))))
            m = get_model(MODEL_NAME)
            m.cpu()
            m.eval()
            _model = m
        return _model


def separate(wav_path: Path, out_dir: Path, progress: Callable[[float], None]) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    if MODE == "fake":
        return _fake(wav_path, out_dir, progress)
    return _demucs(wav_path, out_dir, progress)


def _demucs(wav_path: Path, out_dir: Path, progress: Callable[[float], None]) -> dict[str, Path]:
    import torch
    import soundfile as sf
    import demucs.apply as dapply
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model = _get_model()

    def tracked(iterable, **_kw):
        items = list(iterable)
        total = max(len(items), 1)
        for i, item in enumerate(items):
            yield item
            progress((i + 1) / total)

    # apply_model memakai tqdm.tqdm(...) untuk progress — kita sadap supaya bisa lapor ke HP.
    dapply.tqdm = types.SimpleNamespace(tqdm=tracked)

    wav = AudioFile(wav_path).read(streams=0, samplerate=model.samplerate, channels=model.audio_channels)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    wav = (wav - mean) / (std + 1e-8)

    with torch.no_grad():
        sources = apply_model(model, wav[None], device="cpu", shifts=1, split=True,
                              overlap=0.25, progress=True, num_workers=0)[0]
    sources = sources * std + mean

    result = {}
    for source, name in zip(sources, model.sources):
        peak = float(source.abs().max())
        if peak > 0.99:
            source = source / (peak * 1.01)
        path = out_dir / f"{name}.wav"
        sf.write(str(path), source.numpy().T, model.samplerate, subtype="PCM_16")
        result[name] = path
    return result


_FAKE_FILTERS = {
    "vocals": "bandpass=f=1500:width_type=o:w=2",
    "drums": "highpass=f=4000",
    "bass": "lowpass=f=180",
    "guitar": "bandpass=f=800:width_type=o:w=1",
    "piano": "bandpass=f=2500:width_type=o:w=1",
    "other": "volume=0.2",
}


def _fake(wav_path: Path, out_dir: Path, progress: Callable[[float], None]) -> dict[str, Path]:
    result = {}
    for i, name in enumerate(STEMS):
        path = out_dir / f"{name}.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(wav_path), "-af", _FAKE_FILTERS[name], str(path)],
                       check=True)
        result[name] = path
        progress((i + 1) / len(STEMS))
    return result
