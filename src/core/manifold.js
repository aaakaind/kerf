// Exact mesh booleans with Manifold (Apache-2.0, github.com/elalish/manifold), loaded on demand as WebAssembly.
// Manifold guarantees a closed, watertight result whenever both inputs are closed; anything else falls back to BVH-CSG.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import Module from 'manifold-3d/manifold.js';
import { fetchBundled } from './io.js';

let wasm = null, loading = null, error = '';
export const manifoldState = () => (wasm ? 'ready' : loading ? 'loading' : error ? 'failed' : 'idle');
/** Start loading (idempotent). Resolves true when ready. */
export function loadManifold() {
  if (wasm) return Promise.resolve(true);
  if (!loading) loading = (async () => {
    try {
      const bytes = await fetchBundled('manifold.wasm');
      const m = await Module({ instantiateWasm: (imports, done) => { WebAssembly.instantiate(bytes, imports).then(r => done(r.instance, r.module)); return {}; }, print() {}, printErr() {} });
      m.setup(); wasm = m; return true;
    } catch (e) { error = e.message || String(e); console.warn('Manifold failed to load', e); return false; } finally { loading = null; }
  })();
  return loading;
}

function toManifold(geo) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', geo.attributes.position.clone()); if (geo.index) g.setIndex(geo.index.clone());
  const m = mergeVertices(g, 1e-5);
  const pos = m.attributes.position.array; const idx = m.index ? m.index.array : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(pos), triVerts: new Uint32Array(idx) });
  mesh.merge(); // weld seam vertices that three.js primitives keep separate for UVs
  return new wasm.Manifold(mesh); // throws ManifoldError when the input is not closed / oriented
}
function fromManifold(man, crease = 32) {
  const out = man.getMesh(); const np = out.numProp;
  const pos = new Float32Array((out.vertProperties.length / np) * 3);
  for (let i = 0, j = 0; i < out.vertProperties.length; i += np, j += 3) { pos[j] = out.vertProperties[i]; pos[j + 1] = out.vertProperties[i + 1]; pos[j + 2] = out.vertProperties[i + 2]; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(new Uint32Array(out.triVerts), 1));
  return toCreasedNormals(g, (crease * Math.PI) / 180); // sharp at real edges, smooth across curved faces
}

/**
 * Boolean of two geometries already placed in the same frame. op: 'union' | 'subtract' | 'intersect'.
 * Returns {geometry, volume, genus} or null when Manifold isn't loaded or an input isn't a closed solid.
 */
export function manifoldBoolean(geoA, geoB, op) {
  if (!wasm) return null;
  let a, b, r;
  try {
    a = toManifold(geoA); b = toManifold(geoB);
    r = op === 'union' || op === 'add' ? a.add(b) : op === 'intersect' ? a.intersect(b) : a.subtract(b);
    if (r.isEmpty()) return { geometry: new THREE.BufferGeometry(), volume: 0, genus: 0, empty: true };
    return { geometry: fromManifold(r), volume: r.volume(), genus: r.genus() };
  } catch { return null; } finally { a?.delete(); b?.delete(); r?.delete(); }
}
