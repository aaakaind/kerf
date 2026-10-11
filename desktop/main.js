// KERF desktop shell (Windows + Linux). A thin, private window around the same single-file app as the web build.
// No accounts, no telemetry, no auto-updater, no network needed. Files are served from inside the app over app://.
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const { app, BrowserWindow, Menu, protocol, net, shell, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, 'web'); // the built KERF (index.html + on-demand engines)
const ORIGIN = 'app://kerf';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.zip': 'application/zip', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// app:// behaves like https: secure context, fetch(), workers and WebAssembly all work
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

// WebGL on machines without a usable GPU (VMs, remote desktops): fall back to the software rasteriser.
// Safe here because the window only ever shows KERF's own files.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
if (!app.requestSingleInstanceLock()) app.quit();

function serveApp() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB + path.sep) && file !== WEB) return new Response('Forbidden', { status: 403 });
    try { await fs.promises.access(file, fs.constants.R_OK); } catch { return new Response('Not found', { status: 404 }); }
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers); headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    return new Response(res.body, { status: 200, headers });
  });
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#f3eee4', title: 'KERF', icon: path.join(__dirname, 'build', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${ORIGIN}/index.html`);
  // links to the outside world open in the user's browser; the app window never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

function menu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; } // KERF has its own File menu and ⌘K palette
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
}

app.whenReady().then(() => {
  serveApp(); menu();
  // nothing leaves the machine unless the person clicks a link; deny device permissions the app never asks for
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  session.defaultSession.on('will-download', (_e, item) => { // every save gets a native "Save as" dialog
    const ext = path.extname(item.getFilename()).slice(1);
    item.setSaveDialogOptions({ title: 'Save from KERF', defaultPath: path.join(app.getPath('documents'), item.getFilename()), filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [] });
  });
  createWindow();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => { dialog.showErrorBox('KERF', String(e?.stack || e)); });
