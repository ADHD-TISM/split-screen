// Checks the relay's address and type rules in server.js (see "relay rules" there).
// Run: npm test   (or: node test/relay-rules.mjs)
// server.js starts a server when it loads, so this test does not import it. It cuts out the code
// between the 2 "relay rules" lines and runs it with stand-ins for this PC's network and the
// window list. Keep those 2 lines in server.js.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf('// ---- relay rules: start');
const end = src.indexOf('// ---- relay rules: end ----');
if (start < 0 || end < start) throw new Error('The "relay rules" lines are missing in server.js.');
const block = src.slice(start, end);

// This PC: one IPv4 address, one public IPv6 address (its /64 counts as local) and a link-local one.
const os = { networkInterfaces: () => ({ eth: [
  { address: '192.168.1.50', family: 'IPv4', internal: false },
  { address: '2001:db8:aa:bb:1:2:3:4', family: 'IPv6', internal: false },
  { address: 'fe80::1', family: 'IPv6', internal: false },
] }) };
const state = { windows: ['http://192.168.1.20/x', 'http://cam.lan/x', 'http://example.com/x', 'https://nas.local:5001/x'].map((url, i) => ({ id: 'w' + i, url })) };
const learnedHosts = new Set(['cdn.example.net']);
// A stand-in DNS: each name answers with the addresses listed here. Like the real dns.lookup, it
// answers a list only with all: true, so the test also fails if relayLookup stops asking for all.
const answers = {
  'mixed.example': ['127.0.0.1', '192.168.1.30', '93.184.216.34'],
  'lan-only.example': ['192.168.1.30', 'fd00::5'],
  'loop-only.example': ['127.0.0.1', '::1'],
  'public.example': ['93.184.216.34', '2606:4700::1111'],
};
const dns = { lookup: (name, options, cb) => {
  const list = answers[name];
  if (!list) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  const family = (address) => (net.isIPv6(address) ? 6 : 4);
  if (options.all) cb(null, list.map((address) => ({ address, family: family(address) })));
  else cb(null, list[0], family(list[0]));
} };
// 'use strict': server.js is an ES module, so its code runs strict there too.
const rules = new Function('os', 'net', 'dns', 'state', 'learnedHosts', `'use strict';
  ${block}
  return { isPrivateIp, isLoopbackIp, localStyleHost, privateAllowed, relayAllowed, listedHost, relayType,
    relayLookup, literalRefused, learnHost };`)(os, net, dns, state, learnedHosts);

let fails = 0;
const check = (name, got, want) => {
  if (got !== want) { fails++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
};

// This PC itself: refused always, also in IPv6 and short forms.
for (const ip of ['127.0.0.1', '127.9.9.9', '0.0.0.0', '::', '::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '::127.0.0.1', '0:0:0:0:0:0:0:1']) {
  check(`loopback ${ip}`, rules.isLoopbackIp(ip), true);
}
for (const ip of ['192.168.1.20', '10.0.0.1', '8.8.8.8', '::ffff:c0a8:114', '2001:db8:aa:bb::9']) {
  check(`not loopback ${ip}`, rules.isLoopbackIp(ip), false);
}

// The local network, this PC's own addresses, reserved ranges, and IPv4 hidden in IPv6.
for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.0.1',
  '192.0.0.8', '198.18.0.1', '198.19.255.1', '224.0.0.1', '255.255.255.255', '0.1.2.3', '127.0.0.1', '192.168.1.50',
  '::ffff:c0a8:101', '::ffff:10.0.0.1', '64:ff9b::a00:1', '64:ff9b::192.168.1.1', '2002:c0a8:101::1', 'fc00::1', 'fd12::1',
  'fe80::abcd', 'fec0::1', 'ff02::1', '2001:db8:aa:bb::1', '2001:db8:aa:bb:ffff::ffff', 'not-an-address']) {
  check(`private ${ip}`, rules.isPrivateIp(ip), true);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '198.20.0.1', '192.0.1.1', '2606:4700::1111',
  '2001:db8:aa:bc::1', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8']) {
  check(`public ${ip}`, rules.isPrivateIp(ip), false);
}

// Names that count as local, and public names that only look local.
for (const h of ['http://192.168.1.20/', 'http://[fd00::1]/', 'http://nas/', 'http://nas.local/', 'http://nas.local./',
  'http://cam.lan:8080/', 'http://x.home.arpa/', 'http://box.internal/', 'http://cam.fritz.box/', 'http://nas.home/',
  'http://x.localdomain/', 'http://y.intranet/']) {
  check(`local name ${h}`, rules.localStyleHost(new URL(h)), true);
}
for (const h of ['http://example.com/', 'http://cdn.example.co.uk/', 'http://evil.local.example.com/', 'http://a.lan.evil.com/']) {
  check(`public name ${h}`, rules.localStyleHost(new URL(h)), false);
}

