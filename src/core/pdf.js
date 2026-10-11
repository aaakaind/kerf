// Vector PDF 1.7 writer: paths, real embedded fonts (subset TrueType/CFF via fontkit, MIT) with ToUnicode maps so
// text stays selectable and searchable, standard-14 fallback, lossless images with alpha, opacity,
// bleed/trim boxes and crop marks. Coordinates are top-left based; each page flips the CTM once.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as G from './geom.js';
import { loadImage } from './ui.js';
import { dataURLToBytes, fetchBundled } from './io.js';
import fontkit from '@pdf-lib/fontkit';

const enc = new TextEncoder();
const n = (v) => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(await out);
}

// ---------- colours ----------
let cctx;
export function rgb(css) {
  if (!css) return null;
  if (!cctx) cctx = document.createElement('canvas').getContext('2d');
  cctx.fillStyle = '#000'; cctx.fillStyle = css; const v = cctx.fillStyle;
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255, 1];
  const m = v.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 1];
  const p = m[1].split(',').map(s => parseFloat(s)); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
}

// ---------- text encoding (WinAnsi) ----------
const WIN = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  0x2212: 0x2d, 0x00ad: 0x2d, 0x2010: 0x2d, 0x2011: 0x2d, 0x00a0: 0x20, 0x2009: 0x20, 0x200a: 0x20, 0x202f: 0x20, 0x2002: 0x20, 0x2003: 0x20 };
export function pdfString(s) {
  let out = '(';
  for (const ch of s) {
    let c = ch.codePointAt(0);
    if (c === 0x200b || c === 0xfeff) continue;
    if (WIN[c] != null) c = WIN[c]; else if (c > 0xff || (c >= 0x80 && c < 0xa0)) c = 0x3f;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

// ---------- standard-14 font mapping & width estimation via metric-compatible system faces ----------
export function stdFont(family = '', weight = 400, italic = false) {
  const f = String(family).toLowerCase();
  const kind = /mono|courier|consol|menlo|code/.test(f) ? 'Courier' : (/serif|times|georgia|garamond|caslon|baskerville|minion|merriweather|playfair|book/.test(f) && !/sans/.test(f)) ? 'Times' : 'Helvetica';
  const b = weight >= 600, i = !!italic;
  if (kind === 'Times') return b && i ? 'Times-BoldItalic' : b ? 'Times-Bold' : i ? 'Times-Italic' : 'Times-Roman';
  const sfx = b && i ? '-BoldOblique' : b ? '-Bold' : i ? '-Oblique' : '';
  return kind + sfx;
}
let mctx;
export function stdWidth(name, size, text) {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  const fam = name.startsWith('Times') ? '"Times New Roman", "Liberation Serif", Times, serif' : name.startsWith('Courier') ? '"Courier New", "Liberation Mono", Courier, monospace' : 'Arial, "Liberation Sans", Helvetica, sans-serif';
  mctx.font = `${/Italic|Oblique/.test(name) ? 'italic ' : ''}${/Bold/.test(name) ? 700 : 400} ${size}px ${fam}`;
  return mctx.measureText(text).width;
}

// ---------- embedded fonts ----------
// Built-in faces ship as TrueType next to the app (dist/fonts/*.ttf, decompressed from the bundled WOFF2 at build time)
// and are fetched only when a PDF is exported.
const BUILTIN = {
  'jost': { slug: 'jost', weights: [400, 500, 600, 700, 800] },
  'ibm plex sans': { slug: 'ibm-plex-sans', weights: [400, 600] },
  'ibm plex mono': { slug: 'ibm-plex-mono', weights: [400, 600] },
};
const nearestWeight = (list, w) => list.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) || (Math.abs(b - w) === Math.abs(a - w) && b > a && w >= 500)) ? b : a);
export const firstFamily = (css) => String(css || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
const fontBytesCache = new Map();
function loadFontBytes(key, loader) { if (!fontBytesCache.has(key)) fontBytesCache.set(key, loader().catch(() => null)); return fontBytesCache.get(key); }
const subsetBytes = (sub) => new Promise((res, rej) => { const parts = []; sub.encodeStream().on('data', b => parts.push(b)).on('end', () => { const len = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } res(out); }).on('error', rej); });

