// Right-click menus that send to the TV, and the stream finder.
'use strict';

// ---------- right-click menus ----------
function makeMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'page', title: 'Send this page to the TV', contexts: ['page', 'frame'] });
    browser.contextMenus.create({ id: 'link', title: 'Send this link to the TV', contexts: ['link'] });
    browser.contextMenus.create({ id: 'media', title: 'Send this video to the TV', contexts: ['video', 'audio'] });
    browser.contextMenus.create({ id: 'image', title: 'Send this image to the TV', contexts: ['image'] });
  });
}
browser.runtime.onInstalled.addListener(makeMenus);
browser.runtime.onStartup.addListener(makeMenus);

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  let url = info.menuItemId === 'link' ? info.linkUrl
    : info.menuItemId === 'media' || info.menuItemId === 'image' ? info.srcUrl
    : info.menuItemId === 'page' ? (info.frameUrl || info.pageUrl) : null;
  // A video often plays from a blob: address that only this browser has. Then send the page
  // (or the player frame) it is in: the TV opens it and plays the video there. Only for
  // videos: a link or image that is not a web address is not sent.
  if (info.menuItemId === 'media' && !sendable(url)) url = info.frameUrl || info.pageUrl;
  try {
    await sendToTv([url]);
    flash(tab, 'OK', '#3ecf8e', 'Sent to the TV');
  } catch (e) {
    flash(tab, '!', '#ff6b6b', 'Not sent: ' + e.message);
  }
});

// A short mark on the toolbar button (and its tooltip): sent, or why not.
function flash(tab, text, color, title) {
  const tabId = tab && tab.id >= 0 ? tab.id : undefined;
  if (tabId === undefined) return;
  browser.browserAction.setBadgeBackgroundColor({ color, tabId });
  browser.browserAction.setBadgeText({ text, tabId });
  browser.browserAction.setTitle({ title: 'Split Screen: ' + title, tabId });
  setTimeout(() => { browser.browserAction.setTitle({ title: null, tabId }); showStreamCount(tabId); }, 3000);
}

// ---------- stream finder ----------
// Off until turned on in the popup (it then asks Firefox for the "webRequest" and all-sites
// permissions). It notes the stream addresses a page loads, per tab, so the popup can send
// them. Nothing leaves this browser except what you send.
// Only what the TV can play: HLS playlists (.m3u8) and whole video files. Not DASH (.mpd),
// and not the pieces a player loads one after another (segments, byte ranges).
const MAX_FOUND = 30;
const PLAYLIST_TYPE = /mpegurl/i;
const PLAYLIST_NAME = /\.m3u8(\?|#|$)/i;
const VIDEO_NAME = /\.(mp4|webm|m4v|mov)(\?|#|$)/i;
const SEGMENT = /\.(ts|m4s|aac)(\?|#|$)|[?&](range|rn|bytes)=|\/(seg|segment|chunk|frag)[-_]?\d/i;

function onHeaders(d) {
  const header = (name) => { const h = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === name); return h ? String(h.value) : ''; };
  // A 206 is a byte range. A video element asks for "bytes=0-" first: that one starts the
  // file and counts. Later ranges are parts of the same file.
  if (d.tabId < 0 || (d.statusCode === 206 && !/^bytes 0-/i.test(header('content-range')))) return;
  const type = header('content-type').split(';')[0].trim().toLowerCase();
  // A playlist: from any request (also under a path like /segment1/). The TV plays it only
  // with .m3u8 in the link.
  if (PLAYLIST_NAME.test(d.url)) return note(d.tabId, d.url, 'Live stream (HLS)', true);
  if (SEGMENT.test(d.url) || type === 'video/mp2t' || type === 'video/iso.segment') return;
  if (PLAYLIST_TYPE.test(type)) return note(d.tabId, d.url, 'HLS playlist (may need .m3u8 in the link to play on the TV)', true);
  // A whole video file: only what the page plays as media, not the chunks a player fetches.
  if (d.type !== 'xmlhttprequest' && (VIDEO_NAME.test(d.url) || /^video\//.test(type))) return note(d.tabId, d.url, 'Video file', false);
}

// Writes for 1 tab run one after another, so 2 finds at once both stay.
const queues = new Map();
function inTurn(tabId, fn) {
  const next = (queues.get(tabId) || Promise.resolve()).then(fn, fn);
  queues.set(tabId, next.catch(() => {}));
  return next;
}
async function found(tabId) {
  const key = 'found:' + tabId;
  return (await browser.storage.session.get(key))[key] || [];
}
// The same stream again: low-latency HLS reloads its playlist with changing _HLS_ values.
// Only used to spot repeats: the link itself is kept and sent exactly as the page loaded it
// (signed links break if anything in them changes).
function sameKey(url) {
  const hash = url.indexOf('#'), base = hash < 0 ? url : url.slice(0, hash);
  const q = base.indexOf('?');
  if (q < 0) return base;
  const kept = base.slice(q + 1).split('&').filter((p) => p && !/^_HLS_/i.test(p));
  return base.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
}
function note(tabId, url, kind, playlist) {
  if (!sendable(url)) return;
  const key = sameKey(url);
  return inTurn(tabId, async () => {
    const list = await found(tabId);
    if (list.some((f) => sameKey(f.url) === key)) return;
    // Playlists come first and are never pushed out by video files.
    const item = { url, kind, playlist, at: Date.now() };
    const playlists = list.filter((f) => f.playlist), files = list.filter((f) => !f.playlist);
    const next = playlist ? [item, ...playlists, ...files] : [...playlists, item, ...files];
    await browser.storage.session.set({ ['found:' + tabId]: next.slice(0, MAX_FOUND) });
    showStreamCount(tabId);
  });
}

// Added at once when the background starts, as Firefox needs to wake it for these events
// later. With the permission missing, browser.webRequest does not exist and nothing is added.
const FILTER = { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'sub_frame'] };
function startFinder() {
  if (browser.webRequest && !browser.webRequest.onHeadersReceived.hasListener(onHeaders)) {
    browser.webRequest.onHeadersReceived.addListener(onHeaders, FILTER, ['responseHeaders']);
  }
}
startFinder();
browser.permissions.onAdded.addListener(startFinder);   // turned on in this session
browser.permissions.onRemoved.addListener(async () => {
  if (browser.webRequest) browser.webRequest.onHeadersReceived.removeListener(onHeaders);
  // Turned off: forget what was found, and clear the counts on the toolbar button.
  const all = await browser.storage.session.get(null);
  // Every tab with a list, or with a write still running (its first find may not be stored
  // yet). In turn with those writes, so none puts a list back.
  const tabs = new Set([...queues.keys(), ...Object.keys(all).filter((x) => x.startsWith('found:')).map((k) => Number(k.slice(6)))]);
  for (const tabId of tabs) {
    inTurn(tabId, () => browser.storage.session.remove('found:' + tabId)).then(() => showStreamCount(tabId));
  }
});

// A page loading in a tab (a new one, or a reload) starts a new list.
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') {
    inTurn(tabId, () => browser.storage.session.remove('found:' + tabId)).then(() => showStreamCount(tabId));
  }
}, { properties: ['status', 'url'] });
browser.tabs.onRemoved.addListener((tabId) => inTurn(tabId, () => browser.storage.session.remove('found:' + tabId)));

async function showStreamCount(tabId) {
  if (tabId === undefined) return;
  const n = (await found(tabId)).length;
  browser.browserAction.setBadgeBackgroundColor({ color: '#4f8cff', tabId });
  browser.browserAction.setBadgeText({ text: n ? String(n) : '', tabId }).catch(() => {});   // the tab may be gone
}
