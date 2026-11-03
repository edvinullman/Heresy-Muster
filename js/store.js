// Saved lists live in this browser's localStorage. Lists move between people
// as files or as share links that carry the list itself.

const KEY = 'hh3-lists-v1';

export function loadLists() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function saveLists(lists) {
  try { localStorage.setItem(KEY, JSON.stringify(lists)); return true; } catch { return false; }
}

export function upsertList(raw) {
  const lists = loadLists();
  raw.updated = Date.now();
  const i = lists.findIndex(l => l.id === raw.id);
  if (i >= 0) lists[i] = raw; else lists.unshift(raw);
  saveLists(lists);
}

export function deleteList(id) {
  saveLists(loadLists().filter(l => l.id !== id));
}

// ---- share links: deflate + base64url in the URL fragment ----
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeShare(raw) {
  const slim = { v: 1, ...raw };
  const bytes = new TextEncoder().encode(JSON.stringify(slim));
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(bytes);
  const z = await pipe(bytes, new CompressionStream('deflate-raw'));
  let s = '';
  for (let i = 0; i < z.length; i += 8192) s += String.fromCharCode(...z.subarray(i, i + 8192));
  return 'z' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodeShare(code) {
  const kind = code[0];
  const bytes = unb64url(code.slice(1));
  const json = kind === 'z' ? new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw'))) : new TextDecoder().decode(bytes);
  const raw = JSON.parse(json);
  delete raw.v;
  return raw;
}

// ---- presets: saved units and detachments, reusable across lists ----
const PKEY = 'hh3-presets-v1';

export function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PKEY) || '[]'); } catch { return []; }
}

function savePresets(list) {
  try { localStorage.setItem(PKEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function addPreset(preset) {
  const list = loadPresets();
  list.unshift(preset);
  return savePresets(list);
}

export function deletePreset(id) {
  savePresets(loadPresets().filter(p => p.id !== id));
}

// Deep copy of saved selections or a force, with fresh ids.
export function freshCopy(raw) {
  const c = JSON.parse(JSON.stringify(raw));
  const reid = (r) => {
    r.id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    (r.selections || []).forEach(reid);
    (r.forces || []).forEach(reid);
  };
  reid(c);
  return c;
}
