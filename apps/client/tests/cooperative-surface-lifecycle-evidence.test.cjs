'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/cooperative-surface-lifecycle-evidence.cjs');
const { assertPromotion, assertRecreated, assertNoImplicitFocus, validateReport, main } = require(script);
const copy = (value) => structuredClone(value);

function state() {
  return {
    member: 'b', processId: 101, targetPid: 900,
    authenticatedTarget: { pid: 900, executablePath: 'C:\\Games\\Owned\\Target.exe', creationTime100ns: '133000000000000001' },
    transport: { producerPid: 101, port: 42000, tokenFingerprint: 'a'.repeat(32), targetPid: 900 },
    connectionCount: 1, authenticationCount: 1, transportLostCount: 0, targetDisconnectedCount: 0,
    removedSurfaceCount: 0, fpsCount: 3,
    surface: { pid: 900, surfaceId: '0x1', hwnd: '0x101', revision: 1, renderSize: { width: 1280, height: 720 } },
    windows: {
      main: { id: 1, value: 'a', downs: 1, ups: 1, heldKeys: [], keydowns: 1 },
      secondary: { id: 2, value: '', downs: 0, ups: 0, heldKeys: [], keydowns: 0 },
    },
    focusedWindowId: 1,
    tcp: { localAddress: '127.0.0.1', localPort: 50123, remoteAddress: '127.0.0.1', remotePort: 42000, owningProcess: 900, state: 'Established' },
  };
}

function promoted() {
  const before = state(), after = copy(before);
  after.surface.surfaceId = '0x2'; after.surface.hwnd = '0x202';
  after.surface.revision = 2;
  after.fpsCount = 5; after.removedSurfaceCount = 1;
  after.windows.main.value = 'alpha'; after.windows.main.downs = 2;
  after.windows.main.ups = 2; after.windows.main.keydowns = 5;
  return { before, after };
}

function recreated() {
  const before = promoted().after, destroyed = copy(before), after = copy(before);
  destroyed.surface = null; destroyed.removedSurfaceCount = 2;
  destroyed.transportLostCount = 1; destroyed.focusedWindowId = 0; destroyed.tcp = null;
  after.surface.surfaceId = '0x3'; // Same HWND may survive graphics recreation.
  after.surface.revision = 3;
  after.fpsCount = 7; after.removedSurfaceCount = 2; after.transportLostCount = 1;
  after.connectionCount = 2; after.authenticationCount = 2; after.focusedWindowId = 0;
  after.tcp.localPort = 50124;
  return { before, destroyed, after };
}

function noFocus() {
  const before = recreated().after, after = copy(before);
  after.fpsCount++;
  return { before, after, sent: 'unfocused-key-attempt' };
}

test('promotion proves stable connection and identities with a distinct interactive presenter', () => {
  const { before, after } = promoted();
  const result = assertPromotion(before, after);
  assert.equal(result.status, 'validated'); assert.equal(result.kind, 'promotion');
  assert.match(result.checks.join(';'), /uninterrupted authenticated TCP/);
  assert.equal(before.windows.main.value, 'a', 'Assertions do not mutate observed states.');
  const producerSide = promoted();
  for (const snapshot of [producerSide.before, producerSide.after]) {
    snapshot.tcp = { ...snapshot.tcp, localPort: 42000, remotePort: 50123, owningProcess: 101 };
  }
  assert.equal(assertPromotion(producerSide.before, producerSide.after).status, 'validated');
});

test('promotion rejects reconnection, reauthentication, loss and changed TCP or route', () => {
  const mutations = [
    (s) => s.connectionCount++,
    (s) => s.authenticationCount++,
    (s) => s.transportLostCount++,
    (s) => s.targetDisconnectedCount++,
    (s) => s.tcp.localPort++,
    (s) => { s.transport.port++; s.tcp.remotePort++; },
    (s) => s.transport.tokenFingerprint = 'b'.repeat(32),
    (s) => s.tcp.owningProcess = 777,
    (s) => s.tcp.state = 'Closed',
    (s) => s.tcp.remoteAddress = '192.168.1.2',
    (s) => s.tcp.remoteAddress = '127.999.999.999',
  ];
  for (const mutate of mutations) {
    const { before, after } = promoted(); mutate(after);
    assert.throws(() => assertPromotion(before, after));
  }
});

