'use strict';

// Genuine public-SDK producer for the resource-soak controller. This process
// never starts or terminates the target and makes no native resource claims.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectSdkEvidence } = require('./cooperative-game-evidence.cjs');
const { publishJsonSnapshot } = require('./cooperative-atomic-state.cjs');

const MAX_CYCLES = 1024;
const MAX_WINDOWS = 32;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_EVENTS = 64;
const WINDOW_NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ACTIONS = new Set(['close-session', 'recreate-session', 'create-window', 'close-window', 'focus', 'clear', 'intercept', 'release', 'exit']);
const fatalDiagnostics = new Set(['runtime-input-router-reset', 'runtime-input-routing-failed', 'runtime-scene-query-failed', 'runtime-frame-upload-failed']);
const hash = value => createHash('sha256').update(value).digest('hex');

function parseOptions(argv) {
  const allowed = new Set(['member', 'slot', 'evidence', 'sdk-dist', 'game', 'pid', 'max-cycles']);
  const options = {};
  for (const argument of argv) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(options, match[1])) throw new Error('Invalid or duplicate resource-soak option.');
    options[match[1]] = match[2];
  }
  if (!WINDOW_NAME.test(options.member || '') || !['survivor', 'churn'].includes(options.slot || 'churn')) throw new Error('Expected a safe member name and slot survivor|churn.');
  if (!/^[1-9][0-9]{0,9}$/u.test(options.pid || '') || Number(options.pid) > 0xffffffff) throw new Error('An exact positive uint32 target PID is required.');
  const maxCycles = options['max-cycles'] === undefined ? MAX_CYCLES : Number(options['max-cycles']);
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > MAX_CYCLES || (options['max-cycles'] !== undefined && !/^[1-9][0-9]*$/u.test(options['max-cycles']))) throw new Error('max-cycles must be between 1 and 1024.');
  for (const field of ['evidence', 'sdk-dist', 'game']) {
    if (!options[field] || !path.isAbsolute(options[field]) || options[field].includes('\0')) throw new Error(`${field} must be an absolute path.`);
  }
  return Object.freeze({ member: options.member, slot: options.slot || 'churn', evidence: path.resolve(options.evidence), sdkDist: path.resolve(options['sdk-dist']), game: path.resolve(options.game), targetPid: Number(options.pid), maxCycles });
}

function parseCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !ACTIONS.has(value.action)) throw new Error('Malformed resource-soak command.');
  if (Object.keys(value).some(key => !['sequence', 'action', 'window'].includes(key))) throw new Error('Unknown resource-soak command field.');
  const window = value.window === undefined ? 'main' : value.window;
  if (typeof window !== 'string' || !WINDOW_NAME.test(window)) throw new Error('Invalid resource-soak window name.');
  return { sequence: value.sequence, action: value.action, window };
}

function readBoundedJson(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_JSON_BYTES) throw new Error('Resource-soak JSON input is out of bounds.');
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== info.size || bytes.length > MAX_JSON_BYTES) throw new Error('Resource-soak JSON input changed while reading.');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

function collectPrivateRoute(result, options, sdkEvidence, cycleRoot) {
  if (result.pid !== options.targetPid || result.injectorTargetPid !== options.targetPid || typeof result.runDirectory !== 'string' || !path.isAbsolute(result.runDirectory)) throw new Error('Attachment did not retain the exact requested target PID.');
  const runDirectory = fs.realpathSync(result.runDirectory);
  const root = fs.realpathSync(cycleRoot);
  const relative = path.relative(root, runDirectory);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Attachment escaped its fresh cycle stage.');
  const discovery = readBoundedJson(path.join(runDirectory, 'electron-overlay-transport-v1.json'));
  if (discovery.version !== 1 || discovery.pid !== process.pid || discovery.targetPid !== options.targetPid || !Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535 || !/^[a-f0-9]{64}$/iu.test(discovery.token || '')) throw new Error('Attachment did not use this producer\'s exact private target route.');
  const addonPath = fs.realpathSync(result.addonModulePath || path.join(runDirectory, 'electron_game_overlay.addon64'));
  const addonRelative = path.relative(runDirectory, addonPath);
  if (!addonRelative || addonRelative.startsWith(`..${path.sep}`) || addonRelative === '..' || path.isAbsolute(addonRelative)) throw new Error('Attachment did not retain its own staged add-on path.');
  const addonInfo = fs.lstatSync(addonPath);
  if (!addonInfo.isFile() || addonInfo.size !== sdkEvidence.addon.bytes || addonInfo.size > 128 * 1024 * 1024) throw new Error('The staged add-on has an unexpected size.');
  const addonHash = hash(fs.readFileSync(addonPath));
  if (addonHash !== sdkEvidence.addon.sha256) throw new Error('The staged add-on changed from the supplied SDK bytes.');
  return {
    runDirectory,
    transport: { version: 1, producerPid: discovery.pid, targetPid: discovery.targetPid, port: discovery.port, tokenFingerprint: hash(discovery.token.toLowerCase()) },
    native: { path: addonPath, sha256: addonHash, bytes: addonInfo.size, abi: sdkEvidence.addon.abi, buildId: sdkEvidence.addon.buildId, scope: 'Verified staged file; the controller must independently verify the target module snapshot.' },
  };
}

