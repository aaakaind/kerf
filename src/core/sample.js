// The sample project: one document that shows the four workspaces feeding each other.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { blankDoc, PT_PER_MM } from './store.js';
import * as G from './geom.js';

const mm = (v) => v * PT_PER_MM;

export function sampleDoc() {
  const d = blankDoc('Field Notes No. 1 (sample)');
  // ---------- VECTOR ----------
  const K = 0.5523 * 18;
  const notch = { id: 'v-mark', type: 'path', name: 'Kerf block', fill: '#1c1a17', stroke: null, sw: 0, subpaths: [{ closed: true, pts: [
    G.P(90, 90), G.P(222, 90), { x: 222, y: 268, ix: 222, iy: 268, ox: 222, oy: 268 + K }, { x: 240, y: 286, ix: 240 - K, iy: 286, ox: 240 + K, oy: 286 },
    { x: 258, y: 268, ix: 258, iy: 268 + K, ox: 258, oy: 268 }, G.P(258, 90), G.P(390, 90), G.P(390, 390), G.P(90, 390)] }] };
  const dots = [['#e3a72f', 150], ['#c8432b', 210], ['#2d5b8a', 270], ['#6b4428', 330]].map(([c, x], i) => ({ id: 'v-dot' + i, type: 'path', name: ['Ochre dot', 'Red dot', 'Blue dot', 'Walnut dot'][i], subpaths: G.ellipsePath(x, 438, 17, 17), fill: c, stroke: null, sw: 0 }));
  const word = { id: 'v-word', type: 'text', name: 'Wordmark', x: 90, y: 64, text: 'KERF', font: 'Jost', size: 40, weight: 700, fill: '#1c1a17', stroke: null, sw: 0, align: 'start', ls: 0.04 };
  const spec = { id: 'v-spec', type: 'text', name: 'Spec line', x: 390, y: 64, text: 'KF-01 · OPEN TOOLS', font: 'IBM Plex Mono', size: 11, weight: 600, fill: '#625a4d', stroke: null, sw: 0, align: 'end', ls: 0.1 };
  // artboard 2: kerf-bending diagram (a plank with relief cuts) — built with Grid repeat
  const plank = { id: 'v-plank', type: 'path', name: 'Plank', subpaths: G.rectPath(40, 1100, 400, 60, 0), fill: '#dec498', stroke: '#1c1a17', sw: 1.5 };
  const kerfs = []; for (let i = 0; i < 18; i++) kerfs.push({ id: 'v-kerf' + i, type: 'path', name: 'Kerf ' + (i + 1), subpaths: G.rectPath(70 + i * 20, 1100, 3, 44, 0), fill: '#1c1a17', stroke: null, sw: 0 });
  const cap = { id: 'v-cap', type: 'text', name: 'Caption', x: 40, y: 1200, text: 'RELIEF KERFS · 2/3 OF THICKNESS · 20 PX PITCH', font: 'IBM Plex Mono', size: 11, weight: 600, fill: '#625a4d', stroke: null, sw: 0, align: 'start', ls: 0.08 };
  d.vector = {
    artboards: [{ id: 'ab-mark', name: 'Mark', x: 0, y: 0, w: 480, h: 480, bg: '#f3eee4' }, { id: 'ab-kerf', name: 'Kerf diagram', x: 0, y: 1040, w: 480, h: 200, bg: '#fbf8f2' }],
    items: [notch, ...dots, word, spec, plank, ...kerfs, cap],
  };
  // ---------- MESH ----------
  d.mesh.objects = [
    { id: 'm-plinth', name: 'Plinth with bore', kind: 'bool', op: 'subtract', pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'birch' },
      a: { id: 'm-pa', name: 'Plinth', kind: 'box', params: { w: 150, h: 16, d: 150, r: 22 }, pos: [0, 8, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'birch' } },
      b: { id: 'm-pb', name: 'Bore', kind: 'cylinder', params: { rt: 14, rb: 14, h: 40, seg: 48 }, pos: [48, 8, 48], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'birch' } } },
    { id: 'm-mark', name: 'Kerf block extrusion', kind: 'extrude', params: { link: 'v-mark', subpaths: JSON.parse(JSON.stringify(notch.subpaths)), size: 90, depth: 22, bevel: 1.4 }, pos: [-10, 61, -10], rot: [0, 18, 0], scl: [1, 1, 1], mat: { preset: 'walnut' } },
    { id: 'm-s1', name: 'Ochre ball', kind: 'sphere', params: { r: 11, seg: 48 }, pos: [-48, 27, 44], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'ochre' } },
    { id: 'm-s2', name: 'Red ball', kind: 'sphere', params: { r: 11, seg: 48 }, pos: [-20, 27, 52], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'red' } },
    { id: 'm-s3', name: 'Blue ball', kind: 'sphere', params: { r: 11, seg: 48 }, pos: [8, 27, 56], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'blue' } },
  ];
  // ---------- CAD ----------
  d.cad = {
    vars: [{ name: 'w', expr: '60 mm' }, { name: 'h', expr: '40 mm' }, { name: 't', expr: '4 mm' }, { name: 'depth', expr: '30 mm' }, { name: 'hole', expr: '5 mm' }],
    configs: [{ name: 'Heavy', values: { w: '70 mm', h: '50 mm', t: '6 mm', depth: '40 mm', hole: '6.5 mm' } }], activeConfig: null,
    features: [
      { id: 'cf-body', type: 'extrude', name: 'Bracket body', suppressed: false, plane: 'XY', offset: '0', depth: '#depth', dir: 'normal', op: 'new', profile: { type: 'poly', pts: '0, 0\n#w, 0\n#w, #t\n#t, #t\n#t, #h\n0, #h', r: '0' } },
      { id: 'cf-fil', type: 'fillet', name: 'Round vertical edges', suppressed: false, r: '1.5 mm', edges: 'Z' },
      { id: 'cf-h1', type: 'hole', name: 'Base hole', suppressed: false, plane: 'XZ', offset: '0', x: '20 mm', y: '#depth/2', d: '#hole', depth: '0', cbd: '0', cbdepth: '0' },
      { id: 'cf-pat', type: 'pattern', name: 'Base hole row', suppressed: false, of: 'cf-h1', kind: 'linear', count: '3', dx: '(#w - 30 mm)/2', dy: '0', dz: '0', axis: 'Z', angle: '360' },
      { id: 'cf-h2', type: 'hole', name: 'Wall hole, counterbored', suppressed: false, plane: 'YZ', offset: '#t', x: '#h*0.65', y: '#depth/2', d: '#hole', depth: '0', cbd: '#hole*1.8', cbdepth: '#t/2' },
    ],
    rollback: null, material: 'al6061', units: 'mm',
  };
  // ---------- LAYOUT (A5, facing) ----------
  const L = d.layout; const P0 = L.page;
  L.styles.standfirst = { name: 'Standfirst', font: 'IBM Plex Sans', size: 12, leading: 16, weight: 400, italic: false, color: '#1c1a17', align: 'left', before: 0, after: 8, indent: 0, tracking: 0, hyphenate: false, upper: false };
  L.styles.kicker = { name: 'Kicker', font: 'IBM Plex Mono', size: 7.5, leading: 10, weight: 600, italic: false, color: '#c8432b', align: 'left', before: 0, after: 6, indent: 0, tracking: 0.12, hyphenate: false, upper: true };
  L.styles.folio.align = 'center';
  L.styles.spec = { name: 'Spec list', font: 'IBM Plex Sans', size: 8.5, leading: 12, weight: 400, italic: false, color: '#1c1a17', align: 'left', before: 0, after: 1, indent: 0, tracking: 0, hyphenate: false, upper: false };
  const m = P0.margins, W = P0.w, H = P0.h, inner = W - m.i - m.o;
  L.masters = [{ id: 'A', name: 'A-Master', items: [
    { id: 'mA-rule', type: 'line', x: m.i, y: mm(10), w: inner, h: 0, stroke: '#1c1a17', sw: 1.2 },
    { id: 'mA-head', type: 'text', x: m.i, y: mm(6), w: inner, h: mm(4), story: 'st-head', cols: 1, gutter: 0, inset: 0 },
    { id: 'mA-folio', type: 'text', x: W / 2 - mm(10), y: H - mm(11), w: mm(20), h: mm(5), story: 'st-folio', cols: 1, gutter: 0, inset: 0, valign: 'center' },
  ] }];
  L.stories = {
    'st-head': { text: '[kicker] KERF Field Notes · No. 1 · Shop methods', frames: ['mA-head'] },
    'st-folio': { text: '[folio] {page} / {pages}', frames: ['mA-folio'] },
    'st-cover': { text: '[kicker] Shop methods · sample document\n# Bending plywood without a factory\n[standfirst] Three ways to put a curve into sheet material with ordinary tools — and the one trick the Eameses used to make it industrial.', frames: ['f-cover-title'] },
    'st-cover-cap': { text: '^ The mark, drawn in Vector and placed live. Edit it there and this page follows.', frames: ['f-cover-cap'] },
    'st-article': { text: ARTICLE, frames: ['f-art-1', 'f-art-2'] },
    'st-cap-render': { text: '^ Bracket rendered from the CAD workspace — 60 × 40 × 30 mm, aluminium 6061. Change #w in CAD and press “Update links”.', frames: ['f-cap-render'] },
    'st-drawing-head': { text: '[kicker] Part drawing · front view\n## Corner bracket, KF-BR-01\n[spec] Generated from the feature tree — extrude, rounded edges, three base holes, a counterbored wall hole. Millimetres.', frames: ['f-drw-head'] },
    'st-spec': { text: '[kicker] Specification\n[spec] **Material** — aluminium 6061; PLA for prototypes\n[spec] **Holes** — 5 mm for M4; wall hole counterbored 9 mm\n[spec] **Configurations** — Default, and Heavy with a 6 mm wall\n[spec] **Files** — STEP and STL from CAD; this PDF from Layout\n[spec] **Licence** — AGPL-3.0, like the software that made it', frames: ['f-spec'] },
  };
  const cover = { id: 'pg-1', master: null, items: [
    { id: 'f-cover-band', type: 'rect', x: -P0.bleed, y: H - mm(46), w: W + P0.bleed * 2, h: mm(46) + P0.bleed, fill: '#e3a72f', stroke: null, sw: 0 },
    { id: 'f-cover-mark', type: 'vector', x: m.i, y: mm(14), w: inner, h: mm(80), src: { ab: 'ab-mark', bg: false }, fit: 'fit' },
    { id: 'f-cover-title', type: 'text', x: m.i, y: mm(98), w: inner, h: mm(60), story: 'st-cover', cols: 1, gutter: 0, inset: 0 },
    { id: 'f-cover-cap', type: 'text', x: m.i, y: H - mm(38), w: inner * 0.62, h: mm(14), story: 'st-cover-cap', cols: 1, gutter: 0, inset: 0 },
  ] };
  const p2 = { id: 'pg-2', master: 'A', items: [
    { id: 'f-art-1', type: 'text', x: m.o, y: m.t, w: W - m.o - m.i, h: H - m.t - m.b, story: 'st-article', cols: 2, gutter: P0.gutter, inset: 0 },
  ] };
  const p3 = { id: 'pg-3', master: 'A', items: [
    { id: 'f-art-2', type: 'text', x: m.i, y: m.t, w: W - m.i - m.o, h: mm(78), story: 'st-article', cols: 2, gutter: P0.gutter, inset: 0 },
    { id: 'f-render', type: 'view', x: m.i, y: m.t + mm(82), w: W - m.i - m.o, h: mm(72), src: { ws: 'cad', angle: 'iso' }, fit: 'fit', fill: '#f3eee4' },
    { id: 'f-cap-render', type: 'text', x: m.i, y: m.t + mm(156), w: W - m.i - m.o, h: mm(12), story: 'st-cap-render', cols: 1, gutter: 0, inset: 0 },
  ] };
  const kh = (W - m.o - m.i) * 200 / 480;
  const p4 = { id: 'pg-4', master: 'A', items: [
    { id: 'f-drw-head', type: 'text', x: m.o, y: m.t, w: W - m.o - m.i, h: mm(26), story: 'st-drawing-head', cols: 1, gutter: 0, inset: 0 },
    { id: 'f-drawing', type: 'drawing', x: m.o, y: mm(43), w: W - m.o - m.i, h: mm(56), src: { ws: 'cad', angle: 'front' }, fit: 'fit', stroke: '#1c1a17', sw: 0.75 },
    { id: 'f-kerf', type: 'vector', x: m.o, y: mm(101), w: W - m.o - m.i, h: kh, src: { ab: 'ab-kerf', bg: true }, fit: 'fit' },
    { id: 'f-spec', type: 'text', x: m.o, y: mm(101) + kh + mm(3), w: W - m.o - m.i, h: H - m.b - (mm(101) + kh + mm(3)), story: 'st-spec', cols: 1, gutter: 0, inset: 0 },
  ] };
  L.pages = [cover, p2, p3, p4];
  return d;
}

