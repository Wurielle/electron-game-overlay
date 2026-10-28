'use strict';
// Explicit opt-in: node tests/real-electron-input.acceptance.cjs <evidence.json>
// Requires genuine installed Electron; Linux uses test-only headless/no-sandbox.
// Never copy the container-only sandbox flag into a consumer application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

// Only the native target transport is controlled. No routing/geometry algorithm
// or Electron API is replaced; the real broker communicates over real sockets.
class ControlledNativeBoundary {
  constructor() { this.windows = new Map(); this.frames = new Map(); this.bounds = []; }
  start() {}
  stop() {}
  whenReady() { return Promise.resolve(); }
  authorizeTarget() { return () => {}; }
  setEventCallback(callback) { this.callback = callback; }
  setDiagnosticCallback() {}
  setInputIntercept() {}
  addWindow(id, details) { this.windows.set(id, structuredClone(details)); }
  closeWindow(id) { this.windows.delete(id); }
  sendWindowBounds(id, details) { this.bounds.push({ id, details }); }
  sendFrameBuffer(id, pixels, width, height) { this.frames.set(id, { width, height }); return true; }
  emit(event, payload) {
    // Opt-in negative control must fail the DOM assertion, not substitute a renderer.
    if (process.env.EGO_ACCEPTANCE_DROP_CHAR === '1' && event === 'game.input' && payload.msg === 0x102) return;
    this.callback(event, { pid: 43210, ...payload });
  }
}
const reportPath = path.resolve(process.argv[2] || 'real-electron-input-acceptance.json');
const report = { passed: false, stage: 'setup', electronReady: false, exitCode: 1, platform: process.platform, environment: { DISPLAY: process.env.DISPLAY || null, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || null }, command: [process.execPath, ...process.argv.slice(1)], assertions: 0, completedSteps: [], boundaries: { intendedReal: ['Electron main/renderer processes', 'offscreen BrowserWindow', 'OverlaySession lifecycle/windows/input', 'OverlayBrokerClient/Server sockets', 'DOM click/focus/key/input/value'], controlled: ['native target transport', 'synthetic Windows focus/mouse/key messages', 'fake PID 43210 and Windows image identity', 'minimal HTML input adapter, not demo application'], excluded: ['Windows native hook', 'Rust caption dragging/compositor rendering', 'real game injection', 'application app-entry focus callback', 'mixed SDK versions'] }, children: [] };
const save = () => { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
save();
let root;
let server;
const children = [];
let sequence = 0;
const check = (condition, message) => { assert.ok(condition, message); report.assertions++; };
const waitFor = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for acceptance state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const request = (child, command) => new Promise((resolve, reject) => {
  const requestId = ++sequence;
  const timeout = setTimeout(() => finish(new Error(`Child ${command} timed out`)), 8000);
  const onMessage = message => { if (message.requestId === requestId) finish(message.error ? new Error(message.error) : null, message.result); };
  const onExit = code => finish(new Error(`Child exited during ${command}: ${code}`));
  const finish = (error, value) => { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); error ? reject(error) : resolve(value); };
  child.on('message', onMessage); child.once('exit', onExit);
  child.send({ requestId, command });
});
const launch = (electron, name, pipePath) => new Promise((resolve, reject) => {
  const profile = path.join(root, name); fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, EGO_ACCEPTANCE_PROFILE: profile, EGO_ACCEPTANCE_NAME: name, EGO_ACCEPTANCE_PIPE: pipePath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = fork(path.join(__dirname, 'helpers/real-electron-input-child.cjs'), [], { execPath: electron, execArgv: ['--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const item = { name, pid: child.pid, stderr: '', stdout: '', exit: null };
  children.push(child); report.children.push(item);
  child.stdout.on('data', data => { item.stdout = (item.stdout + data).slice(-12000); });
  child.stderr.on('data', data => { item.stderr = (item.stderr + data).slice(-12000); });
  const timeout = setTimeout(() => reject(new Error(`Electron ${name} did not become ready`)), 15000);
  child.on('exit', (code, signal) => { item.exit = { code, signal }; clearTimeout(timeout); reject(new Error(`Electron ${name} exited ${code}: ${item.stderr}`)); });
  child.on('message', message => {
    if (message.type === 'fatal') { clearTimeout(timeout); reject(new Error(message.error)); }
    if (message.type === 'ready') { clearTimeout(timeout); item.ready = message; resolve(child); }
  });
});
const deadline = setTimeout(() => { report.error = 'Overall 60s acceptance deadline'; save(); for (const child of children) child.kill('SIGKILL'); process.exitCode = 1; server?.stop(); }, 60000);
(async () => {
  try {
    const { OverlayBrokerServer } = require('../dist/lib/overlay-broker-server.js');
    const electron = require('electron');
    check(typeof electron === 'string' && fs.existsSync(electron), 'genuine installed Electron executable required');
    root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ego-real-ui-'));
    const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\ego-ui-${process.pid}` : path.join(root, 'broker.sock');
    const native = new ControlledNativeBoundary();
    server = new OverlayBrokerServer({ pipePath, idleShutdownMs: false, runtimeProviderElectionWindowMs: 0, isProcessAlive: () => true, targetRecoveryClaimProbe: () => undefined, clearTargetRecoveryClaim: () => undefined, targetTransportFactory: () => native });
    await server.start();
    const apps = await Promise.all(['a', 'b'].map(name => launch(electron, name, pipePath)));
    report.electronReady = true;
    report.stage = 'assertions';
    check(report.children[0].ready.pid !== report.children[1].ready.pid, 'independent Electron processes');
    check(report.children[0].ready.profile !== report.children[1].ready.profile, 'isolated profiles');
    check(report.children.every(item => item.ready.windows[0].id === 1), 'both apps reuse native local ID 1');
    check(report.children.every(item => item.ready.windows.every(window => window.offscreen)), 'all four windows are real OSR BrowserWindows');
    check(report.children.every(item => item.ready.windows.every(window => window.dom.value === '' && window.dom.events.length === 0)), 'every real DOM input starts empty without programmatic input focus');
    await request(apps[0], 'authorize');
    native.emit('game.process', { path: 'C:\\Games\\Shared Game\\game.exe' });
    await request(apps[1], 'authorize');
    await waitFor(() => native.windows.size === 4);
    report.registrations = [...native.windows].map(([id, details]) => ({ id, details }));
    check(new Set(report.registrations.map(item => item.id)).size === 4, 'four target-global IDs');
    await waitFor(() => native.frames.size === 4);
    report.frames = [...native.frames];
    const expected = [['', ''], ['', '']];
    // The same path visits both real windows of each app, then returns to each.
    for (const [appIndex, windowIndex, text] of [[0, 0, 'a'], [1, 0, 'b'], [0, 1, 'A'], [1, 1, 'B'], [0, 0, 'A'], [1, 0, 'B'], [0, 1, 'a'], [1, 1, 'b']]) {
      const name = `${appIndex === 0 ? 'a' : 'b'}-${windowIndex}`;
      const id = [...native.windows].find(([, details]) => details.name === name)?.[0];
      check(id !== undefined, `registered ${name}`);
      native.emit('game.window.focused', { focusWindowId: id });
      const lparam = (70 << 16) | 60;
      for (const [msg, wparam, position] of [[0x200, 0, lparam], [0x201, 1, lparam], [0x202, 0, lparam], [0x100, text.toUpperCase().charCodeAt(0), 1], [0x102, text.charCodeAt(0), 1], [0x101, text.toUpperCase().charCodeAt(0), 1]]) native.emit('game.input', { windowId: id, msg, wparam, lparam: position, scaleFactorMicros: 1000000 });
      expected[appIndex][windowIndex] += text;
      let snapshots;
      try {
        await waitFor(async () => { snapshots = await Promise.all(apps.map(child => request(child, 'snapshot'))); report.lastSnapshots = snapshots; return snapshots[appIndex][windowIndex].dom.value === expected[appIndex][windowIndex]; });
      } catch (error) {
        if (snapshots) assert.equal(snapshots[appIndex][windowIndex].dom.value, expected[appIndex][windowIndex], 'real DOM input must receive routed character');
        throw error;
      }
      check(snapshots[appIndex][windowIndex].dom.active === 'hudhook-client-input-target', 'real mouse click focuses intended DOM input');
      check(['mousedown', 'mouseup', 'keydown', 'input', 'keyup'].every(type => snapshots[appIndex][windowIndex].dom.events.some(event => event.type === type)), 'real DOM observes mouse/key/input events');
      check(JSON.stringify(snapshots.map(windows => windows.map(window => window.dom.value))) === JSON.stringify(expected), 'all other input values unchanged');
      check(snapshots.every((windows, app) => windows.every((window, index) => JSON.stringify(window.bounds) === JSON.stringify(report.children[app].ready.windows[index].bounds))), 'focus changes preserve every actual BrowserWindow bounds');
      report.completedSteps.push({ appIndex, windowIndex, text, snapshots });
    }
    report.finalValues = expected;
    for (const app of apps) await request(app, 'quit');
    await waitFor(() => report.children.every(item => item.exit !== null));
    check(report.children.every(item => item.exit.code === 0), 'both Electron consumers quit cleanly');
    report.passed = true;
    report.stage = 'completed';
    report.exitCode = 0;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    clearTimeout(deadline);
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGKILL');
      });
    }));
    await server?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    save();
    console.log(JSON.stringify({ passed: report.passed, assertions: report.assertions, completedSteps: report.completedSteps.length, reportPath, error: report.error }));
  }
})();
