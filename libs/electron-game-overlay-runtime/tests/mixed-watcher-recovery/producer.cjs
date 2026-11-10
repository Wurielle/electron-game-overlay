'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const configuration = JSON.parse(fs.readFileSync(process.argv.find(value => value.startsWith('--configuration=')).slice(16)));
app.setPath('userData', configuration.userData);
app.disableHardwareAcceleration();
const { ElectronGameOverlay, OverlayTargetWatcher, createReShadeLaunchConfig, createOverlayProcessPolicy } = require(path.join(configuration.sdkDist, 'index.js'));
const statePath = configuration.statePath;
const state = { scope: 'Current workspace SDK JavaScript, exact released generation-23 native payload, owned fixtures only; synthetic SendInput, not physical keyboard evidence.',
  pid: process.pid, ready: false, events: [], diagnostics: [], connected: [], exited: [], failures: [], firstKeys: [],
  watcherSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(configuration.sdkDist, 'lib/overlay-target-watcher.js'))).digest('hex') };
let owner, session, watcher, panel, timer, sequence = 0, busy = false, quitting = false;
function save() {
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(state));
  try { fs.renameSync(statePath + '.tmp', statePath); }
  catch (error) {
    // A Windows reader may briefly hold the old state path without delete
    // sharing. The next observation tick republishes; SDK work is unaffected.
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
  }
}
function failure(error) { state.fatal = { message: error.message, stack: error.stack }; save(); console.error(error); app.exit(1); }
function dispose() { watcher?.dispose(); session?.close(); owner?.dispose(); }
app.on('before-quit', dispose);
state.phase = 'entry-loaded'; save(); console.log('EGO_MIXED_PRODUCER_ENTRY_LOADED');
app.whenReady().then(async () => {
  state.phase = 'electron-ready'; save();
  owner = new ElectronGameOverlay(); session = owner.createSession(); session.start();
  panel = session.windows.create({ id: 'mixed-recovery-input', bounds: { x: 40, y: 50, width: 440, height: 170 },
    browserWindow: { webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } });
  await panel.browserWindow.loadURL('data:text/html,' + encodeURIComponent('<body style="background:#183044;color:white"><h2>Owned SDK recovery fixture</h2><input id="text" autofocus style="font:24px sans-serif"><script>window.keys=[];document.querySelector("input").addEventListener("keydown",e=>window.keys.push(e.key));</script>'));
  state.phase = 'dom-ready'; save();
  session.on('inputInterceptionChanged', value => {
    state.intercepting = value.intercepting;
    if (value.intercepting) state.interceptAcknowledgedAt = Date.now();
    save();
  });
  session.on('diagnostic', value => {
    if (value.severity === 'error' || value.code === 'runtime-scene-rendering-started') {
      state.diagnostics.push({ code: value.code, pid: value.pid, severity: value.severity, context: value.context }); save();
    }
  });
  const config = createReShadeLaunchConfig({ bundledRuntimeDirectory: configuration.runtimeDirectory, runsRootDirectory: configuration.runsRoot });
  state.nativeGeneration = config.runtimeProvider.runtimeGeneration;
  watcher = new OverlayTargetWatcher(session, { config,
    earlyPolicy: createOverlayProcessPolicy({ allow: [configuration.targetDirectory.replace(/\\/g, '/') + '/**'], deny: ['**/denied.exe'] }),
    onEvent(event) {
      state.events.push({ type: event.type, target: event.target, selector: event.selector, code: event.error?.code, stage: event.error?.stage, retrySafety: event.error?.retrySafety, message: event.error?.message });
      if (event.type === 'connected') {
        state.connected.push(event.target); state.activePid = event.target.pid; state.inputReady = false;
        void (async () => {
          await panel.browserWindow.webContents.executeJavaScript('document.querySelector("input").value="";window.keys=[];document.querySelector("input").focus()');
          panel.show(); panel.focus(); session.input.intercept();
          state.inputReady = true; save();
        })().catch(failure);
      }
      if (event.type === 'exited') { state.exited.push(event.identity); session.input.release(); state.inputReady = false; }
      if (event.type === 'error') {
        const scoped = Boolean(event.target || event.selector);
        state.failures.push({ scoped, target: event.target, selector: event.selector, code: event.error.code, stage: event.error.stage, retrySafety: event.error.retrySafety });
        // Match the consumer's stop boundary; a scoped target failure survives.
        if (!scoped) { state.globalStop = true; dispose(); }
      }
      save();
    },
  });
  await watcher.ready; state.ready = true; save();
  timer = setInterval(async () => {
    if (busy || quitting) return; busy = true;
    try {
      const commandPath = configuration.commandPath;
      if (fs.existsSync(commandPath)) {
        const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
        if (command.sequence > sequence) {
          sequence = command.sequence;
          if (command.kind === 'quit') {
            quitting = true; clearInterval(timer); dispose(); state.stopped = true; save();
            setTimeout(() => app.quit(), 250); return;
          }
        }
      }
      state.dom = await panel.browserWindow.webContents.executeJavaScript('({value:document.querySelector("input").value,keys:window.keys,focused:document.activeElement===document.querySelector("input")})');
      state.targets = watcher.targets; save();
    } catch (error) { failure(error); }
    finally { busy = false; }
  }, 30);
}).catch(failure);
