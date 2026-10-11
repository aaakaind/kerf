// MESH workspace — parametric primitives, non-destructive booleans, live extrude/lathe from Vector paths, arrays,
// PBR materials (incl. molded-ply woods), import GLB/STL/OBJ/3DM, export GLB/STL/OBJ/PNG, path-traced renders.
// Booleans run on Manifold (exact, watertight) when it has loaded, BVH-CSG otherwise.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createViewport, woodTexture, boxUV, THREE } from '../core/viewport3d.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { h, icon, pane, numField, colorField, selectField, textField, checkField, segmented, iconBtn, clear, uid, toast, dialog, registerCommand, pickFile, readAsArrayBuffer, round, clamp } from '../core/ui.js';
import { panelRebuilder } from '../core/ui.js';
import { saveFile, safeName, bytesToBase64, dataURLToBytes } from '../core/io.js';
import { subpathsToLoops } from '../core/shapes.js';
import { manifoldBoolean, manifoldState, loadManifold } from '../core/manifold.js';
import { threeFrom3dm } from '../core/rhino.js';
import { openPathTracer } from '../core/pathtrace.js';

const PRIMS = {
  box: { label: 'Box', icon: 'cube', p: { w: 40, h: 40, d: 40, r: 0 } },
  sphere: { label: 'Sphere', icon: 'sphere', p: { r: 20, seg: 48 } },
  cylinder: { label: 'Cylinder', icon: 'cylinder', p: { rt: 20, rb: 20, h: 40, seg: 48 } },
  cone: { label: 'Cone', icon: 'cone', p: { r: 20, h: 40, seg: 48 } },
  torus: { label: 'Torus', icon: 'torus', p: { r: 22, tube: 7, seg: 72 } },
};
const MORE_PRIMS = {
  capsule: { label: 'Capsule', p: { r: 12, len: 30 } }, ico: { label: 'Icosphere', p: { r: 20, detail: 1 } },
  knot: { label: 'Torus knot', p: { r: 18, tube: 5, p: 2, q: 3 } }, plane: { label: 'Plane', p: { w: 120, d: 120 } },
};
export const MATERIALS = {
  ochre: { label: 'Ochre powder coat', color: '#e3a72f', metal: 0.05, rough: 0.55 },
  red: { label: 'Signal red enamel', color: '#c8432b', metal: 0.05, rough: 0.4 },
  blue: { label: 'Eames blue', color: '#2d5b8a', metal: 0.05, rough: 0.5 },
  olive: { label: 'Olive', color: '#5e6b3a', metal: 0, rough: 0.7 },
  ivory: { label: 'Ivory', color: '#f3eee4', metal: 0, rough: 0.6 },
  ink: { label: 'Matte ink', color: '#1c1a17', metal: 0, rough: 0.75 },
  birch: { label: 'Birch ply', color: '#ffffff', metal: 0, rough: 0.65, wood: 'birch' },
  walnut: { label: 'Walnut', color: '#ffffff', metal: 0, rough: 0.55, wood: 'walnut' },
  alu: { label: 'Brushed aluminium', color: '#c9ccd1', metal: 1, rough: 0.35 },
  steel: { label: 'Blackened steel', color: '#3b3a38', metal: 0.9, rough: 0.45 },
  chrome: { label: 'Chrome', color: '#ffffff', metal: 1, rough: 0.04 },
  concrete: { label: 'Board-formed concrete', color: '#b5aea3', metal: 0, rough: 0.95 },
  glass: { label: 'Glass', color: '#dff0f2', metal: 0, rough: 0.04, opacity: 0.3 },
};

