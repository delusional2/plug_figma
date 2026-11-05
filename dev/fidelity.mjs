#!/usr/bin/env node
// Fidelity harness: for each case, screenshots the original page, runs the plugin's
// page agent (like Figma would), draws the resulting layer tree back with
// dev/render.html, validates the tree against dev/mock-figma.js, and pixel-diffs
// original vs. re-render. Outputs land in dev/out/<case>.{orig,render,diff}.png + .json.
//
//   node dev/fidelity.mjs                 # all cases in dev/cases at 1440
//   node dev/fidelity.mjs landing -w 390  # cases whose name contains "landing", phone width
//   node dev/fidelity.mjs --jobs 4        # cases in parallel (default 3), each in its own tabs
//   node dev/fidelity.mjs --timeout 300   # per-case limit in seconds (default 240)
//
// Needs Google Chrome installed (uses the DevTools protocol, no npm deps).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dev', 'out');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KILL_MOTION = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}html{scroll-behavior:auto!important}';

const argv = process.argv.slice(2);
let width = 1440, height = 900, jobs = 3, caseTimeout = 240;
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-w') width = +argv[++i];
  else if (argv[i] === '-h') height = +argv[++i];
  else if (argv[i] === '-j' || argv[i] === '--jobs') jobs = Math.max(1, +argv[++i] || 1);
  else if (argv[i] === '--timeout') caseTimeout = +argv[++i] || caseTimeout;
  else filters.push(argv[i]);
}
const cases = fs.readdirSync(path.join(ROOT, 'dev', 'cases'))
  .filter((f) => f.endsWith('.html') && (!filters.length || filters.some((x) => f.includes(x))))
  .sort();
fs.mkdirSync(OUT, { recursive: true });

// ---------- static server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json', '.gif': 'image/gif', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- chrome ----------
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'h2f-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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

// Every tab a case opens is registered in its `tabs` set, so a timed-out case can be torn down.
async function newPage(w, h, tabs) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  if (tabs) tabs.add(targetId);
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  // Like the plugin's stage, never let the dev machine's OS theme leak into the page.
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const page = {
    s,
    async goto(url) {
      const loaded = new Promise((r) => { const l = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await s('Page.navigate', { url });
      await Promise.race([loaded, sleep(30000)]);
    },
    async eval(expr) {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(w, h) {
      const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      return r.data;
    },
    close: () => { if (tabs) tabs.delete(targetId); return send('Target.closeTarget', { targetId }).catch(() => {}); },
  };
  return page;
}

async function waitFor(page, expr, ms = 150000, alive = () => true) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && alive()) {
    const v = await page.eval(expr);
    if (v) return v;
    await sleep(250);
  }
  throw new Error('timeout waiting for ' + expr);
}

// ---------- per case ----------
async function original(caseFile, tabs) {
  const p = await newPage(width, height, tabs);
  let html = fs.readFileSync(path.join(ROOT, 'dev', 'cases', caseFile), 'utf8');
  // Serve through runner-equivalent Tailwind detection so both sides see the same CSS.
  const ui = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');
  const cdn = /const TAILWIND_CDN = '([^']+)'/.exec(ui)[1];
  const needsTw = !/<style|stylesheet|tailwind/i.test(html) && /class(Name)?="[^"]*\b(flex|grid|px-\d|py-\d|text-(xs|sm|lg|xl|\dxl)|bg-[a-z]+-\d{2,3}|rounded(-\w+)?)\b/.test(html);
  if (needsTw) html = `<script src="${cdn}"></script>\n` + html;
  const tmpName = `_orig_${width}_${caseFile}`;
  const tmp = path.join(OUT, tmpName);
  fs.writeFileSync(tmp, html);
  await p.goto(`${BASE}/dev/out/${tmpName}`);
  const h = await p.eval(`(async () => {
    const st = document.createElement('style'); st.textContent = ${JSON.stringify(KILL_MOTION)}; (document.head || document.documentElement).appendChild(st);
    await document.fonts.ready; await new Promise(r => setTimeout(r, 500));
    const total = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    for (let y = 0; y < total; y += ${height} * 0.75) { scrollTo(0, y); await new Promise(r => setTimeout(r, 40)); }
    scrollTo(0, 0);
    await Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })));
    await new Promise(r => setTimeout(r, 400));
    return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  })()`);
  const png = await p.shot(width, h);
  await p.close();
  try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
  return { png, h };
}

async function extract(caseFile, tabs) {
  const p = await newPage(width, height, tabs);
  await p.goto(`${BASE}/dev/runner.html?case=${encodeURIComponent('cases/' + caseFile)}&w=${width}&h=${height}`);
  const json = await waitFor(p, 'window.__result', caseTimeout * 1000, () => tabs.size > 0);
  await p.close();
  return JSON.parse(json);
}

