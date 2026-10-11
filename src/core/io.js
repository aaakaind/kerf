// File output that works everywhere: a normal browser download when standalone, the viewer's
// save prompt when KERF runs inside a sandboxed viewer (with a .zip wrapper for formats that
// viewer refuses, e.g. .stl / .step / .glb).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { toast } from './ui.js';

const VIEWER_OK = new Set('gif png jpg jpeg webp mp4 webm txt json md docx pptx epub csv ttf html svg pdf xlsx zip'.split(' '));
let capPromise = null;
function downloadsCap() {
  if (!capPromise) {
    const c = typeof window !== 'undefined' && window.claude;
    capPromise = c && typeof c.use === 'function' ? c.use('downloads').catch(() => null) : Promise.resolve(null);
  }
  return capPromise;
}
/**
 * Fetch one of KERF's own files that sit next to the page. Some hosts only serve text, so each
 * binary may also be published as `<name>.b64.txt` (base64); that copy is tried second.
 * Returns the bytes, or throws with the last reason.
 */
export async function fetchBundled(name) {
  let last = '';
  for (const [url, b64] of [[name, false], [name + '.b64.txt', true]]) {
    try {
      const res = await fetch(url); if (!res.ok) { last = `${url}: HTTP ${res.status}`; continue; }
      if (!b64) return new Uint8Array(await res.arrayBuffer());
      const bin = atob((await res.text()).replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { last = `${url}: ${e.message}`; }
  }
  throw new Error(last || `${name} not found`);
}
export const inViewer = () => !!(typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function');

export async function saveFile(filename, data, mime = 'application/octet-stream') {
  const ext = filename.split('.').pop().toLowerCase();
  const dl = await downloadsCap();
  if (dl) {
    let name = filename, payload = data;
    if (!VIEWER_OK.has(ext)) { // wrap in a zip so the viewer will accept it
      const bytes = await toBytes(data);
      payload = new Blob([makeZip([{ name: filename, data: bytes }])], { type: 'application/zip' });
      name = filename + '.zip';
    }
    try { await dl.save({ filename: name, data: payload instanceof Blob ? payload : new Blob([payload], { type: mime }) }); toast(`Saved ${name}`); return true; }
    catch (e) {
      if (e?.code === 'declined') { toast('Save cancelled'); return false; }
      if (e?.code === 'rate_limited') { toast('A save prompt is already open. Finish that one first.', 'bad'); return false; }
      if (e?.code === 'rejected_extension' || e?.code === 'extension_not_enabled') { toast(`This viewer can't save .${ext} files.`, 'bad'); return false; }
      // otherwise fall through to a plain download
    }
  }
  if (typeof window !== 'undefined' && window.KerfNative?.saveFile) { // Android app: the system "Save to…" picker
    const bytes = await toBytes(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    const ok = window.KerfNative.saveFile(filename, mime, bytesToBase64(bytes));
    if (!ok) { toast('Could not hand the file to Android', 'bad'); return false; }
    return await new Promise((res) => { const on = (e) => { window.removeEventListener('kerf-native-saved', on); toast(e.detail?.ok ? `Saved ${filename}` : 'Save cancelled', e.detail?.ok ? '' : 'bad'); res(!!e.detail?.ok); }; window.addEventListener('kerf-native-saved', on); });
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  toast(`Saved ${filename}`);
  return true;
}
async function toBytes(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof Blob) return new Uint8Array(await d.arrayBuffer());
  return new TextEncoder().encode(String(d));
}

// ---------- minimal ZIP (stored, no compression) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name); const data = f.data; const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

export function safeName(s, fallback = 'kerf') { return (String(s || fallback).replace(/[^\w\- .]+/g, '').trim().replace(/\s+/g, '-') || fallback).slice(0, 80); }
export function dataURLToBytes(url) {
  const b64 = url.split(',')[1]; const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
export function bytesToBase64(bytes) {
  let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s);
}
