#!/usr/bin/env node
// Builds bookmarklet.html (repo root): the "Скопировать для Figma" bookmarklet runs the
// plugin's own pageAgent on the live page and copies a JSON snapshot that the plugin
// builds directly: {"h2f":1, name, root, images:[{ref, url, base64}]}.
//
//   node dev/build-bookmarklet.mjs        # writes bookmarklet.html
//
// The agent is taken from ui.html (first <script>), so the bookmarklet always measures
// exactly like the plugin. Self-contained javascript: URL, nothing loaded from outside.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');
const first = /<script>\n([\s\S]*?)<\/script>/.exec(ui)[1];
const { pageAgent } = new Function(first + '\n;return { pageAgent };')();

// Runs in the page. ES2017, no dependencies; the UI box lives outside <body> so the agent never measures it.
function bookmarklet(AGENT) {
  if (window.__h2fBusy) return;
  window.__h2fBusy = true;
  var host = document.createElement('div');
  host.setAttribute('data-h2f-ui', '');
  host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML = '<style>.b{font:13px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:#1e1e1e;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);padding:12px 14px;width:280px}'
    + '.t{font-weight:600;margin-bottom:4px}.m{color:#555}.r{display:flex;gap:8px;margin-top:10px}'
    + 'button,a{font:inherit;font-weight:500;border-radius:6px;padding:6px 10px;cursor:pointer;text-decoration:none;border:1px solid #ddd;color:#1e1e1e;background:#fff}'
    + 'button.p{background:#0d99ff;border-color:#0d99ff;color:#fff}.x{position:absolute;top:6px;right:10px;border:0;padding:2px 4px;color:#999}</style>'
    + '<div class="b"><button class="x" title="Закрыть">×</button><div class="t">HTML → Figma</div><div class="m">Запускаю…</div><div class="r" hidden></div></div>';
  document.documentElement.appendChild(host);
  var msg = root.querySelector('.m'), row = root.querySelector('.r');
  var close = function () { host.remove(); };
  root.querySelector('.x').onclick = close;
  var say = function (t) { msg.textContent = t; };

  var b64 = function (u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  var copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  };
  var legacyCopy = function (text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.documentElement.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      if (ok) resolve(); else reject(new Error('copy blocked'));
    });
  };

  var api = null, why = '';
  try { api = AGENT('live'); } catch (e) { why = ' (' + ((e && e.message) || e) + ')'; }
  if (!api || !api.run) {
    say('Не получилось запустить разбор на этой странице' + why + '.');
    window.__h2fBusy = false;
    return;
  }
  api.run(say).then(function (r) {
    say('Упаковываю…');
    var name = (r.root && r.root.name) || document.title || location.hostname;
    var payload = {
      h2f: 1,
      name: name,
      source: location.href,
      root: r.root,
      images: r.images.map(function (im) {
        var o = { ref: im.ref, url: im.url || null, base64: im.bytes ? b64(im.bytes) : null };
        if (im.same) o.same = im.same;
        return o;
      }),
      warnings: r.warnings,
    };
    var json = JSON.stringify(payload);
    var count = (function n(x) { var k = 1; (x.children || []).forEach(function (c) { k += n(c); }); return k; })(r.root);
    var file = (name.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'page') + '.figma.json';
    var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    var dl = document.createElement('a');
    dl.href = url;
    dl.download = file;
    dl.textContent = 'Скачать .json';
    var mb = (json.length / 1048576).toFixed(1);
    var done = function () {
      say('Скопировано: ' + count + ' слоёв, ' + mb + ' МБ. Вставь в окно плагина HTML → Figma и нажми «Импортировать».');
      row.hidden = false;
      row.appendChild(dl);
    };
    var manual = function () {
      say('Готово: ' + count + ' слоёв, ' + mb + ' МБ. Браузер не дал скопировать автоматически — нажми «Скопировать» или скачай файл и перетащи его в плагин.');
      var btn = document.createElement('button');
      btn.className = 'p';
      btn.textContent = 'Скопировать';
      btn.onclick = function () { copyText(json).then(done, function () { say('Не копируется — скачай файл и перетащи его в окно плагина.'); }); btn.remove(); };
      row.hidden = false;
      row.appendChild(btn);
      row.appendChild(dl);
    };
    window.__h2fLast = json; // for the dev test and the console
    copyText(json).then(done, manual);
  }).catch(function (e) {
    say('Ошибка: ' + ((e && e.message) || e));
  }).then(function () { window.__h2fBusy = false; });
}

const code = `(${bookmarklet})(${pageAgent});`;
// javascript: URLs are percent-decoded and lose raw newlines/tabs: encode those, %, # and non-ASCII.
const href = 'javascript:' + code.replace(/[%#\n\r\t]|[^\x20-\x7e]/gu, (c) => encodeURIComponent(c)) + 'void 0';
const attr = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>HTML → Figma: закладка «Скопировать для Figma»</title>
<style>
  body { max-width: 640px; margin: 40px auto; padding: 0 20px; font: 15px/1.6 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #1e1e1e; }
  h1 { font-size: 22px; }
  .bm { display: inline-block; margin: 8px 0 16px; padding: 10px 18px; border-radius: 8px; background: #0d99ff; color: #fff; font-weight: 600; text-decoration: none; cursor: grab; }
  li { margin: 6px 0; }
  .muted { color: #666; font-size: 13px; }
  textarea { width: 100%; height: 120px; font: 11px/1.4 ui-monospace, Menlo, monospace; }
  code { background: #f2f2f2; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<h1>Закладка «Скопировать для Figma»</h1>
<p>Снимает страницу прямо в браузере — такой, какой ты её видишь: с твоей шириной окна, после входа в аккаунт, со всеми скриптами. Подходит для сайтов, которые плагин не может загрузить по ссылке (CORS), и для приложений на localhost.</p>
<p><a class="bm" href="${attr}" onclick="alert('Не нажимай — перетащи эту кнопку на панель закладок.'); return false;">Скопировать для Figma</a></p>
<ol>
  <li>Перетащи синюю кнопку на панель закладок (показать панель: <code>⌘/Ctrl + Shift + B</code>).</li>
  <li>Открой нужную страницу и нажми закладку. Подожди несколько секунд — в углу появится окошко «Скопировано».</li>
  <li>В Figma открой плагин <b>HTML → Figma</b>, вставь (<code>⌘/Ctrl + V</code>) в большое поле и нажми <b>Импортировать</b>.</li>
</ol>
<p>Если браузер не дал скопировать, в окошке будет кнопка «Скопировать» и ссылка «Скачать .json» — файл можно просто перетащить в окно плагина.</p>
<p class="muted">Ширина в Figma = ширина окна браузера: для мобильной версии сузь окно или включи режим устройства в DevTools. Картинки с чужих сайтов, которые не отдаются странице, плагин докачает сам по ссылке. После снимка страница может чуть измениться (отключаются анимации) — просто обнови её.</p>
<details>
  <summary>Закладка не работает? Запусти код в консоли</summary>
  <p class="muted">Некоторые браузеры ограничивают длину закладок. Тогда открой страницу, нажми <code>F12</code> → Console, вставь этот код и нажми Enter.</p>
  <textarea readonly onclick="this.select()">${esc(code)}</textarea>
</details>
<p class="muted">Собрано из ui.html командой <code>node dev/build-bookmarklet.mjs</code> — код закладки совпадает с тем, что плагин запускает у себя.</p>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, 'bookmarklet.html'), page);
console.log(`bookmarklet.html: ${Math.round(href.length / 1024)} KB link, ${Math.round(code.length / 1024)} KB code`);