/** One embedded, subset font. Glyphs are added as text is written; the file is built in finish(). */
class EmbeddedFont {
  constructor(font, name, mono) {
    this.font = font; this.name = name; this.mono = mono; this.subset = font.createSubset();
    this.ids = new Map();          // original glyph id → subset id
    this.widths = [];              // subset id → advance (1/1000 em)
    this.uni = [];                 // subset id → unicode string
    this.isCFF = !!font.cff; this.k = 1000 / font.unitsPerEm;
    const g0 = font.getGlyph(0); this.widths[0] = Math.round(g0.advanceWidth * this.k); // .notdef
  }
  /** Shape `text` and return { tj: TJ array body, width: advance in 1/1000 em, glyphs } */
  encode(text) {
    const run = this.font.layout(text);
    const parts = []; let width = 0;
    run.glyphs.forEach((g, i) => {
      let id = this.ids.get(g.id);
      if (id == null) { id = this.subset.includeGlyph(g); this.ids.set(g.id, id); this.widths[id] = Math.round(g.advanceWidth * this.k); this.uni[id] = String.fromCodePoint(...(g.codePoints.length ? g.codePoints : [0xfffd])); }
      parts.push('<' + id.toString(16).padStart(4, '0') + '>');
      const adv = run.positions[i].xAdvance, kern = adv - g.advanceWidth;
      if (Math.abs(kern) > 0.01 && i < run.glyphs.length - 1) parts.push(n(-kern * this.k));
      width += adv * this.k;
    });
    return { tj: parts.join(''), width, glyphs: run.glyphs.length };
  }
}
function toUnicodeCMap(uni) {
  const hex16 = (s) => [...s].map(ch => { const c = ch.codePointAt(0); if (c < 0x10000) return c.toString(16).padStart(4, '0'); const v = c - 0x10000; return ((v >> 10) + 0xd800).toString(16) + ((v & 0x3ff) + 0xdc00).toString(16); }).join('');
  const entries = uni.map((u, id) => u ? `<${id.toString(16).padStart(4, '0')}> <${hex16(u)}>` : null).filter(Boolean);
  const chunks = []; for (let i = 0; i < entries.length; i += 100) chunks.push(`${Math.min(100, entries.length - i)} beginbfchar\n${entries.slice(i, i + 100).join('\n')}\nendbfchar`);
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}
const tag = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

