// Tells the web app it is running as the installed desktop build. Nothing else crosses the bridge.
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('KerfDesktop', { platform: process.platform, versions: { electron: process.versions.electron, chrome: process.versions.chrome } });
