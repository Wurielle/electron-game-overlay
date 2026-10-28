import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const entry = fileURLToPath(
  new URL('../src/main/electron/app-entry.ts', import.meta.url),
);

// Compile the actual application graph; only Electron and the SDK are controlled.
function boundary() {
  let nextId = 1;
  const sessions = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.id = nextId++;
      this.bounds = { ...options };
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        send() {},
        isDestroyed: () => false,
        invalidate: () => this.calls.push('invalidate'),
      });
      this.calls = [];
    }
    loadURL() {}
    isDestroyed() {
      return false;
    }
    getContentBounds() {
      return this.bounds;
    }
  }
  class Session extends EventEmitter {
    constructor() {
      super();
      this.targets = { list: () => [] };
      this.windows = {
        attach: (window, options) => this.attachElectronWindow(window, options),
      };
      this.inputCalls = [];
      this.input = {
        intercept: () => this.inputCalls.push(true),
        release: () => this.inputCalls.push(false),
      };
      sessions.push(this);
    }
    onQuit(callback) {
      this.on('quit', callback);
    }
    attachElectronWindow(window, options) {
      return {
        browserWindow: window,
        nativeId: window.id,
        visible: false,
        options,
        show() {
          window.calls.push('show');
          this.visible = true;
        },
        hide() {
          window.calls.push('hide');
          this.visible = false;
        },
        setBounds(bounds) {
          window.calls.push(['bounds', bounds]);
          Object.assign(window.bounds, bounds);
        },
        onClose() {},
        followTarget() {},
      };
    }
    start() {}
  }
  const sdk = {
    ElectronGameOverlay: class {
      createSession() {
        this.session = new Session();
        return this.session;
      }
      dispose() {
        this.session.removeAllListeners();
      }
    },
  };
  const electron = {
    BrowserWindow: Window,
    globalShortcut: { register: () => true, unregister() {} },
  };
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename);
    cache.set(filename, mod);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = (specifier) => {
      if (specifier === 'electron') return electron;
      if (specifier === 'electron-game-overlay') return sdk;
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        if (existsSync(`${resolved}.ts`)) return load(`${resolved}.ts`);
      }
      return createRequire(filename)(specifier);
    };
    mod._compile(
      ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      filename,
    );
    return mod.exports;
  }
  return { Application: load(entry).Application, sessions };
}

async function withApps(flags, run) {
  const savedArgv = process.argv;
  const savedConfig = global.CONFIG;
  process.argv = [...savedArgv, '--demo-presentation', ...flags];
  global.CONFIG = { resolveRendererUrl: (value) => value };
  const { Application, sessions } = boundary();
  const apps = [new Application(), new Application()];
  try {
    await run(apps, sessions);
  } finally {
    apps.forEach((app) => app.dispose());
    process.argv = savedArgv;
    global.CONFIG = savedConfig;
  }
}

for (const flags of [[], ['--steam-exact-pid-only']]) {
  const mode = flags.length ? 'exact-PID' : 'ordinary';
  test(`${mode}: actual two-app focus callbacks preserve visible control geometry and native focus diagnostics`, async () => {
    await withApps(flags, async (apps, sessions) => {
      const controls = apps.map((app) => {
        app.syncDemoControlOverlay();
        return app.overlayWindows.get('demo-control-overlay');
      });
      const records = [[], []];
      apps.forEach((app, index) => {
        app.compatibilityRunRecorder = {
          recordNativeEvent: (...args) => records[index].push(args),
          close() {},
        };
      });
      for (const windowId of [0, 900, controls[0].nativeId]) {
        controls.forEach((control) => {
          control.browserWindow.calls.length = 0;
        });
        sessions.forEach((session) =>
          session.emit('windowFocused', { pid: 42, windowId }),
        );
        await new Promise(queueMicrotask);
        controls.forEach((control) => {
          assert.deepEqual(
            control.browserWindow.calls,
            [],
            `focus ${windowId} must not hide/show, resize, invalidate or steal focus`,
          );
          assert.equal(control.visible, true);
        });
      }
      records.forEach((events) =>
        assert.deepEqual(
          events,
          [0, 900, controls[0].nativeId].map((windowId) => [
            'game.window.focused',
            { pid: 42, focusWindowId: windowId },
          ]),
        ),
      );
    });
  });
  test(`${mode}: opening a test window and disposing before queued focus cannot mutate controls`, async () => {
    await withApps(flags, async (apps, sessions) => {
      const controls = apps.map((app) => {
        app.syncDemoControlOverlay();
        return app.overlayWindows.get('demo-control-overlay');
      });
      controls.forEach((control) => {
        control.browserWindow.calls.length = 0;
      });
      apps.forEach((app) =>
        app.setExampleOverlayWindowVisible('example-main-overlay', true),
      );
      await new Promise(queueMicrotask);
      controls.forEach((control) =>
        assert.deepEqual(control.browserWindow.calls, []),
      );
      const lateCallbacks = sessions.map(
        (session) => session.listeners('windowFocused')[0],
      );
      sessions.forEach((session) =>
        session.emit('windowFocused', { pid: 42, windowId: 901 }),
      );
      apps.forEach((app) => app.dispose());
      await new Promise(queueMicrotask);
      // Already delivered SDK callbacks can outlive listener removal.
      lateCallbacks.forEach((callback) => callback({ pid: 42, windowId: 902 }));
      sessions.forEach((session) =>
        session.emit('windowFocused', { pid: 42, windowId: 902 }),
      );
      await new Promise(queueMicrotask);
      controls.forEach((control) =>
        assert.deepEqual(control.browserWindow.calls, []),
      );
    });
  });
  test(`${mode}: input toggling retains expanded and compact control sizes`, async () => {
    await withApps(flags, async (apps, sessions) => {
      apps.forEach((app) => {
        app.syncDemoControlOverlay();
        app.setInputIntercept(true);
        const control = app.overlayWindows.get('demo-control-overlay');
        assert.equal(control.browserWindow.bounds.width, 390);
        assert.equal(control.browserWindow.bounds.height, 390);
        assert.equal(control.options.captionHeight, 54);
        app.setInputIntercept(false);
        assert.equal(control.browserWindow.bounds.width, 320);
        assert.equal(control.browserWindow.bounds.height, 170);
      });
      sessions.forEach((session) =>
        assert.deepEqual(session.inputCalls, [true, false]),
      );
    });
  });
}
