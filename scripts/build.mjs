// Build KERF into a single self-contained HTML file (+ the compressed CAD kernel next to it).
//   dist/index.html      full standalone page: open via any static web server
//   dist/artifact.html   the same app as a page fragment (for hosts that supply <html>/<head>)
//   dist/occt.wasm.gz    OpenCascade kernel, loaded on demand by the CAD workspace
//   dist/planegcs.wasm   FreeCAD's PlaneGCS constraint solver (LGPL), loaded when a sketch is solved
//   dist/manifold.wasm   Manifold mesh booleans (Apache-2.0) · dist/rhino3dm.wasm  Rhino .3dm reader (MIT) — both on demand
//   dist/fonts/*.ttf, dist/pdf.worker.min.mjs   PDF export fonts and the PDF.js worker, loaded on demand
//   dist/kerf-<version>-source.zip   the complete corresponding source (AGPL §13), offered from inside the app
//   dist/embed/*.b64.txt  base64 copies of the two binaries, for hosts that only serve text files
// Optional: KERF_SOURCE_URL=https://… npm run build  → the Pledge dialog also links to your public repository.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { build, transform, context } from 'esbuild';
const WASM_FILES = [['@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm', 'planegcs.wasm'], ['manifold-3d/manifold.wasm', 'manifold.wasm'], ['rhino3dm/rhino3dm.wasm', 'rhino3dm.wasm']];
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { gzipSync, deflateRawSync, crc32, constants } from 'node:zlib';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const SOURCE_URL = process.env.KERF_SOURCE_URL || '';
mkdirSync(dist, { recursive: true });

const FONTS = {
  __FONT_JOST__: '@fontsource-variable/jost/files/jost-latin-wght-normal.woff2',
  __FONT_JOST_I__: '@fontsource-variable/jost/files/jost-latin-wght-italic.woff2',
  __FONT_PLEX_400__: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2',
  __FONT_PLEX_400I__: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-italic.woff2',
  __FONT_PLEX_600__: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2',
  __FONT_PLEX_600I__: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-italic.woff2',
  __FONT_MONO_400__: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  __FONT_MONO_600__: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
};

