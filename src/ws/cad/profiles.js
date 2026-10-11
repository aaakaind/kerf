// CAD profiles (2D sketches by parameters) and feature evaluation (expressions → numbers).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { tryEval } from '../../core/expr.js';
import { filletPolygon, nestLoops, subpathsToLoops } from '../../core/shapes.js';
import { solveSketch, sketchNested, defaultSketch } from './sketch-core.js';

export const PLANES = {
  XY: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  XZ: { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  YZ: { u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};
export const PROFILE_TYPES = { sketch: 'Sketch (constraints)', rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', slot: 'Slot', poly: 'Polyline', vector: 'From Vector' };
export const PROFILE_FIELDS = {
  rect: [['w', 'Width'], ['h', 'Height'], ['cx', 'Centre U'], ['cy', 'Centre V'], ['r', 'Corner radius']],
  circle: [['d', 'Diameter'], ['cx', 'Centre U'], ['cy', 'Centre V']],
  polygon: [['n', 'Sides'], ['d', 'Across corners'], ['cx', 'Centre U'], ['cy', 'Centre V'], ['rot', 'Rotation °']],
  slot: [['l', 'Length'], ['w', 'Width'], ['cx', 'Centre U'], ['cy', 'Centre V'], ['rot', 'Rotation °']],
  poly: [['r', 'Corner fillet']],
  vector: [['size', 'Largest side'], ['cx', 'Centre U'], ['cy', 'Centre V']],
  sketch: [],
};
export const PROFILE_DEFAULTS = {
  rect: { w: '40 mm', h: '30 mm', cx: '0', cy: '0', r: '0' }, circle: { d: '30 mm', cx: '0', cy: '0' },
  polygon: { n: '6', d: '30 mm', cx: '0', cy: '0', rot: '0' }, slot: { l: '40 mm', w: '10 mm', cx: '0', cy: '0', rot: '0' },
  poly: { pts: '0, 0\n40, 0\n40, 8\n8, 8\n8, 30\n0, 30', r: '0' }, vector: { size: '60 mm', cx: '0', cy: '0' },
  get sketch() { return defaultSketch(); }, // fresh copy every time (nested arrays)
};

/** Numeric fields per feature type (besides profile). */
export const FEATURE_FIELDS = {
  extrude: [['offset', 'Plane offset'], ['depth', 'Depth']],
  revolve: [['offset', 'Plane offset'], ['angle', 'Angle °']],
  hole: [['offset', 'Entry plane offset'], ['x', 'Centre U'], ['y', 'Centre V'], ['d', 'Diameter'], ['depth', 'Depth (0 = through)'], ['cbd', 'Counterbore Ø (0 = none)'], ['cbdepth', 'Counterbore depth']],
  fillet: [['r', 'Radius']],
  chamfer: [['d', 'Distance']],
  shell: [['t', 'Wall thickness']],
  pattern: [['count', 'Count'], ['dx', 'Step X'], ['dy', 'Step Y'], ['dz', 'Step Z'], ['angle', 'Total angle °']],
  mirror: [],
  import: [['x', 'Move X'], ['y', 'Move Y'], ['z', 'Move Z'], ['rz', 'Turn about Z °'], ['scale', 'Scale']],
  box: [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['w', 'Width X'], ['l', 'Length Y'], ['h', 'Height Z']],
  cylinder: [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['d', 'Diameter'], ['h', 'Height']],
  sphere: [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['d', 'Diameter']],
};
export const FEATURE_LABEL = { extrude: 'Extrude', revolve: 'Revolve', hole: 'Hole', fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', pattern: 'Pattern', mirror: 'Mirror', box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', import: 'STEP import' };
export const FEATURE_ICON = { extrude: 'extrude', revolve: 'revolve', hole: 'hole', fillet: 'fillet', chamfer: 'chamfer', shell: 'shell', pattern: 'patLin', mirror: 'mirror', box: 'cube', cylinder: 'cylinder', sphere: 'sphere', import: 'upload' };
const ANGLE_KEYS = new Set(['angle', 'rot', 'n', 'count', 'rz', 'scale']);

export function newFeature(type, id, n) {
  const base = { id, type, name: `${FEATURE_LABEL[type]} ${n}`, suppressed: false };
  switch (type) {
    case 'extrude': return { ...base, plane: 'XY', offset: '0', depth: '10 mm', dir: 'normal', op: n === 1 ? 'new' : 'add', profile: { type: 'sketch', ...PROFILE_DEFAULTS.sketch } };
    case 'revolve': return { ...base, plane: 'XZ', offset: '0', angle: '360', op: n === 1 ? 'new' : 'add', profile: { type: 'rect', w: '10 mm', h: '30 mm', cx: '15 mm', cy: '15 mm', r: '0' } };
    case 'hole': return { ...base, plane: 'XY', offset: '10 mm', x: '0', y: '0', d: '5 mm', depth: '0', cbd: '0', cbdepth: '3 mm' };
    case 'fillet': return { ...base, r: '2 mm', edges: 'Z' };
    case 'chamfer': return { ...base, d: '1 mm', edges: 'top' };
    case 'shell': return { ...base, t: '2 mm', face: 'top' };
    case 'pattern': return { ...base, of: null, kind: 'linear', count: '3', dx: '15 mm', dy: '0', dz: '0', axis: 'Z', angle: '360' };
    case 'mirror': return { ...base, plane: 'YZ' };
    case 'box': return { ...base, op: n === 1 ? 'new' : 'add', x: '0', y: '0', z: '0', w: '40 mm', l: '30 mm', h: '20 mm' };
    case 'cylinder': return { ...base, op: n === 1 ? 'new' : 'add', axis: 'Z', x: '0', y: '0', z: '0', d: '20 mm', h: '30 mm' };
    case 'sphere': return { ...base, op: n === 1 ? 'new' : 'add', x: '0', y: '0', z: '10 mm', d: '20 mm' };
    case 'import': return { ...base, op: n === 1 ? 'new' : 'add', asset: null, x: '0', y: '0', z: '0', rz: '0', scale: '1' };
  }
  return base;
}

/** Resolve a feature's expressions. Returns {ok, f (numeric copy), errors:{field: msg}}. */
export function evalFeature(f, vals, vectorLookup) {
  const errors = {}; const out = { ...f };
  const num = (k, v) => { const r = tryEval(v ?? '0', vals); if (r.ok) return ANGLE_KEYS.has(k) ? r.value : r.value; errors[k] = r.error; return 0; };
  for (const [k] of FEATURE_FIELDS[f.type] || []) out[k] = num(k, f[k]);
  if (f.profile) {
    const p = { type: f.profile.type };
    for (const [k] of PROFILE_FIELDS[f.profile.type] || []) { const r = tryEval(f.profile[k] ?? '0', vals); if (r.ok) p[k] = r.value; else { errors['profile.' + k] = r.error; p[k] = 0; } }
    if (f.profile.type === 'poly') {
      p.pts = []; String(f.profile.pts || '').split('\n').map(s => s.trim()).filter(Boolean).forEach((line, i) => {
        const parts = splitPoint(line); if (parts.length !== 2) { errors['profile.pts'] = `Line ${i + 1}: write “x, y”`; return; }
        const a = tryEval(parts[0], vals), b = tryEval(parts[1], vals);
        if (!a.ok || !b.ok) { errors['profile.pts'] = `Line ${i + 1}: ${(a.ok ? b : a).error}`; return; }
        p.pts.push([a.value, b.value]);
      });
      if (p.pts.length < 3) errors['profile.pts'] ??= 'A polyline profile needs at least 3 points';
    }
    if (f.profile.type === 'sketch') {
      const r = solveSketch(f.profile, vals);
      p.sk = r.sk; p.dof = r.dof;
      if (r.conflicting.length) errors['profile.sketch'] = `Over-constrained — ${r.conflicting.length} conflicting constraints. Open the sketch to fix.`;
      else if (Object.keys(r.errors).length) errors['profile.sketch'] = Object.values(r.errors)[0];
    }
    if (f.profile.type === 'vector') {
      const subs = vectorLookup?.(f.profile.link) || f.profile.subpaths;
      if (!subs) errors['profile.link'] = 'Vector path not found'; else p.subpaths = subs;
    }
    out.profile = p;
  }
  if (f.type === 'pattern') out.count = Math.max(1, Math.round(out.count));
  if (f.type === 'import' && !(out.scale > 0)) errors.scale = 'Scale must be greater than zero';
  return { ok: !Object.keys(errors).length, f: out, errors };
}
function splitPoint(line) { // split "x, y" at the top-level comma (commas inside function calls are kept)
  let depth = 0; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '(') depth++; else if (c === ')') depth--; else if ((c === ',' || c === ';') && depth === 0) return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }
  return line.split(/\s+/);
}

/** Profile → nested loops (outer CCW + holes) in plane UV mm. Used by the mesh kernel and the profile preview. */
export function profileLoops(p) {
  const circle = (cx, cy, r, n = 96) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)]);
  const rotPts = (pts, deg, cx, cy) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]); };
  switch (p.type) {
    case 'rect': { const w = p.w / 2, h = p.h / 2; const pts = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => [x + p.cx, y + p.cy]); return nestLoops([p.r > 0 ? filletPolygon(pts, p.r, 10) : pts]); }
    case 'circle': return nestLoops([circle(p.cx, p.cy, p.d / 2)]);
    case 'polygon': { const n = Math.max(3, Math.round(p.n)); const pts = Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + Math.PI / 2; return [Math.cos(a) * p.d / 2, Math.sin(a) * p.d / 2]; }); return nestLoops([rotPts(pts, p.rot, p.cx, p.cy)]); }
    case 'slot': { const r = p.w / 2, L = Math.max(0, p.l / 2 - r); const pts = []; for (let i = 0; i <= 24; i++) { const a = -Math.PI / 2 + (i / 24) * Math.PI; pts.push([L + r * Math.cos(a), r * Math.sin(a)]); } for (let i = 0; i <= 24; i++) { const a = Math.PI / 2 + (i / 24) * Math.PI; pts.push([-L + r * Math.cos(a), r * Math.sin(a)]); } return nestLoops([rotPts(pts, p.rot, p.cx, p.cy)]); }
    case 'poly': return p.pts?.length >= 3 ? nestLoops([p.r > 0 ? filletPolygon(p.pts, p.r, 8) : p.pts]) : [];
    case 'sketch': return p.sk ? sketchNested(p.sk) : [];
    case 'vector': return p.subpaths ? subpathsToLoops(p.subpaths, { size: p.size }).map(({ outer, holes }) => ({ outer: outer.map(([x, y]) => [x + p.cx, y + p.cy]), holes: holes.map(hh => hh.map(([x, y]) => [x + p.cx, y + p.cy])) })) : [];
  }
  return [];
}
