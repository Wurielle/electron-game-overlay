'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { MODES, validateArchitecture } = require('./evidence.cjs');

function results(architecture = 'x64') {
  return MODES.map(mode => ({
    mode, passed: true, pointerBits: architecture === 'x64' ? 64 : 32,
    mappingBytes: architecture === 'x64' ? 1565848 : 1549464,
    maxParticipants: 512, maxWindows: 8192, active: 0,
    reserved: mode === 'stable-participant' ? 1 : mode === 'concurrent-departure' ? 2 : 512,
    ...(mode === 'stable-participant' ? { cycles: 8209 } : {}),
    ...(mode === 'lifetime-capacity' ? { admitted: 512, rejectedAttempts: 1025 } : {}),
    ...(mode === 'admission-transaction' ? { cancelledPrePin: 1024, unpublishedTombstones: 509 } : {}),
    trackedCppHeapBlocks: 0, trackedCppHeapBytes: 0, handles: 9, threads: 1, modules: 12,
    resourceBaseline: { trackedCppHeapBlocks: 0, trackedCppHeapBytes: 0, handles: 9, threads: 3, modules: 12 },
    resourceAfter: { trackedCppHeapBlocks: 0, trackedCppHeapBytes: 0, handles: 9, threads: 3, modules: 12 },
    privateBytesDiagnostic: 8 * 1024 * 1024,
  }));
}
test('accepts complete exact-bound fixture evidence on both architectures', () => {
  for (const architecture of ['x64', 'x86']) assert.equal(validateArchitecture(results(architecture), architecture).length, 4);
});
test('rejects omitted, duplicate and unexecuted fixture cases', () => {
  assert.throws(() => validateArchitecture(results().slice(1), 'x64'));
  const duplicate = results(); duplicate[1] = duplicate[0];
  assert.throws(() => validateArchitecture(duplicate, 'x64'));
  const failed = results(); failed[1].passed = false;
  assert.throws(() => validateArchitecture(failed, 'x64'));
});
test('rejects slot reuse, early exhaustion and wrong architecture', () => {
  for (const [index, property, value] of [[0, 'reserved', 2], [1, 'admitted', 511], [1, 'rejectedAttempts', 0], [2, 'active', 1]]) {
    const changed = results(); changed[index][property] = value;
    assert.throws(() => validateArchitecture(changed, 'x64'));
  }
  assert.throws(() => validateArchitecture(results('x86'), 'x64'));
});
test('rejects live worker retention but keeps private bytes diagnostic', () => {
  const workers = results(); workers[2].resourceAfter.threads = 4;
  assert.throws(() => validateArchitecture(workers, 'x64'));
  const diagnostic = results(); diagnostic[0].privateBytesDiagnostic = 1024 * 1024 * 1024;
  assert.equal(validateArchitecture(diagnostic, 'x64').length, 4);
});
