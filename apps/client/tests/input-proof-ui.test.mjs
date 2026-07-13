import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(testDirectory, '..');

function readClientFile(...segments) {
  return readFileSync(path.join(clientRoot, ...segments), 'utf8');
}

test('the real client arms and forwards the main overlay input proof', () => {
  const windowSource = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const mainOverlay = readClientFile(
    'public',
    'index',
    'example-main-overlay.html',
  );

  assert.match(windowSource, /once\(['"]did-finish-load['"]/);
  assert.match(windowSource, /proof\.enable\(\)/);
  assert.match(windowSource, /HUDHOOK_CLIENT_INPUT_PROOF_ARMED/);
  assert.match(windowSource, /startsWith\(HUDHOOK_CLIENT_INPUT_MARKER\)/);
  assert.match(mainOverlay, /HUDHOOK_CLIENT_INPUT_PROOF_READY/);
  assert.match(mainOverlay, /HUDHOOK_CLIENT_INPUT_DIAGNOSTIC/);
});

test('the status overlay exposes and forwards visible input diagnostics', () => {
  const windowSource = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const statusOverlay = readClientFile(
    'public',
    'index',
    'example-status-overlay.html',
  );

  assert.match(windowSource, /forwardHudhookInputDiagnostics\(window\)/);
  assert.match(statusOverlay, /id="hudhook-status-input-diagnostic"/);
  assert.match(statusOverlay, /HUDHOOK_CLIENT_STATUS_INPUT_DIAGNOSTIC/);
});

test('the Gun Frog client proof publishes four aligned Electron controls and readiness markers', () => {
  const appEntry = readClientFile('src', 'main', 'electron', 'app-entry.ts');
  const windowSource = readClientFile(
    'src',
    'main',
    'electron',
    'example-overlay-windows.ts',
  );
  const mainOverlay = readClientFile(
    'public',
    'index',
    'example-main-overlay.html',
  );

  assert.match(windowSource, /gunFrogInputProof \? 64 : 1/);
  assert.match(windowSource, /gunFrogInputProof \? 270 : 1/);
  assert.match(windowSource, /HUDHOOK_GUN_FROG_BUTTONS_READY/);
  assert.match(appEntry, /HUDHOOK_CLIENT_GUN_FROG_PROOF_READY/);
  assert.match(appEntry, /HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK/);

  for (const [name, top] of [
    ['continue', 80],
    ['new-game', 154],
    ['settings', 227],
    ['quit', 301],
  ]) {
    assert.match(
      mainOverlay,
      new RegExp(`name:\\s*['"]${name}['"][\\s\\S]{0,200}?top:\\s*${top}`),
    );
  }
  assert.match(mainOverlay, /left: 36/);
  assert.match(mainOverlay, /width: 335px/);
  assert.match(mainOverlay, /height: 56px/);
  assert.match(
    mainOverlay,
    /HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=back event=gun-frog-click/,
  );
});
