// VECTOR workspace — artboards, Bézier pen, pencil, shapes, live booleans, smart guides, repeat, gradients, SVG/PNG/PDF out.
// SPDX-License-Identifier: AGPL-3.0-or-later
import paper from 'paper'; // aliased to paper-core by the build, shared with paperjs-offset
import { PaperOffset } from 'paperjs-offset';
import { traceImage, TRACE_PRESETS, dxfFromItems, itemsFromDXF, MM_PER_PX } from '../core/vtools.js';
import { h, icon, pane, numField, colorField, selectField, textField, checkField, segmented, iconBtn, clear, uid, esc, toast, dialog,
  registerCommand, pickFile, readAsText, readAsDataURL, loadImage, modKey, round, clamp } from '../core/ui.js';
import { panelRebuilder } from '../core/ui.js';
import * as G from '../core/geom.js';
import { saveFile, safeName } from '../core/io.js';
import { allFonts } from '../core/fonts.js';

const NS = 'http://www.w3.org/2000/svg';
const TOOLS = [
  { id: 'select', icon: 'select', key: 'v', label: 'Select (V)' },
  { id: 'direct', icon: 'direct', key: 'a', label: 'Direct select (A) — edit anchors' },
  { id: 'pen', icon: 'pen', key: 'p', label: 'Pen (P) — click for corners, drag for curves' },
  { id: 'pencil', icon: 'pencil', key: 'n', label: 'Pencil (N) — freehand, auto-smoothed' },
  '-',
  { id: 'rect', icon: 'rect', key: 'm', label: 'Rectangle (M)' },
  { id: 'ellipse', icon: 'ellipse', key: 'l', label: 'Ellipse (L)' },
  { id: 'polygon', icon: 'polygon', key: 'y', label: 'Polygon (Y)' },
  { id: 'star', icon: 'star', key: 's', label: 'Star (S)' },
  { id: 'line', icon: 'line', key: '\\', label: 'Line (\\)' },
  { id: 'text', icon: 'text', key: 't', label: 'Text (T)' },
  '-',
  { id: 'eyedrop', icon: 'eyedrop', key: 'i', label: 'Eyedropper (I) — copy style onto selection' },
  { id: 'hand', icon: 'hand', key: 'h', label: 'Hand (H) — or hold Space' },
];

let ctx, S, root, svg, gAb, gArt, gOv, defs, panelEl, railEl, inlineEditor = null;
let view = { x: -60, y: -60, k: 1 };
let tool = 'select';
const sel = new Set();
let anchorsSel = []; // [{id, s, i}]
let drag = null, pen = null, spaceDown = false, hoverWorld = null;
let fitted = false;
const opts = { radius: 0, sides: 6, points: 5, inner: 0.45, snapGrid: false, grid: 8, smart: true };
const style = { fill: '#e3a72f', stroke: '#1c1a17', sw: 2 };
let clipboard = null;
const V = () => S.store.doc.vector;
const items = () => V().items;
const byId = (id) => items().find(i => i.id === id);

// ---------- paper bridge (curve-accurate booleans & smoothing) ----------
let paperReady = false;
function ensurePaper() { if (!paperReady) { paper.setup(new paper.Size(1, 1)); paperReady = true; } }
function toPaper(subpaths) {
  ensurePaper();
  const paths = subpaths.map(sp => new paper.Path({
    segments: sp.pts.map(p => new paper.Segment(new paper.Point(p.x, p.y), new paper.Point(p.ix - p.x, p.iy - p.y), new paper.Point(p.ox - p.x, p.oy - p.y))),
    closed: sp.closed, insert: false,
  }));
  return paths.length === 1 ? paths[0] : new paper.CompoundPath({ children: paths, insert: false, fillRule: 'evenodd' });
}
function fromPaper(item) {
  const list = item instanceof paper.CompoundPath ? item.children : [item];
  return list.filter(p => p.segments && p.segments.length).map(p => ({
    closed: p.closed,
    pts: p.segments.map(s => ({ x: s.point.x, y: s.point.y, ix: s.point.x + s.handleIn.x, iy: s.point.y + s.handleIn.y, ox: s.point.x + s.handleOut.x, oy: s.point.y + s.handleOut.y })),
  }));
}

// ---------- item helpers ----------
const clone = (o) => JSON.parse(JSON.stringify(o));

function fontCss(it, k = 1) { return `${it.italic ? 'italic ' : ''}${it.weight || 400} ${it.size * k}px "${it.font}", sans-serif`; }
function localBounds(it) {
  if (it.type === 'path') return G.subpathsBounds(it.subpaths);
  if (it.type === 'image') return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.type === 'text') {
    const lines = String(it.text).split('\n'); const lh = it.lh || it.size * 1.2;
    let w = 0; for (const l of lines) w = Math.max(w, G.measureText(l, fontCss(it)).width + (it.ls || 0) * it.size * l.length);
    const x0 = it.align === 'middle' ? it.x - w / 2 : it.align === 'end' ? it.x - w : it.x;
    return { x: x0, y: it.y - it.size * 0.82, w, h: lh * (lines.length - 1) + it.size * 1.04 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}
export function itemBounds(it) {
  const b = localBounds(it);
  if (!it.m) return b;
  const c = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => G.apply(it.m, x, y));
  const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
function transformItem(it, m) {
  if (it.type === 'path') { G.transformSubpaths(it.subpaths, m); const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); if (it.scaleStroke !== false && it.sw) it.sw = it.sw * s; }
  else it.m = G.mul(m, it.m || G.I());
}
const selBounds = () => G.unionBounds([...sel].map(byId).filter(Boolean).map(itemBounds));

// ---------- SVG serialization (canvas + export share this) ----------
function gradDef(it) {
  const f = it.fill; const a = ((f.angle || 0) * Math.PI) / 180;
  const x1 = 0.5 - Math.cos(a) / 2, y1 = 0.5 - Math.sin(a) / 2, x2 = 0.5 + Math.cos(a) / 2, y2 = 0.5 + Math.sin(a) / 2;
  return `<linearGradient id="g-${it.id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${f.stops.map(s => `<stop offset="${s.o}" stop-color="${esc(s.c)}"/>`).join('')}</linearGradient>`;
}
function paint(it) {
  const fill = it.fill == null ? 'none' : typeof it.fill === 'object' ? `url(#g-${it.id})` : it.fill;
  let a = `fill="${esc(fill)}"`;
  if (it.stroke && it.sw > 0) a += ` stroke="${esc(it.stroke)}" stroke-width="${it.sw}" stroke-linecap="${it.cap || 'butt'}" stroke-linejoin="${it.join || 'miter'}"${it.dash ? ` stroke-dasharray="${esc(it.dash)}"` : ''}`;
  if (it.rule === 'evenodd') a += ' fill-rule="evenodd"';
  const st = []; if (it.opacity != null && it.opacity < 1) st.push(`opacity:${it.opacity}`); if (it.blend && it.blend !== 'normal') st.push(`mix-blend-mode:${it.blend}`);
  if (st.length) a += ` style="${st.join(';')}"`;
  return a;
}
const mAttr = (m) => m ? ` transform="matrix(${m.map(n => round(n, 5)).join(' ')})"` : '';
export function itemSVG(it, { hit = false, k = 1 } = {}) {
  if (it.hidden) return '';
  const id = hit ? ` data-id="${it.id}"` : '';
  if (it.type === 'path') {
    const d = G.subpathsD(it.subpaths);
    let s = `<path d="${d}" ${paint(it)}${id}/>`;
    if (hit) s += `<path d="${d}" fill="none" stroke="transparent" stroke-width="${10 / k}" pointer-events="stroke"${id}/>`;
    return s;
  }
  if (it.type === 'text') {
    const lines = String(it.text).split('\n'); const lh = it.lh || it.size * 1.2;
    const ls = it.ls ? ` letter-spacing="${it.ls * it.size}"` : '';
    const t = lines.map((l, i) => `<tspan x="${it.x}" ${i ? `dy="${lh}"` : ''}>${esc(l) || ' '}</tspan>`).join('');
    return `<text x="${it.x}" y="${it.y}" font-family="${esc(it.font)}, sans-serif" font-size="${it.size}" font-weight="${it.weight || 400}"${it.italic ? ' font-style="italic"' : ''} text-anchor="${it.align || 'start'}"${ls} ${paint(it)}${mAttr(it.m)}${id} xml:space="preserve">${t}</text>`;
  }
  if (it.type === 'image') {
    const href = hit ? S.assetURL(it.asset) : (S.store.doc.assets[it.asset]?.data || '');
    return `<image href="${href}" x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" preserveAspectRatio="none"${it.opacity != null && it.opacity < 1 ? ` opacity="${it.opacity}"` : ''}${mAttr(it.m)}${id}/>`;
  }
  return '';
}
function defsFor(list) { return list.filter(it => it.fill && typeof it.fill === 'object').map(gradDef).join(''); }
/** Full SVG for an artboard (used by export and by Layout placements). */
export function artboardSVG(abId, { withBg = true } = {}) {
  const ab = V().artboards.find(a => a.id === abId) || V().artboards[0];
  if (!ab) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const list = items().filter(i => !i.hidden);
  return `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${ab.x} ${ab.y} ${ab.w} ${ab.h}" width="${ab.w}" height="${ab.h}">` +
    `<defs>${defsFor(list)}</defs>` + (withBg && ab.bg ? `<rect x="${ab.x}" y="${ab.y}" width="${ab.w}" height="${ab.h}" fill="${esc(ab.bg)}"/>` : '') +
    list.map(it => itemSVG(it)).join('') + '</svg>';
}
export function listArtboards() { return V().artboards.map(a => ({ id: a.id, name: a.name, w: a.w, h: a.h })); }
/** Closed outlines (for Mesh extrusion / CAD profiles). Returns [{id,name,subpaths}] in world px, y-down. */
export function listShapes() { return items().filter(i => i.type === 'path' && i.subpaths.some(s => s.closed && s.pts.length > 2)).map(i => ({ id: i.id, name: i.name || 'Path', subpaths: i.subpaths, fill: typeof i.fill === 'string' ? i.fill : null })); }
export function getItem(id) { return byId(id); }

