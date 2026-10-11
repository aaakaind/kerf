// Fast CAD kernel: exact-enough mesh solids + BVH booleans (three-bvh-csg). Runs anywhere, instantly.
// Fillet / chamfer / shell need the precise B-rep kernel and are reported as skipped here.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { PLANES, profileLoops } from './profiles.js';
import { manifoldBoolean } from '../../core/manifold.js';

const OPS = { add: ADDITION, cut: SUBTRACTION, intersect: INTERSECTION };
const evaluator = new Evaluator(); evaluator.attributes = ['position', 'normal']; evaluator.useGroups = false;

function planeMatrix(plane, offset) {
  const P = PLANES[plane] || PLANES.XY;
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...P.u), new THREE.Vector3(...P.v), new THREE.Vector3(...P.n));
  m.setPosition(new THREE.Vector3(...P.n).multiplyScalar(offset));
  return m;
}
function clean(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.clearGroups(); if (!g.attributes.normal) g.computeVertexNormals(); return g;
}
function shapesFromLoops(loops) {
  return loops.map(({ outer, holes }) => { const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y))); for (const hp of holes) s.holes.push(new THREE.Path(hp.map(([x, y]) => new THREE.Vector2(x, y)))); return s; });
}
function brush(geo, matrix) { const b = new Brush(clean(geo)); if (matrix) b.geometry.applyMatrix4(matrix); b.updateMatrixWorld(); return b; }
function extrudeTool(f) {
  const loops = profileLoops(f.profile); if (!loops.length) throw new Error('The profile is empty');
  let z0 = 0, depth = f.depth;
  if (f.dir === 'reverse') z0 = -depth; else if (f.dir === 'symmetric') z0 = -depth / 2;
  if (depth <= 0) throw new Error('Depth must be greater than zero');
  const g = new THREE.ExtrudeGeometry(shapesFromLoops(loops), { depth, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, z0);
  return brush(g, planeMatrix(f.plane, f.offset));
}
function revolveTool(f) {
  const loops = profileLoops(f.profile); if (!loops.length) throw new Error('The profile is empty');
  const outer = loops[0].outer;
  if (outer.some(([u]) => u < -1e-6)) throw new Error('A revolve profile must sit on one side of the axis (U ≥ 0)');
  const pts = [...outer, outer[0]].map(([u, v]) => new THREE.Vector2(Math.max(0, u), v));
  const ang = Math.min(360, Math.max(1, f.angle));
  const g = new THREE.LatheGeometry(pts, Math.max(24, Math.round(96 * ang / 360)), 0, (ang * Math.PI) / 180);
  // Lathe spins around local Y into local X/Z; map local X→u, Y→v, Z→n
  return brush(g, planeMatrix(f.plane, f.offset));
}
function holeTools(f) {
  const tools = []; const L = 10000;
  const make = (d, z0, h) => { const g = new THREE.CylinderGeometry(d / 2, d / 2, h, 64); g.rotateX(Math.PI / 2); g.translate(f.x, f.y, z0 + h / 2); return brush(g, planeMatrix(f.plane, f.offset)); };
  if (!(f.d > 0)) throw new Error('Diameter must be greater than zero');
  tools.push(f.depth > 0 ? make(f.d, -f.depth, f.depth + 0.01) : make(f.d, -L, 2 * L));
  if (f.cbd > f.d && f.cbdepth > 0) tools.push(make(f.cbd, -f.cbdepth, f.cbdepth + 0.01));
  return tools;
}
function primTool(f) {
  if (f.type === 'box') { const g = new THREE.BoxGeometry(f.w, f.l, f.h); g.translate(f.x + f.w / 2, f.y + f.l / 2, f.z + f.h / 2); return brush(g); }
  if (f.type === 'cylinder') {
    const g = new THREE.CylinderGeometry(f.d / 2, f.d / 2, f.h, 72);
    if (f.axis === 'Z' || !f.axis) g.rotateX(Math.PI / 2); else if (f.axis === 'X') g.rotateZ(-Math.PI / 2);
    const off = f.axis === 'X' ? [f.h / 2, 0, 0] : f.axis === 'Y' ? [0, f.h / 2, 0] : [0, 0, f.h / 2];
    g.translate(f.x + off[0], f.y + off[1], f.z + off[2]); return brush(g);
  }
  const g = new THREE.SphereGeometry(f.d / 2, 64, 32); g.translate(f.x, f.y, f.z); return brush(g);
}
function importTool(f, imports) {
  const rec = imports?.get(f.asset); if (rec?.error) throw new Error(rec.error);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(rec.mesh.position.slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(rec.mesh.normal.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(rec.mesh.index.slice(), 1));
  const m = new THREE.Matrix4().makeTranslation(f.x, f.y, f.z).multiply(new THREE.Matrix4().makeRotationZ((f.rz * Math.PI) / 180)).multiply(new THREE.Matrix4().makeScale(f.scale, f.scale, f.scale));
  return brush(g.toNonIndexed(), m);
}
function applyOp(body, tool, op) {
  if (!body || op === 'new') return tool;
  const m = manifoldBoolean(body.geometry, tool.geometry, op === 'cut' ? 'subtract' : op); // exact when both are closed
  if (m && !m.empty) { const b = new Brush(m.geometry); b.updateMatrixWorld(); return b; }
  const r = evaluator.evaluate(body, tool, OPS[op] ?? ADDITION);
  r.updateMatrixWorld(); return r;
}
function transformed(b, m, flip = false) {
  const g = b.geometry.clone(); g.applyMatrix4(m);
  if (flip) { // mirror: reverse triangle winding
    const ix = g.index; if (ix) { const a = ix.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } ix.needsUpdate = true; }
    else { const p = g.attributes.position.array, nn = g.attributes.normal?.array; for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; if (nn) { const u = nn[i + 3 + k]; nn[i + 3 + k] = nn[i + 6 + k]; nn[i + 6 + k] = u; } } }
    g.computeVertexNormals();
  }
  return brush(g);
}
const axisVec = (a) => a === 'X' ? new THREE.Vector3(1, 0, 0) : a === 'Y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);

