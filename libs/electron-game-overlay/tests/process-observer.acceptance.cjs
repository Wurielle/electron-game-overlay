// Actual Windows observer + public SDK. No injection, game files or UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { observeOverlayProcesses } = require('../dist/index.js');
const {
  resolveOverlayBrokerProcessIdentity,
} = require('../dist/lib/overlay-broker-native-provider.js');
const root = fs.mkdtempSync(path.resolve('build', 'observer-native-日本語-'));
const report = { status: 'failed', nativeExecuted: false, checks: [] };
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report));
const children = [];
let observer;
async function until(predicate, label) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < end, label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function target() {
  const exe = path.join(root, 'é-target.exe');
  if (!fs.existsSync(exe)) fs.copyFileSync(process.execPath, exe);
  const child = spawn(
    exe,
    ['-e', "console.log('READY');setInterval(()=>{},1000)"],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`owned target exited before readiness: ${code}`)),
    );
    child.stdout.once('data', resolve);
  });
  return child;
}
(async () => {
  const baseline = await target();
  const created = [],
    exited = [],
    errors = [];
  observer = observeOverlayProcesses({
    pathContains: root,
    onCreated: (value) => created.push(value),
    onExited: (value) => exited.push(value),
    onError: (error) => errors.push(error.message),
  });
  await observer.ready;
  report.nativeExecuted = true;
  const fresh = await target();
  await until(
    () => created.some((value) => value.pid === fresh.pid),
    'new Unicode process observed',
  );
  assert.equal(
    created.some((value) => value.pid === baseline.pid),
    false,
  );
  const identity = created.find((value) => value.pid === fresh.pid);
  const expected = await resolveOverlayBrokerProcessIdentity(
    fresh.pid,
    path.resolve(
      'libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay_reshade_manager.exe',
    ),
  );
  assert.equal(identity.creationTime100ns, expected.creationTime100ns);
  assert.equal(
    identity.executablePath.toLowerCase(),
    expected.executablePath.toLowerCase(),
  );
  fresh.kill();
  await until(
    () => exited.some((value) => value.pid === fresh.pid),
    'retained-handle exit observed',
  );
  assert.equal(exited[0], identity);
  observer.dispose();
  observer.dispose();
  baseline.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exited.length, 1);
  assert.deepEqual(errors, []);
  report.checks = [
    'ready handshake',
    'baseline excluded',
    'Unicode path',
    'same exact creation FILETIME as independent OS query',
    'authoritative retained-handle exit',
    'idempotent disposal without synthetic exits',
  ];
  report.status = 'passed';
})()
  .catch((error) => {
    report.error = error.stack;
    process.exitCode = 1;
    fs.writeFileSync(
      path.join(root, 'report.json'),
      JSON.stringify(report, null, 2),
    );
  })
  .finally(async () => {
    observer?.dispose();
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? undefined
          : new Promise((resolve) => child.once('exit', resolve)),
      ),
    );
    fs.writeFileSync(
      path.join(root, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ ...report, evidence: root }));
  });
