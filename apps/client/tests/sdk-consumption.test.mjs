import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildElectronDevArguments } from '../src/main/dev-launch.ts';

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
  assert.equal(typeof sdk.ReShadeOverlayLauncher, 'function');
  assert.equal(typeof sdk.parseReShadeLaunchConfig, 'function');
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

test('the SDK resolves the ReShade runtime used by the demo', () => {
  const config = sdk.parseReShadeLaunchConfig([
    'electron.exe',
    '--reshade-overlay',
  ]);

  assert.ok(config);
  assert.ok(path.isAbsolute(config.runtimeDirectory));
  assert.equal(path.basename(config.injectorPath), 'inject.exe');
  assert.equal(path.basename(config.runtimePath), 'ReShade64.dll');
  assert.equal(
    path.basename(config.addonPath),
    'electron_game_overlay.addon64',
  );
});

test('dev launch enables ReShade without selecting a graphics backend', () => {
  assert.deepEqual(buildElectronDevArguments('C:\\repo', 'development'), [
    'C:\\repo',
    '--no-sandbox',
    '--reshade-overlay',
  ]);
  assert.deepEqual(buildElectronDevArguments('C:\\repo', 'gun-frog'), [
    'C:\\repo',
    '--no-sandbox',
    '--reshade-overlay',
    '--reshade-auto-target-process=Gun Frog.exe',
    '--start-overlay-session',
    '--gun-frog-input-proof',
  ]);
});
