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
// --disable-quic: on networks that drop UDP, QUIC to image CDNs (picsum/fastly) hangs fetches from
// the opaque-origin stage for 10s+ instead of failing over, which made image results flaky.
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'h2f-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none', '--disable-quic', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  // H2F_DEBUG=1: page console + exceptions on stderr (which tab is stuck, and where).
  if (process.env.H2F_DEBUG && m.method === 'Runtime.consoleAPICalled') process.stderr.write(`  [console ${m.sessionId.slice(0, 6)}] ${m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ')}\n`);
  if (process.env.H2F_DEBUG && m.method === 'Runtime.exceptionThrown') process.stderr.write(`  [exception ${m.sessionId.slice(0, 6)}] ${(m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text}\n`);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every tab a case opens is registered in its `tabs` set, so a timed-out case can be torn down.
async function newPage(w, h, tabs, contextId) {
  // Own window per tab: parallel background tabs don't paint reliably (tiled screenshots).
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true, background: false, browserContextId: contextId || (tabs && tabs.contextId) });
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
// The plugin's first <script> is plain string work at top level (functions only), so it evaluates in node.
const { prepareHtml } = new Function(/<script>\n([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8'))[1] + '\n;return { prepareHtml };')();

async function original(caseFile, tabs) {
  // Its own browser context: the original's <img> loads must not share an HTTP cache (and its
  // per-URL cache locks) with the extraction stage, which never happens in Figma.
  const p = await newPage(width, height, tabs, tabs.origContextId);
  // Same preparation as the plugin (JSX build, CSP strip, Tailwind injection, env shim), minus the agent.
  const html = prepareHtml(fs.readFileSync(path.join(ROOT, 'dev', 'cases', caseFile), 'utf8'), { agent: false }).html;
  const tmpName = `_orig_${width}_${caseFile}`;
  const tmp = path.join(OUT, tmpName);
  fs.writeFileSync(tmp, html);
  await p.goto(`${BASE}/dev/out/${tmpName}`);
  const h = await p.eval(`(async () => {
    const st = document.createElement('style'); st.textContent = ${JSON.stringify(KILL_MOTION)}; (document.head || document.documentElement).appendChild(st);
    // SPAs (Babel/React from a CDN) render after load: wait for the DOM to go quiet, like the agent's settle().
    let last = performance.now(); new MutationObserver(() => { last = performance.now(); }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const t0 = performance.now(); performance.now() - t0 < 8000 && performance.now() - last < 500;) await new Promise(r => setTimeout(r, 50));
    await document.fonts.ready; await new Promise(r => setTimeout(r, 500));
    const total = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    for (let y = 0; y < total; y += ${height} * 0.75) { scrollTo(0, y); await new Promise(r => setTimeout(r, 40)); }
    scrollTo(0, 0);
    // Remote image hosts throttle after many runs: never wait for them forever.
    for (const t0 = performance.now(); performance.now() - t0 < 20000 && [...document.images].some(i => !i.complete);) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400));
    // captureBeyondViewport resizes the viewport, and responsive canvas libraries (Chart.js)
    // clear and re-animate on resize: freeze each canvas as an <img> of what it shows now.
    for (const cv of document.querySelectorAll('canvas')) {
      try {
        const r = cv.getBoundingClientRect(); if (!r.width || !r.height) continue;
        const img = new Image(); img.src = cv.toDataURL();
        for (const k of ['display', 'position', 'top', 'left', 'right', 'bottom', 'margin', 'borderRadius', 'transform', 'zIndex', 'opacity']) img.style[k] = getComputedStyle(cv)[k];
        img.style.width = r.width + 'px'; img.style.height = r.height + 'px'; img.style.maxWidth = 'none'; img.style.boxSizing = 'border-box';
        cv.replaceWith(img); await img.decode().catch(() => {});
      } catch (e) { /* tainted canvas: leave it */ }
    }
    // Like the plugin (and a Figma frame with fixed-on-scroll children): bottom-pinned fixed
    // bars and buttons sit at the page bottom, not where the first viewport ends.
    const full = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const VH = innerHeight;
    if (full > VH + 1) for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      let free = true;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const c = getComputedStyle(a);
        if (c.transform !== 'none' || c.filter !== 'none' || (c.perspective && c.perspective !== 'none') || (c.backdropFilter && c.backdropFilter !== 'none') || /paint|layout|strict|content/.test(c.contain || '') || /transform|filter|perspective/.test(c.willChange || '')) { free = false; break; }
      }
      const r = el.getBoundingClientRect();
      if (!free || !(VH - r.bottom < r.top - 1 && r.height < VH * 0.6)) continue;
      el.style.setProperty('top', (r.top + full - VH) + 'px', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('height', r.height + 'px', 'important');
    }
    return full;
  })()`);
  const png = await p.shot(width, h);
  await p.close();
  try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
  return { png, h };
}

async function extract(caseFile, tabs) {
  const p = await newPage(width, height, tabs);
  await p.goto(`${BASE}/dev/runner.html?case=${encodeURIComponent('cases/' + caseFile)}&w=${width}&h=${height}`);
  const len = await waitFor(p, 'window.__result ? window.__result.length : 0', caseTimeout * 1000, () => tabs.size > 0);
  // Read in slices: a raw photo re-encoded at 4096px is 20MB+ of base64, more than one
  // DevTools message carries (the reply never arrives and the case looked hung).
  let json = '';
  for (let i = 0; i < len; i += 4e6) json += await p.eval(`window.__result.slice(${i}, ${i + 4e6})`);
  await p.close();
  return JSON.parse(json);
}

async function rerender(doc, tabs) {
  const p = await newPage(width, height, tabs);
  await p.goto(`${BASE}/dev/render.html`);
  const size = await p.eval(`renderTree(${JSON.stringify(JSON.stringify(doc))})`);
  await sleep(200);
  const png = await p.shot(size.w, size.h);
  const missingFonts = await p.eval('window.__missingFonts.join(",")');
  await p.close();
  return { png, missingFonts, ...size };
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
  this.phase = 'original+extract';
  const [orig, doc] = await Promise.all([original(c, this.tabs).then((v) => { this.phase = 'extract'; return v; }), extract(c, this.tabs)]);
  this.phase = 'render';
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
  return { case: name, diffPct: +d.pct.toFixed(2), heightDelta: d.heightDelta, layers: count(doc.root), autoLayouts: al(doc.root), images: doc.images.length, imagesMissing: doc.images.filter((i) => !i.bytes && !i.same).length, slowImages: doc.images.filter((i) => i.slow).length || undefined, missingFonts: rr.missingFonts || undefined, warnings: (doc.warnings || []).join(',') || undefined, mockErrors: mockErrors ? String(mockErrors).slice(0, 400) : 0 };
}

const results = [];
// One case in fresh browser contexts with a hard time limit; never throws.
async function runOne(c) {
  const name = c.replace(/\.html$/, '') + (width !== 1440 ? `@${width}` : '');
  const ctx = { tabs: new Set() };
  let timer, r;
  try {
    // Each case in its own browser context: its own renderer process and HTTP cache,
    // so a hung or heavy page (or a cache lock on a slow image) can't stall the others.
    const mkContext = () => Promise.race([send('Target.createBrowserContext', {}), sleep(15000).then(() => { throw new Error('browser did not create a context'); })]);
    ctx.tabs.contextId = (await mkContext()).browserContextId;
    ctx.tabs.origContextId = (await mkContext()).browserContextId;
    r = await Promise.race([
      runCase.call(ctx, c),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`case timed out after ${caseTimeout}s in ${ctx.phase}`)), caseTimeout * 1000); }),
    ]);
  } catch (e) {
    r = { case: name, error: String(e.message || e).slice(0, 400) };
  } finally {
    clearTimeout(timer);
    const left = [...ctx.tabs];
    ctx.tabs.clear();
    // A hung page may never answer closeTarget: don't let teardown block the worker.
    await Promise.race([Promise.all(left.map((targetId) => send('Target.closeTarget', { targetId }).catch(() => {}))), sleep(5000)]);
    for (const browserContextId of [ctx.tabs.contextId, ctx.tabs.origContextId]) {
      if (browserContextId) await Promise.race([send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}), sleep(5000)]);
    }
  }
  return r;
}
try {
  const queue = cases.slice();
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      const r = await runOne(c);
      results.push(r);
      process.stderr.write(`[${results.length}/${cases.length}] ${r.case} ${r.error ? 'ERROR ' + r.error.slice(0, 80) : r.diffPct + '%'}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, cases.length) }, worker));
  // Image hosts (picsum/unsplash) and Google Fonts stall under parallel load (images marked
  // "slow", fonts missing in the re-render): rerun those cases (and timeouts) one at a time so the numbers don't depend on --jobs.
  if (jobs > 1) {
    for (let i = 0; i < results.length; i++) {
      if (!results[i].slowImages && !results[i].missingFonts && !results[i].error) continue;
      const c = cases.find((f) => results[i].case === f.replace(/\.html$/, '') + (width !== 1440 ? `@${width}` : ''));
      const r = await runOne(c);
      process.stderr.write(`[rerun] ${r.case} ${r.error ? 'ERROR ' + r.error.slice(0, 80) : r.diffPct + '%'}\n`);
      results[i] = r;
    }
  }
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