async function rerender(doc, tabs) {
  const p = await newPage(width, height, tabs);
  await p.goto(`${BASE}/dev/render.html`);
  const size = await p.eval(`renderTree(${JSON.stringify(JSON.stringify(doc))})`);
  await sleep(200);
  const png = await p.shot(size.w, size.h);
  await p.close();
  return { png, ...size };
}

async function diff(a, b, w, h, tabs) {
  const p = await newPage(800, 600, tabs);
  await p.goto('about:blank');
  const r = await p.eval(`(async () => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [A, B] = await Promise.all([load('data:image/png;base64,${a}'), load('data:image/png;base64,${b}')]);
    const W = ${w}, H = Math.max(A.height, B.height);
    const get = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(img, 0, 0); return x.getImageData(0, 0, W, H); };
    const da = get(A), db = get(B);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const ox = out.getContext('2d'); const od = ox.createImageData(W, H);
    let bad = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
      const g = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3;
      if (d > 48) { bad++; od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 0; od.data[i + 3] = 255; }
      else { od.data[i] = od.data[i + 1] = od.data[i + 2] = 200 + g / 5; od.data[i + 3] = 255; }
    }
    ox.putImageData(od, 0, 0);
    return { pct: bad / (W * H) * 100, heightDelta: B.height - A.height, png: out.toDataURL('image/png').split(',')[1] };
  })()`);
  await p.close();
  return r;
}

async function runCase(c) {
  const name = c.replace(/\.html$/, '') + (width !== 1440 ? `@${width}` : '');
  const [orig, doc] = await Promise.all([original(c, this.tabs), extract(c, this.tabs)]);
  if (doc.error) throw new Error('agent: ' + doc.error);
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(doc, null, 1));
  let mock = '';
  try {
    mock = execFileSync('node', [path.join(ROOT, 'dev', 'mock-figma.js'), path.join(ROOT, 'code.js'), path.join(OUT, name + '.json')], { encoding: 'utf8' });
  } catch (e) { mock = 'MOCK CRASH ' + (e.stderr || e.message); }
  const mockErrors = /errors: none/.test(mock) ? 0 : mock;
  const rr = await rerender(doc, this.tabs);
  const d = await diff(orig.png, rr.png, width, Math.max(orig.h, rr.h), this.tabs);
  fs.writeFileSync(path.join(OUT, name + '.orig.png'), Buffer.from(orig.png, 'base64'));
  fs.writeFileSync(path.join(OUT, name + '.render.png'), Buffer.from(rr.png, 'base64'));
  fs.writeFileSync(path.join(OUT, name + '.diff.png'), Buffer.from(d.png, 'base64'));
  const count = (n) => 1 + (n.children || []).reduce((a, k) => a + count(k), 0);
  const al = (n) => (n.layout ? 1 : 0) + (n.children || []).reduce((a, k) => a + al(k), 0);
  return { case: name, diffPct: +d.pct.toFixed(2), heightDelta: d.heightDelta, layers: count(doc.root), autoLayouts: al(doc.root), images: doc.images.length, imagesMissing: doc.images.filter((i) => !i.bytes).length, warnings: (doc.warnings || []).join(',') || undefined, mockErrors: mockErrors ? String(mockErrors).slice(0, 400) : 0 };
}

const results = [];
try {
  const queue = cases.slice();
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      const name = c.replace(/\.html$/, '') + (width !== 1440 ? `@${width}` : '');
      const ctx = { tabs: new Set() };
      let timer;
      try {
        results.push(await Promise.race([
          runCase.call(ctx, c),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`case timed out after ${caseTimeout}s`)), caseTimeout * 1000); }),
        ]));
      } catch (e) {
        results.push({ case: name, error: String(e.message || e).slice(0, 400) });
      } finally {
        clearTimeout(timer);
        const left = [...ctx.tabs];
        ctx.tabs.clear();
        await Promise.all(left.map((targetId) => send('Target.closeTarget', { targetId }).catch(() => {})));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
  results.sort((a, b) => (a.case < b.case ? -1 : 1));
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(3000)]);
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* temp dir, best effort */ }
}
console.table(results.map((r) => ({ ...r, mockErrors: r.mockErrors ? 'YES' : r.error ? '' : 0 })));
for (const r of results) if (r.mockErrors || r.error) console.log(r.case, r.error || r.mockErrors);
fs.writeFileSync(path.join(OUT, `summary${width !== 1440 ? '@' + width : ''}.json`), JSON.stringify(results, null, 1));
