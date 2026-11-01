'use strict';
const assert = require('node:assert/strict');
const MODES = ['stable-participant', 'lifetime-capacity', 'concurrent-departure', 'admission-transaction'];

function validateResult(result, architecture) {
  assert.ok(result && typeof result === 'object', 'Missing fixture result');
  assert.ok(MODES.includes(result.mode), 'Unknown fixture mode');
  assert.equal(result.passed, true);
  assert.equal(result.pointerBits, architecture === 'x64' ? 64 : 32);
  assert.equal(result.mappingBytes, architecture === 'x64' ? 1565848 : 1549464);
  assert.equal(result.maxParticipants, 512);
  assert.equal(result.maxWindows, 8192);
  assert.equal(result.active, 0);
  for (const name of ['trackedCppHeapBlocks', 'trackedCppHeapBytes', 'handles', 'threads', 'modules', 'privateBytesDiagnostic']) {
    assert.ok(Number.isSafeInteger(result[name]) && result[name] >= 0, `Invalid ${name}`);
  }
  for (const name of ['trackedCppHeapBlocks', 'trackedCppHeapBytes', 'handles', 'threads', 'modules']) {
    assert.ok(Number.isSafeInteger(result.resourceBaseline?.[name]) && result.resourceBaseline[name] >= 0, `Invalid baseline ${name}`);
    assert.equal(result.resourceAfter?.[name], result.resourceBaseline[name], `The isolated fixture retained ${name}`);
  }
  assert.ok(result.resourceBaseline.threads > 0);
  assert.ok(result.handles > 0 && result.modules > 0);
  if (result.mode === 'stable-participant') {
    assert.equal(result.cycles, 8209);
    assert.equal(result.reserved, 1);
  } else if (result.mode === 'lifetime-capacity') {
    assert.equal(result.admitted, 512);
    assert.equal(result.rejectedAttempts, 1025);
    assert.equal(result.reserved, 512);
  } else if (result.mode === 'admission-transaction') {
    assert.equal(result.cancelledPrePin, 1024);
    assert.equal(result.unpublishedTombstones, 509);
    assert.equal(result.reserved, 512);
  } else {
    assert.equal(result.reserved, 2);
  }
  return result;
}
function validateArchitecture(results, architecture) {
  assert.ok(['x64', 'x86'].includes(architecture), 'Unsupported architecture');
  assert.equal(results.length, MODES.length, 'All isolated cases are required');
  assert.deepEqual(results.map(value => value.mode).sort(), [...MODES].sort(), 'Fixture modes must be unique and complete');
  return results.map(result => validateResult(result, architecture));
}
module.exports = { MODES, validateResult, validateArchitecture };

if (require.main === module) {
  const fs = require('node:fs');
  const [, , architecture, input] = process.argv;
  const results = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  validateArchitecture(results, architecture);
  process.stdout.write('Controlled registry resource evidence is complete.\n');
}