// ---------- rendering ----------
function render() {
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${Math.max(1, r.width) / view.k} ${Math.max(1, r.height) / view.k}`);
  // artboards
  gAb.innerHTML = V().artboards.map(ab => `<rect class="ab-bg" x="${ab.x}" y="${ab.y}" width="${ab.w}" height="${ab.h}" style="fill:${esc(ab.bg || '#ffffff')}"/>` +
    `<rect class="ab-frame" x="${ab.x}" y="${ab.y}" width="${ab.w}" height="${ab.h}"/>` +
    `<text class="ab-label" x="${ab.x}" y="${ab.y - 8 / view.k}" style="font-size:${10.5 / view.k}px">${esc(ab.name)} · ${round(ab.w, 0)}×${round(ab.h, 0)}</text>`).join('') +
    (opts.snapGrid ? gridLines(r) : '');
  const list = items();
  defs.innerHTML = defsFor(list);
  gArt.innerHTML = list.map(it => itemSVG(it, { hit: !it.locked, k: view.k })).join('');
  renderOverlay();
}
function gridLines(r) {
  const g = opts.grid; if (g * view.k < 6) return '';
  const x0 = Math.floor(view.x / g) * g, y0 = Math.floor(view.y / g) * g, x1 = view.x + r.width / view.k, y1 = view.y + r.height / view.k;
  let s = ''; for (let x = x0; x < x1; x += g) s += `<line class="grid-line" x1="${x}" y1="${y0}" x2="${x}" y2="${y1}"/>`;
  for (let y = y0; y < y1; y += g) s += `<line class="grid-line" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`;
  return s;
}
let guides = [];
function renderOverlay() {
  const k = view.k, hs = 8 / k; let s = '';
  for (const id of sel) {
    const it = byId(id); if (!it || it.hidden) continue;
    if (it.type === 'path') s += `<path class="sel-outline" d="${G.subpathsD(it.subpaths)}"/>`;
  }
  if (tool === 'direct' || (pen && pen.id)) {
    for (const id of (pen ? [pen.id] : [...sel])) {
      const it = byId(id); if (!it || it.type !== 'path') continue;
      it.subpaths.forEach((sp, si) => sp.pts.forEach((p, pi) => {
        const on = anchorsSel.some(a => a.id === id && a.s === si && a.i === pi);
        if (on || pen) {
          if (p.ix !== p.x || p.iy !== p.y) s += `<line class="ctrl-line" x1="${p.x}" y1="${p.y}" x2="${p.ix}" y2="${p.iy}"/><circle class="handle" data-ctrl="${id}:${si}:${pi}:in" cx="${p.ix}" cy="${p.iy}" r="${3.5 / k}"/>`;
          if (p.ox !== p.x || p.oy !== p.y) s += `<line class="ctrl-line" x1="${p.x}" y1="${p.y}" x2="${p.ox}" y2="${p.oy}"/><circle class="handle" data-ctrl="${id}:${si}:${pi}:out" cx="${p.ox}" cy="${p.oy}" r="${3.5 / k}"/>`;
        }
        s += `<rect class="handle${on ? ' on' : ''}" data-anchor="${id}:${si}:${pi}" x="${p.x - 3.5 / k}" y="${p.y - 3.5 / k}" width="${7 / k}" height="${7 / k}"/>`;
      }));
    }
  }
  if (tool === 'select' && sel.size) {
    const b = selBounds();
    if (b) {
      s += `<rect class="sel-box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
      const hx = [b.x, b.x + b.w / 2, b.x + b.w], hy = [b.y, b.y + b.h / 2, b.y + b.h];
      const names = [['nw', 'n', 'ne'], ['w', '', 'e'], ['sw', 's', 'se']];
      for (let yi = 0; yi < 3; yi++) for (let xi = 0; xi < 3; xi++) {
        const n = names[yi][xi]; if (!n) continue;
        s += `<rect class="handle" data-h="${n}" x="${hx[xi] - hs / 2}" y="${hy[yi] - hs / 2}" width="${hs}" height="${hs}" style="cursor:${n}-resize"/>`;
      }
      const ry = b.y - 22 / k;
      s += `<line class="ctrl-line" x1="${b.x + b.w / 2}" y1="${b.y}" x2="${b.x + b.w / 2}" y2="${ry}"/><circle class="handle" data-h="rot" cx="${b.x + b.w / 2}" cy="${ry}" r="${5 / k}" style="cursor:grab"/>`;
    }
  }
  if (drag?.mode === 'marquee') { const m = drag.rect; s += `<rect class="marquee" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}"/>`; }
  for (const g of guides) s += `<line class="guide" x1="${g[0]}" y1="${g[1]}" x2="${g[2]}" y2="${g[3]}"/>`;
  if (pen && hoverWorld && !drag) {
    const it = byId(pen.id); const sp = it?.subpaths[0]; const last = sp?.pts[sp.pts.length - 1];
    if (last) s += `<path class="pen-preview" d="M${last.x} ${last.y}C${last.ox} ${last.oy} ${hoverWorld[0]} ${hoverWorld[1]} ${hoverWorld[0]} ${hoverWorld[1]}"/>`;
  }
  if (drag?.mode === 'pencil' && drag.pts.length > 1) s += `<path class="pen-preview" d="M${drag.pts.map(p => p.join(' ')).join('L')}"/>`;
  gOv.innerHTML = s;
  updateStatus();
}
function updateStatus() {
  const t = TOOLS.find(x => x.id === tool);
  const c = hoverWorld ? `${round(hoverWorld[0], 1)}, ${round(hoverWorld[1], 1)} px` : '';
  ctx.setStatus('vector', `${(t?.label || '').split(' (')[0]} · ${Math.round(view.k * 100)}% · ${c}${sel.size ? ` · ${sel.size} selected` : ''}`);
  if (zoomLabel) zoomLabel.textContent = Math.round(view.k * 100) + '%';
}

// ---------- view ----------
function toWorld(e) { const r = svg.getBoundingClientRect(); return [view.x + (e.clientX - r.left) / view.k, view.y + (e.clientY - r.top) / view.k]; }
function zoomAt(k, sx, sy) {
  const r = svg.getBoundingClientRect(); sx ??= r.width / 2; sy ??= r.height / 2;
  const wx = view.x + sx / view.k, wy = view.y + sy / view.k;
  view.k = clamp(k, 0.05, 64); view.x = wx - sx / view.k; view.y = wy - sy / view.k; render();
}
function fitView(b) {
  const r = svg.getBoundingClientRect(); if (r.width < 10) return false;
  b ??= G.unionBounds([...V().artboards, ...items().map(itemBounds)]) || { x: 0, y: 0, w: 800, h: 600 };
  const pad = 48; view.k = clamp(Math.min((r.width - pad * 2) / Math.max(1, b.w), (r.height - pad * 2) / Math.max(1, b.h)), 0.05, 8);
  view.x = b.x - (r.width / view.k - b.w) / 2; view.y = b.y - (r.height / view.k - b.h) / 2; render(); return true;
}

// ---------- selection & commands ----------
function select(ids, add = false) { if (!add) sel.clear(); for (const id of ids) sel.add(id); anchorsSel = []; renderOverlay(); buildPanel(); }
function mutate(label, fn) { S.checkpoint(label); fn(); S.changed('vector'); }
function deleteSelection() {
  if (tool === 'direct' && anchorsSel.length) {
    mutate('Delete anchors', () => {
      const byItem = {}; for (const a of anchorsSel) (byItem[a.id] ??= []).push(a);
      for (const [id, list] of Object.entries(byItem)) {
        const it = byId(id); if (!it) continue;
        list.sort((a, b) => b.s - a.s || b.i - a.i).forEach(a => it.subpaths[a.s]?.pts.splice(a.i, 1));
        it.subpaths = it.subpaths.filter(sp => sp.pts.length > 1);
        if (!it.subpaths.length) V().items = items().filter(x => x.id !== id);
      }
      anchorsSel = [];
    });
    return;
  }
  if (!sel.size) return;
  mutate('Delete', () => { V().items = items().filter(i => !sel.has(i.id)); sel.clear(); });
  buildPanel();
}
function duplicate(offset = 10) {
  if (!sel.size) return;
  mutate('Duplicate', () => {
    const ids = [];
    for (const it of items().filter(i => sel.has(i.id))) { const c = clone(it); c.id = uid('v'); transformItem(c, G.tr(offset, offset)); items().push(c); ids.push(c.id); }
    sel.clear(); ids.forEach(i => sel.add(i));
  });
  buildPanel();
}
function arrange(dir) {
  if (!sel.size) return;
  mutate('Arrange', () => {
    const list = items(); const picked = list.filter(i => sel.has(i.id)); const rest = list.filter(i => !sel.has(i.id));
    if (dir === 'front') V().items = [...rest, ...picked];
    else if (dir === 'back') V().items = [...picked, ...rest];
    else {
      const arr = [...list]; const order = dir === 'forward' ? [...arr.keys()].reverse() : [...arr.keys()];
      for (const i of order) { if (!sel.has(arr[i].id)) continue; const j = dir === 'forward' ? i + 1 : i - 1; if (j < 0 || j >= arr.length || sel.has(arr[j].id)) continue; [arr[i], arr[j]] = [arr[j], arr[i]]; }
      V().items = arr;
    }
  });
}
function align(how) {
  const list = items().filter(i => sel.has(i.id)); if (!list.length) return;
  const ab = currentArtboard();
  const ref = list.length === 1 ? ab : selBounds();
  mutate('Align', () => {
    for (const it of list) {
      const b = itemBounds(it); let dx = 0, dy = 0;
      if (how === 'l') dx = ref.x - b.x; if (how === 'ch') dx = ref.x + ref.w / 2 - (b.x + b.w / 2); if (how === 'r') dx = ref.x + ref.w - (b.x + b.w);
      if (how === 't') dy = ref.y - b.y; if (how === 'cv') dy = ref.y + ref.h / 2 - (b.y + b.h / 2); if (how === 'b') dy = ref.y + ref.h - (b.y + b.h);
      transformItem(it, G.tr(dx, dy));
    }
  });
}
function distribute(axis) {
  const list = items().filter(i => sel.has(i.id)); if (list.length < 3) { toast('Select three or more objects to distribute'); return; }
  const bs = list.map(it => ({ it, b: itemBounds(it) })).sort((a, b) => axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y);
  const first = bs[0].b, last = bs[bs.length - 1].b;
  const total = axis === 'h' ? (last.x + last.w - first.x) : (last.y + last.h - first.y);
  const sizes = bs.reduce((s, x) => s + (axis === 'h' ? x.b.w : x.b.h), 0); const gap = (total - sizes) / (bs.length - 1);
  mutate('Distribute', () => { let pos = axis === 'h' ? first.x : first.y; for (const x of bs) { const cur = axis === 'h' ? x.b.x : x.b.y; transformItem(x.it, axis === 'h' ? G.tr(pos - cur, 0) : G.tr(0, pos - cur)); pos += (axis === 'h' ? x.b.w : x.b.h) + gap; } });
}
function flip(axis) {
  const b = selBounds(); if (!b) return;
  mutate('Flip', () => { for (const it of items().filter(i => sel.has(i.id))) transformItem(it, axis === 'h' ? G.sc(-1, 1, b.x + b.w / 2, 0) : G.sc(1, -1, 0, b.y + b.h / 2)); });
}
function pathfinder(op) {
  const list = items().filter(i => sel.has(i.id) && i.type === 'path');
  if (list.length < 2) { toast('Select two or more paths'); return; }
  try {
    const ps = list.map(it => toPaper(it.subpaths));
    let res;
    if (op === 'unite') res = ps.slice(1).reduce((a, b) => a.unite(b, { insert: false }), ps[0]);
    else if (op === 'subtract') res = ps.slice(1).reduce((a, b) => a.subtract(b, { insert: false }), ps[0]);
    else if (op === 'intersect') res = ps.slice(1).reduce((a, b) => a.intersect(b, { insert: false }), ps[0]);
    else res = ps.slice(1).reduce((a, b) => a.exclude(b, { insert: false }), ps[0]);
    const subs = fromPaper(res);
    mutate('Pathfinder ' + op, () => {
      const base = list[0]; const idx = items().indexOf(base);
      // Keep the back shape's id so anything linked to it (3D extrusions, CAD profiles) follows the edit.
      const out = { ...clone(base), id: base.id, subpaths: subs, rule: 'evenodd', name: (base.name || 'Path') + ' ' + op };
      V().items = items().filter(i => !list.includes(i));
      if (subs.length) items().splice(Math.min(idx, items().length), 0, out);
      sel.clear(); if (subs.length) sel.add(out.id);
    });
    if (!subs.length) toast('The result is empty');
    buildPanel();
  } catch (e) { console.error(e); toast('Boolean failed on these shapes: ' + e.message, 'bad'); }
}
async function repeatDialog(kind) {
  if (!sel.size) { toast('Select something to repeat'); return; }
  const b = selBounds(); const st = kind === 'radial' ? { count: 8, radius: Math.round(Math.max(b.w, b.h) * 1.2) } : { cols: 4, rows: 3, gx: 12, gy: 12 };
  const ok = await dialog({ title: kind === 'radial' ? 'Radial repeat' : 'Grid repeat', body: (el) => el.append(h('div', { class: 'fields' },
    kind === 'radial'
      ? [numField({ label: 'Copies', value: st.count, min: 2, max: 360, step: 1, decimals: 0, onChange: v => st.count = Math.round(v) }), numField({ label: 'Radius', unit: 'px', value: st.radius, min: 0, onChange: v => st.radius = v })]
      : [numField({ label: 'Columns', value: st.cols, min: 1, max: 100, decimals: 0, onChange: v => st.cols = Math.round(v) }), numField({ label: 'Rows', value: st.rows, min: 1, max: 100, decimals: 0, onChange: v => st.rows = Math.round(v) }),
        numField({ label: 'Gap X', unit: 'px', value: st.gx, onChange: v => st.gx = v }), numField({ label: 'Gap Y', unit: 'px', value: st.gy, onChange: v => st.gy = v })])),
    actions: [{ label: 'Cancel', value: false }, { label: 'Repeat', primary: true, value: true }] });
  if (!ok) return;
  mutate(kind === 'radial' ? 'Radial repeat' : 'Grid repeat', () => {
    const src = items().filter(i => sel.has(i.id)); const out = [];
    if (kind === 'radial') {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2 + st.radius;
      for (let i = 1; i < st.count; i++) for (const it of src) { const c = clone(it); c.id = uid('v'); transformItem(c, G.rot((i * 2 * Math.PI) / st.count, cx, cy)); out.push(c); }
    } else {
      for (let r = 0; r < st.rows; r++) for (let c0 = 0; c0 < st.cols; c0++) { if (!r && !c0) continue; for (const it of src) { const c = clone(it); c.id = uid('v'); transformItem(c, G.tr(c0 * (b.w + st.gx), r * (b.h + st.gy))); out.push(c); } }
    }
    items().push(...out); out.forEach(o => sel.add(o.id));
  });
  buildPanel();
}
function currentArtboard() {
  const b = selBounds(); const abs = V().artboards;
  if (b) { const c = [b.x + b.w / 2, b.y + b.h / 2]; const hit = abs.find(a => c[0] >= a.x && c[0] <= a.x + a.w && c[1] >= a.y && c[1] <= a.y + a.h); if (hit) return hit; }
  return abs.find(a => a.id === activeAb) || abs[0];
}
let activeAb = null;

