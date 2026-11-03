'use strict';

// Genuine public-SDK producer for a controller-owned, exact-PID D3D11 host.
// This fixture never creates, closes, or kills a target process.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app } = require('electron');
const { collectSdkEvidence } = require('./cooperative-game-evidence.cjs');
const { publishJsonSnapshot } = require('./cooperative-atomic-state.cjs');
const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--') && value.includes('=')).map(value => {
  const separator = value.indexOf('=');
  return [value.slice(2, separator), value.slice(separator + 1)];
}));
if (!['a', 'b'].includes(args.member) || !args.evidence || !args['sdk-dist'] || !args.target || !/^[1-9][0-9]*$/u.test(args.pid || '')) {
  throw new Error('Expected member a|b, evidence, sdk-dist, target path and exact target pid.');
}
const member = args.member;
const evidenceRoot = path.resolve(args.evidence);
const sdkEvidence = collectSdkEvidence(path.resolve(args['sdk-dist']));
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.writeFileSync(path.join(evidenceRoot, `${member}-sdk.json`), JSON.stringify(sdkEvidence, null, 2));
app.setPath('userData', path.join(evidenceRoot, `profile-${member}`));
app.disableHardwareAcceleration();
const { ElectronGameOverlay, ReShadeOverlayLauncher, parseReShadeLaunchConfig } = require(path.join(sdkEvidence.sdkDist, 'index.js'));
let overlay, session, launcher, window, timer, done = false, reading = false, sequence = 0;
const state = {
  schemaVersion: 1, member, processId: process.pid, targetPid: Number(args.pid), ready: false, injectorReturned: false, attached: false,
  connectionCount: 0, authenticationCount: 0, transportLostCount: 0, targetDisconnectedCount: 0,
  surface: null, removedSurfaceCount: 0, fpsCount: 0, focusedWindowId: 0,
  intercepting: false, requestedInterception: false, explicitFocusCount: 0, events: [], windows: {},
};
function persist() {
  const destination = path.join(evidenceRoot, `${member}-state.json`);
  publishJsonSnapshot(destination, state);
}
function event(value) {
  state.events.push({ ...value, at: Date.now() });
  if (state.events.length > 512) state.events.shift();
}
function cleanup() {
  if (done) return;
  done = true;
  clearInterval(timer);
  try { launcher?.dispose(); } catch {}
  try { overlay?.dispose(); } catch {}
}
function fail(error) {
  if (done) return;
  state.error = error.stack || String(error);
  try { persist(); } catch {}
  cleanup();
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.on('before-quit', cleanup);

async function command(value) {
  switch (value.action) {
    case 'focus':
      await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').focus()");
      state.explicitFocusCount++;
      window.focus();
      break;
    case 'blur': window.blur(); break;
    case 'clear': await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').value=''"); break;
    case 'intercept': state.requestedInterception = true; session.input.intercept(); break;
    case 'release': state.requestedInterception = false; session.input.release(); break;
    case 'exit': state.commandSequence = value.sequence; persist(); cleanup(); app.exit(0); return;
    default: throw new Error(`Unsupported lifecycle command ${value.action}`);
  }
  state.commandSequence = value.sequence;
}
async function snapshot() {
  Object.assign(state.windows.main, await window.browserWindow.webContents.executeJavaScript("({...window.observed,value:document.querySelector('input').value,dpr:devicePixelRatio})"));
  persist();
}

app.whenReady().then(async () => {
  overlay = new ElectronGameOverlay();
  session = overlay.createSession();
  session.on('diagnostic', value => {
    event({ code: value.code, severity: value.severity, context: value.context, pid: value.pid });
    if (value.code === 'target-authenticated') state.authenticationCount++;
    if (value.severity === 'error' || ['runtime-input-router-reset', 'runtime-input-routing-failed', 'runtime-scene-query-failed', 'runtime-frame-upload-failed'].includes(value.code)) {
      fail(new Error(`Native/transport fault invalidated lifecycle acceptance: ${value.code}`));
    }
  });
  session.on('targetConnected', value => { state.connectionCount++; state.authenticatedTarget = value; });
  session.on('targetTransportLost', value => { state.transportLostCount++; event({ type: 'targetTransportLost', ...value }); });
  session.on('targetDisconnected', value => { state.targetDisconnectedCount++; event({ type: 'targetDisconnected', ...value }); });
  session.on('targetSurfaceChanged', value => { state.surface = value; event({ type: 'surface', surfaceId: value.surfaceId, hwnd: value.hwnd }); });
  session.on('targetSurfaceRemoved', value => {
    state.removedSurfaceCount++;
    if (state.surface?.surfaceId === value.surfaceId) state.surface = null;
    event({ type: 'surfaceRemoved', ...value });
  });
  session.on('windowFocused', value => { state.focusedWindowId = value.windowId; event({ type: 'focus', windowId: value.windowId }); });
  session.on('inputInterceptionChanged', value => { state.intercepting = value.intercepting; });
  session.on('fps', value => { state.fps = value; state.fpsCount++; });
  const bounds = { x: member === 'a' ? 40 : 400, y: 80, width: 300, height: 220 };
  const color = member === 'a' ? '#c62828' : '#1565c0';
  window = session.windows.create({ id: 'same-retained-window', name: `surface-lifecycle-${member}`, bounds, focusOnReady: false, captionHeight: 0, dragBorder: 0 });
  state.windows.main = { id: window.nativeId, bounds, color, value: '', downs: 0, ups: 0, keydowns: 0, heldKeys: [] };
  await window.browserWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;width:300px;height:220px;background:${color};color:white;font:18px sans-serif"><div style="padding:8px">Participant ${member.toUpperCase()}</div><input style="position:absolute;left:20px;top:40px;width:180px;height:30px;font:18px sans-serif" autocomplete="off"><script>
window.observed={downs:0,ups:0,keydowns:0,heldKeys:[]};const held=new Set();
addEventListener('pointerdown',()=>observed.downs++);addEventListener('pointerup',()=>observed.ups++);
addEventListener('keydown',e=>{observed.keydowns++;held.add(e.code);observed.heldKeys=[...held]});addEventListener('keyup',e=>{held.delete(e.code);observed.heldKeys=[...held]});
document.querySelector('input').focus();</script></body></html>`));
  window.show();
  state.ready = true;
  persist();
  timer = setInterval(async () => {
    if (reading || done) return;
    reading = true;
    try {
      const filename = path.join(evidenceRoot, `${member}-command.json`);
      if (fs.existsSync(filename)) {
        const value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''));
        if (Number.isSafeInteger(value.sequence) && value.sequence > sequence) { sequence = value.sequence; await command(value); }
      }
      if (!done) await snapshot();
    } catch (error) { fail(error); }
    finally { reading = false; }
  }, 40);
  launcher = new ReShadeOverlayLauncher(parseReShadeLaunchConfig(['--reshade-overlay'], { runsRootDirectory: path.join(evidenceRoot, `runs-${member}`) }));
  launcher.onEvent(value => {
    event({ type: value.type, runDirectory: value.runDirectory });
    if (value.type === 'injector-returned') { state.injectorReturned = true; persist(); }
  });
  const result = await launcher.attach(session, { processName: path.basename(args.target), executablePath: path.resolve(args.target), pid: Number(args.pid) });
  if (done) return;
  const discovery = JSON.parse(fs.readFileSync(path.join(result.runDirectory, 'electron-overlay-transport-v1.json'), 'utf8').replace(/^\uFEFF/u, ''));
  if (discovery.version !== 1 || discovery.pid !== process.pid || discovery.targetPid !== Number(args.pid) || !Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535 || !/^[a-f0-9]{64}$/iu.test(discovery.token || '')) throw new Error('Private transport route did not match this producer and exact target.');
  state.attachment = result;
  state.transport = { producerPid: discovery.pid, targetPid: discovery.targetPid, port: discovery.port, tokenFingerprint: createHash('sha256').update(discovery.token.toLowerCase()).digest('hex') };
  state.attached = true;
  await snapshot();
}).catch(fail);
