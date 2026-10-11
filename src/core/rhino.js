// Rhino .3dm import with rhino3dm (MIT, McNeel), loaded on demand as WebAssembly.
// Meshes, and the render meshes Rhino saves with Breps, Extrusions and SubDs, come in with their layer/object colours.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import rhino3dm from 'rhino3dm/rhino3dm.module.js';
import { fetchBundled } from './io.js';

let rh = null, loading = null;
export function loadRhino() {
  if (rh) return Promise.resolve(rh);
  if (!loading) loading = (async () => {
    const bytes = await fetchBundled('rhino3dm.wasm');
    rh = await rhino3dm({ instantiateWasm: (imports, done) => { WebAssembly.instantiate(bytes, imports).then(r => done(r.instance, r.module)); return {}; }, print() {}, printErr() {} });
    return rh;
  })().finally(() => { loading = null; });
  return loading;
}
const UNIT_MM = { Millimeters: 1, Centimeters: 10, Meters: 1000, Kilometers: 1e6, Microns: 0.001, Inches: 25.4, Feet: 304.8, Yards: 914.4, Miles: 1609344, None: 1 };

/** Parse .3dm bytes into a three.js group (Y-up, millimetres). Returns {group, stats}. */
export async function threeFrom3dm(bytes) {
  const R = await loadRhino();
  const doc = R.File3dm.fromByteArray(bytes);
  if (!doc) throw new Error('This is not a Rhino .3dm file, or it is from a newer Rhino than rhino3dm can read');
  let unit = 'Millimeters'; const us = doc.settings().modelUnitSystem; for (const [k, v] of Object.entries(R.UnitSystem)) if (v === us) unit = k;
  const k = UNIT_MM[unit] ?? 1;
  const group = new THREE.Group(); group.name = 'Rhino model';
  const loader = new THREE.BufferGeometryLoader();
  const stats = { objects: 0, meshes: 0, skipped: 0, unit, layers: doc.layers().count };
  const mats = new Map();
  const matFor = (c) => { const key = `${c.r},${c.g},${c.b}`; if (!mats.has(key)) mats.set(key, new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c.r / 255, c.g / 255, c.b / 255).convertSRGBToLinear(), roughness: 0.55, metalness: 0, side: THREE.DoubleSide })); return mats.get(key); };
  const objs = doc.objects();
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i); const g = o.geometry(); const at = o.attributes(); stats.objects++;
    if (at.visible === false) continue;
    const meshes = [];
    if (g instanceof R.Mesh) meshes.push(g);
    else if (g instanceof R.Brep) { const f = g.faces(); for (let j = 0; j < f.count; j++) { const m = f.get(j).getMesh(R.MeshType.Any); if (m) meshes.push(m); } }
    else if (g instanceof R.Extrusion) { const m = g.getMesh(R.MeshType.Any); if (m) meshes.push(m); }
    else if (R.SubD && g instanceof R.SubD) { /* SubD limit surfaces need Rhino's mesher */ }
    else continue; // curves, points, annotations
    if (!meshes.length) { stats.skipped++; continue; }
    let color = { r: 200, g: 196, b: 188 }; try { color = at.drawColor(doc); } catch { /* default */ }
    const sub = new THREE.Group(); sub.name = at.name || `${g.constructor?.name || 'Object'} ${i + 1}`;
    for (const m of meshes) {
      const json = m.toThreejsJSON(true); const geo = loader.parse(json);
      geo.scale(k, k, k); if (!geo.attributes.normal) geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, matFor(color)); mesh.castShadow = mesh.receiveShadow = true; sub.add(mesh); stats.meshes++;
    }
    group.add(sub);
  }
  return { group, stats };
}
