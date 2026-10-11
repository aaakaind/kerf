// 2D geometry: affine matrices, cubic-Bézier path model, bounds, hit-testing, SVG path parsing.
// Path model: subpaths [{closed, pts:[{x,y, ix,iy (in-handle), ox,oy (out-handle)}]}], handles absolute.
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PT_PER_MM = 72 / 25.4;
export const UNITS = { pt: 1, mm: PT_PER_MM, cm: PT_PER_MM * 10, in: 72, px: 0.75 };
export const toUnit = (pt, u) => pt / (UNITS[u] || 1);
export const fromUnit = (v, u) => v * (UNITS[u] || 1);

// ---------- matrices [a,b,c,d,e,f] ----------
export const I = () => [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const tr = (x, y) => [1, 0, 0, 1, x, y];
export const sc = (sx, sy, cx = 0, cy = 0) => mul(tr(cx, cy), mul([sx, 0, 0, sy, 0, 0], tr(-cx, -cy)));
export const rot = (a, cx = 0, cy = 0) => { const c = Math.cos(a), s = Math.sin(a); return mul(tr(cx, cy), mul([c, s, -s, c, 0, 0], tr(-cx, -cy))); };
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };

// ---------- path construction ----------
export const P = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
export const isCorner = (p) => p.ix === p.x && p.iy === p.y && p.ox === p.x && p.oy === p.y;
const K = 0.5522847498;
export function rectPath(x, y, w, h, r = 0) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  if (!r) return [{ closed: true, pts: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)] }];
  const k = r * K, pts = [];
  const add = (x, y, ix, iy, ox, oy) => pts.push({ x, y, ix, iy, ox, oy });
  add(x + r, y, x + r - k, y, x + r, y); add(x + w - r, y, x + w - r, y, x + w - r + k, y);
  add(x + w, y + r, x + w, y + r - k, x + w, y + r); add(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k);
  add(x + w - r, y + h, x + w - r + k, y + h, x + w - r, y + h); add(x + r, y + h, x + r, y + h, x + r - k, y + h);
  add(x, y + h - r, x, y + h - r + k, x, y + h - r); add(x, y + r, x, y + r, x, y + r - k);
  return [{ closed: true, pts }];
}
export function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * K, ky = ry * K;
  return [{ closed: true, pts: [
    { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ky, ox: cx + rx, oy: cy + ky },
    { x: cx, y: cy + ry, ix: cx + kx, iy: cy + ry, ox: cx - kx, oy: cy + ry },
    { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ky, ox: cx - rx, oy: cy - ky },
    { x: cx, y: cy - ry, ix: cx - kx, iy: cy - ry, ox: cx + kx, oy: cy - ry },
  ] }];
}
export function polygonPath(cx, cy, r, n, a0 = -Math.PI / 2) {
  const pts = []; for (let i = 0; i < n; i++) { const a = a0 + i * 2 * Math.PI / n; pts.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
  return [{ closed: true, pts }];
}
export function starPath(cx, cy, r1, r2, n, a0 = -Math.PI / 2) {
  const pts = []; for (let i = 0; i < n * 2; i++) { const a = a0 + i * Math.PI / n, r = i % 2 ? r2 : r1; pts.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
  return [{ closed: true, pts }];
}

// ---------- path → SVG d ----------
const f = (n) => (Math.round(n * 1000) / 1000).toString();
export function subpathsD(subpaths) {
  let d = '';
  for (const sp of subpaths) {
    const pts = sp.pts; if (!pts.length) continue;
    d += `M${f(pts[0].x)} ${f(pts[0].y)}`;
    const n = pts.length, segs = sp.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) d += `L${f(b.x)} ${f(b.y)}`;
      else d += `C${f(a.ox)} ${f(a.oy)} ${f(b.ix)} ${f(b.iy)} ${f(b.x)} ${f(b.y)}`;
    }
    if (sp.closed) d += 'Z';
  }
  return d;
}
export function* segments(sp) {
  const n = sp.pts.length, segs = sp.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) { const a = sp.pts[i], b = sp.pts[(i + 1) % n]; yield [a.x, a.y, a.ox, a.oy, b.ix, b.iy, b.x, b.y, i]; }
}

