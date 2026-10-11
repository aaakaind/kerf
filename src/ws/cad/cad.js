// CAD workspace — parametric feature tree with variables & configurations, rollback, two kernels
// (fast mesh / precise OpenCascade B-rep), mass properties, section view, measure, STEP/STL, drawings to Layout.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createViewport, woodTexture, boxUV, THREE } from '../../core/viewport3d.js';
import { h, icon, pane, numField, selectField, textField, checkField, segmented, iconBtn, clear, uid, toast, dialog, registerCommand, menu, round, clamp, debounce, pickFile, readAsDataURL } from '../../core/ui.js';
import { panelRebuilder } from '../../core/ui.js';
import { saveFile, safeName, fetchBundled, dataURLToBytes } from '../../core/io.js';
import { addAsset, asset } from '../../core/store.js';
import { resolveVars, tryEval } from '../../core/expr.js';
import { PLANES, PROFILE_TYPES, PROFILE_FIELDS, PROFILE_DEFAULTS, FEATURE_LABEL, FEATURE_ICON, newFeature, evalFeature, profileLoops } from './profiles.js';
import { meshKernel } from './kernel-mesh.js';
import { occtKernel, initOCCT, readSTEP } from './kernel-occt.js';
import { loadSolver, solverState, solverError, sketchLoops, CONS, defaultSketch } from './sketch-core.js';
import { openSketcher } from './sketch-editor.js';
import { openPathTracer } from '../../core/pathtrace.js';
import { loadManifold, manifoldState } from '../../core/manifold.js';

const MATERIALS = {
  pla: { label: 'PLA (3D print)', rho: 1.24, color: '#e3a72f', metal: 0, rough: 0.55 },
  petg: { label: 'PETG', rho: 1.27, color: '#2d5b8a', metal: 0, rough: 0.35 },
  abs: { label: 'ABS', rho: 1.04, color: '#1c1a17', metal: 0, rough: 0.6 },
  pa12: { label: 'Nylon PA12 (SLS)', rho: 1.01, color: '#ece6da', metal: 0, rough: 0.85 },
  al6061: { label: 'Aluminium 6061', rho: 2.70, color: '#c9ccd1', metal: 1, rough: 0.32 },
  steel: { label: 'Mild steel 1018', rho: 7.87, color: '#8d8f92', metal: 1, rough: 0.4 },
  ss304: { label: 'Stainless 304', rho: 8.00, color: '#b9bcc0', metal: 1, rough: 0.22 },
  brass: { label: 'Brass C360', rho: 8.50, color: '#c9a24a', metal: 1, rough: 0.3 },
  birch: { label: 'Birch plywood', rho: 0.68, color: '#ffffff', metal: 0, rough: 0.65, wood: 'birch' },
  walnut: { label: 'Black walnut', rho: 0.64, color: '#ffffff', metal: 0, rough: 0.55, wood: 'walnut' },
  concrete: { label: 'Concrete', rho: 2.40, color: '#b5aea3', metal: 0, rough: 0.95 },
};
const TOOLS = [
  ['extrude', 'Extrude — sketch a profile and give it depth'], ['revolve', 'Revolve — spin a profile around an axis'], ['hole', 'Hole — drilled, through or blind, optional counterbore'],
  '-', ['fillet', 'Fillet — round edges (precise kernel)'], ['chamfer', 'Chamfer — bevel edges (precise kernel)'], ['shell', 'Shell — hollow out with one face open (precise kernel)'],
  '-', ['pattern', 'Pattern — repeat a feature in a line or circle'], ['mirror', 'Mirror the part across a plane'],
  '-', ['box', 'Box primitive'], ['cylinder', 'Cylinder primitive'], ['import', 'Import STEP — bring in a part from any other CAD program'],
];
const SOLID_TYPES = ['hole', 'extrude', 'revolve', 'box', 'cylinder', 'sphere', 'import'];

let ctx, S, root, railEl, panelEl, vp, partGroup, partMesh, partEdges, measureGroup;
let result = null, buildMs = 0, building = false, fitted = false;
let kernelPref = 'auto', occtState = 'idle', occtError = '';
let selId = null, section = { on: false, z: 10 }, measuring = false, measurePts = [];
const C = () => S.store.doc.cad;
const feats = () => C().features;
const findF = (id) => feats().find(f => f.id === id);

// ---------- variables & configurations ----------
function configOverrides() { const c = C().configs?.[C().activeConfig]; return c ? c.values : {}; }
function vars() { return resolveVars(C().vars, configOverrides()); }
function exprCheck(src) { return tryEval(src, vars().vals); }

// ---------- kernel management ----------
function activeKernel() { return kernelPref !== 'fast' && occtState === 'ready' ? occtKernel : meshKernel; }
async function loadPrecise() {
  if (occtState === 'loading' || occtState === 'ready') return;
  occtState = 'loading'; occtError = ''; renderKernelBadge();
  try {
    let bytes = null, lastErr = '';
    for (const url of ['occt.wasm.gz', 'occt.wasm']) {
      try {
        const buf = await fetchBundled(url);
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack the kernel');
          bytes = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        } else bytes = buf;
        if (bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) break; else { lastErr = `${url}: not a WebAssembly file`; bytes = null; }
      } catch (e) { lastErr = e.message; }
    }
    if (!bytes) throw new Error(lastErr || 'kernel file not found');
    await initOCCT(bytes);
    occtState = 'ready'; toast('Precise kernel ready — fillets, shells and STEP export are on');
    build(); S.emit('kernel-ready');
  } catch (e) { occtState = 'failed'; occtError = e.message || String(e); console.warn('OCCT load failed', e); S.emit('kernel-ready'); }
  renderKernelBadge();
}

