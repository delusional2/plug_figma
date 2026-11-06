#!/usr/bin/env node
// End-to-end check of the two import paths that don't go through pasted HTML:
//
// 1. Bookmarklet: builds bookmarklet.html, opens dev/cases/<case>.html as a normal page
//    (real origin, no stage), runs the bookmarklet's code there, takes the JSON payload
//    it would copy, converts it the way the plugin UI does and builds it under
//    dev/mock-figma.js. The payload is also re-rendered with dev/render.html.
// 2. Import by link: dev/runner.html?url= fetches dev/fixtures/url-page (relative CSS,
//    images and script) and adds <base href> like ui.html's fetchPage().
//
//   node dev/test-import.mjs                    # landing, media-images, robust-dashboard
//   node dev/test-import.mjs gen-lists -w 390   # other cases / width
//
// Outputs: dev/out/<case>.bm.json, dev/out/<case>.bm.render.png, dev/out/url-page.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dev', 'out');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
let width = 1440;
const names = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-w') width = +argv[++i];
  else names.push(argv[i]);
}
if (!names.length) names.push('landing', 'media-images', 'robust-dashboard');
fs.mkdirSync(OUT, { recursive: true });

execFileSync('node', [path.join(ROOT, 'dev', 'build-bookmarklet.mjs')], { stdio: 'inherit' });
const page = fs.readFileSync(path.join(ROOT, 'bookmarklet.html'), 'utf8');
const href = /class="bm" href="([^"]*)"/.exec(page)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
if (!href.startsWith('javascript:')) throw new Error('no javascript: link in bookmarklet.html');
// What the browser runs when the bookmark is clicked.
const code = decodeURIComponent(href.slice('javascript:'.length));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'h2f-bm-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-quic', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = /ws:\/\/[^\s]+/.exec(buf); if (m) resolve(m[0]); });
  setTimeout(() => reject(new Error('chrome did not start')), 15000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let msgId = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  else listeners.forEach((l) => l(m));
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url, w, h) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const loaded = new Promise((r) => { const l = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
  await s('Page.navigate', { url });
  await Promise.race([loaded, sleep(30000)]);
  return {
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
      return r.result.value;
    },
    async wait(expr, ms) {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) { const v = await this.eval(expr); if (v) return v; }
      throw new Error("timeout; box says: " + (await this.eval("(() => { const h = document.querySelector('[data-h2f-ui]'); const r = h && (h.shadowRoot || h); return r ? r.querySelector(\'.m\').textContent + \' | busy=\' + window.__h2fBusy : 'no box'; })()")));
    },
    async read(expr) {
      const len = await this.eval(`${expr}.length`);
      let out = '';
      for (let i = 0; i < len; i += 4e6) out += await this.eval(`${expr}.slice(${i}, ${i + 4e6})`);
      return out;
    },
    async shot(w, h) {
      await s('Emulation.setDeviceMetricsOverride', { width: w, height: Math.min(h, 16000), deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      return (await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 16000), scale: 1 } })).data;
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
}

const mock = (file) => {
  try { return execFileSync('node', [path.join(ROOT, 'dev', 'mock-figma.js'), path.join(ROOT, 'code.js'), file], { encoding: 'utf8' }); } catch (e) { return 'MOCK CRASH ' + (e.stderr || e.message); }
};
const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
const rows = [];
let failed = false;