test('promotion rejects old surfaces, stale FPS/input, new app/game incarnations and recreated window IDs', () => {
  const mutations = [
    (s) => s.surface.surfaceId = '0x1',
    (s) => s.surface.hwnd = '0x101',
    (s) => s.surface = null,
    (s) => s.fpsCount = 3,
    (s) => s.windows.main.value = 'a',
    (s) => s.windows.main.downs = 1,
    (s) => s.windows.main.ups = 1,
    (s) => s.windows.main.id = 7,
    (s) => s.windows.main.heldKeys = ['KeyA'],
    (s) => s.authenticatedTarget.creationTime100ns = '133000000000000002',
    (s) => s.authenticatedTarget.executablePath = 'C:\\Games\\Other.exe',
    (s) => { s.processId = 102; s.transport.producerPid = 102; },
    (s) => s.member = 'a',
  ];
  for (const mutate of mutations) {
    const { before, after } = promoted(); mutate(after);
    assert.throws(() => assertPromotion(before, after));
  }
});

test('final-surface recreation preserves app/game/route/windows and permits native reauthentication', () => {
  const { before, destroyed, after } = recreated();
  const result = assertRecreated(before, destroyed, after);
  assert.equal(result.status, 'validated'); assert.equal(result.reconnected, true);
  assert.equal(after.surface.hwnd, before.surface.hwnd, 'A new surface may reuse the existing native window.');
  const uninterrupted = recreated();
  uninterrupted.destroyed.transportLostCount = 0;
  uninterrupted.after.transportLostCount = 0;
  uninterrupted.after.connectionCount = 1;
  uninterrupted.after.authenticationCount = 1;
  uninterrupted.after.tcp = copy(uninterrupted.before.tcp);
  assert.equal(assertRecreated(uninterrupted.before, uninterrupted.destroyed, uninterrupted.after).reconnected, false);
});

test('recreation rejects absent clear/removal, stale surface identity, moved route and any target disconnect', () => {
  const mutations = [
    (r) => r.destroyed.surface = copy(r.before.surface),
    (r) => r.destroyed.removedSurfaceCount = r.before.removedSurfaceCount,
    (r) => r.destroyed.windows.main.id = 99,
    (r) => r.destroyed.targetDisconnectedCount = 1,
    (r) => r.after.targetDisconnectedCount = 1,
    (r) => { r.after.surface.surfaceId = r.before.surface.surfaceId; r.after.surface.revision = r.before.surface.revision; },
    (r) => r.after.fpsCount = r.before.fpsCount,
    (r) => r.after.connectionCount = 0,
    (r) => r.after.authenticationCount = 0,
    (r) => { r.after.transport.port++; r.after.tcp.remotePort++; },
    (r) => r.after.authenticatedTarget.creationTime100ns = '133000000000000002',
    (r) => r.after.transportLostCount = 0,
  ];
  for (const mutate of mutations) {
    const fixture = recreated(); mutate(fixture);
    assert.throws(() => assertRecreated(fixture.before, fixture.destroyed, fixture.after));
  }
});

test('pointer-derived surface identity may be reused only after removal with a fresh revision', () => {
  const evidence = recreated();
  evidence.after.surface.surfaceId = evidence.before.surface.surfaceId;
  assert.equal(assertRecreated(evidence.before, evidence.destroyed, evidence.after).reusedSurfaceId, true);
  evidence.after.surface.revision = evidence.before.surface.revision;
  assert.throws(() => assertRecreated(evidence.before, evidence.destroyed, evidence.after), /no newer revision/);
  evidence.after.surface.revision++;
  evidence.destroyed.surface = copy(evidence.before.surface);
  assert.throws(() => assertRecreated(evidence.before, evidence.destroyed, evidence.after), /did not clear/);
  evidence.destroyed.surface = null;
  evidence.destroyed.removedSurfaceCount = evidence.before.removedSurfaceCount;
  assert.throws(() => assertRecreated(evidence.before, evidence.destroyed, evidence.after), /no surface-removed/);
});