// ---------- build ----------
function evaluated() {
  const { vals } = vars(); const out = []; const evalErrors = {};
  const rb = C().rollback == null ? feats().length : C().rollback;
  feats().forEach((f, i) => {
    if (i >= rb || f.suppressed) return;
    const r = evalFeature(f, vals, (id) => ctx.ws.vector.getItem?.(id)?.subpaths);
    if (!r.ok) { evalErrors[f.id] = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(' · '); return; }
    out.push(r.f);
  });
  return { list: out, evalErrors };
}
const scheduleBuild = debounce(() => build(), 140);
// ---------- STEP imports: parsed once per file by OpenCascade, reused by both kernels ----------
const imports = new Map(); const importing = new Set();
function syncImports() {
  for (const f of feats()) {
    if (f.type !== 'import' || !f.asset || imports.has(f.asset) || importing.has(f.asset)) continue;
    const a = asset(f.asset); if (!a) { imports.set(f.asset, { error: 'The STEP file is missing from this document' }); continue; }
    if (occtState === 'failed') { imports.set(f.asset, { error: 'STEP import needs the precise kernel, which could not start here' }); continue; }
    if (occtState !== 'ready') continue; // kernel-ready triggers another build
    importing.add(f.asset);
    const id = f.asset;
    setTimeout(async () => {
      try { imports.set(id, await readSTEP(dataURLToBytes(a.data))); }
      catch (e) { imports.set(id, { error: 'Could not read this STEP file' + (e?.message ? ` (${e.message})` : '') }); }
      importing.delete(id); fitted = false; scheduleBuild();
    }, 30);
  }
}
function needsSolver() { return feats().some(f => f.profile?.type === 'sketch'); }
function build() {
  if (!vp) return;
  building = true; renderKernelBadge();
  if (needsSolver() && solverState() === 'idle') loadSolver().then((ok) => { if (ok) { scheduleBuild(); buildPanelSoon(); } });
  syncImports();
  if (manifoldState() === 'idle' && (kernelPref === 'fast' || occtState === 'failed')) loadManifold().then(ok => { if (ok && activeKernel() === meshKernel) scheduleBuild(); });
  const t0 = performance.now(); const kernel = activeKernel();
  const { list, evalErrors } = evaluated();
  let r;
  try { r = kernel.build(list, { imports }); } catch (e) { console.error(e); r = { mesh: null, edges: null, errors: { _: e.message }, warnings: {}, solid: null }; }
  r.errors = { ...r.errors, ...evalErrors }; r.kernel = kernel;
  result = r; buildMs = performance.now() - t0; building = false;
  showResult(); buildPanelSoon(); renderKernelBadge(); updateStatus();
}
function partMaterial() {
  const m = MATERIALS[C().material] || MATERIALS.al6061;
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(m.color), metalness: m.metal, roughness: m.rough, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: clipPlanes(), clipShadows: true });
  if (m.wood) mat.map = woodTexture(m.wood, 1 / 60);
  return mat;
}
function clipPlanes() { return section.on ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), section.z)] : []; }
function showResult() {
  if (!vp) return;
  if (partMesh) { partGroup.remove(partMesh); partMesh.geometry.dispose(); partMesh = null; }
  if (partEdges) { partGroup.remove(partEdges); partEdges.geometry.dispose(); partEdges = null; }
  if (result?.mesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.mesh.position), 3));
    if (result.mesh.normal) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(result.mesh.normal), 3));
    if (result.mesh.index) g.setIndex(new THREE.BufferAttribute(result.mesh.index, 1));
    if (!result.mesh.normal) g.computeVertexNormals();
    boxUV(g);
    partMesh = new THREE.Mesh(g, partMaterial()); partMesh.castShadow = partMesh.receiveShadow = true; partGroup.add(partMesh);
    if (result.edges?.length) {
      const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(result.edges), 3));
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1c1a17';
      partEdges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: new THREE.Color(ink), clippingPlanes: clipPlanes() })); partGroup.add(partEdges);
    }
  }
  vp.requestRender();
  if (!fitted && partMesh && !root.hidden) { vp.setView('iso'); fitted = true; }
}
// ---------- properties ----------
function massProps() {
  if (!result?.mesh) return null;
  const P = result.mesh.position, I = result.mesh.index; const n = I ? I.length / 3 : P.length / 9;
  let vol = 0, area = 0, cx = 0, cy = 0, cz = 0; const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const v = (k) => I ? I[k] : k;
  for (let t = 0; t < n; t++) {
    const a = v(t * 3) * 3, b = v(t * 3 + 1) * 3, c = v(t * 3 + 2) * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], qx = P[c], qy = P[c + 1], qz = P[c + 2];
    const d = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
    vol += d; cx += d * (ax + bx + qx) / 4; cy += d * (ay + by + qy) / 4; cz += d * (az + bz + qz) / 4;
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = qx - ax, wy = qy - ay, wz = qz - az;
    area += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [qx, qy, qz]]) { if (x < mn[0]) mn[0] = x; if (y < mn[1]) mn[1] = y; if (z < mn[2]) mn[2] = z; if (x > mx[0]) mx[0] = x; if (y > mx[1]) mx[1] = y; if (z > mx[2]) mx[2] = z; }
  }
  const ex = result.exact;
  const volume = Math.abs(ex?.volume ?? vol); const com = ex?.com ?? [cx / vol, cy / vol, cz / vol];
  const rho = (MATERIALS[C().material] || MATERIALS.al6061).rho;
  return { volume, area: ex?.area ?? area, com, bbox: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]], mass: (volume / 1000) * rho, exact: !!ex };
}
function updateStatus() {
  const mp = massProps(); const nErr = Object.keys(result?.errors || {}).length;
  ctx.setStatus('cad', `${activeKernel() === occtKernel ? 'Precise kernel' : 'Fast kernel'} · ${feats().length} features${mp ? ` · ${round(mp.volume / 1000, 2)} cm³ · ${round(mp.mass, 1)} g` : ''}${nErr ? ` · ${nErr} feature error${nErr > 1 ? 's' : ''}` : ''} · built in ${Math.round(buildMs)} ms`);
}

