'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
// Negative control changes only the actual compiled translator in this child.
if (process.env.EGO_ACCEPTANCE_DROP_CHAR === '1') {
  const Module = require('node:module');
  const original = Module._extensions['.js'];
  Module._extensions['.js'] = function(mod, filename) {
    if (!filename.endsWith('input-translation.js')) return original(mod, filename);
    const source = require('node:fs').readFileSync(filename, 'utf8');
    require('node:assert/strict').equal(source.split("type: 'char',").length - 1, 2, 'negative control translator anchors');
    mod._compile(source.replaceAll("type: 'char',", "type: 'keyUp',"), filename);
  };
  process.once('exit', () => { Module._extensions['.js'] = original; });
}
const { OverlayBrokerClient } = require('../../dist/lib/overlay-broker-client.js');
const { createOverlaySession } = require('../../dist/lib/overlay-session.js');

app.setPath('userData', path.join(process.env.EGO_ACCEPTANCE_PROFILE, 'userData'));
app.setPath('sessionData', path.join(process.env.EGO_ACCEPTANCE_PROFILE, 'sessionData'));
app.disableHardwareAcceleration();
let session;
let client;
const windows = [];
const send = (message) => process.send?.(message);
const snapshot = async () => Promise.all(windows.map(async (window) => ({
  id: window.nativeId,
  bounds: window.getBounds(),
  offscreen: window.browserWindow.webContents.isOffscreen(),
  dom: await window.browserWindow.webContents.executeJavaScript(`({value: document.querySelector('input').value, active: document.activeElement.id, events: window.inputEvents})`),
})));
process.on('message', async ({ requestId, command }) => {
  try {
    if (command === 'snapshot') send({ requestId, result: await snapshot() });
    if (command === 'move') {
      for (const [index, window] of windows.entries()) {
        window.browserWindow.setPosition(90 + index * 300, 130 + index * 70);
      }
      send({ requestId, result: await snapshot() });
    }
    if (command === 'hide-reopen') {
      for (const window of windows) { window.hide(); window.show(); }
      send({ requestId, result: await snapshot() });
    }
    if (command === 'authorize') send({ requestId, result: await client.authorizeTarget(43210, path.join(process.env.EGO_ACCEPTANCE_PROFILE, 'electron-overlay-transport-v1.json'), 'C:\\Games\\Shared Game\\game.exe') });
    if (command === 'quit') {
      session?.close();
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      send({ requestId, result: 'closed' });
      app.quit();
    }
  } catch (error) { send({ requestId, error: error.stack }); }
});
app.whenReady().then(async () => {
  client = new OverlayBrokerClient({ pipePath: process.env.EGO_ACCEPTANCE_PIPE, spawnBroker: () => { throw new Error('Unexpected broker bootstrap'); } });
  // The internal construction seam selects an isolated real broker backend;
  // all lifecycle, window creation, event dispatch and input translation are SDK code.
  session = createOverlaySession(client);
  session.start();
  await client.whenReady();
  for (let index = 0; index < 2; index++) {
    const window = session.windows.create({ id: `fixture-${index}`, name: `${process.env.EGO_ACCEPTANCE_NAME}-${index}`, bounds: { x: 40 + index * 380, y: 50, width: 360, height: 180 }, browserWindow: { frame: false, webPreferences: { backgroundThrottling: false } } });
    windows.push(window);
    const html = `<!doctype html><html><body style="margin:0"><label for="hudhook-client-input-target">Controlled acceptance input</label><input id="hudhook-client-input-target" style="position:absolute;left:20px;top:50px;width:280px;height:40px"><script>window.inputEvents=[];for(const type of ['focus','mousedown','mouseup','keydown','input','keyup'])document.querySelector('input').addEventListener(type,e=>window.inputEvents.push({type:e.type,key:e.key,value:e.target.value}));</script></body></html>`;
    await window.browserWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    window.show();
  }
  send({ type: 'ready', pid: process.pid, electron: process.versions.electron, profile: app.getPath('userData'), windows: await snapshot() });
}).catch(error => { send({ type: 'fatal', error: error.stack }); app.exit(1); });
app.on('window-all-closed', () => {});