// ---------- cubic math ----------
export function cubicAt(c, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, d = t * t * t;
  return [a * c[0] + b * c[2] + cc * c[4] + d * c[6], a * c[1] + b * c[3] + cc * c[5] + d * c[7]];
}
function cubicExtrema(p0, p1, p2, p3) { // roots of derivative in (0,1)
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0, out = [];
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); }
  else { const disc = b * b - 4 * a * c; if (disc >= 0) { const s = Math.sqrt(disc); out.push((-b + s) / (2 * a), (-b - s) / (2 * a)); } }
  return out.filter(t => t > 0 && t < 1);
}
export function splitCubic(c, t) { // returns [left, right] each 8 numbers
  const [x0, y0, x1, y1, x2, y2, x3, y3] = c, l = (a, b) => a + (b - a) * t;
  const x01 = l(x0, x1), y01 = l(y0, y1), x12 = l(x1, x2), y12 = l(y1, y2), x23 = l(x2, x3), y23 = l(y2, y3);
  const x012 = l(x01, x12), y012 = l(y01, y12), x123 = l(x12, x23), y123 = l(y12, y23), xm = l(x012, x123), ym = l(y012, y123);
  return [[x0, y0, x01, y01, x012, y012, xm, ym], [xm, ym, x123, y123, x23, y23, x3, y3]];
}
export function nearestOnSubpath(sp, x, y) {
  let best = { d: Infinity };
  for (const s of segments(sp)) {
    const c = s.slice(0, 8);
    for (let k = 0; k <= 48; k++) { const t = k / 48, [px, py] = cubicAt(c, t), d = (px - x) ** 2 + (py - y) ** 2; if (d < best.d) best = { d, seg: s[8], t, x: px, y: py }; }
  }
  if (best.seg == null) return null;
  // refine
  const s = [...segments(sp)][best.seg].slice(0, 8); let lo = Math.max(0, best.t - 1 / 48), hi = Math.min(1, best.t + 1 / 48);
  for (let i = 0; i < 20; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; const a = cubicAt(s, m1), b = cubicAt(s, m2); if ((a[0] - x) ** 2 + (a[1] - y) ** 2 < (b[0] - x) ** 2 + (b[1] - y) ** 2) hi = m2; else lo = m1; }
  const t = (lo + hi) / 2, [px, py] = cubicAt(s, t);
  return { seg: best.seg, t, x: px, y: py, d: Math.hypot(px - x, py - y) };
}
/** Insert an anchor into a subpath at segment index `seg`, parameter t. */
export function insertAnchor(sp, seg, t) {
  const n = sp.pts.length, a = sp.pts[seg], b = sp.pts[(seg + 1) % n];
  const c = [a.x, a.y, a.ox, a.oy, b.ix, b.iy, b.x, b.y];
  const [L, R] = splitCubic(c, t);
  a.ox = L[2]; a.oy = L[3]; b.ix = R[4]; b.iy = R[5];
  const np = { x: L[6], y: L[7], ix: L[4], iy: L[5], ox: R[2], oy: R[3] };
  sp.pts.splice(seg + 1, 0, np);
  return seg + 1;
}

