'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('standalone native identity gate provisions its locked independent FFI reference without install scripts', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8');
  const job = workflow.split('  process-image-diagnostics:')[1].split('  packaged-broker:')[0];
  const install = job.indexOf('npm ci --ignore-scripts --no-audit --no-fund');
  assert.ok(install >= 0, 'locked FFI reference dependency must be installed');
  assert.ok(job.indexOf('Seed sanitized native setup evidence before compilation') < install, 'failure-default evidence must precede dependency setup');
  assert.ok(install < job.indexOf('Build the native process-image query manager'), 'reference setup must precede compilation and native assertions');
});

test('process-instance mixed acceptance reuses the independently compiled baseline and preserves its report', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8');
  const command = "node libs/electron-game-overlay/tests/process-instance-mixed.acceptance.cjs (Join-Path $baseline 'libs/electron-game-overlay/dist')";
  assert.ok(workflow.includes(command), 'identity degradation must run against the real baseline distribution');
  assert.ok(workflow.includes('EGO_INSTANCE_MIXED_EVIDENCE: test-results/process-instance-mixed.json'), 'mixed report must be included in existing test-results upload');
});
