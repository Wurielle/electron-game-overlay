const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimeScripts = path.resolve(__dirname, '../../libs/electron-game-overlay-runtime/scripts');
const helper = path.join(runtimeScripts, 'owned-stage-marker.ps1');
const markerName = '.electron-game-overlay-run.json';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-owned-stage-marker-'));
  const buildRoot = path.join(directory, 'build');
  const stage = path.join(buildRoot, 'native stage');
  fs.mkdirSync(stage, { recursive: true });
  t.after(() => {
    const resolvedDirectory = path.resolve(directory);
    assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedDirectory).startsWith('ego-owned-stage-marker-'));
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  });
  return { directory, buildRoot, stage };
}

function writeMarker(buildRoot, stage) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference = 'Stop'; . $env:EGO_MARKER_HELPER; Write-OwnedOverlayRunMarker -RunDirectory $env:EGO_MARKER_RUN -BuildRoot $env:EGO_MARKER_BUILD",
  ], {
    env: {
      ...process.env,
      EGO_MARKER_HELPER: helper,
      EGO_MARKER_RUN: stage,
      EGO_MARKER_BUILD: buildRoot,
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
}

test('owned stage marker contains the canonical native run identity and cannot be replaced', {
  skip: process.platform !== 'win32',
}, (t) => {
  const f = fixture(t);
  const first = writeMarker(f.buildRoot, f.stage);
  assert.equal(first.error, undefined);
  assert.equal(first.status, 0, first.stderr);
  const markerPath = path.join(f.stage, markerName);
  const bytes = fs.readFileSync(markerPath);
  assert.ok(bytes.length <= 4096);
  assert.equal(bytes[0], 0x7b, 'Marker must start with JSON, without a UTF-8 BOM');
  const record = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'directoryName', 'kind', 'runId', 'schemaVersion',
  ]);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, 'electron-game-overlay-reshade-run');
  assert.equal(record.directoryName, path.basename(f.stage));
  assert.match(record.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(record), 'utf8'));
  const repeated = writeMarker(f.buildRoot, f.stage);
  assert.notEqual(repeated.status, 0, 'A second publisher must fail rather than overwrite ownership');
  assert.deepEqual(fs.readFileSync(markerPath), bytes);
});

test('owned stage marker refuses an outside directory and a reparse-point ancestor', {
  skip: process.platform !== 'win32',
}, (t) => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside-build');
  fs.mkdirSync(outside);
  const rejectedOutside = writeMarker(f.buildRoot, outside);
  assert.equal(rejectedOutside.error, undefined);
  assert.notEqual(rejectedOutside.status, 0);
  assert.equal(fs.existsSync(path.join(outside, markerName)), false);
  const junction = path.join(f.buildRoot, 'redirected');
  fs.symlinkSync(outside, junction, 'junction');
  const rejectedReparse = writeMarker(f.buildRoot, junction);
  assert.equal(rejectedReparse.error, undefined);
  assert.notEqual(rejectedReparse.status, 0);
  assert.equal(fs.existsSync(path.join(outside, markerName)), false);
});

test('every direct scene runner writes ownership before starting native processes', () => {
  for (const name of [
    'run-electron-scene.ps1',
    'run-injected-electron-scene.ps1',
    'run-client-sdk-session-deactivation-gate.ps1',
  ]) {
    const source = fs.readFileSync(path.join(runtimeScripts, name), 'utf8');
    const calls = [...source.matchAll(/^\s*Write-OwnedOverlayRunMarker\b/gm)];
    assert.equal(calls.length, 1, `${name} must publish exactly one owned stage marker`);
    const firstProcess = source.indexOf('Start-Process');
    assert.ok(firstProcess >= 0 && calls[0].index < firstProcess,
      `${name} must publish the marker before a native process can consume its stage`);
    assert.ok(source.includes('owned-stage-marker.ps1'), `${name} must use the shared marker writer`);
  }
});
