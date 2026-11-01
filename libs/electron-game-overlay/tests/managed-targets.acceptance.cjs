// Controlled Windows integration: no desktop input and no unrelated process termination.
const { app } = require('electron'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { spawn } = require('node:child_process');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const n = a.indexOf('=');
      return [a.slice(2, n), a.slice(n + 1)];
    }),
);
const root = path.resolve(args.evidence);
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const {
  ElectronGameOverlay,
  OverlayTargetWatcher,
  createReShadeLaunchConfig,
} = require(args.sdk || '../dist');
let owner, session, watcher;
const children = [],
  events = [],
  diagnostics = [];
const report = { status: 'failed', nativeExecuted: true, events, checks: [] };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, label, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(40);
  }
  throw Error('Timed out: ' + label);
}
function cleanup() {
  watcher?.dispose();
  session?.close();
  owner?.dispose();
  for (const c of children) if (c.exitCode === null) c.kill();
}
app.on('before-quit', cleanup);
void app
  .whenReady()
  .then(async () => {
    const targetDir = path.join(root, 'target');
    fs.mkdirSync(targetDir);
    const target = path.join(targetDir, 'managed-native-host.exe');
    fs.copyFileSync(args.host, target);
    const barrier = path.join(
      targetDir,
      'electron-game-overlay-startup-barrier.enabled',
    );
    fs.writeFileSync(barrier, 'owned controlled test');
    const start = () => {
      const child = spawn(target, [], {
        cwd: targetDir,
        windowsHide: true,
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    };
    const baseline = start();
    await delay(200);
    owner = new ElectronGameOverlay({ allowPrereleaseBroker: true });
    session = owner.createSession();
    session.on('diagnostic', (d) => diagnostics.push(d));
    session.start();
    const panel = session.windows.create({
      id: 'managed-native-test',
      bounds: { x: 20, y: 60, width: 300, height: 160 },
    });
    await panel.browserWindow.loadURL(
      'data:text/html,<body style="background:purple;color:white">Managed target acceptance</body>',
    );
    panel.show();
    const config = createReShadeLaunchConfig({
      runsRootDirectory: path.join(root, 'runs'),
    });
    watcher = new OverlayTargetWatcher(session, {
      config,
      ...(args.mode === 'best-effort'
        ? {
            acceptBestEffort: (i) =>
              i.executablePath.toLowerCase() === target.toLowerCase(),
          }
        : {
            earlyTargets: [
              { processName: path.basename(target), executablePath: target },
            ],
            acceptBestEffort: () => {
              throw Error('Early discovery must never use exact-PID fallback');
            },
          }),
      onEvent: (e) => {
        events.push({
          type: e.type,
          ...(e.target
            ? {
                pid: e.target.pid,
                status: e.target.status,
                identity: e.target.identity,
              }
            : {}),
          ...(e.error ? { error: e.error.message } : {}),
        });
      },
    });
    await watcher.ready;
    report.checks.push(
      args.mode === 'best-effort'
        ? 'explicit observer readiness; post-creation exact-PID attachment'
        : 'explicit readiness after observer baseline and native prearming',
    );
    assert.equal(
      events.some((e) => e.pid === baseline.pid),
      false,
    );
    for (let n = 0; n < 2; n++) {
      const child = start();
      // The graphics host deliberately blocks before initialization until this
      // owned injector has completed. This is not a real-game timing guarantee.
      fs.writeFileSync(
        path.join(root, 'progress.json'),
        JSON.stringify({ targetPid: child.pid }),
      );
      await until(
        () => !fs.existsSync(barrier),
        'mapped runtime and successful owned injector',
      );
      fs.rmSync(barrier, { force: true });
      await until(
        () => events.some((e) => e.type === 'connected' && e.pid === child.pid),
        'managed authenticated target',
      );
      await until(
        () =>
          diagnostics.some(
            (d) =>
              d.code === 'runtime-scene-rendering-started' &&
              d.pid === child.pid,
          ),
        'native composited scene',
      );
      assert.equal(
        events.some((e) => e.pid === baseline.pid),
        false,
      );
      const managed = watcher.targets.find((t) => t.pid === child.pid);
      assert.ok(managed);
      assert.equal(
        managed.mode,
        args.mode === 'best-effort' ? 'best-effort' : 'early',
      );
      await until(
        () =>
          watcher.targets.find((t) => t.pid === child.pid)?.identity
            ?.creationTime100ns,
        'authoritative process observer identity',
      );
      report.checks.push(
        'fresh target ' +
          (n + 1) +
          ': exact-path authenticated native scene and authoritative creation identity',
      );
      const armed = events.filter((e) => e.type === 'armed').length;
      child.kill();
      await until(
        () => events.some((e) => e.type === 'exited' && e.pid === child.pid),
        'authoritative exit',
      );
      if (args.mode !== 'best-effort')
        await until(
          () => events.filter((e) => e.type === 'armed').length > armed,
          'fresh native rearm',
        );
      fs.writeFileSync(barrier, 'next owned target');
    }
    await watcher.cancel();
    report.checks.push(
      'cancelled watcher policy after authoritative exit and rearm',
    );
    assert.equal(
      events.some((e) => e.pid === baseline.pid),
      false,
    );
    assert.equal(baseline.exitCode, null);
    report.checks.push('already-running baseline process excluded throughout');
    assert.equal(
      events.some((e) => e.type === 'error'),
      false,
      JSON.stringify(events.filter((e) => e.type === 'error')),
    );
    report.status = 'passed';
    report.electron = process.versions.electron;
  })
  .catch((e) => {
    report.error = e.stack;
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    fs.writeFileSync(
      path.join(root, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.status === 'passed' ? 0 : 1);
  });
