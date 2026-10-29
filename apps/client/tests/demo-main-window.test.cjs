const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(filename) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => {
    if (name === 'electron') return { screen: {} };
    if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return require(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const { AppWindows } = load(path.join(root, 'src/main/electron/window-names.ts'));
const { createExampleMainOverlayWindow } = load(path.join(root, 'src/main/electron/example-overlay-windows.ts'));
function factory(flags = {}) {
  let options, metadata;
  const follows = [];
  const window = { webContents: new EventEmitter(), loadURL() {} };
  const overlay = { show() {}, followTarget(value) { follows.push(value); } };
  global.CONFIG = { resolveRendererUrl: (name) => name };
  createExampleMainOverlayWindow({
    demoPresentation: true, gunFrogInputProof: false, ...flags,
    createWindow(name, value) { assert.equal(name, AppWindows.exampleMainOverlay); options = value; return window; },
    attachElectronOverlayWindow(_window, value) { metadata = value; return overlay; },
    isQuitting: () => false, getMainWindow: () => null, onGunFrogButtonsReady() {},
  });
  return { options, metadata, follows };
}
test('two ordinary demo Main factories remain bounded and natively draggable', () => {
  for (let client = 0; client < 2; client++) {
    const { options, metadata, follows } = factory();
    assert.deepEqual(follows, [], 'ordinary demo must not replace local bounds with full target render area');
    assert.equal(options.width, 640);
    assert.equal(options.height, 360);
    assert.ok(options.x >= 0 && options.x + options.width <= 1366);
    assert.ok(options.y >= 0 && options.y + options.height <= 768);
    assert.equal(metadata.captionHeight, 40);
    assert.equal(metadata.dragBorder, 10);
  }
});
test('explicit Gun Frog proof retains unchanged bounded geometry without target following', () => {
  const { options, follows } = factory({ demoPresentation: false, gunFrogInputProof: true });
  assert.deepEqual(follows, [], 'actual proof must not replace its fixed bounds with the target render area');
  assert.deepEqual(
    { x: options.x, y: options.y, width: options.width, height: options.height },
    { x: 64, y: 270, width: 640, height: 360 },
  );
});
function renderer() {
  const source = fs.readFileSync(path.join(root, 'public/index/example-main-overlay.html'), 'utf8');
  class Element extends EventEmitter {
    constructor(id) { super(); this.id = id; this.style = {}; this.value = ''; }
    addEventListener(name, fn) { this.on(name, fn); }
    getBoundingClientRect() { return { x: 24, y: 112, width: 240, height: 36 }; }
  }
  const elements = new Map([...source.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const calls = [], sizes = [];
  const visibility = new Map([[AppWindows.exampleMainOverlay, true], [AppWindows.demoControlOverlay, true], ['peer-main', true]]);
  const ipcRenderer = {
    invoke(channel, name, visible) { calls.push([channel, name, visible]); assert.equal(channel, 'overlay:set-window-visible'); assert.equal(name, AppWindows.exampleMainOverlay); visibility.set(name, visible); return Promise.resolve({}); },
    send(channel) { calls.push([channel]); },
  };
  const document = { getElementById: (id) => elements.get(id), addEventListener() {}, createElement: () => new Element(''), body: { appendChild() {} } };
  const window = { innerWidth: 640, innerHeight: 360, require(name) { assert.equal(name, 'electron'); return { ipcRenderer, remote: { getCurrentWindow: () => ({ setSize: (...args) => sizes.push(args) }) } }; } };
  vm.runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document, Element, HTMLInputElement: Element, setInterval() {}, console });
  return { source, elements, calls, sizes, visibility, window };
}
test('actual HTML hides only Main and preserves its local text across reopen', async () => {
  const r = renderer();
  const input = r.elements.get('hudhook-client-input-target');
  input.value = 'retained local text';
  const hide = r.elements.get('hide-main-overlay');
  assert.ok(hide, 'visible Hide Main action is required');
  hide.emit('click');
  await Promise.resolve();
  assert.deepEqual(r.calls, [['overlay:set-window-visible', AppWindows.exampleMainOverlay, false]]);
  assert.equal(r.visibility.get(AppWindows.exampleMainOverlay), false);
  assert.equal(r.visibility.get(AppWindows.demoControlOverlay), true);
  assert.equal(r.visibility.get('peer-main'), true);
  r.visibility.set(AppWindows.exampleMainOverlay, true);
  assert.equal(input.value, 'retained local text');
});
test('actual popup event sends existing IPC without growing Main', () => {
  const r = renderer();
  for (let i = 0; i < 3; i++) r.elements.get('show-popup-overlay').emit('click');
  assert.deepEqual(r.sizes, [], 'popup must not resize Main');
  assert.deepEqual(r.calls, Array.from({ length: 3 }, () => ['showExamplePopupOverlay']));
});
module.exports = { factory, renderer };