try {
  for (const name of names) {
    const row = { test: 'bookmarklet ' + name + (width !== 1440 ? '@' + width : '') };
    try {
      const p = await open(`${BASE}/dev/cases/${name}.html`, width, 900);
      await sleep(500);
      await p.eval(code);
      const shown = await p.wait("(() => { const h = document.querySelector('[data-h2f-ui]'); const r = h && (h.shadowRoot || h); const m = r && r.querySelector('.m'); return window.__h2fLast ? (m ? m.textContent : 'no box') : (m && /Ошибка/.test(m.textContent) ? m.textContent : ''); })()", 180000);
      if (/^Ошибка/.test(shown)) throw new Error(shown);
      const json = await p.read('window.__h2fLast');
      const left = await p.eval("document.querySelectorAll('h2f-pseudo,[data-h2f-b],[data-h2f-a]').length");
      await p.close();
      const payload = JSON.parse(json);
      if (payload.h2f !== 1 || !payload.root) throw new Error('bad payload');
      // Same conversion as ui.html payloadDoc(); the mock takes base64 bytes directly.
      const doc = { name: payload.name, root: payload.root, images: payload.images.map((im) => ({ ref: im.ref, url: im.url, bytes: im.base64 || null, same: im.same })) };
      const file = path.join(OUT, `${name}${width !== 1440 ? '@' + width : ''}.bm.json`);
      fs.writeFileSync(file, JSON.stringify(doc));
      const m = mock(file);
      const r = await open(`${BASE}/dev/render.html`, width, 900);
      const size = await r.eval(`renderTree(${JSON.stringify(JSON.stringify(doc))})`);
      await sleep(300);
      fs.writeFileSync(file.replace(/\.json$/, '.render.png'), Buffer.from(await r.shot(size.w, size.h), 'base64'));
      await r.close();
      Object.assign(row, {
        ok: /errors: none/.test(m) && left === 0,
        layers: count(payload.root), images: payload.images.length,
        imagesMissing: payload.images.filter((i) => !i.base64 && !i.same).length,
        payloadKB: Math.round(json.length / 1024), pageLeftovers: left,
        box: shown.slice(0, 60), mock: /errors: none/.test(m) ? 'ok' : m.slice(0, 300),
      });
    } catch (e) {
      Object.assign(row, { ok: false, error: String(e.message || e).slice(0, 300) });
    }
    if (!row.ok) failed = true;
    rows.push(row);
  }

  // Import by link.
  const row = { test: 'url dev/fixtures/url-page' };
  try {
    const p = await open(`${BASE}/dev/runner.html?url=${encodeURIComponent('/dev/fixtures/url-page/index.html')}&w=1024&h=700`, 1024, 700);
    const json = await p.wait('window.__result', 120000);
    await p.close();
    const doc = JSON.parse(json);
    if (doc.error) throw new Error(doc.error);
    const file = path.join(OUT, 'url-page.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    const flat = JSON.stringify(doc.root);
    // style.css: hero rgb(18, 52, 86); app.js adds the " ✓" pseudo; three relative images.
    const cssOk = /"r":0\.0705\d*,"g":0\.2039\d*,"b":0\.3372\d*/.test(flat);
    const jsOk = flat.includes('✓');
    const imgs = doc.images.filter((i) => i.bytes || i.same).length;
    const vectors = (flat.match(/"type":"SVG"/g) || []).length;
    // The same file under two URLs is sent once (the copy names the first in "same").
    const deduped = doc.images.filter((i) => i.same).length;
    const m = mock(file);
    Object.assign(row, { ok: cssOk && jsOk && imgs + vectors >= 3 && deduped === 1 && /errors: none/.test(m), css: cssOk, script: jsOk, images: imgs, deduped, svgVectors: vectors, mock: /errors: none/.test(m) ? 'ok' : m.slice(0, 300) });
  } catch (e) {
    Object.assign(row, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
  if (!row.ok) failed = true;
  rows.push(row);

  // The plugin window itself (ui.html opened as a page: parent === window, so the
  // message meant for code.js is caught here): a pasted bookmarklet payload and a link.
  for (const kind of ['payload', 'url']) {
    const row = { test: 'ui.html ' + kind };
    try {
      const p = await open(`${BASE}/ui.html`, 420, 640);
      await p.eval(`(() => {
        window.__sent = null;
        const post = window.postMessage.bind(window);
        window.postMessage = function (m, o, t) { if (m && m.pluginMessage && m.pluginMessage.type === 'import') window.__sent = m.pluginMessage.doc; else post(m, o, t); };
      })()`);
      if (kind === 'payload') {
        const bm = JSON.parse(fs.readFileSync(path.join(OUT, `${names[0]}${width !== 1440 ? '@' + width : ''}.bm.json`), 'utf8'));
        const payload = { h2f: 1, name: bm.name, root: bm.root, images: bm.images.map((i) => ({ ref: i.ref, url: i.url, base64: i.bytes, same: i.same })) };
        await p.eval(`document.getElementById('html').value = ${JSON.stringify(JSON.stringify(payload))}; document.getElementById('go').click();`);
      } else {
        await p.eval(`document.getElementById('url').value = ${JSON.stringify(BASE + '/dev/fixtures/url-page/index.html')}; document.getElementById('go').click();`);
      }
      const res = await p.wait(`window.__sent ? JSON.stringify({ name: window.__sent.name, layers: (function n(x) { return 1 + (x.children || []).reduce((a, c) => a + n(c), 0); })(window.__sent.root), bytes: window.__sent.images.filter((i) => i.bytes instanceof Uint8Array).length, images: window.__sent.images.length }) : (/Ошибка/.test(document.getElementById('status').textContent) ? 'ERR ' + document.getElementById('status').textContent : '')`, 120000);
      await p.close();
      if (/^ERR /.test(res)) throw new Error(res);
      const r = JSON.parse(res);
      Object.assign(row, { ok: r.layers > 3 && (kind === 'url' ? r.bytes >= 2 : true), layers: r.layers, images: r.images, box: r.name });
    } catch (e) {
      Object.assign(row, { ok: false, error: String(e.message || e).slice(0, 300) });
    }
    if (!row.ok) failed = true;
    rows.push(row);
  }
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* temp dir */ }
}
console.table(rows);
process.exit(failed ? 1 : 0);
