// Shared three.js viewport: PBR lighting, shadow-catching floor, orbit, view presets, on-demand rendering, snapshots.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const css = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

export function createViewport(host, { gridSize = 400, gridDiv = 40 } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
  catch (e) { const msg = document.createElement('div'); msg.className = 'canvas-banner'; msg.innerHTML = '<span class="badge bad"><span class="led"></span>WebGL is unavailable in this browser</span>'; host.append(msg); return null; }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
  camera.position.set(160, 120, 180);
  const controls = new OrbitControls(camera, renderer.domElement);
  // Inertial glide off for people who ask the OS for reduced motion.
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.enableDamping = !reduceMotion; controls.dampingFactor = 0.12; controls.screenSpacePanning = true;

  const hemi = new THREE.HemisphereLight(0xfff6e8, 0x3a3328, 0.55); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(200, 320, 160); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.6;
  const sc = key.shadow.camera; sc.left = -300; sc.right = 300; sc.top = 300; sc.bottom = -300; sc.near = 10; sc.far = 1200;
  scene.add(key); scene.add(key.target);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.22 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = -0.01; scene.add(floor);
  let grid = makeGrid(gridSize, gridDiv); scene.add(grid);

  const root = new THREE.Group(); scene.add(root);
  const overlay = new THREE.Group(); scene.add(overlay);

  let needs = true, raf = 0, disposed = false;
  const requestRender = () => { needs = true; if (!raf) raf = requestAnimationFrame(loop); };
  function loop() {
    raf = 0; if (disposed) return;
    const moving = controls.update();
    if (needs || moving) { renderer.render(scene, camera); needs = false; }
    if (moving) raf = requestAnimationFrame(loop);
  }
  controls.addEventListener('change', requestRender);
  function applyTheme() {
    scene.background = new THREE.Color(css('--concrete', '#dcd5c8'));
    scene.remove(grid); grid.geometry.dispose(); grid = makeGrid(gridSize, gridDiv); scene.add(grid);
    requestRender();
  }
  function resize() {
    const r = host.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
    renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); requestRender();
  }
  const ro = new ResizeObserver(resize); ro.observe(host);
  applyTheme();

  function bounds(obj = root) { const b = new THREE.Box3(); obj.updateWorldMatrix(true, true); b.setFromObject(obj, true); return b; }
  function frame(b = bounds(), dir) {
    if (b.isEmpty()) b = new THREE.Box3(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 50, 50));
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()).length() || 100;
    const d = dir ? dir.clone().normalize() : camera.position.clone().sub(controls.target).normalize();
    const dist = (s / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.15;
    camera.position.copy(c).addScaledVector(d, dist); controls.target.copy(c);
    camera.near = Math.max(0.1, dist / 200); camera.far = dist * 50; camera.updateProjectionMatrix();
    controls.update(); fitShadow(b); requestRender();
  }
  function fitShadow(b) {
    const s = Math.max(60, b.getSize(new THREE.Vector3()).length());
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s; sc.updateProjectionMatrix();
    const c = b.getCenter(new THREE.Vector3()); key.target.position.copy(c); key.position.copy(c).add(new THREE.Vector3(s * 0.7, s * 1.3, s * 0.55)); sc.far = s * 4;
    floor.position.y = Math.min(0, b.min.y) - 0.01;
  }
  const VIEWS = { iso: [1, 0.75, 1], front: [0, 0, 1], top: [0, 1, 0.0001], right: [1, 0, 0], back: [0, 0, -1], left: [-1, 0, 0], hero: [1.25, 0.32, 0.95] };
  function setView(name) { const v = VIEWS[name] || VIEWS.iso; frame(bounds(), new THREE.Vector3(...v)); }
  /** Render an offscreen PNG (transparent background, no grid) at w×h from a named angle, or the current camera. */
  function snapshot({ w = 1200, h = 800, angle } = {}) {
    const size = renderer.getSize(new THREE.Vector2()); const pr = renderer.getPixelRatio();
    const saved = { pos: camera.position.clone(), tgt: controls.target.clone(), aspect: camera.aspect, bg: scene.background, near: camera.near, far: camera.far };
    grid.visible = false; overlay.visible = false; scene.background = null;
    renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (angle) { const b = bounds(); const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()).length() || 100; const d = new THREE.Vector3(...(VIEWS[angle] || VIEWS.iso)).normalize(); const fov = camera.fov * Math.PI / 180; const fit = (s / 2) / Math.tan(fov / 2) * (w < h ? h / w : 1) * 1.08; camera.position.copy(c).addScaledVector(d, fit); camera.lookAt(c); camera.near = fit / 100; camera.far = fit * 20; camera.updateProjectionMatrix(); fitShadow(b); }
    renderer.setClearColor(0x000000, 0); renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    grid.visible = true; overlay.visible = true; scene.background = saved.bg;
    camera.position.copy(saved.pos); controls.target.copy(saved.tgt); camera.aspect = saved.aspect; camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix();
    renderer.setPixelRatio(pr); renderer.setSize(size.x, size.y, false); controls.update(); requestRender();
    return url;
  }
  function dispose() { disposed = true; ro.disconnect(); renderer.dispose(); }
  return { THREE, renderer, scene, camera, controls, root, overlay, grid: () => grid, floor, requestRender, frame, setView, snapshot, bounds, applyTheme, resize, dispose, VIEWS };
}
function makeGrid(size, div) {
  const ink = new THREE.Color(css('--ink', '#1c1a17')), bg = new THREE.Color(css('--concrete', '#dcd5c8'));
  const major = ink.clone().lerp(bg, 0.55), minor = ink.clone().lerp(bg, 0.82);
  const g = new THREE.GridHelper(size, div, major, minor); g.material.transparent = true; g.material.opacity = 0.9; g.material.depthWrite = false;
  return g;
}
/** Procedural wood grain texture (birch / walnut) — Eames molded-ply look without image downloads. */
const woodCache = new Map();
export function woodTexture(kind = 'birch', repeat = 1) {
  const ck = kind + ':' + repeat; if (woodCache.has(ck)) return woodCache.get(ck);
  if (woodCache.has(kind + ':base')) { const t = woodCache.get(kind + ':base').clone(); t.needsUpdate = true; t.repeat.set(repeat, repeat); woodCache.set(ck, t); return t; }
  const c = document.createElement('canvas'); c.width = 512; c.height = 512; const x = c.getContext('2d');
  const base = kind === 'walnut' ? [92, 58, 34] : [222, 196, 152], dark = kind === 'walnut' ? [52, 31, 18] : [176, 140, 92];
  x.fillStyle = `rgb(${base})`; x.fillRect(0, 0, 512, 512);
  let seed = kind === 'walnut' ? 7 : 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 140; i++) {
    const y0 = rnd() * 512, amp = 2 + rnd() * 9, f = 0.004 + rnd() * 0.01, wdt = 0.6 + rnd() * 2.6, a = 0.08 + rnd() * 0.22;
    x.strokeStyle = `rgba(${dark},${a})`; x.lineWidth = wdt; x.beginPath();
    for (let px = 0; px <= 512; px += 4) { const y = y0 + Math.sin(px * f + i) * amp + Math.sin(px * f * 3.1) * amp * 0.3; px ? x.lineTo(px, y) : x.moveTo(px, y); }
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; woodCache.set(kind + ':base', t);
  const t2 = t.clone(); t2.needsUpdate = true; t2.repeat.set(repeat, repeat); woodCache.set(ck, t2); return t2;
}
/** Box-projected UVs (world units × scale) so wood grain reads on any face of a generated solid. */
export function boxUV(g, scale = 1) {
  const p = g.attributes.position; if (!p) return g; if (!g.attributes.normal) g.computeVertexNormals(); const n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v; if (az >= ax && az >= ay) { u = p.getX(i); v = p.getY(i); } else if (ay >= ax) { u = p.getX(i); v = p.getZ(i); } else { u = p.getZ(i); v = p.getY(i); }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return g;
}
export { THREE };