// ---------- snapping ----------
function snapMove(dx, dy, b) {
  guides = [];
  if (opts.snapGrid) { const g = opts.grid; return [Math.round((b.x + dx) / g) * g - b.x, Math.round((b.y + dy) / g) * g - b.y]; }
  if (!opts.smart) return [dx, dy];
  const tol = 6 / view.k, others = [...items().filter(i => !sel.has(i.id) && !i.hidden).map(itemBounds), ...V().artboards];
  const xs = [], ys = []; for (const o of others) { xs.push(o.x, o.x + o.w / 2, o.x + o.w); ys.push(o.y, o.y + o.h / 2, o.y + o.h); }
  const mx = [b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w], my = [b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h];
  let bx = null, by = null;
  for (const m of mx) for (const x of xs) { const d = x - m; if (Math.abs(d) < tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, x }; }
  for (const m of my) for (const y of ys) { const d = y - m; if (Math.abs(d) < tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, y }; }
  if (bx) { dx += bx.d; guides.push([bx.x, Math.min(b.y + dy, ...others.map(o => o.y)) - 20, bx.x, Math.max(b.y + dy + b.h, ...others.map(o => o.y + o.h)) + 20]); }
  if (by) { dy += by.d; guides.push([Math.min(b.x + dx, ...others.map(o => o.x)) - 20, by.y, Math.max(b.x + dx + b.w, ...others.map(o => o.x + o.w)) + 20, by.y]); }
  return [dx, dy];
}
const snapPt = (x, y) => opts.snapGrid ? [Math.round(x / opts.grid) * opts.grid, Math.round(y / opts.grid) * opts.grid] : [x, y];

