// The toolbar popup: send the tab, control the windows, watch the TV, send found streams.
'use strict';

const $ = (id) => document.getElementById(id);
const LAYOUTS = [['auto', 'Auto'], ['1x1', '1'], ['2x1', '2 side'], ['1x2', '2 stack'], ['2x2', '2×2'],
  ['3x2', '3×2'], ['3x3', '3×3'], ['4x4', '4×4'], ['featured', '1 big + 4'], ['pip', 'PiP'], ['free', 'Free']];
let state = null;
let tab = null;

function showError(e) { $('err').textContent = e ? (e.message || String(e)) : ''; $('err').className = 'err'; }
// A short "done" line in the same place, gone after 4 s.
function showDone(text) {
  $('err').textContent = text; $('err').className = 'done';
  setTimeout(() => { if ($('err').textContent === text) $('err').textContent = ''; }, 4000);
}
async function run(fn) {
  showError(null);
  try { await fn(); } catch (e) { showError(e); }
}

// ---------- tabs of the popup ----------
let current = 'send';
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => showTab(b.dataset.tab);
}
function showTab(name) {
  current = name;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== name;
  // The preview plays only while its tab is shown.
  serverBase().then((base) => { $('previewFrame').src = name === 'preview' ? base + '/tv?preview=1' : 'about:blank'; });
  if (name === 'windows') refresh();
  if (name === 'streams') showStreams();
  browser.storage.local.set({ popupTab: name });
}

// ---------- connection ----------
async function refresh() {
  try {
    const [s, info] = await Promise.all([getState(), api('/api/info')]);
    state = s;
    const tv = info.tvSecondsAgo !== null && info.tvSecondsAgo < 40;
    setStatus(tv ? 'ok' : 'bad', tv ? '● TV connected' : '● TV not connected yet', ' · ' + s.windows.length + ' of ' + MAX_WINDOWS + ' windows');
    renderWindows();
  } catch (e) {
    setStatus('bad', '● ' + e.message, '');
  }
}
function setStatus(cls, text, rest) {
  const span = document.createElement('span'); span.className = cls; span.textContent = text;
  $('status').replaceChildren(span, rest);
}