function collectInjectorBinding(invocation, options) {
  const args = invocation?.arguments;
  if (!Array.isArray(args) || args.length < 5 || args.length > 8 || args.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !path.isAbsolute(args[0]) || path.resolve(args[0]).toLowerCase() !== options.game.toLowerCase() ||
      !path.isAbsolute(invocation.executable || '') || !path.isAbsolute(invocation.workingDirectory || '')) throw new Error('Injector invocation did not bind the exact target image.');
  const flags = new Map();
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (flags.has(key) || !['--pid', '--expected-creation-time-100ns', '--addon-only'].includes(key)) throw new Error('Injector invocation has ambiguous target binding flags.');
    flags.set(key, key === '--addon-only' ? true : args[++index]);
  }
  const pid = flags.get('--pid'), created = flags.get('--expected-creation-time-100ns');
  if (!/^[1-9][0-9]{0,9}$/u.test(pid || '') || Number(pid) !== options.targetPid || !/^[1-9][0-9]{0,19}$/u.test(created || '') || BigInt(created) > 0xffffffffffffffffn) throw new Error('Injector invocation omitted or changed its exact process creation binding.');
  const runDirectory = fs.realpathSync(invocation.workingDirectory), executable = fs.realpathSync(invocation.executable);
  if (path.dirname(executable).toLowerCase() !== runDirectory.toLowerCase() || path.basename(executable).toLowerCase() !== 'inject.exe') throw new Error('Injector invocation escaped its own x64 stage.');
  return { pid: Number(pid), creationTime100ns: created, executablePath: path.resolve(args[0]), runDirectory };
}

function collectInjectorSelection(result, options, binding) {
  if (result.injectorTargetPid !== options.targetPid || !path.isAbsolute(result.targetExecutablePath || '') || path.resolve(result.targetExecutablePath).toLowerCase() !== options.game.toLowerCase()) throw new Error('Injector result changed its exact selected target image or PID.');
  if (typeof result.injectorStdoutPath !== 'string' || !path.isAbsolute(result.injectorStdoutPath)) throw new Error('Injector proof did not identify its owned stdout file.');
  const runDirectory = fs.realpathSync(result.runDirectory);
  const filename = fs.realpathSync(result.injectorStdoutPath);
  const relative = path.relative(runDirectory, filename);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Injector selection proof escaped its own stage.');
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) throw new Error('Injector selection proof size is out of bounds.');
  const text = fs.readFileSync(filename, 'utf8');
  if (Buffer.byteLength(text, 'utf8') !== info.size) throw new Error('Injector selection proof changed while reading.');
  const selections = [...text.matchAll(/^EGO_TARGET_SELECTED_V2\t([1-9][0-9]*)\t([1-9][0-9]{0,19})\t([^\t\r\n]+)\r?$/gmu)];
  const plain = [...text.matchAll(/^EGO_TARGET_SELECTED\t([1-9][0-9]*)\r?$/gmu)];
  const lines = text.split(/\r?\n/u).filter(line => line.startsWith('EGO_TARGET_SELECTED'));
  if (selections.length > 1 || plain.length > 1 || lines.length !== selections.length + plain.length || plain.some(value => Number(value[1]) !== options.targetPid)) throw new Error('Injector stdout did not prove one exact selected target identity.');
  if (binding && (binding.pid !== options.targetPid || binding.executablePath.toLowerCase() !== options.game.toLowerCase() || binding.runDirectory.toLowerCase() !== runDirectory.toLowerCase())) throw new Error('Injector result differs from its retained process binding.');
  if (selections.length === 1) {
    const [, pid, created, image] = selections[0];
    if (Number(pid) !== options.targetPid || BigInt(created) > 0xffffffffffffffffn || !path.isAbsolute(image) || path.resolve(image).toLowerCase() !== options.game.toLowerCase() || (binding && binding.creationTime100ns !== created)) throw new Error('Injector stdout did not prove one exact selected target identity.');
    return { pid: Number(pid), creationTime100ns: created, executablePath: image };
  }
  if (plain.length !== 1 || !binding || !/^[1-9][0-9]{0,19}$/u.test(binding.creationTime100ns || '') || BigInt(binding.creationTime100ns) > 0xffffffffffffffffn) throw new Error('Exact-PID selection requires its native creation-bound injector invocation.');
  return { pid: binding.pid, creationTime100ns: binding.creationTime100ns, executablePath: binding.executablePath, identitySource: 'native-expected-creation-binding' };
}

