import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMOS = Object.freeze([
  'basic-window',
  'exact-process-attachment',
  'input-interception',
  'multiple-windows',
  'target-follow-and-telemetry',
  'steam-auto-attach',
]);
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDirectory, '..', '..');
const runner = path.join(scriptsDirectory, 'run-demo.mjs');
const smokeBrokerPipe = `\\\\.\\pipe\\electron-game-overlay-demo-smoke-${process.pid}-${randomUUID().replaceAll('-', '')}`;
let activeChild = null;
let interrupted = false;

const interrupt = (signal) => {
  if (interrupted) return;
  interrupted = true;
  terminateProcessTree(activeChild);
  process.exit(signal === 'SIGINT' ? 130 : 143);
};
process.once('SIGINT', () => interrupt('SIGINT'));
process.once('SIGTERM', () => interrupt('SIGTERM'));
process.once('exit', () => terminateProcessTree(activeChild));

for (const demo of DEMOS) {
  await smokeDemo(demo);
}
console.log(`[demo-smoke] pass count=${DEMOS.length}`);

async function smokeDemo(demo) {
  const impossibleTarget =
    `codex-demo-smoke-${randomUUID()}`.replaceAll('-', '') + '.exe';
  const child = spawn(process.execPath, [runner, demo], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ELECTRON_GAME_OVERLAY_BROKER_PIPE: smokeBrokerPipe,
      ELECTRON_GAME_OVERLAY_DEMO_SMOKE: '1',
      ELECTRON_GAME_OVERLAY_DEMO_TARGET_PROCESS: impossibleTarget,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeChild = child;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });

  const result = await waitForChild(child, 45_000);
  if (activeChild === child) activeChild = null;
  const marker = `[demo-smoke] ready demo=${demo}`;
  if (result.timedOut) {
    throw new Error(`Demo smoke timed out: ${demo}`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Demo smoke exited with ${result.status}: ${demo}`);
  }
  if (!output.includes(marker)) {
    throw new Error(`Demo smoke did not publish its ready marker: ${demo}`);
  }
  const runtimeFailure = [
    'Uncaught Exception',
    'UnhandledPromiseRejection',
    'Object has been destroyed',
    'renderer failed to load',
    'renderer bundle did not publish',
    'renderer console error',
    'preload failed',
    'renderer exited unexpectedly',
  ].find((failure) => output.includes(failure));
  if (runtimeFailure) {
    throw new Error(`Demo smoke reported ${runtimeFailure}: ${demo}`);
  }
}

function waitForChild(child, timeoutMilliseconds) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish({ status: null, timedOut: true });
    }, timeoutMilliseconds);
    child.once('error', (error) => finish({ error, status: null }));
    child.once('close', (status) => finish({ status, timedOut: false }));
  });
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    if (result.status !== 0) terminateWindowsDescendants(child.pid);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

function terminateWindowsDescendants(rootPid) {
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
    $rootPid = [uint32]$env:ELECTRON_GAME_OVERLAY_DEMO_ROOT_PID
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $descendants = [System.Collections.Generic.HashSet[uint32]]::new()
    $pending = [System.Collections.Generic.Queue[uint32]]::new()
    $pending.Enqueue($rootPid)
    while ($pending.Count -gt 0) {
      $parentPid = $pending.Dequeue()
      foreach ($process in $processes) {
        $processId = [uint32]$process.ProcessId
        if ([uint32]$process.ParentProcessId -eq $parentPid -and $descendants.Add($processId)) {
          $pending.Enqueue($processId)
        }
      }
    }
    foreach ($processId in $descendants) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  `,
    ],
    {
      env: {
        ...process.env,
        ELECTRON_GAME_OVERLAY_DEMO_ROOT_PID: String(rootPid),
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
}
