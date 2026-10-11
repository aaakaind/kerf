// Precise CAD kernel: OpenCascade B-rep via replicad. Real fillets, chamfers, shells, STEP export, hidden-line drawings.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as R from 'replicad';
import Module from 'replicad-opencascadejs';
import { PLANES, profileLoops } from './profiles.js';
import { sketchLoops, loopPoly, arcMid } from './sketch-core.js';
import { polyArea, pointInPoly } from '../../core/shapes.js';

let ready = null;
export function initOCCT(wasmBinary) {
  if (!ready) ready = (async () => { const OC = await Module({ wasmBinary, locateFile: () => 'occt.wasm', print: () => {}, printErr: () => {} }); R.setOC(OC); return true; })();
  return ready;
}

function profileDrawing(p) {
  switch (p.type) {
    case 'rect': return (p.r > 0 ? R.drawRoundedRectangle(p.w, p.h, Math.min(p.r, p.w / 2 - 1e-4, p.h / 2 - 1e-4)) : R.drawRectangle(p.w, p.h)).translate(p.cx, p.cy);
    case 'circle': return R.drawCircle(p.d / 2).translate(p.cx, p.cy);
    case 'polygon': return R.drawPolysides(p.d / 2, Math.max(3, Math.round(p.n))).rotate(p.rot || 0).translate(p.cx, p.cy);
    case 'slot': return R.drawRoundedRectangle(Math.max(p.l, p.w + 1e-3), p.w, p.w / 2 - 1e-4).rotate(p.rot || 0).translate(p.cx, p.cy);
    case 'poly': {
      let pen = R.draw(p.pts[0]); for (let i = 1; i < p.pts.length; i++) pen = pen.lineTo(p.pts[i]);
      let d = pen.close(); if (p.r > 0) d = d.fillet(p.r); return d;
    }
    case 'sketch': return sketchDrawing(p.sk);
    case 'vector': {
      const loops = profileLoops(p); let shape = null;
      for (const { outer, holes } of loops) {
        let d = polyDrawing(outer); for (const hh of holes) d = d.cut(polyDrawing(hh));
        shape = shape ? shape.fuse(d) : d;
      }
      if (!shape) throw new Error('The vector path has no closed area');
      return shape;
    }
  }
  throw new Error('Unknown profile');
}
/** Exact sketch profile: lines stay lines and arcs stay true arcs in the B-rep. Nesting by even–odd containment. */
function sketchDrawing(sk) {
  const { loops, open } = sketchLoops(sk || { ents: [], cons: [] });
  if (!loops.length) throw new Error(open ? `The sketch is not closed — ${open} open end${open > 1 ? 's' : ''}. Join the outline or make stray lines construction.` : 'The sketch has no closed outline yet');
  const polys = loops.map(L => loopPoly(L, 32));
  const depth = polys.map((pp, i) => { const a = Math.abs(polyArea(pp)); const q = pp[0]; const probe = [q[0] + (pp[1][0] - q[0]) * 0.5, q[1] + (pp[1][1] - q[1]) * 0.5];
    const c = polys.reduce((t, other) => t + (other !== pp && Math.abs(polyArea(other)) > a && pointInPoly(...centroidish(pp, probe), other) ? 1 : 0), 0); void i; return c; });
  const order = loops.map((L, i) => i).sort((a, b) => depth[a] - depth[b]);
  let shape = null;
  for (const i of order) {
    const d = loopDrawing(loops[i]);
    if (depth[i] % 2 === 0) shape = shape ? shape.fuse(d) : d; else if (shape) shape = shape.cut(d);
  }
  return shape;
}
function centroidish(pp, fallback) { let x = 0, y = 0; for (const q of pp) { x += q[0]; y += q[1]; } x /= pp.length; y /= pp.length; return pointInPoly(x, y, pp) ? [x, y] : fallback; }
function loopDrawing(L) {
  if (L.circle) return R.drawCircle(L.circle.r).translate(L.circle.c[0], L.circle.c[1]);
  const segs = L.segs; let pen = R.draw(segs[0].from);
  segs.forEach((s, i) => {
    const to = i === segs.length - 1 ? segs[0].from : s.to; // close exactly on the first point
    if (i === segs.length - 1 && s.kind === 'line') return; // close() draws the last straight edge
    pen = s.kind === 'line' ? pen.lineTo(to) : pen.threePointsArcTo(to, arcMid(s));
  });
  return pen.close();
}
function polyDrawing(pts) {
  // drop near-duplicate points; OpenCascade rejects zero-length edges
  const clean = []; for (const q of pts) { const l = clean[clean.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-4) clean.push(q); }
  if (clean.length > 2 && Math.hypot(clean[0][0] - clean.at(-1)[0], clean[0][1] - clean.at(-1)[1]) < 1e-4) clean.pop();
  let pen = R.draw(clean[0]); for (let i = 1; i < clean.length; i++) pen = pen.lineTo(clean[i]); return pen.close();
}
function sketch(d, plane, offset) { return d.sketchOnPlane(plane, offset); }
function extrudeTool(f) {
  const d = profileDrawing(f.profile);
  if (!(f.depth > 0)) throw new Error('Depth must be greater than zero');
  if (f.dir === 'reverse') return sketch(d, f.plane, f.offset - f.depth).extrude(f.depth);
  if (f.dir === 'symmetric') return sketch(d, f.plane, f.offset - f.depth / 2).extrude(f.depth);
  return sketch(d, f.plane, f.offset).extrude(f.depth);
}
function revolveTool(f) {
  const loops = profileLoops(f.profile); if (loops[0]?.outer.some(([u]) => u < -1e-6)) throw new Error('A revolve profile must sit on one side of the axis (U ≥ 0)');
  const d = profileDrawing(f.profile); const v = PLANES[f.plane].v; const n = PLANES[f.plane].n;
  const origin = n.map(c => c * f.offset);
  return sketch(d, f.plane, f.offset).revolve(v, { origin, angle: Math.min(360, Math.max(0.1, f.angle)) });
}
function holeTools(f) {
  if (!(f.d > 0)) throw new Error('Diameter must be greater than zero');
  const L = 5000, out = [];
  const make = (dia, from, len) => sketch(R.drawCircle(dia / 2).translate(f.x, f.y), f.plane, f.offset + from).extrude(len);
  out.push(f.depth > 0 ? make(f.d, -f.depth, f.depth + 0.01) : make(f.d, -L, 2 * L));
  if (f.cbd > f.d && f.cbdepth > 0) out.push(make(f.cbd, -f.cbdepth, f.cbdepth + 0.01));
  return out;
}
function primTool(f) {
  if (f.type === 'box') return R.makeBox([f.x, f.y, f.z], [f.x + f.w, f.y + f.l, f.z + f.h]);
  if (f.type === 'cylinder') return R.makeCylinder(f.d / 2, f.h, [f.x, f.y, f.z], f.axis === 'X' ? [1, 0, 0] : f.axis === 'Y' ? [0, 1, 0] : [0, 0, 1]);
  return R.makeSphere(f.d / 2).translate(f.x, f.y, f.z);
}
function applyOp(body, tool, op) {
  if (!body || op === 'new') return tool;
  if (op === 'cut') return body.cut(tool);
  if (op === 'intersect') return body.intersect(tool);
  return body.fuse(tool);
}
function edgeFinder(kind, bb) {
  const [[x0, y0, z0], [x1, y1, z1]] = bb.bounds;
  switch (kind) {
    case 'X': case 'Y': case 'Z': return (e) => e.inDirection(kind);
    case 'top': return (e) => e.inPlane('XY', [0, 0, z1]);
    case 'bottom': return (e) => e.inPlane('XY', [0, 0, z0]);
    case 'front': return (e) => e.inPlane('XZ', [0, y0, 0]);
    case 'back': return (e) => e.inPlane('XZ', [0, y1, 0]);
    case 'left': return (e) => e.inPlane('YZ', [x0, 0, 0]);
    case 'right': return (e) => e.inPlane('YZ', [x1, 0, 0]);
    default: return undefined;
  }
}
function faceFinder(kind, bb) {
  const [[x0, y0, z0], [x1, y1, z1]] = bb.bounds;
  return {
    top: (f) => f.inPlane('XY', [0, 0, z1]), bottom: (f) => f.inPlane('XY', [0, 0, z0]),
    front: (f) => f.inPlane('XZ', [0, y0, 0]), back: (f) => f.inPlane('XZ', [0, y1, 0]),
    left: (f) => f.inPlane('YZ', [x0, 0, 0]), right: (f) => f.inPlane('YZ', [x1, 0, 0]),
  }[kind] || ((f) => f.inPlane('XY', [0, 0, z1]));
}
function polylineSegments(lines, groups) { // replicad edge polylines → line-segment pairs
  const out = [];
  for (const g of groups) {
    for (let i = g.start; i < g.start + g.count - 1; i++) out.push(lines[i * 3], lines[i * 3 + 1], lines[i * 3 + 2], lines[i * 3 + 3], lines[i * 3 + 4], lines[i * 3 + 5]);
  }
  return new Float32Array(out);
}

