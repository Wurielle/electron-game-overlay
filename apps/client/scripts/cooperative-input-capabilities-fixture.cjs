'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');

// Observe packet metadata at the real socket boundary. Never retain a token,
// JSON body, frame pixels, typed text, or arbitrary native payload.
class PacketMetadataObserver {
  constructor(direction, summary) {
    this.direction = direction;
    this.summary = summary;
    this.header = Buffer.alloc(5);
    this.headerUsed = 0;
    this.remaining = 0;
    this.kind = 0;
    this.json = [];
    this.jsonBytes = 0;
  }
  push(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.summary.bytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      if (this.headerUsed < 5) {
        const count = Math.min(5 - this.headerUsed, bytes.length - offset);
        bytes.copy(this.header, this.headerUsed, offset, offset + count);
        this.headerUsed += count;
        offset += count;
        if (this.headerUsed !== 5) continue;
        this.remaining = this.header.readUInt32LE(0);
        this.kind = this.header[4];
        this.json = [];
        this.jsonBytes = 0;
        if (this.remaining > 64 * 1024 * 1024) { this.summary.error = 'oversized-packet'; return; }
      }
      const count = Math.min(this.remaining, bytes.length - offset);
      if (this.kind === 1 && this.jsonBytes + count <= 64 * 1024) {
        this.json.push(Buffer.from(bytes.subarray(offset, offset + count)));
        this.jsonBytes += count;
      } else if (this.kind === 1) {
        this.summary.error = 'oversized-json';
      }
      this.remaining -= count;
      offset += count;
      if (this.remaining !== 0) continue;
      this.summary.packets++;
      if (this.kind === 2) this.summary.frames++;
      else if (this.kind === 1 && !this.summary.error) {
        let value;
        try { value = JSON.parse(Buffer.concat(this.json).toString('utf8')); }
        catch { this.summary.error = 'malformed-json'; }
        if (value) this.recordJson(value);
      } else if (this.kind !== 1) this.summary.unknownKinds++;
      this.headerUsed = 0;
      this.json = [];
    }
  }
  recordJson(value) {
    const type = typeof value.type === 'string' && /^[a-z][a-z0-9.-]{0,99}$/u.test(value.type) ? value.type : 'unknown-json';
    this.summary.types[type] = (this.summary.types[type] || 0) + 1;
    if (this.direction === 'outbound' && type === 'command.input.intercept' && value.intercept === true) this.summary.interceptTrue++;
    if (this.direction === 'inbound' && type === 'game.process') {
      this.summary.hello = {
        pid: Number.isSafeInteger(value.pid) ? value.pid : null,
        path: typeof value.path === 'string' ? value.path : null,
        creationTime100ns: typeof value.creationTime100ns === 'string' ? value.creationTime100ns : null,
        protocolVersion: Number.isSafeInteger(value.protocolVersion) ? value.protocolVersion : null,
        capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter(token => typeof token === 'string' && token.length <= 100).slice(0, 64) : null,
      };
    }
  }
}

function packetSummary() {
  return { bytes: 0, packets: 0, frames: 0, interceptTrue: 0, unknownKinds: 0, types: Object.create(null) };
}

function wireSummary(records) {
  const summary = { nativeConnections: records.length, helloCount: 0, outboundBytes: 0,
    outboundPackets: 0, outboundFrames: 0, interceptTruePackets: 0, outboundTypes: Object.create(null) };
  for (const record of records) {
    summary.helloCount += record.inbound.types['game.process'] || 0;
    summary.outboundBytes += record.outbound.bytes;
    summary.outboundPackets += record.outbound.packets;
    summary.outboundFrames += record.outbound.frames;
    summary.interceptTruePackets += record.outbound.interceptTrue;
    for (const [type, count] of Object.entries(record.outbound.types)) summary.outboundTypes[type] = (summary.outboundTypes[type] || 0) + count;
  }
  return summary;
}

