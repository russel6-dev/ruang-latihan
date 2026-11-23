# Ruang Latihan

Aplikasi latihan band buat HP (PWA):

- **Pisah 6 instrumen** (vokal, drum, bass, gitar, piano, lainnya) pakai model AI Demucs `htdemucs_6s`
- **Mixer**: mute / solo / volume per track, plus preset *Minus gitar*, *Minus bass*, *Minus drum*
- **Metronome otomatis** yang ngikutin ketukan asli lagu (bukan BPM rata), aksen ketukan 1, count-in
- **Peta tempo**: deteksi otomatis bagian dengan tempo berbeda, jeda sebelum perubahan tempo (dengan 1 bar hitungan tempo baru), bar ganjil, birama 3/4 & 4/4
- **Mode klik**: *Tempo tetap* (rata per bagian — cocok lagu studio) atau *Ikuti drummer*
- **Editor peta tempo**: BPM per bagian, ×2/÷2, birama, geser ketukan "1", bar ganjil, bagian baru, tap tempo
- **Ekspor** (di HP, offline): klik saja, sequencer saja, sesuai mixer, atau **klik kiri + SQ kanan** — WAV atau MP3, opsional count-in
- Peringatan "jangan tutup aplikasi" selama upload / unduh / ekspor
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
| `web/vendor/lame.min.js` | Encoder MP3 [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0, lihat `LICENSE-lamejs.txt`) |

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
