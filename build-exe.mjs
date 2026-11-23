// Builds SplitScreen.exe: a Node.js single executable that holds server.js and the pages in
// public\. Run: node build-exe.mjs   (or double-click build-exe.bat)
// Needs: Node.js 20.12 or later (22 or 24 LTS recommended), postject and resedit (npm ci).
// Docs: https://nodejs.org/api/single-executable-applications.html
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'SplitScreen.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log(`- ${msg}`);

// The .exe runs this same Node.js. node:sea and SEA assets need 20.12 or later.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  throw new Error(`Node.js ${process.versions.node} is too old. Install Node.js 20.12 or later (22 or 24 LTS).`);
}

// The license of this exact Node.js version: Node.js itself and the parts it includes
// (V8, OpenSSL, ICU, libuv and others). Each release includes it as NODE-LICENSE.txt.
// Downloaded first, so a build without internet stops before it changes any file.
step('Getting the Node.js license');
const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
let r;
try {
  r = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) });
} catch (e) {
  throw new Error(`Cannot download ${licenseUrl} (${e.message}). Check the internet connection, then build again.`);
}
if (r.status === 404) throw new Error(`Node.js ${process.version} has no release tag on GitHub. Build with a released Node.js.`);
if (!r.ok) throw new Error(`Cannot download ${licenseUrl} (HTTP ${r.status}). Build again later.`);
let license;
try {
  license = await r.text();
} catch (e) {
  throw new Error(`Cannot download ${licenseUrl} (${e.message}). Check the internet connection, then build again.`);
}
if (!license.includes('Node.js is licensed for use as follows')) throw new Error(`${licenseUrl} is not the Node.js license.`);
fs.mkdirSync(DIST, { recursive: true });

// 1. The executable runs 1 CommonJS file. server.js is an ES module that imports only
//    built-in modules, so turning its imports into require() calls is enough.
step('Converting server.js to CommonJS');
let src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
src = src
  .replace(/^import \* as (\w+) from '([^']+)';$/gm, "const $1 = require('$2');")
  .replace(/^import \{ ([^}]+) \} from '([^']+)';$/gm, "const { $1 } = require('$2');")
  .replace(/^import (\w+) from '([^']+)';$/gm, "const $1 = require('$2');")
  .replace(/import\.meta\.url/g, "require('node:url').pathToFileURL(__filename).href");
const left = src.match(/^import\b.*$/m) || src.match(/import\.meta/);
if (left) throw new Error(`Cannot convert this line of server.js: ${left[0]}`);
// ES modules are always strict; keep the .exe the same as `node server.js`.
const main = path.join(DIST, 'server.cjs');
fs.writeFileSync(main, "'use strict'; " + src);   // same line: stack-trace line numbers match server.js
// Stop here on any syntax the conversion broke (export, top-level await, import ... as ...).
execFileSync(process.execPath, ['--check', main], { stdio: 'inherit' });

// 2. Pack the script and the pages into a blob.
step('Packing server and pages');
const assets = {};
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  const full = path.join(ROOT, 'public', f);
  // The .exe serves flat file names only (see servePublic in server.js).
  if (!fs.statSync(full).isFile()) throw new Error(`public\\${f} is a folder. The .exe serves files directly in public\\ only.`);
  assets[`public/${f}`] = full;
}
assets['tray.ps1'] = path.join(ROOT, 'tray.ps1');   // the tray icon (see startTray in server.js)
const blob = path.join(DIST, 'sea-prep.blob');
const config = path.join(DIST, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({
  main, output: blob, assets,
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

// 3. Copy this Node.js and inject the blob into the copy.
step('Writing the .exe');
const exe = path.join(DIST, 'SplitScreen.exe');
fs.copyFileSync(process.execPath, exe);

// 3a. Replace node.exe's file details (Properties > Details), so Task Manager and Startup
//     apps show "Split Screen" instead of "Node.js JavaScript Runtime". Done before postject, so
//     the blob is injected into the finished file.
step('Setting the file details to Split Screen');
let ResEdit;
try { ResEdit = await import('resedit'); }
catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  throw new Error(`A build tool is missing (${e.message}). Run: npm ci   (in the split-screen folder)`);
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Each part must fit Windows's 16-bit version fields.
if (!/^\d+\.\d+\.\d+$/.test(version) || version.split('.').some((n) => Number(n) > 65535)) {
  throw new Error(`package.json version "${version}" must look like 1.1.0 (each part 65535 or less).`);
}
const peFile = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(peFile);
const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (!info) throw new Error('node.exe has no version details to replace.');
for (const lang of info.getAllLanguagesForStringValues()) {
  for (const key of ['CompanyName', 'Comments', 'LegalTrademarks']) info.removeStringValue(lang, key);
  info.setStringValues(lang, {
    // Node.js's license asks that its notices go with every copy. The full text is in
    // NODE-LICENSE.txt (step 5), which each release includes.
    LegalCopyright: 'Split Screen. Includes Node.js and its parts; see NODE-LICENSE.txt.',
    FileDescription: 'Split Screen',
    ProductName: 'Split Screen',
    InternalName: 'SplitScreen',
    OriginalFilename: 'SplitScreen.exe',
  });
}
// These also write the FileVersion and ProductVersion text (as 1.0.0.0).
info.setFileVersion(version);
info.setProductVersion(version);
info.outputToResourceEntries(res.entries);
res.outputResource(peFile);
fs.writeFileSync(exe, Buffer.from(peFile.generate()));

const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postject)) throw new Error('postject is missing. Run: npm ci   (in the split-screen folder)');
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, '--overwrite'], { stdio: 'inherit' });

// 3b. Make it a Windows program instead of a console program, so no console window opens.
//     Split Screen then runs from its tray icon (tray mode in server.js). The Subsystem field
//     is at offset 68 of the PE optional header (same for 32- and 64-bit images).
step('Switching to a windowless program (tray icon)');
const img = fs.readFileSync(exe);
const pe = img.readUInt32LE(0x3c);
if (img.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('SplitScreen.exe is not a Windows PE file.');
const magic = img.readUInt16LE(pe + 24);
if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unexpected PE optional header magic 0x${magic.toString(16)}.`);
const subsystemAt = pe + 24 + 68;
if (subsystemAt + 2 > img.length) throw new Error('SplitScreen.exe is too short.');
const subsystem = img.readUInt16LE(subsystemAt);
if (subsystem !== 3 && subsystem !== 2) throw new Error(`Unexpected PE subsystem ${subsystem}.`);
img.writeUInt16LE(2, subsystemAt);   // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI, 3 = console
fs.writeFileSync(exe, img);

// 4. Put it next to state.json, media\ and SplitScreen.apk.
try {
  fs.copyFileSync(exe, OUT);
} catch (e) {
  throw new Error(`Cannot replace ${OUT}. Close Split Screen first, then build again. (${e.code})`);
}
try {
  fs.rmSync(exe, { force: true });   // do not keep a 2nd 90 MB copy in dist\
} catch (e) {
  console.warn(`Warning: could not delete ${exe} (${e.code}). Delete it by hand.`);
}
// 5. Put the license of the Node.js inside this exe next to it.
const LICENSE_OUT = path.join(ROOT, 'NODE-LICENSE.txt');
fs.writeFileSync(LICENSE_OUT, license);

console.log(`\nBuilt: ${OUT}  (${Math.round(fs.statSync(OUT).size / 1e6)} MB)`);
console.log(`       ${LICENSE_OUT}  (Node.js ${process.version})`);
