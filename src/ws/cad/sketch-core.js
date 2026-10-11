// Constraint sketches for CAD profiles. Geometry + dimensions live in the document; FreeCAD's PlaneGCS solver
// (LGPL-2.1-or-later, via @salusoft89/planegcs, loaded on demand as WebAssembly) resolves them.
// Without the solver the last solved positions are used, so a file always builds.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs';
import { fetchBundled } from '../../core/io.js';
import { tryEval } from '../../core/expr.js';
import { nestLoops } from '../../core/shapes.js';

export const ORIGIN = 'O';
/** Constraint kinds: label, which refs they take, whether they carry a value. */
export const CONS = {
  coinc: { label: 'Coincident', sym: '●' }, h: { label: 'Horizontal', sym: 'H' }, v: { label: 'Vertical', sym: 'V' },
  par: { label: 'Parallel', sym: '∥' }, perp: { label: 'Perpendicular', sym: '⊥' }, equal: { label: 'Equal', sym: '=' },
  tan: { label: 'Tangent', sym: 'T' }, fix: { label: 'Fix', sym: '⚓' }, on: { label: 'Point on', sym: '◦' }, mid: { label: 'Midpoint', sym: 'M' },
  dist: { label: 'Distance', dim: true }, hdist: { label: 'Horizontal distance', dim: true }, vdist: { label: 'Vertical distance', dim: true },
  radius: { label: 'Radius', dim: true }, diam: { label: 'Diameter', dim: true }, angle: { label: 'Angle', dim: true, deg: true },
};

// ---------- solver lifecycle ----------
let mod = null, wrap = null, loading = null, loadError = '';
export const solverState = () => (mod ? 'ready' : loading ? 'loading' : loadError ? 'failed' : 'idle');
export const solverError = () => loadError;
export function loadSolver() {
  if (mod) return Promise.resolve(true);
  if (!loading) loading = (async () => {
    try {
      const wasmBinary = await fetchBundled('planegcs.wasm');
      // this Emscripten build ignores Module.wasmBinary, so hand it the compiled instance instead
      mod = await init_planegcs_module({ instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasmBinary, imports).then(r => done(r.instance)); return {}; }, print() {}, printErr() {} });
      wrap = new GcsWrapper(new mod.GcsSystem()); wrap.debug_mode = 0;
      return true;
    } catch (e) { loadError = e.message || String(e); console.warn('PlaneGCS failed to load', e); return false; } finally { loading = null; }
  })();
  return loading;
}

