'use strict';

// Opt-in SDK/native console acceptance. No Electron, target process, GUI or
// injection is created. All native discovery selectors are private directories
// that this test never creates. The session is an explicit pure-Node seam.
// node this-file <report-under-repo-build.json> [complete-sdk-package-root]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const repo = path.resolve(__dirname, '../../..');
const build = path.join(repo, 'build');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const reportPath = path.resolve(process.argv[2] || path.join(build, 'managed-startup-policy.json'));
assert.ok(inside(build, reportPath) && reportPath !== build, 'Report must stay under this SDK repository build directory');
const sdkRoot = fs.realpathSync(path.resolve(process.argv[3] || path.join(repo, 'libs/electron-game-overlay')));
assert.ok(inside(repo, sdkRoot), 'SDK fixture must stay inside this repository; never use an application workspace');
const root = path.join(path.dirname(reportPath), 'owned-managed-startup-' + randomUUID());
const runsRoot = path.join(root, 'runs');
const neverPaths = ['never-created-initial', 'never-created-database', 'never-created-later'].map(name => path.join(root, name));
const normalize = value => value.replace(/\\/g, '/').toLowerCase();
const allowedPatterns = neverPaths.map(file => normalize(file) + '/**');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const records = [], launcherEvents = [], events = [], quiescence = [];
const report = {
  schemaVersion: 1,
  status: 'failed',
  scope: 'Actual compiled managed watcher and native read-only discovery only; pure-Node session readiness/authorization seam',
  sdkRoot,
  ownedRoot: root,
  nativeExecuted: false,
  targetCreated: false,
  injectionExecuted: false,
  electronExecuted: false,
  sessionReadySimulated: true,
  events,
  launcherEvents,
  children: records,
  quiescence,
  checks: [],
};
const originalSpawn = cp.spawn, originalExecFile = cp.execFile;
let watcher, Launcher, originalPrepare, originalQuiesce, heldLauncher;
let releaseHeld, resolvePrepareEntered;
const held = new Promise(resolve => { releaseHeld = resolve; });
const prepareEntered = new Promise(resolve => { resolvePrepareEntered = resolve; });
let releasedHeld = false, grants = 0, releases = 0, nextLauncherId = 0;
const preparations = [], launcherIds = new WeakMap(), stopListeners = [];
const childRecords = new Map();
const deadline = (promise, label, milliseconds = 15000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const stamp = () => new Date().toISOString();
function retain(child, kind, executable, args, executableHash) {
  // Compute/validate hashes before spawn; never throw on a post-spawn file read
  // before retaining the child that cleanup must own.
  const record = { kind, pid: child.pid, executable, arguments: [...args], sha256: executableHash, stdout: '', stderr: '', closed: false };
  records.push(record);
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      record.closed = true;
      record.exitCode = code;
      record.signal = signal;
      record.stdoutDrained = child.stdout?.readableEnded === true;
      record.closedAtUtc = stamp();
      resolve();
    });
  });
  child.on('error', error => { record.error = error.message; });
  child.stdout?.on('data', chunk => { record.stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', chunk => { record.stderr += chunk.toString('utf8'); });
  childRecords.set(child, { record, closed });
  report.nativeExecuted = true;
  return child;
}
function assertNeverSelectors() {
  for (const file of neverPaths) assert.equal(fs.existsSync(file), false, 'A never-created selector directory unexpectedly exists');
}
function assertPolicyInvocation(executable, args, options, expectedHash) {
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.ok(inside(runsRoot, path.resolve(executable)), 'Policy executable escaped the owned runtime stages');
  assert.equal(path.basename(executable).toLowerCase(), 'inject.exe');
  assert.equal(sha(executable), expectedHash, 'Policy executable differs from validated SDK injector');
  assert.deepEqual(args.slice(0, 2), ['--path-contains', '\\']);
  assert.equal(args.length, 4, 'Only a native policy watcher invocation is permitted');
  assert.equal(args[2], '--policy-file');
  const file = path.resolve(args[3]);
  assert.ok(inside(runsRoot, file));
  assert.equal(path.resolve(options.cwd), path.dirname(file));
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.shift(), 'EGO_PROCESS_POLICY_V1');
  assert.equal(lines.pop(), '');
  assert.ok(lines.length > 0 && lines.length <= allowedPatterns.length);
  for (const line of lines) {
    assert.ok(line.startsWith('A\t'), 'Only owned never-created allow rules are permitted');
    assert.ok(allowedPatterns.includes(line.slice(2)), 'Policy could select a non-test process');
  }
  assertNeverSelectors();
}
async function cleanup() {
  try {
    watcher?.dispose();
    if (!releasedHeld) { releasedHeld = true; releaseHeld(); }
    for (const child of childRecords.keys()) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await deadline(Promise.all([...childRecords.values()].map(entry => entry.closed)), 'Owned native child cleanup');
    await deadline(Promise.allSettled(preparations), 'Owned preparation cleanup');
    assertNeverSelectors();
    assert.equal([...childRecords.values()].every(({ record }) => record.closed), true);
    assert.equal(grants, releases, 'Every simulated session authorization must be released');
    report.cleanup = { status: 'passed', ownedChildren: childRecords.size, allClosed: true, authorizations: grants, released: releases };
  } finally {
    for (const stop of stopListeners) stop();
    if (Launcher && originalPrepare) Launcher.prototype.prepare = originalPrepare;
    if (Launcher && originalQuiesce) Launcher.prototype.quiesceUnselectedPolicyWatcher = originalQuiesce;
    cp.spawn = originalSpawn;
    cp.execFile = originalExecFile;
  }
}

