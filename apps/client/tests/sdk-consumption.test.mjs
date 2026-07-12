import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildElectronDevArguments,
  hudhookDevBackend,
} from '../src/main/dev-launch.ts';

const require = createRequire(import.meta.url);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(testDirectory, '..');
const sdk = require('electron-game-overlay');

test('the built demo consumes the SDK instead of bundling a client launcher', () => {
  const mainBundle = readFileSync(
    path.join(clientRoot, 'dist', 'main', 'main.js'),
    'utf8',
  );

  assert.match(mainBundle, /require\(["']electron-game-overlay["']\)/);
  assert.equal(typeof sdk.HudhookOverlayLauncher, 'function');
  assert.equal(typeof sdk.parseHudhookLaunchConfig, 'function');
  assert.equal(typeof sdk.OverlaySession.prototype.whenReady, 'function');
});

test('the built demo gives Ctrl+I to one global shortcut owner', () => {
  const mainBundle = readFileSync(
    path.join(clientRoot, 'dist', 'main', 'main.js'),
    'utf8',
  );
  const rendererBundle = readFileSync(
    path.join(clientRoot, 'dist', 'renderer', 'renderer.js'),
    'utf8',
  );

  assert.match(mainBundle, /CommandOrControl\+I/);
  assert.doesNotMatch(mainBundle, /overlay\.hotkey\.toggleInputIntercept/);
  assert.match(mainBundle, /overlay:state-changed/);
  assert.match(rendererBundle, /overlay:state-changed/);
});

test('the SDK resolves the runtime used by the demo', () => {
  const config = sdk.parseHudhookLaunchConfig([
    'electron.exe',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
  ]);

  assert.ok(config);
  assert.equal(config.runtimeDirectory, sdk.defaultHudhookRuntimeDirectory());
  assert.equal(
    path.basename(config.injectorPath),
    'hudhook_overlay_injector.exe',
  );
  assert.equal(
    path.basename(config.payloadPath),
    'hudhook_imgui_overlay_dx11.dll',
  );
});

test('dev launch configures D3D11 by default and supports D3D12 explicitly', () => {
  assert.equal(hudhookDevBackend('development'), 'd3d11');
  assert.equal(hudhookDevBackend('hudhook-d3d11'), 'd3d11');
  assert.equal(hudhookDevBackend('hudhook-d3d12'), 'd3d12');
  assert.deepEqual(buildElectronDevArguments('C:\\repo', 'development'), [
    'C:\\repo',
    '--no-sandbox',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
  ]);
  assert.deepEqual(buildElectronDevArguments('C:\\repo', 'hudhook-d3d12'), [
    'C:\\repo',
    '--no-sandbox',
    '--hudhook-overlay',
    '--hudhook-backend=d3d12',
  ]);
});
