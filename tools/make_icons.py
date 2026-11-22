"""Bikin ikon aplikasi (PNG) — dijalankan saat build Docker."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
BG = (16, 18, 23)
ACCENT = (255, 176, 32)
TRACK = (58, 63, 75)


def draw(size: int, maskable: bool) -> Image.Image:
    s = 4  # supersampling biar halus
    S = size * s
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)
    pad = S * (0.24 if maskable else 0.16)
    area = S - 2 * pad
    # tiga fader mixer
    knobs = [0.62, 0.30, 0.48]
    w = area / 7
    for i, k in enumerate(knobs):
        cx = pad + w * (1.5 + 2 * i)
        d.rounded_rectangle([cx - w * 0.16, pad, cx + w * 0.16, S - pad], radius=w * 0.16, fill=TRACK)
        ky = pad + area * k
        d.rounded_rectangle([cx - w * 0.62, ky - w * 0.36, cx + w * 0.62, ky + w * 0.36], radius=w * 0.2,
                            fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192, False).save(OUT / "icon-192.png")
    draw(512, False).save(OUT / "icon-512.png")
    draw(512, True).save(OUT / "maskable-512.png")
    print("ikon dibuat di", OUT)
