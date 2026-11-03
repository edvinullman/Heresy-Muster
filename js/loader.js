// Fetches data files from GitHub at the pinned commit and keeps a copy in
// IndexedDB, so each file downloads once per browser.

import { dataUrl, DATA_COMMIT } from './config.js';

const DB_NAME = 'hh3-data';
const STORE = 'files';

function openDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cacheGet(db, key) {
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(db, key, value) {
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

let dbPromise = null;

// Load a list of manifest entries into the GameData. onProgress(doneBytes, totalBytes, label)
export async function loadFiles(data, entries, onProgress = () => {}) {
  dbPromise ||= openDb();
  const db = await dbPromise;
  const todo = entries.filter(m => !data.files.has(m.id));
  const total = todo.reduce((a, m) => a + m.size, 0);
  let done = 0;
  onProgress(0, total, todo[0]?.name || '');
  await Promise.all(todo.map(async (m) => {
    const key = DATA_COMMIT + '/' + m.file;
    let text = await cacheGet(db, key);
    if (!text) {
      const res = await fetch(dataUrl(m.file));
      if (!res.ok) throw new Error(`Could not download ${m.name} (HTTP ${res.status})`);
      text = await res.text();
      cachePut(db, key, text);
    }
    data.addFile(JSON.parse(text));
    done += m.size;
    onProgress(done, total, m.name);
  }));
}

export async function clearCache() {
  dbPromise ||= openDb();
  const db = await dbPromise;
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