// ---------- feature commands ----------
function mutate(label, fn) { S.checkpoint(label); fn(); S.changed('cad'); }
function addFeature(type, extra = {}) {
  const n = feats().filter(f => f.type === type).length + 1;
  const f = { ...newFeature(type, uid('cf'), feats().length ? n : 1), ...extra };
  if ('op' in f) f.op = feats().length === 0 ? 'new' : f.op === 'new' ? 'add' : f.op;
  if (type === 'pattern') f.of = [...feats()].reverse().find(x => SOLID_TYPES.includes(x.type))?.id || null;
  if ((type === 'fillet' || type === 'chamfer' || type === 'shell') && activeKernel() !== occtKernel) toast(occtState === 'ready' ? 'Switch to the precise kernel to see this feature' : 'This feature needs the precise kernel, which is loading or unavailable here');
  mutate('Add ' + FEATURE_LABEL[type], () => {
    const rb = C().rollback; if (rb != null && rb < feats().length) feats().splice(rb, 0, f); else feats().push(f);
    if (rb != null) C().rollback = rb + 1;
  });
  selId = f.id; buildPanel(); ctx.openSheet();
}
export function profileFromVector(vecId) {
  const it = ctx.ws.vector.getItem?.(vecId); if (!it) { toast('That path no longer exists', 'bad'); return; }
  addFeature('extrude', { name: (it.name || 'Path') + ' profile', profile: { type: 'vector', link: vecId, subpaths: JSON.parse(JSON.stringify(it.subpaths)), size: '60 mm', cx: '0', cy: '0' }, depth: '6 mm' });
}
async function importSTEPFile(replace) {
  const file = await pickFile('.step,.stp,model/step,application/step');
  if (!file) return;
  if (!/\.(step|stp)$/i.test(file.name)) { toast('Pick a .step or .stp file', 'bad'); return; }
  const data = await readAsDataURL(file);
  const id = addAsset({ kind: 'step', name: file.name, data });
  if (replace) { setF(replace, { asset: id, name: file.name.replace(/\.(step|stp)$/i, '') }, 'Replace STEP file'); buildPanel(); }
  else addFeature('import', { asset: id, name: file.name.replace(/\.(step|stp)$/i, '') });
  if (occtState !== 'ready') { toast(occtState === 'failed' ? 'STEP import needs the precise kernel, which could not start here' : 'Loading the precise kernel to read the STEP file…'); loadPrecise(); }
  else toast(`Reading ${file.name}…`);
}
async function editSketch(f) {
  const r = await openSketcher({ sketch: f.profile, title: `${f.name} · sketch`, plane: f.plane || 'XY', getVals: () => vars().vals });
  if (!r) return;
  setF(f, { profile: { ...r, type: 'sketch' } }, 'Edit sketch'); buildPanel();
}
function moveFeature(id, d) { const a = feats(); const i = a.findIndex(f => f.id === id); const j = i + d; if (j < 0 || j >= a.length) return; mutate('Reorder features', () => { [a[i], a[j]] = [a[j], a[i]]; }); }
function deleteFeature(id) { mutate('Delete feature', () => { C().features = feats().filter(f => f.id !== id); for (const f of feats()) if (f.of === id) f.of = null; if (C().rollback != null) C().rollback = Math.min(C().rollback, feats().length); }); if (selId === id) selId = null; buildPanel(); }
function setF(f, p, label) { S.checkpoint(label || 'Edit feature'); Object.assign(f, p); S.changed('cad'); }