function createProducer({ app, sdk, sdkEvidence, options, publish = publishJsonSnapshot, collectRoute = collectPrivateRoute, collectSelection = collectInjectorSelection }) {
  let overlay, session, launcher, done = false, failed = false;
  const windows = new Map();
  const state = {
    schemaVersion: 1, scope: 'Genuine Electron/public-SDK fresh-stage lifecycle producer; no socket-reconnect or native resource assertion.',
    member: options.member, slot: options.slot, processId: process.pid, electron: process.versions.electron || null,
    targetPid: options.targetPid, cycle: 0, maxCycles: options.maxCycles, activeSession: false,
    ready: false, attached: false, rendering: false, watcherReady: false, injectorReturned: false, injectorBinding: null, selectedTarget: null, injectorProof: null, requestedInterception: false, intercepting: false,
    focusedWindowId: 0, focusRevision: 0, commandSequence: 0, windowsCreated: 0, windowsClosed: 0, sessionsClosed: 0,
    windows: {}, events: [], transport: null, native: null, runDirectory: null,
    sdk: { sdkDist: sdkEvidence.sdkDist, packageVersion: sdkEvidence.packageVersion, javascriptGraphSha256: sdkEvidence.javascriptGraphSha256, addon: sdkEvidence.addon },
  };
  const filename = path.join(options.evidence, `${options.member}-state.json`);
  const persist = () => publish(filename, state);
  function event(value) {
    const record = { ...value, cycle: state.cycle, at: Date.now() };
    state.events.push(record);
    if (state.events.length > MAX_EVENTS) state.events.shift();
    fs.appendFileSync(path.join(options.evidence, `${options.member}-events.jsonl`), JSON.stringify(record) + '\n');
  }
  function current(owned) { return !done && session === owned; }
  function requireSession() { if (!session) throw new Error('No active resource-soak session.'); return session; }
  function requireWindow(name) { const window = windows.get(name); if (!window) throw new Error(`Missing resource-soak window ${name}.`); return window; }
  function resetLiveState() {
    Object.assign(state, { activeSession: false, attached: false, rendering: false, watcherReady: false, injectorReturned: false, injectorBinding: null, selectedTarget: null, injectorProof: null, requestedInterception: false, intercepting: false, focusedWindowId: 0, transport: null, native: null, runDirectory: null });
    delete state.authenticatedTarget; delete state.surface; delete state.fps; delete state.lastFpsAt;
  }
  function closeSession() {
    const closing = session;
    if (!closing) throw new Error('The resource-soak session is already closed.');
    session = undefined; // Late events/completions from this cycle cannot alter a newer cycle.
    const closingLauncher = launcher; launcher = undefined;
    resetLiveState();
    closingLauncher?.dispose();
    closing.close();
    state.windowsClosed += windows.size;
    windows.clear(); state.windows = {};
    state.sessionsClosed++;
    event({ type: 'session-closed' });
  }
  function cleanup() {
    if (done) return;
    try { if (session) closeSession(); }
    finally { done = true; overlay?.dispose(); }
  }
  function fail(error) {
    if (failed || state.exited) return;
    failed = true;
    state.error = error.stack || String(error);
    try { cleanup(); } catch (cleanupError) { state.cleanupError = cleanupError.stack || String(cleanupError); }
    try { persist(); } finally { app.exit(1); }
  }
  async function createWindow(name) {
    const owned = requireSession();
    if (windows.has(name)) throw new Error(`Resource-soak window ${name} already exists.`);
    if (windows.size >= MAX_WINDOWS) throw new Error('Resource-soak live window bound reached.');
    const bounds = { x: options.slot === 'survivor' ? 30 : 320, y: 80, width: 250, height: 160 };
    const color = options.slot === 'survivor' ? '#2e7d32' : '#1565c0';
    const window = owned.windows.create({ id: name, name: `resource-soak-${options.member}-${name}`, bounds, transparent: true, captionHeight: 24, dragBorder: 0, browserWindow: { transparent: true, backgroundColor: '#00000000', frame: false } });
    windows.set(name, window);
    state.windows[name] = { id: window.nativeId, bounds, color, visible: false, paints: 0 };
    state.windowsCreated++;
    window.browserWindow.webContents.on('paint', (_event, _dirty, image) => {
      if (!current(owned) || windows.get(name) !== window) return;
      const size = image.getSize();
      const bitmap = image.getBitmap();
      state.windows[name].paints++;
      state.windows[name].raster = { width: size.width, height: size.height, bitmapBytes: bitmap.length, opaqueAlpha: bitmap.length >= 4 ? bitmap[3] : null };
    });
    const html = `<!doctype html><html><body style="margin:0;background:${color};color:white;font:16px sans-serif"><div style="height:24px">${options.member} ${name}</div><input id="text" maxlength="128" style="margin:12px;width:180px;font:18px sans-serif" autocomplete="off"><script>
window.observed={downs:0,ups:0,keyDowns:0,keyUps:0,heldKeys:[],lastPointerId:null,wheelX:0,wheelY:0};const held=new Set();
addEventListener('pointerdown',e=>{observed.downs++;observed.lastPointerId=e.pointerId});addEventListener('pointerup',()=>observed.ups++);
addEventListener('keydown',e=>{observed.keyDowns++;held.add(e.code);observed.heldKeys=[...held]});addEventListener('keyup',e=>{observed.keyUps++;held.delete(e.code);observed.heldKeys=[...held]});
addEventListener('wheel',e=>{observed.wheelX+=e.deltaX;observed.wheelY+=e.deltaY});document.querySelector('input').focus();</script></body></html>`;
    await window.browserWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    if (!current(owned)) return;
    window.show(); state.windows[name].visible = true;
  }
  async function openSession() {
    if (session) throw new Error('Close the resource-soak session before recreating it.');
    if (state.cycle >= options.maxCycles) throw new Error('Resource-soak session cycle bound reached.');
    state.cycle++;
    resetLiveState();
    const owned = overlay.createSession(); session = owned; state.activeSession = true;
    const observe = (name, callback) => owned.on(name, value => { if (current(owned)) callback(value); });
    observe('diagnostic', diagnostic => {
      event({ type: 'diagnostic', code: diagnostic.code, severity: diagnostic.severity, pid: diagnostic.pid });
      if (diagnostic.severity === 'error' || fatalDiagnostics.has(diagnostic.code)) return fail(new Error(`Resource-soak diagnostic invalidated acceptance: ${diagnostic.code}`));
      if (diagnostic.code === 'runtime-scene-rendering-started') state.rendering = true;
    });
    observe('targetConnected', value => {
      if (value.pid !== options.targetPid) return fail(new Error('An unexpected target authenticated to the resource-soak producer.'));
      state.authenticatedTarget = value;
    });
    const clearTargetSnapshot = () => {
      state.attached = false; state.rendering = false; state.intercepting = false; state.focusedWindowId = 0;
      delete state.surface; delete state.fps; delete state.lastFpsAt;
    };
    observe('targetTransportLost', value => { clearTargetSnapshot(); event({ type: 'transport-lost', pid: value.pid }); });
    observe('targetDisconnected', value => { clearTargetSnapshot(); event({ type: 'target-exited', pid: value.pid }); });
    observe('targetSurfaceChanged', value => { state.surface = value; });
    observe('targetSurfaceRemoved', value => { delete state.surface; event({ type: 'target-surface-removed', pid: value.pid }); });
    observe('windowFocused', value => { state.focusedWindowId = value.windowId; state.focusRevision++; });
    observe('inputInterceptionChanged', value => { state.intercepting = value.intercepting; });
    observe('fps', value => { state.fps = value; state.lastFpsAt = Date.now(); });
    await createWindow('main');
    if (!current(owned)) return;
    const cycleRoot = path.join(options.evidence, `runs-${options.member}`, `cycle-${state.cycle}`);
    const config = sdk.parseReShadeLaunchConfig(['--reshade-overlay'], { runsRootDirectory: cycleRoot });
    const ownedLauncher = new sdk.ReShadeOverlayLauncher(config); launcher = ownedLauncher;
    ownedLauncher.onEvent(value => {
      if (!current(owned)) return;
      event({ type: value.type, ...(value.runDirectory ? { runDirectory: value.runDirectory } : {}) });
      if (value.type === 'injector-watcher-ready') state.watcherReady = true;
      if (value.type === 'injector-started') {
        try { state.injectorBinding = collectInjectorBinding(value.invocation, options); }
        catch (error) { return fail(error); }
      }
      if (value.type === 'target-selected') {
        if (value.pid !== options.targetPid || typeof value.executablePath !== 'string' || value.executablePath.length > 32768 || path.resolve(value.executablePath).toLowerCase() !== options.game.toLowerCase() || !/^[1-9][0-9]{0,19}$/u.test(value.creationTime100ns || '')) return fail(new Error('Injector selected an unexpected resource-soak target identity.'));
        state.selectedTarget = { pid: value.pid, executablePath: value.executablePath, creationTime100ns: value.creationTime100ns };
      }
      if (value.type === 'injector-returned') {
        const result = value.result;
        if (!result || result.injectorTargetPid !== options.targetPid || !['injected-runtime', 'existing-runtime', 'official-addon', 'participant-addon', 'shared-runtime'].includes(result.runtimeMode) || typeof result.runDirectory !== 'string' || !path.isAbsolute(result.runDirectory) || result.runDirectory.length > 32768) return fail(new Error('Injector returned invalid resource-soak target proof.'));
        // Exact-PID launchers already bound creation before injection and do
        // not emit the future-target-only target-selected lifecycle event.
        try { state.selectedTarget = collectSelection(result, options, state.injectorBinding); }
        catch (error) { return fail(error); }
        const proof = { injectorTargetPid: result.injectorTargetPid, runtimeMode: result.runtimeMode, runDirectory: result.runDirectory };
        for (const name of ['targetExecutablePath', 'injectorStdoutPath', 'hostRuntimePath', 'addonModulePath']) {
          const value = result[name];
          if (value === undefined) continue;
          if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 32768) return fail(new Error(`Injector returned an invalid ${name}.`));
          proof[name] = value;
        }
        state.injectorProof = proof;
        state.injectorReturned = true;
        persist();
      }
    });
    event({ type: 'session-created', freshStageRoot: cycleRoot });
    void ownedLauncher.attach(owned, { processName: path.basename(options.game), executablePath: options.game, pid: options.targetPid }).then(result => {
      if (!current(owned)) return;
      Object.assign(state, collectRoute(result, options, sdkEvidence, cycleRoot));
      state.attached = true;
      event({ type: 'private-route-verified', runDirectory: state.runDirectory, tokenFingerprint: state.transport.tokenFingerprint, nativePath: state.native.path });
      persist();
    }).catch(error => { if (current(owned)) fail(error); });
  }
  async function command(raw) {
    const value = parseCommand(raw);
    if (value.sequence <= state.commandSequence) return false;
    switch (value.action) {
      case 'close-session': closeSession(); break;
      case 'recreate-session': if (session) closeSession(); await openSession(); break;
      case 'create-window': await createWindow(value.window); break;
      case 'close-window': requireWindow(value.window).close(); windows.delete(value.window); delete state.windows[value.window]; state.windowsClosed++; break;
      case 'focus': {
        const window = requireWindow(value.window);
        await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').focus()");
        window.focus(); break;
      }
      case 'clear': await requireWindow(value.window).browserWindow.webContents.executeJavaScript("document.querySelector('input').value=''"); break;
      case 'intercept': requireSession().input.intercept(); state.requestedInterception = true; break;
      case 'release': requireSession().input.release(); state.requestedInterception = false; break;
      case 'exit': cleanup(); state.commandSequence = value.sequence; state.exited = true; persist(); app.exit(0); return true;
    }
    state.commandSequence = value.sequence;
    persist();
    return true;
  }
  async function snapshot() {
    for (const [name, window] of windows) {
      const observation = await window.browserWindow.webContents.executeJavaScript("({...window.observed,value:document.querySelector('input').value,dpr:devicePixelRatio})");
      if (windows.get(name) === window) Object.assign(state.windows[name], observation, { visible: window.visible });
    }
    persist();
  }
  async function start() {
    overlay = new sdk.ElectronGameOverlay();
    await openSession(); state.ready = true; persist();
  }
  return { state, start, command, snapshot, cleanup, fail, persist, get done() { return done; } };
}

