# Ruang Latihan

Aplikasi latihan band buat HP (PWA):

- **Pisah 6 instrumen** (vokal, drum, bass, gitar, piano, lainnya) pakai model AI Demucs `htdemucs_6s`
- **Mixer**: mute / solo / volume per track, plus preset *Minus gitar*, *Minus bass*, *Minus drum*
- **Metronome otomatis** yang ngikutin ketukan asli lagu (bukan BPM rata), aksen ketukan 1, count-in
- **Koreksi ketukan**: geser ketukan "1", geser halus ±10 ms, tempo ×2 / ÷2, tap tempo
- Hasil disimpan di HP, jadi latihan bisa **offline**

## Cara kerja (gratis, pakai GitHub)

```
HP (aplikasi di GitHub Pages)
  1. upload lagu ke branch sementara inbox/<id>
  2. nyalain workflow "Proses lagu"
GitHub Actions
  3. pisah instrumen (Demucs) + deteksi ketukan (librosa), lapor progress lewat commit status
  4. simpan hasil (6 track Opus + result.json) ke branch results/<id>, hapus inbox/<id>
HP
  5. unduh hasil, simpan di HP (IndexedDB), hapus branch results/<id>
```

## Struktur

| Folder | Isi |
|---|---|
| `web/` | Aplikasi di HP (HTML/JS tanpa build): mixer, metronome, penyimpanan offline |
| `engine/` | Dijalankan GitHub Actions: pemisah instrumen + deteksi ketukan |
| `.github/workflows/process.yml` | Workflow pemroses lagu |
| `.github/workflows/pages.yml` | Menerbitkan `web/` ke GitHub Pages |
| `tools/make_icons.py` | Bikin ikon aplikasi |

## Setup sekali

1. Repo harus **public** (supaya menit GitHub Actions gratis tanpa batas).
2. Settings → Pages → Source: **GitHub Actions**.
3. Bikin token *fine-grained* khusus repo ini, izin: **Contents** (read & write), **Actions** (read & write), **Commit statuses** (read).
4. Buka `https://<user>.github.io/ruang-latihan/` di Chrome HP → ⚙️ → isi token → **Tambahkan ke layar utama**.

## Tes lokal tanpa model AI

```bash
pip install librosa soundfile pillow
SEPARATOR=fake GITHUB_REPOSITORY=me/repo GH_TOKEN=x RESULT_REMOTE=/path/ke/bare.git python engine/process.py <job>
```
