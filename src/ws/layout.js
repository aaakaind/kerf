// LAYOUT workspace — pages & spreads, masters with live folios, threaded multi-column text frames with paragraph
// styles, image frames with effective-PPI preflight, live placements from Vector/Mesh/CAD, data merge, vector PDF.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { h, icon, pane, numField, colorField, selectField, textField, checkField, segmented, iconBtn, clear, uid, esc, toast, dialog,
  registerCommand, pickFile, readAsText, readAsDataURL, readAsArrayBuffer, loadImage, modKey, round, clamp, confirmDialog, menu } from '../core/ui.js';
import { panelRebuilder } from '../core/ui.js';
import * as G from '../core/geom.js';
import { saveFile, safeName, fetchBundled } from '../core/io.js';
import { allFonts, registerFontAssets, addFontFile, fallbackFor } from '../core/fonts.js';
import { hyphenateSync } from 'hyphen/en-us';
import * as PDF from '../core/pdf.js';

const TOOLS = [
  { id: 'select', icon: 'select', key: 'v', label: 'Select (V) — move & resize frames' },
  { id: 'text', icon: 'frameText', key: 't', label: 'Text frame (T)' },
  { id: 'image', icon: 'frameImg', key: 'f', label: 'Image frame (F)' },
  { id: 'rect', icon: 'rect', key: 'm', label: 'Rectangle (M)' },
  { id: 'ellipse', icon: 'ellipse', key: 'l', label: 'Ellipse (L)' },
  { id: 'line', icon: 'line', key: '\\', label: 'Line (\\)' },
  '-',
  { id: 'hand', icon: 'hand', key: 'h', label: 'Hand (H) — or hold Space' },
];
const PAGE_SIZES = { A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8], 'Half Letter': [139.7, 215.9], 'Square 200': [200, 200] };

let ctx, S, root, scroller, spreadsEl, measure, psStyle, railEl, panelEl;
let k = 1, tool = 'select', target = { kind: 'doc' }, threadFrom = null, spaceDown = false;
const sel = new Set();
let drag = null, fitted = false, vectorVersion = 0;
const flowCache = new Map();   // storyId -> flow
const elCache = new Map();     // `${pageId}:${frameId}` -> {el, key}
const L = () => S.store.doc.layout;
const unit = () => L().unit || 'mm';
const U = (pt) => G.toUnit(pt, unit());
const P = (v) => G.fromUnit(v, unit());

// ---------- model helpers ----------
function targetPages() {
  if (target.kind === 'master') { const m = L().masters.find(x => x.id === target.id); return m ? [{ page: m, idx: 0, master: true }] : []; }
  return L().pages.map((page, idx) => ({ page, idx }));
}
function findFrame(id) {
  for (const { page, idx, master } of targetPages()) { const f = page.items.find(i => i.id === id); if (f) return { frame: f, page, idx, master }; }
  return null;
}
function findFrameAnywhere(id) {
  for (const [idx, page] of L().pages.entries()) { const f = page.items.find(i => i.id === id); if (f) return { frame: f, page, idx }; }
  for (const m of L().masters) { const f = m.items.find(i => i.id === id); if (f) return { frame: f, page: m, idx: 0, master: true }; }
  return null;
}
const selFrames = () => [...sel].map(findFrame).filter(Boolean);
const isLeftPage = (idx) => L().facing && idx % 2 === 1;
function marginsFor(idx) {
  const m = L().page.margins; const left = isLeftPage(idx);
  return { t: m.t, b: m.b, l: left ? m.o : m.i, r: left ? m.i : m.o };
}
function spreads() {
  const pages = targetPages();
  if (target.kind === 'master' || !L().facing) return pages.map(p => [p]);
  const out = [[pages[0]]]; for (let i = 1; i < pages.length; i += 2) out.push(pages.slice(i, i + 2));
  return out.filter(s => s.length && s[0]);
}

// ---------- paragraph styles → CSS ----------
function styleCSS() {
  let css = '.story{position:relative}.story>p:first-child{margin-top:0!important}.story>p:last-child{margin-bottom:0!important}.story p{margin:0}';
  for (const [id, s] of Object.entries(L().styles)) {
    css += `.story .ps-${id}{font-family:"${s.font}",${fallbackFor(s.font)};font-size:${s.size}px;line-height:${s.leading}px;font-weight:${s.weight};font-style:${s.italic ? 'italic' : 'normal'};color:${s.color};text-align:${s.align};margin:${s.before}px 0 ${s.after}px;letter-spacing:${s.tracking || 0}em;hyphens:manual;-webkit-hyphens:manual;text-transform:${s.upper ? 'uppercase' : 'none'};text-indent:0;overflow-wrap:break-word}`;
    css += `.story .ps-${id}+.ps-${id}{text-indent:${s.indent || 0}px}.story .ps-${id}.cont{text-indent:0;margin-top:0}.story .ps-${id}.split{text-align-last:${s.align === 'justify' ? 'justify' : 'auto'}}`;
  }
  psStyle.textContent = css;
}
let styleVersion = 0;

