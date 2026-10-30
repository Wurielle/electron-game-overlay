import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
const require = createRequire(import.meta.url);
const demoName = process.argv[2];
const demoArguments = withDefaultTarget(demoName, process.argv.slice(3));

if (!DEMO_NAME_IS_VALID(demoName)) {
  console.error(
    'Usage: node demos/scripts/run-demo.mjs <demo> [demo arguments]',
  );
  console.error(`Available demos: ${DEMOS.join(', ')}`);
  process.exitCode = 1;
} else {
  prepareSdk();

  runOrExit(
    process.execPath,
    [
      packageBinary('vite', 'vite'),
      'build',
      '--config',
      path.join('demos', 'vite.config.mts'),
    ],
    {
      ...process.env,
      ELECTRON_GAME_OVERLAY_DEMO: demoName,
    },
  );

  const electronExecutable = path.join(
    workspaceRoot,
    'node_modules',
    'electron',
    'dist',
    'electron.exe',
  );
  const mainEntry = path.join(
    workspaceRoot,
    'demos',
    'dist',
    demoName,
    'main',
    'main.js',
  );
  await runElectronOrExit(
    electronExecutable,
    [mainEntry, '--reshade-overlay', ...demoArguments],
    {
      ...process.env,
      ELECTRON_GAME_OVERLAY_DEMO: demoName,
    },
  );
}

function prepareSdk() {
  const missingRuntimeFiles = missingStagedRuntimeFiles();
  if (missingRuntimeFiles.length > 0) {
    throw new Error(
      [
        'The SDK native runtime has not been prepared.',
        `Missing: ${missingRuntimeFiles.join(', ')}`,
        'Run "npm run demo:prepare" once, then launch this demo again.',
      ].join('\n'),
    );
  }

  runOrExit(
    process.execPath,
    [
      packageBinary('typescript', 'tsc'),
      '--build',
      '--force',
      path.join(
        workspaceRoot,
        'libs',
        'electron-game-overlay',
        'tsconfig.lib.json',
      ),
    ],
    process.env,
  );
}

function missingStagedRuntimeFiles() {
  const runtimeDirectory = path.join(
    workspaceRoot,
    'libs',
    'electron-game-overlay',
    'dist',
    'runtime',
    'win32-x64',
    'reshade',
  );
  return [
    'electron_game_overlay.addon32',
    'electron_game_overlay.addon64',
    'electron_game_overlay_reshade_manager.exe',
    'electron_game_overlay_reshade_manager32.exe',
    'electron_game_overlay_runtime.build.json',
    'electron_game_overlay_runtime32.build.json',
    'inject.exe',
    'inject32.exe',
    'ReShade.ini',
    'ReShade32.build.json',
    'ReShade32.dll',
    'ReShade64.build.json',
    'ReShade64.dll',
  ].filter((fileName) => !existsSync(path.join(runtimeDirectory, fileName)));
}

function packageBinary(packageName, binaryName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const binaryPath =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binaryName];
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new Error(
      `Package ${packageName} does not expose the ${binaryName} executable.`,
    );
  }
  return path.resolve(path.dirname(packageJsonPath), binaryPath);
}

function withDefaultTarget(name, arguments_) {
  if (
    name === 'steam-auto-attach' ||
    arguments_.some(
      (argument) =>
        argument === '--target-process' ||
        argument.startsWith('--target-process='),
    )
  ) {
    return arguments_;
  }

  const processName =
    process.env.ELECTRON_GAME_OVERLAY_DEMO_TARGET_PROCESS?.trim() ||
    'Gun Frog.exe';
  console.log(
    `[demo] No target was supplied; waiting for ${JSON.stringify(processName)}.`,
  );
  return [...arguments_, `--target-process=${processName}`];
}

function DEMO_NAME_IS_VALID(value) {
  return typeof value === 'string' && DEMOS.includes(value);
}

function runOrExit(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
  exitForFailedResult(result);
}

async function runElectronOrExit(command, arguments_, environment) {
  const userDataDirectory = mkdtempSync(
    path.join(tmpdir(), 'electron-game-overlay-demo-'),
  );
  const child = spawn(
    command,
    [`--user-data-dir=${userDataDirectory}`, ...arguments_],
    {
      cwd: workspaceRoot,
      env: environment,
      stdio: 'inherit',
      windowsHide: false,
    },
  );
  let interruptedSignal;
  const terminateForSignal = (signal) => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    terminateProcessTree(child, signal);
  };
  const onSigint = () => terminateForSignal('SIGINT');
  const onSigterm = () => terminateForSignal('SIGTERM');
  const onParentExit = () => {
    terminateProcessTree(child, 'SIGTERM');
    terminateRemainingWindowsProcesses(child.pid, userDataDirectory);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', onParentExit);

  let result;
  try {
    result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error, status: null }));
      child.once('exit', (status) => resolve({ status }));
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('exit', onParentExit);
  }

  if (result.status !== 0 || interruptedSignal) {
    terminateRemainingWindowsProcesses(child.pid, userDataDirectory);
  }

  try {
    rmSync(userDataDirectory, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(
      `[demo] Could not remove temporary Electron profile ${userDataDirectory}:`,
      error,
    );
  }
  if (interruptedSignal) {
    process.exit(interruptedSignal === 'SIGINT' ? 130 : 143);
  }
  exitForFailedResult(result);
}

function terminateProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    if (result.status !== 0) child.kill();
    return;
  }
  child.kill(signal);
}

function terminateRemainingWindowsProcesses(rootPid, userDataDirectory) {
  if (process.platform !== 'win32' || !rootPid) return;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
        $rootPid = [uint32]$env:ELECTRON_GAME_OVERLAY_DEMO_ROOT_PID
        $profile = $env:ELECTRON_GAME_OVERLAY_DEMO_PROFILE
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
        foreach ($process in $processes) {
          if ($process.CommandLine -and $process.CommandLine.IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            [void]$descendants.Add([uint32]$process.ProcessId)
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
        ELECTRON_GAME_OVERLAY_DEMO_PROFILE: userDataDirectory,
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    console.warn('[demo] Could not verify cleanup of Electron descendants.');
  }
}

function exitForFailedResult(result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