// ---------- export ----------
function stlBytes() {
  if (!result?.mesh) return null;
  const P = result.mesh.position, I = result.mesh.index; const n = I ? I.length / 3 : P.length / 9;
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  const head = 'KERF binary STL · units: mm'; for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, n, true); let o = 84;
  for (let t = 0; t < n; t++) {
    const id = [0, 1, 2].map(k => (I ? I[t * 3 + k] : t * 3 + k) * 3);
    const [a, b, c] = id.map(i => [P[i], P[i + 1], P[i + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0]; const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [nx / l, ny / l, nz / l, ...a, ...b, ...c]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}
async function exportSTL() { const b = stlBytes(); if (!b) { toast('Nothing to export yet', 'bad'); return; } await saveFile(safeName(S.store.doc.name, 'part') + '.stl', new Blob([b]), 'model/stl'); }
async function exportSTEP() {
  if (activeKernel() !== occtKernel || !result?.solid) { toast(occtState === 'ready' ? 'Switch to the precise kernel to export STEP' : 'STEP needs the precise kernel, which is not available here. STL works.', 'bad'); return; }
  try { const blob = occtKernel.exportSTEP(result.solid); await saveFile(safeName(S.store.doc.name, 'part') + '.step', blob, 'model/step'); }
  catch (e) { toast('STEP export failed: ' + e.message, 'bad'); }
}
function sendToMesh() { const b = stlBytes(); if (!b) { toast('Nothing to send yet', 'bad'); return; } ctx.ensure?.('mesh'); ctx.ws.mesh.addMeshFromSTL?.(S.store.doc.name + ' part', b, ({ birch: 'birch', walnut: 'walnut', al6061: 'alu', steel: 'steel', ss304: 'chrome', brass: 'ochre', pla: 'ochre', petg: 'blue', abs: 'ink' })[C().material] || 'alu'); ctx.activate('mesh'); }
/** Line drawing of the part (hidden lines with the precise kernel; silhouette edges with the fast one). */
async function drawingSVG(view = 'front') {
  if (!vp) init2();
  if (!result) build();
  if (!result?.mesh) return null;
  if (activeKernel() === occtKernel && result.solid) { try { return occtKernel.drawingSVG(result.solid, view); } catch (e) { console.warn(e); } }
  const E = result.edges; if (!E) return null;
  const proj = { front: (x, y, z) => [x, -z], back: (x, y, z) => [-x, -z], top: (x, y) => [x, -y], bottom: (x, y) => [x, y], right: (x, y, z) => [y, -z], left: (x, y, z) => [-y, -z] }[view] || ((x, y, z) => [x, -z]);
  let s = '', x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const segs = [];
  for (let i = 0; i < E.length; i += 6) { const a = proj(E[i], E[i + 1], E[i + 2]), b = proj(E[i + 3], E[i + 4], E[i + 5]); segs.push([a, b]); for (const p of [a, b]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } }
  const w = x1 - x0, hh = y1 - y0, pad = Math.max(w, hh) * 0.12, sw = Math.max(w, hh) / 380;
  for (const [a, b] of segs) s += `<line x1="${round(a[0], 3)}" y1="${round(a[1], 3)}" x2="${round(b[0], 3)}" y2="${round(b[1], 3)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - pad} ${y0 - pad} ${w + pad * 2} ${hh + pad * 2}"><g stroke="#1c1a17" stroke-width="${sw * 1.2}" stroke-linecap="round">${s}</g></svg>`;
}
function raytrace() { if (!result?.mesh) { toast('Build a part first', 'bad'); return; } measuring = false; measurePts = []; drawMeasure(); openPathTracer({ vp, name: S.store.doc.name }); }
async function exportDrawing() { const svg = await drawingSVG('front'); if (!svg) { toast('Nothing to draw yet', 'bad'); return; } await saveFile(safeName(S.store.doc.name, 'part') + '-front.svg', svg, 'image/svg+xml'); }

// ---------- UI: rail ----------
let toolBtns = {};
function buildRail() {
  clear(railEl);
  for (const t of TOOLS) {
    if (t === '-') { railEl.append(h('div', { class: 'rail-sep' })); continue; }
    const [type, label] = t; railEl.append(h('button', { class: 'tool', type: 'button', title: label, 'aria-label': label, html: icon(FEATURE_ICON[type]), onclick: () => (type === 'import' ? importSTEPFile() : addFeature(type)) }));
  }
  railEl.append(h('div', { class: 'rail-sep' }));
  toolBtns.section = h('button', { class: 'tool', type: 'button', title: 'Section view', 'aria-label': 'Section view', 'aria-pressed': String(section.on), html: icon('section'), onclick: () => { section.on = !section.on; toolBtns.section.setAttribute('aria-pressed', String(section.on)); showResult(); buildPanel(); } });
  toolBtns.measure = h('button', { class: 'tool', type: 'button', title: 'Measure — click two points on the part', 'aria-label': 'Measure', 'aria-pressed': String(measuring), html: icon('measure'), onclick: () => { measuring = !measuring; measurePts = []; drawMeasure(); toolBtns.measure.setAttribute('aria-pressed', String(measuring)); } });
  railEl.append(toolBtns.section, toolBtns.measure);
}

// ---------- UI: panel ----------
let badgeEl;
function renderKernelBadge() {
  if (!badgeEl) return;
  const precise = activeKernel() === occtKernel;
  const st = building ? 'busy' : occtState === 'loading' && kernelPref !== 'fast' ? 'busy' : precise ? 'ok' : occtState === 'failed' ? 'bad' : '';
  const txt = building ? 'Building…' : precise ? 'Precise · OpenCascade B-rep' : occtState === 'loading' ? 'Fast mesh · loading precise kernel…' : occtState === 'failed' ? 'Fast mesh · precise kernel unavailable' : 'Fast mesh kernel';
  badgeEl.className = 'badge ' + st; badgeEl.innerHTML = `<span class="led"></span>${txt}`;
  badgeEl.title = occtState === 'failed' ? `Precise kernel could not load here: ${occtError}. Fillet, chamfer, shell and STEP need it; everything else works.` : '';
}
function exprField(label, f, key, opts = {}) {
  const src = opts.get ? opts.get() : f[key];
  const out = h('span', { class: 'expr-val' });
  const show = (s) => { const r = exprCheck(s); out.textContent = r.ok ? '= ' + round(r.value, 3) : '⚠ ' + r.error; out.style.color = r.ok ? '' : 'var(--danger)'; };
  const fid = uid('e');
  const inp = h('input', { type: 'text', id: fid, value: src ?? '', spellcheck: 'false', autocomplete: 'off' });
  inp.addEventListener('input', () => show(inp.value));
  inp.addEventListener('change', () => { opts.set ? opts.set(inp.value) : setF(f, { [key]: inp.value }, 'Edit ' + label); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { const r = exprCheck(inp.value); if (r.ok && /^-?[\d.]+\s*(mm)?$/.test(inp.value.trim())) { e.preventDefault(); const v = round(r.value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1), 3); inp.value = /mm/.test(inp.value) ? v + ' mm' : String(v); inp.dispatchEvent(new Event('change')); } } });
  show(src ?? '');
  return h('div', { class: 'field' + (opts.span ? ' span' + opts.span : '') }, h('label', { for: fid }, h('span', null, label), out), inp);
}
function profileEditor(f) {
  const p = f.profile; const wrap = h('div', { class: 'fields' });
  wrap.append(selectField({ label: 'Profile', value: p.type, span: 2, options: Object.entries(PROFILE_TYPES).filter(([k]) => k !== 'vector' || p.type === 'vector' || (ctx.ws.vector.listShapes?.() || []).length).map(([k, l]) => [k, l]), onChange: v => {
    if (v === 'vector') { const s = ctx.ws.vector.listShapes?.()[0]; if (!s) return; setF(f, { profile: { type: 'vector', link: s.id, subpaths: JSON.parse(JSON.stringify(s.subpaths)), size: '60 mm', cx: '0', cy: '0' } }, 'Profile'); }
    else if (v === 'sketch' && p.type === 'rect') setF(f, { profile: { type: 'sketch', ...defaultSketch(p.w, p.h) } }, 'Profile'); // keep the size you had
    else setF(f, { profile: { type: v, ...PROFILE_DEFAULTS[v] } }, 'Profile'); buildPanel(); } }));
  if (p.type === 'sketch') {
    const L = sketchLoops(p); const r = evalFeature(f, vars().vals, () => null); const dof = r.f.profile?.dof;
    const st = solverState(); const nDims = p.cons.filter(c => CONS[c.t]?.dim).length;
    const status = st === 'ready' ? (r.errors['profile.sketch'] ? '⚠ ' + r.errors['profile.sketch'] : dof === 0 ? 'Fully defined' : `${dof} degree${dof === 1 ? '' : 's'} of freedom left`) : st === 'failed' ? `Solver unavailable (${solverError()}) — geometry as drawn` : 'Loading solver…';
    wrap.append(h('div', { class: 'field span3' }, h('button', { class: 'btn primary', type: 'button', onclick: () => editSketch(f) }, h('span', { html: icon('pencil', 15) }), 'Edit sketch'),
      h('p', { class: 'hint', style: { color: r.errors['profile.sketch'] ? 'var(--danger)' : '' } }, `${status} · ${p.ents.filter(e => e.t !== 'pt').length} curves · ${p.cons.length} constraints · ${L.loops.length} loop${L.loops.length === 1 ? '' : 's'}`)));
    // the sketch's dimensions, editable right here like any other parameter
    for (const c of p.cons) if (CONS[c.t]?.dim) wrap.append(exprField(`${CONS[c.t].label}${nDims > 1 ? ' · ' + c.id : ''}`, c, 'v', { get: () => c.v, set: (v) => { S.checkpoint('Edit dimension'); c.v = v; S.changed('cad'); } }));
  }
  if (p.type === 'vector') wrap.append(selectField({ label: 'Vector path', value: p.link, span: 2, options: (ctx.ws.vector.listShapes?.() || []).map(s => [s.id, s.name]), onChange: v => { const s = ctx.ws.vector.getItem(v); setF(f, { profile: { ...p, link: v, subpaths: JSON.parse(JSON.stringify(s.subpaths)) } }, 'Profile'); } }));
  for (const [k, l] of PROFILE_FIELDS[p.type] || []) wrap.append(exprField(l, p, k, { get: () => p[k], set: (v) => setF(f, { profile: { ...p, [k]: v } }, 'Edit ' + l) }));
  if (p.type === 'poly') {
    const ta = h('textarea', { id: 'cad-pts', rows: 6, spellcheck: 'false', style: { fontFamily: 'var(--mono)', fontSize: '12px', minHeight: '110px' } }); ta.value = p.pts;
    ta.addEventListener('change', () => setF(f, { profile: { ...p, pts: ta.value } }, 'Edit points'));
    wrap.append(h('div', { class: 'field span3' }, h('label', { for: 'cad-pts' }, h('span', null, 'Points — one “u, v” per line'), h('span', null, 'expressions ok')), ta));
  }
  wrap.append(h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, h('span', null, 'Sketch'), h('span', null, p.type === 'poly' ? 'drag points' : '')), profilePreview(f)));
  return wrap;
}
function profilePreview(f) {
  const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'profile-prev');
  const r = evalFeature(f, vars().vals, (id) => ctx.ws.vector.getItem?.(id)?.subpaths);
  const loops = r.f.profile ? profileLoops(r.f.profile) : [];
  const all = loops.flatMap(l => [l.outer, ...l.holes]).flat(); all.push([0, 0]);
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(x1 - x0, y1 - y0, 10) * 0.12; const vb = [x0 - pad, -(y1 + pad), (x1 - x0) + pad * 2, (y1 - y0) + pad * 2];
  svg.setAttribute('viewBox', vb.join(' ')); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  let s = `<line class="axis" x1="${vb[0]}" y1="0" x2="${vb[0] + vb[2]}" y2="0"/><line class="axis" x1="0" y1="${vb[1]}" x2="0" y2="${vb[1] + vb[3]}"/>`;
  for (const l of loops) s += `<path d="${[l.outer, ...l.holes].map(pts => 'M' + pts.map(([x, y]) => `${round(x, 3)} ${round(-y, 3)}`).join('L') + 'Z').join('')}" fill-rule="evenodd"/>`;
  if (f.profile.type === 'poly' && r.f.profile.pts) r.f.profile.pts.forEach(([x, y], i) => { s += `<circle class="pt" data-i="${i}" cx="${x}" cy="${-y}" r="${Math.max(vb[2], vb[3]) / 70}"/>`; });
  svg.innerHTML = s;
  if (f.profile.type === 'poly') {
    let drag = null;
    svg.addEventListener('pointerdown', (e) => { const i = e.target.dataset?.i; if (i == null) return; drag = { i: +i }; svg.setPointerCapture(e.pointerId); S.checkpoint('Move sketch point'); });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return; const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const q = pt.matrixTransform(svg.getScreenCTM().inverse());
      const lines = String(f.profile.pts).split('\n').filter(l => l.trim()); const snap = e.shiftKey ? 1 : 0.5;
      lines[drag.i] = `${round(Math.round(q.x / snap) * snap, 2)}, ${round(Math.round(-q.y / snap) * snap, 2)}`;
      f.profile = { ...f.profile, pts: lines.join('\n') }; S.changed('cad', { live: true });
      const c = svg.querySelector(`[data-i="${drag.i}"]`); if (c) { c.setAttribute('cx', q.x); c.setAttribute('cy', q.y); }
    });
    svg.addEventListener('pointerup', () => { if (drag) { drag = null; S.changed('cad'); buildPanel(); } });
  }
  return svg;
}
function featureEditor(f) {
  const err = result?.errors?.[f.id], warn = result?.warnings?.[f.id];
  const els = [h('div', { class: 'fields' }, textField({ label: 'Name', value: f.name, span: 3, onChange: v => setF(f, { name: v }, 'Rename feature') }))];
  if (err) els.push(h('p', { class: 'hint', style: { color: 'var(--danger)' } }, '⚠ ' + err));
  if (warn) els.push(h('p', { class: 'hint', style: { color: 'var(--warn)' } }, warn));
  const opSel = () => selectField({ label: 'Operation', value: f.op, options: [['new', 'New solid'], ['add', 'Add'], ['cut', 'Cut'], ['intersect', 'Intersect']], onChange: v => setF(f, { op: v }, 'Operation') });
  const planeSel = () => selectField({ label: 'Plane', value: f.plane, options: Object.keys(PLANES).map(k => [k, k + ' plane']), onChange: v => setF(f, { plane: v }, 'Plane') });
  const g = h('div', { class: 'fields' });
  if (f.type === 'extrude') { g.append(planeSel(), opSel(), exprField('Plane offset', f, 'offset'), exprField('Depth', f, 'depth'), selectField({ label: 'Direction', value: f.dir, span: 2, options: [['normal', 'Along plane normal'], ['reverse', 'Reverse'], ['symmetric', 'Symmetric (mid-plane)']], onChange: v => setF(f, { dir: v }, 'Direction') })); els.push(g, profileEditor(f)); }
  else if (f.type === 'revolve') { g.append(planeSel(), opSel(), exprField('Plane offset', f, 'offset'), exprField('Angle °', f, 'angle')); els.push(g, h('p', { class: 'hint' }, 'Spins around the plane’s V axis. Keep the profile at U ≥ 0.'), profileEditor(f)); }
  else if (f.type === 'hole') { g.append(planeSel(), exprField('Entry plane offset', f, 'offset'), exprField('Centre U', f, 'x'), exprField('Centre V', f, 'y'), exprField('Diameter', f, 'd'), exprField('Depth (0 = through)', f, 'depth'), exprField('Counterbore Ø', f, 'cbd'), exprField('Counterbore depth', f, 'cbdepth')); els.push(g, h('p', { class: 'hint' }, 'Drills from the entry plane against its normal. Put the entry plane on the face the drill enters.')); }
  else if (f.type === 'fillet' || f.type === 'chamfer') { g.append(exprField(f.type === 'fillet' ? 'Radius' : 'Distance', f, f.type === 'fillet' ? 'r' : 'd'), selectField({ label: 'Edges', value: f.edges, options: [['all', 'All edges'], ['Z', 'Vertical (∥ Z)'], ['X', 'Parallel to X'], ['Y', 'Parallel to Y'], ['top', 'Top face'], ['bottom', 'Bottom face'], ['front', 'Front face'], ['back', 'Back face'], ['left', 'Left face'], ['right', 'Right face']], onChange: v => setF(f, { edges: v }, 'Edges') })); els.push(g); }
  else if (f.type === 'shell') { g.append(exprField('Wall thickness', f, 't'), selectField({ label: 'Open face', value: f.face, options: [['top', 'Top'], ['bottom', 'Bottom'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right']], onChange: v => setF(f, { face: v }, 'Open face') })); els.push(g); }
  else if (f.type === 'pattern') {
    g.append(selectField({ label: 'Feature to repeat', value: f.of || '', span: 2, options: [['', '— pick —'], ...feats().filter(x => x.id !== f.id && SOLID_TYPES.includes(x.type)).map(x => [x.id, x.name])], onChange: v => setF(f, { of: v || null }, 'Pattern source') }),
      selectField({ label: 'Kind', value: f.kind, options: [['linear', 'Linear'], ['circular', 'Circular']], onChange: v => { setF(f, { kind: v }, 'Pattern kind'); buildPanel(); } }), exprField('Count', f, 'count'));
    if (f.kind === 'linear') g.append(exprField('Step X', f, 'dx'), exprField('Step Y', f, 'dy'), exprField('Step Z', f, 'dz'));
    else g.append(selectField({ label: 'Axis', value: f.axis, options: ['X', 'Y', 'Z'], onChange: v => setF(f, { axis: v }, 'Axis') }), exprField('Total angle °', f, 'angle'));
    els.push(g);
  }
  else if (f.type === 'mirror') { g.append(selectField({ label: 'Mirror plane', value: f.plane, span: 2, options: [['YZ', 'YZ (flip X)'], ['XZ', 'XZ (flip Y)'], ['XY', 'XY (flip Z)']], onChange: v => setF(f, { plane: v }, 'Mirror plane') })); els.push(g); }
  else if (f.type === 'box') { g.append(opSel(), h('div'), exprField('X', f, 'x'), exprField('Y', f, 'y'), exprField('Z', f, 'z'), exprField('Width X', f, 'w'), exprField('Length Y', f, 'l'), exprField('Height Z', f, 'h')); els.push(g); }
  else if (f.type === 'cylinder') { g.append(opSel(), selectField({ label: 'Axis', value: f.axis, options: ['X', 'Y', 'Z'], onChange: v => setF(f, { axis: v }, 'Axis') }), exprField('X', f, 'x'), exprField('Y', f, 'y'), exprField('Z', f, 'z'), exprField('Diameter', f, 'd'), exprField('Height', f, 'h')); els.push(g); }
  else if (f.type === 'import') {
    const a = f.asset && asset(f.asset); const rec = f.asset && imports.get(f.asset);
    g.append(opSel(), h('div'), exprField('Move X', f, 'x'), exprField('Move Y', f, 'y'), exprField('Move Z', f, 'z'), exprField('Turn about Z °', f, 'rz'), exprField('Scale', f, 'scale'));
    els.push(g, h('p', { class: 'hint' }, a ? `${a.name} · ${Math.round(a.data.length * 0.75 / 1024)} KB · ${rec?.error ? 'error' : rec ? 'read by OpenCascade' : 'reading…'}` : 'No file attached'),
      h('p', { class: 'hint' }, 'STEP stores millimetres; use Scale 25.4 for a part modelled in inches. Combine it with your own features — cut a pocket into it, add a boss, fillet it.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => importSTEPFile(f) }, 'Replace file…')));
  }
  else if (f.type === 'sphere') { g.append(opSel(), h('div'), exprField('X', f, 'x'), exprField('Y', f, 'y'), exprField('Z', f, 'z'), exprField('Diameter', f, 'd')); els.push(g); }
  return pane(`${FEATURE_LABEL[f.type]} · ${f.name}`, ...els);
}
function varsPane() {
  const { vals, errors } = vars(); const ov = configOverrides(); const cfgs = C().configs || [];
  const list = h('div', { class: 'fields', style: { gridTemplateColumns: '1fr 1.4fr auto', alignItems: 'end' } });
  C().vars.forEach((v, i) => {
    const nameIn = h('input', { type: 'text', value: v.name, 'aria-label': 'Variable name', spellcheck: 'false' });
    nameIn.addEventListener('change', () => { const n = nameIn.value.trim().replace(/[^\w]/g, '_'); if (!n) return; setF(v, { name: n }, 'Rename variable'); });
    const exprIn = h('input', { type: 'text', value: ov[v.name] ?? v.expr, 'aria-label': `Value of #${v.name}`, spellcheck: 'false' });
    exprIn.addEventListener('change', () => { S.checkpoint('Edit variable'); const c = cfgs[C().activeConfig]; if (c) c.values[v.name] = exprIn.value; else v.expr = exprIn.value; S.changed('cad'); });
    list.append(h('div', { class: 'field' }, h('span', { class: 'lbl' }, '#name'), nameIn),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, h('span', null, 'value'), h('span', { style: { color: errors[v.name] ? 'var(--danger)' : '' } }, errors[v.name] ? '⚠' : '= ' + round(vals[v.name], 3))), exprIn),
      h('button', { class: 'btn icon ghost', type: 'button', title: 'Delete variable', 'aria-label': `Delete #${v.name}`, html: icon('trash', 16), onclick: () => { S.checkpoint('Delete variable'); C().vars.splice(i, 1); S.changed('cad'); buildPanel(); } }));
  });
  const cfgRow = h('div', { class: 'btn-row' },
    segmented({ value: C().activeConfig ?? -1, options: [{ value: -1, label: 'Default' }, ...cfgs.map((c, i) => ({ value: i, label: c.name }))], onChange: v => { S.checkpoint('Switch configuration'); C().activeConfig = v < 0 ? null : v; S.changed('cad'); buildPanel(); } }),
    h('button', { class: 'btn small', type: 'button', title: 'Save the current values as a new configuration', onclick: async () => { const { promptDialog } = await import('../../core/ui.js'); const n = await promptDialog('New configuration', 'Name (e.g. “Large”)', `Config ${cfgs.length + 1}`); if (!n) return; S.checkpoint('New configuration'); C().configs = [...cfgs, { name: n, values: Object.fromEntries(C().vars.map(v => [v.name, ov[v.name] ?? v.expr])) }]; C().activeConfig = C().configs.length - 1; S.changed('cad'); buildPanel(); } }, '+ Config'));
  return pane('Variables', list,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => { S.checkpoint('Add variable'); let n = 'v' + (C().vars.length + 1); C().vars.push({ name: n, expr: '10 mm' }); S.changed('cad'); buildPanel(); } }, h('span', { html: icon('plus', 14) }), 'Variable')),
    h('p', { class: 'hint' }, 'Use #name in any field: “#w/2 + 3 mm”. Units: mm, cm, m, in, ft. Functions: sin, cos, sqrt, min, max, round.'),
    cfgs.length || true ? cfgRow : null);
}
function treePane() {
  const list = h('div', { class: 'list tall', id: 'cad-tree' });
  const rb = C().rollback == null ? feats().length : C().rollback;
  if (!feats().length) list.append(h('div', { class: 'li' }, h('span'), h('span', { class: 'name', style: { color: 'var(--muted)' } }, 'No features yet. Start with Extrude on the left.'), h('span')));
  const bar = () => h('div', { class: 'rollbar', title: 'Rollback bar — drag to see the part at an earlier step', role: 'separator', 'aria-label': 'Rollback bar' });
  feats().forEach((f, i) => {
    if (i === rb) list.append(bar());
    const err = result?.errors?.[f.id], warn = result?.warnings?.[f.id];
    list.append(h('div', { class: 'li' + (err ? ' err' : warn ? ' warn' : '') + (f.suppressed ? ' dim' : '') + (i >= rb ? ' rolled' : ''), 'aria-selected': String(f.id === selId), 'data-idx': i, title: err || warn || '', onclick: () => { selId = f.id; buildPanel(); ctx.openSheet(); } },
      h('span', { html: icon(FEATURE_ICON[f.type], 16) }), h('span', { class: 'name' }, f.name),
      h('span', { class: 'acts' },
        h('button', { type: 'button', title: f.suppressed ? 'Unsuppress' : 'Suppress', 'aria-label': f.suppressed ? 'Unsuppress' : 'Suppress', html: icon(f.suppressed ? 'eyeOff' : 'eye', 15), onclick: (e) => { e.stopPropagation(); setF(f, { suppressed: !f.suppressed }, 'Suppress'); } }),
        h('button', { type: 'button', title: 'More', 'aria-label': 'Feature options', html: icon('menu', 15), onclick: (e) => { e.stopPropagation(); menu(e.currentTarget, [
          { label: 'Move up', icon: 'up', run: () => moveFeature(f.id, -1) }, { label: 'Move down', icon: 'down', run: () => moveFeature(f.id, 1) },
          { label: 'Roll back to here', run: () => { S.checkpoint('Rollback'); C().rollback = i + 1; S.changed('cad'); } },
          { label: 'Duplicate', icon: 'copy', run: () => { mutate('Duplicate feature', () => { const c = JSON.parse(JSON.stringify(f)); c.id = uid('cf'); c.name += ' copy'; feats().splice(i + 1, 0, c); }); } },
          '-', { label: 'Delete', icon: 'trash', run: () => deleteFeature(f.id) }]); } }))));
  });
  if (rb >= feats().length && feats().length) list.append(bar());
  // drag the rollback bar
  list.addEventListener('pointerdown', (e) => {
    if (!e.target.classList.contains('rollbar')) return; e.preventDefault(); list.setPointerCapture(e.pointerId); S.checkpoint('Rollback');
    const move = (ev) => { const rows = [...list.querySelectorAll('.li[data-idx]')]; let idx = rows.length; for (const r of rows) { const rr = r.getBoundingClientRect(); if (ev.clientY < rr.top + rr.height / 2) { idx = +r.dataset.idx; break; } } const v = idx >= feats().length ? null : idx; if (v !== C().rollback) { C().rollback = v; S.changed('cad', { live: true }); } };
    const up = () => { list.removeEventListener('pointermove', move); list.removeEventListener('pointerup', up); S.changed('cad'); buildPanel(); };
    list.addEventListener('pointermove', move); list.addEventListener('pointerup', up);
  });
  return pane(`Feature tree · ${feats().length}`, list, rb < feats().length ? h('button', { class: 'btn small', type: 'button', onclick: () => { S.checkpoint('Rollback'); C().rollback = null; S.changed('cad'); buildPanel(); } }, 'Roll forward to the end') : null);
}
function buildPanel() {
  if (!panelEl) return; clear(panelEl);
  badgeEl = h('span', { class: 'badge' }); renderKernelBadge();
  panelEl.append(pane('Kernel', h('div', { class: 'btn-row' }, badgeEl),
    h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, 'Mode'), segmented({ value: kernelPref, options: [{ value: 'auto', label: 'Precise when ready' }, { value: 'fast', label: 'Fast mesh only' }], onChange: v => { kernelPref = v; if (v !== 'fast') loadPrecise(); scheduleBuild(); } })),
    occtState === 'failed' ? h('p', { class: 'hint' }, `The precise kernel could not start here (${occtError}). Download KERF and run it from any web server for fillets, shells and STEP.`) : null));
  const f = selId && findF(selId);
  if (f) panelEl.append(featureEditor(f));
  panelEl.append(treePane(), varsPane());
  const mp = massProps();
  panelEl.append(pane('Mass properties', h('div', { class: 'fields' }, selectField({ label: 'Material', value: C().material, span: 2, options: Object.entries(MATERIALS).map(([k, m]) => [k, `${m.label} · ${m.rho} g/cm³`]), onChange: v => { setF(C(), { material: v }, 'Material'); } })),
    mp ? h('dl', { class: 'stat-grid' },
      h('dt', null, 'Mass'), h('dd', null, `${round(mp.mass, 2)} g`), h('dt', null, 'Volume'), h('dd', null, `${round(mp.volume / 1000, 3)} cm³`),
      h('dt', null, 'Surface'), h('dd', null, `${round(mp.area / 100, 2)} cm²`), h('dt', null, 'Bounding box'), h('dd', null, mp.bbox.map(v => round(v, 1)).join(' × ') + ' mm'),
      h('dt', null, 'Centre of mass'), h('dd', null, mp.com.map(v => round(v, 2)).join(', ')), h('dt', null, 'Method'), h('dd', null, mp.exact ? 'exact B-rep' : 'from mesh')) : h('p', { class: 'empty' }, 'Build a solid to see mass, volume and area.')));
  if (section.on) panelEl.append(pane('Section view', numField({ label: 'Cut height (Z)', unit: 'mm', value: section.z, step: 0.5, onChange: v => { section.z = v; showResult(); }, onInput: v => { section.z = v; showResult(); } })));
  panelEl.append(pane('Output', h('div', { class: 'btn-grid' },
    h('button', { class: 'btn small primary', type: 'button', onclick: exportSTEP, disabled: activeKernel() !== occtKernel }, 'STEP'),
    h('button', { class: 'btn small', type: 'button', onclick: exportSTL }, 'STL'),
    h('button', { class: 'btn small', type: 'button', onclick: exportDrawing }, 'Drawing SVG'),
    h('button', { class: 'btn small', type: 'button', onclick: sendToMesh }, 'Send to Mesh'),
    h('button', { class: 'btn small', type: 'button', onclick: () => { ctx.activate('layout'); setTimeout(() => ctx.ws.layout?.placeFrom?.('drawing', { angle: 'front' }), 50); } }, 'Drawing → Layout'),
    h('button', { class: 'btn small', type: 'button', onclick: () => { ctx.activate('layout'); setTimeout(() => ctx.ws.layout?.placeFrom?.('cad', { angle: 'iso' }), 50); } }, 'Render → Layout'),
    h('button', { class: 'btn small primary', type: 'button', style: { gridColumn: 'span 2' }, onclick: raytrace }, 'Ray-traced render…'))));
}

// ---------- measure ----------
function drawMeasure() {
  if (!measureGroup) return; while (measureGroup.children.length) measureGroup.remove(measureGroup.children[0]);
  const sel = getComputedStyle(document.documentElement).getPropertyValue('--sel').trim() || '#1f55e8';
  for (const p of measurePts) { const s = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 8), new THREE.MeshBasicMaterial({ color: sel, depthTest: false })); s.position.set(...p); s.renderOrder = 10; measureGroup.add(s); }
  if (measurePts.length === 2) { const g = new THREE.BufferGeometry().setFromPoints(measurePts.map(p => new THREE.Vector3(...p))); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: sel, depthTest: false })); l.renderOrder = 10; measureGroup.add(l); }
  vp?.requestRender();
  if (measurePts.length === 2) { const [a, b] = measurePts; const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; toast(`Distance ${round(Math.hypot(...d), 3)} mm (ΔX ${round(d[0], 2)}, ΔY ${round(d[1], 2)}, ΔZ ${round(d[2], 2)})`); }
}
let downAt = null;
function onUp(e) {
  if (!measuring || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !partMesh) return;
  const r = vp.renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), vp.camera);
  const hit = ray.intersectObject(partMesh)[0]; if (!hit) return;
  const local = partGroup.worldToLocal(hit.point.clone());
  if (measurePts.length >= 2) measurePts = [];
  measurePts.push([round(local.x, 4), round(local.y, 4), round(local.z, 4)]); drawMeasure();
}

