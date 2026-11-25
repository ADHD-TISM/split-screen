'use strict';
const box = document.getElementById('server');
const msg = document.getElementById('msg');
serverAddress().then((s) => { box.value = s; });
document.getElementById('save').onclick = async () => {
  const v = box.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || DEFAULT_SERVER;
  if (!validServer(v)) { msg.textContent = 'Use 127.0.0.1:port or localhost:port.'; return; }
  await browser.storage.local.set({ server: v });
  try { await api('/api/info'); msg.textContent = 'Saved. Split Screen answers.'; }
  catch (e) { msg.textContent = 'Saved, but: ' + e.message; }
};