// ---------- pointer handling ----------
const pointers = new Map();
function onDown(e) {
  if (inlineEditor) commitInline();
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag = { mode: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), k0: view.k, c0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...view } }; return; }
  const [wx, wy] = toWorld(e); const t = e.target;
  if (e.button === 1 || spaceDown || tool === 'hand') { drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, v0: { ...view } }; return; }
  if (e.button !== 0) return;
  const hitId = t.closest?.('[data-id]')?.dataset.id;

  if (tool === 'select') {
    if (t.dataset.h) { startTransform(t.dataset.h, wx, wy, e); return; }
    if (hitId) {
      if (e.shiftKey) { sel.has(hitId) ? sel.delete(hitId) : sel.add(hitId); }
      else if (!sel.has(hitId)) { sel.clear(); sel.add(hitId); }
      buildPanel(); renderOverlay();
      if (!sel.size) return;
      S.checkpoint('Move');
      if (e.altKey) { // alt-drag duplicates
        const ids = []; for (const it of items().filter(i => sel.has(i.id))) { const c = clone(it); c.id = uid('v'); items().push(c); ids.push(c.id); }
        sel.clear(); ids.forEach(i => sel.add(i));
      }
      drag = { mode: 'move', duplicated: e.altKey, x0: wx, y0: wy, orig: new Map([...sel].map(id => [id, clone(byId(id))])), b0: selBounds() };
      return;
    }
    if (!e.shiftKey) sel.clear();
    drag = { mode: 'marquee', x0: wx, y0: wy, rect: { x: wx, y: wy, w: 0, h: 0 } }; buildPanel(); renderOverlay(); return;
  }
  if (tool === 'direct') {
    if (t.dataset.ctrl) { const [id, s, i, which] = t.dataset.ctrl.split(':'); S.checkpoint('Edit handle'); drag = { mode: 'handle', id, s: +s, i: +i, which }; return; }
    if (t.dataset.anchor) {
      const [id, s, i] = t.dataset.anchor.split(':').map((v, k) => k ? +v : v);
      const it = byId(id); const p = it.subpaths[s].pts[i];
      if (e.altKey) { mutate('Convert anchor', () => toggleSmooth(it.subpaths[s], i)); return; }
      const exists = anchorsSel.some(a => a.id === id && a.s === s && a.i === i);
      if (e.shiftKey) { anchorsSel = exists ? anchorsSel.filter(a => !(a.id === id && a.s === s && a.i === i)) : [...anchorsSel, { id, s, i }]; }
      else if (!exists) anchorsSel = [{ id, s, i }];
      S.checkpoint('Move anchor');
      drag = { mode: 'anchors', x0: wx, y0: wy, orig: anchorsSel.map(a => ({ ...a, p: { ...byId(a.id).subpaths[a.s].pts[a.i] } })), single: !e.shiftKey ? p : null };
      renderOverlay(); return;
    }
    if (hitId) { if (!sel.has(hitId)) { sel.clear(); sel.add(hitId); anchorsSel = []; buildPanel(); } renderOverlay(); return; }
    sel.clear(); anchorsSel = []; buildPanel(); renderOverlay();
    drag = { mode: 'marquee', direct: true, x0: wx, y0: wy, rect: { x: wx, y: wy, w: 0, h: 0 } }; return;
  }
  if (tool === 'pen') { penDown(wx, wy, e); return; }
  if (tool === 'pencil') { drag = { mode: 'pencil', pts: [[wx, wy]] }; return; }
  if (tool === 'eyedrop') {
    const src = hitId && byId(hitId); if (!src) return;
    if (sel.size) mutate('Apply style', () => { for (const it of items().filter(i => sel.has(i.id))) { if (it.type !== 'image') { it.fill = clone(src.fill); it.stroke = src.stroke; it.sw = src.sw; it.opacity = src.opacity; } } });
    style.fill = typeof src.fill === 'string' ? src.fill : style.fill; style.stroke = src.stroke; style.sw = src.sw;
    toast('Style picked up'); buildPanel(); return;
  }
  if (tool === 'text') {
    const [x, y] = snapPt(wx, wy);
    mutate('Add text', () => { const it = { id: uid('v'), type: 'text', name: 'Text', x, y, text: 'Text', font: 'Jost', size: 36, weight: 600, fill: style.stroke || '#1c1a17', stroke: null, sw: 0, align: 'start' }; items().push(it); sel.clear(); sel.add(it.id); });
    buildPanel(); setTimeout(() => editInline([...sel][0]), 30); setTool('select'); return;
  }
  if (['rect', 'ellipse', 'polygon', 'star', 'line'].includes(tool)) {
    const [x, y] = snapPt(wx, wy);
    S.checkpoint('Draw ' + tool);
    const it = { id: uid('v'), type: 'path', name: tool[0].toUpperCase() + tool.slice(1), subpaths: [], fill: tool === 'line' ? null : style.fill, stroke: style.stroke, sw: tool === 'line' ? Math.max(style.sw, 1) : style.sw };
    items().push(it); sel.clear(); sel.add(it.id);
    drag = { mode: 'create', id: it.id, x0: x, y0: y };
  }
}
function onMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const [wx, wy] = toWorld(e); hoverWorld = [wx, wy];
  if (!drag) { if (pen) renderOverlay(); else updateStatus(); return; }
  if (drag.mode === 'pinch') {
    if (pointers.size < 2) return; const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const r = svg.getBoundingClientRect();
    const k = clamp(drag.k0 * d / drag.d0, 0.05, 64);
    const wx0 = drag.v0.x + (drag.c0[0] - r.left) / drag.k0, wy0 = drag.v0.y + (drag.c0[1] - r.top) / drag.k0;
    view.k = k; view.x = wx0 - (c[0] - r.left) / k; view.y = wy0 - (c[1] - r.top) / k; render(); return;
  }
  if (drag.mode === 'pan') { view.x = drag.v0.x - (e.clientX - drag.sx) / view.k; view.y = drag.v0.y - (e.clientY - drag.sy) / view.k; render(); return; }
  if (drag.mode === 'marquee') {
    drag.rect = { x: Math.min(drag.x0, wx), y: Math.min(drag.y0, wy), w: Math.abs(wx - drag.x0), h: Math.abs(wy - drag.y0) }; renderOverlay(); return;
  }
  if (drag.mode === 'move') {
    let dx = wx - drag.x0, dy = wy - drag.y0;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    [dx, dy] = snapMove(dx, dy, drag.b0);
    for (const [id, o] of drag.orig) { const it = byId(id); const c = clone(o); transformItem(c, G.tr(dx, dy)); Object.assign(it, c); }
    drag.moved = true; S.changed('vector', { live: true }); return;
  }
  if (drag.mode === 'scale' || drag.mode === 'rotate') { applyTransformDrag(wx, wy, e); return; }
  if (drag.mode === 'anchors') {
    let dx = wx - drag.x0, dy = wy - drag.y0; if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    for (const o of drag.orig) { const p = byId(o.id).subpaths[o.s].pts[o.i]; const q = o.p; p.x = q.x + dx; p.y = q.y + dy; p.ix = q.ix + dx; p.iy = q.iy + dy; p.ox = q.ox + dx; p.oy = q.oy + dy; }
    drag.moved = true; S.changed('vector', { live: true }); return;
  }
  if (drag.mode === 'handle') {
    const p = byId(drag.id).subpaths[drag.s].pts[drag.i];
    const [x, y] = snapPt(wx, wy);
    if (drag.which === 'in') { p.ix = x; p.iy = y; if (!e.altKey && !p.broken) { const l = Math.hypot(p.ox - p.x, p.oy - p.y), a = Math.atan2(p.y - y, p.x - x); if (l > 0) { p.ox = p.x + Math.cos(a) * l; p.oy = p.y + Math.sin(a) * l; } } }
    else { p.ox = x; p.oy = y; if (!e.altKey && !p.broken) { const l = Math.hypot(p.ix - p.x, p.iy - p.y), a = Math.atan2(p.y - y, p.x - x); if (l > 0) { p.ix = p.x + Math.cos(a) * l; p.iy = p.y + Math.sin(a) * l; } } }
    if (e.altKey) p.broken = true;
    drag.moved = true; S.changed('vector', { live: true }); return;
  }
  if (drag.mode === 'pen-handle') {
    const it = byId(pen.id); const sp = it.subpaths[0]; const p = drag.closing ? sp.pts[0] : sp.pts[sp.pts.length - 1];
    let [x, y] = [wx, wy];
    p.ox = x; p.oy = y; p.ix = 2 * p.x - x; p.iy = 2 * p.y - y;
    if (drag.closing) { [p.ox, p.ix] = [p.ix, p.ox]; [p.oy, p.iy] = [p.iy, p.oy]; }
    S.changed('vector', { live: true }); return;
  }
  if (drag.mode === 'pencil') { const l = drag.pts[drag.pts.length - 1]; if (Math.hypot(l[0] - wx, l[1] - wy) > 1.5 / view.k) drag.pts.push([wx, wy]); renderOverlay(); return; }
  if (drag.mode === 'create') {
    const it = byId(drag.id); let [x, y] = snapPt(wx, wy); let x0 = drag.x0, y0 = drag.y0;
    let w = x - x0, hh = y - y0;
    if (e.shiftKey && tool !== 'line') { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
    if (e.shiftKey && tool === 'line') { const a = Math.round(Math.atan2(hh, w) / (Math.PI / 4)) * Math.PI / 4, l = Math.hypot(w, hh); w = Math.cos(a) * l; hh = Math.sin(a) * l; }
    if (e.altKey && tool !== 'line') { x0 -= w; y0 -= hh; w *= 2; hh *= 2; }
    const bx = Math.min(x0, x0 + w), by = Math.min(y0, y0 + hh), bw = Math.abs(w), bh = Math.abs(hh);
    if (tool === 'rect') it.subpaths = G.rectPath(bx, by, bw, bh, opts.radius);
    else if (tool === 'ellipse') it.subpaths = G.ellipsePath(bx + bw / 2, by + bh / 2, bw / 2, bh / 2);
    else if (tool === 'polygon') { it.subpaths = G.polygonPath(0, 0, 1, opts.sides); fitInto(it.subpaths, bx, by, bw, bh); }
    else if (tool === 'star') { it.subpaths = G.starPath(0, 0, 1, opts.inner, opts.points); fitInto(it.subpaths, bx, by, bw, bh); }
    else if (tool === 'line') it.subpaths = [{ closed: false, pts: [G.P(x0, y0), G.P(x0 + w, y0 + hh)] }];
    drag.moved = true; S.changed('vector', { live: true });
  }
}
function fitInto(subs, x, y, w, hh) { const b = G.subpathsBounds(subs); G.transformSubpaths(subs, G.mul(G.tr(x, y), G.mul([w / (b.w || 1), 0, 0, hh / (b.h || 1), 0, 0], G.tr(-b.x, -b.y)))); }
function onUp(e) {
  pointers.delete(e.pointerId);
  if (!drag) return;
  const d = drag; drag = null; guides = [];
  if (d.mode === 'pinch' || d.mode === 'pan') { render(); return; }
  if (d.mode === 'marquee') {
    const m = d.rect;
    if (m.w > 2 / view.k || m.h > 2 / view.k) {
      if (d.direct) {
        for (const it of items().filter(i => i.type === 'path' && !i.locked && !i.hidden)) it.subpaths.forEach((sp, s) => sp.pts.forEach((p, i) => { if (p.x >= m.x && p.x <= m.x + m.w && p.y >= m.y && p.y <= m.y + m.h) { sel.add(it.id); anchorsSel.push({ id: it.id, s, i }); } }));
      } else {
        for (const it of items()) { if (it.locked || it.hidden) continue; const b = itemBounds(it); if (b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y) sel.add(it.id); }
      }
    }
    buildPanel(); renderOverlay(); return;
  }
  if (d.mode === 'pencil') {
    if (d.pts.length > 2) {
      ensurePaper(); const pp = new paper.Path({ segments: d.pts.map(p => new paper.Point(p[0], p[1])), insert: false });
      pp.simplify(2.5 / Math.max(0.25, view.k));
      const first = d.pts[0], last = d.pts[d.pts.length - 1]; const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) < 10 / view.k;
      if (closed) pp.closePath();
      mutate('Pencil', () => { const it = { id: uid('v'), type: 'path', name: 'Pencil', subpaths: fromPaper(pp), fill: closed ? style.fill : null, stroke: style.stroke || '#1c1a17', sw: Math.max(1, style.sw) }; items().push(it); sel.clear(); sel.add(it.id); });
      buildPanel();
    }
    renderOverlay(); return;
  }
  if (d.mode === 'create') {
    const it = byId(d.id);
    if (!d.moved || !it.subpaths.length) { // click without drag: default-size shape
      const s = 100; const x = d.x0, y = d.y0;
      if (tool === 'rect') it.subpaths = G.rectPath(x, y, s, s, opts.radius);
      else if (tool === 'ellipse') it.subpaths = G.ellipsePath(x + s / 2, y + s / 2, s / 2, s / 2);
      else if (tool === 'polygon') it.subpaths = G.polygonPath(x + s / 2, y + s / 2, s / 2, opts.sides);
      else if (tool === 'star') it.subpaths = G.starPath(x + s / 2, y + s / 2, s / 2, s / 2 * opts.inner, opts.points);
      else if (tool === 'line') it.subpaths = [{ closed: false, pts: [G.P(x, y), G.P(x + s, y)] }];
      S.changed('vector');
    } else S.changed('vector');
    buildPanel(); return;
  }
  if (d.mode === 'pen-handle') { S.changed('vector'); if (d.closing) finishPen(); return; }
  if (d.moved || d.duplicated) S.changed('vector'); else S.settle();
  buildPanel();
}
function onDbl(e) {
  const t = e.target; const hitId = t.closest?.('[data-id]')?.dataset.id; if (!hitId) return;
  const it = byId(hitId);
  if (it.type === 'text') { editInline(hitId); return; }
  if (it.type === 'path' && (tool === 'direct' || tool === 'select')) {
    if (tool === 'select') { setTool('direct'); select([hitId]); return; }
    const [wx, wy] = toWorld(e); let best = null;
    it.subpaths.forEach((sp, s) => { const n = G.nearestOnSubpath(sp, wx, wy); if (n && (!best || n.d < best.d)) best = { ...n, s }; });
    if (best && best.d < 8 / view.k) { mutate('Add anchor', () => { const i = G.insertAnchor(it.subpaths[best.s], best.seg, best.t); anchorsSel = [{ id: hitId, s: best.s, i }]; }); }
  }
}
function onWheel(e) {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(view.k * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
  else { view.x += (e.shiftKey ? e.deltaY : e.deltaX) / view.k; view.y += (e.shiftKey ? 0 : e.deltaY) / view.k; render(); }
}
function toggleSmooth(sp, i) {
  const n = sp.pts.length, p = sp.pts[i];
  if (G.isCorner(p)) {
    const a = sp.pts[(i - 1 + n) % n], b = sp.pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, k = 0.25;
    const la = Math.hypot(p.x - a.x, p.y - a.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    p.ix = p.x - dx / l * la * k * 1.33; p.iy = p.y - dy / l * la * k * 1.33; p.ox = p.x + dx / l * lb * k * 1.33; p.oy = p.y + dy / l * lb * k * 1.33; p.broken = false;
  } else { p.ix = p.ox = p.x; p.iy = p.oy = p.y; }
}

// transforms (scale / rotate via handles)
function startTransform(hname, wx, wy, e) {
  const b = selBounds(); if (!b) return;
  S.checkpoint(hname === 'rot' ? 'Rotate' : 'Scale');
  drag = { mode: hname === 'rot' ? 'rotate' : 'scale', h: hname, b, x0: wx, y0: wy, orig: new Map([...sel].map(id => [id, clone(byId(id))])), cx: b.x + b.w / 2, cy: b.y + b.h / 2, a0: Math.atan2(wy - (b.y + b.h / 2), wx - (b.x + b.w / 2)) };
}
function applyTransformDrag(wx, wy, e) {
  const d = drag, b = d.b; let m;
  if (d.mode === 'rotate') {
    let a = Math.atan2(wy - d.cy, wx - d.cx) - d.a0; if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    m = G.rot(a, d.cx, d.cy); d.angle = a;
  } else {
    const hn = d.h; const left = hn.includes('w'), right = hn.includes('e'), top = hn.includes('n'), bottom = hn.includes('s');
    let ax = left ? b.x + b.w : right ? b.x : b.x + b.w / 2, ay = top ? b.y + b.h : bottom ? b.y : b.y + b.h / 2;
    if (e.altKey) { ax = d.cx; ay = d.cy; }
    let sx = 1, sy = 1;
    if (left || right) sx = (wx - ax) / ((left ? b.x : b.x + b.w) - ax || 1);
    if (top || bottom) sy = (wy - ay) / ((top ? b.y : b.y + b.h) - ay || 1);
    const corner = (left || right) && (top || bottom);
    if (e.shiftKey) {
      if (corner) { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * s; sy = Math.sign(sy || 1) * s; }
      else if (left || right) sy = Math.abs(sx); else sx = Math.abs(sy);
    }
    if (Math.abs(sx) < 1e-3) sx = 1e-3 * Math.sign(sx || 1); if (Math.abs(sy) < 1e-3) sy = 1e-3 * Math.sign(sy || 1);
    m = G.sc(sx, sy, ax, ay);
  }
  for (const [id, o] of d.orig) { const c = clone(o); transformItem(c, m); Object.assign(byId(id), c); }
  d.moved = true; S.changed('vector', { live: true });
}

// pen
function penDown(wx, wy, e) {
  [wx, wy] = snapPt(wx, wy);
  if (pen) {
    const it = byId(pen.id); if (!it) { pen = null; return penDown(wx, wy, e); }
    const sp = it.subpaths[0], first = sp.pts[0], last = sp.pts[sp.pts.length - 1];
    if (sp.pts.length > 1 && Math.hypot(first.x - wx, first.y - wy) < 9 / view.k) { S.checkpoint('Close path'); sp.closed = true; drag = { mode: 'pen-handle', closing: true }; S.changed('vector', { live: true }); return; }
    if (e.shiftKey) { const a = Math.round(Math.atan2(wy - last.y, wx - last.x) / (Math.PI / 4)) * Math.PI / 4, l = Math.hypot(wx - last.x, wy - last.y); wx = last.x + Math.cos(a) * l; wy = last.y + Math.sin(a) * l; }
    S.checkpoint('Pen point'); sp.pts.push(G.P(wx, wy)); drag = { mode: 'pen-handle' }; S.changed('vector', { live: true }); return;
  }
  S.checkpoint('Pen path');
  const it = { id: uid('v'), type: 'path', name: 'Path', subpaths: [{ closed: false, pts: [G.P(wx, wy)] }], fill: null, stroke: style.stroke || '#1c1a17', sw: Math.max(1, style.sw) };
  items().push(it); sel.clear(); sel.add(it.id); pen = { id: it.id };
  drag = { mode: 'pen-handle' }; S.changed('vector', { live: true });
}
function finishPen() {
  if (!pen) return; const it = byId(pen.id); pen = null;
  if (it) {
    const sp = it.subpaths[0];
    if (sp.pts.length < 2) { V().items = items().filter(i => i !== it); sel.delete(it.id); }
    else if (sp.closed && it.fill == null) it.fill = style.fill;
    S.changed('vector');
  }
  buildPanel(); renderOverlay();
}

// inline text editing
function editInline(id) {
  const it = byId(id); if (!it || it.type !== 'text') return;
  const host = root; const r = svg.getBoundingClientRect(), hr = host.getBoundingClientRect(); const b = itemBounds(it);
  const ta = h('textarea', { class: 'vec-inline-edit', spellcheck: 'false' });
  ta.value = it.text;
  Object.assign(ta.style, { left: (b.x - view.x) * view.k + r.left - hr.left - 4 + 'px', top: (b.y - view.y) * view.k + r.top - hr.top - 4 + 'px',
    minWidth: Math.max(80, b.w * view.k + 30) + 'px', height: Math.max(30, b.h * view.k + 14) + 'px', font: fontCss(it, view.k), color: '#111', lineHeight: (it.lh || it.size * 1.2) * view.k + 'px' });
  host.append(ta); ta.focus(); ta.select();
  inlineEditor = { ta, id };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); commitInline(); } e.stopPropagation(); });
  ta.addEventListener('blur', () => setTimeout(commitInline, 0));
}
function commitInline() {
  if (!inlineEditor) return; const { ta, id } = inlineEditor; inlineEditor = null;
  const it = byId(id); const v = ta.value; ta.remove();
  if (it && v !== it.text) mutate('Edit text', () => { it.text = v || ' '; });
}

