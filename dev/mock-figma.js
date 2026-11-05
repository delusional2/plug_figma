// Strict-ish mock of the Figma plugin API, enough to exercise code.js.
const vm = require('vm');
const fs = require('fs');
const [codePath, docPath] = process.argv.slice(2);
const errors = [];
const fail = (m) => { errors.push(m); throw new Error(m); };
const num = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} not finite: ${v}`); };
const oneOf = (v, list, what) => { if (!list.includes(v)) fail(`${what}: bad value ${v}`); };
const keysOnly = (o, allowed, what) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what}: unexpected key ${k}`); };
const color = (c, alpha, what) => { keysOnly(c, alpha ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'], what); for (const k of alpha ? 'rgba' : 'rgb') { num(c[k], what + '.' + k); if (c[k] < 0 || c[k] > 1) fail(`${what}.${k} out of range ${c[k]}`); } };
function checkPaint(p) {
  if (p.type === 'SOLID') { keysOnly(p, ['type', 'color', 'opacity'], 'SOLID'); color(p.color, false, 'SOLID.color'); if (p.opacity !== undefined) num(p.opacity, 'opacity'); }
  else if (/^GRADIENT_/.test(p.type)) {
    keysOnly(p, ['type', 'gradientTransform', 'gradientStops'], p.type);
    if (p.gradientTransform.length !== 2) fail('transform rows');
    p.gradientTransform.flat().forEach((v) => num(v, 'gradientTransform'));
    let last = -1;
    for (const s of p.gradientStops) { keysOnly(s, ['position', 'color'], 'stop'); num(s.position, 'stop.position'); if (s.position < last) fail('stops not sorted'); last = s.position; color(s.color, true, 'stop.color'); }
  } else if (p.type === 'IMAGE') { keysOnly(p, ['type', 'imageHash', 'scaleMode'], 'IMAGE'); oneOf(p.scaleMode, ['FILL', 'FIT', 'CROP', 'TILE'], 'scaleMode'); }
  else fail('paint type ' + p.type);
}
function checkEffect(e) {
  if (/SHADOW/.test(e.type)) {
    keysOnly(e, ['type', 'color', 'offset', 'radius', 'spread', 'visible', 'blendMode', 'showShadowBehindNode'], e.type);
    color(e.color, true, 'shadow.color'); num(e.offset.x, 'offset'); num(e.offset.y, 'offset'); num(e.radius, 'radius'); num(e.spread, 'spread');
  } else if (/BLUR/.test(e.type)) { keysOnly(e, ['type', 'radius', 'visible'], e.type); num(e.radius, 'blur'); }
  else fail('effect ' + e.type);
}

const FONTS = [];
for (const fam of ['Inter', 'Arial', 'Roboto Mono', 'Georgia']) for (const st of ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black', 'Italic', 'Bold Italic']) FONTS.push({ fontName: { family: fam, style: st } });
const loaded = new Set();
const fk = (f) => f.family + '/' + f.style;

let ids = 0;
class Node {
  constructor(type) { this.type = type; this.id = String(++ids); this.children = []; this.parent = null; this.removed = false; this._x = 0; this._y = 0; this.width = 100; this.height = 100; this.name = type; this.opacity = 1; }
  set x(v) { num(v, 'x'); this._x = v; } get x() { return this._x; }
  set y(v) { num(v, 'y'); this._y = v; } get y() { return this._y; }
  appendChild(c) { if (!this.children) fail('no children'); if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.removed = true; }
  resize(w, h) { num(w, 'w'); num(h, 'h'); if (w < 0.01 || h < 0.01) fail(`resize too small ${w}x${h}`); this.width = w; this.height = h; }
  set opacity(v) { num(v, 'opacity'); this._o = v; } get opacity() { return this._o; }
  set fills(v) { v.forEach(checkPaint); this._fills = v; } get fills() { return this._fills; }
  set strokes(v) { v.forEach(checkPaint); this._strokes = v; } get strokes() { return this._strokes; }
  set effects(v) { v.forEach(checkEffect); this._effects = v; } get effects() { return this._effects; }
  set layoutAlign(v) { oneOf(v, ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'], 'layoutAlign'); if (!this.parent || this.parent.layoutMode === 'NONE') fail('layoutAlign outside AL'); this._la = v; } get layoutAlign() { return this._la; }
  set relativeTransform(m) {
    if (!Array.isArray(m) || m.length !== 2 || m.some((r) => !Array.isArray(r) || r.length !== 3)) fail('relativeTransform shape');
    m.flat().forEach((v) => num(v, 'relativeTransform'));
    if (Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]) < 1e-6) fail('relativeTransform singular');
    if (this.parent && this.parent.layoutMode && this.parent.layoutMode !== 'NONE' && this._lp !== 'ABSOLUTE') fail('relativeTransform on an auto-layout child');
    this._rt = m; this._x = m[0][2]; this._y = m[1][2];
  }
  get relativeTransform() { return this._rt || [[1, 0, this._x], [0, 1, this._y]]; }
  set isMask(v) { if (typeof v !== 'boolean') fail('isMask'); if (!this.parent) fail('isMask before append'); this._mask = v; } get isMask() { return !!this._mask; }
  set maskType(v) { oneOf(v, ['ALPHA', 'VECTOR', 'LUMINANCE'], 'maskType'); if (!this._mask) fail('maskType without isMask'); }
  set constraints(v) { keysOnly(v, ['horizontal', 'vertical'], 'constraints'); oneOf(v.horizontal, ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'], 'constraints.horizontal'); oneOf(v.vertical, ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'], 'constraints.vertical'); this._cons = v; } get constraints() { return this._cons; }
  set layoutGrow(v) { oneOf(v, [0, 1], 'layoutGrow'); if (!this.parent || !this.parent.layoutMode || this.parent.layoutMode === 'NONE') fail('layoutGrow outside AL'); this._lg = v; } get layoutGrow() { return this._lg || 0; }
  set layoutPositioning(v) { oneOf(v, ['AUTO', 'ABSOLUTE'], 'layoutPositioning'); if (v === 'ABSOLUTE' && (!this.parent || !this.parent.layoutMode || this.parent.layoutMode === 'NONE')) fail('ABSOLUTE outside AL'); this._lp = v; } get layoutPositioning() { return this._lp; }
}
class Frame extends Node {
  constructor() { super('FRAME'); this.layoutMode = 'NONE'; this.clipsContent = true; }
  set layoutMode(v) { oneOf(v, ['NONE', 'HORIZONTAL', 'VERTICAL'], 'layoutMode'); this._lm = v; } get layoutMode() { return this._lm; }
  set primaryAxisAlignItems(v) { oneOf(v, ['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'], 'primaryAxisAlignItems'); }
  set counterAxisAlignItems(v) { oneOf(v, ['MIN', 'MAX', 'CENTER', 'BASELINE'], 'counterAxisAlignItems'); }
  set primaryAxisSizingMode(v) { oneOf(v, ['FIXED', 'AUTO'], 'primaryAxisSizingMode'); }
  set counterAxisSizingMode(v) { oneOf(v, ['FIXED', 'AUTO'], 'counterAxisSizingMode'); }
  set itemSpacing(v) { num(v, 'itemSpacing'); }
  set numberOfFixedChildren(v) { if (!(Number.isInteger(v) && v >= 0 && v <= this.children.length)) fail('numberOfFixedChildren ' + v); }
  set itemReverseZIndex(v) { if (typeof v !== 'boolean') fail('itemReverseZIndex'); if (this._lm === 'NONE') fail('itemReverseZIndex without layout'); }
  set paddingTop(v) { num(v, 'pad'); if (v < 0) fail('neg pad'); } set paddingRight(v) { num(v, 'pad'); if (v < 0) fail('neg pad'); }
  set paddingBottom(v) { num(v, 'pad'); if (v < 0) fail('neg pad'); } set paddingLeft(v) { num(v, 'pad'); if (v < 0) fail('neg pad'); }
  set strokeWeight(v) { num(v, 'strokeWeight'); } set strokeTopWeight(v) { num(v, 'sw'); } set strokeRightWeight(v) { num(v, 'sw'); } set strokeBottomWeight(v) { num(v, 'sw'); } set strokeLeftWeight(v) { num(v, 'sw'); }
  set strokeAlign(v) { oneOf(v, ['INSIDE', 'OUTSIDE', 'CENTER'], 'strokeAlign'); }
  set topLeftRadius(v) { num(v, 'radius'); } set topRightRadius(v) { num(v, 'radius'); } set bottomLeftRadius(v) { num(v, 'radius'); } set bottomRightRadius(v) { num(v, 'radius'); }
  set dashPattern(v) { v.forEach((d) => num(d, 'dash')); }
}
class Rect extends Frame { constructor() { super(); this.type = 'RECTANGLE'; this.children = null; } }
class Shape extends Node {
  constructor(type) { super(type); this.children = null; }
  set strokeWeight(v) { num(v, 'strokeWeight'); if (v < 0) fail('neg strokeWeight'); }
  set strokeAlign(v) { oneOf(v, ['INSIDE', 'OUTSIDE', 'CENTER'], 'strokeAlign'); }
  set dashPattern(v) { v.forEach((d) => num(d, 'dash')); }
}
class Ellipse extends Shape { constructor() { super('ELLIPSE'); } }
class Vector extends Shape {
  constructor() { super('VECTOR'); }
  set vectorPaths(v) {
    if (!Array.isArray(v) || !v.length) fail('vectorPaths');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of v) {
      keysOnly(p, ['windingRule', 'data'], 'vectorPath'); oneOf(p.windingRule, ['NONZERO', 'EVENODD', 'NONE'], 'windingRule');
      if (typeof p.data !== 'string' || !/^\s*M/.test(p.data) || /[^MLQCZ0-9.eE\s-]/.test(p.data)) fail('vectorPath data: ' + String(p.data).slice(0, 60));
      const nums = p.data.match(/-?[\d.]+(?:e-?\d+)?/g) || [];
      if (nums.length % 2) fail('vectorPath odd coordinates');
      for (let i = 0; i < nums.length; i += 2) { const x = +nums[i], y = +nums[i + 1]; num(x, 'path x'); num(y, 'path y'); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    this.width = Math.max(0.01, x1 - x0); this.height = Math.max(0.01, y1 - y0); this._vp = v;
  }
  get vectorPaths() { return this._vp; }
}
class Text extends Node {
  constructor() { super('TEXT'); this.children = null; this._font = { family: 'Inter', style: 'Regular' }; this._chars = ''; }
  set fontName(f) { if (!loaded.has(fk(f))) fail('font not loaded ' + fk(f)); this._font = f; } get fontName() { return this._font; }
  set characters(s) { if (!loaded.has(fk(this._font))) fail('current font not loaded'); if (typeof s !== 'string') fail('chars'); this._chars = s; } get characters() { return this._chars; }
  _range(a, b) { if (!(a >= 0 && b <= this._chars.length && a < b)) fail(`bad range ${a}-${b} of ${this._chars.length}`); }
  setRangeFontName(a, b, f) { this._range(a, b); if (!loaded.has(fk(f))) fail('range font not loaded ' + fk(f)); }
  setRangeFontSize(a, b, s) { this._range(a, b); num(s, 'fontSize'); }
  setRangeFills(a, b, f) { this._range(a, b); f.forEach(checkPaint); }
  setRangeTextDecoration(a, b, d) { this._range(a, b); oneOf(d, ['NONE', 'UNDERLINE', 'STRIKETHROUGH'], 'decoration'); }
  setRangeLetterSpacing(a, b, v) { this._range(a, b); keysOnly(v, ['value', 'unit'], 'ls'); num(v.value, 'ls'); }
  setRangeLineHeight(a, b, v) { this._range(a, b); if (v.unit === 'AUTO') keysOnly(v, ['unit'], 'lh'); else { keysOnly(v, ['value', 'unit'], 'lh'); num(v.value, 'lh'); } }
  setRangeTextCase(a, b, v) { this._range(a, b); oneOf(v, ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE'], 'textCase'); }
  set textAutoResize(v) { oneOf(v, ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'], 'textAutoResize'); this._ar = v; } get textAutoResize() { return this._ar || 'NONE'; }
  set textAlignHorizontal(v) { oneOf(v, ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'], 'align'); }
  set textTruncation(v) { oneOf(v, ['DISABLED', 'ENDING'], 'textTruncation'); this._tt = v; } get textTruncation() { return this._tt || 'DISABLED'; }
  set maxLines(v) { if (v !== null && !(Number.isInteger(v) && v >= 1)) fail('maxLines: bad value ' + v); if (v !== null && this._tt !== 'ENDING') fail('maxLines without textTruncation ENDING'); this._ml = v; } get maxLines() { return this._ml == null ? null : this._ml; }
}
const page = new Node('PAGE');
page.selection = [];
const messages = [];
const figma = {
  showUI() {}, notify(t) { messages.push('notify: ' + t); },
  ui: { postMessage(m) { messages.push(m); }, onmessage: null },
  clientStorage: { getAsync: async () => null, setAsync: async () => {} },
  currentPage: page,
  viewport: { scrollAndZoomIntoView() {} },
  createFrame() { const f = new Frame(); page.appendChild(f); return f; },
  createRectangle() { const r = new Rect(); page.appendChild(r); return r; },
  createEllipse() { const e = new Ellipse(); page.appendChild(e); return e; },
  createVector() { const v = new Vector(); page.appendChild(v); return v; },
  createText() { const t = new Text(); page.appendChild(t); return t; },
  createNodeFromSvg(svg) {
    if (!/^<svg[\s>]/.test(svg)) fail('svg parse');
    const f = new Frame(); page.appendChild(f);
    f.width = parseFloat(/width="([\d.]+)"/.exec(svg)[1]); f.height = parseFloat(/height="([\d.]+)"/.exec(svg)[1]);
    return f;
  },
  createImage(bytes) { if (!(bytes instanceof Uint8Array)) fail('bytes'); return { hash: 'h' + bytes.length }; },
  createImageAsync: async (url) => { if (/fail/.test(url)) throw new Error('nope'); return { hash: 'url:' + url.length }; },
  listAvailableFontsAsync: async () => FONTS,
  loadFontAsync: async (f) => { if (!FONTS.some((x) => fk(x.fontName) === fk(f))) throw new Error('no font ' + fk(f)); loaded.add(fk(f)); },
};
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
for (const im of doc.images || []) { if (Array.isArray(im.bytes)) im.bytes = Uint8Array.from(im.bytes); else if (typeof im.bytes === 'string') im.bytes = new Uint8Array(Buffer.from(im.bytes, 'base64')); }
vm.runInNewContext(fs.readFileSync(codePath, 'utf8'), { figma, __html__: '', console, Object, Array, Math, Map, Set, Promise, String, JSON, Infinity, setTimeout, clearTimeout });
(async () => {
  await figma.ui.onmessage({ type: 'import', doc });
  const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
  const root = page.children[page.children.length - 1];
  console.log('messages:', JSON.stringify(messages.filter((m) => typeof m === 'string' || m.type !== 'progress')));
  console.log('page children:', page.children.length, 'root:', root.name, root.width + 'x' + root.height, 'tree nodes:', count(root) - 1);
  console.log('errors:', errors.length ? [...new Set(errors)] : 'none');
})();
