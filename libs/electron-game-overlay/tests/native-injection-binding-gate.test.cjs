'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8');
const job = workflow.split('  packaged-broker:')[1];

test('native binding gate consumes freshly built injectors and preserves failure evidence', () => {
  const build = job.indexOf('name: Build native runtimes and packaged SDK');
  const check = job.indexOf('name: Check native injection instance binding');
  assert.ok(build >= 0 && check > build, 'binding acceptance must follow the actual production build');
  const step = job.slice(check, job.indexOf('      - ', check + 1));
  for (const value of ['native-injection-binding.acceptance.cjs', '--injector64', 'inject.exe', '--injector32', 'inject32.exe', '--vcvarsall', 'native-injection-binding.json', 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }']) assert.ok(step.includes(value), value);
  const seed = job.indexOf('name: Seed native-binding failure evidence');
  assert.ok(seed >= 0 && seed < job.indexOf('name: Install locked dependencies'), 'failure-default report must precede dependency setup');
  const initial = job.slice(seed, job.indexOf('      - ', seed + 1));
  for (const value of ["status = 'failed'", 'nativeExecuted = $false', 'legacyFixtureVerified = $false', 'sameHandlePlacementVerified = $false']) assert.ok(initial.includes(value), value);
  const artifact = job.indexOf('name: native-injection-binding-results');
  assert.ok(artifact >= 0);
  const upload = job.slice(job.lastIndexOf('      - ', artifact), job.indexOf('      - ', artifact));
  for (const value of ['if: always()', 'path: test-results/native-injection-binding.json', 'if-no-files-found: error']) assert.ok(upload.includes(value), value);
});
