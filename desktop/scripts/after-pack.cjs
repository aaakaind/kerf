// Windows: write KERF's icon and version information into KERF.exe with resedit (pure JS, so Linux CI needs no Wine).
// SPDX-License-Identifier: AGPL-3.0-or-later
const fs = require('node:fs'); const path = require('node:path');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const name = ctx.packager.appInfo.productFilename; const exePath = path.join(ctx.appOutDir, `${name}.exe`);
  const version = ctx.packager.appInfo.version.split('.').map(Number); while (version.length < 4) version.push(0);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icons', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const gid = groups.length ? groups[0].id : 1; const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const strings = { ProductName: 'KERF', FileDescription: 'KERF — open design tools', CompanyName: 'AKA IND Technologies Inc.', LegalCopyright: '© 2026 AKA IND Technologies Inc. · AGPL-3.0-or-later', OriginalFilename: `${name}.exe`, InternalName: 'KERF', ProductVersion: version.join('.'), FileVersion: version.join('.') };
  const langs = vi.getAllLanguagesForStringValues(); const target = langs.length ? langs[0] : { lang: 1033, codepage: 1200 };
  vi.setStringValues(target, strings); vi.setFileVersion(...version, target.lang); vi.setProductVersion(...version, target.lang);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • resedit: icon + version ${version.join('.')} written to ${name}.exe`);
};
