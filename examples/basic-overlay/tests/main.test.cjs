const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

async function run(args, options = {}) {
  const calls = [];
  const app = new EventEmitter();
  app.disableHardwareAcceleration = () => calls.push('disable-gpu');
  app.whenReady = async () => {};
  app.exit = (code) => {
    calls.push(['exit', code]);
  };
  app.quit = () => {
    calls.push('quit');
    app.emit('before-quit');
  };
  class BrowserWindow {
    constructor() {
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async () => true;
      calls.push('window');
    }
    async loadFile() {
      if (options.loadFailure) throw Error('load failed');
    }
  }
  const session = {
    start: () => calls.push('start'),
    close: () => calls.push('close'),
    windows: {
      create: () => ({ browserWindow: new BrowserWindow(), show() {} }),
    },
  };
  const sdk = {
    ElectronGameOverlay: class {
      constructor() {
        calls.push('owner');
      }
      createSession() {
        calls.push('session');
        return session;
      }
      dispose() {
        calls.push('dispose');
      }
    },
    parseReShadeLaunchConfig: () => {
      calls.push('config');
      return {};
    },
    ReShadeOverlayLauncher: class {
      constructor() {
        calls.push('launcher');
      }
      onEvent(callback) {
        callback({ type: 'injector-watcher-ready' });
      }
      async attach(_session, target) {
        calls.push(['attach', target]);
        if (options.attachFailure) throw Error('attach failed');
        return { processName: target.processName, pid: 123 };
      }
      dispose() {
        calls.push('launcher-dispose');
      }
    },
  };
  const logs = [];
  const processBoundary = {
    argv: ['electron', 'main.cjs', ...args],
    platform: 'win32',
  };
  const entry = path.join(__dirname, '..', 'main.cjs');
  vm.runInNewContext(
    fs.readFileSync(entry, 'utf8'),
    {
      require(name) {
        if (name === 'electron') return { app, BrowserWindow };
        if (name === 'electron-game-overlay') return sdk;
        if (name === 'node:path') return path;
        throw Error(`Unexpected import ${name}`);
      },
      __dirname: path.dirname(entry),
      process: processBoundary,
      console: {
        log: (...v) => logs.push(v.join(' ')),
        error: (...v) => logs.push(v.join(' ')),
      },
      setTimeout,
      clearTimeout,
    },
    { filename: entry },
  );
  for (let i = 0; i < 15; i++) await new Promise(setImmediate);
  return { calls, logs, app };
}

test('invalid or missing targets fail before creating SDK objects', async () => {
  for (const args of [
    [],
    ['--target-process=C:\\game.exe'],
    ['--target-process=.exe'],
    ['--target-process= game.exe'],
    ['--target-process=game.exe', '--target-process=other.exe'],
    ['--smoke', '--reshade-overlay'],
  ]) {
    const { calls } = await run(args);
    assert.ok(
      calls.some(
        (item) => Array.isArray(item) && item[0] === 'exit' && item[1] === 1,
      ),
    );
    assert.ok(!calls.includes('owner'));
  }
});

test('explicit target and opt-in use public launcher name watcher and clean up once', async () => {
  const { calls, logs, app } = await run([
    '--target-process=game.exe',
    '--reshade-overlay',
  ]);
  assert.ok(calls.includes('start'));
  const attach = calls.find(
    (item) => Array.isArray(item) && item[0] === 'attach',
  );
  assert.equal(attach[1].processName, 'game.exe');
  assert.ok(logs.some((line) => line.includes('Launch game.exe now')));
  app.emit('before-quit');
  app.emit('before-quit');
  for (const name of ['launcher-dispose', 'close', 'dispose'])
    assert.equal(calls.filter((v) => v === name).length, 1);
});

test('attachment errors exit unsuccessfully and dispose the session', async () => {
  const { calls, logs } = await run(
    ['--target-process=game.exe', '--reshade-overlay'],
    { attachFailure: true },
  );
  assert.ok(logs.some((line) => line.includes('attach failed')));
  assert.ok(
    calls.some((v) => Array.isArray(v) && v[0] === 'exit' && v[1] === 1),
  );
  assert.ok(calls.includes('launcher-dispose'));
  assert.ok(calls.includes('dispose'));
});

test('renderer load errors fail smoke and dispose the lazy session', async () => {
  const { calls } = await run(['--smoke'], { loadFailure: true });
  assert.ok(
    calls.some((v) => Array.isArray(v) && v[0] === 'exit' && v[1] === 1),
  );
  assert.ok(calls.includes('dispose'));
});

test('smoke creates a DOM window and lazy SDK session without runtime or broker startup', async () => {
  const { calls, logs } = await run(['--smoke']);
  assert.ok(calls.includes('owner'));
  assert.ok(calls.includes('session'));
  assert.ok(calls.includes('window'));
  for (const forbidden of ['config', 'launcher', 'start'])
    assert.ok(!calls.includes(forbidden));
  assert.ok(logs.some((line) => line.includes('SMOKE_OK')));
  assert.equal(calls.filter((item) => item === 'dispose').length, 1);
});
