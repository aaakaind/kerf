# Roadmap

KERF v0.2 is a foundation. This is the order of work to make it a real replacement for the
paid tools, judged by what blocks professional use first. Each milestone ships as a free
release under the same licence and the same [Pledge](PLEDGE.md).

## Done in v0.2

- Fonts embedded and subset in PDF export, with real kerning and searchable text
- TeX hyphenation; place PDF pages in Layout
- Image trace, offset path, outline stroke; DXF import and export for laser and CNC
- Constraint sketcher on FreeCAD's PlaneGCS; STEP import
- Manifold booleans, Rhino .3dm import, path-traced renders
- Windows, Linux and Android apps

## v0.3 · Type and print

The things a print shop will reject a file for.

- Paragraph composer: justification with word and letter spacing limits, more hyphenation
  languages, widow and orphan control, keep-with-next
- Character styles and a styles panel with based-on inheritance
- Text wrap around frames and image outlines
- Colour management: CMYK and spot swatches, overprint, PDF/X-4 output

## v0.4 · Sketch on anything

- Sketches on part faces, splines, sketch fillets and trims, projected edges
- Sweep, loft, draft and rib features
- Face and edge picking in the viewport for fillets, chamfers and shells
- IGES import
- Drawing views: section, detail and auxiliary, with an editable title block

## v0.5 · Assemblies

- Multi-part documents, instances and mates
- Exploded views and bill of materials into Layout tables
- Interference checks

## v0.6 · Illustration depth

- Brushes and variable-width strokes
- Radial and freeform gradients, patterns
- Symbols, blends, text on a path
- PDF and AI (PDF-compatible) import

## v0.7 · Work together, still without accounts

- Peer-to-peer live editing over WebRTC with end-to-end encryption, no KERF server in the
  middle
- Comments and review mode
- Named versions and branches inside the `.kerf` file

## Always

- Code-signed Windows installer, Flatpak, F-Droid listing, iOS
- Accessibility: full keyboard operation, screen-reader labels, contrast checks
- Translations
- A plug-in API that cannot phone home
- More tests, more file-format fixtures, more documentation

Open an issue to argue for a different order. The roadmap belongs to the people using KERF.