// Private addresses only for a listed window's own scheme, host and port with a local name.
check('listed LAN address', rules.privateAllowed(new URL('http://192.168.1.20/a')), true);
check('listed local name', rules.privateAllowed(new URL('http://cam.lan/live.m3u8')), true);
check('listed https local name and port', rules.privateAllowed(new URL('https://nas.local:5001/seg.ts')), true);
check('listed public name', rules.privateAllowed(new URL('http://example.com/a')), false);
check('unlisted LAN address', rules.privateAllowed(new URL('http://192.168.1.21/a')), false);
check('listed host, https instead of http', rules.privateAllowed(new URL('https://192.168.1.20/a')), false);
check('listed host, other port', rules.privateAllowed(new URL('http://cam.lan:81/')), false);
check('listed https host, other port', rules.privateAllowed(new URL('https://nas.local:5002/')), false);

// Which hosts the relay fetches at all.
check('listed host', rules.relayAllowed(new URL('http://cam.lan/x')), true);
check('learned host', rules.relayAllowed(new URL('https://cdn.example.net/seg.ts')), true);
check('unknown host', rules.relayAllowed(new URL('http://other.example/')), false);
check('not a web address', rules.relayAllowed(new URL('file:///C:/Windows/win.ini')), false);

// Literal addresses (Node skips the DNS lookup for them): this PC never, the local network only if allowed.
for (const [href, allowPrivate, want] of [
  ['http://127.0.0.1:8090/api/media', true, true], ['http://[::1]/', true, true], ['http://[::ffff:7f00:1]/', true, true],
  ['http://0.0.0.0/', true, true], ['http://192.168.1.20/', false, true], ['http://[fd00::1]/', false, true],
  ['http://192.168.1.50/', false, true], ['http://192.168.1.20/', true, false], ['http://93.184.216.34/', false, false],
  ['http://cam.lan/', false, false],   // a name: checked in the DNS lookup instead
]) {
  check(`literal ${href} (private ${allowPrivate})`, rules.literalRefused(new URL(href), allowPrivate), want);
}

// The DNS lookup: drops this PC always and the local network unless allowed (DNS rebinding).
const lookup = (name, allowPrivate, all) => new Promise((resolve) => {
  rules.relayLookup(allowPrivate)(name, { all }, (err, a, family) => resolve(err ? err.code : all ? a.map((x) => x.address).join(',') : `${a}/${family}`));
});
for (const [name, allowPrivate, all, want] of [
  ['mixed.example', false, true, '93.184.216.34'],
  ['mixed.example', true, true, '192.168.1.30,93.184.216.34'],
  ['mixed.example', false, false, '93.184.216.34/4'],
  ['lan-only.example', false, true, 'EPRIVATE'],
  ['lan-only.example', true, true, '192.168.1.30,fd00::5'],
  ['loop-only.example', true, true, 'EPRIVATE'],
  ['public.example', false, true, '93.184.216.34,2606:4700::1111'],
  ['missing.example', false, true, 'ENOTFOUND'],
]) {
  check(`lookup ${name} (private ${allowPrivate}, all ${all})`, await lookup(name, allowPrivate, all), want);
}

// Only bare media types pass; everything else goes out as bytes.
for (const [raw, want] of [
  ['video/mp4', 'video/mp4'], ['Video/MP2T; charset=x', 'video/mp2t'], [' audio/aac ', 'audio/aac'],
  ['application/vnd.apple.mpegurl', 'application/vnd.apple.mpegurl'], ['application/mp2t', 'application/mp2t'],
  ['text/vtt', 'text/vtt'], ['binary/octet-stream', 'binary/octet-stream'],
  ['video/x+xml', 'application/octet-stream'], ['audio/svg+xml', 'application/octet-stream'],
  ['video/mp4, text/html', 'application/octet-stream'], ['audio/x,text/html', 'application/octet-stream'],
  ['video/', 'application/octet-stream'], ['video/../text/html', 'application/octet-stream'],
  ['text/html', 'application/octet-stream'], ['image/svg+xml', 'application/octet-stream'],
  ['', 'application/octet-stream'], [undefined, 'application/octet-stream'],
]) {
  check(`type ${JSON.stringify(raw)}`, rules.relayType(raw), want);
}

// Learned hosts: at most 500, the one learned longest ago goes first, one learned again stays.
// Last, because it empties the learned hosts the checks above use.
learnedHosts.clear();
for (let i = 0; i < 500; i++) rules.learnHost('h' + i);
rules.learnHost('h0');   // learned again: moves to the end
rules.learnHost('new');
check('learned hosts stay at 500', learnedHosts.size, 500);
check('host learned longest ago is dropped', learnedHosts.has('h1'), false);
check('host learned again stays', learnedHosts.has('h0'), true);
check('newest host is kept', learnedHosts.has('new'), true);
rules.learnHost('h2');   // already learned: nothing is dropped
check('learning a known host drops none', learnedHosts.size === 500 && learnedHosts.has('h3'), true);

if (fails) { console.log(`${fails} check(s) failed.`); process.exit(1); }
console.log('Relay rules: all checks passed.');
