// HTML → Figma, main thread.
// ui.html renders the page in a real browser, measures every box and sends a
// ready-made layer tree here; this file only turns that tree into Figma nodes.
// Kept to ES2017 syntax: no optional chaining, no object spread.

figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

const SETTINGS_KEY = 'settings-v1';
const FALLBACK_FONT = { family: 'Inter', style: 'Regular' };
const PLACEHOLDER = { type: 'SOLID', color: { r: 0.86, g: 0.86, b: 0.88 } };

figma.clientStorage.getAsync(SETTINGS_KEY)
  .then((s) => figma.ui.postMessage({ type: 'settings', settings: s || null }))
  .catch(() => {});

let batchNodes = []; // frames of a multi-file import, selected together at the end

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'save-settings') {
    figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings).catch(() => {});
  } else if (msg.type === 'import') {
    try {
      const result = await importDocument(msg.doc, !!msg.batch);
      figma.ui.postMessage({ type: 'done', count: result.count, failed: result.failed });
      if (!msg.batch) figma.notify('Готово: ' + result.count + ' слоёв');
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
  } else if (msg.type === 'batch-end' && batchNodes.length) {
    figma.currentPage.selection = batchNodes;
    figma.viewport.scrollAndZoomIntoView(batchNodes);
    figma.notify('Готово: экранов ' + batchNodes.length);
    batchNodes = [];
  }
};

function progress(text) {
  figma.ui.postMessage({ type: 'progress', text: text });
}

async function importDocument(doc, batch) {
  progress('Подбираю шрифты…');
  const font = await prepareFonts(doc.root);
  progress('Добавляю картинки…');
  const images = await prepareImages(doc.images || []);
  progress('Создаю слои…');

  const page = figma.currentPage;
  const others = page.children.slice();
  const ctx = { font: font, images: images, count: 0, failed: 0, total: countNodes(doc.root) };
  const root = await buildNode(doc.root, page, ctx);
  if (!root) throw new Error('Не получилось создать слои');
  root.name = doc.name;
  if (doc.root.fixedCount) {
    try { root.numberOfFixedChildren = doc.root.fixedCount; } catch (e) {}
  }

  // Put the import to the right of whatever is already on the page.
  if (others.length) {
    let right = -Infinity;
    let top = Infinity;
    for (const n of others) {
      right = Math.max(right, n.x + n.width);
      top = Math.min(top, n.y);
    }
    root.x = Math.round(right + 200);
    root.y = Math.round(top);
  }
  if (batch) {
    batchNodes.push(root);
  } else {
    page.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
  }
  return ctx;
}

// ---------- nodes ----------

function countNodes(n) {
  let k = 1;
  if (n.children) for (const c of n.children) k += countNodes(c);
  return k;
}

