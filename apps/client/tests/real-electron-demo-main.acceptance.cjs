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
    controlled: ['SDK attachment and visibility', 'sender-scoped fixture IPC provider calling actual production factories'],
    real: ['production Main/popup/video factories and HTML', 'genuine Electron BrowserWindows, OSR paint, mouse/key input, setPosition/getBounds'],
    excluded: ['game injection', 'native hit testing and dragging', 'broker', 'Application/app-entry IPC registration', 'SDK visibility/reopen', 'video playback/decoding (paint only)', 'independent app processes (two factory contexts in one Electron main)'] };
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
    let source = fs.readFileSync(filename, 'utf8');
    if (process.env.EGO_MAIN_RESIZE_EXISTING === '1' && filename.endsWith('example-overlay-windows.ts')) {
      const anchor = 'export function createExamplePopupOverlayWindow(context: OverlayWindowContext) {';
      assert.ok(source.includes(anchor), 'negative control source anchor');
      source = source.replace(anchor, anchor + `\n require('electron').BrowserWindow.getAllWindows().filter(w => w.getBounds().width === 640).forEach(w => w.setSize(900,700));`);
    }
    mod._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, filename);
    return mod.exports;
  }
  app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '..');
    global.CONFIG = { resolveRendererUrl: (name) => require('node:url').pathToFileURL(path.join(root, 'public', name)).href };
    const factories = load(path.join(root, 'src/main/electron/example-overlay-windows.ts'));
    const { AppWindows } = load(path.join(root, 'src/main/electron/window-names.ts'));
    const contexts = new Map();
    const locals = [];
    const calls = [];
    const samples = [];
    const delay = () => new Promise(resolve => setTimeout(resolve, 30));
    const wait = async (predicate) => {
      const deadline = Date.now() + 4000;
      while (!await predicate()) { assert.ok(Date.now() < deadline, 'Electron action deadline'); await delay(); }
    };
    const snapshot = async () => Promise.all(locals.map(async local => ({
      id: local.window.id, visible: local.visible, bounds: local.window.getBounds(),
      text: await local.window.webContents.executeJavaScript(`document.getElementById('hudhook-client-input-target').value`),
    })));
    const verify = async (step) => {
      const state = await snapshot();
      for (const [index, actual] of state.entries()) {
        assert.deepEqual(actual.bounds, locals[index].expectedBounds, `${step}: peer/Main bounds unchanged`);
        assert.equal(actual.text, locals[index].text, `${step}: real DOM text retained`);
        assert.equal(actual.id, locals[index].id, `${step}: Hide/reopen must not recreate Main`);
      }
      for (const local of locals) for (const item of local.created) {
        if (!item.window.isDestroyed()) assert.deepEqual(item.window.getBounds(), item.expectedBounds, `${step}: every surviving real window retains placement/size`);
      }
      samples.push({ step, state });
    };
    const click = async (local, selector) => {
      const point = await local.window.webContents.executeJavaScript(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+15),y:Math.round(r.y+15)}; })()`);
      for (const type of ['mouseDown', 'mouseUp']) local.window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
      await delay();
    };
    const type = async (local, text) => {
      await click(local, '#hudhook-client-input-target');
      local.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
      local.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
      for (const keyCode of text) {
        local.window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (process.env.EGO_MAIN_DROP_CHAR !== '1') local.window.webContents.sendInputEvent({ type: 'char', keyCode });
        local.window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      }
      local.text += text;
      await delay();
      assert.equal(await local.window.webContents.executeJavaScript(`document.getElementById('hudhook-client-input-target').value`), local.text, 'real DOM input must receive character');
    };
    ipcMain.handle('overlay:set-window-visible', (event, name, visible) => {
      assert.equal(name, AppWindows.exampleMainOverlay);
      const local = contexts.get(event.sender.id);
      assert.ok(local, 'sender-scoped Main visibility');
      local.visible = visible; calls.push({ sender: event.sender.id, visible }); return {};
    });
    for (const [channel, factory] of [['showExamplePopupOverlay', factories.createExamplePopupOverlayWindow], ['showExampleVideoOverlay', factories.createExampleVideoOverlayWindow]]) {
      ipcMain.on(channel, event => {
        const local = contexts.get(event.sender.id);
        assert.ok(local, 'known Main opens its own production factory window');
        factory(local.context);
      });
    }
    for (let client = 0; client < 2; client++) {
      const local = { visible: false, follows: [], text: '', named: new Map(), created: [] };
      local.context = { demoPresentation: true, gunFrogInputProof: false,
        createWindow(name, options) {
          const window = new BrowserWindow(options); windows.push(window);
          local.named.set(name, window);
          const item = { id: window.id, name, window, expectedBounds: window.getBounds(), paints: 0, loaded: false };
          local.created.push(item);
          window.webContents.on('paint', () => item.paints++);
          window.webContents.once('did-finish-load', () => { item.loaded = true; });
          if (name === AppWindows.exampleMainOverlay) { local.window = window; contexts.set(window.webContents.id, local); }
          return window;
        },
        closeWindow(name) { const old = local.named.get(name); if (old && !old.isDestroyed()) old.destroy(); },
        attachElectronOverlayWindow(window, metadata) {
          if (window === local.window) local.metadata = metadata;
          return { show() { if (window === local.window) local.visible = true; }, followTarget(value) { local.follows.push(value); } };
        },
        onGunFrogButtonsReady() {}, isQuitting: () => false, getMainWindow: () => null,
      };
      factories.createExampleMainOverlayWindow(local.context);
      await wait(() => local.created[0].loaded && local.created[0].paints > 0);
      local.id = local.window.id;
      assert.deepEqual(local.follows, []);
      assert.deepEqual([local.window.getBounds().width, local.window.getBounds().height], [640, 360]);
      local.window.setPosition(70 + client * 220, 90 + client * 80);
      local.expectedBounds = local.window.getBounds();
      local.created[0].expectedBounds = local.expectedBounds;
      const layout = await local.window.webContents.executeJavaScript(`(() => { const r=document.getElementById('hide-main-overlay').getBoundingClientRect(); return {hide:{y:r.y,height:r.height},input:window.hudhookInputProof.getTargetRect(),background:getComputedStyle(document.body).backgroundColor}; })()`);
      assert.ok(layout.hide.y >= local.metadata.captionHeight && layout.hide.y + layout.hide.height < 350, 'Hide avoids native caption and drag border');
      assert.deepEqual([layout.input.x, layout.input.y], [24, 112]);
      assert.equal(layout.background, 'rgb(21, 28, 40)');
      assert.deepEqual([local.expectedBounds.x, local.expectedBounds.y], [70 + client * 220, 90 + client * 80], 'real Electron movement');
      locals.push(local);
      await type(local, client ? 'b' : 'a');
      await verify(`initial move/type ${client}`);
    }
    for (let round = 0; round < 3; round++) for (const [client, local] of locals.entries()) {
      for (const [selector, kind] of [['#show-popup-overlay', 'popup'], ['#show-video-overlay', 'video']]) {
        const before = local.created.length;
        await click(local, selector);
        await wait(() => local.created.length === before + 1 && local.created.at(-1).loaded && local.created.at(-1).paints > 0);
        const fresh = local.created.at(-1);
        assert.ok(!fresh.window.isDestroyed() && fresh.window.webContents.isOffscreen(), 'new genuine OSR window exists and paints');
        await verify(`${client}/${round}/${kind} creation`);
        await type(local, client ? 'B' : 'A');
        await verify(`${client}/${round}/${kind} typing`);
        samples.push({ step: 'fresh window', client, kind, id: fresh.id, bounds: fresh.window.getBounds(), paints: fresh.paints, url: fresh.window.webContents.getURL() });
      }
      await click(local, '#hide-main-overlay');
      await wait(() => !local.visible);
      assert.equal(locals[1-client].visible, true, 'peer remains visible');
      await verify('Hide');
      local.visible = true; // controlled SDK visibility, not Application reopen IPC
      await type(local, 'x');
      await verify('reopen and continue typing');
    }
    assert.equal(calls.length, 6);
    process.send?.({ passed: true, electron: process.versions.electron, samples, hideCalls: calls.length, createdWindows: locals.map(local => local.created.map(({id,name,paints}) => ({id,name,paints}))) });
    windows.forEach((window) => { if (!window.isDestroyed()) window.destroy(); }); app.quit();
  }).catch((error) => {
    process.send?.({ passed: false, error: error.stack });
    windows.forEach((window) => { if (!window.isDestroyed()) window.destroy(); }); app.exit(1);
  });
}
