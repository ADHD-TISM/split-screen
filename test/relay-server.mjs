// Runs server.js and checks the stream relay end to end: which hosts it fetches, redirects,
// types, playlists and compression. Run: npm test   (or: node test/relay-server.mjs)
// It starts Split Screen on TEST_PORT (default 18990, with discovery on 18999) and a fake stream
// server on this PC's network address, port TEST_PORT + 1. State and media go in a temp folder.
// Needs a network address (not 127.x): without one the test is skipped (on GitHub it fails).
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 18990);
const UP_PORT = PORT + 1;
// A normal network address (not 127.x, preferably not a 169.254.x link-local one).
const v4 = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
const LAN = (v4.find((i) => !i.address.startsWith('169.254.')) || v4[0])?.address;
// On GitHub (CI is set there) a skip would show a pass that tested nothing, so it fails instead.
if (!LAN) {
  console.log(`Relay server test ${process.env.CI ? 'failed' : 'skipped'}: this PC has no network address.`);
  process.exit(process.env.CI ? 1 : 0);
}

// Split Screen moves to the next port when its port is busy, so a busy test port would make this
// test talk to some other program. Stop at once instead.
const portFree = (port, host) => new Promise((ok) => {
  const s = net.createServer().once('error', () => ok(false)).listen(port, host, () => s.close(() => ok(true)));
});
// 127.0.0.1 too: on Windows a program bound to 127.0.0.1 only does not block 0.0.0.0, but it
// would answer this test's requests.
for (const [port, host] of [[PORT, '0.0.0.0'], [PORT, '127.0.0.1'], [UP_PORT, LAN]]) {
  if (!(await portFree(port, host))) {
    console.log(`Relay server test: port ${port} is in use. Close the program that uses it, or set TEST_PORT.`);
    process.exit(1);
  }
}

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const UP = `http://${LAN}:${UP_PORT}`;
const LONG_DIR = '/' + 'd'.repeat(8000);   // a long base address for the rewrite cap check
const writeState = (tmp) => fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ layout: 'auto', windows: [
  { id: 'a1', url: `${UP}/live.m3u8` },
  { id: 'a2', url: `http://127.0.0.1:${PORT}/api/media` },
  { id: 'a3', url: `http://localhost:${PORT}/` },
] }));