let ctx, S, root, railEl, panelEl, vp, tc;
const sel = [];
const geoCache = new Map(); const importCache = new Map();
let objMap = new Map(); // id -> Object3D
let selHelper = null, fitted = false, gizmoMode = 'translate';
const M = () => S.store.doc.mesh;
const objs = () => M().objects;
const find = (id) => objs().find(o => o.id === id);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- geometry ----------
function linkedSubpaths(o) { const it = o.params.link && ctx.ws.vector.getItem?.(o.params.link); return it?.type === 'path' ? it.subpaths : o.params.subpaths; }
function geomKey(o) { const p = { ...o.params }; if (o.kind === 'extrude' || o.kind === 'lathe') p.subpaths = linkedSubpaths(o); return o.kind + JSON.stringify(p); }
function primGeometry(kind, p) {
  switch (kind) {
    case 'box': { if (p.r > 0) return roundedBox(p.w, p.h, p.d, p.r); return new THREE.BoxGeometry(p.w, p.h, p.d); }
    case 'sphere': return new THREE.SphereGeometry(p.r, p.seg, Math.max(8, Math.round(p.seg / 2)));
    case 'cylinder': return new THREE.CylinderGeometry(p.rt, p.rb, p.h, p.seg);
    case 'cone': return new THREE.ConeGeometry(p.r, p.h, p.seg);
    case 'torus': return new THREE.TorusGeometry(p.r, p.tube, Math.max(12, Math.round(p.seg / 3)), p.seg);
    case 'capsule': return new THREE.CapsuleGeometry(p.r, p.len, 8, 24);
    case 'ico': return new THREE.IcosahedronGeometry(p.r, p.detail);
    case 'knot': return new THREE.TorusKnotGeometry(p.r, p.tube, 160, 20, p.p, p.q);
    case 'plane': { const g = new THREE.PlaneGeometry(p.w, p.d); g.rotateX(-Math.PI / 2); return g; }
  }
  return new THREE.BoxGeometry(10, 10, 10);
}
function roundedBox(w, hh, d, r) { // rounded in plan (vertical edges), like a molded-ply tray
  r = Math.min(r, w / 2 - 0.01, d / 2 - 0.01);
  const s = new THREE.Shape(); const x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0); s.lineTo(x + w, y + d - r); s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + d); s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI); s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: hh, bevelEnabled: false, curveSegments: 12 }); g.translate(0, 0, -hh / 2); g.rotateX(-Math.PI / 2); return boxUV(g, 1 / 60);
}
function loopsToShapes(loops) {
  return loops.map(({ outer, holes }) => {
    const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hpts of holes) s.holes.push(new THREE.Path(hpts.map(([x, y]) => new THREE.Vector2(x, y))));
    return s;
  });
}
function buildGeometry(o) {
  const key = geomKey(o); const hit = geoCache.get(o.id);
  if (hit && hit.key === key) return hit.geo;
  let geo;
  if (PRIMS[o.kind] || MORE_PRIMS[o.kind]) geo = primGeometry(o.kind, o.params);
  else if (o.kind === 'extrude') {
    const subs = linkedSubpaths(o) || [];
    const shapes = loopsToShapes(subpathsToLoops(subs, { size: o.params.size }));
    geo = shapes.length ? new THREE.ExtrudeGeometry(shapes, { depth: o.params.depth, bevelEnabled: o.params.bevel > 0, bevelThickness: o.params.bevel, bevelSize: o.params.bevel * 0.8, bevelSegments: 3, curveSegments: 8 }) : new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, -o.params.depth / 2); geo.computeVertexNormals(); boxUV(geo);
  } else if (o.kind === 'lathe') {
    const loops = subpathsToLoops(linkedSubpaths(o) || [], { size: o.params.size, center: false });
    const outer = loops[0]?.outer || [[5, 0], [15, 0], [15, 20], [5, 20]];
    const minx = Math.min(...outer.map(p => p[0])), miny = Math.min(...outer.map(p => p[1]));
    const pts = [...outer, outer[0]].map(([x, y]) => new THREE.Vector2(Math.max(0, x - minx + (o.params.inner || 0)), y - miny));
    geo = new THREE.LatheGeometry(pts, o.params.seg || 64, 0, (o.params.angle ?? 360) * Math.PI / 180);
  } else if (o.kind === 'bool') {
    geo = boolGeometry(o);
  } else geo = new THREE.BufferGeometry();
  if (!geo.attributes.normal) geo.computeVertexNormals();
  hit?.geo?.dispose?.();
  geoCache.set(o.id, { key, geo });
  return geo;
}
const evaluator = new Evaluator(); evaluator.attributes = ['position', 'normal']; evaluator.useGroups = false;
function toBrush(o) {
  const g = (o.kind === 'bool' ? boolGeometry(o) : buildGeometry(o)).clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.clearGroups();
  const b = new Brush(g);
  b.position.set(...o.pos); b.rotation.set(...o.rot.map(d => d * Math.PI / 180)); b.scale.set(...o.scl); b.updateMatrixWorld();
  return b;
}
function placed(o) { // a boolean operand's geometry moved into the boolean's own frame
  const g = (o.kind === 'bool' ? boolGeometry(o) : buildGeometry(o)).clone();
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...o.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rot.map(d => d * Math.PI / 180))), new THREE.Vector3(...o.scl)));
  return g;
}
const boolEngine = new Map(); // bool id -> 'manifold' | 'bvh'
function boolGeometry(o) {
  const mf = manifoldState() === 'ready';
  const key = 'bool' + JSON.stringify([o.op, o.a, o.b, o.a.kind === 'extrude' ? linkedSubpaths(o.a) : 0, o.b.kind === 'extrude' ? linkedSubpaths(o.b) : 0, mf]);
  const hit = geoCache.get('bool:' + o.id); if (hit && hit.key === key) return hit.geo;
  let geo = null;
  try {
    const r = mf ? manifoldBoolean(placed(o.a), placed(o.b), o.op) : null;
    if (r) { geo = r.geometry; boolEngine.set(o.id, { engine: 'manifold', volume: r.volume, genus: r.genus }); }
    else {
      const A = toBrush(o.a), B = toBrush(o.b);
      const res = evaluator.evaluate(A, B, { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION }[o.op] ?? SUBTRACTION);
      geo = res.geometry; geo.applyMatrix4(A.matrixWorld); geo.computeVertexNormals(); // the result comes back in operand A's frame
      boolEngine.set(o.id, { engine: 'bvh', fallback: mf });
    }
    boxUV(geo);
  } catch (e) { console.error(e); geo = new THREE.BoxGeometry(1, 1, 1); toast('Boolean failed: ' + e.message, 'bad'); }
  geoCache.set('bool:' + o.id, { key, geo });
  return geo;
}

// ---------- materials ----------
const matCache = new Map();
function material(o) {
  const m = o.mat || { preset: 'ochre' }; const pre = MATERIALS[m.preset] || {};
  const woodRepeat = (o.kind === 'extrude' || o.kind === 'bool') ? 1 / 60 : 1;
  const key = JSON.stringify([m, woodRepeat]); if (matCache.has(key)) return matCache.get(key);
  const opacity = m.opacity ?? pre.opacity ?? 1;
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(m.color || pre.color || '#cccccc'), metalness: m.metal ?? pre.metal ?? 0, roughness: m.rough ?? pre.rough ?? 0.5,
    transparent: opacity < 1, opacity, flatShading: !!m.flat, wireframe: !!m.wire, side: THREE.DoubleSide,
    clearcoat: m.preset === 'red' || m.preset === 'walnut' ? 0.35 : 0, clearcoatRoughness: 0.3,
  });
  const wood = m.wood ?? pre.wood; if (wood) mat.map = woodTexture(wood, woodRepeat);
  matCache.set(key, mat); return mat;
}

