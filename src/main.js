// KERF application shell: top bar, workspace tabs, rails, inspector panel, status bar, file menu, shortcuts.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { h, icon, toast, dialog, menu, closeMenu, registerCommand, openPalette, isTyping, pickFile, readAsText, modKey, confirmDialog, promptDialog, iconBtn } from './core/ui.js';
import * as S from './core/store.js';
import { saveFile, safeName, fetchBundled } from './core/io.js';
import layout from './ws/layout.js';
import vector from './ws/vector.js';
import mesh from './ws/mesh.js';
import cad from './ws/cad/cad.js';
import { sampleDoc } from './core/sample.js';
import { akaSVG } from './core/brand.js';

const WS = [layout, vector, mesh, cad];
const WS_COLORS = { layout: 'var(--mustard)', vector: 'var(--red)', mesh: 'var(--teal)', cad: 'var(--walnut)' };
/* global __KERF_VERSION__, __KERF_SOURCE_URL__ */
const VERSION = typeof __KERF_VERSION__ === 'string' ? __KERF_VERSION__ : '0.1.0';
const SOURCE_URL = typeof __KERF_SOURCE_URL__ === 'string' ? __KERF_SOURCE_URL__ : ''; // set KERF_SOURCE_URL at build time

const app = h('div', { id: 'app', 'data-ws': 'layout' });
const tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Workspaces' });
const docName = h('button', { class: 'docname', type: 'button', title: 'Rename document' });
const undoBtn = iconBtn('undo', `Undo (${modKey}+Z)`, () => doUndo(), 'ghost hide-sm');
const redoBtn = iconBtn('redo', `Redo (${modKey}+Shift+Z)`, () => doRedo(), 'ghost hide-sm');
const fileBtn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'File' }, h('span', { html: icon('menu', 16) }), h('span', { class: 'hide-xs' }, 'File'));
const sheetBtn = iconBtn('sheet', 'Show panel', () => app.classList.toggle('sheet-open'), 'sheet-toggle');
const bar = h('header', { class: 'bar' },
  h('div', { class: 'brand' }, h('div', { class: 'mark', 'aria-hidden': 'true' }), h('div', null, h('div', { class: 'word' }, 'KERF'), h('div', { class: 'spec' }, `KF-01 · v${VERSION} · AI² Lab`))),
  tabs,
  h('div', { class: 'bar-actions' }, docName, undoBtn, redoBtn,
    iconBtn('cmd', `Commands (${modKey}+K)`, () => openPalette(() => current.id, WS_COLORS), 'ghost hide-xs'),
    fileBtn, sheetBtn,
    h('button', { class: 'btn hide-sm', type: 'button', title: 'What KERF promises', onclick: () => showPledge() }, h('span', { html: icon('pledge', 16) }), 'Pledge')));
const rail = h('aside', { class: 'rail', 'aria-label': 'Tools' });
// The rail stamp reads like a timber grade stamp: product, grade line, and the mill's mark (AKA IND).
const railStamp = h('div', { class: 'stamp', 'aria-hidden': 'true' }, h('b', null, 'KERF'), h('span', null, 'Open tools · no rent'), h('i', { class: 'aka', html: akaSVG() }));
const stage = h('section', { class: 'stage', 'aria-label': 'Canvas' });
const panel = h('aside', { class: 'panel', 'aria-label': 'Inspector' });
const statusLeft = h('div', { class: 'left' });
const autosaveEl = h('span', null, 'Autosave —');
const status = h('footer', { class: 'status' }, statusLeft,
  h('div', { class: 'right' }, autosaveEl, h('span', { class: 'hide-sm' }, h('b', null, 'No account'), ' · ', h('b', null, 'No tracking'), ' · ', h('b', null, 'AGPL-3.0')), h('a', { class: 'aka-link', href: '#', title: 'Made by AKA IND Technologies Inc. · AI² Lab', html: akaSVG('AKA IND'), onclick: (e) => { e.preventDefault(); showPledge(); } })));
app.append(bar, h('div', { class: 'main' }, rail, stage, panel), status);

let current = null;
const mounts = {};
const ctx = {
  store: S.store, S, toast, WS_COLORS,
  get ws() { return Object.fromEntries(WS.map(w => [w.id, w])); },
  get active() { return current?.id; },
  setStatus(id, text) { if (current?.id === id) statusLeft.textContent = text; },
  activate: (id) => activate(id),
  ensure(id) { const w = WS.find(x => x.id === id); const m = mounts[id]; if (w && m && !m.inited) { w.init(ctx, m); m.inited = true; } },
  openSheet() { if (matchMedia('(max-width: 820px)').matches) app.classList.add('sheet-open'); },
};

