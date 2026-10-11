// Vector power tools built on open-source libraries:
//   image trace  — imagetracerjs (public domain / Unlicense)
//   DXF export   — @tarikjabiri/dxf (MIT)
//   DXF import   — dxf-parser (MIT)
// All functions work on KERF's subpath model: [{ closed, pts: [{x,y,ix,iy,ox,oy}] }] in px (1 px = 1 pt).
// SPDX-License-Identifier: AGPL-3.0-or-later
import ImageTracer from 'imagetracerjs';
import { DxfWriter, Units, LWPolylineFlags, point3d } from '@tarikjabiri/dxf';
import DxfParser from 'dxf-parser';
import * as G from './geom.js';

export const MM_PER_PX = 25.4 / 72;   // KERF vector px are PostScript points
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
const toHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);

// ---------------------------------------------------------------- image trace
export const TRACE_PRESETS = {
  bw: { label: 'Black & white (logos, line art)', colors: 2 },
  p4: { label: 'Posterize · 4 colours', colors: 4 },
  p8: { label: 'Posterize · 8 colours', colors: 8 },
  p16: { label: 'Detailed · 16 colours', colors: 16 },
};

/**
 * Trace a bitmap into filled vector paths.
 * @param {HTMLImageElement} img  decoded image
 * @param {{preset:string, detail:number, threshold:number, dropWhite:boolean, maxSize:number}} o
 * @returns {{items: Array, width:number, height:number}} items in the traced image's pixel space
 */
