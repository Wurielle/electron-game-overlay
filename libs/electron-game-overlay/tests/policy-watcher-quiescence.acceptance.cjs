// Native read-only watcher stop acceptance; no target is created or injected.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const reportPath = path.resolve(
  process.argv[2] || 'build/policy-watcher-quiescence.json',
);
const repo = path.resolve(__dirname, '../../..');
const root = path.join(
  path.dirname(reportPath),
  'owned-quiescence-' + randomUUID(),
);
const report = {
  status: 'failed',
  nativeExecuted: false,
  targetCreated: false,
  injectionExecuted: false,
  checks: [],
};
fs.mkdirSync(root, { recursive: true });
const children = new Set();
let launcher;
const originalExecFile = cp.execFile;
const deadline = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label + ' timed out')), 8000);
    }),
  ]).finally(() => clearTimeout(timer));
};
(async () => {
  assert.equal(process.platform, 'win32');
  const nativeSource = fs.readFileSync(
    path.join(
      repo,
      'build/electron-game-overlay-runtime/_deps/reshade-src/tools/injector.cpp',
    ),
    'utf8',
  );
  const main = nativeSource.slice(nativeSource.indexOf('int wmain('));
  const marker = main.indexOf('L"EGO_TARGET_SELECTED_V2\\t"');
  assert.ok(marker > 0);
  assert.match(main.slice(marker, marker + 250), /return ERROR_WRITE_FAULT/);
  for (const operation of [
    'acquire_injection_claim(pid',
    'inspect_target_for_reshade(',
    'VirtualAllocEx(remote_process',
  ])
    assert.ok(main.indexOf(operation) > marker, operation);
  assert.match(
    nativeSource,
    /fwrite\(encoded\.data\(\), 1, encoded\.size\(\), stdout\) != encoded\.size\(\)/,
  );
  assert.match(nativeSource, /return fflush\(stdout\) == 0/);
  report.checks.push(
    'checked and flushed V2 selection precedes claim/preflight/target-memory mutation in pinned native source',
  );
  let sdkOutput = '',
    sdkChild;
  cp.execFile = (...args) => {
    const child = originalExecFile(...args);
    children.add(child);
    sdkChild = child;
    child.stdout?.on('data', (data) => {
      sdkOutput += data;
    });
    return child;
  };
  const {
    ReShadeOverlayLauncher,
    createReShadeLaunchConfig,
    launchReShadeOverlay,
  } = require('../dist/lib/reshade-launcher.js');
  const config = createReShadeLaunchConfig({
    bundledRuntimeDirectory: path.join(
      repo,
      'libs/electron-game-overlay/dist/runtime/win32-x64/reshade',
    ),
    runsRootDirectory: path.join(root, 'runs'),
  });
  launcher = new ReShadeOverlayLauncher(config);
  let armedResolve;
  const armed = new Promise((resolve) => {
    armedResolve = resolve;
  });
  launcher.onEvent((event) => {
    if (event.type === 'injector-watcher-ready') armedResolve();
  });
  const neverTarget = path
    .join(root, 'never-created-target')
    .replace(/\\/g, '/');
  const operation = launchReShadeOverlay(launcher, {
    pathContains: neverTarget,
    processPolicy: { allow: [neverTarget + '/**'] },
  }).catch((error) => {
    report.sdkStopError = error.message;
  });
  await deadline(armed, 'SDK native watcher armed');
  report.nativeExecuted = true;
  assert.equal(await launcher.quiesceUnselectedPolicyWatcher(), true);
  await deadline(operation, 'SDK stop settled');
  assert.equal(sdkChild.stdout.readableEnded, true);
  assert.ok(sdkChild.exitCode !== null || sdkChild.signalCode !== null);
  assert.equal(sdkOutput.includes('EGO_TARGET_SELECTED'), false);
  assert.match(sdkOutput, /EGO_POLICY_BASELINE_V1/);
  report.sdk = {
    pid: sdkChild.pid,
    drained: true,
    stdout: sdkOutput,
    exited: true,
  };
  report.checks.push(
    'actual SDK x64 policy watcher stops with authoritative child exit and fully drained unused output',
  );
  const runtime = config.runtimeDirectory,
    policyFile = path.join(root, 'policy.txt');
  const {
    serializeOverlayProcessPolicy,
  } = require('../dist/lib/process-policy.js');
  fs.writeFileSync(
    policyFile,
    serializeOverlayProcessPolicy({ allow: [neverTarget + '/**'] }),
  );
  for (const arch of ['x64', 'x86']) {
    const exe = path.join(
      runtime,
      arch === 'x64' ? 'inject.exe' : 'inject32.exe',
    );
    const child = cp.spawn(
      exe,
      ['--path-contains', neverTarget, '--policy-file', policyFile],
      { cwd: runtime, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.add(child);
    let stdout = '',
      stderr = '',
      armedResolve,
      exitResolve;
    const ready = new Promise((resolve) => {
        armedResolve = resolve;
      }),
      exit = new Promise((resolve) => {
        exitResolve = resolve;
      });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ReShade path watcher armed.')) armedResolve();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const observation = {
      pid: child.pid,
      executable: exe,
      stdout: '',
      stderr: '',
      exitCode: null,
    };
    report[arch] = observation;
    child.stdout.on('data', (chunk) => {
      observation.stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      observation.stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      observation.error = error.message;
    });
    child.once('close', () => {
      observation.exitCode = child.exitCode;
      exitResolve();
      if (!stdout.includes('ReShade path watcher armed.')) armedResolve();
    });
    await deadline(ready, arch + ' CLI armed');
    assert.match(
      stdout,
      /ReShade path watcher armed\./,
      JSON.stringify(observation),
    );
    assert.equal(child.kill(), true);
    await deadline(exit, arch + ' CLI drained exit');
    assert.equal(child.stdout.readableEnded, true);
    assert.equal(stdout.includes('EGO_TARGET_SELECTED'), false);
    assert.equal(stdout.includes('Succeeded!'), false);
    report[arch] = {
      pid: child.pid,
      sha256: createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),
      stdout,
      stderr,
      exited: true,
      drained: true,
    };
    report.checks.push(
      'actual ' +
        arch +
        ' native watcher drains unused output after owned cancellation',
    );
  }
  report.status = 'passed';
})()
  .catch((error) => {
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(async () => {
    cp.execFile = originalExecFile;
    launcher?.dispose();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  });
