'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const version = process.argv[2];
assert.match(version || '', /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:nightly|rc|alpha|beta)\.(0|[1-9][0-9]*))?$/);
assert.match(process.env.GITHUB_SHA || '', /^[0-9a-f]{40}$/);
const output = 'artifacts/release';
const packageScript = 'libs/electron-game-overlay/scripts/package-sdk.cjs';
const run = args => execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 600000 });
run([packageScript, '--package-root', 'libs/electron-game-overlay',
  '--built-dist', 'libs/electron-game-overlay/dist', '--output', output,
  '--version', version, '--source-commit', process.env.GITHUB_SHA]);
const packed = JSON.parse(fs.readFileSync(path.join(output, 'sdk-preview-report.json'), 'utf8'));
assert.equal(packed.status, 'passed');
assert.equal(packed.version, version);
const installedReport = path.join(output, 'installed-package-report.json');
run(['libs/electron-game-overlay/tests/broker-package-install.acceptance.cjs',
  '--package-root', packed.stageRoot, '--sdk-root', path.join(packed.stageRoot, 'dist'),
  '--tslib-root', 'node_modules/tslib', '--typescript-root', 'node_modules/typescript',
  '--scratch-root', process.env.RUNNER_TEMP || process.env.TMPDIR,
  '--report', installedReport]);
const installed = JSON.parse(fs.readFileSync(installedReport, 'utf8'));
assert.equal(installed.status, 'passed');
assert.equal(installed.tarballSha256, packed.tarballSha256, 'Installed tarball differs from release asset');
assert.equal(createHash('sha256').update(fs.readFileSync(packed.tarball)).digest('hex'), packed.tarballSha256);
assert.deepEqual(fs.readdirSync(output).filter(file => file.endsWith('.tgz')), [`electron-game-overlay-${version}.tgz`]);
console.log(`Verified release asset: ${packed.tarball} (${packed.tarballSha256})`);
