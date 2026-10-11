# The .kerf file format

`FORMAT_VERSION 1` · plain JSON · UTF-8

A `.kerf` file is one JSON object that holds all four workspaces. There is no binary
container and no proprietary encoding: any language with a JSON parser can read and write it.
Embedded images and fonts are stored as `data:` URLs inside `assets`.

This document describes version 1. KERF reads older versions and fills missing parts with
defaults (`migrate()` in `src/core/store.js`). Unknown keys are preserved on load and save, so
other tools can add their own data under a namespaced key such as `"x-yourtool": {…}`.

## Conventions

| Thing | Unit / form |
|---|---|
| Layout coordinates | PostScript points (1 pt = 1/72 in = 0.3528 mm), origin top-left of the page, y down |
| Vector coordinates | pixels at 1:1 zoom (1 px = 1 pt on PDF export), one infinite canvas, y down |
| Mesh coordinates | scene units (treated as millimetres on STL/OBJ export), y up |
| CAD values | **strings** holding expressions, e.g. `"60 mm"`, `"#w/2 + 3 mm"`, `"30 deg"`. Lengths resolve to millimetres, angles to degrees |
| Colours | `#rrggbb` strings; `null` means none |
| Ids | short strings, unique within the document (`ab-…`, `v-…`, `pg-…`, `f-…`, `m-…`, `cf-…`) |
| Matrices | `[a, b, c, d, e, f]` as in SVG `matrix()` |

## Top level

```json
{
  "kerf": 1,
  "name": "Field Notes No. 1",
  "created": "2026-10-04T15:00:00.000Z",
  "modified": "2026-10-04T15:30:00.000Z",
  "assets": { "as-1a2b": { "kind": "image", "name": "photo.jpg", "mime": "image/jpeg", "data": "data:image/jpeg;base64,…", "w": 2400, "h": 1600 } },
  "vector": { … },
  "layout": { … },
  "mesh": { … },
  "cad": { … }
}
```

`assets` maps an id to an object with `kind`, `name` and `data`. Items refer to assets by id.

| kind | Fields |
|---|---|
| `image` | `mime`, `data` (data URL), `w`, `h` (pixels) |
| `svg` | `data` (the SVG markup as text) |
| `font` | `family`, `data` (data URL of the font file) |
| `model` | `format` (`stl`, `glb`, `obj`), `data` (data URL) |

## vector

```json
{
  "artboards": [{ "id": "ab-mark", "name": "Mark", "x": 0, "y": 0, "w": 480, "h": 480, "bg": "#f3eee4" }],
  "items": [ … ]
}
```

Items are drawn in array order (first is at the back). Common fields: `id`, `type`, `name`,
`hidden`, `locked`, `opacity` (0–1), `blend` (CSS blend mode).

**path**
```json
{ "id": "v-1", "type": "path", "name": "Kerf block",
  "fill": "#1c1a17", "stroke": null, "sw": 0, "cap": "butt", "join": "miter", "dash": null, "rule": "nonzero",
  "subpaths": [{ "closed": true, "pts": [{ "x": 90, "y": 90, "ix": 90, "iy": 90, "ox": 90, "oy": 90 }, …] }] }
```
Each point is an anchor (`x`, `y`) with absolute in-handle (`ix`, `iy`) and out-handle
(`ox`, `oy`). A handle equal to its anchor means a straight segment on that side. Transforms
are baked into the points. `fill` may also be a linear gradient:
`{ "type": "linear", "angle": 90, "stops": [{ "o": 0, "c": "#e3a72f" }, { "o": 1, "c": "#c8432b" }] }`.

**text**
```json
{ "id": "v-2", "type": "text", "x": 90, "y": 64, "text": "KERF", "font": "Jost", "size": 40, "weight": 700,
  "italic": false, "ls": 0.04, "align": "start", "fill": "#1c1a17", "stroke": null, "sw": 0, "m": null }
```
`x`, `y` is the baseline origin; `align` is `start`, `middle` or `end`; `ls` is letter spacing
as a fraction of the font size; `m` is an optional transform matrix.

