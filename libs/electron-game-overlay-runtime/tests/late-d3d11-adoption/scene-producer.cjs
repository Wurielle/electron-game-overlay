'use strict';

// Public-SDK scene only. The controller owns the target and its manual-runtime
// bootstrap; this producer never attaches, injects, launches, or kills it.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app } = require('electron');

const requiredArguments = new Set(['sdk-dist', 'stage-directory', 'evidence-directory']);
const supportedArguments = new Set([...requiredArguments, 'target-pid']);
const arguments_ = {};
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith('--') || !argument.includes('=')) continue;
  const separator = argument.indexOf('=');
  const key = argument.slice(2, separator);
  if (!supportedArguments.has(key)) continue; // Electron also supplies its own switches.
  if (Object.hasOwn(arguments_, key)) throw new TypeError(`Duplicate --${key}.`);
  arguments_[key] = argument.slice(separator + 1);
}
for (const key of requiredArguments) {
  const value = arguments_[key];
  if (!value || !path.isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`--${key}=<absolute existing directory> is required.`);
  }
}
if (arguments_['target-pid'] !== undefined &&
    !/^[1-9][0-9]*$/u.test(arguments_['target-pid'])) {
  throw new TypeError('--target-pid must be a positive integer.');
}
const sdkDirectory = fs.realpathSync(arguments_['sdk-dist']);
const stageDirectory = fs.realpathSync(arguments_['stage-directory']);
const evidenceDirectory = fs.realpathSync(arguments_['evidence-directory']);
for (const directory of [sdkDirectory, stageDirectory, evidenceDirectory]) {
  if (!fs.statSync(directory).isDirectory()) throw new TypeError('Expected existing directories.');
}
const expectedTargetPid = arguments_['target-pid'] === undefined ? undefined : Number(arguments_['target-pid']);
if (expectedTargetPid !== undefined && !Number.isSafeInteger(expectedTargetPid)) {
  throw new TypeError('--target-pid exceeds the safe integer range.');
}

const sdkEntry = path.join(sdkDirectory, 'index.js');
const authorizationEntry = path.join(sdkDirectory, 'lib', 'overlay-session-authorization.js');
const { ElectronGameOverlay } = require(sdkEntry);
const { authorizeOverlaySessionGlobalTarget } = require(authorizationEntry);
const { readNativeImageRaster } = require(path.join(sdkDirectory, 'lib', 'native-image-raster.js'));
const statePath = path.join(evidenceDirectory, 'scene-state.json');
const commandPath = path.join(evidenceDirectory, 'scene-command.json');
const discoveryPath = path.join(stageDirectory, 'electron-overlay-transport-v1.json');
const pause = new Int32Array(new SharedArrayBuffer(4));

app.setPath('userData', path.join(evidenceDirectory, 'scene-profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

let overlay;
let session;
let window;
let releaseRoute;
let timer;
let done = false;
let reading = false;
let lastCommandSequence = 0;
const state = {
  schemaVersion: 1,
  fixture: 'late-d3d11-private-scene-producer',
  processId: process.pid,
  status: 'starting',
  ready: false,
  injectionPerformed: false,
  renderedOverlayPixelsProven: false,
  sdkEntrySha256: createHash('sha256').update(fs.readFileSync(sdkEntry)).digest('hex'),
  expectedTargetPid: expectedTargetPid ?? null,
  targetPid: null,
  connectionCount: 0,
  authenticationCount: 0,
  transportLostCount: 0,
  targetDisconnectedCount: 0,
  surface: null,
  removedSurfaceCount: 0,
  focusedWindowId: 0,
  intercepting: false,
  requestedInterception: false,
  explicitFocusCount: 0,
  commandSequence: 0,
  fpsCount: 0,
  events: [],
  window: {
    nativeId: 0,
    bounds: { x: 40, y: 60, width: 300, height: 220 },
    color: '#c62828',
    cleanColorSampleClient: { x: 60, y: 80 },
    inputClientBounds: { x: 60, y: 110, width: 180, height: 30 },
    paintCount: 0,
    lastPaintBitmapSize: null,
    value: '',
    pointerDowns: 0,
    pointerUps: 0,
    keyDowns: 0,
    keyUps: 0,
    inputEvents: 0,
    heldKeys: [],
  },
};

function persist() {
  const temporary = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, statePath); return; }
    catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 39) throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

