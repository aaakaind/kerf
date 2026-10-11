# Contributing to KERF

Thank you. KERF is built in the open and every kind of help counts: bug reports, test files,
documentation, translations, design critique and code.

## Ground rules

1. **The Pledge is not negotiable.** Contributions that add accounts, telemetry, third-party
   requests, paywalls or dark patterns will not be merged. See [PLEDGE.md](PLEDGE.md).
2. **Files stay open.** Any change to the document model updates [FORMAT.md](FORMAT.md) and
   keeps older files opening (`migrate()` in `src/core/store.js`).
3. **Ease of use is a feature.** A new tool should be reachable from the command palette
   (Ctrl/Cmd + K), have a sensible default, and explain itself in one line in the panel.
4. **No new runtime dependencies without discussion.** Everything ships inside one page; each
   library costs every user download time.

## Getting set up

```sh
npm install
npm run dev      # rebuilds dist/ on every change
npm run serve    # http://localhost:5173
npm test         # build + headless browser smoke test
```

## Code style

- Plain ES modules, no framework. DOM through the `h()` helper in `src/core/ui.js`.
- Every document change goes through the store: `S.checkpoint(label)` before a mutation (or
  `S.commit(label, fn, ws)`), then `S.changed(ws)`. That is what makes undo and autosave work.
- Colours come from the CSS tokens in `src/styles.css`. Both light and dark themes must work.
- Each source file starts with a one-line purpose comment and
  `// SPDX-License-Identifier: AGPL-3.0-or-later`.

## Licence of contributions

By contributing you agree that your contribution is licensed under the AGPL-3.0-or-later, the
same licence as KERF. There is no contributor licence agreement and no copyright assignment.
That means nobody, including AKA IND Technologies Inc., can later relicense your work under
closed terms.

## Reporting a bug

Include what you did, what you expected, what happened, your browser and, if you can, a
`.kerf` file that shows it. KERF files are plain JSON, so check them for anything private
before attaching.