// ---------- scene sync ----------
async function loadImport(o) {
  const a = S.store.doc.assets[o.params.asset]; if (!a) return null;
  if (importCache.has(a.data)) return importCache.get(a.data);
  const p = (async () => {
    const bytes = dataURLToBytes(a.data); const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (a.format === 'stl') { const g = new STLLoader().parse(buf); g.computeVertexNormals(); return new THREE.Mesh(g); }
    if (a.format === '3dm') { const { group, stats } = await threeFrom3dm(bytes); if (stats.skipped) toast(`${stats.skipped} Rhino object${stats.skipped > 1 ? 's' : ''} had no render mesh and ${stats.skipped > 1 ? 'were' : 'was'} skipped — in Rhino, save without “Save small”`); return group; }
    if (a.format === 'obj') return new OBJLoader().parse(new TextDecoder().decode(bytes));
    return await new Promise((res, rej) => new GLTFLoader().parse(buf, '', (gltf) => res(gltf.scene), rej));
  })();
  importCache.set(a.data, p); return p;
}
function objectFor(o) {
  let node;
  if (o.kind === 'import') {
    node = new THREE.Group();
    loadImport(o).then(src => { if (!src) return; const c = src.clone(true); c.traverse(ch => { if (ch.isMesh) { ch.castShadow = ch.receiveShadow = true; if (o.mat?.override) ch.material = material(o); } }); node.add(c); vp.requestRender(); updateSelHelper(); }).catch(e => toast('Could not read the 3D file: ' + e.message, 'bad'));
  } else {
    const mesh = new THREE.Mesh(buildGeometry(o), material(o)); mesh.castShadow = mesh.receiveShadow = true; node = mesh;
  }
  node.userData.kid = o.id;
  if (o.array && o.array.count > 1) {
    const g = new THREE.Group(); g.userData.kid = o.id; g.add(node);
    for (let i = 1; i < o.array.count; i++) {
      const c = node.clone(); c.userData.kid = o.id;
      if (o.array.type === 'radial') { const piv = new THREE.Group(); piv.rotation.y = (i * (o.array.angle ?? 360) / (o.array.angle === 360 || o.array.angle == null ? o.array.count : Math.max(1, o.array.count - 1))) * Math.PI / 180; piv.add(c); c.position.set(o.array.radius ?? 0, 0, 0); g.add(piv); }
      else { c.position.set(...(o.array.offset || [30, 0, 0]).map(v => v * i)); g.add(c); }
    }
    if (o.array.type === 'radial') node.position.set(o.array.radius ?? 0, 0, 0);
    node = g;
  }
  return node;
}
function sync() {
  if (!vp) return;
  if (manifoldState() === 'idle' && objs().some(o => o.kind === 'bool')) loadManifold().then(ok => { if (ok) sync(); });
  const keep = new Set();
  const root3 = vp.root;
  for (const o of objs()) {
    keep.add(o.id);
    const sig = JSON.stringify([geomKey(o), o.mat, o.array, o.hidden, o.kind === 'bool' ? [o.a, o.b] : 0]);
    let node = objMap.get(o.id);
    if (!node || node.userData.sig !== sig) {
      if (node) root3.remove(node);
      node = objectFor(o); node.userData.sig = sig; objMap.set(o.id, node); root3.add(node);
    }
    node.visible = !o.hidden;
    node.position.set(...o.pos); node.rotation.set(...o.rot.map(d => d * Math.PI / 180)); node.scale.set(...o.scl);
  }
  for (const [id, node] of objMap) if (!keep.has(id)) { root3.remove(node); objMap.delete(id); }
  attachGizmo(); updateSelHelper(); vp.requestRender(); updateStatus();
}
function updateSelHelper() {
  if (!vp) return;
  if (selHelper) { vp.overlay.remove(selHelper); selHelper.geometry?.dispose(); selHelper = null; }
  const n = sel[0] && objMap.get(sel[0]); if (!n) return;
  selHelper = new THREE.BoxHelper(n, new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--sel').trim() || '#1f55e8'));
  vp.overlay.add(selHelper); vp.requestRender();
}
function attachGizmo() {
  if (!tc) return;
  const n = sel[0] && objMap.get(sel[0]);
  if (n && n.parent) tc.attach(n); else tc.detach();
  tc.setMode(gizmoMode);
}
function updateStatus() {
  let tris = 0; vp?.root.traverse(n => { if (n.isMesh && n.geometry) { const g = n.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  ctx.setStatus('mesh', `${objs().length} objects · ${Math.round(tris).toLocaleString()} triangles · gizmo ${gizmoMode}${sel.length ? ` · ${sel.length} selected` : ''}`);
}

// ---------- commands ----------
function mutate(label, fn) { S.checkpoint(label); fn(); S.changed('mesh'); }
function addPrim(kind) {
  const def = PRIMS[kind] || MORE_PRIMS[kind]; const p = { ...def.p };
  const half = kind === 'plane' ? 0 : kind === 'box' ? p.h / 2 : kind === 'cylinder' || kind === 'cone' ? p.h / 2 : kind === 'capsule' ? p.r + p.len / 2 : kind === 'torus' ? p.r + p.tube : p.r ?? 20;
  const o = { id: uid('m'), name: def.label, kind, params: p, pos: [(objs().length % 5) * 12 - 24, half, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: ['ochre', 'red', 'blue', 'walnut', 'olive'][objs().length % 5] } };
  if (kind === 'torus') o.rot = [90, 0, 0];
  mutate('Add ' + def.label, () => { objs().push(o); sel.length = 0; sel.push(o.id); });
  buildPanel();
}
export function extrudeFromVector(vecId) {
  const it = ctx.ws.vector.getItem?.(vecId); if (!it || it.type !== 'path') { toast('Pick a closed path in Vector first', 'bad'); return; }
  if (!it.subpaths.some(s => s.closed)) { toast('That path is open — close it to extrude', 'bad'); return; }
  const o = { id: uid('m'), name: (it.name || 'Path') + ' extrusion', kind: 'extrude', params: { link: vecId, subpaths: JSON.parse(JSON.stringify(it.subpaths)), size: 80, depth: 14, bevel: 1.2 }, pos: [0, 45, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'red' } };
  mutate('Extrude from Vector', () => { objs().push(o); sel.length = 0; sel.push(o.id); });
  buildPanel(); setTimeout(() => vp?.frame(), 60);
}
async function fromVectorDialog(kind) {
  const shapes = ctx.ws.vector.listShapes?.() || [];
  if (!shapes.length) { toast('Draw a closed path in Vector first', 'bad'); return; }
  let pick = shapes[0].id;
  const ok = await dialog({ title: kind === 'lathe' ? 'Lathe a Vector profile' : 'Extrude a Vector path', body: (el) => el.append(
    h('p', null, kind === 'lathe' ? 'The path is spun around its left edge, like turning on a lathe. The link stays live: reshape the path in Vector and the solid follows.' : 'The path becomes a solid with depth and a bevel. The link stays live: reshape the path in Vector and the solid follows.'),
    selectField({ label: 'Path', value: pick, options: shapes.map(s => [s.id, s.name]), onChange: v => pick = v, span: 3 })),
    actions: [{ label: 'Cancel', value: false }, { label: kind === 'lathe' ? 'Lathe' : 'Extrude', primary: true, value: true }] });
  if (!ok) return;
  if (kind === 'extrude') return extrudeFromVector(pick);
  const it = ctx.ws.vector.getItem(pick);
  const o = { id: uid('m'), name: (it.name || 'Path') + ' lathe', kind: 'lathe', params: { link: pick, subpaths: clone(it.subpaths), size: 60, seg: 72, angle: 360, inner: 0 }, pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'ivory' } };
  mutate('Lathe from Vector', () => { objs().push(o); sel.length = 0; sel.push(o.id); }); buildPanel(); setTimeout(() => vp?.frame(), 60);
}
function boolean(op) {
  if (sel.length !== 2) { toast('Select exactly two objects (Shift-click)'); return; }
  const [a, b] = sel.map(find);
  if (a.kind === 'import' || b.kind === 'import') { toast('Booleans work on KERF objects, not imported files', 'bad'); return; }
  const o = { id: uid('m'), name: `${a.name} ${op} ${b.name}`, kind: 'bool', op, a: clone(a), b: clone(b), pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: clone(a.mat) };
  mutate('Boolean ' + op, () => { M().objects = objs().filter(x => x !== a && x !== b); objs().push(o); sel.length = 0; sel.push(o.id); });
  buildPanel();
  if (manifoldState() !== 'ready') loadManifold().then(ok => { if (ok) { sync(); buildPanel(); } });
}
function breakBool(o) {
  mutate('Break boolean', () => {
    const tr = (c) => { const m = new THREE.Matrix4().compose(new THREE.Vector3(...o.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...o.rot.map(d => d * Math.PI / 180))), new THREE.Vector3(...o.scl));
      const cm = new THREE.Matrix4().compose(new THREE.Vector3(...c.pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...c.rot.map(d => d * Math.PI / 180))), new THREE.Vector3(...c.scl));
      const r = m.multiply(cm); const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); r.decompose(p, q, s); const e = new THREE.Euler().setFromQuaternion(q);
      return { ...c, id: uid('m'), pos: p.toArray(), rot: [e.x, e.y, e.z].map(v => v * 180 / Math.PI), scl: s.toArray() }; };
    M().objects = objs().filter(x => x !== o); const A = tr(o.a), B = tr(o.b); objs().push(A, B); sel.length = 0; sel.push(A.id);
  });
  buildPanel();
}
function duplicate() {
  if (!sel.length) return;
  mutate('Duplicate', () => { const ids = []; for (const id of sel) { const c = clone(find(id)); c.id = uid('m'); c.pos[0] += 15; c.name += ' copy'; objs().push(c); ids.push(c.id); } sel.length = 0; sel.push(...ids); });
  buildPanel();
}
function remove() { if (!sel.length) return; mutate('Delete', () => { M().objects = objs().filter(o => !sel.includes(o.id)); sel.length = 0; }); buildPanel(); }
export function addMeshFromSTL(name, stlBytes, matPreset = 'alu') {
  const asset = S.addAsset({ kind: 'model', format: 'stl', name: name + '.stl', data: 'data:model/stl;base64,' + bytesToBase64(stlBytes) });
  const o = { id: uid('m'), name, kind: 'import', params: { asset }, pos: [0, 0, 0], rot: [-90, 0, 0], scl: [1, 1, 1], mat: { preset: matPreset, override: true } };
  mutate('Send to Mesh', () => { objs().push(o); sel.length = 0; sel.push(o.id); });
  setTimeout(() => vp?.frame(), 120);
}
async function importFile() {
  const f = await pickFile('.glb,.gltf,.stl,.obj,.3dm'); if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase(); const buf = new Uint8Array(await readAsArrayBuffer(f));
  if (ext === 'gltf') { toast('Use .glb (binary glTF) — a .gltf with separate files can\'t be embedded', 'bad'); return; }
  const asset = S.addAsset({ kind: 'model', format: ext === 'glb' ? 'glb' : ext, name: f.name, data: `data:application/octet-stream;base64,${bytesToBase64(buf)}` });
  const o = { id: uid('m'), name: f.name, kind: 'import', params: { asset }, pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], mat: { preset: 'ivory', override: ext !== 'glb' && ext !== '3dm' } };
  mutate('Import ' + ext.toUpperCase(), () => { objs().push(o); sel.length = 0; sel.push(o.id); });
  buildPanel(); setTimeout(() => vp?.frame(), 200);
}
function raytrace() { if (!vp) return; if (!objs().length) { toast('Add something to render first', 'bad'); return; } sel.length = 0; attachGizmo(); updateSelHelper(); openPathTracer({ vp, name: S.store.doc.name }); }
function exportRoot() { const g = new THREE.Group(); vp.root.updateMatrixWorld(true); g.add(vp.root.clone(true)); return g; }
async function exportAs(fmt) {
  if (!vp) return; const base = safeName(S.store.doc.name, 'scene');
  if (fmt === 'glb') { const r = await new GLTFExporter().parseAsync(exportRoot(), { binary: true }); return saveFile(base + '.glb', new Blob([r]), 'model/gltf-binary'); }
  if (fmt === 'stl') { const r = new STLExporter().parse(exportRoot(), { binary: true }); return saveFile(base + '.stl', new Blob([r]), 'model/stl'); }
  if (fmt === 'obj') { const r = new OBJExporter().parse(exportRoot()); return saveFile(base + '.obj', r, 'text/plain'); }
  if (fmt === 'png') { const r = vp.renderer.domElement.getBoundingClientRect(); const url = vp.snapshot({ w: Math.round(r.width * 2), h: Math.round(r.height * 2) }); return saveFile(base + '-render.png', new Blob([dataURLToBytes(url)], { type: 'image/png' }), 'image/png'); }
}