// Big pages: give Figma a breath (and the UI a progress line) every ~150 layers
// instead of freezing until the whole tree is built.
const CHUNK = 150;
function pause(ctx) {
  progress('Создаю слои ' + ctx.count + ' / ' + ctx.total + '…');
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

async function buildNode(n, parent, ctx) {
  let node = null;
  try {
    node = createNode(n, ctx);
    parent.appendChild(node);
    shapeNode(node, n, ctx);
    if (n.layout) applyLayout(node, n);
    place(node, n, parent);
    if (n.xf) applyTransform(node, n.xf);
    if (n.isMask) {
      node.isMask = true;
      try { node.maskType = n.maskType || 'ALPHA'; } catch (e) { /* older API: alpha masks only */ }
    }
  } catch (e) {
    ctx.failed++;
    if (node && !node.removed) node.remove();
    return null;
  }
  ctx.count++;
  if (ctx.count % CHUNK === 0) await pause(ctx);
  if (n.type === 'FRAME' && n.children) {
    for (const c of n.children) await buildNode(c, node, ctx);
    // Hug only after children exist, otherwise the frame collapses first.
    if (n.layout && n.layout.primarySizing === 'AUTO') node.primaryAxisSizingMode = 'AUTO';
    if (n.layout && n.layout.counterSizing === 'AUTO') node.counterAxisSizingMode = 'AUTO';
  }
  return node;
}

function createNode(n, ctx) {
  if (n.type === 'TEXT') return createText(n, ctx);
  if (n.type === 'RECT') return figma.createRectangle();
  if (n.type === 'ELLIPSE') return figma.createEllipse();
  if (n.type === 'VECTOR') {
    const v = figma.createVector();
    v.vectorPaths = [{ windingRule: n.rule || 'NONZERO', data: n.d }];
    return v;
  }
  if (n.type === 'SVG') {
    try {
      return figma.createNodeFromSvg(n.svg);
    } catch (e) {
      const r = figma.createRectangle();
      r.fills = [PLACEHOLDER];
      return r;
    }
  }
  return figma.createFrame();
}

function shapeNode(node, n, ctx) {
  if (n.type === 'TEXT') {
    if (n.autoResize === 'WIDTH_AND_HEIGHT' && !n.truncate) {
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else {
      node.resize(Math.max(1, n.w), Math.max(1, n.h));
      node.textAutoResize = 'HEIGHT';
    }
    // text-overflow: ellipsis / line-clamp (maxLines only works with ENDING).
    if (n.truncate) {
      try {
        node.textTruncation = 'ENDING';
        node.maxLines = Math.max(1, Math.round(n.truncate));
      } catch (e) { /* older API: the full text stays visible */ }
    }
    if (n.effects && n.effects.length) setEffects(node, n.effects);
  } else if (n.type === 'SVG') {
    node.name = n.name || 'svg';
    if (Math.abs(node.width - n.w) > 0.5 || Math.abs(node.height - n.h) > 0.5) {
      node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    }
    if (n.effects && n.effects.length) setEffects(node, n.effects);
  } else {
    node.name = n.name || node.name;
    // A vector takes its size from its path (already in box coordinates).
    if (n.type !== 'VECTOR') node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    applyBox(node, n, ctx);
  }
  if (typeof n.opacity === 'number' && n.opacity < 1) node.opacity = n.opacity;
}

function place(node, n, parent) {
  const auto = 'layoutMode' in parent && parent.layoutMode !== 'NONE';
  if (auto && n.absolute) {
    node.layoutPositioning = 'ABSOLUTE';
    node.x = n.x;
    node.y = n.y;
  } else if (auto) {
    if (n.stretch) node.layoutAlign = 'STRETCH';
    if (n.grow) {
      node.layoutGrow = 1;
      if (node.type === 'TEXT' && node.textAutoResize === 'WIDTH_AND_HEIGHT') node.textAutoResize = 'HEIGHT';
    }
  } else {
    node.x = n.x;
    node.y = n.y;
  }
  if (n.cons && (n.absolute || !auto)) {
    try { node.constraints = { horizontal: n.cons.h, vertical: n.cons.v }; } catch (e) {}
  }
}

// CSS transform (scale already baked into sizes): rotation, flips and skew.
function applyTransform(node, xf) {
  try {
    node.relativeTransform = [[xf.a, xf.c, xf.tx], [xf.b, xf.d, xf.ty]];
  } catch (e) {
    // Skew (non-orthogonal matrix) rejected: keep the rotation only.
    try {
      const r = Math.atan2(xf.b, xf.a);
      node.relativeTransform = [[Math.cos(r), -Math.sin(r), xf.tx], [Math.sin(r), Math.cos(r), xf.ty]];
    } catch (e2) {}
  }
}

function applyLayout(node, n) {
  const l = n.layout;
  node.layoutMode = l.mode;
  node.primaryAxisSizingMode = 'FIXED';
  node.counterAxisSizingMode = 'FIXED';
  node.itemSpacing = l.spacing;
  node.paddingTop = l.pt;
  node.paddingRight = l.pr;
  node.paddingBottom = l.pb;
  node.paddingLeft = l.pl;
  node.primaryAxisAlignItems = l.primaryAlign;
  node.counterAxisAlignItems = l.counterAlign;
  if (l.reverseZ) {
    try { node.itemReverseZIndex = true; } catch (e) {}
  }
  node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
}

function applyBox(node, n, ctx) {
  node.fills = (n.fills || []).map((p) => toPaint(p, ctx)).filter(Boolean);
  if (n.stroke) {
    node.strokes = [toPaint(n.stroke.paint, ctx)];
    node.strokeAlign = n.stroke.align || 'INSIDE';
    const w = n.stroke.weights;
    if (node.type === 'ELLIPSE' || node.type === 'VECTOR') {
      node.strokeWeight = Math.max(w.t, w.r, w.b, w.l);
    } else if (w.t === w.r && w.r === w.b && w.b === w.l) {
      node.strokeWeight = w.t;
    } else {
      node.strokeTopWeight = w.t;
      node.strokeRightWeight = w.r;
      node.strokeBottomWeight = w.b;
      node.strokeLeftWeight = w.l;
    }
    if (n.stroke.dash) node.dashPattern = n.stroke.dash;
  }
  if (n.radii) {
    node.topLeftRadius = n.radii.tl;
    node.topRightRadius = n.radii.tr;
    node.bottomRightRadius = n.radii.br;
    node.bottomLeftRadius = n.radii.bl;
  }
  if (n.effects && n.effects.length) setEffects(node, n.effects);
  if (node.type === 'FRAME') node.clipsContent = !!n.clip;
}

function setEffects(node, effects) {
  const isBlur = (e) => /BLUR/.test(e.type);
  try {
    node.effects = effects;
    return;
  } catch (e) {}
  // Newer API versions want an explicit blurType on blur effects.
  try {
    node.effects = effects.map((e) => (isBlur(e) ? Object.assign({ blurType: 'NORMAL' }, e) : e));
    return;
  } catch (e) {}
  try {
    node.effects = effects.filter((e) => !isBlur(e));
  } catch (e) {}
}

function createText(n, ctx) {
  const t = figma.createText();
  const segs = n.segments;
  t.fontName = ctx.font(segs[0].font);
  t.characters = segs.map((s) => s.text).join('');
  let i = 0;
  for (const s of segs) {
    const end = i + s.text.length;
    t.setRangeFontName(i, end, ctx.font(s.font));
    t.setRangeFontSize(i, end, Math.max(1, s.size));
    t.setRangeFills(i, end, [toPaint(s.fill, ctx)]);
    if (s.decoration) t.setRangeTextDecoration(i, end, s.decoration);
    if (s.letterSpacing) t.setRangeLetterSpacing(i, end, { value: s.letterSpacing, unit: 'PIXELS' });
    t.setRangeLineHeight(i, end, s.lineHeight ? { value: s.lineHeight, unit: 'PIXELS' } : { unit: 'AUTO' });
    if (s.textCase) t.setRangeTextCase(i, end, s.textCase);
    i = end;
  }
  t.textAlignHorizontal = n.align || 'LEFT';
  return t;
}

function toPaint(p, ctx) {
  if (!p) return null;
  if (p.type === 'IMAGE') {
    const hash = ctx.images[p.ref];
    return hash ? { type: 'IMAGE', imageHash: hash, scaleMode: p.scaleMode || 'FILL' } : PLACEHOLDER;
  }
  return p;
}

// ---------- images ----------

function withTimeout(promise, ms) {
  let timer = 0;
  const limit = new Promise(function (resolve, reject) {
    timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
  });
  return Promise.race([promise, limit]).then(
    function (v) { clearTimeout(timer); return v; },
    function (e) { clearTimeout(timer); throw e; }
  );
}

async function prepareImages(list) {
  const hashes = {};
  const remote = [];
  for (const im of list) {
    if (im.bytes) {
      try {
        hashes[im.ref] = figma.createImage(im.bytes).hash;
        continue;
      } catch (e) {}
    }
    if (im.same) continue; // the same bytes as an earlier image
    // The UI could not read the file (CORS, or too slow there) — let Figma try the URL itself.
    if (im.url && /^https?:/i.test(im.url)) remote.push(im);
  }
  let next = 0;
  let settled = 0;
  async function worker() {
    while (next < remote.length) {
      const im = remote[next++];
      try {
        hashes[im.ref] = (await withTimeout(figma.createImageAsync(im.url), 15000)).hash;
      } catch (e) {}
      settled++;
      progress('Добавляю картинки ' + settled + '/' + remote.length + '…');
    }
  }
  const pool = [];
  for (let i = 0; i < Math.min(4, remote.length); i++) pool.push(worker());
  await Promise.all(pool);
  for (const im of list) if (im.same && hashes[im.same]) hashes[im.ref] = hashes[im.same];
  return hashes;
}

// ---------- fonts ----------

const GENERIC_FAMILIES = {
  sans: ['Inter', 'SF Pro Text', 'Helvetica Neue', 'Arial', 'Roboto'],
  serif: ['Georgia', 'Times New Roman', 'Noto Serif', 'PT Serif', 'Merriweather'],
  mono: ['JetBrains Mono', 'Roboto Mono', 'Source Code Pro', 'IBM Plex Mono', 'Fira Code', 'Menlo', 'Courier New'],
};

const GENERIC_ALIASES = {
  'sans-serif': 'sans', 'system-ui': 'sans', '-apple-system': 'sans', 'blinkmacsystemfont': 'sans',
  'ui-sans-serif': 'sans', 'segoe ui': 'sans', 'cursive': 'sans', 'fantasy': 'sans',
  'serif': 'serif', 'ui-serif': 'serif',
  'monospace': 'mono', 'ui-monospace': 'mono', 'sfmono-regular': 'mono', 'sf mono': 'mono',
  'menlo': 'mono', 'monaco': 'mono', 'consolas': 'mono', 'liberation mono': 'mono', 'courier new': 'mono',
  'apple color emoji': 'skip', 'segoe ui emoji': 'skip', 'segoe ui symbol': 'skip', 'noto color emoji': 'skip',
};

function specKey(spec) {
  return spec.families.join('|') + '/' + spec.weight + '/' + (spec.italic ? 'i' : 'n');
}

function describeStyle(style) {
  const s = style.toLowerCase().replace(/[\s_-]+/g, '');
  let weight = 400;
  if (/thin|hairline/.test(s)) weight = 100;
  else if (/extralight|ultralight/.test(s)) weight = 200;
  else if (/semibold|demibold/.test(s)) weight = 600;
  else if (/extrabold|ultrabold/.test(s)) weight = 800;
  else if (/black|heavy/.test(s)) weight = 900;
  else if (/light/.test(s)) weight = 300;
  else if (/medium/.test(s)) weight = 500;
  else if (/bold/.test(s)) weight = 700;
  return {
    style: style,
    weight: weight,
    italic: /italic|oblique/.test(s),
    // Prefer plain styles over width/optical variants with the same weight.
    penalty: /condensed|narrow|compressed|expanded|extended|wide|display|caption|subhead|poster/.test(s) ? 50 : 0,
  };
}

async function buildFontIndex() {
  const idx = new Map();
  for (const f of await figma.listAvailableFontsAsync()) {
    const key = f.fontName.family.toLowerCase();
    let entry = idx.get(key);
    if (!entry) {
      entry = { family: f.fontName.family, styles: [] };
      idx.set(key, entry);
    }
    entry.styles.push(describeStyle(f.fontName.style));
  }
  return idx;
}

function resolveFont(idx, spec) {
  let key = null;
  for (const raw of spec.families) {
    const name = raw.toLowerCase();
    if (idx.has(name)) {
      key = name;
      break;
    }
    const generic = GENERIC_ALIASES[name];
    if (!generic || generic === 'skip') continue;
    const hit = GENERIC_FAMILIES[generic].find((f) => idx.has(f.toLowerCase()));
    if (hit) {
      key = hit.toLowerCase();
      break;
    }
  }
  if (!key) key = idx.has('inter') ? 'inter' : null;
  if (!key) return FALLBACK_FONT;
  const entry = idx.get(key);
  let best = null;
  let bestScore = Infinity;
  for (const s of entry.styles) {
    const score = Math.abs(s.weight - spec.weight) + (s.italic !== !!spec.italic ? 1000 : 0) + s.penalty;
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return { family: entry.family, style: best.style };
}

function collectFontSpecs(n, out) {
  if (n.type === 'TEXT') for (const s of n.segments) out.set(specKey(s.font), s.font);
  if (n.children) for (const c of n.children) collectFontSpecs(c, out);
}

async function prepareFonts(root) {
  const specs = new Map();
  collectFontSpecs(root, specs);
  const idx = await buildFontIndex();
  const resolved = new Map();
  const toLoad = new Map();
  toLoad.set(FALLBACK_FONT.family + '\u0000' + FALLBACK_FONT.style, FALLBACK_FONT);
  for (const [key, spec] of specs) {
    const fn = resolveFont(idx, spec);
    resolved.set(key, fn);
    toLoad.set(fn.family + '\u0000' + fn.style, fn);
  }
  const failed = new Set();
  await Promise.all(Array.from(toLoad.entries()).map(([k, fn]) => figma.loadFontAsync(fn).catch(() => failed.add(k))));
  return (spec) => {
    const fn = resolved.get(specKey(spec));
    return fn && !failed.has(fn.family + '\u0000' + fn.style) ? fn : FALLBACK_FONT;
  };
}
