// Split Screen: control page on the PC, multi-window display page on the TV.
// No dependencies. Run: node server.js
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import dgram from 'node:dgram';
import * as sea from 'node:sea';
import util from 'node:util';

// SplitScreen.exe (a Node single executable, see build-exe.mjs) keeps its pages inside the .exe,
// and keeps state.json, media\ and SplitScreen.apk in the folder the .exe sits in.
const IS_EXE = sea.isSea();
const ROOT = IS_EXE ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
if (IS_EXE) process.title = 'Split Screen';

// Tray mode: SplitScreen.exe is built as a Windows program with no console window. It shows an
// icon in the taskbar tray (tray.ps1), writes its messages to splitscreen.log, and shows fatal
// errors in a message box. TRAY=1 tries tray mode with `node server.js` too.
const TRAY = (IS_EXE || process.env.TRAY === '1') && process.platform === 'win32';
const LOG_FILE = path.join(ROOT, 'splitscreen.log');
// Lines are kept in memory until this copy knows it is the server (openLog), so a 2nd
// double-click never touches the running copy's log. Writes are synchronous, so the last
// lines before an exit (the reason for a fatal error) are never lost.
let logFd = null;
let logOff = false;   // the log could not be opened: drop lines instead of keeping them
const logBuffer = [];
function logLine(...args) {
  if (logOff) return;
  const line = `${new Date().toLocaleString()}  ${util.format(...args)}\n`;
  if (logFd === null) { if (logBuffer.length < 500) logBuffer.push(line); return; }
  try { fs.writeSync(logFd, line); } catch { /* disk full or file gone: keep running */ }
}
function openLog() {
  if (!TRAY || logFd !== null) return;
  try {
    try { fs.renameSync(LOG_FILE, path.join(ROOT, 'splitscreen.old.log')); } catch { /* no old log */ }
    logFd = fs.openSync(LOG_FILE, 'w');
    for (const line of logBuffer) fs.writeSync(logFd, line);
  } catch {
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* already closed */ } }
    logFd = null;
    logOff = true;
  }
  logBuffer.length = 0;
}
if (TRAY) console.log = console.warn = console.error = logLine;

const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(ROOT, 'media'));
const STATE_FILE = path.resolve(process.env.STATE_FILE || path.join(ROOT, 'state.json'));
const ALLOW_REMOTE_CONTROL = process.env.ALLOW_REMOTE_CONTROL === '1';

const LAYOUTS = ['auto', '1x1', '2x1', '1x2', '2x2', '3x2', '3x3', '4x4', 'featured', 'pip', 'free'];
const MAX_WINDOWS = 16;
const MAX_BODY = 64 * 1024;
const LONG_POLL_MS = 25000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.apk': 'application/vnd.android.package-archive',
};
const MEDIA_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv', '.m3u8',
  '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

// ---------- state ----------
let state = { version: 1, layout: 'auto', audio: null, solo: null, windows: [] };
let tvLastSeen = 0;
const waiters = new Set();

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = { ...sanitize(saved), version: 1 };
} catch { /* first run or unreadable file: start empty */ }

function sanitize(input) {
  if (!input || typeof input !== 'object') throw new Error('Body must be a JSON object.');
  const layout = LAYOUTS.includes(input.layout) ? input.layout : 'auto';
  const list = Array.isArray(input.windows) ? input.windows : [];
  if (list.length > MAX_WINDOWS) throw new Error(`At most ${MAX_WINDOWS} windows.`);
  const seen = new Set();
  const windows = list.map((w) => {
    const id = String(w?.id ?? '');
    if (!/^[a-z0-9]{1,16}$/.test(id) || seen.has(id)) throw new Error('Bad window id.');
    seen.add(id);
    const url = String(w?.url ?? '').trim();
    if (url.length > 2048) throw new Error('URL too long.');
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/media/')) {
      throw new Error(`URL must start with http:// or https://  (${url.slice(0, 60)})`);
    }
    const nonce = Number.isInteger(w?.nonce) && w.nonce >= 0 ? w.nonce : 0;
    const out = { id, url, nonce };
    // Free layout: position and size as fractions of the screen (0 to 1).
    const r = w?.rect;
    if (r && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k]))) {
      const c = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v * 10000) / 10000));
      const rw = c(r.w, 0.05, 1), rh = c(r.h, 0.05, 1);
      out.rect = { x: c(r.x, 0, 1 - rw), y: c(r.y, 0, 1 - rh), w: rw, h: rh };
    }
    if (Number.isInteger(w?.z) && w.z >= 0 && w.z < 1000) out.z = w.z;
    return out;
  });
  const audio = seen.has(input.audio) ? input.audio : null;
  const solo = seen.has(input.solo) ? input.solo : null;
  return { layout, audio, solo, windows };
}

// Saves run one after another, and each writes a temp file, then renames it over
// state.json. A stop during a save then leaves the old or the new list, never an empty file.
let saving = Promise.resolve();
// Windows refuses to replace a file another program has open for a moment (antivirus,
// the search indexer, an editor). Retry those, up to 8 times over about 1.4 s.
// If the newest list still is not saved, shutdown() tries it once more.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
let unsavedText = null;
async function saveState(text) {
  const tmp = STATE_FILE + '.tmp';
  try {
    await fsp.writeFile(tmp, text);
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(tmp, STATE_FILE);
        if (attempt > 1) console.log(`Saved after ${attempt} tries (state.json was busy).`);
        if (unsavedText === text) unsavedText = null;
        return;
      } catch (e) {
        if (!BUSY.has(e.code) || attempt >= 8) throw e;
        await new Promise((ok) => setTimeout(ok, 200));
      }
    }
  } catch (e) {
    // unsavedText is not set here: setState() already holds the newest text in it. Setting
    // it to this (maybe older) text could later write an old list over a newer one.
    console.error('Save failed:', e.message);
  }
}