// ---------- workspace ----------
function init2() {
  if (vp || !root) return;
  const host = h('div', { class: 'three-host' }); root.append(host);
  vp = createViewport(host); if (!vp) return;
  partGroup = new THREE.Group(); partGroup.rotation.x = -Math.PI / 2; vp.root.add(partGroup);
  measureGroup = new THREE.Group(); partGroup.add(measureGroup);
  root.append(h('div', { class: 'view-cube' }, ...[['iso', 'ISO'], ['front', 'FRONT'], ['top', 'TOP'], ['right', 'RIGHT'], ['back', 'BACK'], ['left', 'LEFT']].map(([v, l]) => h('button', { type: 'button', onclick: () => vp.setView(v) }, l))));
  const cv = vp.renderer.domElement; cv.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; }); cv.addEventListener('pointerup', onUp);
  S.on('theme', () => setTimeout(() => { vp.applyTheme(); showResult(); }, 30));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => setTimeout(() => { vp.applyTheme(); showResult(); }, 30));
  build();
}
export default {
  id: 'cad', label: 'CAD',
  profileFromVector: (id) => profileFromVector(id),
  drawingSVG: (view) => drawingSVG(view),
  isPrecise: () => activeKernel() === occtKernel,
  kernelState: () => (kernelPref === 'fast' ? 'fast' : occtState),
  snapshot(opts) { ctx.ensure?.('cad'); if (!vp) init2(); if (!vp) return null; if (!result) build(); return result?.mesh ? vp.snapshot(opts) : null; },
  register(c) {
    const r = (id, label, run, tags) => registerCommand({ id: 'cad.' + id, label, run: () => { c.activate('cad'); run(); }, tags, ws: 'cad' });
    for (const t of TOOLS) if (t !== '-' && t[0] !== 'import') r('add-' + t[0], `Add ${FEATURE_LABEL[t[0]].toLowerCase()} feature`, () => addFeature(t[0]), 'feature parametric');
    r('import-step', 'Import STEP part…', () => importSTEPFile(), 'open load stp interchange');
    r('sketch', 'Edit the selected feature’s sketch', () => { const f = selId && findF(selId); if (f?.profile?.type === 'sketch') editSketch(f); else toast('Select a feature with a sketch profile', 'bad'); }, 'constraint planegcs draw');
    r('step', 'Export part as STEP', exportSTEP, 'save cad interchange');
    r('stl', 'Export part as STL', exportSTL, '3d print save');
    r('drawing', 'Export front drawing as SVG', exportDrawing, 'technical 2d');
    r('mesh', 'Send part to Mesh workspace', sendToMesh, 'render');
    r('kernel', 'Load the precise kernel (OpenCascade)', loadPrecise, 'brep occt');
    r('section', 'Toggle section view', () => toolBtns.section?.click(), 'cut clip');
    r('raytrace', 'Ray-traced render of the part', raytrace, 'render pathtrace photoreal gpu');
  },
  init(c, m) {
    ctx = c; S = c.S; root = m.root; railEl = m.rail; panelEl = m.panel;
    init2(); buildRail(); buildPanel(); loadPrecise();
  },
  show() { init2(); requestAnimationFrame(() => { vp?.resize(); if (!fitted && partMesh) { vp.setView('iso'); fitted = true; } }); scheduleBuild(); buildPanel(); },
  onDoc() { selId = null; fitted = false; imports.clear(); measurePts = []; drawMeasure(); if (vp) build(); buildPanel(); },
  onChange(e) {
    if (e.ws === 'vector') { if (feats().some(f => f.profile?.type === 'vector')) scheduleBuild(); return; }
    if (e.ws === 'cad' || !e.ws) { scheduleBuild(); if (!e.live) buildPanelSoon(); }
  },
  status() { return 'CAD'; },
  fileMenu() {
    return [
      { label: 'Import STEP…', icon: 'upload', run: () => importSTEPFile() },
      { label: 'Export STEP', icon: 'download', run: exportSTEP, disabled: activeKernel() !== occtKernel },
      { label: 'Export STL', icon: 'download', run: exportSTL },
      { label: 'Export front drawing (SVG)', icon: 'download', run: exportDrawing },
      { label: 'Send part to Mesh', icon: 'cube', run: sendToMesh },
    ];
  },
  onKey(e) {
    if (e.metaKey || e.ctrlKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'f') { vp?.frame(); return true; }
    if (k === '1') { vp?.setView('front'); return true; } if (k === '2') { vp?.setView('top'); return true; } if (k === '3') { vp?.setView('right'); return true; } if (k === '0') { vp?.setView('iso'); return true; }
    if ((k === 'delete' || k === 'backspace') && selId) { e.preventDefault(); deleteFeature(selId); return true; }
    if (k === 'escape') { selId = null; measuring = false; measurePts = []; drawMeasure(); toolBtns.measure?.setAttribute('aria-pressed', 'false'); buildPanel(); return true; }
    return false;
  },
};
const buildPanelSoon = panelRebuilder(() => panelEl, () => buildPanel());