// ---------- Send ----------
async function showTab0() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  $('tabTitle').textContent = tab && tab.title || '';
  $('tabUrl').textContent = tab && tab.url || '';
  const ok = tab && sendable(tab.url);
  $('addTab').disabled = $('replaceTab').disabled = !ok;
  if (!ok) $('tabUrl').textContent += '  (this page cannot go to the TV)';
}
$('addTab').onclick = () => run(async () => { await sendToTv([tab.url]); showDone('Sent to the TV.'); refresh(); });
// Popups cannot show a confirm box, so Replace all asks for a 2nd click within 4 s.
let replaceTimer = null;
const disarm = () => { clearTimeout(replaceTimer); replaceTimer = null; $('replaceTab').textContent = 'Replace all'; };
$('replaceTab').onclick = () => run(async () => {
  if (!replaceTimer) {
    $('replaceTab').textContent = 'Click again to replace all';
    replaceTimer = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  await sendToTv([tab.url], true); showDone('The TV shows only this page now.'); refresh();
});

// ---------- Windows ----------
const update = (fn) => run(async () => {
  const s = await getState();
  const next = { layout: s.layout, audio: s.audio, solo: s.solo, windows: s.windows };
  fn(next);
  if (next.layout === 'free') fillRects(next.windows);
  state = await saveState(next);
  renderWindows();
  refresh();   // the window count in the status line
});

function renderWindows() {
  const lay = $('layouts'); lay.textContent = '';
  for (const [key, label] of LAYOUTS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = state && state.layout === key ? 'on' : '';
    b.onclick = () => update((n) => { n.layout = key; });
    lay.append(b);
  }
  const box = $('wins'); box.textContent = '';
  if (!state || !state.windows.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No windows yet. Send a page to the TV.'; box.append(e);
    return;
  }
  state.windows.forEach((w, i) => {
    const row = document.createElement('div'); row.className = 'win';
    const num = document.createElement('div'); num.className = 'num'; num.textContent = i + 1;
    const mid = document.createElement('div');
    const u = document.createElement('div'); u.className = 'url'; u.textContent = w.url; u.title = w.url;
    const k = document.createElement('div'); k.className = 'kind'; k.textContent = kindOf(w.url);
    mid.append(u, k);
    const tools = document.createElement('div'); tools.className = 'tools';
    const btn = (label, title, fn, on) => {
      const b = document.createElement('button'); b.textContent = label; b.title = title;
      if (on) b.className = 'on';
      b.onclick = fn; tools.append(b);
    };
    btn('🔊', 'Sound from this window', () => update((n) => { n.audio = n.audio === w.id ? null : w.id; }), state.audio === w.id);
    btn('⛶', 'Show only this window', () => update((n) => { n.solo = n.solo === w.id ? null : w.id; }), state.solo === w.id);
    btn('↻', 'Reload this window', () => update((n) => { const x = n.windows.find((v) => v.id === w.id); if (x) x.nonce++; }));
    btn('✕', 'Remove', () => update((n) => {
      n.windows = n.windows.filter((v) => v.id !== w.id);
      if (n.audio === w.id) n.audio = null;
      if (n.solo === w.id) n.solo = null;
    }));
    row.append(num, mid, tools); box.append(row);
  });
}
$('muteAll').onclick = () => update((n) => { n.audio = null; });
$('openControl').onclick = async () => { browser.tabs.create({ url: await serverBase() + '/' }); window.close(); };

// ---------- Streams ----------
const FINDER = { permissions: ['webRequest'], origins: ['<all_urls>'] };

async function showStreams() {
  const on = await browser.permissions.contains(FINDER);
  $('finderOff').hidden = on;
  $('finderOn').hidden = !on;
  if (!on || !tab) return;
  const key = 'found:' + tab.id;
  const list = (await browser.storage.session.get(key))[key] || [];
  $('streamCount').textContent = list.length ? '(' + list.length + ')' : '';
  const box = $('found'); box.textContent = '';
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No streams found on this page yet. Start the video, then look again.'; box.append(e);
    return;
  }
  for (const f of list) {
    const row = document.createElement('div'); row.className = 'found';
    const mid = document.createElement('div');
    const u = document.createElement('div'); u.className = 'url'; u.textContent = f.url; u.title = f.url;
    const k = document.createElement('div'); k.className = 'kind'; k.textContent = f.kind || kindOf(f.url);
    mid.append(u, k);
    const b = document.createElement('button'); b.textContent = 'Send';
    b.onclick = () => run(async () => { await sendToTv([f.url]); showDone('Stream sent to the TV.'); });
    row.append(mid, b); box.append(row);
  }
}
// The permission request must be the first thing the click does (Firefox's rule).
$('finderEnable').onclick = async () => {
  const ok = await browser.permissions.request(FINDER);
  if (ok) showDone('Stream finder on. Reload the page with the video.');
  showStreams();
};
$('finderDisable').onclick = async (e) => {
  e.preventDefault();
  await browser.permissions.remove(FINDER);
  showStreams();
};

// ---------- start ----------
(async () => {
  await showTab0();
  const { popupTab } = await browser.storage.local.get('popupTab');
  const first = ['send', 'windows', 'preview', 'streams'].includes(popupTab) ? popupTab : 'send';
  showTab(first);
  if (first !== 'windows') refresh();   // the Windows tab refreshes itself
  if (tab) {
    const key = 'found:' + tab.id;
    const list = (await browser.storage.session.get(key))[key] || [];
    $('streamCount').textContent = list.length ? '(' + list.length + ')' : '';
  }
})();