function setState(next) {
  state = { ...next, version: state.version + 1 };
  const text = JSON.stringify(state, null, 2);
  unsavedText = text;   // the newest list; cleared when exactly this text reaches state.json
  saving = saving.then(() => saveState(text));
  for (const w of waiters) w();
  waiters.clear();
}

// ---------- helpers ----------
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// DNS rebinding: a website can point its own domain name at this PC (127.0.0.1 or the LAN
// address) and then read Split Screen from the user's browser. Split Screen itself is opened by
// number (127.0.0.1, 192.168.x.x, [::1]), as localhost, or (from other devices) by this PC's
// own name, so only those Host values are accepted. Any other name (a domain, or another
// one-word name that a LAN device could answer for) is refused.
// Windows knows this PC by 2 names: the full name (os.hostname(), up to 63 characters) and
// the network name cut to 15 characters (COMPUTERNAME). A TV may use either one. Both are
// accepted only from other devices: on this PC, a LAN device could answer for a name and
// point it at 127.0.0.1, which would reach the PC-only control routes. This PC itself
// opens Split Screen as 127.0.0.1.
const PC_NAME = os.hostname().toLowerCase();
const SHORT_NAME = String(process.env.COMPUTERNAME || '').toLowerCase();
const SHORT_OK = /^[a-z0-9-]{1,15}$/.test(SHORT_NAME);
const nameOk = (host) => (host !== '' && host === PC_NAME) || (SHORT_OK && host === SHORT_NAME);
const hostOk = (req) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost'
    || (nameOk(host) && !isLocal(req))
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)          // IPv4 address
    || /^\[[0-9a-f:.]+\]$/.test(host);                // IPv6 address
};

// JSON bodies force a CORS preflight, which this server never approves, so another
// website cannot send these requests from the user's browser.
const isJson = (req) => /^application\/json/i.test(req.headers['content-type'] || '');

function lanAddresses() {
  const real = [], virtual = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    const isVirtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier/i.test(name);
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      (isVirtual ? virtual : real).push(a.address);
    }
  }
  // Home networks first (192.168.x.x, then 10.x.x.x).
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  real.sort((a, b) => rank(a) - rank(b));
  return real.length ? real : virtual;
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Resolve a URL path inside a base folder. Returns null if it escapes the folder.
function safeJoin(base, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  const full = path.resolve(base, '.' + path.sep + rel);
  const r = path.relative(base, full);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return full;
}

async function serveFile(req, res, file) {
  let st;
  try { st = await fsp.stat(file); } catch { return send(res, 404, 'Not found', 'text/plain'); }
  if (!st.isFile()) return send(res, 404, 'Not found', 'text/plain');
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (start < 0) start = 0;
    if (end >= st.size) end = st.size - 1;
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
    });
    // pipeline closes the file when the reader cancels (video seeks, a cancelled download)
    // and ends only this response on a read error (e.g. SplitScreen.apk replaced mid-download).
    return pipeline(fs.createReadStream(file, { start, end }), res, () => {});
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(file), res, () => {});
}

// Pages in public\: from disk, or from inside the .exe. Only flat file names are served.
function servePublic(req, res, name) {
  if (!IS_EXE) {
    const file = safeJoin(PUBLIC_DIR, name);
    return file ? serveFile(req, res, file) : send(res, 404, 'Not found', 'text/plain');
  }
  let body;
  try {
    name = decodeURIComponent(name);   // same as safeJoin on disk
    if (!/^[\w.-]+$/.test(name)) throw new Error('bad name');
    body = Buffer.from(sea.getAsset('public/' + name));
  } catch {
    return send(res, 404, 'Not found', 'text/plain');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function listMedia(dir = MEDIA_DIR, prefix = '', depth = 0, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix + e.name;
    if (e.isDirectory() && depth < 3) await listMedia(path.join(dir, e.name), rel + '/', depth + 1, out);
    else if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())) out.push(rel);
    if (out.length >= 500) break;
  }
  return out;
}