function buildTabs() {
  for (const w of WS) {
    const short = { layout: 'Lay', vector: 'Vec', mesh: '3D', cad: 'CAD' }[w.id];
    const b = h('button', { class: 'tab', role: 'tab', type: 'button', id: 'tab-' + w.id, 'aria-selected': 'false', 'aria-controls': 'ws-' + w.id, onclick: () => activate(w.id) },
      h('span', { class: 'dot', style: { background: WS_COLORS[w.id] } }), h('span', { class: 'lbl-long' }, w.label), h('span', { class: 'lbl-short' }, short));
    tabs.append(b);
    const root = h('div', { class: 'ws-root', id: 'ws-' + w.id, role: 'tabpanel', 'aria-labelledby': 'tab-' + w.id, hidden: true });
    const railInner = h('div', { class: 'rail-inner', hidden: true });
    const panelInner = h('div', { hidden: true });
    stage.append(root); rail.append(railInner); panel.append(panelInner);
    mounts[w.id] = { root, rail: railInner, panel: panelInner, inited: false };
  }
  rail.append(railStamp);
}

function activate(id) {
  const w = WS.find(x => x.id === id) || WS[0];
  if (current === w) return;
  if (current) { current.hide?.(); const m = mounts[current.id]; m.root.hidden = m.rail.hidden = m.panel.hidden = true; }
  current = w; app.dataset.ws = w.id;
  for (const b of tabs.children) b.setAttribute('aria-selected', String(b.id === 'tab-' + w.id));
  const m = mounts[w.id];
  m.root.hidden = m.rail.hidden = m.panel.hidden = false;
  if (!m.inited) { w.init(ctx, m); m.inited = true; }
  statusLeft.textContent = w.status?.() || '';
  w.show?.();
  fitRail();
  try { history.replaceState(null, '', '#' + w.id); } catch { /* sandboxed frames may refuse */ }
}

function refreshTitle() {
  docName.textContent = S.store.doc.name || 'Untitled';
  document.title = 'KERF';
}

function doUndo() { const l = S.undo(); if (l) toast('Undid ' + l); }
function doRedo() { const l = S.redo(); if (l) toast('Redid ' + l); }

async function saveProject() {
  const name = safeName(S.store.doc.name, 'kerf-project') + '.kerf.json';
  if (await saveFile(name, S.serialize(), 'application/json')) S.store.dirty = false;
}
async function openProject() {
  const f = await pickFile('.json,.kerf,application/json');
  if (!f) return;
  try { const doc = S.parseDoc(await readAsText(f)); S.replaceDoc(doc, f.name); toast(`Opened ${f.name}`); }
  catch (e) { toast(`Couldn't open ${f.name}: ${e.message}`, 'bad'); }
}
async function newProject() {
  if (S.store.dirty && !(await confirmDialog('Start a new document?', 'Your current document is autosaved in this browser, but only a saved file is safe to keep. Save first if you need it.', 'Start new'))) return;
  S.replaceDoc(S.blankDoc('Untitled'));
}
function loadSample() { S.replaceDoc(sampleDoc()); toast('Loaded the sample project'); }

function fileMenu() {
  const wsItems = current?.fileMenu?.() || [];
  menu(fileBtn, [
    { header: 'Document' },
    { label: 'New document', icon: 'page', run: newProject },
    { label: 'Open…', icon: 'upload', keys: `${modKey}+O`, run: openProject },
    { label: 'Save as file', icon: 'download', keys: `${modKey}+S`, run: saveProject },
    { label: 'Open the sample project', icon: 'wand', run: loadSample },
    '-',
    { header: current.label },
    ...wsItems,
    '-',
    { header: 'View' },
    { label: 'Theme: follow system', run: () => setTheme(null) },
    { label: 'Theme: light', run: () => setTheme('light') },
    { label: 'Theme: dark', run: () => setTheme('dark') },
    '-',
    { label: 'The KERF Pledge', icon: 'pledge', run: showPledge },
    { label: 'Keyboard shortcuts', icon: 'cmd', run: showShortcuts },
  ]);
}
function setTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('kerf.theme', t || ''); } catch { /* storage may be blocked */ }
  S.emit('theme', t);
}