(async () => {
  assert.equal(process.platform, 'win32', 'Windows native console acceptance only');
  fs.mkdirSync(root, { recursive: true });
  assertNeverSelectors();
  const launcherModule = require(path.join(sdkRoot, 'dist/lib/reshade-launcher.js'));
  Launcher = launcherModule.ReShadeOverlayLauncher;
  const config = launcherModule.createReShadeLaunchConfig({
    bundledRuntimeDirectory: path.join(sdkRoot, 'dist/runtime/win32-x64/reshade'),
    runsRootDirectory: runsRoot,
  });
  const expectedHash = sha(config.injectorPath);
  report.injectorSha256 = expectedHash;
  cp.spawn = (executable, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(fs.realpathSync(executable), fs.realpathSync(config.injectorPath));
    assert.equal(sha(executable), expectedHash);
    assert.deepEqual(args, ['--observe-future-path-contains', '\\', '--parent-pid', String(process.pid)], 'Only the read-only process observer can spawn');
    return retain(originalSpawn(executable, args, options), 'read-only-observer', executable, args, expectedHash);
  };
  cp.execFile = (executable, args, options, callback) => {
    assertPolicyInvocation(executable, args, options, expectedHash);
    return retain(originalExecFile(executable, args, options, callback), 'never-matching-policy-watcher', executable, args, expectedHash);
  };
  originalPrepare = Launcher.prototype.prepare;
  originalQuiesce = Launcher.prototype.quiesceUnselectedPolicyWatcher;
  Launcher.prototype.prepare = function(...args) {
    if (!launcherIds.has(this)) {
      const id = nextLauncherId++;
      launcherIds.set(this, id);
      launcherEvents.push({ type: 'launcher-created', launcher: id, atUtc: stamp() });
      stopListeners.push(this.onEvent(event => {
        launcherEvents.push({ type: event.type, launcher: id, atUtc: stamp(), ...(event.creationCutoff100ns ? { creationCutoff100ns: event.creationCutoff100ns } : {}), ...(event.error ? { error: event.error.message } : {}) });
      }));
    }
    const operation = originalPrepare.apply(this, args);
    preparations.push(operation);
    if (!heldLauncher) {
      heldLauncher = this;
      resolvePrepareEntered();
      return Promise.all([operation, held]).then(() => undefined);
    }
    return operation;
  };
  Launcher.prototype.quiesceUnselectedPolicyWatcher = async function(...args) {
    const record = { launcher: launcherIds.get(this), startedAtUtc: stamp() };
    quiescence.push(record);
    const safe = await originalQuiesce.apply(this, args);
    record.safe = safe;
    record.completedAtUtc = stamp();
    return safe;
  };
  const handlers = new Map(), closeHandlers = new Set();
  const session = {
    whenReady: () => Promise.resolve(),
    on(name, handler) { let set = handlers.get(name); if (!set) handlers.set(name, set = new Set()); set.add(handler); return () => set.delete(handler); },
    onClose(handler) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
  };
  const authorization = require(path.join(sdkRoot, 'dist/lib/overlay-session-authorization.js'));
  authorization.globalTargetAuthorizers.set(session, async discoveryPath => {
    if (discoveryPath !== undefined) assert.ok(inside(runsRoot, path.resolve(discoveryPath)));
    grants++;
    let active = true;
    return () => { if (active) { active = false; releases++; } };
  });
  authorization.targetAuthorizers.set(session, async () => { throw new Error('No target authorization or injection is permitted in this test'); });
  const { OverlayTargetWatcher } = require(path.join(sdkRoot, 'dist/lib/overlay-target-watcher.js'));
  watcher = new OverlayTargetWatcher(session, {
    config,
    earlyPolicy: { allow: [allowedPatterns[0]] },
    onEvent(event) {
      events.push({ type: event.type, atUtc: stamp(), ...(event.error ? { error: event.error.message, stack: event.error.stack } : {}), ...(event.selector ? { selector: event.selector } : {}), ...(event.target ? { target: event.target } : {}) });
    },
  });
  let initial = 'pending';
  void watcher.ready.then(() => { initial = 'fulfilled'; }, () => { initial = 'rejected'; });
  await deadline(prepareEntered, 'Actual initial preparation entry after observer baseline');
  assert.equal(records.filter(record => record.kind === 'read-only-observer').length, 1);
  assert.equal(records.filter(record => record.kind === 'never-matching-policy-watcher').length, 0);
  assert.equal(initial, 'pending');
  const replacement = watcher.update({ earlyPolicy: { allow: allowedPatterns.slice(0, 2) } });
  assert.equal(initial, 'pending', 'Supersession cannot immediately reject initial readiness');
  await deadline(Promise.all([watcher.ready, replacement]), 'Current replacement native watcher readiness while obsolete preparation remains held');
  assert.equal(releasedHeld, false);
  assert.equal(initial, 'fulfilled');
  assert.equal(events.filter(event => event.type === 'ready').length, 1);
  assert.equal(events.filter(event => event.type === 'armed').length, 1);
  assert.equal(events.some(event => event.type === 'error' || event.type === 'discovery-blocked'), false, JSON.stringify(events));
  const firstNative = records.find(record => record.kind === 'never-matching-policy-watcher');
  assert.ok(firstNative && /EGO_POLICY_BASELINE_V1\t[1-9][0-9]*\r?\n/.test(firstNative.stdout));
  assert.match(firstNative.stdout, /ReShade path watcher armed\./);
  report.checks.push('Initial readiness follows an additive policy replacement during actual held preparation; the replacement reaches native readiness without waiting for the obsolete preparation');
  releasedHeld = true; releaseHeld();
  await deadline(Promise.allSettled(preparations), 'Obsolete preparation settled');
  await tick();
  assert.equal(events.some(event => event.type === 'error'), false);
  await deadline(watcher.update({ earlyPolicy: { allow: allowedPatterns } }), 'Later current policy replacement and checked native quiescence');
  assert.equal(quiescence.length, 1);
  assert.equal(quiescence[0].safe, true);
  assert.equal(firstNative.closed, true);
  assert.equal(firstNative.stdoutDrained, true);
  assert.equal(events.filter(event => event.type === 'ready').length, 2);
  assert.equal(events.filter(event => event.type === 'armed').length, 2);
  assert.equal(records.filter(record => record.kind === 'never-matching-policy-watcher').length, 2);
  assert.deepEqual(watcher.targets, []);
  assert.equal(events.some(event => ['error', 'discovery-blocked', 'attaching', 'connected', 'transport-lost', 'exited'].includes(event.type)), false, JSON.stringify(events));
  assert.equal(launcherEvents.some(event => ['target-selected', 'target-connected', 'injector-returned'].includes(event.type)), false);
  for (const record of records) {
    assert.equal(/EGO_TARGET_SELECTED|ELECTRON_GAME_OVERLAY_INJECTOR_RESULT|Succeeded!/.test(record.stdout), false, JSON.stringify(record));
  }
  report.checks.push('A later update safely drains the unselected native watcher before replacing it, without target selection, injection or target-exit claims');
  report.status = 'passed';
})().catch(error => {
  report.error = error.stack;
  process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  report.completedAtUtc = stamp();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, nativeExecuted: report.nativeExecuted, targetCreated: false, injectionExecuted: false, children: records.length, error: report.error, cleanup: report.cleanup, reportPath }));
});
