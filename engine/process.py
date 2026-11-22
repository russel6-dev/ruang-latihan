"""Dijalankan oleh GitHub Actions: proses satu lagu dari branch inbox/<job>.

1. Ambil lagu dari branch inbox/<job> (diupload aplikasi di HP)
2. Pisah 6 instrumen (Demucs) + deteksi ketukan
3. Simpan hasil ke branch results/<job>, hapus branch inbox
Progress dilaporkan lewat "commit status" di commit inbox, supaya HP bisa menampilkannya.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import beats  # noqa: E402
import separator  # noqa: E402

REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GH_TOKEN"]
MAX_MINUTES = int(os.environ.get("MAX_MINUTES", "12"))
WORK = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "rl-job"
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")
RESULT_REMOTE = os.environ.get("RESULT_REMOTE", f"https://x-access-token:{TOKEN}@github.com/{REPO}.git")

STAGES = [("convert", 0.03), ("separate", 0.82), ("beats", 0.07), ("encode", 0.08)]


def sh(*cmd: str, cwd: Path | None = None) -> str:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} gagal: {r.stderr.strip()[-400:]}")
    return r.stdout


class Reporter:
    def __init__(self, sha: str):
        self.sha = sha
        self.last = 0.0

    def post(self, state: str, description: str) -> None:
        data = json.dumps({"state": state, "context": "ruang-latihan",
                           "description": description[:139]}).encode()
        req = urllib.request.Request(
            f"{API}/repos/{REPO}/statuses/{self.sha}", data=data, method="POST",
            headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"})
        try:
            urllib.request.urlopen(req, timeout=20).read()
        except Exception as exc:  # noqa: BLE001 — progress bukan hal kritis
            print("gagal lapor status:", exc)

    def progress(self, stage: str, p: float, force: bool = False) -> None:
        now = time.time()
        if not force and now - self.last < 8:
            return
        self.last = now
        total = 0.0
        for name, weight in STAGES:
            if name == stage:
                total += weight * p
                break
            total += weight
        self.post("pending", f"{stage}|{total:.3f}")


def main(job: str) -> None:
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)
    repo_dir = Path.cwd()

    sh("git", "fetch", "--depth=1", "origin", f"refs/heads/inbox/{job}", cwd=repo_dir)
    sha = sh("git", "rev-parse", "FETCH_HEAD", cwd=repo_dir).strip()
    rep = Reporter(sha)
    try:
        files = sh("git", "ls-tree", "--name-only", "FETCH_HEAD", cwd=repo_dir).split()
        meta = json.loads(sh("git", "show", "FETCH_HEAD:meta.json", cwd=repo_dir))
        src_name = next(f for f in files if f.startswith("input."))
        src = WORK / src_name
        with src.open("wb") as f:
            subprocess.run(["git", "show", f"FETCH_HEAD:{src_name}"], cwd=repo_dir, stdout=f, check=True)

        rep.progress("convert", 0, force=True)
        mix = WORK / "mix.wav"
        sh("ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100",
           "-t", str(MAX_MINUTES * 60), str(mix))

        rep.progress("separate", 0, force=True)
        t0 = time.time()
        stems = separator.separate(mix, WORK / "wav", lambda p: rep.progress("separate", p))
        print(f"pemisahan selesai dalam {time.time() - t0:.0f} detik")

        rep.progress("beats", 0, force=True)
        analysis = beats.analyze(str(mix), str(stems["drums"]) if "drums" in stems else None)

        rep.progress("encode", 0, force=True)
        out = WORK / "out"
        out.mkdir()
        names = [n for n in separator.STEMS if n in stems]
        for name in names:
            sh("ffmpeg", "-y", "-v", "error", "-i", str(stems[name]), "-c:a", "libopus", "-b:a", "128k",
               "-vbr", "on", str(out / f"{name}.opus"))
        result = {"title": meta.get("title", "Lagu"), "stems": names, **analysis}
        (out / "result.json").write_text(json.dumps(result))

        # Hasil -> branch results/<job> (commit tanpa riwayat, dihapus HP setelah diunduh)
        sh("git", "init", "-q", "-b", "result", cwd=out)
        sh("git", "add", ".", cwd=out)
        sh("git", "-c", "user.name=ruang-latihan", "-c", "user.email=ruang-latihan@users.noreply.github.com",
           "commit", "-q", "-m", f"hasil {job}", cwd=out)
        sh("git", "push", "-q", "-f", RESULT_REMOTE, f"HEAD:refs/heads/results/{job}", cwd=out)

        rep.post("success", "done|1")
        sh("git", "push", "-q", "origin", "--delete", f"inbox/{job}", cwd=repo_dir)
    except Exception as exc:
        rep.post("failure", f"error|{str(exc)[:120]}")
        raise


if __name__ == "__main__":
    main(sys.argv[1])