function showPledge() {
  const items = [
    ['Free, with every tool.', 'No trial, no tiers, no “pro” lock on core features. The same app for a student and a studio.'],
    ['No account.', 'Open it and work. There is nothing to sign up for, so there is nothing to cancel.'],
    ['No subscription, no stored card, no auto-renewal.', 'KERF never asks for payment details. If you ever chip in, it is a one-time contribution you choose, with no strings.'],
    ['No tracking.', 'No analytics, no telemetry, no third-party requests. Even the typefaces ship inside the app.'],
    ['Your files are yours.', 'One open, documented JSON format, plus export to PDF, SVG, PNG, STL, OBJ, GLB and STEP. Leaving is always one click.'],
    ['A licence that keeps it open.', 'AGPL-3.0: use it, study it, change it, share it. Anyone who hosts a modified KERF must publish their changes, so nobody can wall it off and rent it back to you.'],
    ['Works on your machine.', 'Everything runs locally once the page has loaded, including the CAD kernel.'],
  ];
  dialog({ title: 'The KERF Pledge', body: h('div', { class: 'pledge' },
    h('p', null, 'Design software should be bought like a hammer, not leased like a car. These promises are written into the code and into PLEDGE.md. The source is open, so anyone can check them, and anyone can fork KERF if they are ever broken.'),
    h('ol', null, items.map(([b, t], i) => h('li', null, h('span', { class: 'n' }, String(i + 1)), h('p', null, h('b', null, b), t)))),
    h('div', { class: 'maker' }, h('span', { class: 'aka', html: akaSVG('AKA IND') }), h('p', { class: 'hint' }, `KERF ${VERSION} · made by AKA IND Technologies Inc. · an AI² Lab open-source project`, SOURCE_URL ? ` · Source: ${SOURCE_URL}` : ''))),
    actions: [{ label: 'Licences', onClick: () => { showLicences(); return false; } }, { label: 'Get the source', onClick: () => { getSource(); return false; } }, { label: 'Close', primary: true }] });
}
function showLicences() {
  const text = document.getElementById('kerf-notices')?.textContent?.trim() || 'KERF is licensed AGPL-3.0-or-later. Third-party notices are in the NOTICE file of the source.';
  dialog({ title: 'Open-source licences', wide: true, body: h('pre', { class: 'notices' }, text), actions: [{ label: 'Close', primary: true }] });
}
// AGPL §13: every running copy offers its own complete source. The build places it next to the page.
async function getSource() {
  try {
    const bytes = await fetchBundled(`kerf-${VERSION}-source.zip`);
    await saveFile(`kerf-${VERSION}-source.zip`, new Blob([bytes], { type: 'application/zip' }), 'application/zip');
  } catch {
    toast(SOURCE_URL ? `Source: ${SOURCE_URL}` : 'The source archive is not next to this copy. Ask whoever hosts it, or see the project README.', SOURCE_URL ? '' : 'bad');
  }
}
function showShortcuts() {
  const rows = [
    ['Global', `${modKey}+K command palette · ${modKey}+Z undo · ${modKey}+Shift+Z redo · ${modKey}+S save · ${modKey}+O open · Alt+1…4 switch workspace`],
    ['Vector', 'V select · A direct select · P pen · N pencil · M rectangle · L ellipse · Y polygon · S star · \\ line · T text · I eyedropper · H hand · Space+drag pan · Shift constrains · Alt from centre · ' + modKey + '+D duplicate'],
    ['Layout', 'V select · T text frame · F image frame · M rectangle · L ellipse · \\ line · H hand · double-click a text frame to edit its story'],
    ['Mesh', 'W move · E rotate · R scale · F frame selection · Delete remove · ' + modKey + '+D duplicate'],
    ['CAD', 'Click a feature to edit · drag the rollback bar · F fit view · 1/2/3/0 front/top/right/iso'],
  ];
  dialog({ title: 'Keyboard shortcuts', wide: true, body: h('div', { class: 'stat-grid', style: { gridTemplateColumns: '90px 1fr', gap: '10px 14px', fontFamily: 'var(--sans)' } },
    rows.flatMap(([a, b]) => [h('dt', null, a), h('dd', { style: { textAlign: 'left' } }, b)])), actions: [{ label: 'Close', primary: true }] });
}