// ---------- story parsing ----------
const MARK = [[/^##\s+/, 'h2'], [/^#\s+/, 'h1'], [/^>\s+/, 'quote'], [/^\^\s+/, 'caption']];
const parseCache = new Map();
export function parseStory(text) {
  const key = text + '\u0000' + styleVersion; const c = parseCache.get(key); if (c) return c;
  const paras = [], tokens = [];
  const styles = L().styles;
  String(text || '').split('\n').forEach((line, pi) => {
    let style = 'body', body = line;
    const custom = body.match(/^\[([\w-]+)\]\s?/);
    if (custom && styles[custom[1]]) { style = custom[1]; body = body.slice(custom[0].length); }
    else for (const [re, st] of MARK) if (re.test(body)) { style = st; body = body.replace(re, ''); break; }
    if (!styles[style]) style = 'body';
    paras.push({ style });
    // inline runs: **bold**, *italic*
    const runs = []; const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g; let last = 0, m;
    while ((m = re.exec(body))) { if (m.index > last) runs.push({ t: body.slice(last, m.index) }); runs.push(m[0].startsWith('**') ? { t: m[0].slice(2, -2), b: 1 } : { t: m[0].slice(1, -1), i: 1 }); last = m.index + m[0].length; }
    if (last < body.length) runs.push({ t: body.slice(last) });
    // Hyphenation: TeX US-English patterns (hyphen, ISC) insert soft hyphens, so every renderer breaks words the same way.
    if (styles[style].hyphenate) for (const r of runs) r.t = hyphenateSync(r.t, { hyphenChar: '\u00ad', minWordLength: 6 });
    let any = false;
    for (const r of runs) for (const w of r.t.match(/\S+\s*|\s+/g) || []) {
      let hh = esc(w); if (r.b) hh = `<b>${hh}</b>`; if (r.i) hh = `<i>${hh}</i>`;
      tokens.push({ p: pi, html: hh }); any = true;
    }
    if (!any) tokens.push({ p: pi, html: '​' });
  });
  const out = { paras, tokens };
  parseCache.set(key, out); if (parseCache.size > 400) parseCache.delete(parseCache.keys().next().value);
  return out;
}
function rangeHTML(parsed, a, b, pageNum = 1, pageCount = 1) {
  const { paras, tokens } = parsed; let out = '', curP = -1, buf = '';
  const flush = (endIdx) => {
    if (curP < 0) return;
    const st = paras[curP].style; const startsHere = tokens.findIndex(t => t.p === curP);
    const cont = startsHere < a; const split = endIdx < tokens.length && tokens[endIdx].p === curP;
    out += `<p class="ps-${st}${cont ? ' cont' : ''}${split ? ' split' : ''}">${buf.replace(/\{page\}/g, pageNum).replace(/\{pages\}/g, pageCount)}</p>`;
  };
  for (let i = a; i < b; i++) { const t = tokens[i]; if (t.p !== curP) { flush(i); curP = t.p; buf = ''; } buf += t.html; }
  flush(b);
  return out;
}
function colBoxes(f) {
  const inset = f.inset ?? 0, cols = Math.max(1, f.cols || 1), gut = f.gutter ?? 12;
  const w = (f.w - inset * 2 - gut * (cols - 1)) / cols, hh = f.h - inset * 2;
  return Array.from({ length: cols }, (_, i) => ({ x: inset + i * (w + gut), y: inset, w: Math.max(1, w), h: Math.max(1, hh) }));
}
function computeFlow(storyId) {
  const st = L().stories[storyId]; if (!st) return null;
  const frames = st.frames.map(id => findFrameAnywhere(id)?.frame).filter(Boolean);
  const key = st.text + '|' + styleVersion + '|' + frames.map(f => `${f.id}:${round(f.w, 2)}x${round(f.h, 2)}c${f.cols || 1}g${f.gutter ?? 12}i${f.inset ?? 0}`).join(',');
  const cached = flowCache.get(storyId); if (cached && cached.key === key) return cached;
  const parsed = parseStory(st.text); const N = parsed.tokens.length;
  const cols = new Map(); let a = 0;
  for (const f of frames) {
    const list = [];
    for (const box of colBoxes(f)) {
      if (a >= N) { list.push({ a: N, b: N }); continue; }
      measure.style.width = box.w + 'px';
      const fits = (b) => { measure.innerHTML = rangeHTML(parsed, a, b, 888, 888); return measure.offsetHeight <= box.h + 0.5; };
      let b;
      if (fits(N)) b = N;
      else if (!fits(a + 1)) b = a;
      else { let lo = a + 1, hi = N; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; } b = lo; }
      list.push({ a, b }); a = b;
    }
    cols.set(f.id, list);
  }
  const flow = { key, cols, overset: a < N, parsed, N, placed: a };
  flowCache.set(storyId, flow);
  return flow;
}
function computeAllFlows() { for (const id of Object.keys(L().stories)) computeFlow(id); }

// ---------- frame DOM ----------
function shapeSVG(f) {
  const sw = f.stroke ? (f.sw ?? 1) : 0, fill = f.fill || 'none', stroke = f.stroke || 'none';
  if (f.type === 'line') return `<svg width="${Math.max(1, Math.abs(f.w))}" height="${Math.max(1, Math.abs(f.h))}" style="position:absolute;inset:0;overflow:visible"><line x1="${f.flipX ? f.w : 0}" y1="0" x2="${f.flipX ? 0 : f.w}" y2="${f.h}" stroke="${esc(stroke === 'none' ? '#1c1a17' : stroke)}" stroke-width="${sw || 1}" ${f.dash ? `stroke-dasharray="${esc(f.dash)}"` : ''}/></svg>`;
  if (f.type === 'ellipse') return `<svg width="${f.w}" height="${f.h}" style="position:absolute;inset:0;overflow:visible"><ellipse cx="${f.w / 2}" cy="${f.h / 2}" rx="${Math.max(0, f.w / 2 - sw / 2)}" ry="${Math.max(0, f.h / 2 - sw / 2)}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"/></svg>`;
  return `<svg width="${f.w}" height="${f.h}" style="position:absolute;inset:0;overflow:visible"><rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, f.w - sw)}" height="${Math.max(0, f.h - sw)}" rx="${f.radius || 0}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}" ${f.dash ? `stroke-dasharray="${esc(f.dash)}"` : ''}/></svg>`;
}
function frameContentKey(f, pageNum, pageCount, exportMode) {
  const base = [f.type, f.w, f.h, f.fill, f.stroke, f.sw, f.radius, f.opacity, f.dash, exportMode ? 1 : 0].join('|');
  if (f.type === 'text') { const fl = f.story && flowCache.get(f.story); const cols = fl?.cols.get(f.id); return base + '|' + (fl?.key || '') + '|' + JSON.stringify(cols || []) + '|' + pageNum + '/' + pageCount + '|' + (f.valign || 'top'); }
  if (f.type === 'image') return base + '|' + f.asset + '|' + f.fit + '|' + f.fx + '|' + f.fy;
  if (f.type === 'vector') return base + '|' + JSON.stringify(f.src) + '|' + vectorVersion + '|' + f.fit;
  if (f.type === 'view' || f.type === 'drawing') return base + '|' + f.snap + '|' + f.fit;
  return base;
}
function buildFrameContent(el, f, pageNum, pageCount, exportMode) {
  el.innerHTML = '';
  el.className = 'frame ' + f.type;
  const bg = (f.fill || f.stroke) && !['rect', 'ellipse', 'line'].includes(f.type) ? shapeSVG({ ...f, type: 'rect' }) : '';
  if (f.type === 'rect' || f.type === 'ellipse' || f.type === 'line') { el.innerHTML = shapeSVG(f); el.style.overflow = 'visible'; return; }
  if (bg) el.insertAdjacentHTML('beforeend', bg);
  if (f.radius && f.type !== 'text') el.style.borderRadius = f.radius + 'px'; else el.style.borderRadius = '';
  if (f.type === 'text') {
    const fl = f.story && flowCache.get(f.story);
    const cols = fl?.cols.get(f.id) || [];
    const boxes = colBoxes(f);
    let any = false;
    boxes.forEach((b, i) => {
      const r = cols[i] || { a: 0, b: 0 }; if (r.b > r.a) any = true;
      const col = document.createElement('div'); col.className = 'col';
      Object.assign(col.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px', display: 'flex', flexDirection: 'column', justifyContent: { top: 'flex-start', center: 'center', bottom: 'flex-end' }[f.valign || 'top'] });
      const story = document.createElement('div'); story.className = 'story'; story.lang = 'en';
      story.innerHTML = fl ? rangeHTML(fl.parsed, r.a, r.b, pageNum, pageCount) : '';
      col.append(story); el.append(col);
    });
    if (!any && !exportMode) el.classList.add('empty-text');
    return;
  }
  if (f.type === 'image') {
    const a = S.store.doc.assets[f.asset];
    if (!a) { if (!exportMode) el.classList.add('empty-img'); return; }
    const img = document.createElement('img'); img.src = exportMode ? a.data : S.assetURL(f.asset); img.alt = a.name || '';
    img.draggable = false;
    Object.assign(img.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', maxWidth: 'none', objectFit: { fill: 'cover', fit: 'contain', stretch: 'fill' }[f.fit || 'fill'], objectPosition: `${(f.fx ?? 0.5) * 100}% ${(f.fy ?? 0.5) * 100}%`, pointerEvents: 'none' });
    el.append(img); return;
  }
  if (f.type === 'vector') {
    const svgText = ctx.ws.vector.artboardSVG?.(f.src?.ab, { withBg: f.src?.bg !== false }) || '';
    el.insertAdjacentHTML('beforeend', svgText);
    const sv = el.querySelector('svg:last-child');
    if (sv) { sv.setAttribute('width', '100%'); sv.setAttribute('height', '100%'); sv.setAttribute('preserveAspectRatio', f.fit === 'stretch' ? 'none' : f.fit === 'fill' ? 'xMidYMid slice' : 'xMidYMid meet'); Object.assign(sv.style, { position: 'absolute', inset: '0', pointerEvents: 'none' }); }
    return;
  }
  if (f.type === 'view' || f.type === 'drawing') {
    const a = S.store.doc.assets[f.snap];
    if (!a) { el.classList.add('empty-img'); return; }
    if (a.kind === 'svg') {
      el.insertAdjacentHTML('beforeend', a.data); const sv = el.querySelector('svg:last-child');
      if (sv) { sv.setAttribute('width', '100%'); sv.setAttribute('height', '100%'); sv.setAttribute('preserveAspectRatio', 'xMidYMid meet'); Object.assign(sv.style, { position: 'absolute', inset: '0', pointerEvents: 'none' }); }
    } else {
      const img = document.createElement('img'); img.src = exportMode ? a.data : S.assetURL(f.snap); img.draggable = false;
      Object.assign(img.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', maxWidth: 'none', objectFit: f.fit === 'fill' ? 'cover' : 'contain', pointerEvents: 'none' });
      el.append(img);
    }
  }
}
function frameEl(f, page, pageNum, pageCount, { master = false, exportMode = false } = {}) {
  const ck = `${page.id}:${f.id}`;
  const key = frameContentKey(f, pageNum, pageCount, exportMode);
  let entry = exportMode ? null : elCache.get(ck);
  if (!entry || entry.key !== key) {
    const el = entry?.el || document.createElement('div');
    buildFrameContent(el, f, pageNum, pageCount, exportMode);
    entry = { el, key }; if (!exportMode) elCache.set(ck, entry);
  }
  const el = entry.el;
  el.dataset.fid = f.id; if (master) el.dataset.master = '1'; else delete el.dataset.master;
  Object.assign(el.style, { left: Math.min(f.x, f.x + f.w) + 'px', top: Math.min(f.y, f.y + f.h) + 'px', width: Math.abs(f.w) + 'px', height: Math.abs(f.h) + 'px', opacity: f.opacity ?? 1,
    pointerEvents: master ? 'none' : '', zIndex: '' });
  return el;
}
/** Build a page element (screen or export). */
function pageEl(page, idx, { exportMode = false, masterView = false } = {}) {
  const pg = L().page; const n = idx + 1, count = L().pages.length;
  const el = document.createElement('div'); el.className = 'page'; el.dataset.pid = page.id; el.dataset.idx = idx;
  Object.assign(el.style, { width: pg.w + 'px', height: pg.h + 'px' });
  if (!exportMode) {
    const b = pg.bleed || 0;
    if (b) el.insertAdjacentHTML('beforeend', `<div class="bleed" style="left:${-b}px;top:${-b}px;width:${pg.w + 2 * b}px;height:${pg.h + 2 * b}px"></div>`);
    const m = marginsFor(idx); const cols = Math.max(1, pg.cols || 1), gut = pg.gutter || 0; const cw = (pg.w - m.l - m.r - gut * (cols - 1)) / cols;
    let g = `<div class="guides"><div class="margin-g" style="left:${m.l}px;top:${m.t}px;right:${m.r}px;bottom:${m.b}px"></div>`;
    for (let i = 1; i < cols; i++) g += `<div class="col-g" style="left:${m.l + i * cw + (i - 1) * gut}px;width:${gut}px;top:${m.t}px;bottom:${m.b}px"></div>`;
    el.insertAdjacentHTML('beforeend', g + '</div>');
  }
  if (!masterView && page.master) {
    const ms = L().masters.find(x => x.id === page.master);
    if (ms) for (const f of ms.items) el.append(frameEl(f, page, n, count, { master: true, exportMode }));
  }
  for (const f of page.items) el.append(frameEl(f, page, n, count, { exportMode }));
  return el;
}

// ---------- render ----------
let pageEls = new Map();
function render() {
  if (!spreadsEl) return;
  computeAllFlows();
  const pg = L().page;
  clear(spreadsEl); pageEls = new Map();
  const sp = spreads();
  spreadsEl.style.gap = 36 + 'px';
  for (const spread of sp) {
    const row = h('div', { class: 'lay-spread' });
    if (L().facing && target.kind === 'doc' && spread.length === 1 && spread[0].idx === 0) row.style.paddingLeft = pg.w * k + 'px';
    for (const { page, idx, master } of spread) {
      const wrap = h('div', { class: 'lay-pagewrap', style: { width: pg.w * k + 'px', height: pg.h * k + 'px' } });
      const label = master ? `${page.id}-MASTER · ${page.name}` : `PAGE ${idx + 1}${page.master ? ` · ${page.master}` : ''}`;
      wrap.append(h('div', { class: 'pnum' }, label));
      const el = pageEl(page, idx, { masterView: !!master });
      el.style.transform = `scale(${k})`;
      wrap.append(el); row.append(wrap); pageEls.set(page.id, el);
    }
    spreadsEl.append(row);
  }
  renderOverlay();
  updateStatus();
}
function renderOverlay() {
  for (const el of pageEls.values()) el.querySelectorAll('.frame-sel,.port,.thread-line,.lay-snap').forEach(x => x.remove());
  const hs = 9 / k, bw = 1.25 / k;
  // thread lines for selected text frames' stories
  const stories = new Set(selFrames().filter(x => x.frame.type === 'text' && x.frame.story).map(x => x.frame.story));
  for (const { frame, page } of selFrames()) {
    const pel = pageEls.get(page.id); if (!pel) continue;
    const f = frame, x = Math.min(f.x, f.x + f.w), y = Math.min(f.y, f.y + f.h), w = Math.abs(f.w), hh = Math.abs(f.h);
    const box = h('div', { class: 'frame-sel', style: { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px', borderWidth: bw + 'px' } });
    if (sel.size === 1 && f.type !== 'line') {
      for (const [n, cx, cy] of [['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5]]) {
        box.append(h('div', { class: 'h', 'data-h': n, style: { left: (cx * w - hs / 2) + 'px', top: (cy * hh - hs / 2) + 'px', width: hs + 'px', height: hs + 'px', borderWidth: bw + 'px', cursor: n + '-resize' } }));
      }
    }
    if (sel.size === 1 && f.type === 'line') for (const [n, cx, cy] of [['nw', 0, 0], ['se', 1, 1]]) box.append(h('div', { class: 'h', 'data-h': n, style: { left: (cx * w - hs / 2) + 'px', top: (cy * hh - hs / 2) + 'px', width: hs + 'px', height: hs + 'px', borderWidth: bw + 'px' } }));
    pel.append(box);
  }
  // ports on every text frame of selected stories
  for (const sid of stories) {
    const st = L().stories[sid]; const fl = flowCache.get(sid); if (!st) continue;
    const centers = [];
    st.frames.forEach((fid, i) => {
      const loc = findFrame(fid); if (!loc) return; const pel = pageEls.get(loc.page.id); if (!pel) return;
      const f = loc.frame; const ps = 11 / k;
      const last = i === st.frames.length - 1; const over = last && fl?.overset;
      pel.append(h('div', { class: 'port', title: 'Text in', style: { left: f.x - ps / 2 + 'px', top: f.y + 6 / k + 'px', width: ps + 'px', height: ps + 'px', borderWidth: bw + 'px' } }));
      pel.append(h('div', { class: 'port' + (over ? ' over' : ''), 'data-port': fid, title: over ? 'Overset text — click, then click a frame or page to continue the story' : 'Text out — click, then click a frame to thread', style: { left: f.x + f.w - ps / 2 + 'px', top: f.y + f.h - ps - 6 / k + 'px', width: ps + 'px', height: ps + 'px', borderWidth: bw + 'px', fontSize: 10 / k + 'px', lineHeight: 8 / k + 'px' } }, over ? '+' : (st.frames.length > 1 && !last ? '▸' : '')));
      centers.push({ pel, x: f.x + f.w, y: f.y + f.h - 6 / k, x2: f.x, y2: f.y + 6 / k });
    });
    for (let i = 0; i < centers.length - 1; i++) {
      const a = centers[i], b = centers[i + 1]; if (a.pel !== b.pel) continue;
      const svg = h('div', { class: 'thread-line', html: `<svg width="1" height="1" style="overflow:visible"><path d="M${a.x} ${a.y} C${a.x + 40} ${a.y} ${b.x2 - 40} ${b.y2} ${b.x2} ${b.y2}" style="stroke-width:${bw}"/></svg>` });
      a.pel.append(svg);
    }
  }
  if (drag?.snaps) for (const s of drag.snaps) { const pel = pageEls.get(s.pid); if (!pel) continue; pel.append(h('div', { class: 'lay-snap', style: s.v ? { left: s.at + 'px', top: '-20px', width: 1 / k + 'px', height: L().page.h + 40 + 'px' } : { top: s.at + 'px', left: '-20px', height: 1 / k + 'px', width: L().page.w + 40 + 'px' } })); }
}
function updateStatus() {
  const t = TOOLS.find(x => x !== '-' && x.id === tool);
  const tgt = target.kind === 'master' ? ` · editing master ${target.id}` : '';
  const over = Object.keys(L().stories).filter(id => flowCache.get(id)?.overset).length;
  ctx.setStatus('layout', `${(t?.label || '').split(' (')[0]} · ${Math.round(k * 100)}% · ${L().pages.length} pages · ${round(U(L().page.w), 1)}×${round(U(L().page.h), 1)} ${unit()}${tgt}${over ? ` · ${over} overset ${over === 1 ? 'story' : 'stories'}` : ''}${threadFrom ? ' · THREADING: click a text frame or an empty page spot (Esc cancels)' : ''}`);
  if (zoomLabel) zoomLabel.textContent = Math.round(k * 100) + '%';
}
function fitView() {
  const r = scroller.getBoundingClientRect(); if (r.width < 20) return false;
  const pg = L().page; const spreadW = (L().facing && target.kind === 'doc' ? 2 : 1) * pg.w;
  k = clamp(Math.min((r.width - 120) / spreadW, (r.height - 120) / pg.h), 0.15, 4);
  render(); return true;
}

// ---------- pointer interaction ----------
function pageAt(clientX, clientY) {
  for (const [pid, el] of pageEls) {
    const r = el.getBoundingClientRect();
    const pad = 40 * k;
    if (clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad) {
      const page = targetPages().find(p => p.page.id === pid);
      return { page: page.page, idx: page.idx, el, x: (clientX - r.left) / k, y: (clientY - r.top) / k, inside: clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom };
    }
  }
  return null;
}
function hitFrame(pg) {
  const items = pg.page.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const f = items[i]; if (f.locked) continue;
    const x = Math.min(f.x, f.x + f.w), y = Math.min(f.y, f.y + f.h), w = Math.abs(f.w), hh = Math.abs(f.h), tol = 4 / k;
    if (f.type === 'line') { const d = distToSeg(pg.x, pg.y, f.x, f.y, f.x + f.w, f.y + f.h); if (d < tol + 2 / k) return f; continue; }
    if (pg.x >= x - tol && pg.x <= x + w + tol && pg.y >= y - tol && pg.y <= y + hh + tol) return f;
  }
  return null;
}
function distToSeg(px, py, x1, y1, x2, y2) { const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy || 1; const t = clamp(((px - x1) * dx + (py - y1) * dy) / l, 0, 1); return Math.hypot(px - x1 - t * dx, py - y1 - t * dy); }
function snapCandidates(pg, excludeIds) {
  const P0 = L().page, m = marginsFor(pg.idx); const cols = Math.max(1, P0.cols || 1), gut = P0.gutter || 0; const cw = (P0.w - m.l - m.r - gut * (cols - 1)) / cols;
  const xs = [0, P0.w, P0.w / 2, m.l, P0.w - m.r], ys = [0, P0.h, P0.h / 2, m.t, P0.h - m.b];
  for (let i = 1; i < cols; i++) { const x = m.l + i * cw + (i - 1) * gut; xs.push(x, x + gut); }
  for (const f of pg.page.items) { if (excludeIds.has(f.id)) continue; xs.push(f.x, f.x + f.w, f.x + f.w / 2); ys.push(f.y, f.y + f.h, f.y + f.h / 2); }
  return { xs, ys };
}
function snapValue(v, list, tol) { let best = null; for (const c of list) { const d = c - v; if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c }; } return best; }

function onDown(e) {
  if (e.button === 1 || spaceDown || tool === 'hand') { drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, l0: scroller.scrollLeft, t0: scroller.scrollTop }; scroller.setPointerCapture(e.pointerId); e.preventDefault(); return; }
  if (e.button !== 0) return;
  const t = e.target;
  if (t.dataset.port) { threadFrom = t.dataset.port; scroller.style.cursor = 'copy'; updateStatus(); e.stopPropagation(); return; }
  const pg = pageAt(e.clientX, e.clientY);
  if (threadFrom) { completeThread(pg, e); return; }
  if (t.dataset.h && sel.size === 1) {
    const loc = selFrames()[0]; if (!loc) return;
    S.checkpoint('Resize frame'); scroller.setPointerCapture(e.pointerId);
    drag = { mode: 'resize', h: t.dataset.h, loc, orig: { ...loc.frame }, sx: e.clientX, sy: e.clientY };
    e.preventDefault(); return;
  }
  if (!pg) { if (!e.shiftKey) { sel.clear(); renderOverlay(); buildPanel(); } return; }
  if (tool === 'select') {
    const f = hitFrame(pg);
    if (f) {
      if (e.shiftKey) { sel.has(f.id) ? sel.delete(f.id) : sel.add(f.id); }
      else if (!sel.has(f.id)) { sel.clear(); sel.add(f.id); }
      S.checkpoint('Move frame'); scroller.setPointerCapture(e.pointerId);
      drag = { mode: 'move', pg, sx: e.clientX, sy: e.clientY, orig: selFrames().map(l => ({ id: l.frame.id, x: l.frame.x, y: l.frame.y, pid: l.page.id })) };
      renderOverlay(); buildPanel(); e.preventDefault(); return;
    }
    if (!e.shiftKey) sel.clear(); renderOverlay(); buildPanel(); return;
  }
  // creation tools
  if (!pg.inside && tool !== 'line') return;
  S.checkpoint('Create frame'); scroller.setPointerCapture(e.pointerId);
  const id = uid('f'); const f = { id, type: tool, x: pg.x, y: pg.y, w: 0, h: 0 };
  if (tool === 'text') { const sid = uid('st'); L().stories[sid] = { text: '', frames: [id] }; f.story = sid; f.cols = 1; f.gutter = 12; f.inset = 0; }
  if (tool === 'image') { f.fit = 'fill'; f.fx = 0.5; f.fy = 0.5; }
  if (tool === 'rect' || tool === 'ellipse') { f.fill = '#e3a72f'; f.stroke = null; f.sw = 0; }
  if (tool === 'line') { f.stroke = '#1c1a17'; f.sw = 1; }
  pg.page.items.push(f); sel.clear(); sel.add(id);
  drag = { mode: 'create', pg, f, x0: pg.x, y0: pg.y };
  e.preventDefault();
}
function onMove(e) {
  if (!drag) return;
  if (drag.mode === 'pan') { scroller.scrollLeft = drag.l0 - (e.clientX - drag.sx); scroller.scrollTop = drag.t0 - (e.clientY - drag.sy); return; }
  const tol = 5 / k;
  if (drag.mode === 'move') {
    let dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const first = drag.orig[0], f0 = findFrame(first.id)?.frame; drag.snaps = [];
    if (f0 && !e.altKey) {
      const { xs, ys } = snapCandidates(drag.pg, new Set(drag.orig.map(o => o.id)));
      const bx = [first.x + dx, first.x + dx + f0.w / 2, first.x + dx + f0.w].map(v => snapValue(v, xs, tol)).filter(Boolean).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
      const by = [first.y + dy, first.y + dy + f0.h / 2, first.y + dy + f0.h].map(v => snapValue(v, ys, tol)).filter(Boolean).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
      if (bx) { dx += bx.d; drag.snaps.push({ pid: drag.pg.page.id, v: true, at: bx.at }); }
      if (by) { dy += by.d; drag.snaps.push({ pid: drag.pg.page.id, v: false, at: by.at }); }
    }
    for (const o of drag.orig) { const loc = findFrame(o.id); if (loc) { loc.frame.x = o.x + dx; loc.frame.y = o.y + dy; } }
    drag.moved = true; S.changed('layout', { live: true }); return;
  }
  if (drag.mode === 'resize') {
    const f = drag.loc.frame, o = drag.orig, hn = drag.h;
    let dx = (e.clientX - drag.sx) / k, dy = (e.clientY - drag.sy) / k;
    if (f.type === 'line') { if (hn === 'nw') { f.x = o.x + dx; f.y = o.y + dy; f.w = o.w - dx; f.h = o.h - dy; } else { f.w = o.w + dx; f.h = o.h + dy; } if (e.shiftKey) { if (Math.abs(f.w) > Math.abs(f.h)) f.h = 0; else f.w = 0; } }
    else {
      const { xs, ys } = snapCandidates(drag.loc.idx != null ? { page: drag.loc.page, idx: drag.loc.idx } : drag.pg, new Set([f.id])); drag.snaps = [];
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (hn.includes('w')) x0 += dx; if (hn.includes('e')) x1 += dx; if (hn.includes('n')) y0 += dy; if (hn.includes('s')) y1 += dy;
      if (!e.altKey) {
        const sx = snapValue(hn.includes('w') ? x0 : x1, xs, tol); if (sx && (hn.includes('w') || hn.includes('e'))) { if (hn.includes('w')) x0 += sx.d; else x1 += sx.d; drag.snaps.push({ pid: drag.loc.page.id, v: true, at: sx.at }); }
        const sy = snapValue(hn.includes('n') ? y0 : y1, ys, tol); if (sy && (hn.includes('n') || hn.includes('s'))) { if (hn.includes('n')) y0 += sy.d; else y1 += sy.d; drag.snaps.push({ pid: drag.loc.page.id, v: false, at: sy.at }); }
      }
      if (e.shiftKey && (hn.length === 2)) { const ar = o.w / o.h; const w = x1 - x0, hh = w / ar; if (hn.includes('n')) y0 = y1 - hh; else y1 = y0 + hh; }
      f.x = Math.min(x0, x1); f.y = Math.min(y0, y1); f.w = Math.max(2, Math.abs(x1 - x0)); f.h = Math.max(2, Math.abs(y1 - y0));
    }
    drag.moved = true; S.changed('layout', { live: true }); return;
  }
  if (drag.mode === 'create') {
    const pr = pageEls.get(drag.pg.page.id).getBoundingClientRect();
    let x = (e.clientX - pr.left) / k, y = (e.clientY - pr.top) / k; const f = drag.f;
    if (f.type === 'line') { f.w = x - drag.x0; f.h = y - drag.y0; if (e.shiftKey) { if (Math.abs(f.w) > Math.abs(f.h)) f.h = 0; else f.w = 0; } }
    else {
      const { xs, ys } = snapCandidates(drag.pg, new Set([f.id])); const sx = snapValue(x, xs, tol), sy = snapValue(y, ys, tol); if (sx) x += sx.d; if (sy) y += sy.d;
      let w = x - drag.x0, hh = y - drag.y0; if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
      f.x = Math.min(drag.x0, drag.x0 + w); f.y = Math.min(drag.y0, drag.y0 + hh); f.w = Math.abs(w); f.h = Math.abs(hh);
    }
    drag.moved = true; S.changed('layout', { live: true });
  }
}
function onUp(e) {
  if (!drag) return; const d = drag; drag = null;
  if (d.mode === 'pan') return;
  if (d.mode === 'move' && d.moved) {
    // dropped on another page? move frames there (keeps visual position)
    const pg = pageAt(e.clientX, e.clientY);
    if (pg && pg.page.id !== d.pg.page.id && pg.inside) {
      const fromEl = pageEls.get(d.pg.page.id).getBoundingClientRect(), toEl = pg.el.getBoundingClientRect();
      for (const o of d.orig) {
        const loc = findFrame(o.id); if (!loc) continue; const f = loc.frame;
        loc.page.items = loc.page.items.filter(x => x !== f);
        f.x += (fromEl.left - toEl.left) / k; f.y += (fromEl.top - toEl.top) / k; pg.page.items.push(f);
      }
    }
  }
  if (d.mode === 'create') {
    const f = d.f;
    if (!d.moved || (Math.abs(f.w) < 4 && Math.abs(f.h) < 4)) {
      if (f.type === 'line') { f.w = 100; f.h = 0; }
      else { const m = marginsFor(d.pg.idx); const P0 = L().page; f.w = f.type === 'text' ? (P0.w - m.l - m.r) / Math.max(1, P0.cols) : 120; f.h = f.type === 'text' ? 160 : 90; }
    }
    S.changed('layout');
    if (f.type === 'text') { buildPanel(); focusStory(); }
    else if (f.type === 'image') { buildPanel(); replaceImage(f); }
    setTool('select');
    return;
  }
  if (d.moved) S.changed('layout'); else S.settle();
  buildPanel();
}
function onDbl(e) {
  const pg = pageAt(e.clientX, e.clientY); if (!pg) return;
  const f = hitFrame(pg); if (!f) return;
  sel.clear(); sel.add(f.id); renderOverlay(); buildPanel();
  if (f.type === 'text') focusStory();
  else if (f.type === 'image') replaceImage(f);
  else if (f.type === 'vector') ctx.activate('vector');
  else if (f.type === 'view' || f.type === 'drawing') updatePlacement(f);
}
function onWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const r = scroller.getBoundingClientRect(); const mx = e.clientX - r.left + scroller.scrollLeft, my = e.clientY - r.top + scroller.scrollTop;
  const k0 = k; k = clamp(k * Math.exp(-e.deltaY * 0.0022), 0.1, 6);
  render();
  scroller.scrollLeft = mx * (k / k0) - (e.clientX - r.left); scroller.scrollTop = my * (k / k0) - (e.clientY - r.top);
}

// ---------- threading ----------
function completeThread(pg, e) {
  const fromId = threadFrom; threadFrom = null; scroller.style.cursor = '';
  const from = findFrame(fromId)?.frame; if (!from || !pg) { updateStatus(); return; }
  const st = L().stories[from.story]; if (!st) return;
  let dest = hitFrame(pg);
  S.checkpoint('Thread text');
  if (!dest) { // create a frame where clicked, same size as the source
    dest = { id: uid('f'), type: 'text', x: pg.x, y: pg.y, w: from.w, h: from.h, cols: from.cols, gutter: from.gutter, inset: from.inset };
    pg.page.items.push(dest);
  } else if (dest.type !== 'text') { toast('Thread into a text frame, or click an empty spot to make one', 'bad'); S.settle(); updateStatus(); return; }
  if (dest.id === from.id || st.frames.includes(dest.id)) { toast('That frame is already in this story'); S.settle(); updateStatus(); return; }
  const old = dest.story && L().stories[dest.story];
  if (old) { if (old.text.trim()) st.text += '\n' + old.text; old.frames = old.frames.filter(x => x !== dest.id); if (!old.frames.length) delete L().stories[dest.story]; }
  const at = st.frames.indexOf(from.id); st.frames.splice(at + 1, 0, dest.id); dest.story = from.story;
  sel.clear(); sel.add(dest.id);
  S.changed('layout'); buildPanel(); toast('Threaded');
}
function unthreadAfter(f) {
  const st = L().stories[f.story]; if (!st) return; const i = st.frames.indexOf(f.id); if (i < 0 || i === st.frames.length - 1) return;
  S.checkpoint('Break thread');
  const rest = st.frames.splice(i + 1); const sid = uid('st'); L().stories[sid] = { text: '', frames: rest };
  for (const id of rest) { const loc = findFrameAnywhere(id); if (loc) loc.frame.story = sid; }
  S.changed('layout'); buildPanel();
}
function autoflow(f) {
  const st = L().stories[f.story]; if (!st) return;
  let fl = computeFlow(f.story); if (!fl.overset) { toast('This story already fits'); return; }
  S.checkpoint('Autoflow');
  let lastLoc = findFrameAnywhere(st.frames[st.frames.length - 1]); let added = 0;
  const P0 = L().page;
  while (fl.overset && added < 60) {
    const insertAt = (lastLoc?.idx ?? L().pages.length - 1) + 1;
    const page = { id: uid('pg'), master: L().pages[insertAt - 1]?.master || 'A', items: [] };
    L().pages.splice(insertAt, 0, page);
    const m = marginsFor(insertAt);
    const nf = { id: uid('f'), type: 'text', x: m.l, y: m.t, w: P0.w - m.l - m.r, h: P0.h - m.t - m.b, cols: P0.cols, gutter: P0.gutter, inset: 0, story: f.story };
    page.items.push(nf); st.frames.push(nf.id); added++;
    lastLoc = { idx: insertAt };
    flowCache.delete(f.story); fl = computeFlow(f.story);
  }
  S.changed('layout'); toast(`Added ${added} page${added === 1 ? '' : 's'}`);
}

// ---------- images & placements ----------
async function replaceImage(f) {
  const file = await pickFile('image/*'); if (!file) return;
  const data = await readAsDataURL(file); const img = await loadImage(data);
  const asset = S.addAsset({ kind: 'image', name: file.name, mime: file.type, data, w: img.naturalWidth, h: img.naturalHeight });
  S.commit('Place image', () => { const loc = findFrameAnywhere(f.id); if (loc) { loc.frame.asset = asset; loc.frame.type = 'image'; loc.frame.fit ??= 'fill'; } }, 'layout');
  buildPanel();
}
// ---------- PDF placement (PDF.js, Apache-2.0) ----------
// The page is rendered to a high-resolution image; the worker script ships next to the app and loads on first use.
let pdfjsP = null;
function loadPdfjs() {
  pdfjsP ??= (async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
    const src = await fetchBundled('pdf.worker.min.mjs');
    lib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
    return lib;
  })().catch((e) => { pdfjsP = null; throw e; });
  return pdfjsP;
}
async function placePDF(into = null) {
  const file = await pickFile('.pdf,application/pdf'); if (!file) return;
  let lib, doc;
  try { lib = await loadPdfjs(); doc = await lib.getDocument({ data: new Uint8Array(await readAsArrayBuffer(file)), isEvalSupported: false, useSystemFonts: true }).promise; }
  catch (e) { console.error(e); toast("Couldn't open that PDF: " + (e.message || e), 'bad'); return; }
  const o = { page: 1, ppi: 300 };
  {
    const ok = await dialog({ title: `Place PDF · ${file.name}`, body: (el) => el.append(h('div', { class: 'fields' },
      numField({ label: `Page (1–${doc.numPages})`, value: 1, min: 1, max: doc.numPages, decimals: 0, onChange: v => o.page = Math.round(v) }),
      selectField({ label: 'Resolution', value: '300', options: [['150', '150 PPI · screen'], ['300', '300 PPI · print'], ['600', '600 PPI · fine line art']], onChange: v => o.ppi = +v })),
      h('p', { class: 'hint' }, 'The page is placed as a high-resolution image at its true size. Fonts and vectors inside it are not editable.')),
      actions: [{ label: 'Cancel', value: false }, { label: 'Place', primary: true, value: true }] });
    if (!ok) return;
  }
  toast('Rendering PDF page…');
  try {
    const page = await doc.getPage(Math.max(1, Math.min(doc.numPages, o.page)));
    const vp1 = page.getViewport({ scale: 1 }); const scale = Math.min(o.ppi / 72, 8000 / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale }); const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const data = c.toDataURL('image/png');
    const asset = S.addAsset({ kind: 'image', name: `${file.name} · p${o.page}`, mime: 'image/png', data, w: c.width, h: c.height, source: 'pdf' });
    const pg = target.kind === 'master' ? L().masters.find(x => x.id === target.id) : (findFrame([...sel][0])?.page || visiblePage());
    S.commit('Place PDF', () => {
      if (into) { const loc = findFrameAnywhere(into.id); if (loc) Object.assign(loc.frame, { type: 'image', asset, fit: 'fit' }); return; }
      const P0 = L().page; const w = Math.min(vp1.width, P0.w), hh = w * vp1.height / vp1.width;
      const f = { id: uid('f'), type: 'image', x: (P0.w - w) / 2, y: Math.max(0, (P0.h - hh) / 2), w, h: hh, asset, fit: 'fit', fx: 0.5, fy: 0.5 };
      pg.items.push(f); sel.clear(); sel.add(f.id);
    }, 'layout');
    toast(`Placed page ${o.page} of ${doc.numPages} at ${o.ppi} PPI`); buildPanel();
  } catch (e) { console.error(e); toast('PDF render failed: ' + (e.message || e), 'bad'); }
  finally { doc.destroy?.(); }
}
function effectivePPI(f) {
  const a = S.store.doc.assets[f.asset]; if (!a || !a.w) return null;
  const sx = Math.abs(f.w) / a.w, sy = Math.abs(f.h) / a.h; const fit = f.fit || 'fill';
  const s = fit === 'fill' ? Math.max(sx, sy) : fit === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy);
  return Math.round(72 / s);
}
async function placeFrom(kind, opts = {}) {
  const page = target.kind === 'master' ? L().masters.find(x => x.id === target.id) : (findFrame([...sel][0])?.page || visiblePage());
  if (!page) return;
  const idx = L().pages.indexOf(page); const m = marginsFor(Math.max(0, idx)); const P0 = L().page;
  const w = P0.w - m.l - m.r, hh = w * 0.66;
  const f = { id: uid('f'), x: m.l, y: m.t + 40, w, h: hh, fit: 'fit' };
  if (kind === 'vector') { const ab = opts.ab || ctx.ws.vector.listArtboards()[0]?.id; Object.assign(f, { type: 'vector', src: { ab } }); const a = ctx.ws.vector.listArtboards().find(x => x.id === ab); if (a) f.h = w * a.h / a.w; }
  else Object.assign(f, { type: kind === 'drawing' ? 'drawing' : 'view', src: { ws: kind === 'drawing' ? 'cad' : kind, angle: opts.angle || 'iso' } });
  S.commit('Place', () => { page.items.push(f); sel.clear(); sel.add(f.id); }, 'layout');
  if (f.type !== 'vector') await updatePlacement(f);
  buildPanel();
}
async function updatePlacement(f) {
  try {
    if (f.type === 'drawing') {
      const svgText = await ctx.ws.cad.drawingSVG?.(f.src?.angle || 'front');
      if (!svgText) { toast('Make a CAD part first, then place its drawing', 'bad'); return; }
      const id = S.addAsset({ kind: 'svg', name: 'drawing.svg', data: svgText });
      S.commit('Update drawing', () => { const loc = findFrameAnywhere(f.id); if (loc) { loc.frame.snap = id; loc.frame.snapFast = !ctx.ws.cad.isPrecise?.(); } }, 'layout');
    } else if (f.type === 'view') {
      const mod = ctx.ws[f.src.ws];
      const data = await mod?.snapshot?.({ w: Math.round(Math.abs(f.w) * 3), h: Math.round(Math.abs(f.h) * 3), angle: f.src.angle });
      if (!data) { toast('Nothing to render yet in ' + (f.src.ws === 'cad' ? 'CAD' : 'Mesh'), 'bad'); return; }
      const id = S.addAsset({ kind: 'image', name: 'view.png', mime: 'image/png', data, w: Math.round(Math.abs(f.w) * 3), h: Math.round(Math.abs(f.h) * 3) });
      S.commit('Update view', () => { const loc = findFrameAnywhere(f.id); if (loc) { loc.frame.snap = id; loc.frame.snapFast = f.src.ws === 'cad' && !ctx.ws.cad.isPrecise?.(); } }, 'layout');
    }
    buildPanel();
  } catch (e) { console.error(e); toast('Could not update the placement: ' + e.message, 'bad'); }
}
let filling = false;
/** Render linked views that have no image yet (e.g. a freshly opened sample), without adding undo steps. */
async function fillMissingPlacements(includeFast = false) {
  if (filling) { setTimeout(() => fillMissingPlacements(includeFast), 400); return; } filling = true;
  try {
    const cadWaiting = ['idle', 'loading'].includes(ctx.ws.cad.kernelState?.());
    const list = []; for (const p of [...L().pages, ...L().masters]) for (const f of p.items) {
      if (f.type !== 'view' && f.type !== 'drawing') continue;
      const fromCad = f.type === 'drawing' || f.src?.ws === 'cad';
      if (fromCad && cadWaiting) continue; // the precise kernel is on its way; draw once it lands
      if (!f.snap || (includeFast && f.snapFast)) list.push(f);
    }
    for (const f of list) {
      if (f.type === 'drawing') { const svgText = await ctx.ws.cad.drawingSVG?.(f.src?.angle || 'front'); if (!svgText) continue; f.snap = S.addAsset({ kind: 'svg', name: 'drawing.svg', data: svgText }); f.snapFast = !ctx.ws.cad.isPrecise?.(); }
      else { const data = await ctx.ws[f.src.ws]?.snapshot?.({ w: Math.round(Math.abs(f.w) * 3), h: Math.round(Math.abs(f.h) * 3), angle: f.src.angle }); if (!data) continue; f.snap = S.addAsset({ kind: 'image', name: 'view.png', mime: 'image/png', data, w: Math.round(Math.abs(f.w) * 3), h: Math.round(Math.abs(f.h) * 3) }); f.snapFast = f.src.ws === 'cad' && !ctx.ws.cad.isPrecise?.(); }
    }
    if (list.length) { S.changed('layout'); }
  } catch (e) { console.warn('placement fill', e); }
  finally { filling = false; }
}
async function updateAllPlacements() {
  const list = []; for (const p of [...L().pages, ...L().masters]) for (const f of p.items) if (f.type === 'view' || f.type === 'drawing') list.push(f);
  for (const f of list) await updatePlacement(f);
  vectorVersion++; render(); toast(`Updated ${list.length} linked view${list.length === 1 ? '' : 's'}`);
}
function visiblePage() {
  const r = scroller.getBoundingClientRect(); let best = null, bd = Infinity;
  for (const [pid, el] of pageEls) { const pr = el.getBoundingClientRect(); const d = Math.abs((pr.top + pr.bottom) / 2 - (r.top + r.bottom) / 2) + Math.abs((pr.left + pr.right) / 2 - (r.left + r.right) / 2); if (d < bd) { bd = d; best = pid; } }
  return targetPages().find(p => p.page.id === best)?.page || L().pages[0];
}

// ---------- pages ----------
function addPage(after = L().pages.length - 1, dup = false) {
  S.checkpoint(dup ? 'Duplicate page' : 'Add page');
  const src = L().pages[after];
  const page = { id: uid('pg'), master: src?.master ?? 'A', items: [] };
  if (dup && src) {
    const map = new Map();
    for (const f of src.items) { const c = JSON.parse(JSON.stringify(f)); c.id = uid('f'); map.set(f.id, c.id); page.items.push(c); }
    const storyMap = new Map();
    for (const c of page.items) if (c.type === 'text' && c.story) {
      if (!storyMap.has(c.story)) { const st = L().stories[c.story]; const sid = uid('st'); L().stories[sid] = { text: st ? st.text : '', frames: [] }; storyMap.set(c.story, sid); }
      c.story = storyMap.get(c.story); L().stories[c.story].frames.push(c.id);
    }
  }
  L().pages.splice(after + 1, 0, page);
  S.changed('layout'); buildPanel();
}
async function deletePage(idx) {
  if (L().pages.length <= 1) { toast('A document needs at least one page'); return; }
  S.checkpoint('Delete page');
  const page = L().pages[idx];
  for (const f of page.items) if (f.story) { const st = L().stories[f.story]; if (st) { st.frames = st.frames.filter(x => x !== f.id); if (!st.frames.length) delete L().stories[f.story]; } }
  L().pages.splice(idx, 1); sel.clear(); S.changed('layout'); buildPanel();
}
function movePage(idx, dir) { const j = idx + dir; if (j < 0 || j >= L().pages.length) return; S.checkpoint('Move page'); const p = L().pages; [p[idx], p[j]] = [p[j], p[idx]]; S.changed('layout'); buildPanel(); }
function deleteFrames() {
  if (!sel.size) return;
  S.checkpoint('Delete');
  for (const loc of selFrames()) {
    const f = loc.frame; loc.page.items = loc.page.items.filter(x => x !== f);
    if (f.story) { const st = L().stories[f.story]; if (st) { st.frames = st.frames.filter(x => x !== f.id); if (!st.frames.length) delete L().stories[f.story]; } }
  }
  sel.clear(); S.changed('layout'); buildPanel();
}
function duplicateFrames() {
  if (!sel.size) return; S.checkpoint('Duplicate'); const ids = [];
  for (const loc of selFrames()) {
    const c = JSON.parse(JSON.stringify(loc.frame)); c.id = uid('f'); c.x += 10; c.y += 10;
    if (c.story) { const st = L().stories[c.story]; const sid = uid('st'); L().stories[sid] = { text: st?.text || '', frames: [c.id] }; c.story = sid; }
    loc.page.items.push(c); ids.push(c.id);
  }
  sel.clear(); ids.forEach(i => sel.add(i)); S.changed('layout'); buildPanel();
}
function arrangeFrames(dir) {
  if (!sel.size) return; S.checkpoint('Arrange');
  for (const loc of selFrames()) { const arr = loc.page.items; const i = arr.indexOf(loc.frame); arr.splice(i, 1); if (dir === 'front') arr.push(loc.frame); else if (dir === 'back') arr.unshift(loc.frame); else arr.splice(clamp(i + (dir === 'forward' ? 1 : -1), 0, arr.length), 0, loc.frame); }
  S.changed('layout');
}

// ---------- data merge ----------
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',' || c === '\t') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
async function dataMerge() {
  let csvText = 'name,role,city\nAda Okafor,Lead fabricator,Ottawa\nSam Reyes,CAD technician,Montréal\nLi Wen,Print designer,Toronto';
  const st = { template: 0 };
  let ta;
  const ok = await dialog({ title: 'Data merge', wide: true, body: (el) => {
    el.append(h('p', null, 'Write {{field}} tokens in text frames on a template page, paste rows below (CSV or tab-separated, first row = field names), and KERF adds one finished page per row. The rows shown are examples — replace them with yours.'),
      h('div', { class: 'fields' }, selectField({ label: 'Template page', value: 0, options: L().pages.map((p, i) => [i, `Page ${i + 1}`]), onChange: v => st.template = +v, span: 2 }),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Rows from file'), h('button', { class: 'btn small', type: 'button', onclick: async () => { const f = await pickFile('.csv,.tsv,.txt'); if (f) ta.value = await readAsText(f); } }, 'Load CSV…'))),
      (ta = h('textarea', { class: 'inp', rows: 8, 'aria-label': 'Rows', style: { fontFamily: 'var(--mono)', fontSize: '12px' } })));
    ta.value = csvText;
  }, actions: [{ label: 'Cancel', value: false }, { label: 'Merge', primary: true, onClick: () => { csvText = ta.value; return true; } }] });
  if (!ok) return;
  const rows = parseCSV(csvText); if (rows.length < 2) { toast('Need a header row and at least one data row', 'bad'); return; }
  const head = rows[0].map(x => x.trim()); const tpl = L().pages[st.template];
  S.checkpoint('Data merge');
  let at = L().pages.indexOf(tpl);
  for (const r of rows.slice(1)) {
    const page = { id: uid('pg'), master: tpl.master, items: [] }; const storyMap = new Map();
    for (const f of tpl.items) {
      const c = JSON.parse(JSON.stringify(f)); c.id = uid('f');
      if (c.story) {
        if (!storyMap.has(c.story)) { const src = L().stories[c.story]?.text || ''; const sid = uid('st'); L().stories[sid] = { text: src.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => { const i = head.indexOf(k); return i >= 0 ? (r[i] ?? '') : `{{${k}}}`; }), frames: [] }; storyMap.set(c.story, sid); }
        c.story = storyMap.get(c.story); L().stories[c.story].frames.push(c.id);
      }
      page.items.push(c);
    }
    L().pages.splice(++at, 0, page);
  }
  S.changed('layout'); buildPanel(); toast(`Merged ${rows.length - 1} records`);
}

// ---------- preflight ----------
function preflight() {
  computeAllFlows();
  const issues = []; const P0 = L().page; const bleed = P0.bleed || 0;
  const pagesAll = [...L().pages.map((p, i) => ({ p, label: `Page ${i + 1}` })), ...L().masters.map(m => ({ p: m, label: `${m.id}-Master`, master: true }))];
  for (const sid of Object.keys(L().stories)) { const fl = flowCache.get(sid); if (fl?.overset) { const fid = L().stories[sid].frames.at(-1); issues.push({ sev: 'err', text: `Overset text: ${fl.N - fl.placed} words don't fit`, fid }); } }
  for (const { p, label } of pagesAll) for (const f of p.items) {
    if (f.type === 'image') {
      if (!f.asset) issues.push({ sev: 'warn', text: `${label}: empty image frame`, fid: f.id });
      else { const ppi = effectivePPI(f); if (ppi != null && ppi < 150) issues.push({ sev: ppi < 100 ? 'err' : 'warn', text: `${label}: image at ${ppi} ppi (print wants 300; 150 minimum)`, fid: f.id }); }
    }
    if (f.type === 'text' && f.story && !(L().stories[f.story]?.text || '').trim()) issues.push({ sev: 'warn', text: `${label}: empty text frame`, fid: f.id });
    const x0 = Math.min(f.x, f.x + f.w), y0 = Math.min(f.y, f.y + f.h), x1 = Math.max(f.x, f.x + f.w), y1 = Math.max(f.y, f.y + f.h);
    if (x0 < -bleed - 0.5 || y0 < -bleed - 0.5 || x1 > P0.w + bleed + 0.5 || y1 > P0.h + bleed + 0.5) issues.push({ sev: 'warn', text: `${label}: object runs past the bleed`, fid: f.id });
    else if ((x0 < -0.5 || y0 < -0.5 || x1 > P0.w + 0.5 || y1 > P0.h + 0.5) && (x0 > -bleed + 0.5 || y0 > -bleed + 0.5 || x1 < P0.w + bleed - 0.5 || y1 < P0.h + bleed - 0.5) && f.type === 'image' && bleed > 0) issues.push({ sev: 'warn', text: `${label}: image crosses the trim but stops short of the bleed`, fid: f.id });
  }
  const fonts = new Set(Object.values(L().styles).map(s => s.font));
  for (const fam of fonts) { try { if (!document.fonts.check(`12px "${fam}"`)) issues.push({ sev: 'warn', text: `Font “${fam}” isn't installed here — screen and PDF will substitute` }); } catch { /* ignore */ } }
  return issues;
}

// ---------- export ----------
async function exportPDF({ bleed = true, marks = false, pages = 'all' } = {}) {
  await document.fonts.ready; computeAllFlows();
  const P0 = L().page; const w = new PDF.PdfWriter({ title: S.store.doc.name, fontAssets: PDF.fontAssetsOf(S.store.doc.assets) });
  const host = h('div', { style: { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none' } }); document.body.append(host);
  const list = pages === 'all' ? L().pages.map((p, i) => [p, i]) : [[L().pages[pages], pages]];
  try {
    for (const [page, idx] of list) {
      const el = pageEl(page, idx, { exportMode: true }); host.append(el);
      await Promise.all([...el.querySelectorAll('img')].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
      const pg = w.page(P0.w, P0.h, { bleed: bleed ? (P0.bleed || 0) : 0, marks });
      const frames = [];
      if (page.master) { const ms = L().masters.find(x => x.id === page.master); if (ms) frames.push(...ms.items); }
      frames.push(...page.items);
      const pr = el.getBoundingClientRect();
      for (const f of frames) {
        const fe = el.querySelector(`[data-fid="${f.id}"]`);
        pg.ops.push(await frameOps(w, f, fe, pr));
      }
      host.removeChild(el);
    }
    const bytes = await w.finish();
    await saveFile(safeName(S.store.doc.name, 'layout') + '.pdf', new Blob([bytes], { type: 'application/pdf' }), 'application/pdf');
  } catch (e) { console.error(e); toast('PDF export failed: ' + e.message, 'bad'); }
  finally { host.remove(); }
}
async function frameOps(w, f, fe, pr) {
  const o = []; const x = Math.min(f.x, f.x + f.w), y = Math.min(f.y, f.y + f.h), fw = Math.abs(f.w), fh = Math.abs(f.h); const op = f.opacity ?? 1;
  const rr = (rad) => rad ? PDF.pathOps(G.rectPath(x, y, fw, fh, rad)) : `${x} ${y} ${fw} ${fh} re`;
  if (f.type === 'line') { o.push(PDF.paintOps(w, { stroke: f.stroke || '#1c1a17', sw: f.sw ?? 1, opacity: op, dash: f.dash }, `${f.x} ${f.y} m ${f.x + f.w} ${f.y + f.h} l`)); return o.join('\n'); }
  if (f.type === 'ellipse') { o.push(PDF.paintOps(w, { fill: f.fill, stroke: f.stroke, sw: f.stroke ? f.sw ?? 1 : 0, opacity: op }, PDF.pathOps(G.ellipsePath(x + fw / 2, y + fh / 2, fw / 2 - (f.stroke ? (f.sw ?? 1) / 2 : 0), fh / 2 - (f.stroke ? (f.sw ?? 1) / 2 : 0))))); return o.join('\n'); }
  if (f.fill) o.push(PDF.paintOps(w, { fill: f.fill, opacity: op }, rr(f.radius)));
  if (f.type === 'image' && f.asset) {
    const a = S.store.doc.assets[f.asset];
    if (a) {
      const nw = a.w || 1, nh = a.h || 1; const fit = f.fit || 'fill';
      let dw = fw, dh = fh;
      if (fit !== 'stretch') { const s = fit === 'fill' ? Math.max(fw / nw, fh / nh) : Math.min(fw / nw, fh / nh); dw = nw * s; dh = nh * s; }
      const dx = x + (fw - dw) * (f.fx ?? 0.5), dy = y + (fh - dh) * (f.fy ?? 0.5);
      o.push(`q ${f.radius ? PDF.pathOps(G.rectPath(x, y, fw, fh, f.radius)) + ' W n' : PDF.clipRect(x, y, fw, fh)} ${await PDF.imageOps(w, a.data, dx, dy, dw, dh, op)} Q`);
    }
  }
  if ((f.type === 'view' || f.type === 'drawing') && f.snap) {
    const a = S.store.doc.assets[f.snap];
    if (a?.kind === 'svg') o.push(await svgPlacementOps(w, a.data, x, y, fw, fh, 'meet'));
    else if (a) { const nw = a.w || fw, nh = a.h || fh; const s = f.fit === 'fill' ? Math.max(fw / nw, fh / nh) : Math.min(fw / nw, fh / nh); const dw = nw * s, dh = nh * s; o.push(`q ${PDF.clipRect(x, y, fw, fh)} ${await PDF.imageOps(w, a.data, x + (fw - dw) / 2, y + (fh - dh) / 2, dw, dh, op)} Q`); }
  }
  if (f.type === 'vector' && f.src?.ab) {
    const abs = S.store.doc.vector.artboards; const ab = abs.find(a => a.id === f.src.ab) || abs[0];
    if (ab) {
      const fit = f.fit || 'fit'; let sx = fw / ab.w, sy = fh / ab.h;
      if (fit === 'fit') sx = sy = Math.min(sx, sy); else if (fit === 'fill') sx = sy = Math.max(sx, sy);
      const ox = x + (fw - ab.w * sx) / 2, oy = y + (fh - ab.h * sy) / 2;
      const inner = [];
      if (f.src.bg !== false && ab.bg) inner.push(PDF.paintOps(w, { fill: ab.bg }, `${ab.x} ${ab.y} ${ab.w} ${ab.h} re`));
      inner.push(await PDF.vectorItemsOps(w, S.store.doc.vector.items, S.store.doc.assets));
      o.push(`q ${PDF.clipRect(x, y, fw, fh)} ${PDF.matrixOp([sx, 0, 0, sy, ox - ab.x * sx, oy - ab.y * sy])} ${inner.join('\n')} Q`);
    }
  }
  if (f.type === 'text' && fe) o.push(await textFrameOps(w, fe, pr, op));
  if (f.stroke && (f.sw ?? 1) > 0 && !['line', 'ellipse'].includes(f.type)) o.push(PDF.paintOps(w, { stroke: f.stroke, sw: f.sw ?? 1, opacity: op, dash: f.dash }, rr(f.radius)));
  return o.join('\n');
}
async function svgPlacementOps(w, svgText, x, y, fw, fh) {
  const vb = svgText.match(/viewBox="([^"]+)"/)?.[1]?.split(/[\s,]+/).map(Number) || [0, 0, fw, fh];
  const items = G.svgToSubpathItems(svgText);
  const s = Math.min(fw / vb[2], fh / vb[3]); const ox = x + (fw - vb[2] * s) / 2, oy = y + (fh - vb[3] * s) / 2;
  const inner = items.map(it => PDF.paintOps(w, { fill: it.fill === '#000000' && it.stroke ? null : it.fill, stroke: it.stroke || '#1c1a17', sw: Math.max(0.35 / s, (it.sw || 1)), rule: it.rule, dash: it.dash }, PDF.pathOps(it.subpaths))).join('\n');
  // text labels (dimensions)
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml'); const texts = [];
  for (const t of doc.querySelectorAll('text')) {
    const size = parseFloat(t.getAttribute('font-size') || '10'), tx = parseFloat(t.getAttribute('x') || '0'), ty = parseFloat(t.getAttribute('y') || '0');
    const anchor = t.getAttribute('text-anchor') || 'start', mid = t.getAttribute('dominant-baseline') === 'middle';
    const fn = await PDF.faceFor(w, t.getAttribute('font-family') || 'IBM Plex Mono', parseInt(t.getAttribute('font-weight') || '400', 10), false); const str = t.textContent;
    const wd = PDF.fontWidth(fn, size, str); const x0 = anchor === 'middle' ? tx - wd / 2 : anchor === 'end' ? tx - wd : tx;
    texts.push(PDF.textOps(w, { text: str, x: x0, y: mid ? ty + size * 0.35 : ty, font: fn, size, color: t.getAttribute('fill') || '#1c1a17' }));
  }
  return `q ${PDF.clipRect(x, y, fw, fh)} ${PDF.matrixOp([s, 0, 0, s, ox - vb[0] * s, oy - vb[1] * s])} ${inner}\n${texts.join('\n')} Q`;
}
const metricCache = new Map();
function fontMetrics(cs) {
  const key = cs.fontStyle + cs.fontWeight + cs.fontSize + cs.fontFamily; let m = metricCache.get(key);
  if (!m) { const t = G.measureText('Hg', `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`); m = { asc: t.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8, desc: t.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.2 }; metricCache.set(key, m); }
  return m;
}
async function textFrameOps(w, fe, pr, op) {
  const out = []; const walker = document.createTreeWalker(fe, NodeFilter.SHOW_TEXT); const range = document.createRange();
  const csCache = new Map();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement; let cs = csCache.get(el); if (!cs) { cs = getComputedStyle(el); csCache.set(el, cs); }
    const fn = await PDF.faceFor(w, cs.fontFamily, parseInt(cs.fontWeight, 10) || 400, cs.fontStyle === 'italic');
    const tracking = parseFloat(cs.letterSpacing) || 0;
    const size = parseFloat(cs.fontSize); const mt = fontMetrics(cs); const upper = cs.textTransform === 'uppercase';
    const text = node.data; const re = /\S+/g; let m;
    while ((m = re.exec(text))) {
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
      const rects = [...range.getClientRects()].filter(r => r.width > 0);
      if (!rects.length) continue;
      const emit = (str, r) => { const s2 = upper ? str.toUpperCase() : str; out.push(PDF.textOps(w, { text: s2, x: r.left - pr.left, y: r.top - pr.top + mt.asc, font: fn, size, color: cs.color, opacity: op, targetWidth: r.width, tracking })); };
      if (rects.length === 1) { emit(m[0], rects[0]); continue; }
      // word broken across lines by hyphenation: find the split by character
      let split = -1; const top0 = rects[0].top;
      // Use only real glyph boxes: at a line break the browser also reports a zero-width caret box at the end of the line above.
      for (let i = 1; i < m[0].length; i++) {
        if (m[0][i] === '\u00ad') continue;
        range.setStart(node, m.index + i); range.setEnd(node, m.index + i + 1);
        const rs = [...range.getClientRects()].filter(r => r.width > 0.01); const r = rs[rs.length - 1];
        if (r && Math.abs(r.top - top0) > 2) { split = i; break; }
      }
      if (split > 0) { emit(m[0].slice(0, split) + '-', rects[0]); emit(m[0].slice(split), rects[rects.length - 1]); } else emit(m[0], rects[0]);
    }
  }
  return out.join('\n');
}
async function exportHTML() {
  await document.fonts.ready; computeAllFlows();
  const host = h('div', { style: { position: 'fixed', left: '-100000px', top: '0' } }); document.body.append(host);
  const P0 = L().page; let body = '';
  for (const [i, page] of L().pages.entries()) { const el = pageEl(page, i, { exportMode: true }); host.append(el); body += `<section class="page" style="width:${P0.w}px;height:${P0.h}px">${el.innerHTML}</section>\n`; }
  host.remove();
  const css = `body{margin:0;background:#dcd5c8;display:grid;justify-content:center;gap:24px;padding:24px}.page{position:relative;background:#fff;overflow:hidden;box-shadow:0 0 0 1px #1c1a17}.frame{position:absolute;overflow:hidden}.frame .col{position:absolute;overflow:hidden}${psStyle.textContent}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(S.store.doc.name)}</title><style>${css}</style></head><body>${body}</body></html>`;
  await saveFile(safeName(S.store.doc.name, 'layout') + '.html', html, 'text/html');
}
async function exportDialog() {
  const st = { bleed: true, marks: false, pages: 'all' };
  const ok = await dialog({ title: 'Export PDF', body: (el) => el.append(
    h('p', null, 'Vector PDF with live, selectable text. Fonts map to the PDF standard faces (Helvetica, Times, Courier) with spacing matched to your layout.'),
    h('div', { class: 'fields' }, selectField({ label: 'Pages', value: 'all', options: [['all', 'All pages'], ...L().pages.map((_, i) => [i, `Page ${i + 1} only`])], onChange: v => st.pages = v === 'all' ? 'all' : +v, span: 2 })),
    checkField({ label: `Include ${round(U(L().page.bleed || 0), 1)} ${unit()} bleed`, value: true, onChange: v => st.bleed = v }),
    checkField({ label: 'Crop marks', value: false, onChange: v => st.marks = v })),
    actions: [{ label: 'Cancel', value: false }, { label: 'Export PDF', primary: true, value: true }] });
  if (ok) { toast('Building PDF…'); await exportPDF(st); }
}

// ---------- rail & panel ----------
let toolBtns = {}, zoomLabel;
function setTool(t) {
  tool = t; threadFrom = null;
  for (const [id, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(id === t));
  if (scroller) scroller.style.cursor = t === 'hand' ? 'grab' : t === 'select' ? '' : 'crosshair';
  updateStatus();
}
function buildRail() {
  clear(railEl);
  for (const t of TOOLS) {
    if (t === '-') { railEl.append(h('div', { class: 'rail-sep' })); continue; }
    toolBtns[t.id] = h('button', { class: 'tool', type: 'button', title: t.label, 'aria-label': t.label, 'aria-pressed': String(tool === t.id), html: icon(t.icon) + `<span class="key">${t.key.toUpperCase()}</span>`, onclick: () => setTool(t.id) });
    railEl.append(toolBtns[t.id]);
  }
}
let storyTA = null;
function focusStory() { ctx.openSheet(); setTimeout(() => { storyTA?.focus(); }, 50); }
function setFrame(p, label, live = false) {
  if (!live) S.checkpoint(label);
  for (const loc of selFrames()) Object.assign(loc.frame, p);
  S.changed('layout', { live });
}
function numU(label, val, onChange, opt = {}) { return numField({ label, unit: unit(), value: round(U(val), 3), step: unit() === 'pt' ? 1 : unit() === 'in' ? 0.0625 : 0.5, onChange: v => onChange(P(v)), ...opt }); }
function buildPanel() {
  if (!panelEl) return;
  clear(panelEl); storyTA = null;
  const locs = selFrames();
  if (target.kind === 'master') panelEl.append(pane('Editing master', h('p', { class: 'hint' }, `Changes here appear on every page that uses ${target.id}-Master. Put {page} in a text frame for an automatic page number.`),
    h('button', { class: 'btn primary', type: 'button', onclick: () => { target = { kind: 'doc' }; sel.clear(); fitted = false; fitView(); buildPanel(); } }, 'Done — back to pages')));
  if (locs.length) {
    const f = locs[0].frame;
    panelEl.append(pane(locs.length > 1 ? `${locs.length} frames` : ({ text: 'Text frame', image: 'Image frame', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', vector: 'Vector placement', view: '3D view placement', drawing: 'CAD drawing placement' }[f.type]), h('div', { class: 'fields' },
      numU('X', f.x, v => setFrame({ x: v }, 'Move')), numU('Y', f.y, v => setFrame({ y: v }, 'Move')),
      numU('W', f.w, v => setFrame({ w: v }, 'Resize'), { min: f.type === 'line' ? -Infinity : 0.1 }), numU('H', f.h, v => setFrame({ h: v }, 'Resize'), { min: f.type === 'line' ? -Infinity : 0.1 }))));
    const ap = h('div', { class: 'fields' },
      colorField({ label: 'Fill', value: f.fill, allowNone: true, onInput: c => setFrame({ fill: c }, 'Fill', true), onChange: c => setFrame({ fill: c }, 'Fill') }),
      colorField({ label: 'Stroke', value: f.stroke, allowNone: true, onInput: c => setFrame({ stroke: c }, 'Stroke', true), onChange: c => setFrame({ stroke: c }, 'Stroke') }),
      numField({ label: 'Stroke', unit: 'pt', value: f.sw ?? (f.stroke ? 1 : 0), min: 0, step: 0.25, onChange: v => setFrame({ sw: v }, 'Stroke weight') }),
      f.type !== 'line' && f.type !== 'ellipse' ? numField({ label: 'Corner radius', unit: 'pt', value: f.radius || 0, min: 0, onChange: v => setFrame({ radius: v }, 'Corner radius') }) : textField({ label: 'Dash', value: f.dash || '', span: 1, placeholder: '4 2', onChange: v => setFrame({ dash: v.trim() || null }, 'Dash') }),
      numField({ label: 'Opacity', unit: '%', value: Math.round((f.opacity ?? 1) * 100), min: 0, max: 100, decimals: 0, onChange: v => setFrame({ opacity: v / 100 }, 'Opacity') }));
    panelEl.append(pane('Appearance', ap));
    if (f.type === 'text' && locs.length === 1) {
      const st = L().stories[f.story]; const fl = flowCache.get(f.story); const pos = st ? st.frames.indexOf(f.id) + 1 : 0;
      panelEl.append(pane('Text frame', h('div', { class: 'fields' },
        numField({ label: 'Columns', value: f.cols || 1, min: 1, max: 12, decimals: 0, onChange: v => setFrame({ cols: Math.round(v) }, 'Columns') }),
        numField({ label: 'Gutter', unit: 'pt', value: f.gutter ?? 12, min: 0, onChange: v => setFrame({ gutter: v }, 'Gutter') }),
        numField({ label: 'Inset', unit: 'pt', value: f.inset ?? 0, min: 0, onChange: v => setFrame({ inset: v }, 'Inset') }),
        selectField({ label: 'Vertical', value: f.valign || 'top', options: [['top', 'Top'], ['center', 'Centre'], ['bottom', 'Bottom']], onChange: v => setFrame({ valign: v }, 'Vertical align') })),
        h('p', { class: 'hint' }, `Frame ${pos} of ${st?.frames.length || 0} in this story · ${fl ? fl.N : 0} words${fl?.overset ? ` · ${fl.N - fl.placed} overset` : ' · fits'}`),
        h('div', { class: 'btn-row' },
          fl?.overset ? h('button', { class: 'btn small primary', type: 'button', onclick: () => autoflow(f) }, 'Autoflow pages') : null,
          h('button', { class: 'btn small', type: 'button', onclick: () => { threadFrom = f.id; scroller.style.cursor = 'copy'; updateStatus(); toast('Click a text frame, or an empty spot on a page, to continue the story'); } }, h('span', { html: icon('link', 14) }), 'Thread to…'),
          st && st.frames.indexOf(f.id) < st.frames.length - 1 ? h('button', { class: 'btn small', type: 'button', onclick: () => unthreadAfter(f) }, h('span', { html: icon('unlink', 14) }), 'Break after') : null)));
      if (st) {
        const area = h('textarea', { id: 'lay-story', rows: 14, spellcheck: 'true', 'aria-label': 'Story text' }); area.value = st.text; storyTA = area;
        let editing = false;
        area.addEventListener('focus', () => { editing = false; });
        area.addEventListener('input', debounceLocal(() => { if (!editing) { S.checkpoint('Edit story'); editing = true; } st.text = area.value; S.changed('layout', { live: true }); }, 180));
        area.addEventListener('blur', () => { if (editing) { S.changed('layout'); editing = false; } });
        const insert = (prefix) => { const v = area.value, s = area.selectionStart; const ls = v.lastIndexOf('\n', s - 1) + 1; const line = v.slice(ls).split('\n')[0]; const clean = line.replace(/^(##\s+|#\s+|>\s+|\^\s+|\[[\w-]+\]\s?)/, ''); area.value = v.slice(0, ls) + prefix + clean + v.slice(ls + line.length); area.dispatchEvent(new Event('input')); area.focus(); };
        panelEl.append(pane('Story', h('div', { class: 'btn-row' },
          ...[['Body', ''], ['H1', '# '], ['H2', '## '], ['Quote', '> '], ['Caption', '^ ']].map(([l, p]) => h('button', { class: 'btn small', type: 'button', onclick: () => insert(p) }, l)),
          ...Object.keys(L().styles).filter(id => !['body', 'h1', 'h2', 'quote', 'caption'].includes(id)).map(id => h('button', { class: 'btn small', type: 'button', onclick: () => insert(`[${id}] `) }, L().styles[id].name))),
          h('div', { class: 'field span3' }, area),
          h('p', { class: 'hint' }, 'One paragraph per line. # Heading, ## Subhead, > Pull quote, ^ Caption, [style] any style. **bold**, *italic*, {page} for the page number, {{field}} for data merge.')));
      }
    }
    if (f.type === 'image' && locs.length === 1) {
      const ppi = effectivePPI(f);
      panelEl.append(pane('Image', h('div', { class: 'fields' },
        h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, 'Fitting'), segmented({ value: f.fit || 'fill', options: [{ value: 'fill', label: 'Fill' }, { value: 'fit', label: 'Fit' }, { value: 'stretch', label: 'Stretch' }], onChange: v => setFrame({ fit: v }, 'Fitting') })),
        numField({ label: 'Focus X', unit: '%', value: Math.round((f.fx ?? 0.5) * 100), min: 0, max: 100, decimals: 0, onChange: v => setFrame({ fx: v / 100 }, 'Crop'), onInput: v => setFrame({ fx: v / 100 }, 'Crop', true) }),
        numField({ label: 'Focus Y', unit: '%', value: Math.round((f.fy ?? 0.5) * 100), min: 0, max: 100, decimals: 0, onChange: v => setFrame({ fy: v / 100 }, 'Crop'), onInput: v => setFrame({ fy: v / 100 }, 'Crop', true) })),
        ppi ? h('p', { class: 'hint', style: { color: ppi < 150 ? 'var(--danger)' : '' } }, `Effective resolution: ${ppi} ppi${ppi < 150 ? ' — too low for print' : ppi < 300 ? ' — fine for screen, soft in print' : ' — print ready'}`) : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => replaceImage(f) }, f.asset ? 'Replace image…' : 'Place image…'),
        h('button', { class: 'btn small', type: 'button', onclick: () => placePDF(f) }, 'Place PDF page…')));
    }
    if (f.type === 'vector' && locs.length === 1) {
      panelEl.append(pane('Linked artboard', h('div', { class: 'fields' },
        selectField({ label: 'Artboard', value: f.src?.ab, options: ctx.ws.vector.listArtboards().map(a => [a.id, a.name]), onChange: v => setFrame({ src: { ...f.src, ab: v } }, 'Change artboard'), span: 2 }),
        h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, 'Fitting'), segmented({ value: f.fit || 'fit', options: [{ value: 'fit', label: 'Fit' }, { value: 'fill', label: 'Fill' }, { value: 'stretch', label: 'Stretch' }], onChange: v => setFrame({ fit: v }, 'Fitting') })),
        checkField({ label: 'Artboard background', value: f.src?.bg !== false, onChange: v => setFrame({ src: { ...f.src, bg: v } }, 'Background') })),
        h('p', { class: 'hint' }, 'Live link: edits in Vector show up here immediately, and stay vector in the PDF.')));
    }
    if ((f.type === 'view' || f.type === 'drawing') && locs.length === 1) {
      const opts = f.type === 'drawing' ? [['front', 'Front'], ['top', 'Top'], ['right', 'Right'], ['back', 'Back'], ['left', 'Left'], ['bottom', 'Bottom']] : [['iso', 'Isometric'], ['front', 'Front'], ['top', 'Top'], ['right', 'Right'], ['hero', 'Low hero']];
      panelEl.append(pane(f.type === 'drawing' ? 'Linked CAD drawing' : 'Linked 3D view', h('div', { class: 'fields' },
        f.type === 'view' ? selectField({ label: 'Source', value: f.src?.ws, options: [['cad', 'CAD part'], ['mesh', 'Mesh scene']], onChange: v => { setFrame({ src: { ...f.src, ws: v } }, 'Source'); updatePlacement(findFrame(f.id).frame); } }) : null,
        selectField({ label: 'View', value: f.src?.angle, options: opts, onChange: v => { setFrame({ src: { ...f.src, angle: v } }, 'View'); updatePlacement(findFrame(f.id).frame); } })),
        h('button', { class: 'btn small', type: 'button', onclick: () => updatePlacement(f) }, h('span', { html: icon('rotate', 14) }), 'Update from source')));
    }
    panelEl.append(pane('Arrange', h('div', { class: 'btn-grid' },
      h('button', { class: 'btn small', type: 'button', onclick: () => arrangeFrames('front') }, 'To front'), h('button', { class: 'btn small', type: 'button', onclick: () => arrangeFrames('forward') }, 'Forward'),
      h('button', { class: 'btn small', type: 'button', onclick: () => arrangeFrames('backward') }, 'Backward'), h('button', { class: 'btn small', type: 'button', onclick: () => arrangeFrames('back') }, 'To back'),
      h('button', { class: 'btn small', type: 'button', onclick: duplicateFrames }, 'Duplicate'), h('button', { class: 'btn small danger', type: 'button', onclick: deleteFrames }, 'Delete'))));
    return;
  }
  // nothing selected: document, pages, styles, preflight, output
  const P0 = L().page;
  const setDoc = (fn, label) => { S.checkpoint(label); fn(L()); flowCache.clear(); S.changed('layout'); buildPanel(); };
  const preset = Object.entries(PAGE_SIZES).find(([, [w, hh]]) => Math.abs(w * G.PT_PER_MM - P0.w) < 0.6 && Math.abs(hh * G.PT_PER_MM - P0.h) < 0.6)?.[0] || 'custom';
  panelEl.append(pane('Document', h('div', { class: 'fields' },
    selectField({ label: 'Page size', value: preset, options: [...Object.keys(PAGE_SIZES).map(k2 => [k2, `${k2} · ${PAGE_SIZES[k2][0]}×${PAGE_SIZES[k2][1]} mm`]), ['custom', 'Custom']], onChange: v => { if (PAGE_SIZES[v]) setDoc(l => { const [w, hh] = PAGE_SIZES[v]; const land = l.page.w > l.page.h; l.page.w = (land ? hh : w) * G.PT_PER_MM; l.page.h = (land ? w : hh) * G.PT_PER_MM; }, 'Page size'); }, span: 2 }),
    numU('Width', P0.w, v => setDoc(l => { l.page.w = v; }, 'Page width'), { min: 10 }), numU('Height', P0.h, v => setDoc(l => { l.page.h = v; }, 'Page height'), { min: 10 }),
    numU('Top margin', P0.margins.t, v => setDoc(l => { l.page.margins.t = v; }, 'Margins'), { min: 0 }), numU('Bottom', P0.margins.b, v => setDoc(l => { l.page.margins.b = v; }, 'Margins'), { min: 0 }),
    numU(L().facing ? 'Inside' : 'Left', P0.margins.i, v => setDoc(l => { l.page.margins.i = v; }, 'Margins'), { min: 0 }), numU(L().facing ? 'Outside' : 'Right', P0.margins.o, v => setDoc(l => { l.page.margins.o = v; }, 'Margins'), { min: 0 }),
    numField({ label: 'Columns', value: P0.cols || 1, min: 1, max: 12, decimals: 0, onChange: v => setDoc(l => { l.page.cols = Math.round(v); }, 'Columns') }), numU('Gutter', P0.gutter || 0, v => setDoc(l => { l.page.gutter = v; }, 'Gutter'), { min: 0 }),
    numU('Bleed', P0.bleed || 0, v => setDoc(l => { l.page.bleed = v; }, 'Bleed'), { min: 0 }),
    selectField({ label: 'Units', value: unit(), options: [['mm', 'Millimetres'], ['pt', 'Points'], ['in', 'Inches'], ['cm', 'Centimetres']], onChange: v => setDoc(l => { l.unit = v; }, 'Units') })),
    h('div', { class: 'btn-row' }, checkField({ label: 'Facing pages (spreads)', value: L().facing, onChange: v => { setDoc(l => { l.facing = v; }, 'Facing pages'); fitView(); } }),
      h('button', { class: 'btn small', type: 'button', onclick: () => setDoc(l => { [l.page.w, l.page.h] = [l.page.h, l.page.w]; }, 'Orientation') }, 'Rotate page'))));
  // pages
  const plist = h('div', { class: 'list' });
  L().pages.forEach((p, i) => plist.append(h('div', { class: 'li', onclick: () => scrollToPage(p.id) },
    h('span', { class: 'meta' }, String(i + 1).padStart(2, '0')), h('span', { class: 'name' }, `${p.items.length} frame${p.items.length === 1 ? '' : 's'} · master ${p.master || 'none'}`),
    h('span', { class: 'acts' },
      h('button', { type: 'button', title: 'Move up', 'aria-label': 'Move page up', html: icon('up', 15), onclick: (e) => { e.stopPropagation(); movePage(i, -1); } }),
      h('button', { type: 'button', title: 'Move down', 'aria-label': 'Move page down', html: icon('down', 15), onclick: (e) => { e.stopPropagation(); movePage(i, 1); } }),
      h('button', { type: 'button', title: 'Page options', 'aria-label': 'Page options', html: icon('menu', 15), onclick: (e) => { e.stopPropagation(); menu(e.currentTarget, [
        { label: 'Duplicate page', icon: 'copy', run: () => addPage(i, true) }, { label: 'Insert page after', icon: 'plus', run: () => addPage(i) },
        ...L().masters.map(m => ({ label: `Apply ${m.id}-Master`, run: () => { S.checkpoint('Apply master'); p.master = m.id; S.changed('layout'); buildPanel(); } })),
        { label: 'No master', run: () => { S.checkpoint('Apply master'); p.master = null; S.changed('layout'); buildPanel(); } },
        '-', { label: 'Delete page', icon: 'trash', run: () => deletePage(i) }]); } })))));
  panelEl.append(pane('Pages', plist, h('div', { class: 'btn-row' },
    h('button', { class: 'btn small', type: 'button', onclick: () => addPage() }, h('span', { html: icon('plus', 14) }), 'Add page'),
    ...L().masters.map(m => h('button', { class: 'btn small', type: 'button', onclick: () => { target = { kind: 'master', id: m.id }; sel.clear(); fitted = false; fitView(); buildPanel(); } }, `Edit ${m.id}-Master`)),
    h('button', { class: 'btn small', type: 'button', onclick: () => { S.checkpoint('New master'); const id = String.fromCharCode(65 + L().masters.length); L().masters.push({ id, name: `${id}-Master`, items: [] }); S.changed('layout'); buildPanel(); } }, 'New master'))));
  panelEl.append(stylesPane());
  // place
  panelEl.append(pane('Place from other workspaces', h('div', { class: 'btn-grid' },
    h('button', { class: 'btn small', type: 'button', onclick: () => placeFrom('vector') }, 'Artboard'),
    h('button', { class: 'btn small', type: 'button', onclick: () => placeFrom('cad', { angle: 'iso' }) }, 'CAD render'),
    h('button', { class: 'btn small', type: 'button', onclick: () => placeFrom('drawing', { angle: 'front' }) }, 'CAD drawing'),
    h('button', { class: 'btn small', type: 'button', onclick: () => placeFrom('mesh', { angle: 'hero' }) }, '3D scene'),
    h('button', { class: 'btn small', type: 'button', onclick: () => placePDF() }, 'PDF page…')),
    h('p', { class: 'hint' }, 'Placements stay linked. Artboards update live; renders and drawings refresh with “Update links”.'),
    h('button', { class: 'btn small', type: 'button', onclick: updateAllPlacements }, h('span', { html: icon('rotate', 14) }), 'Update links')));
  // preflight
  const issues = preflight();
  const pf = h('div', { class: 'list' });
  if (!issues.length) pf.append(h('div', { class: 'li' }, h('span', { class: 'sw', style: { background: 'var(--ok)', borderRadius: '50%' } }), h('span', { class: 'name' }, 'No problems found'), h('span')));
  for (const is of issues) pf.append(h('div', { class: 'li ' + (is.sev === 'err' ? 'err' : 'warn'), onclick: () => { if (is.fid) { const loc = findFrame(is.fid); if (loc) { sel.clear(); sel.add(is.fid); scrollToPage(loc.page.id); renderOverlay(); buildPanel(); } } } },
    h('span', { class: 'meta' }, is.sev === 'err' ? 'ERR' : 'WARN'), h('span', { class: 'name', title: is.text }, is.text), h('span')));
  panelEl.append(pane(`Preflight · ${issues.length ? issues.length + ' issue' + (issues.length === 1 ? '' : 's') : 'clean'}`, pf));
  panelEl.append(pane('Output', h('div', { class: 'btn-grid' },
    h('button', { class: 'btn small primary', type: 'button', onclick: exportDialog }, 'Export PDF'),
    h('button', { class: 'btn small', type: 'button', onclick: exportHTML }, 'Web page'),
    h('button', { class: 'btn small', type: 'button', onclick: dataMerge }, 'Data merge'))));
}
let editStyle = 'body';
function stylesPane() {
  const styles = L().styles; if (!styles[editStyle]) editStyle = 'body';
  const s = styles[editStyle];
  const set = (p, label) => { S.checkpoint(label); Object.assign(styles[editStyle], p); styleVersion++; flowCache.clear(); styleCSS(); S.changed('layout'); };
  return pane('Paragraph styles', h('div', { class: 'fields' },
    selectField({ label: 'Style', value: editStyle, options: Object.entries(styles).map(([id, st]) => [id, st.name]), onChange: v => { editStyle = v; buildPanel(); }, span: 2 }),
    selectField({ label: 'Font', value: s.font, options: allFonts(), onChange: v => set({ font: v }, 'Style font'), span: 2 }),
    numField({ label: 'Size', unit: 'pt', value: s.size, min: 1, step: 0.5, onChange: v => set({ size: v }, 'Style size') }),
    numField({ label: 'Leading', unit: 'pt', value: s.leading, min: 1, step: 0.5, onChange: v => set({ leading: v }, 'Style leading') }),
    numField({ label: 'Weight', value: s.weight, min: 100, max: 900, step: 100, decimals: 0, onChange: v => set({ weight: v }, 'Style weight') }),
    numField({ label: 'Tracking', unit: 'em', value: s.tracking || 0, step: 0.01, onChange: v => set({ tracking: v }, 'Style tracking') }),
    numField({ label: 'Space before', unit: 'pt', value: s.before, min: 0, onChange: v => set({ before: v }, 'Space before') }),
    numField({ label: 'Space after', unit: 'pt', value: s.after, min: 0, onChange: v => set({ after: v }, 'Space after') }),
    numField({ label: 'First indent', unit: 'pt', value: s.indent || 0, min: 0, onChange: v => set({ indent: v }, 'Indent') }),
    colorField({ label: 'Colour', value: s.color, onChange: v => set({ color: v }, 'Style colour') }),
    h('div', { class: 'field span3' }, h('span', { class: 'lbl' }, 'Alignment'), segmented({ value: s.align, options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'justify', label: 'Justify' }], onChange: v => set({ align: v }, 'Alignment') })),
    checkField({ label: 'Italic', value: s.italic, onChange: v => set({ italic: v }, 'Italic') }), checkField({ label: 'Hyphenate', value: s.hyphenate, onChange: v => set({ hyphenate: v }, 'Hyphenation') }),
    checkField({ label: 'All caps', value: s.upper, onChange: v => set({ upper: v }, 'Caps') })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => { const { promptDialog } = await import('../core/ui.js'); const n = await promptDialog('New paragraph style', 'Style name', 'Kicker'); if (!n) return; const id = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid('s'); S.checkpoint('New style'); styles[id] = { ...s, name: n }; editStyle = id; styleVersion++; styleCSS(); S.changed('layout'); buildPanel(); } }, h('span', { html: icon('plus', 14) }), 'New style'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { const f = await pickFile('.ttf,.otf,.woff,.woff2'); if (!f) return; try { const fam = await addFontFile(f); toast(`Added font “${fam}” — it travels inside this document`); buildPanel(); } catch (e) { toast("That font file couldn't be loaded", 'bad'); } } }, 'Add font file…')));
}
function scrollToPage(pid) { const el = pageEls.get(pid); if (el) el.parentElement.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center', inline: 'center' }); }
function debounceLocal(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- workspace interface ----------
export default {
  id: 'layout', label: 'Layout',
  placeFrom: (k, o) => placeFrom(k, o),
  register(c) {
    const r = (id, label, run, keys, tags) => registerCommand({ id: 'layout.' + id, label, run: () => { c.activate('layout'); run(); }, keys, tags, ws: 'layout' });
    r('pdf', 'Export layout as PDF…', exportDialog, null, 'print save press');
    r('html', 'Export layout as web page', exportHTML, null, 'html save');
    r('page', 'Add page', () => addPage(), null, 'new insert');
    r('merge', 'Data merge…', dataMerge, null, 'csv mail merge records');
    r('links', 'Update linked views', updateAllPlacements, null, 'refresh placements');
    r('place-ab', 'Place vector artboard', () => placeFrom('vector'), null, 'link illustration');
    r('place-cad', 'Place CAD render', () => placeFrom('cad'), null, '3d part image');
    r('place-drw', 'Place CAD drawing', () => placeFrom('drawing'), null, 'technical orthographic');
    r('place-mesh', 'Place 3D scene render', () => placeFrom('mesh', { angle: 'hero' }), null, 'image');
    r('place-pdf', 'Place PDF page…', () => placePDF(), null, 'import pdf graphic artwork');
    r('fit', 'Fit spread in view', fitView, null, 'zoom');
  },
  init(c, m) {
    ctx = c; S = c.S; root = m.root; railEl = m.rail; panelEl = m.panel;
    psStyle = document.createElement('style'); psStyle.id = 'kerf-ps'; document.head.append(psStyle);
    scroller = h('div', { class: 'lay-scroll' }); spreadsEl = h('div', { class: 'lay-spreads' }); scroller.append(spreadsEl); root.append(scroller);
    measure = h('div', { class: 'story', lang: 'en', style: { position: 'absolute', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none' } }); document.body.append(measure);
    zoomLabel = h('span', null, '100%');
    root.append(h('div', { class: 'zoom-chip' }, h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => { k = clamp(k / 1.25, 0.1, 6); render(); } }, '−'), zoomLabel,
      h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => { k = clamp(k * 1.25, 0.1, 6); render(); } }, '+'), h('button', { type: 'button', title: 'Fit', 'aria-label': 'Fit spread', onclick: fitView }, '⤢')));
    scroller.addEventListener('pointerdown', onDown); scroller.addEventListener('pointermove', onMove); scroller.addEventListener('pointerup', onUp); scroller.addEventListener('pointercancel', onUp);
    scroller.addEventListener('dblclick', onDbl); scroller.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; scroller.style.cursor = tool === 'hand' ? 'grab' : ''; } });
    scroller.addEventListener('dragover', (e) => e.preventDefault());
    scroller.addEventListener('drop', async (e) => {
      e.preventDefault(); const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (!file) return;
      const pg = pageAt(e.clientX, e.clientY); if (!pg) return;
      const data = await readAsDataURL(file); const img = await loadImage(data);
      const asset = S.addAsset({ kind: 'image', name: file.name, mime: file.type, data, w: img.naturalWidth, h: img.naturalHeight });
      const hit = hitFrame(pg);
      S.commit('Place image', () => {
        if (hit && (hit.type === 'image' || hit.type === 'rect')) { hit.type = 'image'; hit.asset = asset; hit.fit ??= 'fill'; sel.clear(); sel.add(hit.id); }
        else { const w = Math.min(L().page.w * 0.5, img.naturalWidth), hh = w * img.naturalHeight / img.naturalWidth; const f = { id: uid('f'), type: 'image', x: pg.x - w / 2, y: pg.y - hh / 2, w, h: hh, asset, fit: 'fill', fx: 0.5, fy: 0.5 }; pg.page.items.push(f); sel.clear(); sel.add(f.id); }
      }, 'layout'); buildPanel();
    });
    new ResizeObserver(() => { if (!fitted && !root.hidden) fitted = fitView(); }).observe(root);
    styleCSS(); registerFontAssets().then(() => { flowCache.clear(); render(); });
    S.on('kernel-ready', () => fillMissingPlacements(true));
    document.fonts?.ready.then(() => { flowCache.clear(); render(); });
    buildRail(); setTool('select'); render(); buildPanel();
  },
  show() { requestAnimationFrame(() => { if (!fitted) fitted = fitView(); else { flowCache.clear(); vectorVersion++; render(); } buildPanel(); fillMissingPlacements(); }); },
  hide() { threadFrom = null; },
  onDoc() { sel.clear(); target = { kind: 'doc' }; flowCache.clear(); elCache.clear(); parseCache.clear(); styleVersion++; styleCSS(); registerFontAssets().then(() => { flowCache.clear(); render(); }); fitted = false; if (!root.hidden) fitted = fitView(); else render(); buildPanel(); },
  onChange(e) {
    if (e.ws === 'vector') { vectorVersion++; if (!root.hidden) render(); return; }
    if (e.ws && e.ws !== 'layout') return;
    styleCSS(); render();
    if (!e.live) buildPanelSoon();
  },
  status() { return 'Layout'; },
  fileMenu() {
    return [
      { label: 'Export PDF…', icon: 'download', run: exportDialog },
      { label: 'Export as web page (HTML)', icon: 'download', run: exportHTML },
      { label: 'Place PDF page…', icon: 'upload', run: () => placePDF() },
      { label: 'Data merge…', icon: 'merge', run: dataMerge },
      { label: 'Update linked views', icon: 'rotate', run: updateAllPlacements },
    ];
  },
  onKey(e) {
    const mod = e.metaKey || e.ctrlKey, key = e.key;
    if (key === ' ' || e.code === 'Space') { if (!spaceDown) { spaceDown = true; scroller.style.cursor = 'grab'; } e.preventDefault(); return true; }
    if (mod && key.toLowerCase() === 'd') { e.preventDefault(); duplicateFrames(); return true; }
    if (mod && (key === '=' || key === '+')) { e.preventDefault(); k = clamp(k * 1.25, 0.1, 6); render(); return true; }
    if (mod && key === '-') { e.preventDefault(); k = clamp(k / 1.25, 0.1, 6); render(); return true; }
    if (mod && key === '0') { e.preventDefault(); fitView(); return true; }
    if (mod && key === ']') { arrangeFrames(e.shiftKey ? 'front' : 'forward'); return true; }
    if (mod && key === '[') { arrangeFrames(e.shiftKey ? 'back' : 'backward'); return true; }
    if (mod) return false;
    if (key === 'Escape') { if (threadFrom) { threadFrom = null; scroller.style.cursor = ''; updateStatus(); return true; } sel.clear(); renderOverlay(); buildPanel(); return true; }
    if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteFrames(); return true; }
    if (key.startsWith('Arrow') && sel.size) {
      e.preventDefault(); const d = e.shiftKey ? 10 : 1; const dx = key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, dy = key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0;
      S.checkpoint('Nudge'); for (const l of selFrames()) { l.frame.x += dx; l.frame.y += dy; } S.changed('layout'); return true;
    }
    const t = TOOLS.find(x => x !== '-' && x.key === key.toLowerCase()); if (t) { setTool(t.id); return true; }
    return false;
  },
};
const buildPanelSoon = panelRebuilder(() => panelEl, () => buildPanel());