function observeNativeConnections(records, onError = () => {}) {
  const emit = net.Server.prototype.emit;
  net.Server.prototype.emit = function (name, ...values) {
    if (name === 'connection') {
      const socket = values[0];
      if (records.length >= 256) { onError(new Error('Wire evidence exceeded its bounded connection capacity.')); }
      else {
        const record = { sequence: records.length + 1, localAddress: socket.localAddress, localPort: socket.localPort,
          remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, closed: false, actualBytesWritten: 0,
          inbound: packetSummary(), outbound: packetSummary() };
        records.push(record);
        const inbound = new PacketMetadataObserver('inbound', record.inbound);
        const outbound = new PacketMetadataObserver('outbound', record.outbound);
        socket.on('data', bytes => inbound.push(bytes));
        socket.on('close', () => { record.closed = true; record.actualBytesWritten = socket.bytesWritten; });
        const write = socket.write;
        socket.write = function (bytes, ...rest) {
          outbound.push(typeof bytes === 'string' ? Buffer.from(bytes, typeof rest[0] === 'string' ? rest[0] : undefined) : bytes);
          const accepted = write.call(this, bytes, ...rest);
          record.actualBytesWritten = socket.bytesWritten;
          return accepted;
        };
      }
    }
    return emit.call(this, name, ...values);
  };
  return () => { net.Server.prototype.emit = emit; };
}

