// Path-traced renders with three-gpu-pathtracer (MIT, Garrett Johnson). Physically based light transport:
// soft shadows, inter-reflection, glossy metals and glass, converging progressively on the GPU.
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';
import { h, toast, segmented } from './ui.js';
import { saveFile, safeName, dataURLToBytes } from './io.js';

const STUDIOS = {
  ivory: { label: 'Ivory studio', top: '#fbf8f2', bottom: '#7a7264', floor: '#efe9dd', exp: 1.6 },
  daylight: { label: 'Daylight', top: '#d9e6f2', bottom: '#8b8170', floor: '#e2dccf', exp: 1.2 },
  void: { label: 'Void', top: '#3a362f', bottom: '#0d0c0a', floor: '#1c1a17', exp: 2.2 },
};

/** Open the renderer for a viewport created by createViewport(). */
export function openPathTracer({ vp, name = 'render' }) {
  let gl;
  try { gl = document.createElement('canvas').getContext('webgl2'); } catch { gl = null; }
  if (!gl) { toast('Ray-traced rendering needs WebGL 2, which this browser or device does not offer', 'bad'); return; }
  const src = vp.renderer.domElement.getBoundingClientRect();
  const aspect = src.width && src.height ? src.width / src.height : 1.5;
  let target = 256, studio = 'ivory', raf = 0, stopped = false, t0 = performance.now();
  const coarse = matchMedia?.('(pointer: coarse)').matches; let width = coarse ? 480 : 1200; // phones and tablets start lighter

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; renderer.outputColorSpace = THREE.SRGBColorSpace;
  let W = width, H = Math.round(W / aspect);
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  const canvas = renderer.domElement; canvas.className = 'pt-canvas';

  // scene: the model, a seamless floor and a gradient sky that lights everything
  const scene = new THREE.Scene();
  const content = vp.root.clone(true); scene.add(content);
  content.traverse((n) => { if (n.isLineSegments || n.isLine || n.isPoints || n.isSprite) n.visible = false; }); // drawing edges are for the modelling view
  const box = new THREE.Box3().setFromObject(content); const size = box.getSize(new THREE.Vector3()); const span = Math.max(size.x, size.y, size.z, 10);
  const floorMat = new THREE.MeshStandardMaterial({ color: STUDIOS.ivory.floor, roughness: 0.9, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(span * 30, 96), floorMat); floor.rotation.x = -Math.PI / 2; floor.position.y = Math.min(0, box.min.y) - 0.01; scene.add(floor);
  const env = new GradientEquirectTexture(256); scene.environment = env; scene.background = env;
  const key = new THREE.DirectionalLight(0xfff4e6, 1.6); key.position.set(span * 2, span * 3.2, span * 1.6); scene.add(key);
  const camera = vp.camera.clone(); camera.aspect = aspect; camera.updateProjectionMatrix();

  const pt = new WebGLPathTracer(renderer);
  pt.bounces = 6; pt.minSamples = 1; pt.renderDelay = 0; pt.fadeDuration = 0; pt.filterGlossyFactor = 0.5;
  const setTiles = () => { const t = W > 1400 ? 3 : 2; pt.tiles.set(t, t); }; setTiles(); // small GPU slices keep the page responsive

  function applyStudio() {
    const s = STUDIOS[studio]; env.topColor.set(s.top); env.bottomColor.set(s.bottom); env.exponent = s.exp; env.update();
    floorMat.color.set(s.floor);
    pt.setScene(scene, camera); t0 = performance.now(); stopped = false; loop();
  }

  // ---------- UI ----------
  const counter = h('span', { class: 'pt-count' }); const bar = h('i'); const meter = h('div', { class: 'pt-meter' }, bar);
  const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save PNG');
  const stopBtn = h('button', { class: 'btn', type: 'button', onclick: () => { stopped = !stopped; stopBtn.textContent = stopped ? 'Resume' : 'Pause'; if (!stopped) loop(); } }, 'Pause');
  const root = h('div', { class: 'backdrop pt-backdrop' }, h('div', { class: 'dialog wide pt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ray-traced render' },
    h('header', null, h('h2', null, 'Ray-traced render'), h('button', { class: 'btn icon ghost x', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'body' },
      h('div', { class: 'pt-frame' }, canvas),
      h('div', { class: 'pt-controls' },
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Light'), segmented({ value: studio, options: Object.entries(STUDIOS).map(([k, s]) => ({ value: k, label: s.label })), onChange: (v) => { studio = v; applyStudio(); } })),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Size'), segmented({ value: width, options: [[480, 'Preview 480'], [1200, '1200'], [2000, 'Print 2000']].map(([v, l]) => ({ value: v, label: l })), onChange: (v) => { width = v; W = v; H = Math.round(W / aspect); renderer.setSize(W, H, false); setTiles(); pt.updateCamera?.(); applyStudio(); } })),
        h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Samples'), segmented({ value: target, options: [64, 256, 1024].map(v => ({ value: v, label: String(v) })), onChange: (v) => { target = v; if (pt.samples < target) { stopped = false; loop(); } } })),
        h('div', { class: 'pt-progress' }, meter, counter),
        h('p', { class: 'hint' }, 'Unbiased path tracing on your GPU: every pass adds light bounces until the noise settles. Nothing leaves this device.'))),
    h('footer', null, stopBtn, saveBtn)));
  document.body.append(root);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (stopped) return;
      try { pt.renderSample(); } catch (e) { console.error(e); toast('The GPU stopped the render: ' + (e.message || e), 'bad'); stopped = true; return; }
      const n = Math.floor(pt.samples); const secs = (performance.now() - t0) / 1000;
      counter.textContent = `${Math.min(n, target)} / ${target} samples · ${W}×${H} px · ${secs.toFixed(1)} s`; bar.style.width = `${Math.min(100, (n / target) * 100)}%`;
      if (n >= target) { stopBtn.textContent = 'Done'; stopBtn.disabled = true; return; }
      stopBtn.disabled = false; raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  async function save() { const url = canvas.toDataURL('image/png'); await saveFile(`${safeName(name, 'render')}-raytraced.png`, new Blob([dataURLToBytes(url)], { type: 'image/png' }), 'image/png'); }
  function close() { stopped = true; cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true); root.remove(); try { pt.dispose(); } catch { /* already gone */ } env.dispose(); floor.geometry.dispose(); floorMat.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); }
  applyStudio();
  return { close, get samples() { return pt.samples; } };
}