// ---------- helpers ----------
export const byId = (sk) => { const m = new Map(sk.ents.map(e => [e.id, e])); m.set(ORIGIN, { id: ORIGIN, t: 'pt', x: 0, y: 0, origin: true }); return m; };
export function ptOf(m, id) { const p = m.get(id); return p ? [p.x, p.y] : [0, 0]; }
const ang = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
function curveTangentAt(m, e, pid) { // unit tangent of a line/arc at one of its points (for 0-vs-π tangency)
  if (e.t === 'line') { const a = ptOf(m, e.a), b = ptOf(m, e.b); const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
  const c = ptOf(m, e.c), p = ptOf(m, pid); const t = ang(c, p); return [-Math.sin(t), Math.cos(t)];
}
/** Evaluate the dimension expressions. Returns {values:{conId:number}, errors:{conId:msg}}. */
export function dimValues(sk, vals) {
  const values = {}, errors = {};
  for (const c of sk.cons) {
    if (!CONS[c.t]?.dim) continue;
    const r = tryEval(String(c.v ?? '0'), vals || {});
    if (!r.ok) { errors[c.id] = r.error; continue; }
    values[c.id] = CONS[c.t].deg ? (r.value * Math.PI) / 180 : r.value;
    if (!CONS[c.t].deg && c.t !== 'hdist' && c.t !== 'vdist' && !(r.value > 0)) errors[c.id] = 'Must be greater than zero';
  }
  return { values, errors };
}

/** Translate the sketch to PlaneGCS primitives. */
function toPrimitives(sk, values, drag) {
  const m = byId(sk); const fixed = new Set(sk.cons.filter(c => c.t === 'fix').flatMap(c => c.refs));
  const out = [{ id: ORIGIN, type: 'point', x: 0, y: 0, fixed: true }];
  for (const e of sk.ents) {
    if (e.t === 'pt') out.push({ id: e.id, type: 'point', x: e.x, y: e.y, fixed: fixed.has(e.id) });
  }
  for (const e of sk.ents) {
    if (e.t === 'line') out.push({ id: e.id, type: 'line', p1_id: e.a, p2_id: e.b });
    else if (e.t === 'circle') out.push({ id: e.id, type: 'circle', c_id: e.c, radius: e.r });
    else if (e.t === 'arc') {
      const c = ptOf(m, e.c); let sa = ang(c, ptOf(m, e.a)), ea = ang(c, ptOf(m, e.b)); if (ea <= sa) ea += Math.PI * 2;
      out.push({ id: e.id, type: 'arc', c_id: e.c, start_id: e.a, end_id: e.b, start_angle: sa, end_angle: ea, radius: e.r });
      out.push({ id: e.id + '~rules', type: 'arc_rules', a_id: e.id });
    }
  }
  const kind = (id) => m.get(id)?.t;
  for (const c of sk.cons) {
    const [r0, r1, r2] = c.refs; const k0 = kind(r0), k1 = kind(r1); const id = c.id;
    switch (c.t) {
      case 'coinc': out.push({ id, type: 'p2p_coincident', p1_id: r0, p2_id: r1 }); break;
      case 'h': out.push(k0 === 'line' ? { id, type: 'horizontal_l', l_id: r0 } : { id, type: 'horizontal_pp', p1_id: r0, p2_id: r1 }); break;
      case 'v': out.push(k0 === 'line' ? { id, type: 'vertical_l', l_id: r0 } : { id, type: 'vertical_pp', p1_id: r0, p2_id: r1 }); break;
      case 'par': out.push({ id, type: 'parallel', l1_id: r0, l2_id: r1 }); break;
      case 'perp': out.push({ id, type: 'perpendicular_ll', l1_id: r0, l2_id: r1 }); break;
      case 'equal':
        if (k0 === 'line') out.push({ id, type: 'equal_length', l1_id: r0, l2_id: r1 });
        else if (k0 === 'circle' && k1 === 'circle') out.push({ id, type: 'equal_radius_cc', c1_id: r0, c2_id: r1 });
        else if (k0 === 'arc' && k1 === 'arc') out.push({ id, type: 'equal_radius_aa', a1_id: r0, a2_id: r1 });
        else out.push({ id, type: 'equal_radius_ca', c1_id: k0 === 'circle' ? r0 : r1, a2_id: k0 === 'circle' ? r1 : r0 });
        break;
      case 'tan': {
        const e0 = m.get(r0), e1 = m.get(r1);
        const ends = (e) => e.t === 'circle' ? [] : [e.a, e.b];
        const shared = ends(e0).find(p => ends(e1).includes(p));
        if (shared) { // endpoint-to-endpoint tangency (FreeCAD style): angle between the curves at the shared point is 0 or π
          const t0 = curveTangentAt(m, e0, shared), t1 = curveTangentAt(m, e1, shared);
          out.push({ id, type: 'angle_via_point', crv1_id: r0, crv2_id: r1, p_id: shared, angle: t0[0] * t1[0] + t0[1] * t1[1] >= 0 ? 0 : Math.PI });
        } else if (k0 === 'line' || k1 === 'line') {
          const l = k0 === 'line' ? r0 : r1, o = k0 === 'line' ? r1 : r0;
          out.push(kind(o) === 'arc' ? { id, type: 'tangent_la', l_id: l, a_id: o } : { id, type: 'tangent_lc', l_id: l, c_id: o });
        } else if (k0 === 'circle' && k1 === 'circle') out.push({ id, type: 'tangent_cc', c1_id: r0, c2_id: r1 });
        else if (k0 === 'arc' && k1 === 'arc') out.push({ id, type: 'tangent_aa', a1_id: r0, a2_id: r1 });
        else out.push({ id, type: 'tangent_ca', c_id: k0 === 'circle' ? r0 : r1, a_id: k0 === 'circle' ? r1 : r0 });
        break;
      }
      case 'on':
        if (k1 === 'line') out.push({ id, type: 'point_on_line_pl', p_id: r0, l_id: r1 });
        else if (k1 === 'circle') out.push({ id, type: 'point_on_circle', p_id: r0, c_id: r1 });
        else if (k1 === 'arc') out.push({ id, type: 'point_on_arc', p_id: r0, a_id: r1 });
        break;
      case 'mid': { const l = m.get(r1); out.push({ id, type: 'point_on_line_pl', p_id: r0, l_id: r1 }, { id: id + '~b', type: 'point_on_perp_bisector_ppp', p_id: r0, lp1_id: l.a, lp2_id: l.b }); break; }
      case 'dist': {
        if (values[id] == null) break;
        if (k0 === 'line' && !r1) { const l = m.get(r0); out.push({ id, type: 'p2p_distance', p1_id: l.a, p2_id: l.b, distance: values[id] }); }
        else if (k0 === 'pt' && k1 === 'line') out.push({ id, type: 'p2l_distance', p_id: r0, l_id: r1, distance: values[id] });
        else out.push({ id, type: 'p2p_distance', p1_id: r0, p2_id: r1, distance: values[id] });
        break;
      }
      case 'hdist': case 'vdist': {
        if (values[id] == null) break; const prop = c.t === 'hdist' ? 'x' : 'y';
        const [a, b] = k0 === 'line' ? [m.get(r0).a, m.get(r0).b] : [r0, r1];
        out.push({ id, type: 'difference', param1: { o_id: a, prop }, param2: { o_id: b, prop }, difference: values[id] });
        break;
      }
      case 'radius': if (values[id] != null) out.push(k0 === 'arc' ? { id, type: 'arc_radius', a_id: r0, radius: values[id] } : { id, type: 'circle_radius', c_id: r0, radius: values[id] }); break;
      case 'diam': if (values[id] != null) out.push(k0 === 'arc' ? { id, type: 'arc_diameter', a_id: r0, diameter: values[id] } : { id, type: 'circle_diameter', c_id: r0, diameter: values[id] }); break;
      case 'angle': if (values[id] != null) out.push({ id, type: 'l2l_angle_ll', l1_id: r0, l2_id: r1, angle: values[id] }); break;
      case 'fix': break;
      default: void r2;
    }
  }
  if (drag) { // temporary constraints pull the dragged points to the cursor as far as the real ones allow
    (Array.isArray(drag) ? drag : [drag]).forEach((d, i) => {
      if (d.id === ORIGIN) return;
      const p = out.find(q => q.id === d.id); if (p && !p.fixed) { p.x = d.x; p.y = d.y; } // start the solve at the cursor
      out.push({ id: `~dx${i}`, type: 'coordinate_x', p_id: d.id, x: d.x, temporary: true }, { id: `~dy${i}`, type: 'coordinate_y', p_id: d.id, y: d.y, temporary: true });
    });
  }
  return out;
}

/**
 * Solve. Returns a new sketch object with solved coordinates plus diagnostics:
 * {sk, ok, dof, conflicting:[ids], redundant:[ids], errors:{conId:msg}, solved:bool}
 * When the solver isn't loaded the input is returned unchanged with solved:false.
 */
export function solveSketch(sk, vals, opts = {}) {
  const { values, errors } = dimValues(sk, vals);
  if (!wrap) return { sk, ok: !Object.keys(errors).length, dof: null, conflicting: [], redundant: [], errors, solved: false };
  wrap.clear_data();
  let status = 2;
  try {
    wrap.push_primitives_and_params(toPrimitives(sk, values, opts.drag));
    status = wrap.solve(2); // DogLeg, FreeCAD's default
    if (status !== 0 && status !== 1) { wrap.clear_data(); wrap.push_primitives_and_params(toPrimitives(sk, values, opts.drag)); status = wrap.solve(1); } // Levenberg–Marquardt fallback
    wrap.apply_solution();
  } catch (e) { return { sk, ok: false, dof: null, conflicting: [], redundant: [], errors: { ...errors, _: e.message || String(e) }, solved: false }; }
  const conflicting = wrap.get_gcs_conflicting_constraints().filter(id => !id.startsWith('~')).map(id => id.replace(/~.*$/, ''));
  const redundant = wrap.get_gcs_redundant_constraints().filter(id => !id.startsWith('~')).map(id => id.replace(/~.*$/, ''));
  const dof = wrap.gcs.dof();
  const solvedPrims = new Map(wrap.sketch_index.get_primitives().map(p => [p.id, p]));
  const ents = sk.ents.map(e => {
    const p = solvedPrims.get(e.id); if (!p) return e;
    if (e.t === 'pt') return { ...e, x: p.x, y: p.y };
    if (e.t === 'circle' || e.t === 'arc') return { ...e, r: p.radius };
    return e;
  });
  const ok = (status === 0 || status === 1) && !conflicting.length && !Object.keys(errors).length;
  if (status !== 0 && status !== 1 && !conflicting.length) errors._ = 'The sketch could not be solved with these dimensions';
  return { sk: { ...sk, ents }, ok, dof, conflicting: [...new Set(conflicting)], redundant: [...new Set(redundant)], errors, solved: true, status };
}

// ---------- geometry → profile loops ----------
const KEY = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
/** Closed loops made from non-construction lines and arcs (chained by position), plus full circles.
 *  Returns {loops:[{segs:[{kind,from,to,c?,r?,ccw?}], circle?:{c,r}}], open: number of dangling ends}. */
export function sketchLoops(sk) {
  const m = byId(sk); const segs = []; const loops = [];
  for (const e of sk.ents) {
    if (e.constr) continue;
    if (e.t === 'line') segs.push({ e, kind: 'line', a: ptOf(m, e.a), b: ptOf(m, e.b) });
    else if (e.t === 'arc') segs.push({ e, kind: 'arc', a: ptOf(m, e.a), b: ptOf(m, e.b), c: ptOf(m, e.c), r: e.r });
    else if (e.t === 'circle' && e.r > 0) loops.push({ circle: { c: ptOf(m, e.c), r: e.r } });
  }
  const adj = new Map(); const add = (k, i) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); };
  segs.forEach((s, i) => { if (Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) < 1e-7) { s.used = true; return; } add(KEY(s.a), i); add(KEY(s.b), i); });
  let open = 0; for (const [, l] of adj) if (l.length % 2) open++;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue;
    const start = KEY(segs[i].a); let cur = i, at = segs[i].a; const chain = [];
    for (let guard = 0; guard < segs.length + 1; guard++) {
      const s = segs[cur]; s.used = true;
      const fwd = KEY(s.a) === KEY(at); const to = fwd ? s.b : s.a;
      chain.push(s.kind === 'line' ? { kind: 'line', from: at, to } : { kind: 'arc', from: at, to, c: s.c, r: s.r, ccw: fwd });
      at = to; if (KEY(at) === start) { loops.push({ segs: chain }); break; }
      const nxt = (adj.get(KEY(at)) || []).find(j => !segs[j].used); if (nxt == null) break; cur = nxt;
    }
  }
  return { loops, open };
}
function arcSweep(s) { // signed sweep from s.from to s.to around s.c following the arc's own CCW direction
  let a0 = ang(s.c, s.from), a1 = ang(s.c, s.to);
  if (s.ccw) { while (a1 <= a0 + 1e-12) a1 += Math.PI * 2; } else { while (a1 >= a0 - 1e-12) a1 -= Math.PI * 2; }
  return [a0, a1];
}
export function arcMid(s) { const [a0, a1] = arcSweep(s); const t = (a0 + a1) / 2; return [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]; }
/** Polygon (flattened) for one loop. */
export function loopPoly(L, seg = 64) {
  if (L.circle) { const { c, r } = L.circle; return Array.from({ length: 96 }, (_, i) => [c[0] + r * Math.cos((i / 96) * Math.PI * 2), c[1] + r * Math.sin((i / 96) * Math.PI * 2)]); }
  const pts = [];
  for (const s of L.segs) {
    if (s.kind === 'line') { pts.push(s.from); continue; }
    const [a0, a1] = arcSweep(s); const n = Math.max(4, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * seg));
    for (let i = 0; i < n; i++) { const t = a0 + ((a1 - a0) * i) / n; pts.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]); }
  }
  return pts;
}
/** Nested loops (outer CCW + holes) for the mesh kernel and previews. */
export function sketchNested(sk) { return nestLoops(sketchLoops(sk).loops.map(L => loopPoly(L))); }