// ---------- stream relay ----------
// Some streams refuse to play in a browser on another device (no CORS headers,
// or they check the address). The TV can then fetch the stream through the PC.
// The relay fetches from this PC, so it must not become a way into this PC or the home network.
// Its rules, in the order they apply:
// 1. Only hosts from the window list, and hosts those playlists and redirects point to (relayAllowed).
// 2. Never this PC itself (127.x, ::1), not even for a listed window (isLoopbackIp).
// 3. An address on the local network (192.168.x, 10.x, the PC's own addresses, ...) only for a
//    window's own scheme, host and port, and only if that host is an address or a local name
//    (privateAllowed, localStyleHost). Never for a host that only a playlist or redirect named.
// 4. Rules 2 and 3 run on the address the connection really uses (relayLookup), so a name that
//    changes its answer between check and connect (DNS rebinding) cannot get around them, and
//    again on every redirect hop.
// 5. Nothing relayed can run: sandbox and nosniff on every answer, only media types pass.
// The rules are tested in test/relay-rules.mjs, which cuts the code out by its comment lines.
const learnedHosts = new Set();
const refusalLogged = new Map();   // host -> time of the last log line about it
const MAX_REWRITTEN_CHARS = 8 * 1024 * 1024;   // a rewritten playlist (real ones are a few KB)
const MAX_REWRITE_WORK = 64 * 1024 * 1024;     // characters parsed while rewriting (see rewritePlaylist)
// Playlist reads at once (see relayPlaylist): 2 per window (a master and a variant playlist) at the most.
// Reads hold at most 32 x 4 MB. The rewrite runs 1 at a time and adds up to about 8 MB of text
// (plus the working copies it makes). A name-only link (which may be a segment) takes a slot
// only while its start is checked.
const MAX_PLAYLIST_READS = 2 * MAX_WINDOWS;
let playlistReads = 0;
const RELAY_HEADER_TIMEOUT_MS = 15000;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// ---- relay rules: start (test/relay-rules.mjs runs the code between these 2 lines) ----
// Types the relay passes on: video and audio, playlists, subtitles, keys and bytes. Only the bare
// type is checked and sent (no parameters, no lists), so a value like "video/mp4, text/html"
// cannot slip a web page through.
// No "+" in video/audio subtypes: "+xml" and "+json" types are documents, not media.
const MEDIA_TYPE = /^(video\/[a-z0-9!#$&^_.-]+|audio\/[a-z0-9!#$&^_.-]+|application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl|mp4|mp2t|octet-stream)|text\/vtt|binary\/octet-stream)$/;
function relayType(raw) {
  const t = String(raw || '').split(';')[0].trim().toLowerCase();
  return MEDIA_TYPE.test(t) ? t : 'application/octet-stream';
}

// The same scheme, host and port as a window (an https window does not allow http).
function listedHost(u) {
  return state.windows.some((w) => {
    try { const o = new URL(w.url).origin; return o !== 'null' && o === u.origin; } catch { return false; }
  });
}

function relayAllowed(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return learnedHosts.has(u.host) || listedHost(u);
}

// An IPv6 address as 8 numbers (null if it is not IPv6).
function ipv6Groups(ip) {
  if (!net.isIPv6(ip)) return null;
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);   // a dotted IPv4 tail
  if (v4) s = s.slice(0, v4.index) + ((+v4[1] << 8) | +v4[2]).toString(16) + ':' + ((+v4[3] << 8) | +v4[4]).toString(16);
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
}

// The IPv4 address inside an IPv4-mapped, -compatible, NAT64 (64:ff9b::/96) or 6to4 (2002::/16)
// IPv6 address, or null.
function embeddedIpv4(g) {
  const q = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return q(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return q(g[6], g[7]);
  if (g[0] === 0x2002) return q(g[1], g[2]);
  return null;
}

// This PC's own addresses, read each time (they change when the network changes).
function thisPcAddresses() {
  try { return Object.values(os.networkInterfaces()).flat().filter(Boolean); } catch { return []; }
}

// Loopback and unspecified: this PC itself.
function isLoopbackIp(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('127.') || ip.startsWith('0.');
  const g = ipv6Groups(ip);
  if (!g) return false;
  // :: and ::1 read as 0.0.0.0 and 0.0.0.1 here, so they count too.
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  return mapped && isLoopbackIp(embeddedIpv4(g));
}

// This PC, the local network, link-local, carrier NAT, multicast and reserved addresses.
// On IPv6 home networks every device also has a public address, so this PC's own addresses
// and the /64 network of each of its public IPv6 addresses count as local too.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))) return true;
    return thisPcAddresses().some((i) => i.address === ip);
  }
  const g = ipv6Groups(ip);
  if (!g) return true;   // not an address: refuse
  const v4 = embeddedIpv4(g);
  if (v4) return isPrivateIp(v4);
  if (g.every((x) => x === 0)) return true;              // ::
  if ((g[0] & 0xfe00) === 0xfc00) return true;          // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;          // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;          // fec0::/10 old site-local
  if ((g[0] & 0xff00) === 0xff00) return true;          // ff00::/8 multicast
  return thisPcAddresses().some((i) => {
    const h = ipv6Groups(i.address);
    return h && h.slice(0, 4).every((x, k) => x === g[k]);   // same /64 as this PC
  });
}

// A window may name a device on the home network (a camera, a NAS) by address or local name.
// Only such hosts may resolve to private addresses. A public domain name that suddenly points
// to 192.168.x is refused, so whoever runs that domain cannot aim the relay inward.
// Local names: 1 word, or ending in a name home routers use (.local, .lan, .home, .fritz.box, ...).
const LOCAL_SUFFIX = /\.(local|lan|home|home\.arpa|internal|intranet|localdomain|fritz\.box)$/;
function localStyleHost(u) {
  const h = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return net.isIP(h) !== 0 || !h.includes('.') || LOCAL_SUFFIX.test(h);
}

const privateError = (why) => Object.assign(new Error(why), { code: 'EPRIVATE' });

// The DNS lookup for relay connections. Never this PC itself: the relay's own requests come from
// 127.0.0.1, which the PC-only routes trust (see isLocal). Private addresses only if allowPrivate.
const relayLookup = (allowPrivate) => (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isLoopbackIp(a.address) && (allowPrivate || !isPrivateIp(a.address)));
    if (!ok.length) return cb(privateError('the address is on this PC or the local network'));
    if (options.all) cb(null, ok); else cb(null, ok[0].address, ok[0].family);
  });
};

// May this URL resolve to a private address? Only a listed window's own origin with a local-style
// host. (A local device's https uses its own certificate, which the relay does not trust, so a
// redirect from its http link to https does not play via PC.)
function privateAllowed(u) {
  return localStyleHost(u) && listedHost(u);
}

// A literal address (127.0.0.1, [::1], 192.168.1.20) skips the DNS lookup, so relayGet checks it here.
function literalRefused(u, allowPrivate) {
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  return net.isIP(literal) !== 0 && (isLoopbackIp(literal) || (!allowPrivate && isPrivateIp(literal)));
}
// At most MAX_LEARNED_HOSTS. A Set keeps insertion order, so the host learned longest ago goes
// first. A learned host that is relayed again moves to the end.
const MAX_LEARNED_HOSTS = 500;
function learnHost(host) {
  learnedHosts.delete(host);
  if (learnedHosts.size >= MAX_LEARNED_HOSTS) learnedHosts.delete(learnedHosts.values().next().value);
  learnedHosts.add(host);
}
// ---- relay rules: end ----

