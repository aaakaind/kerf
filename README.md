# KERF

**Open-source layout, vector, 3D and parametric CAD in one app — on the web, Windows, Linux and Android.**
No account. No subscription. No tracking. Your files stay yours.

`KF-01 · v0.2.0 · AGPL-3.0-or-later · an AI² Lab project by AKA IND Technologies Inc.`

A kerf is the slot a saw leaves behind: the material taken away so a flat sheet can bend.
KERF takes away what makes pro design software painful to own: the rent, the lock-in and the
cancellation traps. It keeps the tools.

---

## What is in v0.2

Four workspaces share one document. A change in one shows up in the others.
v0.2 pulls in proven open-source engines wherever one exists under a licence KERF can ship
(see [Engines](#engines-kerf-stands-on)), instead of re-inventing them.

| Workspace | Class of tool | What works today |
|---|---|---|
| **Layout** | page layout (InDesign-class) | Facing pages, masters, bleed and margins, threaded multi-column text frames, paragraph styles, inline markup (`#`, `##`, `>`, `^`, `**bold**`, `*italic*`, `[style]`), live page numbers, autoflow, **TeX hyphenation**, image frames with effective-PPI readout, **place PDF pages** (rendered by PDF.js at 150–600 PPI), CSV data merge, preflight, vector PDF export with **embedded, subset fonts** (real kerning, searchable text), TrimBox/BleedBox and crop marks, HTML export |
| **Vector** | illustration (Illustrator-class) | Artboards, Bézier pen and direct selection, pencil with curve fitting, shapes, text, curve-accurate booleans (unite, subtract, intersect, exclude), **offset path, outline stroke**, **image trace** (bitmap → vector, 2–16 colours), smart guides, align and distribute, linear gradients, radial and grid repeat, layers, SVG import and paste, **DXF import and export** for laser cutters and CNC (true scale, layer per colour, exact splines), SVG / PNG @2x / PDF export |
| **Mesh** | 3D modelling and rendering | Primitives, non-destructive booleans on **Manifold** (exact and watertight, BVH-CSG fallback), live extrude and lathe from vector paths, arrays, PBR materials including procedural wood, shadows, studio lighting, transform gizmo, GLB / STL / OBJ / **Rhino .3dm** import, GLB / STL / OBJ export, PNG snapshots and **path-traced renders** on the GPU |
| **CAD** | parametric solid modelling (Onshape-class) | **Constraint sketcher on FreeCAD's PlaneGCS solver** (lines, rectangles, circles, arcs; coincident, horizontal, vertical, parallel, perpendicular, equal, tangent, midpoint, point-on, fix; distance, horizontal/vertical distance, radius, diameter and angle dimensions driven by `#variables`; live degrees-of-freedom readout), variables and expressions with units (`#w/2 + 3 mm`), configurations, feature tree with rollback bar, extrude, revolve, hole with counterbore, fillet, chamfer, shell, linear and circular pattern, mirror, primitive solids, **STEP import**, OpenCascade B-rep kernel, mass properties by material, section view, measure, STEP and STL export, 2D drawings with hidden lines and dimensions, path-traced renders |

**Links between workspaces**
- Vector path → live 3D extrusion or lathe (edit the path, the solid follows)
- Vector path → CAD profile
- CAD part → Mesh scene
- CAD drawing, CAD render, Mesh render and Vector artboards → Layout frames, refreshed with **Update links**

Open the app and the sample document, *Field Notes No. 1*, shows all of this in four pages:
a cover mark drawn in Vector, an article that threads across two pages, a bracket modelled
in CAD and rendered onto page 3, and its front-view drawing on page 4. Change `#w` in CAD,
press **Update links** in Layout, export the PDF.

## Honest status

v0.2 is a working foundation. It does **not** yet match InDesign, Illustrator, a 3D suite or
Onshape feature for feature. Here is what is missing, so nobody has to find out the hard way.

| Area | Not yet |
|---|---|
| Layout | Own justification engine (line breaking is the browser's; hyphenation is KERF's), OpenType feature controls, character styles, tables, footnotes, text wrap, CMYK and spot colour, PDF/X, EPUB, IDML import |
| Vector | Brushes, variable-width strokes, mesh and radial gradients, symbols, blends, text on a path, live effects, AI/EPS import |
| Mesh | Polygon editing and sculpting, UV editing, subdivision modelling, animation. Rhino Breps only appear if the file carries render meshes (Rhino's default; not with *Save small*) |
| CAD | Sketches on faces (sketches sit on the XY, XZ and YZ planes with an offset), splines and fillets inside the sketcher, assemblies and mates, sweep and loft, sheet metal, IGES import, drawings with section and detail views, real-time multi-user editing, version branching |
| Platform | Collaboration and comments, plug-in API, code-signed installers (see [Native apps](#native-apps)), iOS, automated test suite beyond the smoke test |

[ROADMAP.md](ROADMAP.md) puts these in order.

## Run it

You need Node.js 20 or newer (22 recommended).

```sh
npm install
npm run build
npm run serve          # http://localhost:5173
```

`npm run dev` rebuilds on every change in `src/`.

The build writes these files to `dist/`:

| File | What it is |
|---|---|
| `index.html` | The whole app in one file: code, styles and typefaces |
| `artifact.html` | The same app as a page fragment, for hosts that supply their own `<html>` and `<head>` |
| `occt.wasm.gz` | The OpenCascade CAD kernel, fetched only when the CAD workspace needs it |
| `planegcs.wasm` | FreeCAD's PlaneGCS constraint solver, fetched when a sketch is solved |
| `manifold.wasm` | Manifold mesh booleans, fetched on the first boolean |
| `rhino3dm.wasm` | The Rhino .3dm reader, fetched on the first .3dm import |
| `pdf.worker.min.mjs` | PDF.js, fetched when you place a PDF page in Layout |
| `fonts/*.ttf` | The typefaces, as TrueType, embedded (subset) into exported PDFs |
| `kerf-<version>-source.zip` | The complete source, offered from inside the app (Pledge → Get the source) |
| `embed/*.b64.txt` | Base64 copies of the kernel and source archive, for hosts that only serve text files. KERF falls back to them automatically |

**Deploy** by copying `dist/` to any static host. To link your public repository from the app,
build with `KERF_SOURCE_URL=https://github.com/you/kerf npm run build` (official releases use `https://github.com/aaakaind/kerf`).

Opening `dist/index.html` straight from disk works, but browsers block fetching the kernel over
`file://`, so CAD falls back to the fast mesh kernel (no fillets, chamfers, shells or STEP). Use
`npm run serve` or any static server.

**Test** with `npm test`. It builds, opens the app in headless Chromium and drives every
workspace: PDF, SVG, STEP, STL and GLB exports, a vector boolean, a CAD variable change and a
configuration switch, and a phone-width layout check. It needs Python 3 and Playwright
(`pip install playwright && playwright install chromium`).

## Native apps

The same app ships as installable programs. They contain the whole web build, need no network
and have no updater, account or telemetry. Your files open and save through the system dialogs.

**Download:** [github.com/aaakaind/kerf/releases](https://github.com/aaakaind/kerf/releases) — every
file is listed with its SHA-256 checksum in `SHA256SUMS.txt`.

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `KERF-0.2.0-win-x64.exe` | Installer: per-user, no admin rights, choose the folder, uninstall from Settings |
| | `KERF-0.2.0-portable.exe` | Runs without installing — handy on a USB stick |
| | `KERF-0.2.0-win-x64.zip` | Unzip and run `KERF.exe` |
| Linux (x64) | `KERF-0.2.0-linux-x86_64.AppImage` | `chmod +x` and run; works on most distributions |
| | `KERF-0.2.0-linux-amd64.deb` | `sudo apt install ./KERF-0.2.0-linux-amd64.deb` on Debian, Ubuntu, Mint, Pop!_OS |
| Android 8+ | `KERF-0.2.0-android.apk` | Sideload: allow “Install unknown apps” for your browser or file manager, then open the APK |

**Not code-signed yet.** Windows SmartScreen will say “Windows protected your PC” — choose
*More info → Run anyway*. That warning is about the missing paid certificate, not the code: every
byte is built from this repository. Signing comes when the project buys a certificate; it will
never be a reason to charge for KERF.

Build them yourself:

```sh
npm run build                       # the web app, into dist/
cd desktop && npm install
npm run dist:linux                  # AppImage + .deb   (Linux host)
npm run dist:win                    # installer, portable .exe, .zip (Windows host, or Linux with Wine)
```

```sh
# Android, without Gradle — needs a JDK 17+, Android build-tools 36 and platform 36
ANDROID_BUILD_TOOLS=… ANDROID_JAR=…/android.jar KERF_KEYSTORE=… KERF_KS_PASS=… ./android/build.sh
```

The desktop shell (`desktop/main.js`, ~80 lines) serves the app from inside the package over a
private `app://` scheme and opens outside links in your browser. The Android shell
(`android/src/…/MainActivity.java`) serves the bundled files on a virtual https origin, refuses
every other request, and routes saving to the system *Save to…* picker. Keep your Android
release keystore out of the repository: every update must be signed with the same key.

## Using it

- **Ctrl/Cmd + K** opens the command palette. Every action in the app is in there.
- **Alt + 1…4** switches workspace. **Ctrl/Cmd + S** saves a `.kerf` file, **Ctrl/Cmd + O** opens one.
- Work is autosaved in your browser. The `.kerf` file is the portable copy: plain JSON,
  documented in [FORMAT.md](FORMAT.md).
- File → Keyboard shortcuts lists the rest.

## How it is built

```
src/
  main.js              shell: bar, tabs, panels, file menu, palette, pledge
  styles.css           the design tokens and every component style
  core/
    store.js           one JSON document, undo/redo, autosave (IndexedDB)
    ui.js              DOM helpers, fields, dialogs, menus, command palette, icons
    geom.js            Bézier paths, matrices, hit testing, SVG path parsing
    expr.js            unit-aware expression evaluator (mm, cm, m, in, ft, pt, deg)
    pdf.js             PDF writer: vector paths, embedded subset fonts, images with alpha, bleed, marks
    vtools.js          image trace, DXF in and out
    manifold.js        exact mesh booleans (Manifold, on demand)
    rhino.js           Rhino .3dm import (rhino3dm, on demand)
    pathtrace.js       path-traced render dialog (three-gpu-pathtracer)
    brand.js           the AKA IND maker's mark
    io.js              file saving (browser download or the host's save prompt)
    viewport3d.js      three.js viewport shared by Mesh and CAD
    shapes.js          path → polygon loops, hole nesting, polygon fillets
    fonts.js           built-in and user-added typefaces
    sample.js          the Field Notes sample document
  ws/
    layout.js          pages, frames, text flow, threading, styles, merge, preflight, PDF
    vector.js          artboards, tools, booleans, guides, repeat, SVG
    mesh.js            scene, primitives, booleans, extrude/lathe, materials, import/export
    cad/
      cad.js           feature tree UI, variables, configurations, kernels, outputs
      profiles.js      profile and feature definitions, expression evaluation
      kernel-mesh.js   fast kernel: CSG on triangle meshes (always available)
      kernel-occt.js   precise kernel: OpenCascade B-rep via replicad, STEP in and out
      sketch-core.js   sketch model, PlaneGCS solving, loops for both kernels
      sketch-editor.js the full-screen constraint sketcher
desktop/               Electron shell + electron-builder config for Windows and Linux
android/               WebView shell, resources and a Gradle-free build script
scripts/
  build.mjs            single-file bundle, fonts inlined, notices, source archive
  serve.mjs            dependency-free static server
  smoke_test.py        headless browser test
```

The app is plain JavaScript modules bundled by esbuild. There is no framework and no server.

### Engines KERF stands on

Taken from other projects because their licences allow it, and credited in [NOTICE](NOTICE)
and inside the app (Pledge → Licences):

| Engine | From | Licence | Does |
|---|---|---|---|
| [OpenCascade](https://dev.opencascade.org) via [replicad](https://replicad.xyz) | FreeCAD, KiCad and others use it | LGPL-2.1 / MIT | B-rep solids, fillets, shells, STEP in and out, drawings |
| [PlaneGCS](https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/Sketcher/App/planegcs) via [@salusoft89/planegcs](https://github.com/Salusoft89/planegcs) | FreeCAD's sketcher | LGPL-2.1+ | geometric constraint solving |
| [Manifold](https://github.com/elalish/manifold) | used by OpenSCAD and Blender | Apache-2.0 | exact, watertight mesh booleans |
| [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | | MIT | physically based path tracing |
| [rhino3dm](https://github.com/mcneel/rhino3dm) | McNeel (Rhino) | MIT | reading .3dm files |
| [PDF.js](https://mozilla.github.io/pdf.js/) | Mozilla Firefox | Apache-2.0 | rendering placed PDF pages |
| [fontkit](https://github.com/foliojs/fontkit) | | MIT | font shaping, kerning and subsetting for PDF |
| [hyphen](https://github.com/ytiurin/hyphen) (TeX patterns) | Knuth–Liang | ISC | hyphenation |
| [paper.js](http://paperjs.org) + [paperjs-offset](https://github.com/glenzli/paperjs-offset) | | MIT | vector booleans, offset and outline stroke |
| [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) | | Unlicense | bitmap tracing |
| [dxf-parser](https://github.com/gdsestimating/dxf-parser), [@tarikjabiri/dxf](https://github.com/dxfjs/writer) | | MIT | DXF read and write |
| [three.js](https://threejs.org), [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | | MIT | 3D viewport, BVH booleans |
| [Electron](https://www.electronjs.org) | | MIT | the desktop window (desktop builds only) |

Nothing proprietary, and nothing under a licence that would stop you from using, changing or
sharing KERF. GPL-2.0-only code is avoided because it cannot be combined with the AGPL-3.0.

## Licence

KERF is free software under the **GNU Affero General Public License v3.0 or later**
([LICENSE](LICENSE)). Copyright © 2026 AKA IND Technologies Inc. (AI² Lab).

In plain terms: use it for anything, including commercial work. Study it, change it, share it.
If you run a modified KERF for other people over a network, you must offer them your source
too. That is what stops anyone from taking KERF, closing it and renting it back.

**What you make with KERF is yours.** The licence covers the software, not your documents,
drawings, models or exports.

## The Pledge

No account. No subscription, stored card or auto-renewal. No tracking. Open file format.
The full text is in [PLEDGE.md](PLEDGE.md) and inside the app.

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md). If KERF saves you money and you want to give some back,
[FUNDING.md](FUNDING.md) explains how it works: one-time, optional, no perks withheld.
