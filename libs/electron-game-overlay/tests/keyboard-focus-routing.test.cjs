const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const { createOverlaySession } = require('../dist/lib/overlay-session.js');
const { createWindowScaleState } = require('../dist/lib/window-scale-state.js');

// Reuse the existing broker fixture, not a second implementation of routing.
const fixturePath = path.join(__dirname, 'overlay-broker.test.cjs');
const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const prefix = fixtureSource.slice(0, fixtureSource.indexOf('const connectRawClient ='));
const fixtureModule = { exports: {} };
vm.runInNewContext(prefix + '\nmodule.exports = { startFixture, overlayWindow, waitFor, TARGET_PID, TARGET_EXE };', {
  require: createRequire(fixturePath), module: fixtureModule, Buffer, structuredClone,
  setTimeout, clearTimeout, console, process,
}, { filename: fixturePath });
const { startFixture, overlayWindow, waitFor, TARGET_PID, TARGET_EXE } = fixtureModule.exports;

test('explicit focus translates colliding app IDs, retains first-show intent and isolates blur/removal', async () => {
  const fixture = await startFixture();
  try {
    const clients = [await fixture.makeClient('0.1.0-rc.1'), await fixture.makeClient('0.1.0-rc.2')];
    for (const [i, client] of clients.entries()) {
      client.addWindow(7, overlayWindow(`app-${i}`));
      client.setWindowFocus(7, true);
      client.setInputIntercept(true);
    }
    await clients[0].authorizeTarget(TARGET_PID, path.join(require('node:os').tmpdir(), 'focus-a', 'electron-overlay-transport-v1.json'), TARGET_EXE);
    const joined = clients[1].authorizeTarget(TARGET_PID, path.join(require('node:os').tmpdir(), 'focus-b', 'electron-overlay-transport-v1.json'), TARGET_EXE);
    const transport = fixture.transports[0];
    const focus = [];
    transport.setWindowFocus = (id, focused) => focus.push({ id, focused });
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await joined;
    await waitFor(() => transport.windows.size === 2 && focus.length >= 2);
    assert.deepEqual(focus.slice(-2), [{ id: 1, focused: true }, { id: 2, focused: true }]);
    const beforeToggle = focus.length;
    clients[0].setInputIntercept(false);
    clients[0].setInputIntercept(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(focus.length, beforeToggle, 'another member toggling interception must not steal the selected focus');
    clients[0].blur = () => clients[0].setWindowFocus(7, false);
    clients[0].blur();
    await waitFor(() => focus.at(-1)?.focused === false);
    assert.deepEqual(focus.at(-1), { id: 1, focused: false }, 'blur must carry app A global ID, never the shared local 7');
    clients[1].closeWindow(7);
    await waitFor(() => transport.windows.size === 1);
    clients[1].addWindow(7, overlayWindow('reopened'));
    clients[1].setWindowFocus(7, true);
    await waitFor(() => focus.at(-1)?.focused === true && focus.at(-1)?.id > 2);
    assert.notEqual(focus.at(-1).id, 1);
    const before = focus.length;
    clients[0].setWindowFocus(999, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(focus.length, before, 'unowned local IDs cannot address another member');
    assert.equal(transport.authorizations.length, 1, 'focus never injects');
  } finally { await fixture.close(); }
});

test('two app namespaces dispatch typed characters only to the selected local offscreen window', async () => {
  const fixture = await startFixture();
  try {
    const clients = [await fixture.makeClient('0.0.1'), await fixture.makeClient('0.0.1')];
    const sent = [[], []];
    const focus = [[], []];
    const sessions = clients.map((client, index) => {
      const session = createOverlaySession(client);
      // StartFixture already starts the backend; bind the actual session handler
      // without subscribing to the unavailable host Electron screen service.
      client.setEventCallback((event, payload) => session.handleEvent(event, payload));
      const browserWindow = {
        isDestroyed: () => false,
        focusOnWebView: () => focus[index].push('focus'),
        blurWebView: () => focus[index].push('blur'),
        webContents: { isDestroyed: () => false, sendInputEvent: (event) => sent[index].push(event) },
      };
      session.windowsByNativeId.set(7, { nativeId: 7, visible: true, browserWindow });
      session.windowScaleStates.set(7, createWindowScaleState(
        { id: 1, scaleFactor: 1, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 640, height: 360 },
      ));
      client.addWindow(7, overlayWindow(`app-${index}`));
      return session;
    });
    await clients[0].authorizeTarget(TARGET_PID, path.join(require('node:os').tmpdir(), 'keyboard-app-a', 'electron-overlay-transport-v1.json'), TARGET_EXE);
    const joined = clients[1].authorizeTarget(TARGET_PID, path.join(require('node:os').tmpdir(), 'keyboard-app-b', 'electron-overlay-transport-v1.json'), TARGET_EXE);
    const transport = fixture.transports[0];
    transport.emit('game.process', { pid: TARGET_PID, path: TARGET_EXE });
    await joined;
    await waitFor(() => transport.windows.size === 2);
    for (const [index, character] of ['a', 'b'].entries()) {
      transport.emit('game.window.focused', { pid: TARGET_PID, focusWindowId: index + 1 });
      for (const [msg, wparam] of [[0x201, 1], [0x202, 0], [0x100, character.toUpperCase().charCodeAt(0)], [0x102, character.charCodeAt(0)], [0x101, character.toUpperCase().charCodeAt(0)]]) {
        transport.emit('game.input', { pid: TARGET_PID, windowId: index + 1, msg, wparam, lparam: 1, scaleFactorMicros: 1000000 });
      }
      await waitFor(() => sent[index].some(event => event.type === 'keyUp'));
      assert.deepEqual(sent[index].map(event => event.type), ['mouseDown', 'mouseUp', 'keyDown', 'char', 'keyUp']);
      assert.equal(sent[index][3].keyCode, character);
      assert.equal(focus[index].at(-1), 'focus');
    }
    assert.equal(sent[0].length, 5);
    assert.equal(sent[1].length, 5);
    assert.equal(sessions.length, 2);
  } finally {
    await fixture.close();
  }
});