async function main(argv) {
  const options = parseOptions(argv);
  fs.mkdirSync(options.evidence, { recursive: true });
  const bootstrap = { schemaVersion: 1, phase: 'main-entered', processId: process.pid, argv: [...process.argv], entryPath: __filename,
    processType: process.type || null, defaultApp: Boolean(process.defaultApp), electron: process.versions.electron || null,
    requireMainMatches: require.main === module };
  const persistBootstrap = () => publishJsonSnapshot(path.join(options.evidence, `${options.member}-bootstrap.json`), bootstrap);
  persistBootstrap();
  try {
    const { app } = require('electron');
    app.setPath('userData', path.join(options.evidence, `profile-${options.member}`));
    app.disableHardwareAcceleration();
    const sdkEvidence = collectSdkEvidence(options.sdkDist);
    fs.writeFileSync(path.join(options.evidence, `${options.member}-sdk.json`), JSON.stringify(sdkEvidence, null, 2));
    const sdk = require(path.join(sdkEvidence.sdkDist, 'index.js'));
    const producer = createProducer({ app, sdk, sdkEvidence, options });
    let timer, reading = false;
    app.on('window-all-closed', () => {}); // Session closure must leave this Electron process alive.
    app.on('before-quit', () => { clearInterval(timer); producer.cleanup(); });
    process.on('uncaughtException', producer.fail);
    process.on('unhandledRejection', producer.fail);
    try {
      await app.whenReady();
      await producer.start();
    } catch (error) {
      bootstrap.phase = 'failed';
      bootstrap.error = (error.stack || String(error)).slice(0, 8192);
      try { persistBootstrap(); } catch {}
      producer.fail(error);
      return;
    }
    timer = setInterval(async () => {
      if (reading || producer.done) return;
      reading = true;
      try {
        const commandPath = path.join(options.evidence, `${options.member}-command.json`);
        if (fs.existsSync(commandPath)) await producer.command(readBoundedJson(commandPath));
        if (!producer.done) await producer.snapshot();
      } catch (error) { producer.fail(error); }
      finally { reading = false; }
    }, 50);
    bootstrap.phase = 'producer-started';
    persistBootstrap();
  } catch (error) {
    bootstrap.phase = 'failed';
    bootstrap.error = (error.stack || String(error)).slice(0, 8192);
    try { persistBootstrap(); } catch {}
    throw error;
  }
}