// ---------- writer ----------
export class PdfWriter {
  constructor(meta = {}) {
    this.objs = [null]; this.pages = []; this.fontNames = {}; this.imgCache = new Map(); this.gsNames = {}; this.meta = meta;
    this.embedded = new Map();   // key → Promise<{name, ef} | null>
    this.userFonts = meta.fontAssets || {}; // family (lower case) → data URL of a user-added font
    this.resId = this.alloc();
  }
  alloc() { this.objs.push(null); return this.objs.length - 1; }
  set(id, body) { this.objs[id] = body; }
  add(body) { const id = this.alloc(); this.set(id, body); return id; }
  async stream(dict, bytes, compress = true) {
    let data = bytes, filt = dict.Filter ? '' : '';
    if (compress && !dict.Filter) { const z = await deflate(bytes); if (z) { data = z; filt = '/Filter /FlateDecode '; } }
    const d = Object.entries(dict).map(([k, v]) => `/${k} ${v}`).join(' ');
    return this.add({ head: `<< ${d} ${filt}/Length ${data.length} >>\nstream\n`, data, tail: '\nendstream' });
  }
  font(stdName) {
    if (!this.fontNames[stdName]) {
      const name = 'F' + (Object.keys(this.fontNames).length + 1);
      const id = this.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${stdName} /Encoding /WinAnsiEncoding >>`);
      this.fontNames[stdName] = { name, id };
    }
    return this.fontNames[stdName].name;
  }
  /**
   * Resolve a CSS family/weight/style to an embedded subset font, or null (caller falls back to standard 14).
   * Built-in KERF faces load from fonts/*.ttf; user fonts come from the document's font assets.
   */
  embeddedFont(family, weight = 400, italic = false) {
    const fam = firstFamily(family).toLowerCase(); const b = BUILTIN[fam];
    let key, loader;
    if (b) {
      const wt = nearestWeight(b.weights, weight); key = `${b.slug}-${wt}-${italic ? 'italic' : 'normal'}`;
      loader = () => fetchBundled(`fonts/${key}.ttf`);
    } else if (this.userFonts[fam]) { key = 'user:' + fam; const url = this.userFonts[fam]; loader = async () => dataURLToBytes(url); }
    else return Promise.resolve(null);
    if (!this.embedded.has(key)) {
      const name = 'E' + (this.embedded.size + 1);
      this.embedded.set(key, (async () => {
        const bytes = await loadFontBytes(key, loader); if (!bytes) return null;
        try {
          const f = fontkit.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
          const ef = new EmbeddedFont(f, name, fam.includes('mono')); ef.key = key; return ef;
        } catch (e) { console.warn('font not embeddable', key, e); return null; }
      })());
    }
    return this.embedded.get(key);
  }
  alpha(a) {
    const k = n(a);
    if (!this.gsNames[k]) { const name = 'GS' + (Object.keys(this.gsNames).length + 1); this.gsNames[k] = { name, id: this.add(`<< /Type /ExtGState /ca ${k} /CA ${k} >>`) }; }
    return this.gsNames[k].name;
  }
  async image(src) {
    if (this.imgCache.has(src)) return this.imgCache.get(src);
    const name = 'Im' + (this.imgCache.size + 1);
    const p = (async () => {
      const img = await loadImage(src);
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      let id;
      if (/^data:image\/jpe?g/i.test(src)) {
        id = await this.stream({ Type: '/XObject', Subtype: '/Image', Width: w, Height: h, ColorSpace: '/DeviceRGB', BitsPerComponent: 8, Filter: '/DCTDecode' }, dataURLToBytes(src), false);
      } else {
        const c = document.createElement('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
        const px = cx.getImageData(0, 0, w, h).data; const rgbB = new Uint8Array(w * h * 3), aB = new Uint8Array(w * h); let hasA = false;
        for (let i = 0, j = 0; i < px.length; i += 4, j++) { rgbB[j * 3] = px[i]; rgbB[j * 3 + 1] = px[i + 1]; rgbB[j * 3 + 2] = px[i + 2]; aB[j] = px[i + 3]; if (px[i + 3] < 255) hasA = true; }
        let smask = '';
        if (hasA) { const sid = await this.stream({ Type: '/XObject', Subtype: '/Image', Width: w, Height: h, ColorSpace: '/DeviceGray', BitsPerComponent: 8 }, aB); smask = `${sid} 0 R`; }
        const dict = { Type: '/XObject', Subtype: '/Image', Width: w, Height: h, ColorSpace: '/DeviceRGB', BitsPerComponent: 8 }; if (smask) dict.SMask = smask;
        id = await this.stream(dict, rgbB);
      }
      return { name, id, w, h };
    })();
    this.imgCache.set(src, p);
    return p;
  }
  /** Start a page. trim = page size; bleed/slug extend the media box. Returns a page whose `ops` are in top-left trim coordinates. */
  page(w, h, { bleed = 0, marks = false } = {}) {
    const slug = marks ? 22 : 0, off = bleed + slug, W = w + off * 2, H = h + off * 2;
    const pg = { w, h, W, H, off, bleed, marks, ops: [] };
    pg.ops.push(`1 0 0 -1 0 ${n(H)} cm`, `1 0 0 1 ${n(off)} ${n(off)} cm`);
    this.pages.push(pg); return pg;
  }
  async finish() {
    const pagesId = this.alloc(); const kids = [];
    for (const pg of this.pages) {
      if (pg.marks) pg.ops.push(cropMarks(pg));
      const content = await this.stream({}, enc.encode(pg.ops.join('\n')));
      const trim = `[${n(pg.off)} ${n(pg.off)} ${n(pg.off + pg.w)} ${n(pg.off + pg.h)}]`, bleedBox = `[${n(pg.off - pg.bleed)} ${n(pg.off - pg.bleed)} ${n(pg.off + pg.w + pg.bleed)} ${n(pg.off + pg.h + pg.bleed)}]`;
      kids.push(this.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pg.W)} ${n(pg.H)}] /TrimBox ${trim} /BleedBox ${bleedBox} /Resources ${this.resId} 0 R /Contents ${content} 0 R >>`));
    }
    const efs = (await Promise.all([...this.embedded.values()])).filter(Boolean).filter(ef => ef.ids.size);
    for (const ef of efs) ef.id = await this.writeEmbedded(ef);
    const fonts = [...Object.values(this.fontNames).map(f => `/${f.name} ${f.id} 0 R`), ...efs.map(ef => `/${ef.name} ${ef.id} 0 R`)].join(' ');
    const imgs = await Promise.all([...this.imgCache.values()]);
    const xo = imgs.map(i => `/${i.name} ${i.id} 0 R`).join(' ');
    const gs = Object.values(this.gsNames).map(g => `/${g.name} ${g.id} 0 R`).join(' ');
    this.set(this.resId, `<< /ProcSet [/PDF /Text /ImageC /ImageB] /Font << ${fonts} >> /XObject << ${xo} >> /ExtGState << ${gs} >> >>`);
    this.set(pagesId, `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
    const info = this.add(`<< /Producer ${pdfString('KERF (open source, AGPL-3.0)')} /Creator ${pdfString('KERF')} /Title ${pdfString(this.meta.title || 'Untitled')} /CreationDate ${pdfString(pdfDate())} >>`);
    const catalog = this.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    // serialize
    const chunks = [enc.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')]; let off = chunks[0].length; const offsets = [0];
    for (let i = 1; i < this.objs.length; i++) {
      offsets[i] = off; const o = this.objs[i];
      const parts = typeof o === 'string' ? [enc.encode(`${i} 0 obj\n${o}\nendobj\n`)] : [enc.encode(`${i} 0 obj\n${o.head}`), o.data, enc.encode(`${o.tail}\nendobj\n`)];
      for (const p of parts) { chunks.push(p); off += p.length; }
    }
    const xref = [`xref\n0 ${this.objs.length}\n0000000000 65535 f \n`, ...offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n')].join('');
    chunks.push(enc.encode(xref + `trailer\n<< /Size ${this.objs.length} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${off}\n%%EOF\n`));
    const total = chunks.reduce((s, c) => s + c.length, 0); const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}
PdfWriter.prototype.writeEmbedded = async function (ef) {
  const f = ef.font, k = ef.k, ps = (f.postscriptName || 'Font').replace(/[^A-Za-z0-9-]/g, ''), base = `${tag()}+${ps}`;
  const bytes = await subsetBytes(ef.subset);
  const file = ef.isCFF ? await this.stream({ Subtype: '/CIDFontType0C' }, bytes) : await this.stream({ Length1: bytes.length }, bytes);
  const bb = f.bbox; const flags = 4 | (ef.mono ? 1 : 0) | (f.italicAngle ? 64 : 0);
  const desc = this.add(`<< /Type /FontDescriptor /FontName /${base} /Flags ${flags} /FontBBox [${[bb.minX, bb.minY, bb.maxX, bb.maxY].map(v => Math.round(v * k)).join(' ')}] /ItalicAngle ${n(f.italicAngle || 0)} /Ascent ${Math.round(f.ascent * k)} /Descent ${Math.round(f.descent * k)} /CapHeight ${Math.round((f.capHeight || f.ascent) * k)} /StemV 80 /${ef.isCFF ? 'FontFile3' : 'FontFile2'} ${file} 0 R >>`);
  const W = `[0 [${Array.from({ length: ef.widths.length }, (_, i) => ef.widths[i] ?? 0).join(' ')}]]`;
  const cid = this.add(`<< /Type /Font /Subtype /${ef.isCFF ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /W ${W}${ef.isCFF ? '' : ' /CIDToGIDMap /Identity'} >>`);
  const tu = await this.stream({}, enc.encode(toUnicodeCMap(ef.uni)));
  return this.add(`<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);
};
function pdfDate() { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; }
function cropMarks(pg) {
  const o = [], L = 12, gap = pg.bleed + 3;
  o.push('q 0 0 0 RG 0.25 w');
  for (const [x, y] of [[0, 0], [pg.w, 0], [0, pg.h], [pg.w, pg.h]]) {
    const sx = x === 0 ? -1 : 1, sy = y === 0 ? -1 : 1;
    o.push(`${n(x + sx * gap)} ${n(y)} m ${n(x + sx * (gap + L))} ${n(y)} l S`, `${n(x)} ${n(y + sy * gap)} m ${n(x)} ${n(y + sy * (gap + L))} l S`);
  }
  o.push('Q'); return o.join('\n');
}