function parseArguments(argv) {
  const args = Object.fromEntries(argv.filter(value => value.startsWith('--') && value.includes('=')).map(value => {
    const index = value.indexOf('='); return [value.slice(2, index), value.slice(index + 1)];
  }));
  if (!['strict', 'permissive'].includes(args.member) || !args.evidence || !args['sdk-dist'] || !args.target ||
      !/^[1-9][0-9]*$/u.test(args.pid || '') || !Number.isSafeInteger(Number(args.pid)) || Number(args.pid) > 0xffffffff) {
    throw new Error('Expected member strict|permissive, evidence, sdk-dist, target path and exact pid.');
  }
  args.expect ||= args.member === 'strict' ? 'reject' : 'accept';
  args.require ||= args.member === 'strict' ? 'copied-raw-input-buffer' : 'copied-wm-input';
  if (!['reject', 'accept'].includes(args.expect) || !['copied-wm-input', 'copied-raw-input-buffer'].includes(args.require)) throw new Error('Invalid expected result or required input capability.');
  return args;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const { app } = require('electron');
  const { collectSdkEvidence } = require('./cooperative-game-evidence.cjs');
  const { publishJsonSnapshot } = require('./cooperative-atomic-state.cjs');
  const member = args.member, root = path.resolve(args.evidence), targetPid = Number(args.pid);
  fs.mkdirSync(root, { recursive: true });
  const sdk = collectSdkEvidence(path.resolve(args['sdk-dist']));
  fs.writeFileSync(path.join(root, `${member}-sdk.json`), JSON.stringify(sdk, null, 2));
  app.setPath('userData', path.join(root, `profile-${member}`));
  app.disableHardwareAcceleration();
  const { ElectronGameOverlay, ReShadeOverlayLauncher, parseReShadeLaunchConfig } = require(path.join(sdk.sdkDist, 'index.js'));
  let overlay, session, launcher, window, timer, done = false, reading = false, sequence = 0;
  const state = { schemaVersion: 1, member, expected: args.expect, requiredInputCapabilities: [args.require],
    processId: process.pid, targetPid, ready: false, attached: false, rejected: false, rendering: false,
    connectionCount: 0, authenticationCount: 0, transportLostCount: 0, targetDisconnectedCount: 0,
    trueAckCount: 0, falseAckCount: 0, requestedInterception: true, intercepting: false, focusedWindowId: 0,
    fpsCount: 0, surface: null, renderingCount: 0, attachment: null, hello: null,
    windows: {}, wire: wireSummary([]), wireConnections: [], events: [] };
  const persist = () => publishJsonSnapshot(path.join(root, `${member}-state.json`), state);
  const event = value => { state.events.push({ ...value, at: Date.now() }); if (state.events.length > 512) state.events.shift(); };
  function cleanup() { if (done) return; done = true; clearInterval(timer); try { launcher?.dispose(); } catch {} try { overlay?.dispose(); } catch {} restoreObserver(); }
  function fail(error) { if (done) return; state.error = error.stack || String(error); try { persist(); } catch {} cleanup(); app.exit(1); }
  const restoreObserver = observeNativeConnections(state.wireConnections, fail);
  process.on('uncaughtException', fail); process.on('unhandledRejection', fail); app.on('before-quit', cleanup);
  function captureRoute(directory) {
    state.runDirectory = directory;
    const filename = path.join(directory, 'electron-overlay-transport-v1.json');
    if (!fs.existsSync(filename)) return;
    const route = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''));
    if (route.version !== 1 || route.pid !== process.pid || route.targetPid !== targetPid || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535 || !/^[0-9a-f]{64}$/iu.test(route.token || '')) throw new Error('The private native route did not match this producer and target.');
    state.transport = { producerPid: route.pid, targetPid: route.targetPid, port: route.port,
      tokenFingerprint: createHash('sha256').update(route.token.toLowerCase()).digest('hex') };
  }
  async function snapshot() {
    if (window) Object.assign(state.window, await window.browserWindow.webContents.executeJavaScript("({...window.observed,value:document.querySelector('input').value,dpr:devicePixelRatio})"));
    if (state.runDirectory) captureRoute(state.runDirectory);
    for (const wire of state.wireConnections) if (wire.inbound.error || wire.outbound.error) throw new Error(`Invalid wire evidence: ${wire.inbound.error || wire.outbound.error}`);
    state.wire = wireSummary(state.wireConnections);
    state.hello = state.wireConnections.filter(wire => wire.inbound.hello).at(-1)?.inbound.hello || null;
    persist();
  }
  async function command(value) {
    if (value.action === 'focus') { await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').focus()"); window.focus(); }
    else if (value.action === 'clear') await window.browserWindow.webContents.executeJavaScript("document.querySelector('input').value=''");
    else if (value.action === 'intercept') { state.requestedInterception = true; session.input.intercept(); }
    else if (value.action === 'release') { state.requestedInterception = false; session.input.release(); }
    else if (value.action === 'exit') { state.commandSequence = value.sequence; await snapshot(); cleanup(); app.exit(0); return; }
    else throw new Error(`Unknown capability fixture command ${value.action}`);
    state.commandSequence = value.sequence;
  }
  try {
  await app.whenReady();
  overlay = new ElectronGameOverlay({ requiredInputCapabilities: [args.require] });
  session = overlay.createSession();
  session.on('diagnostic', value => {
    event({ code: value.code, severity: value.severity, pid: value.pid,
      ...(value.code === 'target-input-capability-unsupported' ? { context: value.context } : {}) });
    if (value.code === 'target-authenticated') state.authenticationCount++;
    if (value.code === 'runtime-scene-rendering-started') { state.rendering = true; state.renderingCount++; }
    if (value.severity === 'error' && !(args.expect === 'reject' && value.code === 'target-input-capability-unsupported')) fail(new Error(`Unexpected capability acceptance diagnostic: ${value.code}`));
  });
  session.on('targetInputCapabilitiesRejected', value => { state.rejected = true; state.rejection = value; state.capabilities = session.targets.inputCapabilities(targetPid); persist(); });
  session.on('targetConnected', value => { state.connectionCount++; state.authenticatedTarget = value; state.capabilities = session.targets.inputCapabilities(targetPid); });
  session.on('targetTransportLost', () => { state.transportLostCount++; });
  session.on('targetDisconnected', () => { state.targetDisconnectedCount++; });
  session.on('targetSurfaceChanged', value => { state.surface = value; });
  session.on('fps', value => { state.fps = value; state.fpsCount++; });
  session.on('windowFocused', value => { state.focusedWindowId = value.windowId; });
  session.on('inputInterceptionChanged', value => { state.intercepting = value.intercepting; if (value.intercepting) state.trueAckCount++; else state.falseAckCount++; });
  const bounds = { x: member === 'strict' ? 40 : 400, y: 80, width: 300, height: 220 }, color = member === 'strict' ? '#c62828' : '#1565c0';
  window = session.windows.create({ id: 'capability-input', name: `capability-${member}`, bounds, focusOnReady: false, captionHeight: 0, dragBorder: 0 });
  state.window = state.windows.main = { id: window.nativeId, bounds, color, downs: 0, ups: 0, keydowns: 0, value: '', wheel: [], heldKeys: [] };
  await window.browserWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;width:300px;height:220px;background:${color};color:white;font:18px sans-serif"><div style="padding:8px">${member} capability</div><input style="position:absolute;left:20px;top:40px;width:180px;height:30px;font:18px sans-serif" autocomplete="off"><script>window.observed={downs:0,ups:0,keydowns:0,wheel:[],heldKeys:[]};const held=new Set();addEventListener('pointerdown',()=>observed.downs++);addEventListener('pointerup',()=>observed.ups++);addEventListener('keydown',e=>{observed.keydowns++;held.add(e.code);observed.heldKeys=[...held]});addEventListener('keyup',e=>{held.delete(e.code);observed.heldKeys=[...held]});addEventListener('wheel',e=>observed.wheel.push({x:e.clientX,y:e.clientY,dx:e.deltaX,dy:e.deltaY}));document.querySelector('input').focus();</script></body></html>`));
  window.show(); session.input.intercept(); state.ready = true; persist();
  timer = setInterval(async () => {
    if (reading || done) return; reading = true;
    try {
      const filename = path.join(root, `${member}-command.json`);
      if (fs.existsSync(filename)) { const value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, '')); if (Number.isSafeInteger(value.sequence) && value.sequence > sequence) { sequence = value.sequence; await command(value); } }
      if (!done) await snapshot();
    } catch (error) { fail(error); } finally { reading = false; }
  }, 40);
  launcher = new ReShadeOverlayLauncher(parseReShadeLaunchConfig(['--reshade-overlay'], { runsRootDirectory: path.join(root, `runs-${member}`) }));
  launcher.onEvent(value => {
    event({ type: value.type, ...(value.runDirectory ? { runDirectory: value.runDirectory } : {}) });
    if (value.type === 'runtime-staged') { state.runDirectory = value.runDirectory; persist(); }
    if (value.type === 'target-rendezvous-authorized' && state.runDirectory) captureRoute(state.runDirectory);
    if (value.type === 'injector-returned') state.injectorReturned = true;
  });
  try {
    const result = await launcher.attach(session, { processName: path.basename(args.target), executablePath: path.resolve(args.target), pid: targetPid });
    state.attached = true; state.attachment = result; captureRoute(result.runDirectory);
    if (args.expect === 'reject') throw new Error('A required unsupported input capability unexpectedly attached.');
  } catch (error) {
    if (args.expect !== 'reject' || error.diagnostic?.code !== 'target-input-capability-unsupported') throw error;
    state.attachmentRejectedCode = error.diagnostic.code;
    state.attachError = { code: error.diagnostic.code, stage: error.diagnostic.stage, retrySafety: error.diagnostic.retrySafety };
    state.rejected = true;
  }
  await snapshot();
  } catch (error) { fail(error); }
}

