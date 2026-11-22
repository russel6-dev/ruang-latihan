// Penyimpanan lokal di HP (IndexedDB): daftar lagu, file track, dan pengaturan.
const DB_NAME = 'ruang-latihan';
const DB_VERSION = 1;
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
    await tx('stems', 'readwrite', (s) => { for (const stem of song.stems) s.delete(`${song.id}:${stem}`); });
    await tx('songs', 'readwrite', (s) => { s.delete(song.id); });
  },
  get: (key) => tx('kv', 'readonly', (s) => req2p(s.get(key))),
  set: (key, value) => tx('kv', 'readwrite', (s) => { s.put(value, key); }),
};