// ---------- op builders ----------
export function pathOps(subpaths, m) {
  const P = (x, y) => (m ? G.apply(m, x, y) : [x, y]).map(n).join(' ');
  const o = [];
  for (const sp of subpaths) {
    if (!sp.pts.length) continue;
    o.push(`${P(sp.pts[0].x, sp.pts[0].y)} m`);
    for (const s of G.segments(sp)) {
      const straight = s[2] === s[0] && s[3] === s[1] && s[4] === s[6] && s[5] === s[7];
      o.push(straight ? `${P(s[6], s[7])} l` : `${P(s[2], s[3])} ${P(s[4], s[5])} ${P(s[6], s[7])} c`);
    }
    if (sp.closed) o.push('h');
  }
  return o.join(' ');
}
export function paintOps(w, { fill, stroke, sw = 0, opacity = 1, rule = 'nonzero', cap, join, dash }, geomOps) {
  const f = rgb(fill), s = sw > 0 ? rgb(stroke) : null;
  if (!f && !s) return '';
  const o = ['q'];
  const a = (opacity ?? 1) * (f ? f[3] : 1);
  if (a < 0.999) o.push(`/${w.alpha(a)} gs`);
  if (f) o.push(`${n(f[0])} ${n(f[1])} ${n(f[2])} rg`);
  if (s) {
    o.push(`${n(s[0])} ${n(s[1])} ${n(s[2])} RG ${n(sw)} w`);
    if (cap) o.push(`${{ butt: 0, round: 1, square: 2 }[cap] ?? 0} J`); if (join) o.push(`${{ miter: 0, round: 1, bevel: 2 }[join] ?? 0} j`);
    if (dash) { const d = String(dash).split(/[\s,]+/).filter(Boolean).map(Number).filter(isFinite); if (d.length) o.push(`[${d.map(n).join(' ')}] 0 d`); }
  }
  o.push(geomOps);
  const evenodd = rule === 'evenodd' ? '*' : '';
  o.push(f && s ? 'B' + evenodd : f ? 'f' + evenodd : 'S');
  o.push('Q');
  return o.join(' ');
}
/** Text run. `font` is a standard-14 name or an EmbeddedFont (from w.embeddedFont). `tracking` is CSS letter-spacing in pt. */
export function textOps(w, { text, x, y, font, size, color, opacity = 1, targetWidth, tracking = 0 }) {
  text = String(text || '').replace(/[\u00ad\u200b\ufeff]/g, '');
  if (!text) return '';
  const c = rgb(color) || [0, 0, 0, 1]; const a = (opacity ?? 1) * c[3];
  const head = `q ${a < 0.999 ? `/${w.alpha(a)} gs ` : ''}BT `;
  const paint = `${n(c[0])} ${n(c[1])} ${n(c[2])} rg 1 0 0 -1 ${n(x)} ${n(y)} Tm`;
  if (font && typeof font === 'object') {
    const e = font.encode(text); const natural = e.width / 1000 * size + tracking * e.glyphs;
    // The browser laid this text out with the same font, so the fit factor stays near 100; it only absorbs rounding.
    const tz = targetWidth > 0 && natural > 0 ? Math.max(90, Math.min(110, (targetWidth / natural) * 100)) : 100;
    return `${head}/${font.name} ${n(size)} Tf ${n(tz)} Tz ${tracking ? `${n(tracking)} Tc ` : ''}${paint} [${e.tj}] TJ ET Q`;
  }
  const name = w.font(font);
  let tz = 100;
  if (targetWidth > 0) { const est = stdWidth(font, size, text); if (est > 0) tz = Math.max(60, Math.min(140, (targetWidth / est) * 100)); }
  return `${head}/${name} ${n(size)} Tf ${n(tz)} Tz ${paint} ${pdfString(text)} Tj ET Q`;
}
/** Resolve an embedded font for a CSS face, falling back to the closest standard-14 font name. */
export async function faceFor(w, family, weight, italic) {
  return (await w.embeddedFont(family, weight, italic)) || stdFont(firstFamily(family), weight, italic);
}
const fontWidth = (font, size, text, tracking = 0) => typeof font === 'object' ? (() => { const e = font.font.layout(String(text).replace(/\u00ad/g, '')); return e.positions.reduce((s, p) => s + p.xAdvance, 0) * font.k / 1000 * size + tracking * e.glyphs.length; })() : stdWidth(font, size, text);
export { fontWidth };
export async function imageOps(w, src, x, y, wd, ht, opacity = 1) {
  const im = await w.image(src);
  return `q ${opacity < 0.999 ? `/${w.alpha(opacity)} gs ` : ''}${n(wd)} 0 0 ${n(-ht)} ${n(x)} ${n(y + ht)} cm /${im.name} Do Q`;
}
export const clipRect = (x, y, wd, ht) => `${n(x)} ${n(y)} ${n(wd)} ${n(ht)} re W n`;
export const matrixOp = (m) => `${m.map(n).join(' ')} cm`;

