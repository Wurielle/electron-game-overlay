const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createReShadeOperationError,
} = require('../dist/lib/reshade-launcher.js');

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

test('the package surface omits removed pre-release compatibility APIs', () => {
  const sdk = require('../dist/index.js');
  const declarations = readFileSync(
    path.resolve(__dirname, '..', 'dist', 'lib', 'sdk.d.ts'),
    'utf8',
  );

  assert.equal('findWindows' in sdk.ElectronGameOverlay.prototype, false);
  assert.equal('attachToProcess' in sdk.OverlaySession.prototype, false);
  assert.equal('setHotkeys' in sdk.OverlaySession.prototype, false);
  assert.equal('buildReShadeInvocation' in sdk, false);
  for (const removedType of [
    'ElectronOverlayWindowOptions',
    'OverlayHotkey',
    'OverlayProcessAttachResult',
    'OverlayProcessTarget',
    'ReShadeInvocation',
  ]) {
    assert.doesNotMatch(declarations, new RegExp(`\\b${removedType}\\b`));
  }
});

test('consumer declarations hide factories and low-level attachment plumbing', () => {
  const sessionDeclarations = readFileSync(
    path.resolve(__dirname, '..', 'dist', 'lib', 'overlay-session.d.ts'),
    'utf8',
  );
  const windowDeclarations = readFileSync(
    path.resolve(
      __dirname,
      '..',
      'dist',
      'lib',
      'electron-overlay-window.d.ts',
    ),
    'utf8',
  );
  const launcherDeclarations = readFileSync(
    path.resolve(__dirname, '..', 'dist', 'lib', 'reshade-launcher.d.ts'),
    'utf8',
  );

  assert.match(sessionDeclarations, /private constructor/);
  assert.doesNotMatch(sessionDeclarations, /static create/);
  assert.doesNotMatch(sessionDeclarations, /authorizeTarget/);
  assert.doesNotMatch(sessionDeclarations, /createOverlaySession/);
  assert.doesNotMatch(sessionDeclarations, /authorizeOverlaySessionTarget/);
  assert.match(windowDeclarations, /private constructor/);
  assert.doesNotMatch(windowDeclarations, /static create/);
  assert.doesNotMatch(windowDeclarations, /OverlayWindowBridge/);
  assert.doesNotMatch(windowDeclarations, /createElectronOverlayWindow/);
  assert.doesNotMatch(launcherDeclarations, /\n\s+launch\(/);
  assert.doesNotMatch(launcherDeclarations, /acceptTargetConnection/);
  assert.match(
    launcherDeclarations,
    /class ReShadeOperationError[\s\S]{0,500}?private constructor/,
  );
  assert.doesNotMatch(launcherDeclarations, /static create/);
  assert.doesNotMatch(launcherDeclarations, /createReShadeOperationError/);
  assert.doesNotMatch(launcherDeclarations, /launchReShadeOverlay/);
  assert.doesNotMatch(launcherDeclarations, /acceptReShadeTargetConnection/);
  assert.match(
    launcherDeclarations,
    /attach\(session: OverlaySession, target: ReShadeTarget\)/,
  );
});

test('the package root runtime surface enforces declaration-hidden boundaries', () => {
  const sdk = require('../dist/index.js');

  assert.equal('create' in sdk.OverlaySession, false);
  assert.equal('authorizeTarget' in sdk.OverlaySession.prototype, false);
  assert.throws(
    () => Reflect.construct(sdk.OverlaySession, [{}]),
    /created by ElectronGameOverlay\.createSession/,
  );

  assert.equal('create' in sdk.ElectronOverlayWindow, false);
  assert.throws(
    () => Reflect.construct(sdk.ElectronOverlayWindow, []),
    /created by OverlaySession\.windows/,
  );

  assert.equal('create' in sdk.ReShadeOperationError, false);
  assert.throws(
    () =>
      Reflect.construct(sdk.ReShadeOperationError, [
        {
          message: 'consumer-forged error',
        },
      ]),
    /created by ReShade overlay operations/,
  );

  const config = Object.freeze({ runtimeDirectory: 'C:\\runtime' });
  const launcher = new sdk.ReShadeOverlayLauncher(config);
  assert.equal(launcher.config, config);
  assert.equal('launch' in launcher, false);
  assert.equal('acceptTargetConnection' in launcher, false);
  assert.equal('requestLaunch' in launcher, false);
  launcher.dispose();

  for (const internalExport of [
    'createOverlaySession',
    'authorizeOverlaySessionTarget',
    'createElectronOverlayWindow',
    'createReShadeOperationError',
    'launchReShadeOverlay',
    'acceptReShadeTargetConnection',
  ]) {
    assert.equal(internalExport in sdk, false);
  }
});

test('session declarations expose only validated typed lifecycle events', () => {
  const declarations = readFileSync(
    path.resolve(__dirname, '..', 'dist', 'lib', 'types.d.ts'),
    'utf8',
  );

  for (const event of [
    'targetConnected',
    'targetTransportLost',
    'targetDisconnected',
    'inputInterceptionChanged',
    'windowFocused',
  ]) {
    assert.match(declarations, new RegExp(`\\b${event}\\b`));
  }
  assert.doesNotMatch(declarations, /nativeEvent/);
  assert.doesNotMatch(declarations, /payload:\s*any/);
  assert.match(
    declarations,
    /windowFocused:[\s\S]{0,100}?pid: number;[\s\S]{0,100}?windowId: number;/,
  );
});

test('the package root exports the typed ReShade diagnostic contract', () => {
  const sdk = require('../dist/index.js');
  const declarations = readFileSync(
    path.resolve(__dirname, '..', 'dist', 'lib', 'sdk.d.ts'),
    'utf8',
  );
  const error = createReShadeOperationError({
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
  assert.match(declarations, /ReShadeLauncherEvent,/);
  assert.match(declarations, /ReShadeLauncherEventHandler,/);
  assert.equal('RESHADE_CLIENT_INJECTOR_STARTED_MARKER' in sdk, false);
  assert.equal('RESHADE_CLIENT_INJECTOR_FAILED_MARKER' in sdk, false);
});
