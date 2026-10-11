// Closed-loop utilities shared by Mesh extrusion and CAD profiles: flatten Bézier subpaths, nest holes by containment.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as G from './geom.js';

export function polyArea(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return a / 2; }
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Nest closed polygons into outer shapes with holes (even depth = solid, odd depth = hole). Output CCW outers, CW holes. */
export function nestLoops(polys) {
  const loops = polys.filter(p => p.length >= 3).map(pts => ({ pts, area: Math.abs(polyArea(pts)), parent: null, depth: 0 }));
  loops.sort((a, b) => b.area - a.area);
  for (let i = 0; i < loops.length; i++) {
    const L = loops[i]; const [x, y] = interiorProbe(L.pts);
    for (let j = i - 1; j >= 0; j--) { if (pointInPoly(x, y, loops[j].pts)) { L.parent = loops[j]; L.depth = loops[j].depth + 1; break; } }
  }
  const out = [];
  for (const L of loops) if (L.depth % 2 === 0) out.push({ outer: orient(L.pts, true), holes: [], ref: L });
  for (const L of loops) if (L.depth % 2 === 1) { const o = out.find(s => s.ref === L.parent); if (o) o.holes.push(orient(L.pts, false)); }
  return out.map(({ outer, holes }) => ({ outer, holes }));
}
function interiorProbe(pts) { // a point near the first vertex that is inside the polygon
  const [a, b] = [pts[0], pts[1]]; const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1;
  const eps = Math.max(1e-4, l * 1e-3); const p1 = [mx - dy / l * eps, my + dx / l * eps];
  return pointInPoly(p1[0], p1[1], pts) ? p1 : [mx + dy / l * eps, my - dx / l * eps];
}
function orient(pts, ccw) { const a = polyArea(pts); return (a > 0) === ccw ? pts.slice() : pts.slice().reverse(); }

/** Vector item subpaths (px, y-down) → nested loops in model units (y-up), scaled so the largest side = size. */
export function subpathsToLoops(subpaths, { size = null, scale = 1, center = true } = {}) {
  const flat = G.flatten(subpaths.filter(s => s.closed), 0.25).map(s => s.pts);
  const b = G.subpathsBounds(subpaths);
  const k = size ? size / Math.max(b.w, b.h, 1e-9) : scale;
  const cx = center ? b.x + b.w / 2 : 0, cy = center ? b.y + b.h / 2 : 0;
  const polys = flat.map(pts => pts.map(([x, y]) => [(x - cx) * k, -(y - cy) * k]));
  return nestLoops(polys);
}
/** Sample a rounded polygon corner set: pts with fillet radius r at every corner. */
export function filletPolygon(pts, r, seg = 6) {
  if (!r || r <= 0 || pts.length < 3) return pts;
  const out = []; const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2); if (l1 < 1e-9 || l2 < 1e-9) { out.push(p1); continue; }
    const u1 = [v1[0] / l1, v1[1] / l1], u2 = [v2[0] / l2, v2[1] / l2];
    const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (ang < 1e-3 || Math.abs(ang - Math.PI) < 1e-3) { out.push(p1); continue; }
    const t = Math.min(r / Math.tan(ang / 2), l1 / 2, l2 / 2); const rr = t * Math.tan(ang / 2);
    const a = [p1[0] + u1[0] * t, p1[1] + u1[1] * t], b = [p1[0] + u2[0] * t, p1[1] + u2[1] * t];
    const bis = [u1[0] + u2[0], u1[1] + u2[1]]; const bl = Math.hypot(...bis); const d = rr / Math.sin(ang / 2);
    const c = [p1[0] + bis[0] / bl * d, p1[1] + bis[1] / bl * d];
    let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    for (let s = 0; s <= seg; s++) { const aa = a0 + da * s / seg; out.push([c[0] + Math.cos(aa) * rr, c[1] + Math.sin(aa) * rr]); }
  }
  return out;
}
