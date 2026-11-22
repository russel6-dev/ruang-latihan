// Komunikasi ke GitHub: upload lagu, nyalain proses di GitHub Actions, unduh hasil.
export const settings = {
  repo: '',        // "pemilik/nama-repo"; kosong = ditebak dari alamat GitHub Pages
  token: '',       // token GitHub (fine-grained) — cuma disimpan di HP ini
  rate: 44100,     // kualitas audio di HP: 44100 (tinggi) atau 32000 (hemat memori)
};

export function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem('rl-settings') || '{}'));
  } catch { /* abaikan */ }
}

export function saveSettings() {
  try { localStorage.setItem('rl-settings', JSON.stringify(settings)); } catch { /* abaikan */ }
}

export function defaultRepo() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return '';
  const owner = host.split('.')[0];
  const name = location.pathname.split('/').filter(Boolean)[0];
  return name ? `${owner}/${name}` : `${owner}/${host}`;
}

export const repoName = () => (settings.repo || defaultRepo()).trim();

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function explain(status, body) {
  if (status === 401) return 'Token GitHub salah atau kedaluwarsa — cek Pengaturan.';
  if (status === 403) {
    if (/rate limit/i.test(body)) return 'Kebanyakan request ke GitHub, tunggu beberapa menit.';
    return 'Token GitHub kurang izin (butuh Contents, Actions, Commit statuses).';
  }
  if (status === 404) return 'Nggak ketemu di GitHub (cek nama repo di Pengaturan).';
  return `GitHub error ${status}`;
}

async function gh(path, { method = 'GET', body, accept, raw = false } = {}) {
  if (!settings.token) throw new ApiError('Token GitHub belum diisi — buka Pengaturan ⚙️', 401);
  const repo = repoName();
  if (!repo) throw new ApiError('Nama repo belum diisi — buka Pengaturan ⚙️', 404);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Nggak bisa terhubung ke GitHub. Cek internet.', 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(explain(res.status, text), res.status);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1]);
    r.onerror = () => reject(new ApiError('Gagal membaca file lagu', 0));
    r.readAsDataURL(file);
  });
}

function postBlob(content, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.github.com/repos/${repoName()}/git/blobs`);
    xhr.setRequestHeader('Authorization', `Bearer ${settings.token}`);
    xhr.setRequestHeader('Accept', 'application/vnd.github+json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText).sha);
      else reject(new ApiError(explain(xhr.status, xhr.responseText), xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Nggak bisa terhubung ke GitHub. Cek internet.', 0));
    xhr.send(JSON.stringify({ content, encoding: 'base64' }));
  });
}

const MAX_MB = 60;

export const api = {
  // Cek token & repo. Dipakai di layar Pengaturan.
  async check() {
    const info = await gh('');
    if (!info.permissions?.push) throw new ApiError('Token ini nggak punya izin tulis ke repo.', 403);
    await gh('/actions/workflows/process.yml');
    return info.full_name;
  },

  async upload(file, title, onProgress) {
    if (file.size > MAX_MB * 1048576) throw new ApiError(`File terlalu besar (maks ${MAX_MB} MB)`, 413);
    if (!settings.token) throw new ApiError('Token GitHub belum diisi — buka Pengaturan ⚙️', 401);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase();
    const content = await readBase64(file);
    const blobSha = await postBlob(content, (p) => onProgress(p * 0.95));
    const tree = await gh('/git/trees', {
      method: 'POST',
      body: {
        tree: [
          { path: `input.${ext}`, mode: '100644', type: 'blob', sha: blobSha },
          { path: 'meta.json', mode: '100644', type: 'blob', content: JSON.stringify({ title }) },
        ],
      },
    });
    const commit = await gh('/git/commits', { method: 'POST', body: { message: `lagu ${id}`, tree: tree.sha, parents: [] } });
    await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/inbox/${id}`, sha: commit.sha } });
    await gh('/actions/workflows/process.yml/dispatches', { method: 'POST', body: { ref: 'main', inputs: { job: id } } });
    onProgress(1);
    return { id, sha: commit.sha };
  },

  // Status proses -> { status: queued|processing|done|error, stage, progress, message }
  async status(id, sha, checkRun = false) {
    try {
      await gh(`/git/ref/heads/results/${id}`);
      return { status: 'done', progress: 1 };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const combined = await gh(`/commits/${sha}/status`);
    const st = combined.statuses?.find((s) => s.context === 'ruang-latihan');
    if (st) {
      const [stage, rest] = (st.description || '').split('|');
      if (st.state === 'failure' || st.state === 'error') return { status: 'error', message: rest || 'Proses gagal' };
      if (st.state === 'success') return { status: 'processing', stage: 'encode', progress: 1 };
      return { status: 'processing', stage, progress: Number(rest) || 0 };
    }
    if (checkRun) {
      const run = await this.findRun(id);
      if (run && run.status === 'completed' && run.conclusion !== 'success') {
        return { status: 'error', message: `Proses di GitHub berhenti (${run.conclusion})` };
      }
    }
    return { status: 'queued', progress: 0 };
  },

  async findRun(id) {
    const data = await gh('/actions/runs?event=workflow_dispatch&per_page=30');
    return data.workflow_runs?.find((r) => r.display_title === `job ${id}`) || null;
  },

  async result(id) {
    const res = await gh(`/contents/result.json?ref=${encodeURIComponent(`results/${id}`)}`, { accept: 'application/vnd.github.raw+json', raw: true });
    return res.json();
  },

  async stem(id, stem) {
    const res = await gh(`/contents/${stem}.opus?ref=${encodeURIComponent(`results/${id}`)}`, { accept: 'application/vnd.github.raw+json', raw: true });
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: 'audio/ogg' });
  },

  // Bersihkan branch sementara (dan batalkan proses kalau masih jalan).
  async remove(id, cancel = false) {
    if (cancel) {
      try {
        const run = await this.findRun(id);
        if (run && run.status !== 'completed') await gh(`/actions/runs/${run.id}/cancel`, { method: 'POST' });
      } catch { /* abaikan */ }
    }
    for (const ref of [`results/${id}`, `inbox/${id}`]) {
      try { await gh(`/git/refs/heads/${ref}`, { method: 'DELETE' }); } catch { /* sudah tidak ada */ }
    }
  },
};
