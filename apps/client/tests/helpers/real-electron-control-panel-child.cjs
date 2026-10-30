'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Module } = require('node:module');
const ts = require('typescript');
app.disableHardwareAcceleration();
app.setPath('userData', process.env.EGO_CONTROL_PROFILE);
let window;
let state = {
  inputInterceptRequested: false,
  inputInterceptEffective: false,
  windows: {},
  presentation: { menuExpanded: false },
};
const samples = [];
const filename = path.resolve(
  __dirname,
  '../../src/main/electron/example-overlay-windows.ts',
);
function load(filename) {
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = (name) => {
    if (name.startsWith('.'))
      return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return require(name);
  };
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  );
  return mod.exports;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app
  .whenReady()
  .then(async () => {
    const root = path.resolve(__dirname, '../../public');
    global.CONFIG = {
      resolveRendererUrl: (name) =>
        require('node:url').pathToFileURL(path.join(root, name)).href,
    };
    ipcMain.handle('overlay:get-state', () => state);
    let metadata;
    const factory = load(filename).createDemoControlOverlayWindow;
    factory({
      createWindow: (_name, options) => (window = new BrowserWindow(options)),
      attachElectronOverlayWindow: (_window, options) => {
        metadata = options;
        return { show() {} };
      },
    });
    let paint;
    let paintSerial = 0;
    window.webContents.on('paint', (_event, _dirty, image) => {
      paint = image;
      paintSerial++;
    });
    await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      window.webContents.once('did-fail-load', (_e, code, message) =>
        reject(new Error(`${code}: ${message}`)),
      );
    });
    const initial = window.getBounds();
    assert.equal(initial.width, 390);
    assert.equal(initial.height, 390);
    assert.equal(window.webContents.isOffscreen(), true);
    assert.equal(metadata.captionHeight, 54);
    assert.equal(metadata.dragBorder, 8);
    assert.equal(metadata.transparent, true);
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const [requested, effective] of [
        [true, true],
        [false, true],
        [false, false],
      ]) {
        state = {
          ...state,
          inputInterceptRequested: requested,
          inputInterceptEffective: effective,
          presentation: { menuExpanded: requested },
        };
        window.webContents.send('overlay:state-changed', state);
        const deadline = Date.now() + 5000;
        let layout;
        do {
          layout = await window.webContents.executeJavaScript(
            `({width: document.body.getBoundingClientRect().width, height: document.body.getBoundingClientRect().height, expanded: document.body.classList.contains('expanded'), launcher: getComputedStyle(document.querySelector('.launcher')).display, inputState: document.body.dataset.inputState, buttonDisabled: document.querySelector('#demo-open-main').disabled})`,
          );
          if (layout.expanded === requested) break;
          await delay(20);
        } while (Date.now() < deadline);
        assert.equal(layout.expanded, requested);
        // Allow the renderer's state IPC and compositor commit to finish before
        // requesting a new paint; an initial transparent paint is not content.
        await delay(120);
        const serial = paintSerial;
        window.webContents.invalidate();
        while (paintSerial <= serial && Date.now() < deadline) await delay(20);
        assert.ok(
          paintSerial > serial,
          'fresh real offscreen paint after state update',
        );
        assert.deepEqual(window.getBounds(), initial);
        assert.equal(layout.width, requested ? 390 : 320);
        assert.equal(layout.height, requested ? 390 : 170);
        assert.equal(layout.launcher, requested ? 'block' : 'none');
        assert.equal(layout.buttonDisabled, !effective);
        assert.equal(
          layout.inputState,
          requested ? 'interactive' : effective ? 'releasing' : 'passthrough',
        );
        const size = paint.getSize();
        const bitmap = paint.toBitmap();
        assert.deepEqual(size, { width: 390, height: 390 });
        const alpha = (x, y) => bitmap[(y * size.width + x) * 4 + 3];
        let outsideNonzero = 0;
        let outsideChecked = 0;
        if (!requested) {
          for (let y = 0; y < size.height; y++)
            for (let x = 0; x < size.width; x++) {
              if (x >= 320 || y >= 170) {
                outsideChecked++;
                if (alpha(x, y) !== 0) outsideNonzero++;
              }
            }
        }
        const sample = {
          cycle,
          requested,
          effective,
          bounds: window.getBounds(),
          frame: size,
          layout,
          outsideChecked,
          outsideNonzero,
          alpha350x50: alpha(350, 50),
          alpha40x250: alpha(40, 250),
          activeAlpha: alpha(40, 50),
        };
        samples.push(sample);
        assert.ok(sample.activeAlpha > 0, 'active HUD paints');
        if (requested) {
          assert.ok(sample.alpha350x50 > 0);
          assert.ok(sample.alpha40x250 > 0);
        } else {
          assert.equal(
            outsideNonzero,
            0,
            'ALL compact-exterior pixels including shadow must have alpha zero',
          );
        }
      }
    }
    process.send?.({
      passed: true,
      electron: process.versions.electron,
      metadata,
      initial,
      samples,
    });
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    process.send?.({ passed: false, error: error.stack, samples });
    window?.destroy();
    app.exit(1);
  });
app.on('window-all-closed', () => {});
