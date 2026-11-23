// Penyimpanan lokal di HP (IndexedDB): daftar lagu, file track, dan pengaturan.
const DB_NAME = 'ruang-latihan';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('stems')) db.createObjectStore('stems');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaksi dibatalkan'));
  });
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const db = {
  async listSongs() {
    const songs = await tx('songs', 'readonly', (s) => req2p(s.getAll()));
    return songs.sort((a, b) => b.created - a.created);
  },
  getSong: (id) => tx('songs', 'readonly', (s) => req2p(s.get(id))),
  putSong: (song) => tx('songs', 'readwrite', (s) => { s.put(song); }),
  putStem: (songId, stem, blob) => tx('stems', 'readwrite', (s) => { s.put(blob, `${songId}:${stem}`); }),
  getStem: (songId, stem) => tx('stems', 'readonly', (s) => req2p(s.get(`${songId}:${stem}`))),
  async deleteSong(song) {
    const takes = await this.listTakes(song.id);
    for (const t of takes) await this.deleteTake(t);
    await tx('stems', 'readwrite', (s) => { for (const stem of song.stems) s.delete(`${song.id}:${stem}`); });
    await tx('songs', 'readwrite', (s) => { s.delete(song.id); });
  },

  // ---- rekaman (take). Audio/video disimpan sebagai blob di store 'stems' dengan kunci sendiri.
  async listTakes(songId) {
    const all = await tx('takes', 'readonly', (s) => req2p(s.getAll()));
    return all.filter((t) => t.songId === songId).sort((a, b) => a.created - b.created);
  },
  putTake: (take) => tx('takes', 'readwrite', (s) => { s.put(take); }),
  putBlob: (key, blob) => tx('stems', 'readwrite', (s) => { s.put(blob, key); }),
  getBlob: (key) => tx('stems', 'readonly', (s) => req2p(s.get(key))),
  deleteBlobs: (keys) => tx('stems', 'readwrite', (s) => { for (const k of keys) s.delete(k); }),
  async blobKeys(prefix) {
    const keys = await tx('stems', 'readonly', (s) => req2p(s.getAllKeys()));
    return keys.filter((k) => typeof k === 'string' && k.startsWith(prefix));
  },
  async deleteTake(take) {
    await this.deleteBlobs([`take:${take.id}`, `video:${take.id}`]);
    await tx('takes', 'readwrite', (s) => { s.delete(take.id); });
  },
  get: (key) => tx('kv', 'readonly', (s) => req2p(s.get(key))),
  set: (key, value) => tx('kv', 'readwrite', (s) => { s.put(value, key); }),
};