export function traceImage(img, o = {}) {
  const preset = TRACE_PRESETS[o.preset] ? o.preset : 'bw';
  const max = o.maxSize || 1000;
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  const imgd = g.getImageData(0, 0, w, h);
  const detail = Math.max(0, Math.min(1, o.detail ?? 0.5));          // 0 = smooth, 1 = tight
  const opts = {
    ltres: 2 - detail * 1.8, qtres: 2 - detail * 1.8, pathomit: Math.round(16 - detail * 12),
    rightangleenhance: true, colorsampling: 2, numberofcolors: TRACE_PRESETS[preset].colors, mincolorratio: 0,
    colorquantcycles: preset === 'bw' ? 1 : 3, blurradius: 0, blurdelta: 20, strokewidth: 0, linefilter: detail < 0.5,
    scale: 1, roundcoords: 2, viewbox: true, desc: false, lcpr: 0, qcpr: 0,
  };
  if (preset === 'bw') {
    // Threshold on luminance (transparent counts as white) and trace against a fixed two-colour palette.
    const t = o.threshold ?? 128, d = imgd.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255, lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * a + 255 * (1 - a);
      const v = lum < t ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    opts.pal = [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }];
  }
  const svg = ImageTracer.imagedataToSVG(imgd, opts);
  // Keep only visible paths; normalise rgb() fills to hex; optionally drop the white background layer.
  const kept = [];
  for (const m of svg.matchAll(/<path\b[^>]*>/g)) {
    const tag = m[0];
    const op = parseFloat((tag.match(/opacity="([\d.]+)"/) || [])[1] ?? '1');
    const rgb = (tag.match(/fill="rgb\((\d+),(\d+),(\d+)\)"/) || []).slice(1).map(Number);
    if (op < 0.05 || rgb.length < 3) continue;
    if (o.dropWhite !== false && rgb[0] > 242 && rgb[1] > 242 && rgb[2] > 242) continue;
    const d = (tag.match(/ d="([^"]+)"/) || [])[1]; if (!d) continue;
    kept.push(`<path fill="${toHex(...rgb)}" d="${d}"/>`);
  }
  const items = kept.length ? G.svgToSubpathItems(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${kept.join('')}</svg>`) : [];
  for (const it of items) { it.stroke = null; it.sw = 0; it.rule = 'evenodd'; }
  return { items, width: w, height: h };
}

// ---------------------------------------------------------------- DXF export
/** Exact conversion of one KERF subpath (cubic Béziers) to a clamped cubic B-spline. */
function subpathToSpline(sp, map) {
  const segs = [...G.segments(sp)]; if (!segs.length) return null;
  const cps = [map(segs[0][0], segs[0][1])];
  for (const s of segs) cps.push(map(s[2], s[3]), map(s[4], s[5]), map(s[6], s[7]));
  const n = segs.length, knots = [0, 0, 0, 0];
  for (let k = 1; k < n; k++) knots.push(k, k, k);
  knots.push(n, n, n, n);
  return { controlPoints: cps.map(([x, y]) => point3d(x, y, 0)), knots, degreeCurve: 3, flags: 8 /* planar */ };
}
const isStraight = (sp) => sp.pts.every(p => p.ix === p.x && p.iy === p.y && p.ox === p.x && p.oy === p.y);
/** Nearest AutoCAD colour index for the handful of colours laser software keys operations to. */
function aci(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || ''); if (!m) return 7;
  const [r, g, b] = m.slice(1).map(v => parseInt(v, 16));
  const table = [[1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255], [7, 0, 0, 0], [8, 128, 128, 128], [9, 192, 192, 192]];
  let best = 7, bd = Infinity; for (const [i, R, Gg, B] of table) { const dd = (R - r) ** 2 + (Gg - g) ** 2 + (B - b) ** 2; if (dd < bd) { bd = dd; best = i; } }
  return best;
}

/**
 * Build a DXF (R2000+, with handles and tables) from path items.
 * @param items  KERF vector items (only 'path' items are written)
 * @param o { units:'mm'|'in'|'px', curves:'polyline'|'spline', origin:{x,y,h} (artboard: DXF y-up from its bottom-left) }
 */
export function dxfFromItems(items, o = {}) {
  const units = o.units || 'mm';
  const k = units === 'mm' ? MM_PER_PX : units === 'in' ? 1 / 72 : 1;
  const ox = o.origin?.x || 0, oyBottom = (o.origin?.y || 0) + (o.origin?.h || 0);
  const map = (x, y) => [(x - ox) * k, (oyBottom - y) * k];
  const dxf = new DxfWriter();
  dxf.setUnits(units === 'mm' ? Units.Millimeters : units === 'in' ? Units.Inches : Units.Unitless);
  const layers = new Map(); let written = 0, skipped = 0;
  for (const it of items) {
    if (it.hidden) continue;
    if (it.type !== 'path') { skipped++; continue; }
    const col = typeof it.stroke === 'string' && it.sw > 0 ? it.stroke : typeof it.fill === 'string' ? it.fill : '#000000';
    const layer = 'KERF_' + col.replace('#', '').toUpperCase();
    if (!layers.has(layer)) { dxf.addLayer(layer, aci(col), 'CONTINUOUS'); layers.set(layer, true); }
    const opts = { layerName: layer, trueColor: String(parseInt(col.replace('#', ''), 16) || 0) };
    for (const sp of it.subpaths) {
      if (sp.pts.length < 2) continue;
      if (o.curves === 'spline' && !isStraight(sp)) {
        const spl = subpathToSpline(sp, map); if (spl) { dxf.addSpline(spl, opts); written++; }
        continue;
      }
      const flat = G.flatten([sp], o.tolerance ?? 0.05)[0];
      const pts = flat.pts.map(([x, y]) => map(x, y));
      if (pts.length < 2) continue;
      dxf.addLWPolyline(pts.map(([x, y]) => ({ point: { x, y } })), { ...opts, flags: sp.closed ? LWPolylineFlags.Closed : LWPolylineFlags.None });
      written++;
    }
  }
  return { text: dxf.stringify(), written, skipped };
}

// ---------------------------------------------------------------- DXF import
const UNIT_MM = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0254, 9: 0.0254, 10: 914.4 };
/** Cubic Bézier pieces for a circular/elliptical arc given an affine frame (centre, u, v) and parameter range. */
function arcPts(cx, cy, ux, uy, vx, vy, t0, t1) {
  let sweep = t1 - t0; const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)); const dt = sweep / n;
  const k = (4 / 3) * Math.tan(dt / 4);
  const at = (t) => [cx + ux * Math.cos(t) + vx * Math.sin(t), cy + uy * Math.cos(t) + vy * Math.sin(t)];
  const der = (t) => [-ux * Math.sin(t) + vx * Math.cos(t), -uy * Math.sin(t) + vy * Math.cos(t)];
  const out = []; let t = t0;
  const p0 = at(t); out.push({ x: p0[0], y: p0[1], ix: p0[0], iy: p0[1], ox: p0[0], oy: p0[1] });
  for (let i = 0; i < n; i++) {
    const a = at(t), da = der(t), b = at(t + dt), db = der(t + dt);
    const prev = out[out.length - 1]; prev.ox = a[0] + k * da[0]; prev.oy = a[1] + k * da[1];
    out.push({ x: b[0], y: b[1], ix: b[0] - k * db[0], iy: b[1] - k * db[1], ox: b[0], oy: b[1] });
    t += dt;
  }
  return out;
}
/** Arc between two polyline vertices from a DXF bulge (tan of a quarter of the included angle; + = CCW). */
function bulgeArc(p1, p2, bulge) {
  const th = 4 * Math.atan(bulge), dx = p2.x - p1.x, dy = p2.y - p1.y, c = Math.hypot(dx, dy);
  if (c < 1e-12 || Math.abs(bulge) < 1e-9) return null;
  const r = c / (2 * Math.sin(Math.abs(th) / 2));
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, d = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2));
  const sgn = (bulge > 0) === (Math.abs(th) < Math.PI) ? 1 : -1;
  const cx = mx - sgn * d * dy / c, cy = my + sgn * d * dx / c;
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  return arcPts(cx, cy, r, 0, 0, r, a0, a0 + th);
}
function deBoor(deg, knots, cps, t) {
  let k = deg; while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
  const d = []; for (let j = 0; j <= deg; j++) d.push({ ...cps[k - deg + j] });
  for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
    const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i]; const a = den ? (t - knots[i]) / den : 0;
    d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
  }
  return d[deg];
}

/**
 * Parse DXF text into KERF path items (px, y-down). Supports LINE, LWPOLYLINE/POLYLINE (with bulges), CIRCLE, ARC,
 * ELLIPSE, SPLINE and INSERT (block references, recursively).
 */
export function itemsFromDXF(text) {
  const dxf = new DxfParser().parseSync(text);
  const mm = UNIT_MM[dxf.header?.$INSUNITS ?? 4] ?? 1, s = mm / MM_PER_PX;
  const out = []; const stats = { entities: 0, skipped: 0 };
  const push = (subs, layer) => { if (subs.length) out.push({ subpaths: subs, layer }); };
  const walk = (ents, tf, depth) => {
    for (const e of ents || []) {
      stats.entities++;
      const T = (x, y) => { const [X, Y] = G.apply(tf, x, y); return { x: X, y: Y }; };
      const P = (x, y) => { const p = T(x, y); return { x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y }; };
      const tfPts = (pts) => pts.map(p => { const a = T(p.x, p.y), i = T(p.ix, p.iy), o = T(p.ox, p.oy); return { x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y }; });
      switch (e.type) {
        case 'LINE': push([{ closed: false, pts: [P(e.vertices[0].x, e.vertices[0].y), P(e.vertices[1].x, e.vertices[1].y)] }], e.layer); break;
        case 'LWPOLYLINE': case 'POLYLINE': {
          const vs = (e.vertices || []).filter(v => !v.faces); if (vs.length < 2) break;
          const closed = !!(e.shape || e.closed); const pts = [P(vs[0].x, vs[0].y)];
          const n = closed ? vs.length : vs.length - 1;
          for (let i = 0; i < n; i++) {
            const a = vs[i], b = vs[(i + 1) % vs.length];
            const arc = a.bulge ? bulgeArc(a, b, a.bulge) : null;
            if (arc) { const tp = tfPts(arc); pts[pts.length - 1].ox = tp[0].ox; pts[pts.length - 1].oy = tp[0].oy; pts.push(...tp.slice(1)); }
            else pts.push(P(b.x, b.y));
          }
          if (closed && pts.length > 1) { const f = pts[0], l = pts[pts.length - 1]; if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) { f.ix = l.ix; f.iy = l.iy; pts.pop(); } }
          push([{ closed, pts }], e.layer); break;
        }
        case 'CIRCLE': { const c = e.center; const pts = tfPts(arcPts(c.x, c.y, e.radius, 0, 0, e.radius, 0, Math.PI * 2)); pts[0].ix = pts[pts.length - 1].ix; pts[0].iy = pts[pts.length - 1].iy; pts.pop(); push([{ closed: true, pts }], e.layer); break; }
        case 'ARC': { let a0 = e.startAngle, a1 = e.endAngle; if (a1 < a0) a1 += Math.PI * 2; push([{ closed: false, pts: tfPts(arcPts(e.center.x, e.center.y, e.radius, 0, 0, e.radius, a0, a1)) }], e.layer); break; }
        case 'ELLIPSE': {
          const c = e.center, u = e.majorAxisEndPoint, r = e.axisRatio ?? 1; const vx = -u.y * r, vy = u.x * r;
          let t0 = e.startAngle ?? 0, t1 = e.endAngle ?? Math.PI * 2; if (t1 <= t0) t1 += Math.PI * 2;
          const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6; const pts = tfPts(arcPts(c.x, c.y, u.x, u.y, vx, vy, t0, t1));
          if (full) { pts[0].ix = pts[pts.length - 1].ix; pts[0].iy = pts[pts.length - 1].iy; pts.pop(); }
          push([{ closed: full, pts }], e.layer); break;
        }
        case 'SPLINE': {
          const cps = e.controlPoints || [], deg = e.degreeOfSplineCurve || 3, kn = e.knotValues || [];
          let raw;
          if (cps.length > deg && kn.length === cps.length + deg + 1) {
            const lo = kn[deg], hi = kn[kn.length - deg - 1], N = Math.max(24, cps.length * 12); raw = [];
            for (let i = 0; i <= N; i++) raw.push(deBoor(deg, kn, cps, lo + (hi - lo) * Math.min(i / N, 1 - 1e-12)));
          } else raw = e.fitPoints || cps;
          if (raw && raw.length > 1) push([{ closed: !!e.closed, pts: raw.map(p => P(p.x, p.y)) }], e.layer);
          break;
        }
        case 'INSERT': {
          const blk = dxf.blocks?.[e.name]; if (!blk || depth > 8) { stats.skipped++; break; }
          const bp = blk.position || { x: 0, y: 0 };
          const m = G.mul(tf, G.mul(G.tr(e.position.x, e.position.y), G.mul(G.rot((e.rotation || 0) * Math.PI / 180, 0, 0), G.mul([e.xScale || 1, 0, 0, e.yScale || 1, 0, 0], G.tr(-bp.x, -bp.y)))));
          walk(blk.entities, m, depth + 1); break;
        }
        default: stats.skipped++;
      }
    }
  };
  // DXF is y-up in drawing units; KERF is y-down in px.
  walk(dxf.entities, [s, 0, 0, -s, 0, 0], 0);
  return { items: out, stats, unitsMM: mm };
}