// ---------- bounds ----------
export function subpathsBounds(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  for (const sp of subpaths) {
    if (sp.pts.length === 1) add(sp.pts[0].x, sp.pts[0].y);
    for (const s of segments(sp)) {
      add(s[0], s[1]); add(s[6], s[7]);
      for (const t of cubicExtrema(s[0], s[2], s[4], s[6])) add(...cubicAt(s, t));
      for (const t of cubicExtrema(s[1], s[3], s[5], s[7])) add(...cubicAt(s, t));
    }
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export function unionBounds(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of list) { if (!b) continue; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const transformSubpaths = (subpaths, m) => {
  for (const sp of subpaths) for (const p of sp.pts) {
    [p.x, p.y] = apply(m, p.x, p.y); [p.ix, p.iy] = apply(m, p.ix, p.iy); [p.ox, p.oy] = apply(m, p.ox, p.oy);
  }
};
export const reverseSubpath = (sp) => { sp.pts.reverse(); for (const p of sp.pts) { [p.ix, p.ox] = [p.ox, p.ix]; [p.iy, p.oy] = [p.oy, p.iy]; } };
/** Signed area by polyline approximation (for orientation & area readouts). */
export function subpathArea(sp, samples = 12) {
  let a = 0, prev = null, first = null;
  for (const s of segments(sp)) for (let k = 0; k < samples; k++) { const p = cubicAt(s, k / samples); if (prev) a += prev[0] * p[1] - p[0] * prev[1]; else first = p; prev = p; }
  if (prev && first) a += prev[0] * first[1] - first[0] * prev[1];
  return a / 2;
}
/** Flatten to polygons (for extrusion, CAD profiles, PDF fallback). */
export function flatten(subpaths, tol = 0.5) {
  return subpaths.map(sp => {
    const out = [];
    if (!sp.pts.length) return { closed: sp.closed, pts: out };
    out.push([sp.pts[0].x, sp.pts[0].y]);
    for (const s of segments(sp)) {
      const straight = s[2] === s[0] && s[3] === s[1] && s[4] === s[6] && s[5] === s[7];
      if (straight) { out.push([s[6], s[7]]); continue; }
      const len = Math.hypot(s[2] - s[0], s[3] - s[1]) + Math.hypot(s[4] - s[2], s[5] - s[3]) + Math.hypot(s[6] - s[4], s[7] - s[5]);
      const n = Math.max(4, Math.min(64, Math.ceil(len / (tol * 6))));
      for (let k = 1; k <= n; k++) out.push(cubicAt(s, k / n));
    }
    if (sp.closed && out.length > 1) { const a = out[0], b = out[out.length - 1]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) out.pop(); }
    return { closed: sp.closed, pts: out };
  });
}

// ---------- hit testing ----------
let hitCtx;
function ctx() { if (!hitCtx) hitCtx = document.createElement('canvas').getContext('2d'); return hitCtx; }
export function hitPath(d, x, y, { fill = true, strokeWidth = 0, rule = 'nonzero' } = {}) {
  const c = ctx(), p = new Path2D(d);
  if (fill && c.isPointInPath(p, x, y, rule)) return true;
  if (strokeWidth > 0) { c.lineWidth = strokeWidth; return c.isPointInStroke(p, x, y); }
  return false;
}
export function measureText(text, font) { const c = ctx(); c.font = font; return c.measureText(text); }

// ---------- SVG path data parser (M L H V C S Q T A Z, abs + rel) ----------
export function parsePathD(d) {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const subs = []; let sp = null, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '', i = 0, lastC = null, lastQ = null;
  const num = () => parseFloat(toks[i++]);
  const isNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  const start = (x, y) => { sp = { closed: false, pts: [P(x, y)] }; subs.push(sp); sx = x; sy = y; };
  const last = () => sp.pts[sp.pts.length - 1];
  const cubic = (x1, y1, x2, y2, x, y) => { const l = last(); l.ox = x1; l.oy = y1; sp.pts.push({ x, y, ix: x2, iy: y2, ox: x, oy: y }); };
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++]; else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === 'Z') { if (sp) { sp.closed = true; const a = sp.pts[0], b = last(); if (sp.pts.length > 1 && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) { a.ix = b.ix; a.iy = b.iy; sp.pts.pop(); } } cx = sx; cy = sy; sp = null; lastC = lastQ = null; continue; }
    if (!isNum()) continue;
    do {
      if (C === 'M') { let x = num(), y = num(); if (rel) { x += cx; y += cy; } start(x, y); cx = x; cy = y; cmd = rel ? 'l' : 'L'; lastC = lastQ = null; break; }
      if (!sp) start(cx, cy);
      if (C === 'L') { let x = num(), y = num(); if (rel) { x += cx; y += cy; } sp.pts.push(P(x, y)); cx = x; cy = y; lastC = lastQ = null; }
      else if (C === 'H') { let x = num(); if (rel) x += cx; sp.pts.push(P(x, cy)); cx = x; lastC = lastQ = null; }
      else if (C === 'V') { let y = num(); if (rel) y += cy; sp.pts.push(P(cx, y)); cy = y; lastC = lastQ = null; }
      else if (C === 'C') { let a = [num(), num(), num(), num(), num(), num()]; if (rel) a = a.map((v, k) => v + (k % 2 ? cy : cx)); cubic(...a); lastC = [a[2], a[3]]; cx = a[4]; cy = a[5]; lastQ = null; }
      else if (C === 'S') { let a = [num(), num(), num(), num()]; if (rel) a = a.map((v, k) => v + (k % 2 ? cy : cx)); const x1 = lastC ? 2 * cx - lastC[0] : cx, y1 = lastC ? 2 * cy - lastC[1] : cy; cubic(x1, y1, ...a); lastC = [a[0], a[1]]; cx = a[2]; cy = a[3]; lastQ = null; }
      else if (C === 'Q' || C === 'T') {
        let qx, qy, x, y;
        if (C === 'Q') { qx = num(); qy = num(); x = num(); y = num(); if (rel) { qx += cx; qy += cy; x += cx; y += cy; } }
        else { x = num(); y = num(); if (rel) { x += cx; y += cy; } qx = lastQ ? 2 * cx - lastQ[0] : cx; qy = lastQ ? 2 * cy - lastQ[1] : cy; }
        cubic(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y); lastQ = [qx, qy]; lastC = null; cx = x; cy = y;
      }
      else if (C === 'A') {
        let [rx, ry, phi, fa, fs, x, y] = [num(), num(), num(), num(), num(), num(), num()]; if (rel) { x += cx; y += cy; }
        for (const c of arcToCubics(cx, cy, rx, ry, phi, fa, fs, x, y)) cubic(...c);
        cx = x; cy = y; lastC = lastQ = null;
      } else { i++; }
    } while (isNum());
  }
  return subs.filter(s => s.pts.length > 0);
}
function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), spn = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cp * dx + spn * dy, y1p = -spn * dx + cp * dy;
  rx = Math.abs(rx); ry = Math.abs(ry); const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const s = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = s * rx * y1p / ry, cyp = -s * ry * x1p / rx, cx = cp * cxp - spn * cyp + (x1 + x2) / 2, cy = spn * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  let t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry), dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2)), d = dt / n, k = 4 / 3 * Math.tan(d / 4), out = [];
  const pt = (t) => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * spn, cy + rx * Math.cos(t) * spn + ry * Math.sin(t) * cp];
  const dv = (t) => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * spn, -rx * Math.sin(t) * spn + ry * Math.cos(t) * cp];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * d, b = a + d, pa = pt(a), pb = pt(b), da = dv(a), db = dv(b);
    out.push([pa[0] + k * da[0], pa[1] + k * da[1], pb[0] - k * db[0], pb[1] - k * db[1], pb[0], pb[1]]);
  }
  return out;
}
/** Parse an SVG document into KERF vector items (paths & basic shapes, nested transforms flattened). */
export function svgToSubpathItems(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement; if (root.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG file');
  const out = [];
  const parseTf = (s) => {
    let m = I(); if (!s) return m;
    for (const [, name, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
      const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
      if (name === 'matrix') m = mul(m, a);
      else if (name === 'translate') m = mul(m, tr(a[0], a[1] || 0));
      else if (name === 'scale') m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
      else if (name === 'rotate') m = mul(m, rot((a[0] * Math.PI) / 180, a[1] || 0, a[2] || 0));
    }
    return m;
  };
  const style = (el, k) => { const st = el.getAttribute('style') || ''; const m = st.match(new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*([^;]+)')); return (m ? m[1] : el.getAttribute(k))?.trim(); };
  const walk = (el, m, inh) => {
    for (const c of el.children) {
      const tag = c.nodeName.toLowerCase(); const mm = mul(m, parseTf(c.getAttribute('transform')));
      const fill = style(c, 'fill') ?? inh.fill, stroke = style(c, 'stroke') ?? inh.stroke, sw = parseFloat(style(c, 'stroke-width') ?? inh.sw ?? 1);
      const ctx2 = { fill, stroke, sw, dash: style(c, 'stroke-dasharray') ?? inh.dash };
      if (tag === 'g' || tag === 'svg') { walk(c, mm, ctx2); continue; }
      let subs = null; const g = (k) => parseFloat(c.getAttribute(k) || 0);
      if (tag === 'path') subs = parsePathD(c.getAttribute('d') || '');
      else if (tag === 'rect') subs = rectPath(g('x'), g('y'), g('width'), g('height'), g('rx') || g('ry'));
      else if (tag === 'circle') subs = ellipsePath(g('cx'), g('cy'), g('r'), g('r'));
      else if (tag === 'ellipse') subs = ellipsePath(g('cx'), g('cy'), g('rx'), g('ry'));
      else if (tag === 'line') subs = [{ closed: false, pts: [P(g('x1'), g('y1')), P(g('x2'), g('y2'))] }];
      else if (tag === 'polygon' || tag === 'polyline') { const n = (c.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number); const pts = []; for (let k = 0; k + 1 < n.length; k += 2) pts.push(P(n[k], n[k + 1])); subs = [{ closed: tag === 'polygon', pts }]; }
      if (subs && subs.length) {
        transformSubpaths(subs, mm);
        const col = (v) => (!v || v === 'none' || v.startsWith('url')) ? null : v;
        const dash = style(c, 'stroke-dasharray') ?? inh.dash;
        out.push({ subpaths: subs, fill: fill === undefined ? '#000000' : col(fill), stroke: col(stroke), sw: sw * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])), rule: style(c, 'fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero', dash: dash && dash !== 'none' ? dash : null });
      }
    }
  };
  walk(root, I(), { fill: undefined, stroke: undefined, sw: 1 });
  return out;
}
