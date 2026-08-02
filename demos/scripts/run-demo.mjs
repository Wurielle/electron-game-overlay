import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
const demoName = process.argv[2];
const demoArguments = process.argv.slice(3);

if (!DEMO_NAME_IS_VALID(demoName)) {
  console.error(
    'Usage: node demos/scripts/run-demo.mjs <demo> [demo arguments]',
  );
  console.error(`Available demos: ${DEMOS.join(', ')}`);
  process.exitCode = 1;
} else {
  runOrExit(
    npmCommand(),
    ['exec', '--', 'nx', 'run', 'electron-game-overlay:build'],
    process.env,
  );

  runOrExit(
    viteCommand(),
    ['build', '--config', path.join('demos', 'vite.config.mts')],
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
  runOrExit(
    electronExecutable,
    [mainEntry, '--reshade-overlay', ...demoArguments],
    process.env,
  );
}

function DEMO_NAME_IS_VALID(value) {
  return typeof value === 'string' && DEMOS.includes(value);
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function viteCommand() {
  return path.join(
    workspaceRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite.cmd' : 'vite',
  );
}

function runOrExit(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
