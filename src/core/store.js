// KERF document store: one open JSON document for all four workspaces, undo/redo, autosave.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { uid } from './ui.js';

export const FORMAT_VERSION = 1;
export const PT_PER_MM = 72 / 25.4;

export function blankDoc(name = 'Untitled') {
  return {
    kerf: FORMAT_VERSION, name, created: new Date().toISOString(), modified: new Date().toISOString(),
    assets: {},
    vector: { artboards: [{ id: uid('ab'), name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600, bg: '#ffffff' }], items: [] },
    layout: {
      unit: 'mm',
      page: { w: 148 * PT_PER_MM, h: 210 * PT_PER_MM, margins: { t: 15 * PT_PER_MM, b: 18 * PT_PER_MM, i: 15 * PT_PER_MM, o: 15 * PT_PER_MM }, cols: 2, gutter: 5 * PT_PER_MM, bleed: 3 * PT_PER_MM },
      facing: true,
      styles: defaultStyles(),
      stories: {},
      masters: [{ id: 'A', name: 'A-Master', items: [] }],
      pages: [{ id: uid('pg'), master: 'A', items: [] }],
    },
    mesh: { objects: [], bg: null, grid: true },
    cad: { vars: [{ name: 'w', expr: '60 mm' }], configs: [], activeConfig: null, features: [], rollback: null, material: 'al6061', units: 'mm' },
  };
}

export function defaultStyles() {
  return {
    body: { name: 'Body', font: 'IBM Plex Sans', size: 9.5, leading: 13.5, weight: 400, italic: false, color: '#1c1a17', align: 'justify', before: 0, after: 0, indent: 10, tracking: 0, hyphenate: true, upper: false },
    h1: { name: 'Heading 1', font: 'Jost', size: 30, leading: 30, weight: 700, italic: false, color: '#1c1a17', align: 'left', before: 0, after: 10, indent: 0, tracking: -0.01, hyphenate: false, upper: false },
    h2: { name: 'Heading 2', font: 'Jost', size: 13, leading: 16, weight: 600, italic: false, color: '#6b4428', align: 'left', before: 9, after: 3, indent: 0, tracking: 0, hyphenate: false, upper: false },
    quote: { name: 'Pull quote', font: 'Jost', size: 16, leading: 19, weight: 500, italic: false, color: '#c8432b', align: 'left', before: 8, after: 8, indent: 0, tracking: 0, hyphenate: false, upper: false },
    caption: { name: 'Caption', font: 'IBM Plex Mono', size: 7, leading: 9.5, weight: 400, italic: false, color: '#625a4d', align: 'left', before: 3, after: 0, indent: 0, tracking: 0.04, hyphenate: false, upper: true },
    folio: { name: 'Folio', font: 'IBM Plex Mono', size: 7, leading: 9, weight: 600, italic: false, color: '#1c1a17', align: 'left', before: 0, after: 0, indent: 0, tracking: 0.08, hyphenate: false, upper: true },
  };
}

// ---------- events ----------
const listeners = new Map();
export function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); }
export function emit(evt, data) { listeners.get(evt)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

// ---------- state & history ----------
export const store = { doc: blankDoc(), dirty: false, fileName: null };
const past = [], future = [];
const MAX_HISTORY = 120;
let pending = null; // snapshot captured at checkpoint() awaiting a real change

const snap = () => JSON.stringify({ ...store.doc, assets: undefined });
function restore(json) { const assets = store.doc.assets; store.doc = JSON.parse(json); store.doc.assets = assets; }

/** Call before a mutation (or at the start of a drag). Groups everything until the next checkpoint. */
export function checkpoint(label = 'Edit') {
  pending = { json: snap(), label };
  past.push(pending); if (past.length > MAX_HISTORY) past.shift();
  future.length = 0;
}
/** Convenience: checkpoint + mutate + notify. */
export function commit(label, fn, ws) { checkpoint(label); fn(store.doc); changed(ws); }
/** Notify listeners that the doc changed (render). */
export function changed(ws, opts = {}) {
  store.dirty = true; store.doc.modified = new Date().toISOString();
  emit('change', { ws, ...opts }); scheduleAutosave();
}
/** Drop a checkpoint if nothing actually changed (e.g. a click without drag). */
export function settle() { if (pending && past[past.length - 1] === pending && pending.json === snap()) past.pop(); pending = null; }
export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }
export function undo() { if (!past.length) return null; const p = past.pop(); future.push({ json: snap(), label: p.label }); restore(p.json); pending = null; emit('doc', { reason: 'undo' }); scheduleAutosave(); return p.label; }
export function redo() { if (!future.length) return null; const f = future.pop(); past.push({ json: snap(), label: f.label }); restore(f.json); pending = null; emit('doc', { reason: 'redo' }); scheduleAutosave(); return f.label; }
export function replaceDoc(doc, fileName = null) {
  store.doc = migrate(doc); store.fileName = fileName; store.dirty = false; past.length = 0; future.length = 0; pending = null;
  emit('doc', { reason: 'open' }); scheduleAutosave();
}
function migrate(doc) {
  if (!doc || typeof doc !== 'object' || !doc.kerf) throw new Error('This is not a KERF document (missing "kerf" version field).');
  if (doc.kerf > FORMAT_VERSION) throw new Error(`This file was made by a newer KERF (format v${doc.kerf}). Update KERF to open it.`);
  const base = blankDoc(doc.name);
  for (const k of ['assets', 'vector', 'layout', 'mesh', 'cad']) doc[k] = { ...base[k], ...(doc[k] || {}) };
  doc.layout.styles = { ...defaultStyles(), ...(doc.layout.styles || {}) };
  return doc;
}

// ---------- assets ----------
export function addAsset(asset) { const id = uid('as'); store.doc.assets[id] = asset; return id; }
export function asset(id) { return store.doc.assets[id]; }
const blobURLs = new Map();
/** Short blob: URL for an embedded asset (keeps canvases fast; data: URLs stay in the file). */
export function assetURL(id) {
  const a = store.doc.assets[id]; if (!a) return '';
  let u = blobURLs.get(id); if (u && u.src === a.data) return u.url;
  try {
    const [head, b64] = a.data.split(','); const mime = head.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
    if (!/;base64/.test(head)) return a.data;
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    u = { src: a.data, url: URL.createObjectURL(new Blob([bytes], { type: mime })) }; blobURLs.set(id, u); return u.url;
  } catch { return a.data; }
}

// ---------- autosave (IndexedDB; never required — saving to a file is the real save) ----------
let saveTimer = null;
export let autosaveState = 'idle';
function scheduleAutosave() { clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 1500); }
function idb() {
  return new Promise((res, rej) => {
    try { const r = indexedDB.open('kerf', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
    catch (e) { rej(e); }
  });
}
async function autosave() {
  try {
    const db = await idb();
    await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(JSON.stringify(store.doc), 'autosave'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    autosaveState = 'saved'; emit('autosave', 'saved');
  } catch { autosaveState = 'off'; emit('autosave', 'off'); }
}
export async function loadAutosave() {
  try {
    const db = await idb();
    const json = await new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const r = tx.objectStore('kv').get('autosave'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return json ? JSON.parse(json) : null;
  } catch { return null; }
}
export function serialize() { return JSON.stringify(store.doc); }
export function parseDoc(text) { return migrate(JSON.parse(text)); }