async function css() {
  let text = readFileSync(join(root, 'src/styles.css'), 'utf8');
  for (const [k, mod] of Object.entries(FONTS)) {
    const b64 = readFileSync(require.resolve(mod)).toString('base64');
    text = text.replaceAll(k, `data:font/woff2;base64,${b64}`);
  }
  return (await transform(text, { loader: 'css', minify: true })).code;
}
async function js() {
  const r = await build({
    entryPoints: [join(root, 'src/main.js')], bundle: true, format: 'esm', platform: 'browser', target: ['es2022', 'chrome100', 'firefox110', 'safari16'],
    minify: true, write: false, legalComments: 'none', external: ['node:*'], logLevel: 'warning', metafile: true,
    alias: { paper: 'paper/dist/paper-core.js' }, // one paper.js instance, shared with paperjs-offset
    define: { 'process.env.NODE_ENV': '"production"', __KERF_VERSION__: JSON.stringify(VERSION), __KERF_SOURCE_URL__: JSON.stringify(SOURCE_URL) },
  });
  // every npm package that ended up in the bundle gets its licence text into the notices
  for (const f of Object.keys(r.metafile.inputs)) { const m = f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g); if (m) bundledPkgs.add(m.pop().replace(/^node_modules\/|\/$/g, '')); }
  return r.outputFiles[0].text.replaceAll('</script', '<\\/script');
}
// Third-party notices travel inside the built page (MIT/ISC/OFL require it; LGPL for the kernel too).
const bundledPkgs = new Set();
// shipped as separate files or fonts (not seen by the JS bundler)
const EXTRA_PKGS = ['flatbush', 'flatqueue', 'opentype.js', 'tiny-inflate', 'string.prototype.codepointat', 'replicad-opencascadejs', '@salusoft89/planegcs', 'manifold-3d', 'rhino3dm', 'pdfjs-dist', '@fontsource-variable/jost', '@fontsource/jost', '@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono'];
function notices() {
  const out = [`KERF ${VERSION} — Copyright (C) 2026 AKA IND Technologies Inc. (AI² Lab). Licensed AGPL-3.0-or-later.`,
    'This page bundles the following open-source components. Their licences and copyright notices follow.',
    'Engines shipped as separate, replaceable files next to this page: occt.wasm.gz (OpenCascade via replicad-opencascadejs, LGPL-2.1),',
    'planegcs.wasm (FreeCAD PlaneGCS, LGPL-2.1-or-later), manifold.wasm (Manifold, Apache-2.0), rhino3dm.wasm (rhino3dm, MIT),',
    'pdf.worker.min.mjs (PDF.js, Apache-2.0) and fonts/*.ttf (Jost, IBM Plex — SIL OFL 1.1, decompressed from the Fontsource WOFF2 files).', ''];
  const names = [...new Set([...[...bundledPkgs].sort(), ...EXTRA_PKGS])].filter(n => existsSync(join(root, 'node_modules', n, 'package.json')));
  for (const name of names) {
    const dir = join(root, 'node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
    const lic = readdirSync(dir).find(f => /^(licen[cs]e|copying)/i.test(f));
    out.push('='.repeat(72), `${pkg.name} ${pkg.version} — ${pkg.license || ''}`, pkg.homepage || '', '='.repeat(72), lic ? readFileSync(join(dir, lic), 'utf8').trim() : '(licence text not found in package)', '');
  }
  return out.join('\n');
}
const BANNER = `<!--
  KERF ${VERSION} — layout, vector, 3D and parametric CAD in one open tool.
  An AI² Lab project by AKA IND Technologies Inc. Licensed AGPL-3.0-or-later. Source: Pledge → Get the source${SOURCE_URL ? ' · ' + SOURCE_URL : ''}.
  No account. No subscription. No tracking. Bundled fonts (OFL-1.1) and libraries (MIT, ISC, LGPL-2.1 OpenCascade):
  full notices at the end of this file and under Pledge → Licences.
-->`;
// Start-up splash: the KERF block, then the maker's mark. main.js fades it once the workspaces are up.
const AKA_D = readFileSync(join(root, 'src/assets/aka-mark.svg'), 'utf8').match(/ d="([^"]+)"/)[1];
const SPLASH = `<div id="kerf-boot" role="status" aria-label="KERF is starting"><div class="mk"></div><div class="wd">KERF</div><div class="sp">KF-01 · v${VERSION} · open tools · no rent</div><div class="by"><span class="aka"><svg viewBox="0 0 500 276" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${AKA_D}"/></svg></span>AKA IND Technologies Inc. · AI² Lab</div></div>`;
async function once() {
  const [c, j] = await Promise.all([css(), js()]);
  const body = `<title>KERF</title>\n<meta name="description" content="Open-source layout, vector, 3D and parametric CAD. No account, no subscription, no tracking.">\n<style>${c}</style>\n<noscript><p style="padding:24px">KERF needs JavaScript. Nothing is sent anywhere; it runs entirely in this page.</p></noscript>\n${SPLASH}\n<script type="module">${j}</script>\n<script type="text/plain" id="kerf-notices">\n${notices().replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--')}\n</script>`;
  writeFileSync(join(dist, 'artifact.html'), BANNER + '\n' + body);
  writeFileSync(join(dist, 'index.html'), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${BANNER}\n${body}\n</head>\n<body></body>\n</html>\n`);
  const wasmSrc = require.resolve('replicad-opencascadejs/wasm');
  const gzOut = join(dist, 'occt.wasm.gz');
  if (!existsSync(gzOut)) writeFileSync(gzOut, gzipSync(readFileSync(wasmSrc), { level: constants.Z_BEST_COMPRESSION }));
  if (existsSync(join(dist, 'occt.wasm'))) rmSync(join(dist, 'occt.wasm')); // older builds shipped the raw kernel too
  await pdfFonts();
  copyFileSync(require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'), join(dist, 'pdf.worker.min.mjs')); // PDF.js worker, loaded on first PDF placement
  for (const [from, to] of WASM_FILES) copyFileSync(require.resolve(from), join(dist, to)); // on-demand engines (replaceable, as their licences ask)
  const src = sourceZip();
  // Text-only hosts (e.g. sandboxed page viewers) get base64 copies of the two binaries in dist/embed/.
  mkdirSync(join(dist, 'embed'), { recursive: true });
  for (const f of ['occt.wasm.gz', `kerf-${VERSION}-source.zip`, 'pdf.worker.min.mjs']) writeFileSync(join(dist, 'embed', f + '.b64.txt'), readFileSync(join(dist, f)).toString('base64'));
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log(`built dist/index.html ${kb(Buffer.byteLength(body))} · css ${kb(c.length)} · js ${kb(j.length)} · kernel ${kb(readFileSync(gzOut).length)} gz · source ${kb(src)}`);
}
// PDF export embeds real fonts. fontkit is most reliable on plain TrueType, so the bundled WOFF2 faces are decompressed
// once (Google's woff2 decoder via wawoff2) into dist/fonts/*.ttf, fetched by the app only when a PDF is exported.
const PDF_FONT_SETS = [['jost', '@fontsource/jost', [400, 500, 600, 700, 800]], ['ibm-plex-sans', '@fontsource/ibm-plex-sans', [400, 600]], ['ibm-plex-mono', '@fontsource/ibm-plex-mono', [400, 600]]];
async function pdfFonts() {
  const out = join(dist, 'fonts'); mkdirSync(out, { recursive: true });
  let wawoff2 = null;
  for (const [slug, pkg, weights] of PDF_FONT_SETS) for (const wt of weights) for (const style of ['normal', 'italic']) {
    const dest = join(out, `${slug}-${wt}-${style}.ttf`); if (existsSync(dest)) continue;
    wawoff2 ??= (await import('wawoff2')).default;
    const woff2 = readFileSync(join(root, 'node_modules', pkg, 'files', `${slug}-latin-${wt}-${style}.woff2`));
    writeFileSync(dest, Buffer.from(await wawoff2.decompress(woff2)));
  }
}
// The complete corresponding source, as a deterministic zip (deflate), rooted at kerf-<version>/.
const SOURCE_FILES = ['README.md', 'docs', 'LICENSE', 'NOTICE', 'PLEDGE.md', 'FORMAT.md', 'ROADMAP.md', 'CONTRIBUTING.md', 'FUNDING.md', 'package.json', 'package-lock.json', '.gitignore', 'src', 'scripts', 'desktop', 'android'];
function walk(p) { return statSync(p).isDirectory() ? readdirSync(p).sort().flatMap(n => walk(join(p, n))) : [p]; }
function sourceZip() {
  const files = SOURCE_FILES.map(f => join(root, f)).filter(existsSync).flatMap(walk).filter(f => !/(^|[\\/])(\.DS_Store|node_modules|__pycache__)([\\/]|$)/.test(f))
    .filter(f => !/(^|[\\/])(desktop[\\/](web|release)|android[\\/]out)([\\/]|$)|\.(jks|keystore|p12)$/.test(relative(root, f)));
  const parts = [], central = []; let offset = 0;
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed timestamp → reproducible archive
  for (const f of files) {
    const name = Buffer.from(`kerf-${VERSION}/` + relative(root, f).split(sep).join('/'));
    const raw = readFileSync(f), comp = deflateRawSync(raw, { level: 9 }), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, comp); central.push(ch, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...parts, cd, end]);
  writeFileSync(join(dist, `kerf-${VERSION}-source.zip`), zip);
  return zip.length;
}
await once();
if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let t; fsWatch(join(root, 'src'), { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => once().catch(e => console.error(e.message)), 120); });
  console.log('watching src/ …');
}