export const meshKernel = {
  name: 'Fast mesh kernel', precise: false,
  build(features, { imports } = {}) {
    let body = null; const tools = {}; const errors = {}; const warnings = {};
    for (const f of features) {
      try {
        if (f.type === 'import' && !imports?.get(f.asset)) { warnings[f.id] = f.asset ? 'Reading the STEP file… (needs the precise kernel)' : 'No STEP file attached'; continue; }
        if (f.type === 'extrude' || f.type === 'revolve' || f.type === 'box' || f.type === 'cylinder' || f.type === 'sphere' || f.type === 'import') {
          const t = f.type === 'extrude' ? extrudeTool(f) : f.type === 'revolve' ? revolveTool(f) : f.type === 'import' ? importTool(f, imports) : primTool(f);
          if (!body && (f.op === 'cut' || f.op === 'intersect')) throw new Error('Nothing to ' + f.op + ' yet — make this the first solid with “New”');
          body = applyOp(body, t, body ? (f.op === 'new' ? 'add' : f.op) : 'new'); tools[f.id] = { list: [t], op: f.op === 'new' ? 'add' : f.op };
        } else if (f.type === 'hole') {
          if (!body) throw new Error('A hole needs a solid to cut into');
          const ts = holeTools(f); for (const t of ts) body = applyOp(body, t, 'cut'); tools[f.id] = { list: ts, op: 'cut' };
        } else if (f.type === 'pattern') {
          const src = tools[f.of]; if (!src) throw new Error('Pick a feature to pattern');
          for (let i = 1; i < f.count; i++) {
            const m = f.kind === 'circular' ? new THREE.Matrix4().makeRotationAxis(axisVec(f.axis), (((f.angle >= 360 ? 360 / f.count : f.angle / Math.max(1, f.count - 1)) * i) * Math.PI) / 180)
              : new THREE.Matrix4().makeTranslation(f.dx * i, f.dy * i, f.dz * i);
            for (const t of src.list) body = applyOp(body, transformed(t, m), src.op);
          }
        } else if (f.type === 'mirror') {
          if (!body) throw new Error('Nothing to mirror yet');
          const s = f.plane === 'YZ' ? [-1, 1, 1] : f.plane === 'XZ' ? [1, -1, 1] : [1, 1, -1];
          body = applyOp(body, transformed(body, new THREE.Matrix4().makeScale(...s), true), 'add');
        } else if (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'shell') {
          warnings[f.id] = `${f.type[0].toUpperCase() + f.type.slice(1)} needs the precise kernel — skipped in fast mode`;
        }
      } catch (e) { errors[f.id] = e.message || String(e); }
    }
    if (!body) return { mesh: null, edges: null, errors, warnings, solid: null };
    const g = body.geometry.clone(); g.computeVertexNormals();
    const edges = new THREE.EdgesGeometry(g, 28).attributes.position.array;
    return { mesh: { position: g.attributes.position.array, normal: g.attributes.normal.array, index: g.index ? g.index.array : null }, edges, errors, warnings, solid: body };
  },
  drawingSVG() { return null; },
  exportSTEP() { return null; },
};
