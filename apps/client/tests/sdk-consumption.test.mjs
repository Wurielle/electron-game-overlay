import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