// ---------- pointer selection ----------
let downAt = null;
function onPointerDown(e) { downAt = [e.clientX, e.clientY]; }
function onPointerUp(e) {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || tc?.dragging) { downAt = null; return; }
  downAt = null;
  const r = vp.renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), vp.camera);
  const hits = ray.intersectObjects(vp.root.children, true);
  let id = null; for (const hh of hits) { let n = hh.object; while (n && !n.userData.kid) n = n.parent; if (n) { id = n.userData.kid; break; } }
  if (!id) { if (!e.shiftKey) sel.length = 0; }
  else if (e.shiftKey) { const i = sel.indexOf(id); if (i >= 0) sel.splice(i, 1); else sel.push(id); }
  else { sel.length = 0; sel.push(id); }
  attachGizmo(); updateSelHelper(); buildPanel(); updateStatus();
}

// ---------- rail & panel ----------
let gizmoBtns = {};
function buildRail() {
  clear(railEl);
  for (const [m, ic, k] of [['translate', 'move', 'W'], ['rotate', 'rotate', 'E'], ['scale', 'scale', 'R']]) {
    gizmoBtns[m] = h('button', { class: 'tool', type: 'button', title: `${m[0].toUpperCase() + m.slice(1)} (${k})`, 'aria-label': m, 'aria-pressed': String(gizmoMode === m), html: icon(ic) + `<span class="key">${k}</span>`, onclick: () => setGizmo(m) });
    railEl.append(gizmoBtns[m]);
  }
  railEl.append(h('div', { class: 'rail-sep' }));
  for (const [kind, d] of Object.entries(PRIMS)) railEl.append(h('button', { class: 'tool', type: 'button', title: 'Add ' + d.label, 'aria-label': 'Add ' + d.label, html: icon(d.icon), onclick: () => addPrim(kind) }));
  railEl.append(h('div', { class: 'rail-sep' }));
  railEl.append(h('button', { class: 'tool', type: 'button', title: 'Extrude a Vector path', 'aria-label': 'Extrude a Vector path', html: icon('extrude'), onclick: () => fromVectorDialog('extrude') }));
  railEl.append(h('button', { class: 'tool', type: 'button', title: 'Lathe a Vector profile', 'aria-label': 'Lathe a Vector profile', html: icon('revolve'), onclick: () => fromVectorDialog('lathe') }));
  railEl.append(h('button', { class: 'tool', type: 'button', title: 'Import GLB / STL / OBJ / Rhino 3DM', 'aria-label': 'Import 3D file', html: icon('upload'), onclick: importFile }));
  railEl.append(h('button', { class: 'tool', type: 'button', title: 'Ray-traced render', 'aria-label': 'Ray-traced render', html: icon('bolt'), onclick: raytrace }));
}
function setGizmo(m) { gizmoMode = m; for (const [k, b] of Object.entries(gizmoBtns)) b.setAttribute('aria-pressed', String(k === m)); attachGizmo(); updateStatus(); }
function vec3Fields(label, arr, onChange, step = 1, unitLbl = '') {
  return h('div', { class: 'fields three' }, ['X', 'Y', 'Z'].map((ax, i) => numField({ label: `${label} ${ax}`, unit: unitLbl, value: arr[i], step, onChange: v => { const a = [...arr]; a[i] = v; onChange(a); } })));
}
function setObj(o, p, label) { S.checkpoint(label); Object.assign(o, p); S.changed('mesh'); }
function paramFields(o) {
  if (!o.params || o.kind === 'import') return null; // booleans and imported files have no primitive parameters
  const p = o.params; const f = (key, label, opt = {}) => numField({ label, value: p[key], unit: opt.unit ?? 'mm', min: opt.min ?? 0, step: opt.step ?? 1, decimals: opt.dec ?? 2, onChange: v => { S.checkpoint('Edit ' + label); p[key] = opt.int ? Math.round(v) : v; S.changed('mesh'); } });
  const by = {
    box: [f('w', 'Width'), f('h', 'Height'), f('d', 'Depth'), f('r', 'Corner radius')],
    sphere: [f('r', 'Radius'), f('seg', 'Segments', { unit: '', min: 8, int: true, dec: 0 })],
    cylinder: [f('rt', 'Top radius'), f('rb', 'Bottom radius'), f('h', 'Height'), f('seg', 'Segments', { unit: '', min: 3, int: true, dec: 0 })],
    cone: [f('r', 'Radius'), f('h', 'Height'), f('seg', 'Segments', { unit: '', min: 3, int: true, dec: 0 })],
    torus: [f('r', 'Radius'), f('tube', 'Tube'), f('seg', 'Segments', { unit: '', min: 12, int: true, dec: 0 })],
    capsule: [f('r', 'Radius'), f('len', 'Length')], ico: [f('r', 'Radius'), f('detail', 'Detail', { unit: '', int: true, dec: 0 })],
    knot: [f('r', 'Radius'), f('tube', 'Tube'), f('p', 'P', { unit: '', int: true, dec: 0, min: 1 }), f('q', 'Q', { unit: '', int: true, dec: 0, min: 1 })], plane: [f('w', 'Width'), f('d', 'Depth')],
    extrude: [f('size', 'Size'), f('depth', 'Depth'), f('bevel', 'Bevel', { step: 0.2 })],
    lathe: [f('size', 'Size'), f('angle', 'Sweep', { unit: '°', min: 1 }), f('inner', 'Inner radius'), f('seg', 'Segments', { unit: '', min: 3, int: true, dec: 0 })],
  }[o.kind];
  return by ? h('div', { class: 'fields' }, by) : null;
}
function buildPanel() {
  if (!panelEl) return; clear(panelEl);
  const o = sel[0] && find(sel[0]);
  if (o) {
    panelEl.append(pane(o.kind === 'bool' ? `Boolean · ${o.op}` : (PRIMS[o.kind] || MORE_PRIMS[o.kind])?.label || ({ extrude: 'Extrusion', lathe: 'Lathe', import: 'Imported model' }[o.kind]),
      h('div', { class: 'fields' }, textField({ label: 'Name', value: o.name, onChange: v => setObj(o, { name: v }, 'Rename') })),
      vec3Fields('Pos', o.pos, a => setObj(o, { pos: a }, 'Move'), 1, 'mm'), vec3Fields('Rot', o.rot, a => setObj(o, { rot: a }, 'Rotate'), 5, '°'), vec3Fields('Scale', o.scl, a => setObj(o, { scl: a }, 'Scale'), 0.1)));
    if (o.kind === 'bool') { const be = boolEngine.get(o.id); panelEl.append(pane('Boolean engine', h('p', { class: 'hint' }, !be ? 'Computing…' : be.engine === 'manifold' ? `Manifold · exact and watertight · ${round(be.volume / 1000, 3)} cm³ · genus ${be.genus}` : be.fallback ? 'BVH-CSG fallback — one of the inputs is not a closed solid, so Manifold refused it' : manifoldState() === 'loading' ? 'BVH-CSG for now · Manifold is loading' : manifoldState() === 'failed' ? 'BVH-CSG · Manifold could not load here' : 'BVH-CSG'))); }
    const pf = paramFields(o); if (pf) panelEl.append(pane('Parameters', pf, (o.kind === 'extrude' || o.kind === 'lathe') ? h('p', { class: 'hint' }, o.params.link && ctx.ws.vector.getItem?.(o.params.link) ? 'Live-linked to a Vector path. Edit the path and this updates.' : 'The source path was deleted; this keeps the last copy.') : null));
    const m = o.mat || {};
    panelEl.append(pane('Material', h('div', { class: 'fields' },
      selectField({ label: 'Preset', value: m.preset || 'ochre', options: Object.entries(MATERIALS).map(([k2, v]) => [k2, v.label]), onChange: v => setObj(o, { mat: { preset: v, override: m.override } }, 'Material'), span: 2 }),
      colorField({ label: 'Colour', value: m.color || MATERIALS[m.preset]?.color || '#cccccc', onChange: v => setObj(o, { mat: { ...m, color: v } }, 'Colour') }),
      numField({ label: 'Metalness', value: m.metal ?? MATERIALS[m.preset]?.metal ?? 0, min: 0, max: 1, step: 0.05, onChange: v => setObj(o, { mat: { ...m, metal: v } }, 'Metalness') }),
      numField({ label: 'Roughness', value: m.rough ?? MATERIALS[m.preset]?.rough ?? 0.5, min: 0, max: 1, step: 0.05, onChange: v => setObj(o, { mat: { ...m, rough: v } }, 'Roughness') }),
      numField({ label: 'Opacity', value: m.opacity ?? MATERIALS[m.preset]?.opacity ?? 1, min: 0.05, max: 1, step: 0.05, onChange: v => setObj(o, { mat: { ...m, opacity: v } }, 'Opacity') })),
      h('div', { class: 'btn-row' }, checkField({ label: 'Flat shading', value: m.flat, onChange: v => setObj(o, { mat: { ...m, flat: v } }, 'Shading') }), checkField({ label: 'Wireframe', value: m.wire, onChange: v => setObj(o, { mat: { ...m, wire: v } }, 'Wireframe') }),
        o.kind === 'import' ? checkField({ label: 'Override file materials', value: m.override, onChange: v => setObj(o, { mat: { ...m, override: v } }, 'Override') }) : null)));
    const ar = o.array || { type: 'none', count: 1 };
    panelEl.append(pane('Array', h('div', { class: 'fields' },
      selectField({ label: 'Type', value: o.array ? ar.type : 'none', options: [['none', 'None'], ['linear', 'Linear'], ['radial', 'Radial (around Y)']], onChange: v => setObj(o, { array: v === 'none' ? null : { type: v, count: 6, offset: [40, 0, 0], radius: 60, angle: 360 } }, 'Array'), span: 2 }),
      o.array ? numField({ label: 'Count', value: ar.count, min: 1, max: 500, decimals: 0, onChange: v => setObj(o, { array: { ...ar, count: Math.round(v) } }, 'Array count') }) : null,
      o.array?.type === 'linear' ? numField({ label: 'Step X', unit: 'mm', value: ar.offset[0], onChange: v => setObj(o, { array: { ...ar, offset: [v, ar.offset[1], ar.offset[2]] } }, 'Array step') }) : null,
      o.array?.type === 'linear' ? numField({ label: 'Step Y', unit: 'mm', value: ar.offset[1], onChange: v => setObj(o, { array: { ...ar, offset: [ar.offset[0], v, ar.offset[2]] } }, 'Array step') }) : null,
      o.array?.type === 'linear' ? numField({ label: 'Step Z', unit: 'mm', value: ar.offset[2], onChange: v => setObj(o, { array: { ...ar, offset: [ar.offset[0], ar.offset[1], v] } }, 'Array step') }) : null,
      o.array?.type === 'radial' ? numField({ label: 'Radius', unit: 'mm', value: ar.radius, onChange: v => setObj(o, { array: { ...ar, radius: v } }, 'Array radius') }) : null,
      o.array?.type === 'radial' ? numField({ label: 'Sweep', unit: '°', value: ar.angle, min: 1, max: 360, onChange: v => setObj(o, { array: { ...ar, angle: v } }, 'Array sweep') }) : null)));
    panelEl.append(pane('Actions', h('div', { class: 'btn-grid' },
      h('button', { class: 'btn small', type: 'button', onclick: duplicate }, 'Duplicate'),
      h('button', { class: 'btn small', type: 'button', onclick: () => vp.frame(vp.bounds(objMap.get(o.id))) }, 'Frame'),
      o.kind === 'bool' ? h('button', { class: 'btn small', type: 'button', onclick: () => breakBool(o) }, 'Break apart') : null,
      h('button', { class: 'btn small danger', type: 'button', onclick: remove }, 'Delete')),
      sel.length === 2 ? h('div', { class: 'btn-row' }, iconBtn('boolU', 'Union', () => boolean('union')), iconBtn('boolS', 'Subtract second from first', () => boolean('subtract')), iconBtn('boolI', 'Intersect', () => boolean('intersect')), h('span', { class: 'hint', style: { alignSelf: 'center' } }, 'Live boolean — Break apart restores both')) : h('p', { class: 'hint' }, 'Shift-click a second object for booleans.')));
  } else {
    panelEl.append(pane('Add', h('div', { class: 'btn-grid' }, ...Object.entries({ ...PRIMS, ...MORE_PRIMS }).map(([k2, d]) => h('button', { class: 'btn small', type: 'button', onclick: () => addPrim(k2) }, d.label))),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => fromVectorDialog('extrude') }, 'Extrude Vector path'), h('button', { class: 'btn small', type: 'button', onclick: () => fromVectorDialog('lathe') }, 'Lathe Vector path'), h('button', { class: 'btn small', type: 'button', onclick: importFile }, 'Import file…'))));
  }
  const list = h('div', { class: 'list tall' });
  if (!objs().length) list.append(h('div', { class: 'li' }, h('span'), h('span', { class: 'name', style: { color: 'var(--muted)' } }, 'Empty scene. Add a primitive or extrude a Vector path.'), h('span')));
  for (const ob of [...objs()].reverse()) {
    const pre = MATERIALS[ob.mat?.preset]; const sw = ob.mat?.color || pre?.color || '#ccc';
    list.append(h('div', { class: 'li' + (ob.hidden ? ' dim' : ''), 'aria-selected': String(sel.includes(ob.id)), onclick: (e) => { if (e.shiftKey) { const i = sel.indexOf(ob.id); if (i >= 0) sel.splice(i, 1); else sel.push(ob.id); } else { sel.length = 0; sel.push(ob.id); } attachGizmo(); updateSelHelper(); buildPanel(); } },
      h('span', { class: 'sw', style: { background: pre?.wood === 'walnut' ? '#5c3a22' : pre?.wood === 'birch' ? '#dec498' : sw, borderRadius: '50%' } }), h('span', { class: 'name' }, ob.name), h('span', { class: 'acts' },
        h('button', { type: 'button', title: ob.hidden ? 'Show' : 'Hide', 'aria-label': ob.hidden ? 'Show' : 'Hide', html: icon(ob.hidden ? 'eyeOff' : 'eye', 15), onclick: (e) => { e.stopPropagation(); setObj(ob, { hidden: !ob.hidden }, 'Visibility'); buildPanel(); } }))));
  }
  panelEl.append(pane('Scene', list, h('div', { class: 'btn-grid' },
    h('button', { class: 'btn small', type: 'button', onclick: () => exportAs('glb') }, 'GLB'), h('button', { class: 'btn small', type: 'button', onclick: () => exportAs('stl') }, 'STL'),
    h('button', { class: 'btn small', type: 'button', onclick: () => exportAs('obj') }, 'OBJ'), h('button', { class: 'btn small', type: 'button', onclick: () => exportAs('png') }, 'Snapshot PNG'),
    h('button', { class: 'btn small primary', type: 'button', onclick: raytrace, style: { gridColumn: 'span 2' } }, 'Ray-traced render…'))));
}

