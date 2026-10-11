// Fonts: bundled house faces (no network), system faces, and user font files embedded in the document.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { store, addAsset } from './store.js';
import { readAsDataURL } from './ui.js';

export const BASE_FONTS = ['Jost', 'IBM Plex Sans', 'IBM Plex Mono', 'Georgia', 'Times New Roman', 'Helvetica', 'Arial', 'Courier New', 'system-ui'];
const registered = new Set();

export function allFonts() {
  const extra = Object.values(store.doc.assets || {}).filter(a => a.kind === 'font').map(a => a.family);
  return [...new Set([...BASE_FONTS, ...extra])];
}
export async function registerFontAssets() {
  for (const [id, a] of Object.entries(store.doc.assets || {})) {
    if (a.kind !== 'font' || registered.has(id)) continue;
    try { const ff = new FontFace(a.family, `url(${a.data})`); await ff.load(); document.fonts.add(ff); registered.add(id); }
    catch (e) { console.warn('Font failed to load', a.family, e); }
  }
}
export async function addFontFile(file) {
  const data = await readAsDataURL(file);
  const family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').trim();
  const ff = new FontFace(family, `url(${data})`); await ff.load(); document.fonts.add(ff);
  const id = addAsset({ kind: 'font', name: file.name, family, data }); registered.add(id);
  return family;
}
export const fallbackFor = (f) => /mono/i.test(f) ? 'ui-monospace, monospace' : /georgia|times|serif/i.test(f) && !/sans/i.test(f) ? 'Georgia, serif' : 'system-ui, sans-serif';
