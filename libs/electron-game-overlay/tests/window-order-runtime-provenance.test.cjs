const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const protocol = require('../dist/lib/overlay-broker-protocol.js');
const runtimeRoot = 'libs/electron-game-overlay-runtime';
const previousAddonId = 'F2A88AD705204DBB8E18D86E7147A13C';

// These guards cover distribution provenance, not native execution or placement.
test('order-capable runtime advances generation without changing frozen v1 defaults', () => {
  assert.equal(protocol.OVERLAY_BROKER_RUNTIME_GENERATION, 4);
  assert.equal(protocol.OVERLAY_BROKER_LEGACY_RUNTIME_GENERATION, 1);
  assert.equal(protocol.OVERLAY_BROKER_PROTOCOL_VERSION, 1);
  assert.equal(protocol.OVERLAY_BROKER_TARGET_TRANSPORT_VERSION, 1);
  assert.equal(protocol.OVERLAY_BROKER_TARGET_TRANSPORT_MIN, 1);
  assert.equal(protocol.OVERLAY_BROKER_TARGET_TRANSPORT_MAX, 1);
  assert.equal(protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES.includes('window-order-v1'), false);
});

test('changed mapped runtime has a fresh exact addon ID across injector and package pins', () => {
  const cmake = read(`${runtimeRoot}/CMakeLists.txt`);
  const canonicalId = cmake.match(/"([A-F0-9]{32})"/u)?.[1];
  assert.match(canonicalId, /^[A-F0-9]{32}$/u);
  assert.notEqual(canonicalId, previousAddonId, 'mapped runtime changes require a new addon build ID');
  const mirrors = [
    `${runtimeRoot}/scripts/build.ps1`,
    `${runtimeRoot}/scripts/run-official-reshade-addon-preflight-gate.ps1`,
    `${runtimeRoot}/scripts/run-client-sdk-process-start-injection-gate.ps1`,
    `${runtimeRoot}/patches/reshade-injector-future-targets.patch`,
    'libs/electron-game-overlay/scripts/stage-game-overlay-runtime.ps1',
    'libs/electron-game-overlay/src/lib/reshade-launcher.ts',
  ];
  for (const relative of mirrors) {
    const source = read(relative);
    assert.ok(source.includes(canonicalId), `${relative} must use the canonical exact addon ID`);
    assert.equal(source.includes(previousAddonId), false, `${relative} must reject the superseded addon ID`);
  }
});

test('runtime builder and SDK staging advertise generation four but retain target transport one', () => {
  const build = read(`${runtimeRoot}/scripts/build.ps1`);
  const stage = read('libs/electron-game-overlay/scripts/stage-game-overlay-runtime.ps1');
  assert.match(build, /\$RuntimeGeneration = 4\b/u);
  assert.match(stage, /\$ExpectedRuntimeGeneration = 4\b/u);
  assert.match(build, /\$TargetTransportMin = 1\b/u);
  assert.match(build, /\$TargetTransportMax = 1\b/u);
  assert.match(stage, /\$ExpectedTargetTransportMin = 1\b/u);
  assert.match(stage, /\$ExpectedTargetTransportMax = 1\b/u);
});