// ---------- tools rail ----------
let toolBtns = {}, zoomLabel;
function setTool(t) {
  if (pen && t !== 'pen') finishPen();
  tool = t; anchorsSel = [];
  for (const [id, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(id === t));
  if (svg) svg.style.cursor = t === 'hand' ? 'grab' : ['pen', 'pencil', 'rect', 'ellipse', 'polygon', 'star', 'line'].includes(t) ? 'crosshair' : t === 'text' ? 'text' : 'default';
  buildPanel(); renderOverlay();
}
function buildRail() {
  clear(railEl);
  for (const t of TOOLS) {
    if (t === '-') { railEl.append(h('div', { class: 'rail-sep' })); continue; }
    const b = h('button', { class: 'tool', type: 'button', title: t.label, 'aria-label': t.label, 'aria-pressed': String(tool === t.id), html: icon(t.icon) + `<span class="key">${t.key.toUpperCase()}</span>`, onclick: () => setTool(t.id) });
    toolBtns[t.id] = b; railEl.append(b);
  }
}

// ---------- inspector panel ----------
function fillEditor(it) {
  const isGrad = it.fill && typeof it.fill === 'object';
  const wrap = h('div', { class: 'fields' });
  wrap.append(h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, 'Fill type'), segmented({ value: it.fill == null ? 'none' : isGrad ? 'linear' : 'solid', options: [{ value: 'none', label: 'None' }, { value: 'solid', label: 'Solid' }, { value: 'linear', label: 'Gradient' }],
    onChange: (v) => setProps(v === 'none' ? { fill: null } : v === 'solid' ? { fill: isGrad ? it.fill.stops[0].c : (it.fill || style.fill) } : { fill: { type: 'linear', angle: 0, stops: [{ o: 0, c: typeof it.fill === 'string' ? it.fill : style.fill }, { o: 1, c: '#2d5b8a' }] } }, 'Fill type', true) })));
  if (isGrad) {
    wrap.append(colorField({ label: 'From', value: it.fill.stops[0].c, onChange: c => setProps({ fill: { ...it.fill, stops: [{ o: 0, c }, it.fill.stops[1]] } }, 'Gradient') }),
      colorField({ label: 'To', value: it.fill.stops[1].c, onChange: c => setProps({ fill: { ...it.fill, stops: [it.fill.stops[0], { o: 1, c }] } }, 'Gradient') }),
      numField({ label: 'Angle', unit: '°', value: it.fill.angle || 0, step: 5, onChange: v => setProps({ fill: { ...it.fill, angle: v } }, 'Gradient') }));
  } else if (it.fill != null) wrap.append(colorField({ label: 'Fill', value: it.fill, onInput: c => setProps({ fill: c }, 'Fill', false, true), onChange: c => setProps({ fill: c }, 'Fill') }));
  return wrap;
}
function setProps(p, label = 'Edit', rebuild = false, live = false) {
  const list = items().filter(i => sel.has(i.id));
  if (!live) S.checkpoint(label);
  for (const it of list) Object.assign(it, clone(p));
  if (typeof p.fill === 'string') style.fill = p.fill; if (p.stroke) style.stroke = p.stroke; if (p.sw != null) style.sw = p.sw;
  S.changed('vector', { live });
  if (rebuild) buildPanel();
}
function buildPanel() {
  if (!panelEl) return;
  clear(panelEl);
  const list = items().filter(i => sel.has(i.id));
  // Tool options
  if (['rect', 'polygon', 'star'].includes(tool)) {
    panelEl.append(pane('Tool options', h('div', { class: 'fields' },
      tool === 'rect' ? numField({ label: 'Corner radius', unit: 'px', value: opts.radius, min: 0, onChange: v => opts.radius = v }) : null,
      tool === 'polygon' ? numField({ label: 'Sides', value: opts.sides, min: 3, max: 64, decimals: 0, onChange: v => opts.sides = Math.round(v) }) : null,
      tool === 'star' ? numField({ label: 'Points', value: opts.points, min: 3, max: 64, decimals: 0, onChange: v => opts.points = Math.round(v) }) : null,
      tool === 'star' ? numField({ label: 'Inner ratio', value: opts.inner, min: 0.05, max: 0.95, step: 0.05, onChange: v => opts.inner = v }) : null)));
  }
  if (tool === 'pen') panelEl.append(pane('Pen', h('p', { class: 'hint' }, 'Click to place corners, drag to pull curves, click the first point to close. Enter or Esc finishes an open path. Shift locks to 45°.')));
  if (tool === 'direct') panelEl.append(pane('Direct select', h('p', { class: 'hint' }, 'Drag anchors and handles. Double-click a segment to add an anchor; Alt-click an anchor to switch corner/smooth; Alt-drag a handle to break it; Delete removes selected anchors.')));

  if (list.length) {
    const it = list[0], b = selBounds();
    const geo = h('div', { class: 'fields' },
      numField({ label: 'X', unit: 'px', value: b.x, onChange: v => moveSelTo(v, null) }),
      numField({ label: 'Y', unit: 'px', value: b.y, onChange: v => moveSelTo(null, v) }),
      numField({ label: 'W', unit: 'px', value: b.w, min: 0.01, onChange: v => resizeSel(v, null) }),
      numField({ label: 'H', unit: 'px', value: b.h, min: 0.01, onChange: v => resizeSel(null, v) }),
      numField({ label: 'Rotate by', unit: '°', value: 0, step: 15, onChange: v => { if (v) { const bb = selBounds(); mutate('Rotate', () => list.forEach(i => transformItem(i, G.rot(v * Math.PI / 180, bb.x + bb.w / 2, bb.y + bb.h / 2)))); buildPanel(); } } }),
      list.length === 1 ? textField({ label: 'Name', value: it.name || '', span: 1, onChange: v => setProps({ name: v }, 'Rename') }) : h('div'));
    panelEl.append(pane(list.length > 1 ? `${list.length} objects` : (it.type === 'text' ? 'Text' : it.type === 'image' ? 'Image' : 'Path'), geo));

    if (it.type !== 'image') {
      const ap = pane('Appearance', fillEditor(it), h('div', { class: 'fields' },
        colorField({ label: 'Stroke', value: it.stroke, allowNone: true, onInput: c => setProps({ stroke: c }, 'Stroke', false, true), onChange: c => setProps({ stroke: c, sw: c && !it.sw ? 1 : it.sw }, 'Stroke') }),
        numField({ label: 'Stroke width', unit: 'px', value: it.sw || 0, min: 0, step: 0.5, onChange: v => setProps({ sw: v }, 'Stroke width') }),
        selectField({ label: 'Cap', value: it.cap || 'butt', options: ['butt', 'round', 'square'], onChange: v => setProps({ cap: v }, 'Cap') }),
        selectField({ label: 'Join', value: it.join || 'miter', options: ['miter', 'round', 'bevel'], onChange: v => setProps({ join: v }, 'Join') }),
        textField({ label: 'Dash pattern', value: it.dash || '', placeholder: 'e.g. 6 4', span: 1, onChange: v => setProps({ dash: v.trim() || null }, 'Dash') }),
        numField({ label: 'Opacity', unit: '%', value: Math.round((it.opacity ?? 1) * 100), min: 0, max: 100, decimals: 0, onChange: v => setProps({ opacity: v / 100 }, 'Opacity') }),
        selectField({ label: 'Blend', value: it.blend || 'normal', options: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'color-burn'], onChange: v => setProps({ blend: v }, 'Blend'), span: 2 })));
      panelEl.append(ap);
    } else {
      panelEl.append(pane('Image', h('div', { class: 'fields' }, numField({ label: 'Opacity', unit: '%', value: Math.round((it.opacity ?? 1) * 100), min: 0, max: 100, decimals: 0, onChange: v => setProps({ opacity: v / 100 }, 'Opacity') }))));
    }
    if (it.type === 'text' && list.length === 1) {
      panelEl.append(pane('Type', h('div', { class: 'fields' },
        h('div', { class: 'field span3' }, h('label', { for: 'vec-text' }, 'Text'), (() => { const ta = h('textarea', { id: 'vec-text', rows: 3 }); ta.value = it.text; ta.addEventListener('change', () => setProps({ text: ta.value }, 'Edit text')); return ta; })()),
        selectField({ label: 'Font', value: it.font, options: allFonts(), onChange: v => setProps({ font: v }, 'Font'), span: 2 }),
        numField({ label: 'Size', unit: 'px', value: it.size, min: 1, onChange: v => setProps({ size: v }, 'Font size') }),
        numField({ label: 'Weight', value: it.weight || 400, min: 100, max: 900, step: 100, decimals: 0, onChange: v => setProps({ weight: v }, 'Weight') }),
        numField({ label: 'Tracking', unit: 'em', value: it.ls || 0, step: 0.01, onChange: v => setProps({ ls: v }, 'Tracking') }),
        numField({ label: 'Line height', unit: 'px', value: it.lh || it.size * 1.2, min: 1, onChange: v => setProps({ lh: v }, 'Leading') }),
        h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, 'Align'), segmented({ value: it.align || 'start', options: [{ value: 'start', label: 'Left' }, { value: 'middle', label: 'Centre' }, { value: 'end', label: 'Right' }], onChange: v => setProps({ align: v }, 'Align') })),
        checkField({ label: 'Italic', value: it.italic, onChange: v => setProps({ italic: v }, 'Italic') }))));
    }
    panelEl.append(pane('Align & distribute', h('div', { class: 'btn-row' },
      ...[['l', 'alignL', 'Align left'], ['ch', 'alignCH', 'Align centres horizontally'], ['r', 'alignR', 'Align right'], ['t', 'alignT', 'Align top'], ['cv', 'alignCV', 'Align centres vertically'], ['b', 'alignB', 'Align bottom']].map(([k, ic, t]) => iconBtn(ic, t + (list.length === 1 ? ' (to artboard)' : ''), () => align(k))),
      iconBtn('distH', 'Distribute horizontally', () => distribute('h')), iconBtn('distV', 'Distribute vertically', () => distribute('v')))));
    const pathCount = list.filter(i => i.type === 'path').length;
    if (pathCount) panelEl.append(pane('Path tools', h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => offsetDialog() }, 'Offset path…'),
      h('button', { class: 'btn small', type: 'button', onclick: () => outlineStroke(), disabled: !list.some(i => i.type === 'path' && i.stroke && i.sw > 0) }, 'Outline stroke')),
      h('p', { class: 'hint' }, 'Offset grows or shrinks a shape by a distance (negative = inset). Outline stroke turns a stroke into a filled shape, ready for cutting.')));
    if (list.length === 1 && it.type === 'image') panelEl.append(pane('Image trace', h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => traceDialog(it) }, h('span', { html: icon('wand', 14) }), 'Trace to vector…')),
      h('p', { class: 'hint' }, 'Turns the bitmap into editable filled paths, in black and white or posterised colour.')));
    if (pathCount >= 2) panelEl.append(pane('Pathfinder', h('div', { class: 'btn-row' },
      iconBtn('boolU', 'Unite', () => pathfinder('unite')), iconBtn('boolS', 'Minus front (back shape minus the others)', () => pathfinder('subtract')),
      iconBtn('boolI', 'Intersect', () => pathfinder('intersect')), iconBtn('boolX', 'Exclude overlap', () => pathfinder('exclude'))),
      h('p', { class: 'hint' }, 'Curves stay curves: booleans run on true Béziers, not on flattened polygons.')));
    panelEl.append(pane('Arrange & repeat', h('div', { class: 'btn-grid' },
      h('button', { class: 'btn small', type: 'button', onclick: () => arrange('front') }, 'To front'), h('button', { class: 'btn small', type: 'button', onclick: () => arrange('forward') }, 'Forward'),
      h('button', { class: 'btn small', type: 'button', onclick: () => arrange('backward') }, 'Backward'), h('button', { class: 'btn small', type: 'button', onclick: () => arrange('back') }, 'To back'),
      h('button', { class: 'btn small', type: 'button', onclick: () => flip('h') }, 'Flip H'), h('button', { class: 'btn small', type: 'button', onclick: () => flip('v') }, 'Flip V'),
      h('button', { class: 'btn small', type: 'button', onclick: () => repeatDialog('radial') }, 'Radial'), h('button', { class: 'btn small', type: 'button', onclick: () => repeatDialog('grid') }, 'Grid'),
      h('button', { class: 'btn small', type: 'button', onclick: () => duplicate() }, 'Duplicate'), h('button', { class: 'btn small danger', type: 'button', onclick: deleteSelection }, 'Delete'))));
    if (list.length === 1 && it.type === 'path') panelEl.append(pane('Send to', h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { ctx.ws.mesh.extrudeFromVector?.(it.id); ctx.activate('mesh'); } }, h('span', { html: icon('extrude', 14) }), 'Extrude in 3D'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { ctx.ws.cad.profileFromVector?.(it.id); ctx.activate('cad'); } }, h('span', { html: icon('cube', 14) }), 'CAD profile'))));
  } else {
    const ab = V().artboards.find(a => a.id === activeAb) || V().artboards[0];
    if (ab) {
      const setAb = (p, label) => { S.checkpoint(label); Object.assign(ab, p); S.changed('vector'); };
      panelEl.append(pane('Artboard', h('div', { class: 'fields' },
        textField({ label: 'Name', value: ab.name, span: 2, onChange: v => setAb({ name: v }, 'Rename artboard') }),
        numField({ label: 'X', unit: 'px', value: ab.x, onChange: v => setAb({ x: v }, 'Move artboard') }), numField({ label: 'Y', unit: 'px', value: ab.y, onChange: v => setAb({ y: v }, 'Move artboard') }),
        numField({ label: 'Width', unit: 'px', value: ab.w, min: 1, onChange: v => setAb({ w: v }, 'Resize artboard') }), numField({ label: 'Height', unit: 'px', value: ab.h, min: 1, onChange: v => setAb({ h: v }, 'Resize artboard') }),
        colorField({ label: 'Background', value: ab.bg, allowNone: true, onChange: v => setAb({ bg: v }, 'Artboard colour'), span: 2 })),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', type: 'button', onclick: addArtboard }, h('span', { html: icon('plus', 14) }), 'Add'),
          h('button', { class: 'btn small', type: 'button', onclick: () => fitView(ab) }, 'Zoom to'),
          V().artboards.length > 1 ? h('button', { class: 'btn small danger', type: 'button', onclick: () => { S.checkpoint('Delete artboard'); V().artboards = V().artboards.filter(a => a !== ab); activeAb = null; S.changed('vector'); buildPanel(); } }, 'Delete') : null)));
      panelEl.append(pane('Artboards', h('div', { class: 'list' }, V().artboards.map(a => h('div', { class: 'li', 'aria-selected': String(a === ab), onclick: () => { activeAb = a.id; fitView(a); buildPanel(); } },
        h('span', { class: 'sw', style: { background: a.bg || 'transparent' } }), h('span', { class: 'name' }, a.name), h('span', { class: 'meta' }, `${round(a.w, 0)}×${round(a.h, 0)}`))))));
    }
    panelEl.append(pane('New shape style', h('div', { class: 'fields' },
      colorField({ label: 'Fill', value: style.fill, allowNone: true, onChange: v => style.fill = v }), colorField({ label: 'Stroke', value: style.stroke, allowNone: true, onChange: v => style.stroke = v }),
      numField({ label: 'Stroke width', unit: 'px', value: style.sw, min: 0, step: 0.5, onChange: v => style.sw = v })),
      h('div', { class: 'fields' }, checkField({ label: 'Smart guides', value: opts.smart, onChange: v => opts.smart = v }), checkField({ label: 'Snap to grid', value: opts.snapGrid, onChange: v => { opts.snapGrid = v; render(); } }))));
  }
  panelEl.append(layersPane());
}
function moveSelTo(x, y) { const b = selBounds(); mutate('Move', () => items().filter(i => sel.has(i.id)).forEach(it => transformItem(it, G.tr(x == null ? 0 : x - b.x, y == null ? 0 : y - b.y)))); buildPanel(); }
function resizeSel(w, hh) { const b = selBounds(); const sx = w == null ? 1 : w / (b.w || 1), sy = hh == null ? 1 : hh / (b.h || 1); mutate('Resize', () => items().filter(i => sel.has(i.id)).forEach(it => transformItem(it, G.sc(sx, sy, b.x, b.y)))); buildPanel(); }
function addArtboard() {
  S.checkpoint('Add artboard');
  const abs = V().artboards; const last = abs[abs.length - 1] || { x: 0, y: 0, w: 800, h: 600 };
  const ab = { id: uid('ab'), name: 'Artboard ' + (abs.length + 1), x: last.x + last.w + 80, y: last.y, w: last.w, h: last.h, bg: '#ffffff' };
  abs.push(ab); activeAb = ab.id; S.changed('vector'); fitView(ab); buildPanel();
}
function layersPane() {
  const list = h('div', { class: 'list tall' });
  const arr = [...items()].reverse();
  if (!arr.length) list.append(h('div', { class: 'li' }, h('span'), h('span', { class: 'name', style: { color: 'var(--muted)' } }, 'No objects yet. Pick a tool and draw.'), h('span')));
  for (const it of arr) {
    const sw = typeof it.fill === 'string' ? it.fill : it.fill ? it.fill.stops[0].c : it.stroke || 'transparent';
    list.append(h('div', { class: 'li' + (it.hidden ? ' dim' : ''), 'aria-selected': String(sel.has(it.id)), onclick: (e) => { if (it.locked) return; select([it.id], e.shiftKey); } },
      h('span', { class: 'sw', style: { background: sw } }), h('span', { class: 'name' }, it.name || it.type),
      h('span', { class: 'acts' },
        h('button', { type: 'button', title: it.hidden ? 'Show' : 'Hide', 'aria-label': it.hidden ? 'Show' : 'Hide', html: icon(it.hidden ? 'eyeOff' : 'eye', 15), onclick: (e) => { e.stopPropagation(); mutate('Visibility', () => { it.hidden = !it.hidden; if (it.hidden) sel.delete(it.id); }); buildPanel(); } }),
        h('button', { type: 'button', title: it.locked ? 'Unlock' : 'Lock', 'aria-label': it.locked ? 'Unlock' : 'Lock', html: icon(it.locked ? 'lock' : 'unlock', 15), onclick: (e) => { e.stopPropagation(); mutate('Lock', () => { it.locked = !it.locked; if (it.locked) sel.delete(it.id); }); buildPanel(); } }))));
  }
  return pane('Layers', list);
}