test('no implicit focus accepts native zero/null and requires unchanged DOM keydown/value state', () => {
  const { before, after, sent } = noFocus();
  assert.equal(assertNoImplicitFocus(before, after, sent).attemptedText, sent);
  after.focusedWindowId = null;
  assert.equal(assertNoImplicitFocus(before, after, sent).status, 'validated');
});

test('actual executablePath/renderSize snapshots use the outer attempted-text report field', () => {
  const promotion = promoted();
  assert.equal(promotion.before.authenticatedTarget.path, undefined);
  assert.equal(promotion.before.surface.renderArea, undefined);
  assert.equal(assertPromotion(promotion.before, promotion.after).status, 'validated');
  const evidence = noFocus();
  assert.equal(evidence.before.sent, undefined);
  const report = validateReport({ noImplicitFocus: evidence });
  assert.equal(report.results[0].attemptedText, evidence.sent);
  const misplaced = { before: { ...evidence.before, sent: evidence.sent }, after: evidence.after };
  assert.throws(() => validateReport({ noImplicitFocus: misplaced }), /attempted text marker/);
  promotion.after.authenticatedTarget.path = 'C:\\Games\\Foreign.exe';
  assert.throws(() => assertPromotion(promotion.before, promotion.after), /conflicting image path fields/);
});

test('no implicit focus rejects consumed-but-nonediting keydowns and pointer/focus/held-key changes', () => {
  const mutations = [
    (r) => r.after.windows.main.keydowns++, // preventDefault may keep value unchanged.
    (r) => r.after.windows.secondary.keydowns++,
    (r) => r.after.windows.main.value += 'unfocused-key-attempt',
    (r) => r.after.focusedWindowId = 1,
    (r) => r.after.windows.main.downs++,
    (r) => r.after.windows.main.ups++,
    (r) => r.after.windows.main.heldKeys = ['KeyQ'],
    (r) => delete r.after.windows.main.keydowns,
    (r) => delete r.sent,
    (r) => r.after.targetDisconnectedCount = 1,
    (r) => r.after.windows.main.id = 42,
  ];
  for (const mutate of mutations) {
    const fixture = noFocus(); mutate(fixture);
    assert.throws(() => assertNoImplicitFocus(fixture.before, fixture.after, fixture.sent));
  }
});

test('malformed identity/counter evidence cannot accidentally compare equal', () => {
  const mutations = [
    (s) => s.authenticatedTarget.creationTime100ns = '0133000000000000001',
    (s) => s.authenticatedTarget.creationTime100ns = '18446744073709551616',
    (s) => s.authenticatedTarget.creationTime100ns = 133000000000000000,
    (s) => s.authenticatedTarget.executablePath = 'relative/target.exe',
    (s) => s.targetPid = 0,
    (s) => s.transport.port = 65536,
    (s) => s.transport.tokenFingerprint = 'unknown',
    (s) => s.connectionCount = '1',
    (s) => s.fpsCount = NaN,
    (s) => s.windows.secondary.id = s.windows.main.id,
    (s) => s.surface.surfaceId = '0x0',
    (s) => s.surface.hwnd = '0xABCD',
    (s) => delete s.surface.revision,
  ];
  for (const mutate of mutations) {
    const { before, after } = promoted(); mutate(before); mutate(after);
    assert.throws(() => assertPromotion(before, after));
  }
});

test('CLI validates named snapshots without presenting them as native execution', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-surface-evidence-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const reportPath = path.join(directory, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ promotion: promoted(), recreation: recreated(), noImplicitFocus: noFocus() }));
  const run = spawnSync(process.execPath, [script, '--report', reportPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.nativeExecuted, false);
  assert.equal(report.results.length, 3);
  assert.match(report.scope, /controller/);
  assert.equal(validateReport({ promotion: promoted() }).results.length, 1);
  assert.throws(() => validateReport({}), /no named lifecycle/);
  assert.throws(() => main(['--report', 'relative.json']), /absolute/);
  const invalid = promoted(); invalid.after.connectionCount++;
  fs.writeFileSync(reportPath, JSON.stringify({ promotion: invalid }));
  const failed = spawnSync(process.execPath, [script, '--report', reportPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /single connection/);
});