// The next piece of a response body, or null at the end. After a piece the stream is paused again,
// so the rest can still be read or piped. A small body can end between 2 calls (its 'end' fires
// before the caller asks again), so an ended or closed stream answers at once.
function nextChunk(stream) {
  return new Promise((resolve, reject) => {
    if (stream.readableEnded) return resolve(null);
    if (stream.destroyed) return reject(stream.errored || new Error('closed early'));
    const done = (fn, v) => {
      stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); stream.off('close', onClose);
      fn(v);
    };
    const onData = (c) => { stream.pause(); done(resolve, c); };
    const onEnd = () => done(resolve, null);
    const onError = (e) => done(reject, e);
    const onClose = () => (stream.readableEnded ? done(resolve, null) : done(reject, stream.errored || new Error('closed early')));
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    stream.resume();   // a paused stream does not restart on its own when 'data' is added
  });
}

// The start of a response body: pieces until the text past any leading white space (and
// byte-order mark) is long enough to tell "#EXTM3U" apart, or 1 KB, or the end of the body.
async function bodyStart(stream) {
  const pieces = [];
  let size = 0;
  for (;;) {
    const c = await nextChunk(stream);
    if (!c) return { pieces, ended: true };
    pieces.push(c);
    size += c.length;
    if (size >= 1024 || Buffer.concat(pieces).toString('utf8').replace(/^\s+/, '').length >= 7) return { pieces, ended: false };
  }
}

// 1 GET with no redirects. Literal addresses skip the DNS lookup, so they are checked here.
function relayGet(u, headers, signal, allowPrivate) {
  return new Promise((resolve, reject) => {
    if (literalRefused(u, allowPrivate)) return reject(privateError('the address is on this PC or the local network'));
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.get(u, { headers, signal, lookup: relayLookup(allowPrivate) }, resolve);
    r.on('error', reject);
  });
}

// Point every link in an HLS playlist back through the relay. Each short link grows into a full
// relay link (with the whole base address), so the result is capped too (MAX_REWRITTEN_CHARS).
// It is counted where each link is made, not per line: 1 line with many URI="a" must not build
// gigabytes before the check.
// The rewrite also blocks the server while it runs, so its work is capped (MAX_REWRITE_WORK):
// each link costs the length of the base address plus the link, even a link that does not parse.
function rewritePlaylist(text, base) {
  let chars = 0;
  let work = 0;
  const hosts = new Set();   // learned only once the whole rewrite has worked, 1 time per host
  const tooBig = () => Object.assign(new Error('Playlist too large.'), { code: 'ETOOBIG' });
  const grow = (n) => {
    chars += n;
    if (chars > MAX_REWRITTEN_CHARS) throw tooBig();
  };
  const toRelay = (ref) => {
    work += base.length + ref.length;
    if (work > MAX_REWRITE_WORK) throw tooBig();
    if (!URL.canParse(ref, base)) return ref;   // cheaper than a throw and catch per bad link
    const abs = new URL(ref, base);
    hosts.add(abs.host);
    const link = '/relay?u=' + encodeURIComponent(abs.href);
    grow(link.length);
    return link;
  };
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { grow(line.length + 1); out.push(line); continue; }
    if (t.startsWith('#')) {
      grow(line.length + 1);   // the tag text; each URI it holds is counted in toRelay
      out.push(line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${toRelay(ref)}"`));
    } else {
      grow(1);   // the line break; the link itself is counted in toRelay
      out.push(toRelay(t));
    }
  }
  for (const h of hosts) learnHost(h);
  return out.join('\n');
}

// Follow redirects by hand, so every hop gets the same checks as the first one. Resolves with the
// answer that is not a redirect and the link it came from. An error carries the hop it failed on
// (e.url), for the log.
async function relayFollow(u, headers, signal) {
  let at = u;
  try {
    for (let hop = 0; ; hop++) {
      const up = await relayGet(at, headers, signal, privateAllowed(at));
      const loc = up.headers.location;
      if (![301, 302, 303, 307, 308].includes(up.statusCode) || !loc) return { up, finalUrl: at };
      up.resume();   // drop the redirect's own body
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      const next = new URL(loc, at);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('redirect to a non-web address');
      at = next;   // learned by the caller, only once it has answered
    }
  } catch (e) {
    e.url = at;
    throw e;
  }
}

// The TV only shows "blocked": the log says which host and why. At most once a minute per host
// and for at most 100 hosts a minute, so a playlist naming many hosts cannot flood it.
function logRefusal(host, why) {
  const now = Date.now();
  if ((refusalLogged.get(host) || 0) >= now - 60000) return;
  if (refusalLogged.size >= 100) for (const [h, t] of refusalLogged) if (t < now - 60000) refusalLogged.delete(h);
  if (refusalLogged.size >= 100) return;
  refusalLogged.set(host, now);
  console.log(`Relay refused ${host}: ${why}. See "Live streams" in the README.`);
}

