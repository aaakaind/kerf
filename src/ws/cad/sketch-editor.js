// Constraint sketcher — a full-screen editor for CAD sketch profiles.
// Draw lines, rectangles, circles and arcs; constrain them; dimension them with numbers or #variables.
// PlaneGCS (FreeCAD's solver) keeps the drawing true to its constraints while you drag.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { h, toast } from '../../core/ui.js';
import { tryEval } from '../../core/expr.js';
import { CONS, ORIGIN, byId, ptOf, solveSketch, loadSolver, solverState, sketchLoops, loopPoly, arcMid } from './sketch-core.js';

const NS = 'http://www.w3.org/2000/svg';
const G = { // 24×24 glyphs, same drawing rules as the app icon set
  select: '<path d="M5 3l14 8-6 2-2 6z"/>',
  line: '<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M6.5 17.5l11-11"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/><circle cx="4" cy="6" r="1.6"/><circle cx="20" cy="18" r="1.6"/>',
  circle: '<circle cx="12" cy="12" r="8"/><path d="M12 12h8"/><circle cx="12" cy="12" r="1.2"/>',
  arc: '<path d="M4 18A10 10 0 0 1 20 10"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="10" r="1.6"/><circle cx="13" cy="19" r="1.2"/>',
  constr: '<path d="M3 21L21 3" stroke-dasharray="3 3"/>',
  dim: '<path d="M4 8v8M20 8v8M4 12h16M7 10l-3 2 3 2M17 10l3 2-3 2"/>',
  coinc: '<circle cx="12" cy="12" r="3"/><path d="M4 20l5-5M20 4l-5 5"/>',
  h: '<path d="M4 12h16M4 8v8M20 8v8"/>', v: '<path d="M12 4v16M8 4h8M8 20h8"/>',
  par: '<path d="M7 20L13 4M12 20L18 4"/>', perp: '<path d="M5 19h14M12 19V5"/>', equal: '<path d="M5 9h14M5 15h14"/>',
  tan: '<circle cx="12" cy="14" r="6"/><path d="M3 8h18"/>', mid: '<path d="M3 12h18"/><circle cx="12" cy="12" r="2.5"/>',
  fix: '<path d="M12 3v14M6 12a6 6 0 0 0 12 0M9 6h6"/>', on: '<path d="M3 17L21 7"/><circle cx="12" cy="12" r="2.5"/>',
  hdist: '<path d="M4 6v12M20 6v12M4 12h16"/><path d="M8 9l-4 3 4 3M16 9l4 3-4 3"/>', vdist: '<path d="M6 4h12M6 20h12M12 4v16"/><path d="M9 8l3-4 3 4M9 16l3 4 3-4"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>', fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
};
const glyph = (n, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" aria-hidden="true">${G[n]}</svg>`;
const TOOLS = [['select', 'Select & drag', 'S'], ['line', 'Line — click points; click the first point to close', 'L'], ['rect', 'Rectangle — two corners', 'R'], ['circle', 'Circle — centre, then radius', 'C'], ['arc', 'Arc — centre, start, end', 'A'], ['dim', 'Dimension — click a line, two points, a circle or two lines', 'D']];
const CTOOLS = [['coinc', 'I'], ['h', 'H'], ['v', 'V'], ['par', 'P'], ['perp', 'X'], ['equal', 'E'], ['tan', 'T'], ['mid', 'M'], ['on', 'O'], ['fix', 'F'], ['hdist', ''], ['vdist', ''], ['constr', 'Q']];
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Open the sketcher. getVals() returns the CAD variable values (for #expressions).
 * Resolves with the edited sketch {ents, cons, seq} on Done, or null on Cancel.
 */
export function openSketcher({ sketch, title = 'Sketch', plane = 'XY', getVals = () => ({}) }) {
  return new Promise((resolve) => {
    let sk = clone(sketch); sk.seq ??= 1; sk.ents ??= []; sk.cons ??= [];
    let diag = { ok: true, dof: null, conflicting: [], redundant: [], errors: {} };
    let tool = 'select', sel = new Set(), pending = [], hover = null, cursor = null, infer = null, chainStart = null, arcSpin = 0;
    const undo = [];
    const view = { x: 20, y: 15, s: 6 };
    const nid = (p) => `${p}${sk.seq++}`;
    const M = () => byId(sk);

    // ---------- DOM ----------
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'sk-canvas'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Sketch canvas');
    const dofBig = h('div', { class: 'sk-dof', 'aria-live': 'polite' });
    const statusEl = h('div', { class: 'sk-status' });
    const consList = h('div', { class: 'sk-cons' });
    const toolBtns = {};
    const toolbar = h('div', { class: 'sk-tools', role: 'toolbar', 'aria-label': 'Sketch tools' },
      ...TOOLS.map(([id, label, key]) => (toolBtns[id] = h('button', { type: 'button', class: 'sk-tool', title: `${label} (${key})`, 'aria-label': label, 'aria-pressed': 'false', html: glyph(id) + `<span class="k">${key}</span>`, onclick: () => setTool(id) }))),
      h('div', { class: 'sk-sep' }),
      ...CTOOLS.map(([id, key]) => h('button', { type: 'button', class: 'sk-tool c', title: `${id === 'constr' ? 'Construction geometry (not part of the profile)' : CONS[id].label}${key ? ` (${key})` : ''}`, 'aria-label': id === 'constr' ? 'Toggle construction' : CONS[id].label, html: glyph(id) + (key ? `<span class="k">${key}</span>` : ''), onclick: () => (id === 'constr' ? toggleConstruction() : applyConstraint(id)) })),
      h('div', { class: 'sk-sep' }),
      h('button', { type: 'button', class: 'sk-tool', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', html: glyph('undo'), onclick: () => doUndo() }),
      h('button', { type: 'button', class: 'sk-tool', title: 'Fit view (F)', 'aria-label': 'Fit view', html: glyph('fit'), onclick: () => { fit(); draw(); } }));
    const dimInput = h('input', { class: 'sk-diminput', type: 'text', spellcheck: 'false', autocomplete: 'off', hidden: true, 'aria-label': 'Dimension value' });
    const stage = h('div', { class: 'sk-stage' }, svg, dimInput, dofBig);
    const side = h('aside', { class: 'sk-side' }, h('h3', null, 'Constraints'), consList,
      h('p', { class: 'hint' }, 'Dimensions take numbers or #variables from the CAD Variables pane (“#w/2 + 3 mm”). Blue geometry can still move; ink geometry is fully defined.'));
    const btnDone = h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, 'Done');
    const head = h('header', { class: 'sk-head' },
      h('div', { class: 'sk-title' }, h('b', null, title), h('span', null, `${plane} plane · mm · PlaneGCS solver`)),
      h('div', { class: 'sk-acts' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, 'Cancel'), btnDone));
    const root = h('div', { class: 'sketcher', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Sketch editor — ${title}` }, head, h('div', { class: 'sk-body' }, toolbar, stage, side), statusEl);
    document.body.append(root);
    const prevFocus = document.activeElement; root.tabIndex = -1; root.focus();

    // ---------- coordinates ----------
    const W = () => svg.clientWidth || 800, H = () => svg.clientHeight || 600;
    const toS = ([x, y]) => [(x - view.x) * view.s + W() / 2, -(y - view.y) * view.s + H() / 2];
    const toW = (sx, sy) => [(sx - W() / 2) / view.s + view.x, -(sy - H() / 2) / view.s + view.y];
    function gridStep() { const st = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]; return st.find(v => v * view.s >= 12) || 1000; }
    function fit() {
      const m = M(); const pts = [[0, 0]];
      for (const e of sk.ents) { if (e.t === 'pt') pts.push([e.x, e.y]); if (e.t === 'circle' || e.t === 'arc') { const c = ptOf(m, e.c); pts.push([c[0] - e.r, c[1] - e.r], [c[0] + e.r, c[1] + e.r]); } }
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const w = Math.max(x1 - x0, 20), hh = Math.max(y1 - y0, 20);
      view.x = (x0 + x1) / 2; view.y = (y0 + y1) / 2; view.s = Math.min(W() / (w * 1.5), H() / (hh * 1.5));
    }

    // ---------- solve ----------
    let freeIds = new Set();
    function solve(drag) {
      const r = solveSketch(sk, getVals(), drag ? { drag } : {});
      if (r.solved && (!drag || r.status === 0 || r.status === 1)) sk = r.sk;
      diag = r; if (!drag) { probeFreedom(); renderSide(); }
      draw();
      return r;
    }
    /** Which points can still move? Nudge each one with a temporary pull and see whether the solver lets it go. */
    function probeFreedom() {
      freeIds = new Set(); if (!diag.solved || !(diag.dof > 0) || sk.ents.length > 400) return;
      const m = M(); const vals = getVals();
      for (const e of sk.ents) {
        if (e.t !== 'pt') continue;
        const r = solveSketch(sk, vals, { drag: { id: e.id, x: e.x + 0.7, y: e.y + 0.45 } });
        const q = r.sk.ents.find(x => x.id === e.id); if (q && Math.hypot(q.x - e.x, q.y - e.y) > 1e-5) freeIds.add(e.id);
      }
      const sized = new Set(sk.cons.filter(c => ['radius', 'diam', 'equal', 'tan', 'on'].includes(c.t)).flatMap(c => c.refs));
      for (const e of sk.ents) {
        if (e.t === 'line' && (freeIds.has(e.a) || freeIds.has(e.b))) freeIds.add(e.id);
        if ((e.t === 'circle' || e.t === 'arc') && (freeIds.has(e.c) || freeIds.has(e.a) || freeIds.has(e.b) || (e.t === 'circle' && !sized.has(e.id)))) freeIds.add(e.id);
      }
      void m;
    }
    function snapshot() { undo.push(JSON.stringify(sk)); if (undo.length > 200) undo.shift(); }
    function doUndo() { const s = undo.pop(); if (!s) return; sk = JSON.parse(s); sel.clear(); pending = []; chainStart = null; solve(); }

    // ---------- picking ----------
    const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    function arcContains(m, e, wp) { const c = ptOf(m, e.c); let a0 = Math.atan2(ptOf(m, e.a)[1] - c[1], ptOf(m, e.a)[0] - c[0]), a1 = Math.atan2(ptOf(m, e.b)[1] - c[1], ptOf(m, e.b)[0] - c[0]), t = Math.atan2(wp[1] - c[1], wp[0] - c[0]); if (a1 <= a0) a1 += Math.PI * 2; if (t < a0) t += Math.PI * 2; return t <= a1; }
    function pick(sx, sy, { points = true, curves = true, exclude = new Set() } = {}) {
      const m = M(); const p = [sx, sy]; let best = null, bd = 9;
      if (points) for (const e of [...m.values()]) { if (e.t !== 'pt' || exclude.has(e.id)) continue; const d = Math.hypot(...toS([e.x, e.y]).map((v, i) => v - p[i])); if (d < bd) { bd = d; best = { kind: 'pt', id: e.id }; } }
      if (best) return best; bd = 7;
      if (curves) for (const e of sk.ents) {
        if (exclude.has(e.id)) continue; let d = Infinity;
        if (e.t === 'line') d = segDist(p, toS(ptOf(m, e.a)), toS(ptOf(m, e.b)));
        else if (e.t === 'circle' || e.t === 'arc') { const c = toS(ptOf(m, e.c)); d = Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - e.r * view.s); if (e.t === 'arc' && !arcContains(m, e, toW(sx, sy))) d = Infinity; }
        if (d < bd) { bd = d; best = { kind: 'ent', id: e.id }; }
      }
      if (best) return best;
      for (const el of svg.querySelectorAll('[data-con]')) { const r = el.getBoundingClientRect(), o = svg.getBoundingClientRect(); if (sx >= r.left - o.left - 3 && sx <= r.right - o.left + 3 && sy >= r.top - o.top - 3 && sy <= r.bottom - o.top + 3) return { kind: 'con', id: el.dataset.con }; }
      return null;
    }
    function snapPoint(sx, sy, alt, exclude) {
      const hit = pick(sx, sy, { curves: true, exclude });
      if (hit?.kind === 'pt') { const e = M().get(hit.id); return { x: e.x, y: e.y, pid: hit.id }; }
      let [x, y] = toW(sx, sy); if (!alt) { const g = gridStep(); x = Math.round(x / g) * g; y = Math.round(y / g) * g; }
      if (hit?.kind === 'ent') { // project onto the curve and remember it for a point-on constraint
        const m = M(), e = M().get(hit.id); const wp = toW(sx, sy);
        if (e.t === 'line') { const a = ptOf(m, e.a), b = ptOf(m, e.b); const dx = b[0] - a[0], dy = b[1] - a[1]; const t = ((wp[0] - a[0]) * dx + (wp[1] - a[1]) * dy) / (dx * dx + dy * dy || 1); x = a[0] + t * dx; y = a[1] + t * dy; }
        else { const c = ptOf(m, e.c); const t = Math.atan2(wp[1] - c[1], wp[0] - c[0]); x = c[0] + e.r * Math.cos(t); y = c[1] + e.r * Math.sin(t); }
        return { x, y, on: hit.id };
      }
      return { x, y };
    }
    function ensurePoint(sp) { if (sp.pid) return sp.pid; const id = nid('p'); sk.ents.push({ id, t: 'pt', x: sp.x, y: sp.y }); if (sp.on) sk.cons.push({ id: nid('k'), t: 'on', refs: [id, sp.on] }); return id; }

    // ---------- drawing tools ----------
    function setTool(t) {
      tool = t; pending = []; chainStart = null; infer = null; arcSpin = 0;
      for (const [k, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(k === t));
      if (t === 'dim' && sel.size) { dimensionFrom([...sel]); sel.clear(); tool = 'select'; toolBtns.dim.setAttribute('aria-pressed', 'false'); toolBtns.select.setAttribute('aria-pressed', 'true'); }
      hintFor(); draw();
    }
    function hintFor(extra) {
      const H = { select: 'Click to select · Shift-click to add · drag points to test the constraints · Delete removes', line: chainStart ? 'Next point · click the first point to close · Esc ends the chain' : 'Click the first point', rect: pending.length ? 'Click the opposite corner' : 'Click the first corner', circle: pending.length ? 'Click to set the radius' : 'Click the centre', arc: pending.length === 0 ? 'Click the centre' : pending.length === 1 ? 'Click the start point' : 'Click the end point (sweep counter-clockwise)', dim: pending.length ? 'Click the second point or line' : 'Click a line, a point, a circle or an arc · for an angle, select two lines and press D' }[tool];
      const c = cursor ? `U ${round(cursor[0], 2).toFixed(2)}  V ${round(cursor[1], 2).toFixed(2)} mm` : '';
      statusEl.innerHTML = `<span>${c}</span><span>${extra || H || ''}</span><span>grid ${gridStep()} mm · Alt = no snap · wheel = zoom · drag empty = pan</span>`;
    }
    function lineTo(sp) {
      const from = chainStart.last; const fp = M().get(from);
      let { x, y } = sp; let autoH = false, autoV = false;
      if (!sp.pid) { const dx = x - fp.x, dy = y - fp.y; const a = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI); if (Math.abs(dy) > 1e-9 && (a < 4 || a > 176)) { y = fp.y; autoH = true; } else if (Math.abs(dx) > 1e-9 && Math.abs(a - 90) < 4) { x = fp.x; autoV = true; } }
      else { const dx = x - fp.x, dy = y - fp.y; if (Math.abs(dy) < 1e-6 && Math.abs(dx) > 1e-6) autoH = true; else if (Math.abs(dx) < 1e-6 && Math.abs(dy) > 1e-6) autoV = true; }
      if (sp.pid === from) return;
      snapshot();
      const to = ensurePoint({ ...sp, x, y }); const lid = nid('l');
      sk.ents.push({ id: lid, t: 'line', a: from, b: to });
      if (autoH) sk.cons.push({ id: nid('k'), t: 'h', refs: [lid] }); else if (autoV) sk.cons.push({ id: nid('k'), t: 'v', refs: [lid] });
      if (to === chainStart.first) chainStart = null; else chainStart.last = to; // landing on the first point closes the loop
      solve();
    }
    function place(sx, sy, alt) {
      const sp = snapPoint(sx, sy, alt);
      if (tool === 'line') {
        if (!chainStart) { snapshot(); const p = ensurePoint(sp); chainStart = { first: p, last: p }; solve(); }
        else lineTo(sp);
      } else if (tool === 'rect') {
        if (!pending.length) { pending = [sp]; }
        else {
          const a = pending[0]; pending = []; if (Math.abs(sp.x - a.x) < 1e-6 || Math.abs(sp.y - a.y) < 1e-6) return;
          snapshot();
          const p1 = ensurePoint(a), p3 = ensurePoint(sp); const p2 = ensurePoint({ x: sp.x, y: a.y }), p4 = ensurePoint({ x: a.x, y: sp.y });
          const ls = [[p1, p2], [p2, p3], [p3, p4], [p4, p1]].map(([u, w]) => { const id = nid('l'); sk.ents.push({ id, t: 'line', a: u, b: w }); return id; });
          sk.cons.push({ id: nid('k'), t: 'h', refs: [ls[0]] }, { id: nid('k'), t: 'v', refs: [ls[1]] }, { id: nid('k'), t: 'h', refs: [ls[2]] }, { id: nid('k'), t: 'v', refs: [ls[3]] });
          solve();
        }
      } else if (tool === 'circle') {
        if (!pending.length) pending = [sp];
        else { const c = pending[0]; pending = []; const r = Math.hypot(sp.x - c.x, sp.y - c.y); if (r < 1e-6) return; snapshot(); const cid = ensurePoint(c); sk.ents.push({ id: nid('c'), t: 'circle', c: cid, r }); solve(); }
      } else if (tool === 'arc') {
        if (pending.length < 2) { pending.push(sp); arcSpin = 0; }
        else {
          const [c, s] = pending; pending = []; const r = Math.hypot(s.x - c.x, s.y - c.y); if (r < 1e-6) return;
          const t = Math.atan2(sp.y - c.y, sp.x - c.x); const e = sp.pid ? sp : { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t), on: sp.on };
          snapshot(); const cid = ensurePoint(c); let a = ensurePoint(s), b = ensurePoint(e);
          if (arcSpin < 0) [a, b] = [b, a]; // drawn clockwise: store it counter-clockwise
          sk.ents.push({ id: nid('a'), t: 'arc', c: cid, a, b, r });
          solve();
        }
      } else if (tool === 'dim') {
        const hit = pick(sx, sy); if (!hit || hit.kind === 'con') return;
        pending.push(hit.id);
        const kinds = pending.map(id => M().get(id)?.t);
        if (pending.length === 1 && kinds[0] !== 'pt') { dimensionFrom(pending); pending = []; }
        else if (pending.length === 2) { dimensionFrom(pending); pending = []; }
      }
      hintFor(); draw();
    }

    // ---------- constraints ----------
    const kindOf = (id) => M().get(id)?.t;
    function measure(t, refs) {
      const m = M(); const [a, b] = refs;
      const P = (id) => ptOf(m, id);
      if (t === 'dist') { if (kindOf(a) === 'line' && !b) { const l = m.get(a); return Math.hypot(...P(l.b).map((v, i) => v - P(l.a)[i])); } if (kindOf(b) === 'line') { const l = m.get(b); const p = P(a), u = P(l.a), w = P(l.b); const dx = w[0] - u[0], dy = w[1] - u[1]; return Math.abs((p[0] - u[0]) * dy - (p[1] - u[1]) * dx) / (Math.hypot(dx, dy) || 1); } return Math.hypot(...P(b).map((v, i) => v - P(a)[i])); }
      if (t === 'hdist' || t === 'vdist') { const k = t === 'hdist' ? 0 : 1; const [u, w] = kindOf(a) === 'line' ? [m.get(a).a, m.get(a).b] : [a, b]; return P(w)[k] - P(u)[k]; }
      if (t === 'radius') return m.get(a).r; if (t === 'diam') return m.get(a).r * 2;
      if (t === 'angle') { const l1 = m.get(a), l2 = m.get(b); const d1 = P(l1.b).map((v, i) => v - P(l1.a)[i]), d2 = P(l2.b).map((v, i) => v - P(l2.a)[i]); let an = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]); while (an <= -Math.PI) an += 2 * Math.PI; while (an > Math.PI) an -= 2 * Math.PI; return (an * 180) / Math.PI; }
      return 0;
    }
    function dimensionFrom(ids) {
      const k = ids.map(kindOf); let t = null, refs = ids;
      if (ids.length === 1 && k[0] === 'line') t = 'dist';
      else if (ids.length === 1 && k[0] === 'circle') t = 'diam';
      else if (ids.length === 1 && k[0] === 'arc') t = 'radius';
      else if (ids.length === 2 && k[0] === 'pt' && k[1] === 'pt') t = 'dist';
      else if (ids.length === 2 && k[0] === 'line' && k[1] === 'line') t = 'angle';
      else if (ids.length === 2 && (k[0] === 'pt') !== (k[1] === 'pt') && k.includes('line')) { t = 'dist'; refs = k[0] === 'pt' ? ids : [ids[1], ids[0]]; }
      if (!t) { toast('Dimension: pick one line, circle or arc — or two points, two lines, or a point and a line', 'bad'); return; }
      addDimension(t, refs);
    }
    function outward(t, refs) { // which side of the geometry a new dimension line goes: away from the sketch's middle
      const m = M(); const pts = sk.ents.filter(e => e.t === 'pt'); if (!pts.length) return 1;
      const cx = pts.reduce((a, e) => a + e.x, 0) / pts.length, cy = pts.reduce((a, e) => a + e.y, 0) / pts.length;
      const [r0, r1] = refs; const [a, b] = m.get(r0)?.t === 'line' ? [ptOf(m, m.get(r0).a), ptOf(m, m.get(r0).b)] : [ptOf(m, r0), ptOf(m, r1 || r0)];
      const mid = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy];
      if (t === 'hdist') return mid[1] >= 0 ? 1 : -1; if (t === 'vdist') return mid[0] >= 0 ? 1 : -1;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      return mid[0] * n[0] + mid[1] * n[1] >= 0 ? 1 : -1;
    }
    function addDimension(t, refs) {
      let v = measure(t, refs); if (t !== 'angle' && t !== 'hdist' && t !== 'vdist') v = Math.abs(v);
      snapshot();
      const c = { id: nid('k'), t, refs, v: t === 'angle' ? `${round(v, 2)}` : `${round(v, 2)} mm`, off: (outward(t, refs) * 22) / view.s };
      sk.cons.push(c); const r = solve();
      if (r.conflicting?.includes(c.id)) { sk.cons = sk.cons.filter(x => x.id !== c.id); undo.pop(); solve(); toast('That dimension would over-constrain the sketch — it already follows from other constraints', 'bad'); return; }
      requestAnimationFrame(() => editDim(c.id));
    }
    function applyConstraint(t) {
      const ids = [...sel]; const k = ids.map(kindOf); const add = (tt, refs) => sk.cons.push({ id: nid('k'), t: tt, refs });
      const lines = ids.filter((_, i) => k[i] === 'line'), pts = ids.filter((_, i) => k[i] === 'pt'), rounds = ids.filter((_, i) => k[i] === 'circle' || k[i] === 'arc');
      const bad = (msg) => { toast(`${CONS[t]?.label || t}: ${msg}`, 'bad'); };
      if (t === 'hdist' || t === 'vdist') { if (lines.length === 1 && ids.length === 1) addDimension(t, lines); else if (pts.length === 2 && ids.length === 2) addDimension(t, pts); else bad('select one line or two points'); return; }
      snapshot(); const before = sk.cons.length;
      switch (t) {
        case 'coinc': if (pts.length >= 2) for (let i = 1; i < pts.length; i++) add('coinc', [pts[0], pts[i]]); else if (pts.length === 1 && lines.length + rounds.length === 1) add('on', [pts[0], lines[0] || rounds[0]]); else bad('select two points'); break;
        case 'h': case 'v': if (lines.length && lines.length === ids.length) lines.forEach(l => add(t, [l])); else if (pts.length === 2 && ids.length === 2) add(t, pts); else bad('select lines, or two points'); break;
        case 'par': case 'perp': if (lines.length >= 2 && lines.length === ids.length) for (let i = 1; i < lines.length; i++) add(t, [lines[0], lines[i]]); else bad('select two lines'); break;
        case 'equal': if (lines.length >= 2 && lines.length === ids.length) for (let i = 1; i < lines.length; i++) add(t, [lines[0], lines[i]]); else if (rounds.length >= 2 && rounds.length === ids.length) for (let i = 1; i < rounds.length; i++) add(t, [rounds[0], rounds[i]]); else bad('select two lines, or two circles/arcs'); break;
        case 'tan': if (ids.length === 2 && rounds.length >= 1 && lines.length + rounds.length === 2) add(t, lines.length ? [lines[0], rounds[0]] : rounds); else bad('select a line and a circle/arc, or two circles/arcs'); break;
        case 'mid': if (pts.length === 1 && lines.length === 1 && ids.length === 2) add(t, [pts[0], lines[0]]); else bad('select a point and a line'); break;
        case 'on': if (pts.length === 1 && ids.length === 2 && lines.length + rounds.length === 1) add(t, [pts[0], lines[0] || rounds[0]]); else bad('select a point and a line, circle or arc'); break;
        case 'fix': if (pts.length && pts.length === ids.length) pts.filter(p => p !== ORIGIN).forEach(p => add(t, [p])); else bad('select points'); break;
      }
      if (sk.cons.length === before) { undo.pop(); return; }
      const added = sk.cons.slice(before).map(c => c.id); const r = solve();
      if (added.some(id => r.conflicting?.includes(id))) { sk.cons = sk.cons.filter(c => !added.includes(c.id)); undo.pop(); solve(); toast(`${CONS[t].label} would over-constrain the sketch — nothing added`, 'bad'); return; }
      sel.clear(); draw();
    }
    function toggleConstruction() { const ents = [...sel].map(id => M().get(id)).filter(e => e && e.t !== 'pt' && !e.origin); if (!ents.length) { toast('Select lines, circles or arcs to make them construction geometry', 'bad'); return; } snapshot(); const on = !ents.every(e => e.constr); for (const e of sk.ents) if (sel.has(e.id) && e.t !== 'pt') e.constr = on; solve(); }
    function deleteSel() {
      if (!sel.size) return; snapshot();
      const kill = new Set([...sel].filter(id => id !== ORIGIN));
      for (const e of sk.ents) if (kill.has(e.id) && e.t === 'pt') for (const f of sk.ents) if ([f.a, f.b, f.c].includes(e.id)) kill.add(f.id);
      // a deleted curve takes its endpoints with it unless something else still uses them
      const users = (pid) => sk.ents.filter(f => !kill.has(f.id) && [f.a, f.b, f.c].includes(pid)).length;
      for (const e of sk.ents) if (kill.has(e.id) && e.t !== 'pt') for (const p of [e.a, e.b, e.c]) if (p && p !== ORIGIN && !users(p)) kill.add(p);
      sk.ents = sk.ents.filter(e => !kill.has(e.id));
      sk.cons = sk.cons.filter(c => !kill.has(c.id) && c.refs.every(r => r === ORIGIN || sk.ents.some(e => e.id === r)));
      sel.clear(); chainStart = null; solve();
    }

    // ---------- dimension editing ----------
    let editing = null;
    function editDim(cid) {
      const c = sk.cons.find(x => x.id === cid); const el = svg.querySelector(`[data-con="${cid}"]`); if (!c || !el) return;
      const r = el.getBoundingClientRect(), o = stage.getBoundingClientRect();
      editing = cid; dimInput.hidden = false; dimInput.value = c.v; dimInput.style.left = `${r.left - o.left + r.width / 2}px`; dimInput.style.top = `${r.top - o.top + r.height / 2}px`;
      dimInput.focus(); dimInput.select(); checkDim();
    }
    function checkDim() { const r = tryEval(dimInput.value, getVals()); dimInput.classList.toggle('bad', !r.ok); dimInput.title = r.ok ? `= ${round(r.value, 3)}` : r.error; }
    function commitDim(keep) {
      if (!editing) return; const c = sk.cons.find(x => x.id === editing); editing = null; dimInput.hidden = true; root.focus();
      if (!c || !keep) { draw(); return; }
      const r = tryEval(dimInput.value, getVals()); if (!r.ok) { toast('Dimension: ' + r.error, 'bad'); draw(); return; }
      const old = c.v; snapshot(); c.v = dimInput.value.trim(); const s = solve();
      if (!s.ok && s.solved) { toast(s.conflicting.length ? 'Those dimensions conflict — reverted' : 'The sketch cannot reach that size — reverted', 'bad'); c.v = old; undo.pop(); solve(); }
    }
    dimInput.addEventListener('input', checkDim);
    dimInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commitDim(true); } if (e.key === 'Escape') { e.preventDefault(); commitDim(false); } });
    dimInput.addEventListener('blur', () => { if (editing) commitDim(true); });

    // ---------- render ----------
    let raf = 0; function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
    const fmt = (c) => { const plain = /^-?[\d.]+\s*(mm|°)?$/.test(String(c.v).trim()); const r = tryEval(String(c.v), getVals()); const val = r.ok ? round(Math.abs(r.value), 2) : '⚠'; const pre = c.t === 'radius' ? 'R' : c.t === 'diam' ? 'Ø' : ''; const suf = c.t === 'angle' ? '°' : ''; return plain ? `${pre}${val}${suf}` : `${pre}${String(c.v).trim()} = ${val}${suf}`; };
    function render() {
      const m = M(); const w = W(), hh = H(); const over = diag.conflicting?.length > 0; const isFree = (id) => freeIds.has(id);
      const cls = (id) => `${sel.has(id) ? ' sel' : ''}${hover?.id === id ? ' hov' : ''}`;
      let s = '';
      // exposed grid
      const g = gridStep(), major = g * 5; const [wx0, wy1] = toW(0, 0), [wx1, wy0] = toW(w, hh);
      let gp = '', gm = '';
      for (let x = Math.ceil(wx0 / g) * g; x <= wx1; x += g) { const sx = toS([x, 0])[0]; (Math.abs(x / major - Math.round(x / major)) < 1e-6 ? (gm += `M${sx} 0V${hh}`) : (gp += `M${sx} 0V${hh}`)); }
      for (let y = Math.ceil(wy0 / g) * g; y <= wy1; y += g) { const sy = toS([0, y])[1]; (Math.abs(y / major - Math.round(y / major)) < 1e-6 ? (gm += `M0 ${sy}H${w}`) : (gp += `M0 ${sy}H${w}`)); }
      const o = toS([0, 0]);
      s += `<path class="g1" d="${gp}"/><path class="g2" d="${gm}"/><path class="ax" d="M0 ${o[1]}H${w}M${o[0]} 0V${hh}"/>`;
      // profile fill (shows exactly what will be extruded)
      try { const L = sketchLoops(sk).loops; if (L.length) s += `<path class="fill" fill-rule="evenodd" d="${L.map(l => 'M' + loopPoly(l, 48).map(p => toS(p).map(v => round(v, 1)).join(' ')).join('L') + 'Z').join('')}"/>`; } catch { /* drawing in progress */ }
      // curves
      for (const e of sk.ents) {
        const k = `geo${e.constr ? ' constr' : ''}${isFree(e.id) ? ' free' : ''}${cls(e.id)}`;
        if (e.t === 'line') { const a = toS(ptOf(m, e.a)), b = toS(ptOf(m, e.b)); s += `<line class="${k}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`; }
        else if (e.t === 'circle') { const c = toS(ptOf(m, e.c)); s += `<circle class="${k}" cx="${c[0]}" cy="${c[1]}" r="${e.r * view.s}"/>`; }
        else if (e.t === 'arc') { const a = toS(ptOf(m, e.a)), b = toS(ptOf(m, e.b)); const mid = toS(arcMid({ from: ptOf(m, e.a), to: ptOf(m, e.b), c: ptOf(m, e.c), r: e.r, ccw: true })); const R = e.r * view.s; const c = ptOf(m, e.c); let a0 = Math.atan2(ptOf(m, e.a)[1] - c[1], ptOf(m, e.a)[0] - c[0]), a1 = Math.atan2(ptOf(m, e.b)[1] - c[1], ptOf(m, e.b)[0] - c[0]); if (a1 <= a0) a1 += Math.PI * 2; s += `<path class="${k}" d="M${a[0]} ${a[1]}A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${b[0]} ${b[1]}"/>`; void mid; }
      }
      // rubber band
      if (cursor) {
        const cs = toS(cursor);
        if (tool === 'line' && chainStart) { const a = toS(ptOf(m, chainStart.last)); s += `<line class="rubber" x1="${a[0]}" y1="${a[1]}" x2="${cs[0]}" y2="${cs[1]}"/>`; if (infer) s += `<text class="infer" x="${cs[0] + 12}" y="${cs[1] - 10}">${infer}</text>`; const L = Math.hypot(...toW(...cs).map((v, i) => v - ptOf(m, chainStart.last)[i])); s += `<text class="meas" x="${cs[0] + 12}" y="${cs[1] + 18}">${round(L, 2)} mm</text>`; }
        if (tool === 'rect' && pending.length) { const a = toS([pending[0].x, pending[0].y]); s += `<rect class="rubber" x="${Math.min(a[0], cs[0])}" y="${Math.min(a[1], cs[1])}" width="${Math.abs(cs[0] - a[0])}" height="${Math.abs(cs[1] - a[1])}"/><text class="meas" x="${cs[0] + 12}" y="${cs[1] + 18}">${round(Math.abs(cursor[0] - pending[0].x), 2)} × ${round(Math.abs(cursor[1] - pending[0].y), 2)}</text>`; }
        if (tool === 'circle' && pending.length) { const a = toS([pending[0].x, pending[0].y]); const R = Math.hypot(cs[0] - a[0], cs[1] - a[1]); s += `<circle class="rubber" cx="${a[0]}" cy="${a[1]}" r="${R}"/><text class="meas" x="${cs[0] + 12}" y="${cs[1] + 18}">Ø ${round((R / view.s) * 2, 2)}</text>`; }
        if (tool === 'arc' && pending.length) { const a = toS([pending[0].x, pending[0].y]); if (pending.length === 1) s += `<line class="rubber" x1="${a[0]}" y1="${a[1]}" x2="${cs[0]}" y2="${cs[1]}"/>`; else { const st = toS([pending[1].x, pending[1].y]); const R = Math.hypot(st[0] - a[0], st[1] - a[1]); const t = Math.atan2(cs[1] - a[1], cs[0] - a[0]); const en = [a[0] + R * Math.cos(t), a[1] + R * Math.sin(t)]; s += `<path class="rubber" d="M${st[0]} ${st[1]}A${R} ${R} 0 ${Math.abs(arcSpin) > Math.PI ? 1 : 0} ${arcSpin < 0 ? 1 : 0} ${en[0]} ${en[1]}"/>`; } }
      }
      // dimensions + constraint badges (screen-space, readable at any zoom)
      s += renderAnnotations(m);
      // points
      for (const e of m.values()) { if (e.t !== 'pt') continue; const p = toS([e.x, e.y]); s += e.origin ? `<g class="origin${cls(e.id)}"><circle cx="${p[0]}" cy="${p[1]}" r="5"/><path d="M${p[0] - 9} ${p[1]}h18M${p[0]} ${p[1] - 9}v18"/></g>` : `<rect class="pt${isFree(e.id) ? ' free' : ''}${cls(e.id)}" x="${p[0] - 3.5}" y="${p[1] - 3.5}" width="7" height="7"/>`; }
      if (pending.length && (tool === 'dim')) for (const id of pending) { const e = m.get(id); if (e?.t === 'pt') { const p = toS([e.x, e.y]); s += `<circle class="pend" cx="${p[0]}" cy="${p[1]}" r="7"/>`; } }
      svg.innerHTML = s;
      // the oversized DOF numeral — the sketch's one loud element
      const n = diag.solved ? diag.dof : null;
      dofBig.className = 'sk-dof' + (over ? ' over' : n === 0 ? ' done' : n == null ? ' off' : '');
      dofBig.innerHTML = over ? `<b>!</b><span>over-constrained<br>${diag.conflicting.length} in conflict</span>` : n == null ? `<b>—</b><span>${solverState() === 'loading' ? 'loading solver' : 'solver unavailable<br>geometry as drawn'}</span>` : `<b>${n}</b><span>${n === 0 ? 'fully defined' : `degree${n === 1 ? '' : 's'} of<br>freedom left`}</span>`;
      btnDone.textContent = over ? 'Done (conflicts)' : 'Done';
    }
    function renderAnnotations(m) {
      let s = ''; const P = (id) => toS(ptOf(m, id)); const conflict = new Set(diag.conflicting || []);
      const label = (c, x, y, rot = 0) => { const t = fmt(c); const wpx = t.length * 6.6 + 10; let r = rot; if (r > 90) r -= 180; if (r < -90) r += 180; return `<g class="dimlbl${conflict.has(c.id) ? ' bad' : ''}${sel.has(c.id) ? ' sel' : ''}${diag.errors?.[c.id] ? ' bad' : ''}" data-con="${c.id}" transform="translate(${round(x, 1)} ${round(y, 1)}) rotate(${round(r, 1)})"><rect x="${-wpx / 2}" y="-9" width="${wpx}" height="18"/><text y="4">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></g>`; };
      const tick = (p, ang) => { const L = 5; const a = ang + Math.PI / 4; return `M${p[0] - Math.cos(a) * L} ${p[1] - Math.sin(a) * L}L${p[0] + Math.cos(a) * L} ${p[1] + Math.sin(a) * L}`; };
      const linear = (c, a, b, offPx, mode) => { // mode: aligned | h | v
        let d1 = a, d2 = b, n;
        if (mode === 'h') { const y = (offPx >= 0 ? Math.min(a[1], b[1]) : Math.max(a[1], b[1])) - offPx; d1 = [a[0], y]; d2 = [b[0], y]; n = [0, offPx >= 0 ? -1 : 1]; }
        else if (mode === 'v') { const x = (offPx >= 0 ? Math.max(a[0], b[0]) : Math.min(a[0], b[0])) + offPx; d1 = [x, a[1]]; d2 = [x, b[1]]; n = [offPx >= 0 ? 1 : -1, 0]; }
        else { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; n = [dy / L, -dx / L]; d1 = [a[0] + n[0] * offPx, a[1] + n[1] * offPx]; d2 = [b[0] + n[0] * offPx, b[1] + n[1] * offPx]; if (offPx < 0) n = [-n[0], -n[1]]; }
        const ang = Math.atan2(d2[1] - d1[1], d2[0] - d1[0]);
        s += `<path class="dim${conflict.has(c.id) ? ' bad' : ''}" d="M${a[0]} ${a[1]}L${d1[0] + n[0] * 4} ${d1[1] + n[1] * 4}M${b[0]} ${b[1]}L${d2[0] + n[0] * 4} ${d2[1] + n[1] * 4}M${d1[0]} ${d1[1]}L${d2[0]} ${d2[1]}${tick(d1, ang)}${tick(d2, ang)}"/>`;
        s += label(c, (d1[0] + d2[0]) / 2 + n[0] * 11, (d1[1] + d2[1]) / 2 + n[1] * 11, (ang * 180) / Math.PI);
      };
      const badges = new Map(); const badge = (anchor, key, c) => { const k = key; const i = (badges.get(k) || 0); badges.set(k, i + 1); const p = [anchor[0] + 12 + i * 15, anchor[1] - 12]; s += `<g class="badge${conflict.has(c.id) ? ' bad' : ''}${sel.has(c.id) ? ' sel' : ''}" data-con="${c.id}"><rect x="${p[0] - 7}" y="${p[1] - 7}" width="14" height="14"/><text x="${p[0]}" y="${p[1] + 4}">${CONS[c.t].sym}</text></g>`; };
      const midOf = (id) => { const e = m.get(id); if (!e) return [0, 0]; if (e.t === 'pt') return toS([e.x, e.y]); if (e.t === 'line') { const a = P(e.a), b = P(e.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; } if (e.t === 'circle') { const c = P(e.c); return [c[0] + e.r * view.s * 0.71, c[1] - e.r * view.s * 0.71]; } return toS(arcMid({ from: ptOf(m, e.a), to: ptOf(m, e.b), c: ptOf(m, e.c), r: e.r, ccw: true })); };
      for (const c of sk.cons) {
        const [r0, r1] = c.refs; const k0 = m.get(r0)?.t; const offPx = c.off != null ? c.off * view.s : outward(c.t, c.refs) * 22;
        try {
          if (c.t === 'dist') {
            if (k0 === 'line' && !r1) { const l = m.get(r0); linear(c, P(l.a), P(l.b), offPx, 'aligned'); }
            else if (m.get(r1)?.t === 'line') { const l = m.get(r1); const p = P(r0), u = P(l.a), w = P(l.b); const dx = w[0] - u[0], dy = w[1] - u[1]; const t = ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (dx * dx + dy * dy || 1); linear(c, p, [u[0] + t * dx, u[1] + t * dy], 0, 'aligned'); }
            else linear(c, P(r0), P(r1), offPx, 'aligned');
          } else if (c.t === 'hdist' || c.t === 'vdist') { const [u, w] = k0 === 'line' ? [m.get(r0).a, m.get(r0).b] : [r0, r1]; linear(c, P(u), P(w), offPx, c.t === 'hdist' ? 'h' : 'v'); }
          else if (c.t === 'radius' || c.t === 'diam') {
            const e = m.get(r0); const cc = P(e.c); const R = e.r * view.s; const a = e.t === 'arc' ? Math.atan2(...((p) => [p[1] - cc[1], p[0] - cc[0]])(midOf(r0))) : -Math.PI / 4;
            const edge = [cc[0] + R * Math.cos(a), cc[1] + R * Math.sin(a)]; const from = c.t === 'diam' ? [cc[0] - R * Math.cos(a), cc[1] - R * Math.sin(a)] : cc; const out = [cc[0] + (R + 26) * Math.cos(a), cc[1] + (R + 26) * Math.sin(a)];
            s += `<path class="dim${conflict.has(c.id) ? ' bad' : ''}" d="M${from[0]} ${from[1]}L${out[0]} ${out[1]}${tick(edge, a)}"/>`; s += label(c, out[0] + Math.cos(a) * 24, out[1] + Math.sin(a) * 10);
          } else if (c.t === 'angle') {
            const l1 = m.get(r0), l2 = m.get(r1); const a1 = P(l1.a), b1 = P(l1.b), a2 = P(l2.a), b2 = P(l2.b);
            const d1 = [b1[0] - a1[0], b1[1] - a1[1]], d2 = [b2[0] - a2[0], b2[1] - a2[1]]; const den = d1[0] * d2[1] - d1[1] * d2[0];
            let X = [(a1[0] + b1[0] + a2[0] + b2[0]) / 4, (a1[1] + b1[1] + a2[1] + b2[1]) / 4];
            if (Math.abs(den) > 1e-9) { const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den; X = [a1[0] + t * d1[0], a1[1] + t * d1[1]]; }
            const t1 = Math.atan2(d1[1], d1[0]), t2 = Math.atan2(d2[1], d2[0]); const R = 34; const mid = (t1 + t2) / 2;
            s += `<path class="dim${conflict.has(c.id) ? ' bad' : ''}" d="M${X[0] + R * Math.cos(t1)} ${X[1] + R * Math.sin(t1)}A${R} ${R} 0 0 ${t2 > t1 ? 1 : 0} ${X[0] + R * Math.cos(t2)} ${X[1] + R * Math.sin(t2)}"/>`;
            s += label(c, X[0] + (R + 16) * Math.cos(mid), X[1] + (R + 16) * Math.sin(mid));
          } else if (CONS[c.t] && !CONS[c.t].dim && c.t !== 'coinc') badge(midOf(c.t === 'fix' || c.t === 'on' || c.t === 'mid' ? r0 : r0), r0, c);
          else if (c.t === 'coinc' && r1 !== ORIGIN && r0 !== ORIGIN) badge(midOf(r0), r0, c);
        } catch { /* stale ref while editing */ }
      }
      return s;
    }
    function renderSide() {
      const m = M(); const conflict = new Set(diag.conflicting || []); consList.innerHTML = '';
      const name = (id) => id === ORIGIN ? 'origin' : ({ pt: 'point', line: 'line', circle: 'circle', arc: 'arc' }[m.get(id)?.t] || '?') + ' ' + id;
      if (!sk.cons.length) consList.append(h('p', { class: 'empty' }, 'No constraints yet.'));
      for (const c of sk.cons) {
        const row = h('div', { class: 'sk-row' + (conflict.has(c.id) ? ' bad' : '') + (sel.has(c.id) ? ' sel' : ''), onclick: (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; sel = new Set([c.id]); renderSide(); draw(); } },
          h('span', { class: 'sym' }, CONS[c.t]?.dim ? '↔' : CONS[c.t]?.sym || '?'),
          h('span', { class: 'nm' }, CONS[c.t]?.label || c.t, h('small', null, c.refs.map(name).join(' · '))));
        if (CONS[c.t]?.dim) {
          const inp = h('input', { type: 'text', value: c.v, spellcheck: 'false', 'aria-label': `${CONS[c.t].label} value` });
          inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
          inp.addEventListener('change', () => { const r = tryEval(inp.value, getVals()); if (!r.ok) { toast(r.error, 'bad'); inp.value = c.v; return; } const old = c.v; snapshot(); c.v = inp.value.trim(); const s = solve(); if (!s.ok && s.solved) { c.v = old; undo.pop(); solve(); toast('That value conflicts with the sketch — reverted', 'bad'); } });
          row.append(inp);
        }
        row.append(h('button', { type: 'button', class: 'x', title: 'Delete constraint', 'aria-label': 'Delete constraint', onclick: () => { snapshot(); sk.cons = sk.cons.filter(x => x.id !== c.id); solve(); } }, '×'));
        consList.append(row);
      }
      const L = sketchLoops(sk);
      consList.append(h('p', { class: 'sk-meta' }, `${sk.ents.filter(e => e.t !== 'pt').length} curves · ${sk.cons.length} constraints · ${L.loops.length} closed loop${L.loops.length === 1 ? '' : 's'}${L.open ? ` · ${L.open} open end${L.open === 1 ? '' : 's'}` : ''}`));
    }

    // ---------- input ----------
    let drag = null, pan = null, downAt = null; const touches = new Map(); let pinch = null;
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId); const r = svg.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
      touches.set(e.pointerId, [sx, sy]);
      if (touches.size === 2) { const [p, q] = [...touches.values()]; pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]), s: view.s, c: toW((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) }; drag = null; pan = null; return; }
      downAt = [sx, sy, e.timeStamp];
      if (e.button === 1 || (e.button === 0 && e.getModifierState?.('Space'))) { pan = { sx, sy, x: view.x, y: view.y }; return; }
      if (e.button === 2) { if (tool === 'line') { chainStart = null; hintFor(); draw(); } return; }
      if (tool === 'select') {
        const hit = pick(sx, sy);
        if (hit?.kind === 'pt' && hit.id !== ORIGIN) { snapshot(); drag = { id: hit.id, moved: false }; }
        else if (hit?.kind === 'ent' && M().get(hit.id)?.t === 'line') { const l = M().get(hit.id); snapshot(); drag = { line: l, from: toW(sx, sy), a: ptOf(M(), l.a), b: ptOf(M(), l.b), moved: false }; }
        else if (hit?.kind === 'con') { const c = sk.cons.find(x => x.id === hit.id); if (CONS[c?.t]?.dim) { snapshot(); drag = { dim: c, from: toW(sx, sy), off: c.off ?? 4, moved: false }; } }
        else if (!hit) pan = { sx, sy, x: view.x, y: view.y, click: true };
        drag && (drag.hit = hit); if (!drag && hit) drag = { hit, moved: false, none: true };
      }
    });
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [sx, sy]);
      if (pinch && touches.size === 2) { const [p, q] = [...touches.values()]; const d = Math.hypot(p[0] - q[0], p[1] - q[1]); view.s = Math.max(0.05, Math.min(400, (pinch.s * d) / pinch.d)); const c = toW((p[0] + q[0]) / 2, (p[1] + q[1]) / 2); view.x += pinch.c[0] - c[0]; view.y += pinch.c[1] - c[1]; draw(); return; }
      const sp = tool !== 'select' && tool !== 'dim' ? snapPoint(sx, sy, e.altKey) : null;
      cursor = sp ? [sp.x, sp.y] : toW(sx, sy);
      if (tool === 'line' && chainStart && sp && !sp.pid) { const fp = M().get(chainStart.last); const a = Math.abs(Math.atan2(sp.y - fp.y, sp.x - fp.x) * 180 / Math.PI); infer = a < 4 || a > 176 ? 'H' : Math.abs(a - 90) < 4 ? 'V' : null; if (infer === 'H') cursor[1] = fp.y; if (infer === 'V') cursor[0] = fp.x; } else infer = null;
      if (tool === 'arc' && pending.length === 2) { const c = pending[0]; const prev = cursor._t; const t = Math.atan2(cursor[1] - c.y, cursor[0] - c.x); if (svg._lastT != null) { let d = t - svg._lastT; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; arcSpin += d; } svg._lastT = t; void prev; } else svg._lastT = null;
      if (pan) { view.x = pan.x - (sx - pan.sx) / view.s; view.y = pan.y + (sy - pan.sy) / view.s; if (Math.hypot(sx - pan.sx, sy - pan.sy) > 3) pan.click = false; draw(); hintFor(); return; }
      if (drag && !drag.none) {
        drag.moved = true; const w = toW(sx, sy);
        if (drag.id) solve([{ id: drag.id, x: w[0], y: w[1] }]);
        else if (drag.line) { const dx = w[0] - drag.from[0], dy = w[1] - drag.from[1]; solve([{ id: drag.line.a, x: drag.a[0] + dx, y: drag.a[1] + dy }, { id: drag.line.b, x: drag.b[0] + dx, y: drag.b[1] + dy }]); }
        else if (drag.dim) { // slide the dimension line along its normal
          const c = drag.dim, m = M(); const dx = w[0] - drag.from[0], dy = w[1] - drag.from[1]; let n = null; const [r0, r1] = c.refs;
          if (c.t === 'hdist') n = [0, 1]; else if (c.t === 'vdist') n = [1, 0];
          else if (c.t === 'dist' && m.get(r1)?.t !== 'line') { const [a, b] = m.get(r0)?.t === 'line' ? [ptOf(m, m.get(r0).a), ptOf(m, m.get(r0).b)] : [ptOf(m, r0), ptOf(m, r1)]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; }
          if (n) { c.off = drag.off + dx * n[0] + dy * n[1]; draw(); }
        }
        hintFor(); return;
      }
      const hv = pick(sx, sy); if (hv?.id !== hover?.id) { hover = hv; svg.style.cursor = hv ? 'pointer' : tool === 'select' ? 'default' : 'crosshair'; }
      hintFor(); draw();
    });
    const endPointer = (e) => {
      touches.delete(e.pointerId); if (pinch) { if (touches.size < 2) pinch = null; return; }
      const r = svg.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const click = downAt && Math.hypot(sx - downAt[0], sy - downAt[1]) < 5;
      if (pan) { const wasClick = pan.click; pan = null; if (wasClick && tool === 'select' && !e.shiftKey) { sel.clear(); renderSide(); draw(); } if (!(wasClick && tool !== 'select')) return; }
      if (drag) {
        const d = drag; drag = null;
        if (d.moved && !d.none) { solve(); return; }
        if (!d.none) undo.pop();
        if (click && d.hit) { const id = d.hit.id; if (e.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id); } else sel = new Set([id]); renderSide(); draw(); }
        return;
      }
      if (click && tool !== 'select' && e.button === 0) place(sx, sy, e.altKey);
    };
    svg.addEventListener('pointerup', endPointer); svg.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); pinch = null; drag = null; pan = null; });
    svg.addEventListener('dblclick', (e) => { const r = svg.getBoundingClientRect(); const hit = pick(e.clientX - r.left, e.clientY - r.top); if (hit?.kind === 'con' && CONS[sk.cons.find(c => c.id === hit.id)?.t]?.dim) editDim(hit.id); else if (tool === 'line') { chainStart = null; hintFor(); draw(); } });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top; const before = toW(sx, sy); view.s = Math.max(0.05, Math.min(400, view.s * Math.exp(-e.deltaY * 0.0015))); const after = toW(sx, sy); view.x += before[0] - after[0]; view.y += before[1] - after[1]; hintFor(); draw(); }, { passive: false });
    const onKey = (e) => {
      if (e.target === dimInput || (e.target.tagName === 'INPUT' && root.contains(e.target))) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.stopPropagation(); doUndo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.stopPropagation();
      if (k === 'escape') { e.preventDefault(); if (chainStart || pending.length) { chainStart = null; pending = []; hintFor(); draw(); } else if (tool !== 'select') setTool('select'); else if (sel.size) { sel.clear(); renderSide(); draw(); } return; }
      if (k === 'enter') { e.preventDefault(); finish(true); return; }
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); return; }
      const toolKey = { s: 'select', l: 'line', r: 'rect', c: 'circle', a: 'arc', d: 'dim' }[k]; if (toolKey) { e.preventDefault(); setTool(toolKey); return; }
      const conKey = { i: 'coinc', h: 'h', v: 'v', p: 'par', x: 'perp', e: 'equal', t: 'tan', m: 'mid', o: 'on', f: 'fix' }[k];
      if (conKey && (sel.size || k !== 'f')) { e.preventDefault(); applyConstraint(conKey); return; }
      if (k === 'f') { e.preventDefault(); fit(); draw(); return; }
      if (k === 'q') { e.preventDefault(); toggleConstruction(); }
    };
    document.addEventListener('keydown', onKey, true);
    const onBack = () => { if (editing) commitDim(true); else if (chainStart || pending.length) { chainStart = null; pending = []; hintFor(); draw(); } else finish(true); };
    document.addEventListener('kerf-back', onBack);
    const ro = new ResizeObserver(() => draw()); ro.observe(svg);

    function finish(ok) {
      if (ok && diag.conflicting?.length) toast('Saved with conflicting constraints — the feature will show an error until they are removed', 'bad');
      document.removeEventListener('keydown', onKey, true); document.removeEventListener('kerf-back', onBack); ro.disconnect(); root.remove(); prevFocus?.focus?.();
      if (!ok) { resolve(null); return; }
      const out = clone(sk); for (const e of out.ents) if (e.t === 'pt') { e.x = round(e.x, 6); e.y = round(e.y, 6); } else if (e.r != null) e.r = round(e.r, 6);
      resolve(out);
    }

    // ---------- go ----------
    setTool('select');
    requestAnimationFrame(() => { fit(); solve(); hintFor(); });
    if (solverState() !== 'ready') loadSolver().then(() => solve());
  });
}