/** A starter sketch: a 40 × 30 rectangle with its lower-left corner on the origin, fully defined. */
export function defaultSketch(w = '40 mm', hgt = '30 mm') {
  const ents = [
    { id: 'p1', t: 'pt', x: 0, y: 0 }, { id: 'p2', t: 'pt', x: 40, y: 0 }, { id: 'p3', t: 'pt', x: 40, y: 30 }, { id: 'p4', t: 'pt', x: 0, y: 30 },
    { id: 'l1', t: 'line', a: 'p1', b: 'p2' }, { id: 'l2', t: 'line', a: 'p2', b: 'p3' }, { id: 'l3', t: 'line', a: 'p3', b: 'p4' }, { id: 'l4', t: 'line', a: 'p4', b: 'p1' },
  ];
  const cons = [
    { id: 'k1', t: 'coinc', refs: ['p1', ORIGIN] }, { id: 'k2', t: 'h', refs: ['l1'] }, { id: 'k3', t: 'v', refs: ['l2'] }, { id: 'k4', t: 'h', refs: ['l3'] }, { id: 'k5', t: 'v', refs: ['l4'] },
    { id: 'k6', t: 'dist', refs: ['l1'], v: w }, { id: 'k7', t: 'dist', refs: ['l2'], v: hgt },
  ];
  return { ents, cons, seq: 8 };
}
