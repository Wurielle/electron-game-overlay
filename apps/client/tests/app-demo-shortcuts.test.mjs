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
  const callbacks = new Map();
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
    globalShortcut: {
      register(accelerator, callback) {
        if (callbacks.has(accelerator)) return false;
        callbacks.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        callbacks.delete(accelerator);
      },
    },
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
  return { Application: load(entry).Application, sessions, callbacks };
}

test('actual two-app graph exposes independently registered shortcuts and preserves survivor input', () => {
  const savedArgv = process.argv;
  const savedConfig = global.CONFIG;
  process.argv = [...savedArgv, '--demo-presentation'];
  global.CONFIG = { resolveRendererUrl: (value) => value };
  const { Application, sessions, callbacks } = boundary();
  const apps = [];
  try {
    apps.push(new Application(), new Application());
    apps.forEach((app) => app.registerInputInterceptShortcut());
    const chords = apps.map((app) => app.getDemoState().presentation.shortcut);
    assert.deepEqual(chords, [
      'CommandOrControl+I',
      'CommandOrControl+Shift+I',
    ]);
    assert.deepEqual(
      apps.map((app) => app.getDemoState().inputInterceptAccelerator),
      chords,
    );
    callbacks.get(chords[0])();
    assert.deepEqual(
      apps.map((app) => app.getDemoState().inputInterceptRequested),
      [true, false],
    );
    callbacks.get(chords[1])();
    assert.deepEqual(
      apps.map((app) => app.getDemoState().inputInterceptRequested),
      [true, true],
    );
    apps[0].dispose();
    assert.equal(callbacks.has(chords[0]), false);
    callbacks.get(chords[1])();
    assert.equal(apps[1].getDemoState().inputInterceptRequested, false);
    assert.deepEqual(sessions[1].inputCalls, [true, false]);
  } finally {
    apps.forEach((app) => app.dispose());
    process.argv = savedArgv;
    global.CONFIG = savedConfig;
  }
  assert.equal(callbacks.size, 0);
});

for (const surface of ['desktop', 'control']) {
  test(`${surface} displays only the registered shortcut, including unavailable state`, async () => {
    const { runInNewContext } = await import('node:vm');
    const elements = new Map();
    const makeElement = () => ({
      textContent: '',
      value: '',
      dataset: {},
      classList: {
        toggle() {},
        add() {},
        remove() {},
        contains() {
          return false;
        },
      },
      addEventListener() {},
      setAttribute() {},
      querySelector() {
        return makeElement();
      },
    });
    const document = {
      body: makeElement(),
      createElement: makeElement,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
    };
    const listeners = new Map();
    const ipcRenderer = {
      on(channel, callback) {
        listeners.set(channel, callback);
      },
      invoke() {
        return new Promise(() => {});
      },
    };
    const filename =
      surface === 'desktop'
        ? new URL('../src/renderer/main.ts', import.meta.url)
        : new URL('../public/index/demo-control-overlay.html', import.meta.url);
    const source = readFileSync(filename, 'utf8');
    const script =
      surface === 'desktop'
        ? ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS },
          }).outputText
        : source.match(/<script>([\s\S]*?)<\/script>/)[1];
    runInNewContext(script, {
      document,
      window: { require: () => ({ ipcRenderer }) },
      require: () => ({ ipcRenderer }),
      exports: {},
      localStorage: {
        getItem() {
          return null;
        },
      },
      console,
    });
    for (const accelerator of ['CommandOrControl+Shift+I', null]) {
      listeners.get('overlay:state-changed')(
        {},
        {
          overlayStarted: false,
          inputInterceptRequested: false,
          inputInterceptEffective: false,
          runtime: null,
          inputInterceptAccelerator: accelerator,
          presentation: { shortcut: accelerator, menuExpanded: false },
          steamAutoAttach: null,
          windows: {},
          attachment: { phase: 'idle' },
          diagnostic: null,
        },
      );
      const text =
        surface === 'desktop'
          ? elements.get('intercept').textContent
          : elements.get('demo-shortcut').textContent +
            ' ' +
            elements.get('demo-hint').textContent;
      assert.ok(
        accelerator ? text.includes(accelerator) : /unavailable/i.test(text),
        text,
      );
      assert.equal(text.includes('Ctrl+I'), false, text);
      if (surface === 'control')
        assert.equal(
          elements.get('demo-release-input').textContent,
          accelerator
            ? `Release input to game · ${accelerator}`
            : 'Release input to game',
        );
    }
  });
}
