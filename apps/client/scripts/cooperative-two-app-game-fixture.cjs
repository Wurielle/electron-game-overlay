'use strict';

// Genuine Electron/public-SDK producer. The PowerShell controller owns the game;
// this process never starts, terminates or receives a process handle to it.
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
if (!['a', 'b'].includes(args.member) || !['first', 'late'].includes(args.slot) || !args.evidence || !args['sdk-dist'] || !args.game) {
  throw new Error('Expected member a|b, slot first|late, evidence, sdk-dist and exact game path.');
}
const evidenceRoot = path.resolve(args.evidence);
const member = args.member;
fs.mkdirSync(evidenceRoot, { recursive: true });
app.setPath('userData', path.join(evidenceRoot, `profile-${member}`));
app.disableHardwareAcceleration();
const sdkEvidence = collectSdkEvidence(path.resolve(args['sdk-dist']));
fs.writeFileSync(path.join(evidenceRoot, `${member}-sdk.json`), JSON.stringify(sdkEvidence, null, 2));
const { ElectronGameOverlay, ReShadeOverlayLauncher, parseReShadeLaunchConfig } = require(path.join(sdkEvidence.sdkDist, 'index.js'));
let overlay, session, launcher, timer, done = false, reading = false, attempt = 0, commandSequence = 0;
const windows = new Map();
const state = {
  schemaVersion: 1, member, slot: args.slot, processId: process.pid,
  electron: process.versions.electron,
  sdk: { sdkDist: sdkEvidence.sdkDist, packageVersion: sdkEvidence.packageVersion, javascriptGraphSha256: sdkEvidence.javascriptGraphSha256, addon: sdkEvidence.addon },
  ready: false, watcherReady: false, attached: false, rendering: false,
  requestedInterception: false, intercepting: false, events: [], windows: {},
};
function persist() {
  const destination = path.join(evidenceRoot, `${member}-state.json`);
  publishJsonSnapshot(destination, state);
}
function event(value) {
  state.events.push({ ...value, at: Date.now() });
  if (state.events.length > 256) state.events.shift();
}
function cleanup() {
  if (done) return;
  done = true;
  clearInterval(timer);
  attempt++;
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
app.on('before-quit', cleanup);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

function documentHtml(name, color, width, height) {
  // Native alpha hit testing must pass the rectangular cutout to another app.
  return `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent;font:16px sans-serif;color:white">
<svg style="position:absolute;inset:0;pointer-events:none" width="${width}" height="${height}"><path fill="${color}" fill-rule="evenodd" d="M0 0H${width}V${height}H0Z M180 160H240V220H180Z"/></svg>
<div style="position:absolute;left:8px;top:5px;pointer-events:none">${member.toUpperCase()} ${name}</div>
<input id="text" style="position:absolute;left:20px;top:40px;width:160px;height:28px;font:18px sans-serif" autocomplete="off">
<a id="hand" href="#" style="position:absolute;left:20px;top:90px;cursor:pointer;color:white">Hand</a>
<span style="position:absolute;left:130px;top:90px;cursor:ew-resize">Resize</span>
<div id="scroll" style="position:absolute;left:20px;top:130px;width:140px;height:100px;overflow:auto;overscroll-behavior:contain;background:#eeeeee;color:#111"><div style="width:600px;height:600px;background:linear-gradient(#eee,#888)">Scroll</div></div>
<script>
window.observed={value:'',downs:0,ups:0,moves:0,heldKeys:[],pointerIds:[],wheel:[],cursor:'',lastUp:null};
const held=new Set();
addEventListener('pointerdown',e=>{observed.downs++;observed.pointerIds.push(e.pointerId)});
addEventListener('pointerup',e=>{observed.ups++;observed.lastUp={x:e.clientX,y:e.clientY}});
addEventListener('pointermove',()=>observed.moves++);
addEventListener('keydown',e=>{held.add(e.code);observed.heldKeys=[...held]});
addEventListener('keyup',e=>{held.delete(e.code);observed.heldKeys=[...held]});
addEventListener('wheel',e=>observed.wheel.push({x:e.clientX,y:e.clientY,dx:e.deltaX,dy:e.deltaY}));
document.querySelector('input').focus();
</script></body></html>`;
}
async function createWindow(name) {
  if (windows.has(name)) return windows.get(name);
  const extra = name === 'extra';
  const bounds = extra ? { x: 260, y: 240, width: 260, height: 220 } : args.slot === 'first'
    ? { x: 40, y: 80, width: 320, height: 300 }
    : { x: 180, y: 160, width: 320, height: 300 };
  const color = extra ? '#2e7d32' : args.slot === 'first' ? '#c62828' : '#1565c0';
  const window = session.windows.create({
    id: name, name: `cooperative-${member}-${name}`, bounds, transparent: true, captionHeight: 24, dragBorder: 0,
    browserWindow: { transparent: true, backgroundColor: '#00000000', frame: false },
  });
  windows.set(name, window);
  state.windows[name] = { id: window.nativeId, bounds, color, visible: false, cursor: '' };
  window.browserWindow.webContents.on('paint', (_event, _dirty, image) => {
    if (done || !state.windows[name]) return;
    const size = image.getSize();
    const bitmap = image.getBitmap();
    if (size.width === bounds.width && size.height === bounds.height && bitmap.length === size.width * size.height * 4) {
      state.windows[name].alphaProbe = { width: size.width, height: size.height, bitmapBytes: bitmap.length, hole: bitmap[(190 * size.width + 210) * 4 + 3], opaque: bitmap[(50 * size.width + 15) * 4 + 3] };
    }
  });
  await window.browserWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(documentHtml(name, color, bounds.width, bounds.height)));
  window.browserWindow.webContents.on('cursor-changed', (_event, cursor) => { if (state.windows[name]) state.windows[name].cursor = cursor; });
  window.show();
  return window;
}
function attach(pid) {
  const generation = ++attempt;
  try { launcher?.dispose(); } catch {}
  state.attached = false;
  state.rendering = false;
  state.watcherReady = false;
  state.attachmentAttempt = generation;
  const config = parseReShadeLaunchConfig(['--reshade-overlay'], { runsRootDirectory: path.join(evidenceRoot, `runs-${member}`, String(generation)) });
  launcher = new ReShadeOverlayLauncher(config);
  launcher.onEvent(value => {
    if (generation !== attempt) return;
    event({ type: value.type, ...(value.runDirectory ? { runDirectory: value.runDirectory } : {}) });
    if (value.type === 'injector-watcher-ready') state.watcherReady = true;
  });
  void launcher.attach(session, {
    processName: path.basename(args.game), executablePath: path.resolve(args.game),
    ...(pid ? { pid } : {}),
  }).then(result => {
    if (generation !== attempt || done) return;
    state.attached = true;
    state.targetPid = result.pid;
    state.attachment = result;
    const discovery = JSON.parse(fs.readFileSync(path.join(result.runDirectory, 'electron-overlay-transport-v1.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (discovery.version !== 1 || discovery.pid !== process.pid || !Number.isInteger(discovery.port) || discovery.port <= 0 || discovery.port > 65535 || !/^[0-9a-f]{64}$/i.test(discovery.token || '')) {
      throw new Error('The attached engine did not use this application\'s valid private transport discovery record.');
    }
    state.transport = { version: discovery.version, producerPid: discovery.pid, port: discovery.port, tokenFingerprint: createHash('sha256').update(discovery.token.toLowerCase()).digest('hex'), targetPid: discovery.targetPid || null };
    persist();
  }, error => { if (generation === attempt) fail(error); });
}
async function command(command) {
  const name = command.window || 'main';
  let window = windows.get(name);
  switch (command.action) {
    case 'focus':
      if (!window) throw new Error(`Missing window ${name}`);
      await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').focus()");
      window.focus();
      break;
    case 'clear':
      await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').value=''");
      break;
    case 'hide': window.hide(); break;
    case 'show': window.show(); break;
    case 'create-extra': await createWindow('extra'); break;
    case 'close-extra': window = windows.get('extra'); window?.close(); windows.delete('extra'); delete state.windows.extra; break;
    case 'intercept': state.requestedInterception = true; session.input.intercept(); break;
    case 'release': state.requestedInterception = false; session.input.release(); break;
    case 'arm-next': attach(); break;
    case 'exit': state.commandSequence = command.sequence; persist(); cleanup(); app.exit(0); return;
    default: throw new Error(`Unsupported test command ${command.action}`);
  }
  state.commandSequence = command.sequence;
}
async function snapshot() {
  for (const [name, window] of windows) {
    Object.assign(state.windows[name], await window.browserWindow.webContents.executeJavaScript("({...window.observed,value:document.querySelector('input').value,scroll:{x:document.querySelector('#scroll').scrollLeft,y:document.querySelector('#scroll').scrollTop},dpr:devicePixelRatio})"));
    state.windows[name].visible = window.visible;
  }
  persist();
}
app.whenReady().then(async () => {
  overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
  session = overlay.createSession();
  session.on('diagnostic', diagnostic => {
    event({ code: diagnostic.code, pid: diagnostic.pid, severity: diagnostic.severity, context: diagnostic.context });
    if (diagnostic.code === 'transport-ready') state.transportPort = diagnostic.context?.port;
    if (diagnostic.severity === 'error' || ['runtime-input-router-reset', 'runtime-input-routing-failed', 'runtime-scene-query-failed', 'runtime-frame-upload-failed'].includes(diagnostic.code)) {
      fail(new Error(`Native/transport diagnostic invalidated acceptance: ${diagnostic.code}`));
      return;
    }
    if (diagnostic.code === 'runtime-scene-rendering-started') state.rendering = true;
  });
  session.on('targetConnected', value => { state.targetPid = value.pid; state.authenticatedTarget = value; });
  session.on('targetDisconnected', value => { event({ type: 'target-disconnected', pid: value.pid }); state.attached = false; });
  session.on('targetSurfaceChanged', surface => { state.surface = surface; });
  session.on('windowFocused', value => { state.focusedWindowId = value.windowId; state.focusRevision = (state.focusRevision || 0) + 1; });
  session.on('inputInterceptionChanged', value => { state.intercepting = value.intercepting; });
  session.on('fps', value => { state.fps = value; state.lastFpsAt = Date.now(); });
  await createWindow('main');
  state.ready = true;
  state.requestedInterception = args.slot === 'first';
  if (state.requestedInterception) session.input.intercept();
  persist();
  timer = setInterval(async () => {
    if (reading || done) return;
    reading = true;
    try {
      const file = path.join(evidenceRoot, `${member}-command.json`);
      if (fs.existsSync(file)) {
        const next = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (Number.isSafeInteger(next.sequence) && next.sequence > commandSequence) {
          commandSequence = next.sequence;
          await command(next);
        }
      }
      if (!done) await snapshot();
    } catch (error) { fail(error); }
    finally { reading = false; }
  }, 50);
  attach(args.pid ? Number(args.pid) : undefined);
}).catch(fail);
