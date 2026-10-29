'use strict';
// Opt-in software-rendered Electron acceptance; SDK attachment/visibility is controlled.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { fork } = require('node:child_process');
  const reportPath = path.resolve(process.argv[2] || 'demo-main-electron.json');
  const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'ego-main-ui-'));
  const report = { passed: false, nativeExecuted: false, platform: process.platform,
    controlled: ['SDK attachment and visibility', 'sender-scoped IPC state provider'],
    excluded: ['game injection', 'native hit testing and dragging', 'broker', 'app-entry IPC registration'] };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const env = { ...process.env, EGO_MAIN_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = fork(__filename, [], { execPath: require('electron'),
    execArgv: ['--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])],
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume();
  report.stderr = '';
  child.stderr.on('data', (data) => { report.stderr = (report.stderr + data).slice(-8000); });
  child.on('message', (message) => { report.result = message; });
  child.on('error', (error) => { report.error = error.stack; });
  const timer = setTimeout(() => { report.error = '35s deadline exceeded'; child.kill('SIGKILL'); }, 35000);
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    report.exit = { code, signal };
    report.passed = code === 0 && report.result?.passed === true;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { Module } = require('node:module');
  const ts = require('typescript');
  const windows = [];
  app.disableHardwareAcceleration();
  app.setPath('userData', process.env.EGO_MAIN_PROFILE);
  function load(filename) {
    const mod = new Module(filename);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = (name) => name.startsWith('.') ? load(path.resolve(path.dirname(filename), `${name}.ts`)) : require(name);
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, filename);
    return mod.exports;
  }
  app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '..');
    global.CONFIG = { resolveRendererUrl: (name) => require('node:url').pathToFileURL(path.join(root, 'public', name)).href };
    const factory = load(path.join(root, 'src/main/electron/example-overlay-windows.ts')).createExampleMainOverlayWindow;
    const { AppWindows } = load(path.join(root, 'src/main/electron/window-names.ts'));
    const contexts = new Map();
    const calls = [];
    ipcMain.handle('overlay:set-window-visible', (event, name, visible) => {
      assert.equal(name, AppWindows.exampleMainOverlay);
      assert.equal(typeof visible, 'boolean');
      const local = contexts.get(event.sender.id);
      assert.ok(local, 'only a known renderer may change its local Main');
      local.visible = visible;
      calls.push({ sender: event.sender.id, name, visible });
      return {};
    });
    let popups = 0;
    ipcMain.on('showExamplePopupOverlay', () => { popups++; });
    const samples = [];
    for (let client = 0; client < 2; client++) {
      const local = { visible: false, controlVisible: true, follows: [] };
      factory({ demoPresentation: true, gunFrogInputProof: false,
        createWindow(_name, options) {
          local.window = new BrowserWindow(options); windows.push(local.window);
          contexts.set(local.window.webContents.id, local); return local.window;
        },
        attachElectronOverlayWindow(_window, metadata) {
          local.metadata = metadata;
          local.overlay = { show() { local.visible = true; }, followTarget(value) { local.follows.push(value); } };
          return local.overlay;
        },
        onGunFrogButtonsReady() {}, isQuitting: () => false, getMainWindow: () => null,
      });
      await new Promise((resolve, reject) => {
        local.window.webContents.once('did-finish-load', resolve);
        local.window.webContents.once('did-fail-load', (_e, code, message) => reject(new Error(`${code}: ${message}`)));
      });
      const wc = local.window.webContents;
      assert.deepEqual(local.follows, []);
      const bounds = local.window.getBounds();
      assert.equal(bounds.width, 640); assert.equal(bounds.height, 360);
      assert.ok(bounds.x + bounds.width <= 1366 && bounds.y + bounds.height <= 768);
      const layout = await wc.executeJavaScript(`(() => {
        const rect = document.getElementById('hide-main-overlay').getBoundingClientRect();
        const input = document.getElementById('hudhook-client-input-target');
        input.value = 'client-${client} retained';
        return { hide: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          input: window.hudhookInputProof.getTargetRect(), background: getComputedStyle(document.body).backgroundColor };
      })()`);
      assert.ok(layout.hide.y >= local.metadata.captionHeight, 'Hide action must be below native caption');
      assert.ok(layout.hide.y + layout.hide.height < 350, 'Hide action avoids drag border');
      assert.deepEqual([layout.input.x, layout.input.y], [24, 112]);
      assert.equal(layout.background, 'rgb(21, 28, 40)');
      wc.sendInputEvent({ type: 'mouseDown', x: Math.round(layout.hide.x + 15), y: Math.round(layout.hide.y + 15), button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(layout.hide.x + 15), y: Math.round(layout.hide.y + 15), button: 'left', clickCount: 1 });
      const deadline = Date.now() + 3000;
      while (local.visible && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(local.visible, false, 'genuine Electron mouse input activates Hide');
      assert.equal(local.controlVisible, true);
      for (const peer of contexts.values()) if (peer !== local) assert.equal(peer.visible, true);
      local.overlay.show();
      assert.equal(await wc.executeJavaScript(`document.getElementById('hudhook-client-input-target').value`), `client-${client} retained`);
      await wc.executeJavaScript(`for (let i=0;i<3;i++) document.getElementById('show-popup-overlay').click()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(local.window.getBounds(), bounds);
      samples.push({ client, bounds, layout, metadata: local.metadata });
    }
    assert.equal(calls.length, 2); assert.equal(popups, 6);
    process.send?.({ passed: true, electron: process.versions.electron, samples, hideCalls: calls.length, popups });
    windows.forEach((window) => window.destroy()); app.quit();
  }).catch((error) => {
    process.send?.({ passed: false, error: error.stack });
    windows.forEach((window) => window.destroy()); app.exit(1);
  });
}