/** Read a STEP file (bytes) into a solid plus a display mesh (also used by the fast kernel). */
export async function readSTEP(bytes) {
  const shape = await R.importSTEP(new Blob([bytes]));
  const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
  return { shape, mesh: { position: new Float32Array(m.vertices), normal: new Float32Array(m.normals), index: new Uint32Array(m.triangles) } };
}
function importTool(f, imports) {
  const rec = imports?.get(f.asset);
  if (!rec) return null;
  if (rec.error) throw new Error(rec.error);
  let t = rec.shape.clone();
  if (f.scale !== 1) t = t.scale(f.scale, [0, 0, 0]);
  if (f.rz) t = t.rotate(f.rz, [0, 0, 0], [0, 0, 1]);
  return t.translate(f.x, f.y, f.z);
}

export const occtKernel = {
  name: 'Precise kernel (OpenCascade)', precise: true,
  build(features, { tolerance = 0.05, imports } = {}) {
    let body = null; const tools = {}; const errors = {}; const warnings = {};
    for (const f of features) {
      try {
        if (f.type === 'import' && !imports?.get(f.asset)) { warnings[f.id] = f.asset ? 'Reading the STEP file…' : 'No STEP file attached'; continue; }
        if (['extrude', 'revolve', 'box', 'cylinder', 'sphere', 'import'].includes(f.type)) {
          const t = f.type === 'extrude' ? extrudeTool(f) : f.type === 'revolve' ? revolveTool(f) : f.type === 'import' ? importTool(f, imports) : primTool(f);
          if (!body && (f.op === 'cut' || f.op === 'intersect')) throw new Error('Nothing to ' + f.op + ' yet — make this the first solid with “New”');
          const op = f.op === 'new' ? 'add' : f.op;
          body = applyOp(body, t.clone(), body ? op : 'new'); tools[f.id] = { list: [t], op };
        } else if (f.type === 'hole') {
          if (!body) throw new Error('A hole needs a solid to cut into');
          const ts = holeTools(f); for (const t of ts) body = body.cut(t.clone()); tools[f.id] = { list: ts, op: 'cut' };
        } else if (f.type === 'fillet' || f.type === 'chamfer') {
          if (!body) throw new Error('Nothing to round yet');
          const amt = f.type === 'fillet' ? f.r : f.d; if (!(amt > 0)) throw new Error('Size must be greater than zero');
          const fnd = edgeFinder(f.edges, body.boundingBox);
          body = f.type === 'fillet' ? body.fillet(amt, fnd) : body.chamfer(amt, fnd);
        } else if (f.type === 'shell') {
          if (!body) throw new Error('Nothing to shell yet');
          if (!(f.t > 0)) throw new Error('Wall thickness must be greater than zero');
          body = body.shell(f.t, faceFinder(f.face, body.boundingBox));
        } else if (f.type === 'pattern') {
          const src = tools[f.of]; if (!src) throw new Error('Pick a feature to pattern');
          const axis = f.axis === 'X' ? [1, 0, 0] : f.axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
          for (let i = 1; i < f.count; i++) {
            for (const t of src.list) {
              const c = t.clone();
              const moved = f.kind === 'circular' ? c.rotate((f.angle >= 360 ? 360 / f.count : f.angle / Math.max(1, f.count - 1)) * i, [0, 0, 0], axis) : c.translate(f.dx * i, f.dy * i, f.dz * i);
              body = applyOp(body, moved, src.op);
            }
          }
        } else if (f.type === 'mirror') {
          if (!body) throw new Error('Nothing to mirror yet');
          body = body.fuse(body.clone().mirror(f.plane, [0, 0, 0]));
        }
      } catch (e) { errors[f.id] = cleanErr(e); }
    }
    if (!body) return { mesh: null, edges: null, errors, warnings, solid: null };
    const m = body.mesh({ tolerance, angularTolerance: 0.25 });
    const em = body.meshEdges({ tolerance, angularTolerance: 0.25 });
    let props = null; try { const vp = R.measureShapeVolumeProperties(body); props = { volume: vp.volume, com: vp.centerOfMass }; vp.delete?.(); } catch { /* fall back to mesh props */ }
    let area = null; try { area = R.measureArea(body); } catch { /* optional */ }
    return { mesh: { position: new Float32Array(m.vertices), normal: new Float32Array(m.normals), index: new Uint32Array(m.triangles) }, edges: polylineSegments(em.lines, em.edgeGroups), errors, warnings, solid: body, exact: props ? { ...props, area } : null };
  },
  exportSTEP(solid) { return solid ? solid.blobSTEP() : null; },
  drawingSVG(solid, view = 'front') {
    if (!solid) return null;
    const { visible, hidden } = R.drawProjection(solid, view);
    const vb = visible.toSVGViewBox(0).split(/\s+/).map(Number); const [x, y, w, h] = vb;
    const pad = Math.max(w, h) * 0.16; const vbx = [x - pad, y - pad, w + pad * 2, h + pad * 2.2];
    const sw = Math.max(w, h) / 380;
    const vis = visible.toSVGPaths().flat().map(d => `<path d="${d}" fill="none" stroke="#1c1a17" stroke-width="${sw * 1.4}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    const hid = hidden ? hidden.toSVGPaths().flat().map(d => `<path d="${d}" fill="none" stroke="#625a4d" stroke-width="${sw * 0.8}" stroke-dasharray="${sw * 5} ${sw * 3}"/>`).join('') : '';
    const fs = Math.max(w, h) / 26; const yb = y + h + pad * 0.55, xr = x + w + pad * 0.55;
    const dim = (x1, y1, x2, y2, label, vertical) => {
      const tx = vertical ? x2 + fs * 0.4 : (x1 + x2) / 2, ty = vertical ? (y1 + y2) / 2 : y2 + fs * 1.2;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c8432b" stroke-width="${sw}"/>` +
        `<line x1="${vertical ? x1 - fs * 0.3 : x1}" y1="${vertical ? y1 : y1 - fs * 0.3}" x2="${vertical ? x1 + fs * 0.3 : x1}" y2="${vertical ? y1 : y1 + fs * 0.3}" stroke="#c8432b" stroke-width="${sw}"/>` +
        `<line x1="${vertical ? x2 - fs * 0.3 : x2}" y1="${vertical ? y2 : y2 - fs * 0.3}" x2="${vertical ? x2 + fs * 0.3 : x2}" y2="${vertical ? y2 : y2 + fs * 0.3}" stroke="#c8432b" stroke-width="${sw}"/>` +
        `<text x="${tx}" y="${ty}" font-family="IBM Plex Mono, monospace" font-size="${fs}" fill="#c8432b" text-anchor="${vertical ? 'start' : 'middle'}" dominant-baseline="${vertical ? 'middle' : 'auto'}">${label}</text>`;
    };
    const dims = dim(x, yb, x + w, yb, `${(+w).toFixed(1)}`, false) + dim(xr, y, xr, y + h, `${(+h).toFixed(1)}`, true);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbx.join(' ')}">${hid}${vis}${dims}</svg>`;
  },
};
function cleanErr(e) {
  const m = (e instanceof Error && e.message) ? e.message : '';
  if (!m) return 'The kernel could not build this feature with these sizes. Check that the feature touches the part, or try a smaller radius.';
  if (/^\d+$/.test(m) || /BRep|Standard_|OCC/i.test(m)) return 'The kernel could not build this feature with these sizes. Try a smaller radius or check the geometry.';
  return m;
}