function registerGlobalCommands() {
  const g = (id, label, run, keys, tags) => registerCommand({ id, label, run, keys, tags });
  g('file.save', 'Save document as file', saveProject, `${modKey}+S`, 'download kerf json');
  g('file.open', 'Open document…', openProject, `${modKey}+O`, 'load import kerf');
  g('file.new', 'New document', newProject, null, 'blank');
  g('file.sample', 'Open the sample project', loadSample, null, 'demo example');
  g('edit.undo', 'Undo', doUndo, `${modKey}+Z`);
  g('edit.redo', 'Redo', doRedo, `${modKey}+Shift+Z`);
  g('app.pledge', 'Show the KERF Pledge', showPledge, null, 'license free open source');
  g('app.source', 'Download KERF source code', getSource, null, 'agpl github repository code');
  g('app.licences', 'Show open-source licences', showLicences, null, 'license notices third party credits');
  g('app.keys', 'Keyboard shortcuts', showShortcuts, null, 'help hotkeys');
  for (const [i, w] of WS.entries()) g('ws.' + w.id, `Go to ${w.label}`, () => activate(w.id), `Alt+${i + 1}`, 'workspace switch tab');
  g('theme.dark', 'Theme: dark', () => setTheme('dark')); g('theme.light', 'Theme: light', () => setTheme('light')); g('theme.system', 'Theme: follow system', () => setTheme(null));
}

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(() => current.id, WS_COLORS); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
  if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); activate(WS[+e.key - 1].id); return; }
  if (isTyping(e)) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  if (document.querySelector('.backdrop')) return;
  current?.onKey?.(e);
}

function updateHistoryButtons() { undoBtn.disabled = !S.canUndo(); redoBtn.disabled = !S.canRedo(); }

function fitRail() { requestAnimationFrame(() => { const inner = current && mounts[current.id].rail; if (!inner) return; rail.classList.toggle('tight', inner.scrollHeight + 190 > rail.clientHeight); }); }
// three-bvh-csg passes an option that newer three-mesh-bvh renamed; silence that one deprecation notice.
{ const w = console.warn; console.warn = (...a) => { if (typeof a[0] === 'string' && a[0].includes('"maxLeafSize"')) return; w(...a); }; }
async function boot() {
  document.body.append(app);
  try { const t = localStorage.getItem('kerf.theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch { /* ignore */ }
  buildTabs();
  registerGlobalCommands();
  for (const w of WS) w.register?.(ctx);
  fileBtn.addEventListener('click', fileMenu);
  docName.addEventListener('click', async () => {
    const n = await promptDialog('Rename document', 'Document name', S.store.doc.name);
    if (n != null && n.trim()) S.commit('Rename', d => { d.name = n.trim(); });
  });
  document.addEventListener('keydown', onKey);
  S.on('doc', () => { refreshTitle(); updateHistoryButtons(); for (const w of WS) if (mounts[w.id].inited) w.onDoc?.(); statusLeft.textContent = current?.status?.() || ''; });
  S.on('change', (e) => { refreshTitle(); updateHistoryButtons(); for (const w of WS) if (mounts[w.id].inited) w.onChange?.(e); });
  S.on('autosave', (s) => { autosaveEl.textContent = s === 'saved' ? 'Autosaved here' : 'Autosave off — save to a file'; });
  stage.addEventListener('pointerdown', () => app.classList.remove('sheet-open'));
  addEventListener('resize', fitRail);

  const saved = await S.loadAutosave();
  let restored = false;
  if (saved) { try { S.replaceDoc(S.parseDoc(JSON.stringify(saved))); restored = true; } catch { /* fall back to sample */ } }
  if (!restored) S.replaceDoc(sampleDoc());
  // Workspaces feed each other (placements, extrusions, drawings), so all of them start up front.
  for (const id of ['vector', 'mesh', 'cad', 'layout']) { try { ctx.ensure(id); } catch (e) { console.error('init failed', id, e); } }
  const hash = (location.hash || '').replace('#', '');
  activate(WS.some(w => w.id === hash) ? hash : 'layout');
  refreshTitle(); updateHistoryButtons();
  if (restored) toast('Restored your last session from this browser');
  const splash = document.getElementById('kerf-boot');
  if (splash) { splash.classList.add('gone'); setTimeout(() => splash.remove(), 300); }
}
// Android back button: close the top-most sheet, dialog, menu or sketcher; report whether anything was closed.
window.__kerfBack = () => {
  if (document.querySelector('.menu[role="menu"]')) { closeMenu(); return true; }
  if (document.querySelector('.sketcher')) { document.dispatchEvent(new CustomEvent('kerf-back')); return true; } // sketcher: cancel the gesture, else Done
  const top = [...document.querySelectorAll('.backdrop')].pop();
  if (top) { // deliver Escape where a keyboard would: the focused control inside the top layer (it bubbles to document handlers too)
    const t = top.contains(document.activeElement) ? document.activeElement : top;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (top.isConnected && top.classList.contains('backdrop')) top.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); // backdrop click closes dialogs that ignore Escape
    return true;
  }
  if (app.classList.contains('sheet-open')) { app.classList.remove('sheet-open'); return true; }
  return false;
};
boot().catch((e) => { console.error(e); document.getElementById('kerf-boot')?.remove(); });