function entryArguments(runtime, filename) {
  if (!Array.isArray(runtime.argv)) return undefined;
  // Electron's default_app scans the first non-option (or --app=) and does
  // not rewrite argv before importing it. A preload argument is not the app.
  for (let index = 1; index < runtime.argv.length; index++) {
    const argument = runtime.argv[index];
    if (typeof argument !== 'string') return undefined;
    if (argument === '--require' || argument === '-r') { index++; continue; }
    if (argument === '--version' || argument === '-v') return undefined;
    const selected = argument.startsWith('--app=') ? argument.split('=')[1] : argument.startsWith('-') ? undefined : argument;
    if (selected === undefined) continue;
    return selected && path.resolve(selected).toLowerCase() === path.resolve(filename).toLowerCase()
      ? runtime.argv.slice(index + 1) : undefined;
  }
  return undefined;
}

function isMainEntrypoint(runtime, requiredMain, self, filename) {
  return requiredMain === self || Boolean(runtime.versions?.electron && runtime.type === 'browser' &&
    entryArguments(runtime, filename) !== undefined);
}

module.exports = { MAX_CYCLES, MAX_WINDOWS, parseOptions, parseCommand, collectPrivateRoute, collectInjectorBinding, collectInjectorSelection, createProducer, entryArguments, isMainEntrypoint };
const runEntrypoint = isMainEntrypoint(process, require.main, module, __filename);
if (process.versions.electron && process.type === 'browser') {
  console.log('EGO_RESOURCE_SOAK_ENTRY ' + JSON.stringify({ processId: process.pid, argv: [...process.argv], entryPath: __filename,
    requireMainMatches: require.main === module, selected: runEntrypoint }));
}
if (runEntrypoint) main(entryArguments(process, __filename) || process.argv.slice(2)).catch(error => {
  console.error(error.stack || String(error));
  require('electron').app.exit(1);
});