// No CORS header: the TV page and the TV app fetch the relay from this server's own address,
// so other websites have no reason to read it.
//
// The relay answers from this server's own address. A relayed web page would run there with
// the control page's trust (on this PC: 127.0.0.1, see isLocal). So nothing relayed may run:
// sandbox and nosniff, and only media types pass (see MEDIA_TYPE); anything else is sent as bytes.
const RELAY_ANSWER = Object.freeze({ 'Cache-Control': 'no-store', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' });

// Headers for passing the body on as it comes. A decoded body has a new length, no encoding,
// and no byte ranges (those counted the packed bytes).
function passOn(up, contentType, decoded) {
  const o = { ...RELAY_ANSWER };
  // content-encoding: in case the upstream compresses anyway, so the TV can still decode it.
  const keep = decoded ? [] : ['content-length', 'content-range', 'accept-ranges', 'content-encoding'];
  for (const h of keep) if (up.headers[h]) o[h] = up.headers[h];
  o['content-type'] = contentType;
  return o;
}

async function relay(req, res, target) {
  let u;
  try { u = new URL(target); } catch { return send(res, 400, { error: 'Bad relay URL.' }); }
  if (!relayAllowed(u)) return send(res, 403, { error: 'This host is not in the window list.' });

  const ctrl = new AbortController();
  const headerTimer = setTimeout(() => ctrl.abort(), RELAY_HEADER_TIMEOUT_MS);
  req.on('close', () => ctrl.abort());
  // identity: the body is passed on as it comes, so it must not be compressed.
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SplitScreen/1.0', Accept: '*/*', 'Accept-Encoding': 'identity' };
  if (req.headers.range) headers.Range = req.headers.range;

  let up;
  let finalUrl;
  try {
    ({ up, finalUrl } = await relayFollow(u, headers, ctrl.signal));
  } catch (e) {
    clearTimeout(headerTimer);
    if (e.code === 'EPRIVATE') {
      logRefusal(e.url.host, e.message);
      if (!res.headersSent) send(res, 403, { error: 'Not relayed: ' + e.message });
      return;
    }
    if (!res.headersSent) send(res, 502, { error: 'Stream did not answer: ' + (e.name === 'AbortError' ? 'timed out' : e.message) });
    return;
  }
  clearTimeout(headerTimer);
  // The link asked for is refreshed only if it was learned (a listed one is allowed by the window
  // list). The host that answered is learned below, even when it is listed; a learned host can
  // reach only public addresses (see privateAllowed).
  if (learnedHosts.has(u.host)) learnHost(u.host);
  learnHost(finalUrl.host);
  const type = up.headers['content-type'] || '';
  // A playlist by its type, or by .m3u or .m3u8 anywhere in the link (path or query, of the link
  // asked for or the one it redirected to), as the README and the TV page say.
  // A link found by name only is rewritten only if its body really starts as one (#EXTM3U);
  // otherwise it streams on (unpacked if it was compressed), so a segment like
  // seg.ts?pl=index.m3u8 plays at any size.
  const byType = /mpegurl/i.test(type);
  const byName = [u, finalUrl].some((x) => /\.m3u8?/i.test(x.pathname + x.search));
  const okStatus = up.statusCode >= 200 && up.statusCode < 300;
  if ((byType || byName) && okStatus) return relayPlaylist(req, res, { up, ctrl, type, byType, finalUrl });

  res.writeHead(up.statusCode, passOn(up, relayType(type)));
  if (req.method === 'HEAD') { up.destroy(); return res.end(); }
  // pipeline closes both ends when either side fails or the TV cancels.
  pipeline(up, res, () => {});
}

// A playlist (or a link that may be one): read it, rewrite its links through the relay, answer.
async function relayPlaylist(req, res, { up, ctrl, type, byType, finalUrl }) {
  // The relay asks for no compression, but some servers compress anyway. A playlist must be read
  // as text, so a compressed one is unpacked first (and passed on unpacked). An empty body is
  // left as it is (zlib refuses 0 bytes). An encoding the relay does not know is often a wrong
  // header (PHP's "Content-Encoding: none"): that body is read as it is and rewritten if it
  // starts as a playlist. Otherwise a link found by name passes on untouched with its header,
  // and one typed as a playlist gets 502 (it cannot be rewritten).
  const enc = String(up.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const unpack = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[enc];
  const unknownEnc = enc !== 'identity' && !unpack;
  const emptyBody = up.statusCode === 204 || up.headers['content-length'] === '0';

  // Each playlist read can hold up to 4 MB, and a small packed body can unpack to that much.
  // So only MAX_PLAYLIST_READS run at once; the TV retries a busy answer.
  if (playlistReads >= MAX_PLAYLIST_READS) { up.destroy(); return send(res, 503, { error: 'Relay busy, try again.' }); }
  const decoded = !!unpack && !emptyBody;
  // The body can fail mid-read (the TV cancels, or the stream drops). Answer 502, never crash.
  const bodyTimer = setTimeout(() => ctrl.abort(), RELAY_HEADER_TIMEOUT_MS);
  playlistReads++;   // counted down in finally, so nothing may come between this line and try
  try {
    const src = decoded ? pipeline(up, unpack(), () => {}) : up;
    const chunks = [];
    let size = 0;
    // A body cut short by the timer can end without an error: answer 502, not a broken playlist.
    const timedOut = () => {
      if (ctrl.signal.aborted) throw Object.assign(new Error('cancelled or timed out'), { name: 'AbortError' });
    };
    if (!byType || unknownEnc) {
      // Found by name only, or in an unknown encoding: look at the start. Not a playlist (or
      // empty): pass it all on as it is.
      const { pieces, ended } = await bodyStart(src);
      timedOut();
      const head = Buffer.concat(pieces);
      if (!/^\s*#EXTM3U/.test(head.toString('utf8'))) {   // \s also skips a byte-order mark
        clearTimeout(bodyTimer);
        if (byType) {
          // Typed as a playlist but in an encoding the relay cannot read: it cannot be rewritten,
          // and passed on as it is its links would skip the relay. Say so instead.
          src.destroy(); up.destroy();
          const name = /^[a-z0-9-]{1,20}$/.test(enc) ? enc : 'not known';
          return send(res, 502, { error: `Not a playlist the relay can read (encoding ${name}).` });
        }
        // An unpacked part (206) has no byte range any more, so it is sent as a whole answer.
        res.writeHead(decoded && up.statusCode === 206 ? 200 : up.statusCode, passOn(up, relayType(type), decoded));
        if (req.method === 'HEAD') { src.destroy(); up.destroy(); return res.end(); }
        if (ended) return res.end(head);
        res.write(head);
        pipeline(src, res, () => {});
        return;
      }
      chunks.push(head);
      size += head.length;
    }
    for await (const c of src) {
      size += c.length;
      if (size > MAX_PLAYLIST_BYTES) { src.destroy(); up.destroy(); return send(res, 502, { error: 'Playlist too large.' }); }
      chunks.push(c);
    }
    timedOut();
    // Rewritten inside the count, so the slot also covers the rewrite.
    const body = rewritePlaylist(Buffer.concat(chunks).toString('utf8'), finalUrl.href);
    res.writeHead(200, { ...RELAY_ANSWER, 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(body);
  } catch (e) {
    const why = e.code === 'ETOOBIG' ? e.message : 'Playlist read failed: ' + (e.name === 'AbortError' ? 'cancelled or timed out' : e.message);
    if (!res.headersSent && !res.destroyed) send(res, 502, { error: why });
    else res.destroy();
    return;
  } finally {
    clearTimeout(bodyTimer);
    playlistReads--;   // the read is over (a non-playlist streams on outside this count)
  }
}

// ---------- TV status reports ----------
let tvStatuses = {};

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // DNS rebinding (see hostOk): refuse any Host other than an address, localhost, or (from other devices) this PC's name.
    if (!hostOk(req)) {
      // On this PC, 127.0.0.1 works. On a TV, 127.0.0.1 would mean the TV itself.
      const example = isLocal(req) ? `http://127.0.0.1:${port}/` : `http://${lanAddresses()[0] || '<PC address>'}:${port}/tv`;
      return send(res, 403, { error: `Open Split Screen by its address, for example ${example}` });
    }
    if (p === '/api/state' && req.method === 'GET') {
      const isTv = url.searchParams.get('tv') === '1';
      if (isTv) tvLastSeen = Date.now();
      const since = Number(url.searchParams.get('v'));
      // While stopping: a TV that does not have the stop message yet gets it, so it cannot
      // get the window list back. Everyone else (a TV that already has it, the PC control
      // page) is left waiting until the process ends: no fast request loop, and the
      // control page never sees, and never saves back, the empty list.
      if (stopping) {
        if (isTv && since !== -1) return send(res, 200, stoppedPayload());
        return;
      }
      if (!since || since !== state.version) return send(res, 200, state);
      // Long poll: answer when the state changes, or after LONG_POLL_MS.
      const done = (payload) => { clearTimeout(t); waiters.delete(done); if (!res.writableEnded) send(res, 200, payload || state); };
      done.tv = isTv;   // only TVs get the stop message (notifyStopped)
      const t = setTimeout(done, LONG_POLL_MS);
      waiters.add(done);
      req.on('close', () => { clearTimeout(t); waiters.delete(done); });
      return;
    }
    if (p === '/api/state' && req.method === 'POST') {
      if (!isLocal(req) && !ALLOW_REMOTE_CONTROL) return send(res, 403, { error: 'Control is allowed from this PC only.' });
      if (!isJson(req)) return send(res, 415, { error: 'Send JSON.' });
      if (stopping) return send(res, 503, { error: 'Split Screen is stopping. Changes are not saved.' });
      const next = sanitize(JSON.parse(await readBody(req)));
      setState(next);
      return send(res, 200, state);
    }
    if (p === '/api/info' && req.method === 'GET') {
      const tvSecondsAgo = tvLastSeen ? Math.round((Date.now() - tvLastSeen) / 1000) : null;
      return send(res, 200, {
        port, ips: lanAddresses(), mediaDir: MEDIA_DIR, tvSecondsAgo,
        statuses: tvSecondsAgo !== null && tvSecondsAgo < 40 ? tvStatuses : {},
      });
    }
    if (p === '/api/report' && req.method === 'POST') {
      // The TV reports what each window is doing. Only known windows, short text.
      const body = JSON.parse(await readBody(req));
      const next = {};
      for (const w of state.windows) {
        const s = body?.statuses?.[w.id];
        if (typeof s === 'string') next[w.id] = s.slice(0, 80);
      }
      tvStatuses = next;
      return send(res, 200, { ok: true });
    }
    if (p === '/api/quit' && req.method === 'POST') {
      // "Stop Split Screen" on the control page. This PC only, even with ALLOW_REMOTE_CONTROL.
      if (!isLocal(req)) return send(res, 403, { error: 'Only this PC can stop Split Screen.' });
      if (!isJson(req)) return send(res, 415, { error: 'Send JSON.' });
      console.log('Stopped from the control page.');
      send(res, 200, { ok: true });
      setTimeout(() => shutdown(0), 100);
      return;
    }
    if (p === '/relay' && (req.method === 'GET' || req.method === 'HEAD')) {
      return await relay(req, res, url.searchParams.get('u') || '');
    }
    if (p === '/api/media' && req.method === 'GET') {
      if (!isLocal(req) && !ALLOW_REMOTE_CONTROL) return send(res, 403, { error: 'PC only.' });
      return send(res, 200, { dir: MEDIA_DIR, files: await listMedia() });
    }
    if (p.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = safeJoin(MEDIA_DIR, p.slice('/media/'.length));
      if (!file) return send(res, 400, 'Bad path', 'text/plain');
      return await serveFile(req, res, file);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/') {
        // The TV only needs to type the address: send it to the display page.
        if (!isLocal(req) && !ALLOW_REMOTE_CONTROL) { res.writeHead(302, { Location: '/tv' }); return res.end(); }
        return servePublic(req, res, 'control.html');
      }
      if (p === '/tv') return servePublic(req, res, 'tv.html');
      // The Fire TV app, for installing with the Downloader app: http://<PC>:<port>/SplitScreen.apk
      if (p.toLowerCase() === '/splitscreen.apk') return await serveFile(req, res, path.join(ROOT, 'SplitScreen.apk'));
      return await servePublic(req, res, p.slice(1));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent && !res.destroyed) send(res, 400, { error: e.message });
    else res.destroy();
  }
});

// ---------- start ----------
// Started by double-click (SplitScreen.exe or start-split-screen.bat): open the control page.
// OPEN_BROWSER=0 turns that off.
const LAUNCHER = (IS_EXE || process.env.OPEN_BROWSER === '1') && process.env.OPEN_BROWSER !== '0';
// Started by Windows at sign-in (Start with Windows in the tray menu): stay in the tray,
// do not open the browser.
const AT_SIGN_IN = process.argv.includes('--startup');

function openBrowser(p) {
  if (!LAUNCHER || AT_SIGN_IN || process.platform !== 'win32') return;
  spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${p}/`], { detached: true, stdio: 'ignore' })
    .on('error', (e) => console.log(`Open http://127.0.0.1:${p}/ in your browser. (${e.message})`))
    .unref();
}

// Windows PowerShell 5.1, by full path (a powershell.exe next to SplitScreen.exe is never used).
// Scripts are fixed text; all values go in environment variables, never into the script.
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function spawnPowerShell(script, env, stdio = 'ignore') {
  return spawn(POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio, env: { ...process.env, ...env } });
}
const MESSAGE_BOX = "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show("
  + "$env:SPLITSCREEN_MSG, 'Split Screen', 'OK', 'Error', 'Button1', 'DefaultDesktopOnly')";
const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Tell every waiting TV that Split Screen is stopping, so it clears its windows and says so.
// The saved window list is not changed: the TV shows the windows again on the next start.
// Version -1 differs from any real version, so the TV always applies it, and its next
// request after a restart always gets the real list.
const stoppedPayload = () => ({ version: -1, stopped: true, layout: state.layout, audio: null, solo: null, windows: [] });
function notifyStopped() {
  const payload = stoppedPayload();
  for (const w of [...waiters]) if (w.tv) w(payload);   // control pages keep waiting
}

// Stop cleanly: tell the TV, wait for queued saves and retry an unsaved newest list (at
// most 3.5 s together), let the tray remove its icon, exit.
let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  notifyStopped();
  await delay(300);   // let those answers reach the TV before the process ends
  // After the queued saves, if the newest list still did not reach state.json (the file
  // was busy), try it once more. Queued, so it never overlaps a save in progress.
  saving = saving.then(() => (unsavedText !== null ? saveState(unsavedText) : undefined));
  await Promise.race([saving, delay(3500)]);
  await closeTray();
  process.exit(code);
}

// Fatal error: first stop serving completely (the listener AND every open connection,
// since the TV keeps long-poll and stream connections open, and discovery), so nothing
// keeps half-working. In tray mode there is no console, so show a message box.
let failed = false;
function fatal(msg) {
  if (failed) { console.error(`Also: ${msg}`); return; }
  failed = true;
  stopping = true;
  try { notifyStopped(); } catch { /* best effort: the TV shows Reconnecting instead */ }
  try { server.close(); } catch { /* not listening */ }
  // Close every connection a moment later, so the stop messages above can go out first.
  setTimeout(() => { try { server.closeAllConnections(); } catch { /* none */ } }, 50);
  try { disco.close(); } catch { /* not bound, or not created yet */ }
  console.error(`Split Screen cannot run: ${msg}`);
  // Console mode: wait as long as tray mode does before closing connections, so the TV
  // gets its stop message there too.
  if (!TRAY) { setTimeout(() => process.exit(1), 100); return; }
  const text = `Split Screen cannot run:\n\n${String(msg).split('\n')[0]}\n\nDetails: ${logFd === null ? 'none' : LOG_FILE}`;
  Promise.race([saving, delay(2000)]).then(closeTray).then(() => {
    const box = spawnPowerShell(MESSAGE_BOX, { SPLITSCREEN_MSG: text });
    box.on('exit', () => process.exit(1));
    box.on('error', () => process.exit(1));
  }).catch(() => process.exit(1));   // the box could not start: never hang without a UI
}
if (TRAY) process.on('uncaughtException', (e) => fatal(e && e.stack ? e.stack : String(e)));
// Console mode (start-split-screen.bat): Ctrl+C and closing the window also stop cleanly,
// so the TV clears there too.
for (const sig of ['SIGINT', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(0));

// ---------- tray icon ----------
// tray.ps1 exits 10 for Quit (Split Screen stops), 3 when it cannot start, 0 when told to close.
// Closing its stdin tells it to remove the icon and exit.
const TRAY_QUIT = 10;
let tray = null;
function startTray() {
  if (!TRAY) return;
  let script;
  try {
    script = IS_EXE ? sea.getAsset('tray.ps1', 'utf8') : fs.readFileSync(path.join(ROOT, 'tray.ps1'), 'utf8');
  } catch (e) {
    console.error(`Tray icon is off (${e.message}). Use Stop Split Screen on the control page.`);
    return;
  }
  tray = spawnPowerShell(script, {
    SPLITSCREEN_PORT: String(port), SPLITSCREEN_PID: String(process.pid),
    SPLITSCREEN_EXE: process.execPath, SPLITSCREEN_LOG: LOG_FILE,
    SPLITSCREEN_AUTOSTART: IS_EXE ? '1' : '0',   // Start with Windows only for SplitScreen.exe
    SPLITSCREEN_QUIET: AT_SIGN_IN ? '1' : '0',     // no "Split Screen is running" balloon at sign-in
  }, ['pipe', 'pipe', 'pipe']);
  const t = tray;
  t.stdin.on('error', () => { /* tray already gone */ });
  // tray.ps1 writes the reason it could not start to stdout as plain text. Anything on
  // stderr (an unexpected PowerShell error, as CLIXML) is kept as a fallback.
  let reason = '', errors = '';
  t.stdout.setEncoding('utf8');
  t.stderr.setEncoding('utf8');
  t.stdout.on('data', (d) => { if (reason.length < 2000) reason += d; });
  t.stderr.on('data', (d) => { errors = (errors + d).slice(-8000); });   // keep the newest
  t.on('error', (e) => {
    if (tray === t) tray = null;   // 'exit' never comes when the spawn failed
    console.error(`Tray icon is off (${e.message}). Use Stop Split Screen on the control page.`);
  });
  t.on('exit', (code) => {
    if (tray === t) tray = null;
    if (stopping) return;
    if (code === TRAY_QUIT) {
      console.log('Quit from the tray icon.');
      shutdown(0);
      return;
    }
    // Any other end (could not start, crashed): Split Screen keeps serving the TV.
    console.error(`Tray icon stopped (exit ${code}). Split Screen keeps running. `
      + 'Stop it with Stop Split Screen on the control page; start SplitScreen.exe again to open that page.');
    const why = reason.trim() || lastPowerShellError(errors);
    if (why) console.error(`Tray icon reason: ${why}`);
  });
}

// PowerShell writes errors to a redirected stderr as CLIXML. Keep only the text.
function plainPowerShellError(text) {
  const t = String(text).trim();
  if (!t.startsWith('#< CLIXML')) return t;
  const parts = [...t.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  return parts.join('')
    .replace(/_x000D__x000A_/g, ' ').replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// The message of the last error record (its 1st line), without the CategoryInfo trailer.
function lastPowerShellError(clixml) {
  // Each line of an error record arrives as its own <S> part. A record's 1st line is its
  // message; its last line is "+ FullyQualifiedErrorId ...", then a blank line.
  const lines = [...String(clixml).matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((m) => plainPowerShellError(`#< CLIXML <S S="Error">${m[1]}</S>`))
    .filter((l) => l !== '');
  if (!lines.length) return plainPowerShellError(clixml).slice(0, 400);
  let message = lines[0];
  lines.forEach((l, i) => { if (/FullyQualifiedErrorId/.test(l) && lines[i + 1]) message = lines[i + 1]; });
  return message.slice(0, 400);
}

// Tell the tray to remove its icon, and wait for it (at most 1.5 s).
function closeTray() {
  if (!tray) return Promise.resolve();
  const t = tray;
  return new Promise((ok) => {
    const timer = setTimeout(() => { try { t.kill(); } catch { /* gone */ } ok(); }, 1500);
    t.once('exit', () => { clearTimeout(timer); ok(); });
    try { t.stdin.end(); } catch { clearTimeout(timer); ok(); }
  });
}

// A 2nd double-click must not start a 2nd server: open the running one instead.
async function findRunning() {
  for (let p = PORT; p <= PORT + 20; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/info`, { signal: AbortSignal.timeout(400) });
      const j = await r.json();
      if (j && Array.isArray(j.ips) && j.port === p) return p;
    } catch { /* nothing there, or not Split Screen */ }
  }
  return null;
}

// Another app can hold the port (Windows lends ports to outgoing connections).
// Try the next 20 ports before giving up.
let port = PORT;
server.on('error', (e) => {
  // EACCES: Windows reserves some port ranges (Hyper-V, WSL). Skip those too.
  if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && port < PORT + 20) {
    console.log(`Port ${port} is in use. Trying ${port + 1}...`);
    port += 1;
    server.listen(port, '0.0.0.0');
    return;
  }
  fatal(e.code === 'EADDRINUSE' || e.code === 'EACCES'
    ? `no free port from ${PORT} to ${PORT + 20} (${e.message})`
    : `cannot listen on port ${port} (${e.message})`);
});
server.on('listening', () => {
  if (failed) { server.close(); return; }   // a fatal error came while a port retry was pending
  port = server.address().port;
  console.log(`\nSplit Screen is running${AT_SIGN_IN ? ' (started with Windows)' : ''}.\n`);
  console.log(`  Control (this PC):  http://127.0.0.1:${port}/`);
  for (const ip of lanAddresses()) console.log(`  On the TV, open:    http://${ip}:${port}/tv`);
  console.log(`  Media folder:       ${MEDIA_DIR}\n`);
  if (TRAY) console.log('  Tray icon: right-click it to quit.\n');
  openBrowser(port);
  startDiscovery();
  startTray();
});

(async () => {
  if (LAUNCHER) {
    const running = await findRunning();
    if (running) {
      console.log(`Split Screen is already running on port ${running}. Opening it.`);
      openBrowser(running);
      setTimeout(() => process.exit(0), 1500);
      return;
    }
  }
  openLog();   // this copy is the server: start a fresh splitscreen.log (the old one becomes splitscreen.old.log)
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  } catch (e) {
    return fatal(`cannot create the media folder ${MEDIA_DIR} (${e.code}). Move Split Screen to a folder you can write to.`);
  }
  server.listen(port, '0.0.0.0');
})();

// ---------- discovery for the TV app ----------
// The Fire TV app broadcasts "SPLITSCREEN_DISCOVER" on UDP 47390. We answer with the
// HTTP port, so the app finds the PC even when the port changed.
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT) || 47390;
const DISCOVERY_APPS = { SPLITSCREEN_DISCOVER: 'splitscreen' };
// No reuseAddr: only 1 copy of Split Screen can answer. A 2nd copy logs "discovery is off".
const disco = dgram.createSocket({ type: 'udp4' });
disco.on('message', (msg, rinfo) => {
  const ask = msg.toString('utf8').trim();
  if (!Object.hasOwn(DISCOVERY_APPS, ask)) return;
  const reply = Buffer.from(JSON.stringify({ app: DISCOVERY_APPS[ask], port }));
  disco.send(reply, rinfo.port, rinfo.address);
});
disco.on('error', (e) => console.error(`TV app discovery is off: ${e.message}`));
// Bound only once the HTTP server is listening, so a copy that exits never answers.
function startDiscovery() { disco.bind(DISCOVERY_PORT, '0.0.0.0'); }