**image**: `{ "type": "image", "asset": "as-…", "x", "y", "w", "h", "m" }`.

## layout

```json
{
  "unit": "mm",
  "page": { "w": 419.53, "h": 595.28, "margins": { "t": 42.52, "b": 51.02, "i": 42.52, "o": 42.52 }, "cols": 2, "gutter": 14.17, "bleed": 8.5 },
  "facing": true,
  "styles": { "body": { … }, "h1": { … } },
  "stories": { "st-article": { "text": "## Kerf bending\nA flat sheet…", "frames": ["f-art-1", "f-art-2"] } },
  "masters": [{ "id": "A", "name": "A-Master", "items": [ … ] }],
  "pages": [{ "id": "pg-1", "master": "A", "items": [ … ] }]
}
```

`unit` is only the display unit; stored values are always points. Margins are top, bottom,
inside and outside. `facing: true` mirrors inside/outside on left-hand pages.

**Paragraph styles** (keyed by id):
`{ name, font, size, leading, weight, italic, color, align, before, after, indent, tracking, hyphenate, upper }`
with sizes in points, `tracking` in em, and `align` one of `left`, `center`, `right`, `justify`.

**Stories** hold text and the ordered list of frames it flows through. Story markup, one
paragraph per line:

| Markup | Meaning |
|---|---|
| `# ` / `## ` | styles `h1` / `h2` |
| `> ` | style `quote` |
| `^ ` | style `caption` |
| `[styleId] ` | any paragraph style |
| `**bold**`, `*italic*` | inline emphasis |
| `{page}`, `{pages}` | current page number, page count |
| `{{field}}` | data-merge field, filled from a CSV column |

**Page items**. Common fields: `id`, `type`, `x`, `y`, `w`, `h` (points, page-relative),
`locked`.

| type | Extra fields |
|---|---|
| `text` | `story`, `cols`, `gutter`, `inset`, `valign` (`top`, `center`, `bottom`) |
| `image` | `asset`, `fit` (`fill` crops to the frame, `fit` shows it all, `stretch`), `fx`, `fy` (focal point, 0–1) |
| `rect`, `ellipse` | `fill`, `stroke`, `sw` |
| `line` | `stroke`, `sw` |
| `vector` | `src: { ab: artboardId, bg: bool }`, `fit`. Live: redrawn from the Vector artboard |
| `view` | `src: { ws: "cad" \| "mesh", angle }` (`iso`, `front`, `top`, `right`, `hero`), `fit`, `fill`, `snap` (asset id of a cached PNG), `snapFast` |
| `drawing` | `src: { ws: "cad", angle }` (`front`, `top`, `right`, `back`, `left`, `bottom`), `fit`, `stroke`, `sw`, `snap` (asset id of a cached SVG), `snapFast` |

`view` and `drawing` frames keep a snapshot so the page renders without recomputing the
model. **Update links** in Layout refreshes them. `snapFast: true` marks a snapshot made by the
fast kernel; KERF replaces it once the precise kernel has loaded.

## mesh

```json
{ "objects": [ … ], "bg": null, "grid": true }
```

Every object: `id`, `name`, `kind`, `params`, `pos [x,y,z]`, `rot [x,y,z]` (degrees),
`scl [x,y,z]`, `mat`, `hidden`, and optionally `array`:
`{ type: "linear", count, offset: [x,y,z] }` or `{ type: "radial", count, angle }`.

| kind | params |
|---|---|
| `box` | `w`, `h`, `d`, `r` (plan corner radius) |
| `sphere` | `r`, `seg` |
| `cylinder` | `rt`, `rb`, `h`, `seg` |
| `cone` | `r`, `h`, `seg` |
| `torus` | `r`, `tube`, `seg` |
| `capsule` | `r`, `len` |
| `ico` | `r`, `detail` |
| `knot` | `r`, `tube`, `p`, `q` |
| `plane` | `w`, `d` |
| `extrude` | `link` (vector item id), `subpaths` (cached copy), `size`, `depth`, `bevel` |
| `lathe` | `link`, `subpaths`, `size`, `angle`, `inner`, `seg` |
| `bool` | no params; `op` (`union`, `subtract`, `intersect`) and two child objects `a`, `b` |
| `import` | `asset` (a `model` asset: STL, GLB or OBJ) |