function event(value) {
  state.events.push({ ...value, at: Date.now() });
  if (state.events.length > 512) state.events.shift();
}

function cleanup() {
  if (done) return;
  done = true;
  clearInterval(timer);
  try { releaseRoute?.(); } catch {}
  try { overlay?.dispose(); } catch {}
}

function fail(error) {
  if (done) return;
  state.status = 'failed';
  state.error = error instanceof Error ? error.stack || error.message : String(error);
  try { persist(); } catch {}
  cleanup();
  app.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.on('before-quit', cleanup);

async function snapshot() {
  Object.assign(state.window, await window.browserWindow.webContents.executeJavaScript(
    "({...window.observed,value:document.querySelector('input').value,dpr:devicePixelRatio,domInputFocused:document.activeElement===document.querySelector('input')})",
  ));
  persist();
}

async function command(value) {
  switch (value.action) {
    case 'focus':
      if (state.targetPid === null) throw new Error('Cannot focus before an authenticated target connects.');
      await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').focus()");
      window.focus();
      state.explicitFocusCount++;
      break;
    case 'intercept':
      state.requestedInterception = true;
      session.input.intercept();
      break;
    case 'release':
      state.requestedInterception = false;
      session.input.release();
      break;
    case 'clear':
      await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').value=''");
      break;
    case 'exit':
      state.commandSequence = value.sequence;
      state.status = 'stopped';
      persist();
      cleanup();
      app.exit(0);
      return;
    default:
      throw new Error(`Unsupported scene command ${String(value.action)}.`);
  }
  state.commandSequence = value.sequence;
}

app.whenReady().then(async () => {
  overlay = new ElectronGameOverlay();
  session = overlay.createSession();
  session.on('diagnostic', value => {
    event({ type: 'diagnostic', code: value.code, severity: value.severity, context: value.context, pid: value.pid });
    if (value.code === 'target-authenticated') state.authenticationCount++;
    if (value.severity === 'error' || [
      'runtime-input-router-reset', 'runtime-input-routing-failed',
      'runtime-scene-query-failed', 'runtime-frame-upload-failed',
      'producer-frame-publication-failed',
    ].includes(value.code)) {
      fail(new Error(`Native/transport fault invalidated late-adoption acceptance: ${value.code}`));
    }
  });
  session.on('targetConnected', value => {
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        (expectedTargetPid !== undefined && value.pid !== expectedTargetPid) ||
        (state.targetPid !== null && value.pid !== state.targetPid)) {
      fail(new Error('The private route connected an unexpected target.'));
      return;
    }
    state.connectionCount++;
    state.targetPid = value.pid;
    state.authenticatedTarget = value;
    event({ type: 'targetConnected', ...value });
  });
  session.on('targetTransportLost', value => {
    state.transportLostCount++;
    event({ type: 'targetTransportLost', ...value });
  });
  session.on('targetDisconnected', value => {
    state.targetDisconnectedCount++;
    event({ type: 'targetDisconnected', ...value });
  });
  session.on('targetInputCapabilitiesRejected', value => {
    event({ type: 'targetInputCapabilitiesRejected', ...value });
    fail(new Error('The target rejected required SDK input capabilities.'));
  });
  session.on('targetSurfaceChanged', value => {
    state.surface = value;
    event({ type: 'surface', surfaceId: value.surfaceId, hwnd: value.hwnd });
  });
  session.on('targetSurfaceRemoved', value => {
    state.removedSurfaceCount++;
    if (state.surface?.surfaceId === value.surfaceId) state.surface = null;
    event({ type: 'surfaceRemoved', ...value });
  });
  session.on('windowFocused', value => {
    state.focusedWindowId = value.windowId;
    event({ type: 'focus', windowId: value.windowId });
  });
  session.on('inputInterceptionChanged', value => { state.intercepting = value.intercepting; });
  session.on('fps', value => { state.fps = value; state.fpsCount++; });
  session.start();
  releaseRoute = await authorizeOverlaySessionGlobalTarget(session, discoveryPath);
  const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8').replace(/^\uFEFF/u, ''));
  if (discovery.version !== 1 || discovery.pid !== process.pid ||
      !Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535 ||
      !/^[a-f0-9]{64}$/iu.test(discovery.token || '')) {
    throw new Error('The private stage credential does not belong to this producer.');
  }
  state.transport = {
    producerPid: discovery.pid,
    port: discovery.port,
    tokenFingerprint: createHash('sha256').update(discovery.token.toLowerCase()).digest('hex'),
  };
  window = session.windows.create({
    id: 'genuine-late-d3d11-scene', name: 'Genuine late D3D11 private scene',
    bounds: state.window.bounds, focusOnReady: false, captionHeight: 0, dragBorder: 0,
  });
  state.window.nativeId = window.nativeId;
  window.browserWindow.webContents.on('paint', (_event, _dirty, image) => {
    state.window.paintCount++;
    state.window.lastPaintBitmapSize = image.getSize();
    // Inspect the same existing NativeImage representation used by this SDK's
    // publication path. These bytes diagnose the source; they are not target
    // pixel acceptance and never replace the controller's foreground sample.
    const raster = readNativeImageRaster(image);
    if (raster) {
      const x = Math.floor(20 * raster.scaleFactor);
      const y = Math.floor(20 * raster.scaleFactor);
      const offset = (y * raster.width + x) * 4;
      state.window.lastPaintRaster = {
        width: raster.width, height: raster.height, scaleFactor: raster.scaleFactor,
        byteLength: raster.bitmap.byteLength,
        sha256: createHash('sha256').update(raster.bitmap).digest('hex'),
        sample: { x, y, byteOrder: 'BGRA', bytes: [...raster.bitmap.subarray(offset, offset + 4)] },
      };
      if (state.window.paintCount <= 64) {
        const filename = `source-scene-paint-${state.window.paintCount}.png`;
        fs.writeFileSync(path.join(evidenceDirectory, filename), image.toPNG({ scaleFactor: raster.scaleFactor }));
        state.window.latestPaintPng = filename;
      }
    }
  });
  window.browserWindow.webContents.on('render-process-gone', (_event, details) => {
    fail(new Error(`Scene renderer exited: ${JSON.stringify(details)}`));
  });
  await window.browserWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:300px;height:220px;overflow:hidden;background:#c62828}
input{position:absolute;left:20px;top:50px;box-sizing:border-box;width:180px;height:30px;font:18px sans-serif}
</style></head><body><input autocomplete="off" spellcheck="false"><script>
window.observed={pointerDowns:0,pointerUps:0,keyDowns:0,keyUps:0,inputEvents:0,heldKeys:[]};
const held=new Set();
addEventListener('pointerdown',()=>observed.pointerDowns++);
addEventListener('pointerup',()=>observed.pointerUps++);
addEventListener('keydown',event=>{observed.keyDowns++;held.add(event.code);observed.heldKeys=[...held]});
addEventListener('keyup',event=>{observed.keyUps++;held.delete(event.code);observed.heldKeys=[...held]});
document.querySelector('input').addEventListener('input',()=>observed.inputEvents++);
document.querySelector('input').focus();
</script></body></html>`));
  window.show();
  state.ready = true;
  state.status = 'ready';
  await snapshot();
  console.log('EGO_LATE_D3D11_PRIVATE_SCENE_READY');
  timer = setInterval(async () => {
    if (reading || done) return;
    reading = true;
    try {
      if (fs.existsSync(commandPath)) {
        const value = JSON.parse(fs.readFileSync(commandPath, 'utf8').replace(/^\uFEFF/u, ''));
        if (!Number.isSafeInteger(value.sequence) || value.sequence <= 0) {
          throw new Error('Scene command sequence must be a positive safe integer.');
        }
        if (value.sequence > lastCommandSequence) {
          lastCommandSequence = value.sequence;
          await command(value);
        }
      }
      if (!done) await snapshot();
    } catch (error) { fail(error); }
    finally { reading = false; }
  }, 40);
}).catch(fail);