const ARTICLE = `## Kerf bending
A flat sheet does not want to curve, so you take away the material that resists. Saw a row of parallel cuts across the back face, each one stopping short of the front so a thin skin survives — roughly two-thirds to three-quarters of the thickness is typical. Bend the board towards the cuts and they close up on the inside of the curve.
The spacing sets the radius. The old shop method: make one cut, clamp the board down on one side of it, and lift the free end until the cut closes. The height the end rises, measured at the radius you want, is your spacing. Closer cuts give a smoother, tighter bend; wider ones show as facets.
> The cuts are the drawing. Space them and you have specified the curve.
Kerfed parts are weak until the curve is fixed, so glue a facing or a solid edge across the open side once it is bent.
## Lamination over a form
For a curve that has to carry load, stack thin plies or veneers with glue between them and clamp the stack over a form until it cures. Each layer bends easily on its own; together, locked by the glue, they hold the shape. More, thinner layers spring back less. A vacuum bag presses the whole surface evenly and is the closest thing to a factory press most shops will own.
## Bending ply
Some plywood is made to bend: thin cross-plies and long-grain faces let a 6 mm sheet wrap a tight radius dry. It is the quickest route to a curved carcase, but it needs a frame to hold the shape.
## The Eames trick
In the early 1940s Charles and Ray Eames built a press in their apartment — they called it the **Kazam! machine** — that used a bicycle pump to push layers of veneer against a heated form. Their 1942 leg splints for the US Navy proved the process, and the moulded plywood chairs of 1946 put it into production. It is lamination, made repeatable.
## Planning the cuts
Draw the board and its kerfs as a flat pattern before you touch the saw. One rectangle for the stock, one thin slot for a cut, then a grid repeat at your spacing: the drawing doubles as a cut list and, exported as SVG, as a file a laser or CNC router can run directly. Measure the inside radius you need, divide the arc length by the spacing from your test cut, and you have the number of kerfs.
Mark which face is the back. The kerfs go on the face that becomes the inside of the curve, so they close as you bend; cut the wrong face and they open into gaps. It is the most common mistake in kerf work, and the most expensive.
## Doing it in KERF
The bracket on the next page and the diagram at the back were drawn in the CAD and Vector workspaces of this same file. Change a variable, update the links, export the PDF. Nothing here was redrawn by hand.`;