`mat` is `{ preset }` (`ochre`, `red`, `blue`, `olive`, `ivory`, `ink`, `birch`, `walnut`,
`alu`, `steel`, `chrome`, `concrete`, `glass`) optionally overridden by `color`, `metal`
(0–1), `rough` (0–1), `opacity`, `wood`, `flat`, `wire`. On imported models, `override: true`
replaces the file's own materials.

## cad

```json
{
  "vars": [{ "name": "w", "expr": "60 mm" }, { "name": "t", "expr": "4 mm" }],
  "configs": [{ "name": "Heavy", "values": { "w": "70 mm", "t": "6 mm" } }],
  "activeConfig": null,
  "features": [ … ],
  "rollback": null,
  "material": "al6061",
  "units": "mm"
}
```

Variables are referenced as `#name` and may use earlier variables. A configuration overrides
some variables by name; `activeConfig` is its name or `null` for the default. `rollback` is the
id of the last feature to build, or `null` for all. `material` sets density for mass
properties: `pla`, `petg`, `abs`, `pa12`, `al6061`, `steel`, `ss304`, `brass`, `birch`,
`walnut`, `concrete` (densities in `MATERIALS`, `src/ws/cad/cad.js`).

Every feature has `id`, `type`, `name`, `suppressed`. Every numeric field is an expression
string.

| type | Fields |
|---|---|
| `extrude` | `plane` (`XY`, `XZ`, `YZ`), `offset`, `depth`, `dir` (`normal`, `reverse`, `symmetric`), `op`, `profile` |
| `revolve` | `plane`, `offset`, `angle`, `op`, `profile` (revolves around the plane's V axis) |
| `hole` | `plane`, `offset` (entry plane), `x`, `y` (centre on the plane), `d`, `depth` (`0` = through), `cbd` (counterbore Ø, `0` = none), `cbdepth` |
| `fillet` | `r`, `edges` (`all`, `X`, `Y`, `Z`, `top`, `bottom`, `front`, `back`, `left`, `right`) |
| `chamfer` | `d`, `edges` |
| `shell` | `t`, `face` (the open face: `top`, `bottom`, `front`, `back`, `left`, `right`) |
| `pattern` | `of` (feature id), `kind` (`linear`, `circular`), `count`, `dx`, `dy`, `dz`, `axis`, `angle` |
| `mirror` | `plane` |
| `box` | `op`, `x`, `y`, `z`, `w`, `l`, `h` |
| `cylinder` | `op`, `axis`, `x`, `y`, `z`, `d`, `h` |
| `sphere` | `op`, `x`, `y`, `z`, `d` |

`op` is `new`, `add`, `cut` or `intersect`.

Plane axes (U, V, normal): `XY` = (X, Y, +Z), `XZ` = (X, Z, −Y), `YZ` = (Y, Z, +X).
`offset` moves the plane along its normal.

**Profiles** (`profile.type`):

| type | Fields |
|---|---|
| `rect` | `w`, `h`, `cx`, `cy`, `r` |
| `circle` | `d`, `cx`, `cy` |
| `polygon` | `n`, `d` (across corners), `cx`, `cy`, `rot` |
| `slot` | `l`, `w`, `cx`, `cy`, `rot` |
| `poly` | `pts` (one `u, v` pair of expressions per line), `r` (corner fillet) |
| `vector` | `link` (vector item id), `subpaths` (cached copy), `size`, `cx`, `cy` |

## Compatibility promise

KERF will always open files written by earlier versions. When the format changes, `kerf` goes
up by one and this document records what changed. A `.kerf` file is never encrypted, signed or
tied to an account.