// ---------- path tools (paperjs-offset, MIT) ----------
function offsetSubpaths(subpaths, dist, join) {
  const p = toPaper(subpaths);
  const res = PaperOffset.offset(p, dist, { join, limit: 10, insert: false });
  return res ? fromPaper(res) : [];
}
async function offsetDialog() {
  const list = items().filter(i => sel.has(i.id) && i.type === 'path'); if (!list.length) return;
  const o = { d: 6, join: 'round', keep: true };
  const ok = await dialog({ title: 'Offset path', body: (el) => el.append(h('div', { class: 'fields' },
    numField({ label: 'Distance', unit: 'px', value: o.d, step: 1, onChange: v => o.d = v }),
    selectField({ label: 'Corners', value: o.join, options: [['round', 'Round'], ['miter', 'Mitre'], ['bevel', 'Bevel']], onChange: v => o.join = v }),
    checkField({ label: 'Keep the original', value: o.keep, onChange: v => o.keep = v })),
    h('p', { class: 'hint' }, `Positive grows the shape, negative insets it. 1 px = 1 pt = ${round(MM_PER_PX, 4)} mm.`)),
    actions: [{ label: 'Cancel', value: false }, { label: 'Offset', primary: true, value: true }] });
  if (!ok || !o.d) return;
  let made = 0;
  mutate('Offset path', () => {
    const newSel = [];
    for (const it of list) {
      let subs; try { subs = offsetSubpaths(it.subpaths, o.d, o.join); } catch (e) { console.warn(e); continue; }
      if (!subs.length) continue; made++;
      if (o.keep) { const c = { ...clone(it), id: uid('v'), name: (it.name || 'Path') + ' offset', subpaths: subs, rule: 'nonzero' }; items().splice(items().indexOf(it) + 1, 0, c); newSel.push(c.id); }
      else { it.subpaths = subs; newSel.push(it.id); }
    }
    sel.clear(); newSel.forEach(id => sel.add(id));
  });
  toast(made ? `Offset ${made} path${made > 1 ? 's' : ''} by ${o.d} px` : 'Nothing to offset (the inset may have collapsed the shape)', made ? '' : 'bad');
  buildPanel();
}
function outlineStroke() {
  const list = items().filter(i => sel.has(i.id) && i.type === 'path' && i.stroke && i.sw > 0); if (!list.length) { toast('Select a path with a stroke'); return; }
  mutate('Outline stroke', () => {
    for (const it of list) {
      const p = toPaper(it.subpaths);
      const res = PaperOffset.offsetStroke(p, it.sw / 2, { cap: it.cap === 'round' ? 'round' : 'butt', join: it.join || 'miter', limit: 10, insert: false });
      const subs = res ? fromPaper(res) : []; if (!subs.length) continue;
      Object.assign(it, { subpaths: subs, fill: it.stroke, stroke: null, sw: 0, rule: 'nonzero', dash: null });
    }
  });
  toast('Stroke outlined into a filled shape'); buildPanel();
}
// ---------- image trace (imagetracerjs, public domain) ----------
async function traceDialog(it) {
  const a = S.store.doc.assets[it.asset]; if (!a) return;
  const o = { preset: 'bw', detail: 60, threshold: 128, dropWhite: true, hide: true };
  const ok = await dialog({ title: 'Trace image to vector', body: (el) => el.append(h('div', { class: 'fields' },
    selectField({ label: 'Mode', value: o.preset, span: 2, options: Object.entries(TRACE_PRESETS).map(([k, v]) => [k, v.label]), onChange: v => o.preset = v }),
    numField({ label: 'Detail', unit: '%', value: o.detail, min: 0, max: 100, decimals: 0, onChange: v => o.detail = v }),
    numField({ label: 'B&W threshold', value: o.threshold, min: 1, max: 254, decimals: 0, onChange: v => o.threshold = v }),
    checkField({ label: 'Drop white background', value: o.dropWhite, onChange: v => o.dropWhite = v }),
    checkField({ label: 'Hide the image after', value: o.hide, onChange: v => o.hide = v })),
    h('p', { class: 'hint' }, 'Higher detail follows the pixels more closely; lower detail gives smoother, lighter paths.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Trace', primary: true, value: true }] });
  if (!ok) return;
  toast('Tracing…');
  await new Promise(r => setTimeout(r, 30));
  let res; try { res = traceImage(await loadImage(a.data), { preset: o.preset, detail: o.detail / 100, threshold: o.threshold, dropWhite: o.dropWhite }); }
  catch (e) { console.error(e); toast('Trace failed: ' + e.message, 'bad'); return; }
  if (!res.items.length) { toast('Nothing to trace at this threshold', 'bad'); return; }
  const m = G.mul(it.m || G.I(), G.mul(G.tr(it.x, it.y), [it.w / res.width, 0, 0, it.h / res.height, 0, 0]));
  mutate('Trace image', () => {
    const at = items().indexOf(it) + 1; const made = res.items.map((p, i) => ({ id: uid('v'), type: 'path', name: `Trace ${i + 1}`, ...p }));
    for (const p of made) G.transformSubpaths(p.subpaths, m);
    items().splice(at, 0, ...made); if (o.hide) { it.hidden = true; }
    sel.clear(); made.forEach(p => sel.add(p.id));
  });
  toast(`Traced into ${res.items.length} path${res.items.length > 1 ? 's' : ''}`); buildPanel();
}
// ---------- DXF for laser / CNC (dxf-parser + @tarikjabiri/dxf, MIT) ----------
async function exportDXF() {
  const ab = currentArtboard();
  const o = { units: 'mm', curves: 'polyline', scope: sel.size ? 'selection' : 'artboard' };
  const ok = await dialog({ title: 'Export DXF', body: (el) => el.append(h('div', { class: 'fields' },
    selectField({ label: 'Units', value: o.units, options: [['mm', 'Millimetres (1 px = 1 pt)'], ['in', 'Inches (72 px = 1 in)'], ['px', 'Unitless (1 px = 1 unit)']], onChange: v => o.units = v, span: 2 }),
    selectField({ label: 'Curves', value: o.curves, options: [['polyline', 'Polylines (most compatible)'], ['spline', 'Splines (exact curves)']], onChange: v => o.curves = v, span: 2 }),
    selectField({ label: 'Export', value: o.scope, options: [['artboard', `Artboard “${ab?.name || ''}”`], ['selection', 'Selection only']], onChange: v => o.scope = v, span: 2 })),
    h('p', { class: 'hint' }, 'Paths only; text and images are left out. Each colour gets its own layer, so laser software can map colours to cut, score and engrave.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Export', primary: true, value: true }] });
  if (!ok) return;
  const inAb = (it) => { if (!ab) return true; const b = itemBounds(it); return b.x < ab.x + ab.w && b.x + b.w > ab.x && b.y < ab.y + ab.h && b.y + b.h > ab.y; };
  const list = o.scope === 'selection' ? items().filter(i => sel.has(i.id)) : items().filter(inAb);
  const res = dxfFromItems(list, { units: o.units, curves: o.curves, origin: ab ? { x: ab.x, y: ab.y, h: ab.h } : null });
  if (!res.written) { toast('No paths to export', 'bad'); return; }
  await saveFile(safeName(S.store.doc.name + '-' + (ab?.name || 'vector')) + '.dxf', res.text, 'application/dxf');
  if (res.skipped) toast(`${res.skipped} text/image object${res.skipped > 1 ? 's' : ''} left out of the DXF`);
}
function importDXF(text) {
  let res; try { res = itemsFromDXF(text); } catch (e) { toast("Couldn't read that DXF: " + e.message, 'bad'); return; }
  if (!res.items.length) { toast('No supported geometry in that DXF', 'bad'); return; }
  const its = res.items.map((p, i) => ({ id: uid('v'), type: 'path', name: (p.layer || 'DXF') + ' ' + (i + 1), subpaths: p.subpaths, fill: null, stroke: '#1c1a17', sw: 1 }));
  const b = G.unionBounds(its.map(itemBounds)); const ab = currentArtboard(); const c = ab ? [ab.x + ab.w / 2, ab.y + ab.h / 2] : [0, 0];
  mutate('Import DXF', () => { for (const it of its) { transformItem(it, G.tr(c[0] - b.x - b.w / 2, c[1] - b.y - b.h / 2)); items().push(it); } sel.clear(); its.forEach(i => sel.add(i.id)); });
  buildPanel(); fitView(G.unionBounds(its.map(itemBounds)));
  toast(`Imported ${its.length} shapes at true scale (${round(b.w * MM_PER_PX, 1)} × ${round(b.h * MM_PER_PX, 1)} mm)` + (res.stats.skipped ? ` · ${res.stats.skipped} unsupported entities skipped` : ''));
}