// ---------- workspace interface ----------
export default {
  id: 'mesh', label: 'Mesh',
  extrudeFromVector: (id) => extrudeFromVector(id),
  addMeshFromSTL: (n, b, m) => addMeshFromSTL(n, b, m),
  snapshot(opts) { if (!vp) initLazy(); if (!vp) return null; sync(); return objs().length ? vp.snapshot(opts) : null; },
  register(c) {
    const r = (id, label, run, tags) => registerCommand({ id: 'mesh.' + id, label, run: () => { c.activate('mesh'); run(); }, tags, ws: 'mesh' });
    for (const [k2, d] of Object.entries({ ...PRIMS, ...MORE_PRIMS })) r('add-' + k2, `Add ${d.label.toLowerCase()}`, () => addPrim(k2), 'primitive 3d');
    r('extrude', 'Extrude a Vector path into 3D', () => fromVectorDialog('extrude'), 'solid logo');
    r('lathe', 'Lathe a Vector profile', () => fromVectorDialog('lathe'), 'revolve turn');
    r('import', 'Import GLB / STL / OBJ / Rhino 3DM…', importFile, 'open load model rhino 3dm');
    r('raytrace', 'Ray-traced render (path tracer)', raytrace, 'render pathtrace photoreal gpu');
    r('glb', 'Export scene as GLB', () => exportAs('glb'), 'gltf save');
    r('stl', 'Export scene as STL', () => exportAs('stl'), '3d print save');
    r('obj', 'Export scene as OBJ', () => exportAs('obj'), 'save');
    r('png', 'Render scene to PNG', () => exportAs('png'), 'image snapshot');
    r('union', 'Boolean union (two selected)', () => boolean('union'), 'csg merge');
    r('subtract', 'Boolean subtract (two selected)', () => boolean('subtract'), 'csg cut');
    r('intersect', 'Boolean intersect (two selected)', () => boolean('intersect'), 'csg');
  },
  init(c, m) { ctx = c; S = c.S; root = m.root; railEl = m.rail; panelEl = m.panel; initLazy(); buildRail(); buildPanel(); },
  show() { initLazy(); geoCache.forEach((v, k) => { if (String(k).startsWith('bool:')) geoCache.delete(k); }); sync(); requestAnimationFrame(() => { vp?.resize(); if (!fitted && vp) { vp.frame(); fitted = true; } }); buildPanel(); },
  onDoc() { sel.length = 0; fitted = false; if (vp) { sync(); if (!root.hidden) { vp.frame(); fitted = true; } } buildPanel(); },
  onChange(e) { if (e.ws === 'mesh' || !e.ws) { sync(); if (!e.live) buildPanelSoon(); } },
  status() { return 'Mesh'; },
  fileMenu() {
    return [
      { label: 'Import GLB / STL / OBJ / 3DM…', icon: 'upload', run: importFile },
      { label: 'Ray-traced render…', icon: 'bolt', run: raytrace },
      { label: 'Export GLB', icon: 'download', run: () => exportAs('glb') }, { label: 'Export STL', icon: 'download', run: () => exportAs('stl') },
      { label: 'Export OBJ', icon: 'download', run: () => exportAs('obj') }, { label: 'Render PNG', icon: 'image', run: () => exportAs('png') },
    ];
  },
  onKey(e) {
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'd') { e.preventDefault(); duplicate(); return true; }
    if (mod) return false;
    if (k === 'w') { setGizmo('translate'); return true; } if (k === 'e') { setGizmo('rotate'); return true; } if (k === 'r') { setGizmo('scale'); return true; }
    if (k === 'f') { vp?.frame(sel[0] ? vp.bounds(objMap.get(sel[0])) : undefined); return true; }
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); remove(); return true; }
    if (k === 'escape') { sel.length = 0; attachGizmo(); updateSelHelper(); buildPanel(); return true; }
    return false;
  },
};
function initLazy() {
  if (vp || !root) return;
  const host = h('div', { class: 'three-host' }); root.append(host);
  vp = createViewport(host); if (!vp) return;
  tc = new TransformControls(vp.camera, vp.renderer.domElement);
  tc.addEventListener('dragging-changed', (ev) => {
    vp.controls.enabled = !ev.value;
    if (ev.value) S.checkpoint('Transform');
    else S.changed('mesh');
  });
  tc.addEventListener('objectChange', () => {
    const n = tc.object; const o = n && find(n.userData.kid); if (!o) return;
    o.pos = n.position.toArray().map(v => round(v, 3)); o.rot = [n.rotation.x, n.rotation.y, n.rotation.z].map(v => round(v * 180 / Math.PI, 3)); o.scl = n.scale.toArray().map(v => round(v, 4));
    updateSelHelper(); vp.requestRender();
  });
  tc.addEventListener('change', () => vp.requestRender());
  vp.scene.add(tc.getHelper());
  const cv = vp.renderer.domElement;
  cv.addEventListener('pointerdown', onPointerDown); cv.addEventListener('pointerup', onPointerUp);
  root.append(h('div', { class: 'view-cube' }, ...['iso', 'front', 'top', 'right', 'hero', 'left'].map(v => h('button', { type: 'button', onclick: () => vp.setView(v) }, v.toUpperCase()))));
  ctx.S.on('theme', () => setTimeout(() => vp.applyTheme(), 30));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => setTimeout(() => vp.applyTheme(), 30));
  sync();
}
const buildPanelSoon = panelRebuilder(() => panelEl, () => buildPanel());