// ---------- vector items → ops (shared by Vector export and Layout placements) ----------
export async function vectorItemsOps(w, items, assets) {
  const o = [];
  for (const it of items) {
    if (it.hidden) continue;
    const op = it.opacity ?? 1;
    if (it.type === 'path') {
      const fill = it.fill == null ? null : typeof it.fill === 'object' ? it.fill.stops?.[0]?.c : it.fill;
      o.push(paintOps(w, { fill, stroke: it.stroke, sw: it.sw, opacity: op, rule: it.rule, cap: it.cap, join: it.join, dash: it.dash }, pathOps(it.subpaths)));
    } else if (it.type === 'text') {
      const lines = String(it.text).split('\n'), lh = it.lh || it.size * 1.2, fn = await faceFor(w, it.font, it.weight || 400, it.italic);
      const tracking = (it.ls || 0) * it.size; const inner = [];
      lines.forEach((l, i) => {
        const wd = fontWidth(fn, it.size, l, tracking); const x = it.align === 'middle' ? it.x - wd / 2 : it.align === 'end' ? it.x - wd : it.x;
        inner.push(textOps(w, { text: l, x, y: it.y + i * lh, font: fn, size: it.size, color: typeof it.fill === 'string' ? it.fill : '#000', opacity: op, tracking }));
      });
      o.push(it.m ? `q ${matrixOp(it.m)} ${inner.join(' ')} Q` : inner.join(' '));
    } else if (it.type === 'image') {
      const a = assets[it.asset]; if (!a) continue;
      const io = await imageOps(w, a.data, it.x, it.y, it.w, it.h, op);
      o.push(it.m ? `q ${matrixOp(it.m)} ${io} Q` : io);
    }
  }
  return o.join('\n');
}
export function fontAssetsOf(assets) { const o = {}; for (const a of Object.values(assets || {})) if (a.kind === 'font' && a.family) o[a.family.toLowerCase()] = a.data; return o; }
export async function pdfFromVectorArtboard(ab, items, assets) {
  const w = new PdfWriter({ title: ab.name, fontAssets: fontAssetsOf(assets) });
  const pg = w.page(ab.w, ab.h);
  pg.ops.push(clipRect(0, 0, ab.w, ab.h), `1 0 0 1 ${n(-ab.x)} ${n(-ab.y)} cm`);
  if (ab.bg) pg.ops.push(paintOps(w, { fill: ab.bg }, `${n(ab.x)} ${n(ab.y)} ${n(ab.w)} ${n(ab.h)} re`));
  pg.ops.push(await vectorItemsOps(w, items, assets));
  return w.finish();
}