// ---------- import / export ----------
async function importSVG(text) {
  let parsed; try { parsed = G.svgToSubpathItems(text); } catch (e) { toast("Couldn't read that SVG: " + e.message, 'bad'); return; }
  if (!parsed.length) { toast('No shapes found in that SVG', 'bad'); return; }
  const its = parsed.map((p, i) => ({ id: uid('v'), type: 'path', name: 'Imported ' + (i + 1), ...p }));
  const b = G.unionBounds(its.map(itemBounds)); const ab = currentArtboard(); const c = ab ? [ab.x + ab.w / 2, ab.y + ab.h / 2] : [0, 0];
  mutate('Import SVG', () => { for (const it of its) { transformItem(it, G.tr(c[0] - b.x - b.w / 2, c[1] - b.y - b.h / 2)); items().push(it); } sel.clear(); its.forEach(i => sel.add(i.id)); });
  buildPanel(); toast(`Imported ${its.length} shapes`);
}
async function placeImage(file) {
  const data = await readAsDataURL(file); const img = await loadImage(data);
  const asset = S.addAsset({ kind: 'image', name: file.name, mime: file.type, data, w: img.naturalWidth, h: img.naturalHeight });
  const ab = currentArtboard(); const s = Math.min(1, (ab.w * 0.8) / img.naturalWidth, (ab.h * 0.8) / img.naturalHeight);
  const w = img.naturalWidth * s, hh = img.naturalHeight * s;
  mutate('Place image', () => { const it = { id: uid('v'), type: 'image', name: file.name, asset, x: ab.x + (ab.w - w) / 2, y: ab.y + (ab.h - hh) / 2, w, h: hh }; items().push(it); sel.clear(); sel.add(it.id); });
  buildPanel();
}
async function exportArtboard(fmt) {
  const ab = currentArtboard(); if (!ab) return;
  const svgText = artboardSVG(ab.id);
  const base = safeName(S.store.doc.name + '-' + ab.name);
  if (fmt === 'svg') return saveFile(base + '.svg', svgText, 'image/svg+xml');
  if (fmt === 'png') {
    const scale = 2; const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText));
    const c = document.createElement('canvas'); c.width = Math.round(ab.w * scale); c.height = Math.round(ab.h * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return saveFile(base + '@2x.png', blob, 'image/png');
  }
  if (fmt === 'pdf') {
    const { pdfFromVectorArtboard } = await import('../core/pdf.js');
    const bytes = await pdfFromVectorArtboard(ab, items(), S.store.doc.assets);
    return saveFile(base + '.pdf', new Blob([bytes], { type: 'application/pdf' }), 'application/pdf');
  }
}
function copySel(cut = false) {
  if (!sel.size) return;
  clipboard = items().filter(i => sel.has(i.id)).map(clone);
  try {
    const b = selBounds(); const svgText = `<svg xmlns="${NS}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${b.w}" height="${b.h}"><defs>${defsFor(clipboard)}</defs>${clipboard.map(i => itemSVG(i)).join('')}</svg>`;
    navigator.clipboard?.writeText(svgText).catch(() => {});
  } catch { /* clipboard is optional */ }
  if (cut) deleteSelection();
  toast(cut ? 'Cut' : 'Copied — paste here, or into any app that takes SVG');
}
function pasteInternal() {
  if (!clipboard) return;
  mutate('Paste', () => { sel.clear(); for (const o of clipboard) { const c = clone(o); c.id = uid('v'); transformItem(c, G.tr(12, 12)); items().push(c); sel.add(c.id); } clipboard = clipboard.map(o => { const c = clone(o); transformItem(c, G.tr(12, 12)); return c; }); });
  buildPanel();
}
function onPaste(e) {
  if (ctx.active !== 'vector' || e.target.closest?.('input,textarea')) return;
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); placeImage(file); return; }
  const text = e.clipboardData?.getData('text/plain') || '';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) { e.preventDefault(); importSVG(text); return; }
  if (clipboard) { e.preventDefault(); pasteInternal(); }
}

