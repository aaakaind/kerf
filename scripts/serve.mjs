// Tiny static server for dist/ (no dependencies). Usage: node scripts/serve.mjs [port]
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const port = Number(process.argv[2] || process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.gz': 'application/octet-stream', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const file = join(dist, p);
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}).listen(port, () => console.log(`KERF on http://localhost:${port}`));
