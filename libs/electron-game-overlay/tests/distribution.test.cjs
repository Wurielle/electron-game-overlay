const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the built SDK does not retain removed hudhook implementation modules', () => {
  const files = readdirSync(path.resolve(__dirname, '..', 'dist', 'lib'));

  assert.ok(files.includes('overlay-loopback-transport.js'));
  assert.ok(files.includes('overlay-loopback-transport.d.ts'));
  assert.ok(files.includes('diagnostic.js'));
  assert.ok(files.includes('diagnostic.d.ts'));
  assert.deepEqual(
    files.filter((file) => /^hudhook-(?:launcher|transport)\./.test(file)),
    [],
  );
});

test('the package declarations export the typed session diagnostic contract', () => {
  const declarations = readFileSync(
    path.resolve(__dirname, '..', 'dist', 'lib', 'sdk.d.ts'),
    'utf8',
  );

  assert.match(declarations, /OverlayDiagnostic,/);
  assert.match(declarations, /OverlayDiagnosticCode,/);
  assert.match(declarations, /OverlayDiagnosticSeverity,/);
  assert.match(declarations, /OverlayDiagnosticSource,/);
});

test('the package root exports the typed ReShade diagnostic contract', () => {
  const sdk = require('../dist/index.js');
  const error = new sdk.ReShadeOperationError({
    message: 'synthetic conflict',
    code: 'target-runtime-conflict',
    stage: 'target-preflight',
    retrySafety: 'definite-safe',
    targetLabel: 'process:game.exe:pid:42',
    pid: 42,
  });

  assert.equal(typeof sdk.isReShadeOperationError, 'function');
  assert.equal(sdk.isReShadeOperationError(error), true);
  assert.equal(error.code, 'target-runtime-conflict');
  assert.equal(error.diagnostic.schemaVersion, 1);
  assert.equal(error.diagnostic.source, 'electron-game-overlay');
  assert.equal(Object.isFrozen(error.diagnostic), true);
});