// ---------- workspace interface ----------
export default {
  id: 'vector', label: 'Vector',
  extrasForOthers: { artboardSVG, listArtboards, listShapes, getItem, itemBounds },
  artboardSVG, listArtboards, listShapes, getItem,
  register(c) {
    const r = (id, label, run, keys, tags) => registerCommand({ id: 'vector.' + id, label, run: () => { c.activate('vector'); run(); }, keys, tags, ws: 'vector' });
    r('svg', 'Export artboard as SVG', () => exportArtboard('svg'), null, 'save download');
    r('png', 'Export artboard as PNG (2×)', () => exportArtboard('png'), null, 'save image raster');
    r('pdf', 'Export artboard as PDF', () => exportArtboard('pdf'), null, 'save print vector');
    r('import', 'Import SVG…', async () => { const f = await pickFile('.svg,image/svg+xml'); if (f) importSVG(await readAsText(f)); }, null, 'open load');
    r('place', 'Place image…', async () => { const f = await pickFile('image/*'); if (f) placeImage(f); }, null, 'photo png jpg');
    r('unite', 'Pathfinder: unite', () => pathfinder('unite'), null, 'boolean union merge');
    r('subtract', 'Pathfinder: minus front', () => pathfinder('subtract'), null, 'boolean difference cut');
    r('intersect', 'Pathfinder: intersect', () => pathfinder('intersect'), null, 'boolean');
    r('exclude', 'Pathfinder: exclude', () => pathfinder('exclude'), null, 'boolean xor');
    r('radial', 'Radial repeat…', () => repeatDialog('radial'), null, 'array circle');
    r('grid', 'Grid repeat…', () => repeatDialog('grid'), null, 'array tile');
    r('offset', 'Offset path…', offsetDialog, null, 'inset outset grow shrink contour');
    r('outline', 'Outline stroke', outlineStroke, null, 'expand stroke to fill');
    r('trace', 'Image trace (bitmap to vector)…', () => { const it = items().find(i => sel.has(i.id) && i.type === 'image'); if (it) traceDialog(it); else toast('Select an image first'); }, null, 'vectorize autotrace potrace');
    r('dxf', 'Export as DXF (laser / CNC)…', exportDXF, null, 'cad cut cnc laser autocad');
    r('dxfin', 'Import DXF…', async () => { const f = await pickFile('.dxf'); if (f) importDXF(await readAsText(f)); }, null, 'cad autocad open');
    r('artboard', 'Add artboard', addArtboard, null, 'canvas page');
    r('fit', 'Fit all artboards in view', () => fitView(), null, 'zoom');
  },
  init(c, m) {
    ctx = c; S = c.S; root = m.root; railEl = m.rail; panelEl = m.panel;
    svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'vec-svg'); svg.setAttribute('role', 'application'); svg.setAttribute('aria-label', 'Vector canvas');
    defs = document.createElementNS(NS, 'defs'); gAb = document.createElementNS(NS, 'g'); gArt = document.createElementNS(NS, 'g'); gOv = document.createElementNS(NS, 'g');
    svg.append(defs, gAb, gArt, gOv); root.append(svg);
    zoomLabel = h('span', null, '100%');
    root.append(h('div', { class: 'zoom-chip' }, h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAt(view.k / 1.25) }, '−'), zoomLabel,
      h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAt(view.k * 1.25) }, '+'), h('button', { type: 'button', title: 'Fit', 'aria-label': 'Fit artboards', onclick: () => fitView() }, '⤢')));
    svg.addEventListener('pointerdown', onDown); svg.addEventListener('pointermove', onMove); svg.addEventListener('pointerup', onUp); svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('dblclick', onDbl); svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('pointerleave', () => { hoverWorld = null; if (pen) renderOverlay(); });
    document.addEventListener('paste', onPaste);
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; if (svg) svg.style.cursor = tool === 'hand' ? 'grab' : ''; } });
    new ResizeObserver(() => { if (!fitted) fitted = fitView(); else render(); }).observe(root);
    root.addEventListener('dragover', (e) => e.preventDefault());
    root.addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) { if (/\.dxf$/i.test(f.name)) importDXF(await readAsText(f)); else if (f.type === 'image/svg+xml' || f.name.endsWith('.svg')) importSVG(await readAsText(f)); else if (f.type.startsWith('image/')) placeImage(f); } });
    buildRail(); setTool('select'); buildPanel();
  },
  show() { requestAnimationFrame(() => { if (!fitted) fitted = fitView(); else render(); }); },
  hide() { if (pen) finishPen(); commitInline(); },
  onDoc() { sel.clear(); anchorsSel = []; pen = null; fitted = false; activeAb = null; if (!root.hidden) fitted = fitView(); else render(); buildPanel(); },
  onChange(e) { if (e.ws === 'vector' || !e.ws) { render(); if (!e.live) buildPanelSoon(); } },
  status() { return 'Vector'; },
  fileMenu() {
    return [
      { label: 'Import SVG…', icon: 'upload', run: async () => { const f = await pickFile('.svg,image/svg+xml'); if (f) importSVG(await readAsText(f)); } },
      { label: 'Place image…', icon: 'image', run: async () => { const f = await pickFile('image/*'); if (f) placeImage(f); } },
      { label: 'Export artboard as SVG', icon: 'download', run: () => exportArtboard('svg') },
      { label: 'Export artboard as PNG (2×)', icon: 'download', run: () => exportArtboard('png') },
      { label: 'Export artboard as PDF', icon: 'download', run: () => exportArtboard('pdf') },
      { label: 'Import DXF…', icon: 'upload', run: async () => { const f = await pickFile('.dxf'); if (f) importDXF(await readAsText(f)); } },
      { label: 'Export DXF (laser / CNC)…', icon: 'download', run: exportDXF },
    ];
  },
  onKey(e) {
    const mod = e.metaKey || e.ctrlKey, k = e.key;
    if (k === ' ' || e.code === 'Space') { if (!spaceDown) { spaceDown = true; svg.style.cursor = 'grab'; } e.preventDefault(); return true; }
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return true; }
    if (mod && k.toLowerCase() === 'c') { copySel(false); return true; }
    if (mod && k.toLowerCase() === 'x') { copySel(true); return true; }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); select(items().filter(i => !i.locked && !i.hidden).map(i => i.id)); return true; }
    if (mod && k === ']') { arrange(e.shiftKey ? 'front' : 'forward'); return true; }
    if (mod && k === '[') { arrange(e.shiftKey ? 'back' : 'backward'); return true; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(view.k * 1.25); return true; }
    if (mod && k === '-') { e.preventDefault(); zoomAt(view.k / 1.25); return true; }
    if (mod && k === '0') { e.preventDefault(); fitView(); return true; }
    if (mod) return false;
    if (k === 'Enter' || k === 'Escape') { if (pen) { finishPen(); return true; } if (k === 'Escape') { select([]); return true; } }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSelection(); return true; }
    if (k.startsWith('Arrow') && sel.size) {
      e.preventDefault(); const d = e.shiftKey ? 10 : 1; const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0;
      mutate('Nudge', () => items().filter(i => sel.has(i.id)).forEach(it => transformItem(it, G.tr(dx, dy)))); return true;
    }
    const t = TOOLS.find(x => x !== '-' && x.key === k.toLowerCase()); if (t) { setTool(t.id); return true; }
    return false;
  },
};
const buildPanelSoon = panelRebuilder(() => panelEl, () => buildPanel());