// The fake stream server: one route per case.
const routes = {
  '/live.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl' },
    ['#EXTM3U', 'seg1.ts', `http://127.0.0.1:${PORT}/api/media`, `http://localhost:${PORT}/api/media`,
      `http://[::ffff:127.0.0.1]:${PORT}/api/info`, 'http://10.0.0.1:80/x', 'http://169.254.169.254/latest'].join('\n')),
  '/seg1.ts': (res, req) => send(res, req.headers.range ? 206 : 200, { 'content-type': 'video/mp2t' }, 'SEGMENT'),
  '/redir-pc': (res) => send(res, 302, { location: `http://127.0.0.1:${PORT}/api/media` }),
  '/redir-name': (res) => send(res, 302, { location: `http://localhost:${PORT}/api/media` }),
  '/redir-lan': (res) => send(res, 302, { location: 'http://10.0.0.1:80/admin' }),   // another local device
  '/redir-self': (res) => send(res, 302, { location: '/seg1.ts' }, 'ignored'),
  '/redir-loop': (res) => send(res, 302, { location: '/redir-loop' }),
  '/redir-file': (res) => send(res, 302, { location: 'file:///C:/Windows/win.ini' }),
  '/page': (res) => send(res, 200, { 'content-type': 'text/html' }, '<script>alert(1)</script>'),
  '/svg': (res) => send(res, 200, { 'content-type': 'image/svg+xml' }, '<svg onload=alert(1)/>'),
  '/mixed': (res) => send(res, 200, { 'content-type': 'video/mp4, text/html' }, '<b>x</b>'),
  '/subs.vtt': (res) => send(res, 200, { 'content-type': 'text/vtt' }, 'WEBVTT'),
  '/play': (res) => send(res, 200, { 'content-type': 'text/plain' }, '#EXTM3U\nseg1.ts\n'),
  '/mid': (res) => send(res, 200, { 'content-type': 'text/plain' }, '#EXTM3U\nseg1.ts\n'),
  '/x.m3u8': (res) => send(res, 302, { location: '/tok?t=abc' }),
  '/tok': (res) => send(res, 200, { 'content-type': 'text/plain' }, '#EXTM3U\nseg1.ts\n'),
  '/seg2.ts': (res) => send(res, 200, { 'content-type': 'video/mp2t' }, 'TSDATA'),
  '/doc': (res) => send(res, 200, { 'content-type': 'text/html' }, '<p>https://example.com/a</p>'),
  '/big.ts': (res) => send(res, 200, { 'content-type': 'application/mp2t' }, Buffer.alloc(5 * 1024 * 1024, 71)),
  '/s3.m3u8': (res) => send(res, 200, { 'content-type': 'binary/octet-stream' }, '#EXTM3U\nseg1.ts\n'),
  '/gz.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-encoding': 'gzip' }, zlib.gzipSync('#EXTM3U\nseg1.ts\n')),
  '/gzempty.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-encoding': 'gzip', 'content-length': '0' }),
  '/none.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-encoding': 'none' }, '#EXTM3U\nseg1.ts\n'),
  '/utf8': (res) => send(res, 200, { 'content-type': 'application/x-mpegURL', 'content-encoding': 'UTF-8' }, '#EXTM3U\nseg1.ts\n'),
  '/odd.ts': (res) => send(res, 200, { 'content-type': 'video/mp2t', 'content-encoding': 'compress' }, 'ODDBYTES'),
  '/tiny.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n' + 'a\n'.repeat(1.9 * 1024 * 1024)),
  // 1 line with many short URIs under a long base address: must stop at the cap, not use up memory.
  '/bomb-redir.m3u8': (res) => send(res, 302, { location: `${LONG_DIR}/bomb.m3u8` }),
  [`${LONG_DIR}/bomb.m3u8`]: (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n#EXT-X-KEY:' + 'URI="a"'.repeat(550000)),   // under the 4 MB read limit
  // Links that do not parse, under the long base: the work cap must stop the rewrite early, so it
  // cannot block the server for long. (Under a short base the cap is not reached; this does not test that.)
  '/slow-redir.m3u8': (res) => send(res, 302, { location: `${LONG_DIR}/slow.m3u8` }),
  [`${LONG_DIR}/slow.m3u8`]: (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n' + '//[\n'.repeat(1000000)),   // under the 4 MB read limit, so the work cap is what stops it
  // Hosts a playlist names are learned only if its whole rewrite works. .invalid names never resolve.
  '/learns.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\nhttp://learned.invalid/seg.ts\n'),
  // 1 link of 3 million "/": under the 4 MB read limit, but over the rewrite cap (each "/" grows to %2F).
  // It must stay under MAX_PLAYLIST_BYTES: both limits answer "too large", and only the rewrite tests this.
  '/toolarge.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\nhttp://never.invalid/' + '/'.repeat(3000000)),
  '/xfoo.m3u8': (res) => send(res, 200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-encoding': 'x-foo' }, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
};
function send(res, code, headers, body) { res.writeHead(code, headers); res.end(body); }
const up = http.createServer((req, res) => (routes[new URL(req.url, 'http://x').pathname] || ((r) => send(r, 404, {})))(res, req));
await new Promise((ok, fail) => up.once('error', fail).listen(UP_PORT, LAN, ok));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'split-screen-test-'));
let srv;
let log = '';
let fails = 0;
try {
  writeState(tmp);
  fs.mkdirSync(path.join(tmp, 'media'));
  const env = { ...process.env, PORT: String(PORT), DISCOVERY_PORT: String(PORT + 9), OPEN_BROWSER: '0', TRAY: '0', INPUT_TTL_MS: '3000', SNAPSHOT_UPLOAD_TIMEOUT_MS: '500',
    STATE_FILE: path.join(tmp, 'state.json'), MEDIA_DIR: path.join(tmp, 'media') };
  srv = spawn(process.execPath, [server], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  let exited = false;
  srv.on('exit', () => { exited = true; });
  // Wait until this server (not another program) says it runs on PORT.
  for (let i = 0; i < 100 && !log.includes(`127.0.0.1:${PORT}/`); i++) {
    if (exited) throw new Error('Split Screen stopped at start:\n' + log.slice(-800));
    await new Promise((ok) => setTimeout(ok, 100));
  }
  if (!log.includes(`127.0.0.1:${PORT}/`)) throw new Error('Split Screen did not start on port ' + PORT + ':\n' + log.slice(-800));
  await runChecks();
  if (exited) { fails++; console.log('FAIL Split Screen stopped during the test:\n' + log.slice(-1500)); }
} catch (e) {
  fails++;
  console.log(`FAIL ${e.message}`);
} finally {
  if (srv) srv.kill();
  up.close();
  await new Promise((ok) => setTimeout(ok, 300));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (/TypeError|ReferenceError|Unhandled|heap out of memory/.test(log)) { fails++; console.log('Server log shows an error:\n' + log.slice(-1500)); }
if (fails) { console.log(`Relay server: ${fails} check(s) failed.`); process.exit(1); }
console.log('Relay server: all checks passed.');

async function runChecks() {
  // A timeout on every request, so a stuck answer fails the test instead of hanging it.
  const R = (target, init) => fetch(`http://127.0.0.1:${PORT}/relay?u=` + encodeURIComponent(target), { signal: AbortSignal.timeout(20000), ...init });
  const check = (name, ok, detail = '') => { if (!ok) { fails++; console.log(`FAIL ${name} (${detail})`); } };
  const isPlaylist = (r, body) => r.headers.get('content-type') === 'application/vnd.apple.mpegurl' && body.includes('/relay?u=');
  let r = await R(`${UP}/live.m3u8`); let b = await r.text();
  check('listed playlist relayed and rewritten', r.status === 200 && b.includes('/relay?u=' + encodeURIComponent(`${UP}/seg1.ts`)), r.status);
  check('no CORS header, sandboxed', !r.headers.get('access-control-allow-origin') && r.headers.get('content-security-policy') === 'sandbox', '');
  r = await R(`${UP}/seg1.ts`, { headers: { Range: 'bytes=0-3' } });
  check('segment with Range', r.status === 206 && (await r.text()) === 'SEGMENT' && r.headers.get('content-type') === 'video/mp2t', r.status);
  r = await R(`${UP}/seg1.ts`, { method: 'HEAD' }); check('HEAD', r.status === 200, r.status);

  // Rules 2 and 3: never this PC, the local network only for a listed window's own origin.
  for (const t of [`http://127.0.0.1:${PORT}/api/media`, `http://localhost:${PORT}/api/media`, `http://[::ffff:127.0.0.1]:${PORT}/api/info`,
    'http://10.0.0.1:80/x', 'http://169.254.169.254/latest', `http://localhost:${PORT}/`]) {
    r = await R(t); b = await r.text();
    check(`refused ${t}`, r.status === 403 && b.includes('Not relayed'), `${r.status} ${b.slice(0, 60)}`);
  }
  // Rule 4: every redirect hop is checked against its own host, not the listed one.
  for (const p of ['/redir-pc', '/redir-name', '/redir-lan']) { r = await R(UP + p); check(`redirect refused ${p}`, r.status === 403, r.status); }
  r = await R(`${UP}/redir-self`); check('redirect within listed host', r.status === 200 && (await r.text()) === 'SEGMENT', r.status);
  r = await R(`${UP}/redir-loop`); check('redirect loop stopped', r.status === 502, r.status);
  r = await R(`${UP}/redir-file`); check('redirect to file: refused', r.status === 502, r.status);
  r = await R('http://other.example/x'); check('unlisted host refused', r.status === 403, r.status);

  // A host named by a playlist that was rewritten is learned (it is fetched, so not 403). A host
  // named only by a playlist refused as too large is not learned (403).
  r = await R(`${UP}/learns.m3u8`); await r.text(); check('playlist rewritten', r.status === 200, r.status);
  // The checks look for "window list" (not learned), not the status: a DNS that answers made-up
  // names with a LAN address makes a learned host 403 too, by the local-network rule.
  r = await R('http://learned.invalid/seg.ts'); b = await r.text(); check('host of a rewritten playlist learned', !b.includes('window list'), `${r.status} ${b.slice(0, 60)}`);
  r = await R(`${UP}/toolarge.m3u8`); b = await r.text(); check('playlist over the rewrite cap refused', r.status === 502 && b.includes('too large'), `${r.status} ${b.slice(0, 60)}`);
  r = await R('http://never.invalid/x'); b = await r.text(); check('host of a refused playlist not learned', r.status === 403 && b.includes('window list'), `${r.status} ${b.slice(0, 60)}`);

  // Rule 5: nothing relayed can run.
  for (const p of ['/page', '/svg', '/mixed']) { r = await R(UP + p); check(`${p} as bytes`, r.headers.get('content-type') === 'application/octet-stream' && r.headers.get('x-content-type-options') === 'nosniff', r.headers.get('content-type')); }
  r = await R(`${UP}/subs.vtt`); check('subtitles pass', r.headers.get('content-type') === 'text/vtt', r.headers.get('content-type'));

  // Playlists by type and by name; segments named like playlists stream untouched.
  for (const p of ['/play?f=x.m3u8', '/mid?src=a.m3u8%3Ftoken%3D1', '/x.m3u8', '/s3.m3u8', '/gz.m3u8', '/none.m3u8', '/utf8?f=x.m3u8']) {
    r = await R(UP + p); b = await r.text(); check(`playlist rewritten ${p}`, isPlaylist(r, b) && !r.headers.get('content-encoding'), `${r.status} ${r.headers.get('content-type')}`);
  }
  r = await R(`${UP}/seg2.ts?pl=index.m3u8`); check('segment named like a playlist', r.headers.get('content-type') === 'video/mp2t' && (await r.text()) === 'TSDATA', r.headers.get('content-type'));
  r = await R(`${UP}/doc?x=.m3u8`); b = await r.text(); check('page named like a playlist', r.headers.get('content-type') === 'application/octet-stream' && b.startsWith('<p>'), r.headers.get('content-type'));
  r = await R(`${UP}/big.ts?pl=index.m3u8`); const big = await r.arrayBuffer(); check('5 MB segment streams', big.byteLength === 5 * 1024 * 1024, big.byteLength);
  r = await R(`${UP}/odd.ts?pl=x.m3u8`); b = await r.text(); check('unknown encoding segment streams on', b === 'ODDBYTES' && r.headers.get('content-encoding') === 'compress', r.headers.get('content-type'));
  r = await R(`${UP}/gzempty.m3u8`); check('empty gzip playlist', r.status === 200, r.status);
  r = await R(`${UP}/xfoo.m3u8`); b = await r.text();
  check('typed playlist in an unknown encoding gets 502', r.status === 502 && b.includes('x-foo'), `${r.status} ${b.slice(0, 60)}`);

  // HEAD on the sniff path answers and does not hang (Node drops any HEAD body itself).
  for (const p of ['/seg2.ts?pl=index.m3u8', '/none.m3u8']) {
    r = await R(UP + p, { method: 'HEAD' }); check(`HEAD ${p}`, r.status === 200, r.status);
  }

  // A slow rewrite must not block the server. /api/info is asked again and again until the slow
  // request ends, so one of the asks falls inside the rewrite whatever the PC's speed.
  let slowDone = false;
  // .catch after .then: it also catches a body read that fails, so no rejection is left unhandled.
  const slow = R(`${UP}/slow-redir.m3u8`)
    .then(async (x) => ({ status: x.status, body: await x.text() }))
    .catch((e) => ({ status: 0, body: e.message }))
    .finally(() => { slowDone = true; });
  let longest = 0;
  let infoOk = true;
  while (!slowDone) {
    const t1 = Date.now();
    try {
      const x = await fetch(`http://127.0.0.1:${PORT}/api/info`, { signal: AbortSignal.timeout(20000) });
      await x.arrayBuffer();
      infoOk &&= x.status === 200;
    } catch { infoOk = false; }
    longest = Math.max(longest, Date.now() - t1);
    await new Promise((ok) => setTimeout(ok, 20));
  }
  const s = await slow;
  // 1M links under the 8000-character base cost more than MAX_REWRITE_WORK, so it must stop early.
  check('rewrite of bad links stops at the work cap', s.status === 502 && s.body.includes('too large'), `${s.status} ${s.body.slice(0, 60)}`);
  check('server answers during a rewrite', infoOk && longest < 1500, `longest wait ${longest} ms`);

  // The rewrite cap: many short lines, and 1 line with many URIs under a long base address.
  for (const p of ['/tiny.m3u8', '/bomb-redir.m3u8']) {
    const t0 = Date.now(); r = await R(UP + p); b = await r.text();
    check(`playlist that would grow too large refused ${p}`, r.status === 502 && b.includes('too large'), `${r.status} ${Date.now() - t0} ms`);
  }

  // Playlist-read slots are given back on every path: after more reads than slots, one still works.
  for (let i = 0; i < 40; i++) await (await R(`${UP}/seg2.ts?pl=index.m3u8`)).arrayBuffer();
  for (let i = 0; i < 10; i++) await (await R(`${UP}/doc?x=.m3u8`)).arrayBuffer();
  r = await R(`${UP}/live.m3u8`); check('slots given back', r.status === 200, r.status);
  r = await fetch(`http://127.0.0.1:${PORT}/api/info`, { signal: AbortSignal.timeout(20000) }); check('server still answers', r.status === 200, r.status);

  // Last, because it replaces the window list: the Close pop-up count is kept only as a whole
  // number from 1 to 999999999.
  const pops = [3, 999999999, 0, -1, 1.5, 'x', 1e9];
  r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ layout: 'auto', solo: 'p0', windows: pops.map((popup, i) => ({ id: 'p' + i, url: `${UP}/page`, nonce: 0, popup, fill: [true, 1, 'true', false, null, {}, true][i] })) }) });
  const keptWins = r.status === 200 ? (await r.json()).windows : [];
  const kept = keptWins.map((w) => w.popup);
  check('Close pop-up count checked', JSON.stringify(kept) === JSON.stringify([3, 999999999, null, null, null, null, null]), `${r.status} ${JSON.stringify(kept)}`);
  // Video full screen is kept only as true, and only for the window shown alone (p0, not p6).
  const fills = keptWins.map((w) => w.fill);
  check('Video full screen checked', JSON.stringify(fills) === JSON.stringify([true, null, null, null, null, null, null]), JSON.stringify(fills));

  // Clicks and scrolls from the preview: checked, numbered, sent only to TVs, not saved, and
  // dropped by a change of the window list.
  const input = (o) => fetch(`http://127.0.0.1:${PORT}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o), signal: AbortSignal.timeout(20000) });
  const getState = async (q) => (await fetch(`http://127.0.0.1:${PORT}/api/state${q}`, { signal: AbortSignal.timeout(20000) })).json();
  const before = await getState('');
  const codes = [];
  for (const o of [{ id: 'p0', kind: 'tap', x: 0.25, y: 2 }, { id: 'p0', kind: 'scroll', x: 0.5, y: 0.5, dy: 9 },
    { id: 'nope', kind: 'tap', x: 0, y: 0 }, { id: 'p0', kind: 'tap', x: 'a', y: 0 }, { id: 'p0', kind: 'zoom', x: 0, y: 0 },
    { id: 'p0', kind: 'scroll', x: 0, y: 0, dy: 0 }, { id: 'p0', kind: 'scroll', x: 0, y: 0, dy: 0.0004 }]) {
    codes.push((await input(o)).status);
  }
  check('inputs checked', JSON.stringify(codes) === JSON.stringify([200, 200, 400, 400, 400, 400, 400]), JSON.stringify(codes));
  const plain = await getState('');
  check('inputs not sent to control pages, version kept', !('inputs' in plain) && plain.version === before.version, `${plain.version} ${before.version}`);
  const tv = await getState(`?tv=1&v=${before.version}&in=0`);
  const ins = tv.inputs || [];
  check('inputs sent to a TV at once', typeof tv.inputsFrom === 'string' && ins.length === 2 && ins[0].kind === 'tap' && ins[0].y === 1
    && ins[1].dy === 3 && ins[1].seq === ins[0].seq + 1 && !('at' in ins[0]), JSON.stringify(ins));
  // A TV page or older app (tv=1, no "in") still long-polls: no early answer, no inputs.
  const old = await Promise.race([
    fetch(`http://127.0.0.1:${PORT}/api/state?tv=1&v=${before.version}`, { signal: AbortSignal.timeout(2000) }).then(() => 'answered', () => 'aborted'),
    new Promise((ok) => setTimeout(() => ok('waiting'), 600)),
  ]);
  check('a TV without "in" keeps waiting', old === 'waiting', old);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  check('inputs not saved', !('inputs' in saved), Object.keys(saved).join(','));
  // They last INPUT_TTL_MS (3 s here), checked when sent: a TV that comes back later gets none.
  await new Promise((ok) => setTimeout(ok, 3200));
  const late = await getState(`?tv=1&in=0`);
  check('old inputs expire', Array.isArray(late.inputs) && late.inputs.length === 0, JSON.stringify(late.inputs));
  r = await input({ id: 'p0', kind: 'tap', x: 0.5, y: 0.5 });
  const waiting = await getState('?tv=1&in=0');
  check('a new input is sent', r.status === 200 && (waiting.inputs || []).length === 1, `${r.status} ${JSON.stringify(waiting.inputs)}`);
  // The TV's screen: only from the TV app (its address and key, from a tv=1&in&key poll), only
  // JPEG, only for the current list, shown to this PC (as soon as it comes). Not from another site.
  const KEY = '0123456789abcdef0123456789abcdef';
  await getState(`?tv=1&in=0&key=${KEY}`);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const ver = plain.version;
  const snapPost = (body, key = KEY, headers = {}, v = ver) => fetch(`http://127.0.0.1:${PORT}/api/screen?v=${v}&key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body, signal: AbortSignal.timeout(20000) });
  const screenGet = (after, headers = {}) => fetch(`http://127.0.0.1:${PORT}/api/screen?after=${after}`, { headers, signal: AbortSignal.timeout(20000) });
  const snapCodes = [(await snapPost(jpeg)).status, (await snapPost(Buffer.from('<svg/>'))).status,
    (await snapPost(jpeg, 'f'.repeat(32))).status, (await snapPost(jpeg, KEY, { Origin: 'https://evil.example' })).status,
    await snapPost(Buffer.alloc(700 * 1024, 0xff)).then((x) => x.status, () => 0)];   // too big: refused or cut off
  check('pictures checked', snapCodes[0] === 200 && snapCodes[1] === 400 && snapCodes[2] === 403 && snapCodes[3] === 403 && snapCodes[4] !== 200, JSON.stringify(snapCodes));
  r = await screenGet(0);
  const got = Buffer.from(await r.arrayBuffer());
  const seq1 = Number(r.headers.get('x-screen-seq'));
  check('picture shown to this PC', r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && got.equals(jpeg) && seq1 > 0, `${r.status} ${r.headers.get('content-type')}`);
  // A GET for the next picture waits, and gets it the moment it comes.
  const t0 = Date.now();
  const nextGet = screenGet(seq1);
  await new Promise((ok) => setTimeout(ok, 300));
  await snapPost(jpeg);
  r = await nextGet; await r.arrayBuffer();
  check('the next picture comes at once', r.status === 200 && Number(r.headers.get('x-screen-seq')) > seq1 && Date.now() - t0 < 2000, `${r.status} ${Date.now() - t0} ms`);
  // A number from before a restart (higher than any now) counts as 0: the current picture comes.
  r = await screenGet(1e9); await r.arrayBuffer();
  check('a number from an old run gets the current picture', r.status === 200, r.status);
  // Old 1.7 apps sent per-window pictures: told to stop.
  r = await fetch(`http://127.0.0.1:${PORT}/api/snapshot?id=p0`, { method: 'POST', body: jpeg, signal: AbortSignal.timeout(20000) });
  check('old per-window pictures are told to stop', r.status === 200 && (await r.json()).wanted === false, r.status);
  // Inputs on the whole screen: no window id; only the TV app holding the place gets them.
  const codesS = [(await input({ screen: true, kind: 'tap', x: 0.5, y: 0.5 })).status, (await input({ screen: true, kind: 'scroll', x: 0.5, y: 0.5, dy: 0.2 })).status];
  const forApp = ((await getState(`?tv=1&in=0&key=${KEY}`)).inputs || []).filter((i) => i.screen);
  const forOld = ((await getState('?tv=1&in=0')).inputs || []).filter((i) => i.screen);
  check('screen inputs only for the TV app', codesS.every((c) => c === 200) && forApp.length === 2 && !('id' in forApp[0]) && forOld.length === 0,
    `${codesS} ${forApp.length} ${forOld.length}`);
  // An upload cut off half-way (the TV lost Wi-Fi) does not block the next one.
  await new Promise((ok) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`POST /api/screen?v=${ver}&key=${KEY} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nContent-Type: image/jpeg\r\nContent-Length: 1000\r\n\r\n\xff\xd8\xff`);
      setTimeout(() => { sock.destroy(); setTimeout(ok, 200); }, 200);
    });
    sock.on('error', () => ok());
  });
  check('a cut-off upload does not block the next', (await snapPost(jpeg)).status === 200, '');
  // A stalled upload (the body stops coming, the connection stays open) is ended after
  // SNAPSHOT_UPLOAD_TIMEOUT_MS (500 ms here); then the next one works.
  const stalled = net.connect(PORT, '127.0.0.1', () => {
    stalled.write(`POST /api/screen?v=${ver}&key=${KEY} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nContent-Type: image/jpeg\r\nContent-Length: 1000\r\n\r\nab`);
  });
  stalled.on('error', () => {});
  await new Promise((ok) => setTimeout(ok, 300));
  check('a second upload waits its turn', (await snapPost(jpeg)).status === 429, '');
  await new Promise((ok) => setTimeout(ok, 700));
  check('a stalled upload does not block the next', (await snapPost(jpeg)).status === 200, '');
  stalled.destroy();
  // Another device does not take over while the TV app polls; the same device may change its key.
  const other = await fetch(`http://${LAN}:${PORT}/api/state?tv=1&in=0&key=${'e'.repeat(32)}`, { signal: AbortSignal.timeout(20000) });
  check('a poll from another address works', other.status === 200, other.status);
  check('the TV app keeps its place', (await snapPost(jpeg)).status === 200, '');
  const KEY2 = 'abcdef0123456789abcdef0123456789';
  await getState(`?tv=1&in=0&key=${KEY2}`);
  check('the TV app may change its key', (await snapPost(jpeg, KEY2)).status === 200 && (await snapPost(jpeg)).status === 403, '');
  r = await screenGet(0, { 'Sec-Fetch-Site': 'cross-site' });
  check('pictures not shown to another site', r.status === 403, r.status);
  check('the TV app is asked for pictures', (await getState(`?tv=1&in=0&key=${KEY2}`)).snap === true, '');
  check('other pollers are not asked', (await getState('?tv=1&in=0')).snap === false, '');
  // A picture taken for an older list is dropped without an error; a list change drops the
  // one kept, so the preview waits (204) instead of showing old windows.
  r = await fetch(`http://127.0.0.1:${PORT}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ layout: '1x1', windows: plain.windows }) });
  const after = await getState('?tv=1&in=0');
  check('a window list change drops inputs', r.status === 200 && Array.isArray(after.inputs) && after.inputs.length === 0, `${r.status} ${JSON.stringify(after.inputs)}`);
  const oldPic = await snapPost(jpeg, KEY2, {}, ver);   // ver is now 1 behind
  r = await screenGet(0);
  check('a list change drops the picture; an old one is not kept', oldPic.status === 200 && r.status === 204, `${oldPic.status} ${r.status}`);
  // Mouse moves: only the newest is kept, and only the TV app that holds the place gets them.
  await input({ id: 'p0', kind: 'move', x: 0.1, y: 0.1 });
  await input({ id: 'p0', kind: 'move', x: 0.2, y: 0.2 });
  const moves = ((await getState(`?tv=1&in=0&key=${KEY2}`)).inputs || []).filter((i) => i.kind === 'move');
  check('only the newest mouse move is kept', moves.length === 1 && moves[0].x === 0.2, JSON.stringify(moves));
  const noKey = ((await getState('?tv=1&in=0')).inputs || []).filter((i) => i.kind === 'move');
  check('no mouse moves for an app without a key', noKey.length === 0, JSON.stringify(noKey));
}
