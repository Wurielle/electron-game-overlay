const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');

const read = (...segments) => readFileSync(path.join(...segments), 'utf8');

test('the root README names every package-root SDK export', () => {
  const sdkSource = read(packageRoot, 'src', 'lib', 'sdk.ts');
  const readme = read(workspaceRoot, 'README.md');
  const exportedNames = Array.from(
    sdkSource.matchAll(/export(?:\s+type)?\s*\{([\s\S]*?)\}\s*from/g),
    (match) => match[1],
  )
    .flatMap((block) => block.split(','))
    .map((entry) =>
      entry
        .trim()
        .split(/\s+as\s+/)
        .at(-1),
    )
    .filter(Boolean)
    .sort();

  assert.ok(exportedNames.length > 0, 'expected package-root exports');
  const missing = exportedNames.filter(
    (name) => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(readme),
  );
  assert.deepEqual(missing, []);
});

test('emitted declarations expose the typed consumer API only', () => {
  const sdk = read(packageRoot, 'dist', 'lib', 'sdk.d.ts');
  const session = read(packageRoot, 'dist', 'lib', 'overlay-session.d.ts');
  const window = read(
    packageRoot,
    'dist',
    'lib',
    'electron-overlay-window.d.ts',
  );
  const launcher = read(packageRoot, 'dist', 'lib', 'reshade-launcher.d.ts');
  const types = read(packageRoot, 'dist', 'lib', 'types.d.ts');

  assert.doesNotMatch(sdk, /\bbuildReShadeInvocation\b/);
  assert.doesNotMatch(sdk, /\bReShadeInvocation\b/);
  assert.doesNotMatch(sdk, /\bElectronOverlayWindowOptions\b/);

  assert.match(session, /private constructor\(\);/);
  assert.doesNotMatch(session, /\bauthorizeTarget\s*\(/);
  assert.match(window, /private constructor\(\);/);

  assert.match(launcher, /attach\(session: OverlaySession,/);
  assert.doesNotMatch(launcher, /\bacceptTargetConnection\s*\(/);
  assert.doesNotMatch(launcher, /\blaunch\s*\(/);

  for (const eventName of [
    'targetConnected',
    'targetTransportLost',
    'targetDisconnected',
    'inputInterceptionChanged',
    'windowFocused',
  ]) {
    assert.match(types, new RegExp(`\\b${eventName}\\b`));
  }
  assert.doesNotMatch(types, /\bnativeEvent\b/);
  assert.doesNotMatch(types, /\bany\b/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
