"""Ubah model Demucs (htdemucs_6s) ke ONNX supaya bisa jalan di browser HP (ONNX Runtime Web).

STFT/iSTFT dikeluarkan dari model (dikerjakan JavaScript di HP), jadi ONNX cuma berisi bagian
jaringan saraf: input = (potongan audio, spektrogram), output = (spektrogram per instrumen,
audio per instrumen dari cabang waktu).

Dijalankan GitHub Actions (.github/workflows/export-model.yml). Hasil ditulis ke web/models/.
"""

from __future__ import annotations

import json
import math
import os
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F
from torch import nn
from demucs.pretrained import get_model
from demucs.hdemucs import pad1d
from demucs.spec import ispectro, spectro

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "web/models")
NAME = os.environ.get("DEMUCS_MODEL", "htdemucs_6s")


class Core(nn.Module):
    """Bagian HTDemucs.forward di antara STFT dan iSTFT (mode inferensi, panjang = segment latih)."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, mix, mag):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)

        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)

        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, x.shape[1], f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, x.shape[1], f, t)
                xt = m.channel_downsampler_t(xt)

        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)

        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1])
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


def spec(m, x):
    """Sama persis dengan HTDemucs._spec + _magnitude (cac)."""
    hl = m.hop_length
    le = int(math.ceil(x.shape[-1] / hl))
    pad = hl // 2 * 3
    x = pad1d(x, (pad, pad + le * hl - x.shape[-1]), mode="reflect")
    z = spectro(x, m.nfft, hl)[..., :-1, :]
    z = z[..., 2: 2 + le]
    B, C, Fr, T = z.shape
    mag = torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(B, C * 2, Fr, T)
    return z, mag


def ispec_sum(m, xs, xt, length):
    B, S, C2, Fr, T = xs.shape
    z = xs.view(B, S, -1, 2, Fr, T).permute(0, 1, 2, 4, 5, 3).contiguous()
    z = torch.view_as_complex(z)
    hl = m.hop_length
    z = F.pad(z, (0, 0, 0, 1))
    z = F.pad(z, (2, 2))
    pad = hl // 2 * 3
    le = hl * int(math.ceil(length / hl)) + 2 * pad
    x = ispectro(z, hl, length=le)[..., pad: pad + length]
    return xt + x


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    bag = get_model(NAME)
    m = bag.models[0] if hasattr(bag, "models") else bag
    m.eval()
    sr = m.samplerate
    L = int(Fraction(m.segment) * sr)
    print("model", NAME, "sources", m.sources, "sr", sr, "segment", m.segment, "L", L, "nfft", m.nfft, "hop", m.hop_length)

    torch.manual_seed(0)
    mix = torch.randn(1, 2, L) * 0.1
    with torch.no_grad():
        ref = m(mix)
        z, mag = spec(m, mix)
        core = Core(m).eval()
        xs, xt = core(mix, mag)
        mine = ispec_sum(m, xs, xt, L)
    print("torch core vs model max err:", float((mine - ref).abs().max()), "ref max", float(ref.abs().max()))

    onnx_path = OUT / "demucs.onnx"
    torch.onnx.export(core, (mix, mag), str(onnx_path), input_names=["mix", "mag"], output_names=["spec", "wave"],
                      opset_version=17, do_constant_folding=True)
    # Bobot dipecah ke 2 file < 100 MB (batas file GitHub).
    model = onnx.load(str(onnx_path))
    big = [t for t in model.graph.initializer if t.data_type == onnx.TensorProto.FLOAT and np.prod(t.dims) * 4 > 1024]
    total = sum(int(np.prod(t.dims)) * 4 for t in big)
    acc = 0
    for f in OUT.glob("demucs.data*"):
        f.unlink()
    for t in big:
        part = 0 if acc < total / 2 else 1
        acc += int(np.prod(t.dims)) * 4
        onnx.external_data_helper.set_external_data(t, location=f"demucs.data{part}")
    onnx.external_data_helper.write_external_data_tensors(model, str(OUT))  # tulis bobot ke file data
    onnx.save_model(model, str(onnx_path))

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    ys, yt = sess.run(None, {"mix": mix.numpy(), "mag": mag.numpy()})
    with torch.no_grad():
        out = ispec_sum(m, torch.from_numpy(ys), torch.from_numpy(yt), L)
    err = float((out - ref).abs().max())
    print("ONNX vs model max err:", err)
    assert err < 1e-3, "hasil ONNX beda dari model asli"

    sizes = {p.name: p.stat().st_size for p in OUT.glob("demucs.*")}
    info = {
        "model": NAME, "sources": list(m.sources), "samplerate": sr, "segment": float(Fraction(m.segment)),
        "length": L, "frames": int(mag.shape[-1]), "bins": int(mag.shape[-2]), "nfft": m.nfft, "hop": m.hop_length,
        "files": sorted(sizes), "sizes": sizes, "max_err": err,
    }
    (OUT / "demucs.json").write_text(json.dumps(info, indent=1))
    print(json.dumps(info, indent=1))

    # Data uji buat ngecek STFT JavaScript (potongan kecil): input + spektrogram referensi
    tdir = Path(__file__).resolve().parent / "testdata"
    tdir.mkdir(exist_ok=True)
    tiny = torch.randn(1, 2, 12000) * 0.2
    zt, magt = spec(m, tiny)
    np.save(tdir / "stft_in.npy", tiny.numpy())
    np.save(tdir / "stft_mag.npy", magt.numpy())
    # iSTFT referensi: spektrogram acak -> audio
    with torch.no_grad():
        zs = torch.randn(1, 1, 4, magt.shape[-2], magt.shape[-1]) * 0.1
        wav0 = torch.zeros(1, 1, 2, 12000)
        back = ispec_sum(m, zs, wav0, 12000)
    np.save(tdir / "istft_spec.npy", zs.numpy())
    np.save(tdir / "istft_out.npy", back.numpy())


if __name__ == "__main__":
    main()