function isFixtureEntry({ isMain = require.main === module, electron = process.versions.electron,
  processType = process.type, argv = process.argv } = {}) {
  if (isMain) return true;
  // Electron's default app can load the selected CJS script as a child module.
  // Only its explicitly selected browser entry may start this fixture; Node
  // test imports and other Electron modules must remain side-effect free.
  if (!electron || processType !== 'browser' || !Array.isArray(argv)) return false;
  let selectedArgument, requireValue = false;
  for (const argument of argv.slice(1)) {
    if (typeof argument !== 'string') return false;
    if (requireValue) { requireValue = false; continue; }
    if (argument === '--require' || argument === '-r') { requireValue = true; continue; }
    if (['--version', '-v', '--abi', '-a', '--interactive', '-i', '-repl'].includes(argument)) return false;
    if (argument.startsWith('--app=')) { selectedArgument = argument.slice('--app='.length); break; }
    if (argument.startsWith('-')) continue;
    selectedArgument = argument;
    break;
  }
  if (!selectedArgument) return false;
  try {
    const selected = fs.realpathSync(selectedArgument);
    const fixture = fs.realpathSync(__filename);
    return process.platform === 'win32' ? selected.toLowerCase() === fixture.toLowerCase() : selected === fixture;
  } catch { return false; }
}

module.exports = { PacketMetadataObserver, packetSummary, wireSummary, observeNativeConnections, parseArguments, isFixtureEntry, run };
if (isFixtureEntry()) run().catch(error => {
  console.error(error);
  const { app } = require('electron');
  if (app) app.exit(1); else process.exitCode = 1;
});
