// Copy the built web app (../dist) into web/ for packaging, plus the licence files.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpSync, rmSync, existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(dirname(fileURLToPath(import.meta.url))); const root = dirname(here); const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the web app first: npm run build (in the repository root)');
rmSync(join(here, 'web'), { recursive: true, force: true });
cpSync(dist, join(here, 'web'), { recursive: true, filter: (src) => !/[\\/](embed|artifact\.html)$/.test(src) }); // b64 copies are for text-only web hosts
for (const f of ['LICENSE', 'NOTICE']) copyFileSync(join(root, f), join(here, f));
const v = JSON.parse(readFileSync(join(root, 'package.json'))).version; const pj = JSON.parse(readFileSync(join(here, 'package.json')));
if (pj.version !== v) { pj.version = v; writeFileSync(join(here, 'package.json'), JSON.stringify(pj, null, 2) + '\n'); }
console.log('web/ ready · KERF', v);
