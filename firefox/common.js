// Shared by the background script and the popup: talking to Split Screen on this PC.
'use strict';

const DEFAULT_SERVER = '127.0.0.1:8090';
const MAX_WINDOWS = 16;

// "host:port" of Split Screen, from the options page. Only this PC (127.0.0.1 or localhost):
// Split Screen takes control from this PC only, and the extension may only reach these hosts.
async function serverAddress() {
  const { server } = await browser.storage.local.get('server');
  return validServer(server) ? server : DEFAULT_SERVER;
}
function validServer(s) {
  const m = typeof s === 'string' && /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 65535;
}
async function serverBase() { return 'http://' + await serverAddress(); }

// A JSON request to Split Screen. Throws with the server's message on an error.
async function api(path, options = {}) {
  const base = await serverBase();
  let r;
  try {
    // 5 s at most: while Split Screen is stopping it leaves requests waiting.
    r = await fetch(base + path, { cache: 'no-store', signal: AbortSignal.timeout(5000), ...options });
  } catch {
    throw new Error('Split Screen is not running on this PC (' + base.replace('http://', '') + ').');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function getState() {
  const s = await api('/api/state');
  if (!s || !Array.isArray(s.windows)) throw new Error('Another program answers on this port, not Split Screen.');
  return s;
}
const saveState = (next) => api('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });

function newId() {
  return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '') || String(Date.now());
}

// Only web addresses can play on the TV: a blob:, data: or file: link exists only in this
// browser.
function sendable(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 2048;
}

// Adds windows to the TV (or replaces all of them). Returns how many were added.
async function sendToTv(urls, replace = false) {
  const list = urls.filter(sendable);
  if (!list.length) throw new Error('Only http:// and https:// addresses can go to the TV.');
  const s = await getState();
  const next = { layout: s.layout, audio: s.audio, solo: s.solo, windows: s.windows };
  if (replace) { next.windows = []; next.audio = null; next.solo = null; }
  const room = MAX_WINDOWS - next.windows.length;
  if (room <= 0) throw new Error('The TV already has ' + MAX_WINDOWS + ' windows. Remove one first.');
  const added = list.slice(0, room);
  next.windows = next.windows.concat(added.map((url) => ({ id: newId(), url, nonce: 0 })));
  if (!next.audio && next.windows.length) next.audio = next.windows[0].id;
  if (next.layout === 'free') fillRects(next.windows);
  await saveState(next);
  return added.length;
}

// Free layout: a window with no place gets a grid cell, on top (as the control page does).
function fillRects(wins) {
  const n = wins.length;
  const [c, r] = n <= 1 ? [1, 1] : n === 2 ? [2, 1] : n <= 4 ? [2, 2] : n <= 6 ? [3, 2] : n <= 9 ? [3, 3] : [4, 4];
  let top = Math.max(0, ...wins.map((w) => w.z || 0));
  wins.forEach((w, i) => {
    if (!w.rect) w.rect = { x: (i % c) / c, y: (Math.floor(i / c) % r) / r, w: 1 / c, h: 1 / r };
    if (w.z == null) w.z = ++top;
  });
}

// What a link is, as on the control page.
function kindOf(url) {
  if (url.startsWith('/media/')) return 'File on the PC';
  try {
    const u = new URL(url); const h = u.hostname.replace(/^(www|m)\./, '');
    if (/(^|\.)youtube(-nocookie)?\.com$|^youtu\.be$/.test(h)) return 'YouTube';
    if (/(^|\.)vimeo\.com$/.test(h)) return 'Vimeo';
    if (/\.m3u8/i.test(u.pathname + u.search)) return 'Live stream (HLS)';
    if (/\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(u.pathname)) return 'Video file';
    if (/\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(u.pathname)) return 'Audio file';
    if (/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(u.pathname)) return 'Image';
    return 'Web page';
  } catch { return 'Link'; }
}
