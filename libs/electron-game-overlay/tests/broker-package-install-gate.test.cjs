'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8');
const job = workflow.split('  packaged-broker:')[1];

test('installed package acceptance consumes the actual built production SDK', () => {
  const check = job.indexOf('name: Check installed SDK tarball');
  assert.ok(check > job.indexOf('name: Build native runtimes and packaged SDK'), 'install acceptance must follow the actual SDK build');
  const step = job.slice(check, job.indexOf('      - ', check + 1));
  for (const flag of ['--package-root libs/electron-game-overlay', '--sdk-root libs/electron-game-overlay/dist', '--tslib-root node_modules/tslib', '--typescript-root node_modules/typescript', '--scratch-root $env:TMPDIR', '--report test-results/broker-package-install.json']) assert.ok(step.includes(flag), flag);
  assert.ok(step.includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));
});

test('installed package evidence is failed before dependency or build setup', () => {
  const seed = job.indexOf('name: Seed installed-package failure evidence');
  assert.ok(seed >= 0 && seed < job.indexOf('name: Install locked dependencies'));
  const step = job.slice(seed, job.indexOf('      - ', seed + 1));
  for (const field of ["status = 'failed'", "stage = 'before-dependency-setup'", 'nativeExecuted = $false', 'test-results/broker-package-install.json']) assert.ok(step.includes(field), field);
});

test('installed package evidence uploads even after setup or verification failure', () => {
  const marker = 'name: installed-sdk-package-results';
  const at = job.indexOf(marker);
  assert.ok(at >= 0, 'missing package acceptance artifact');
  const upload = job.slice(job.lastIndexOf('      - ', at), job.indexOf('      - ', at));
  for (const field of ['if: always()', 'path: test-results/broker-package-install.json', 'if-no-files-found: error']) assert.ok(upload.includes(field), field);
});
