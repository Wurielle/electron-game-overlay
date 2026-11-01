'use strict';
// Executes only the extracted CMake source-cache guard in script mode. No
// project configure, compiler, runtime, target process or installation runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const cmake = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/CMakeLists.txt'), 'utf8');
const guard = cmake.match(/^function\(ego_rollover_known_addon_build_id source_path\)\r?\n[\s\S]*?^endfunction\(\)/m)?.[0];
const value = name => cmake.match(new RegExp(`set\\(${name}\\s+"([0-9A-F]+)"\\s*\\)`))?.[1];
const newId = value('ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID');
const fullHash = value('RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256');
const preHash = value('RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256');
const oldId = 'A8E9DA12477741B9979D9B1B51994EF3';
const canonical = path.join(root, 'build/electron-game-overlay-runtime/_deps/reshade-src/tools/injector.cpp');
const baseline = path.join(root, 'build/cooperative-injector-authoring/tools/injector.base.cpp');
const sha = text => createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex').toUpperCase();
const available = fs.existsSync(canonical) && spawnSync('cmake', ['--version'], { windowsHide: true }).status === 0;

function runGuard(t, input, expectedHash = fullHash) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-addon-id-rollover-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'injector.cpp');
  fs.writeFileSync(file, input);
  const script = path.join(directory, 'guard.cmake');
  fs.writeFileSync(script, [
    'cmake_minimum_required(VERSION 3.24)',
    `set(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID "${newId}")`,
    `set(RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 "${expectedHash}")`,
    `set(RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256 "${preHash}")`,
    guard,
    `ego_rollover_known_addon_build_id([==[${file.replace(/\\/g, '/')}]==])`,
  ].join('\n'));
  const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return { ...result, output: fs.readFileSync(file, 'utf8') };
}

test('known full cached source rolls only its exact old identity to the new pinned hash', { skip: !available }, t => {
  assert.ok(guard);
  const current = fs.readFileSync(canonical, 'utf8');
  assert.equal(sha(current), fullHash, 'Test must use the exact new canonical source, not an arbitrary fixture body');
  const old = current.replace(newId, oldId);
  assert.equal(sha(old), '246B4B1DC7259C2EBF4BC4C4278B03B5083507FAE8BDB071B264692F73730135');
  const result = runGuard(t, old.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(sha(result.output), fullHash);
  assert.equal((result.output.match(new RegExp(newId, 'g')) || []).length, 1);
});

test('known pre-cooperative cache rolls safely before historical patch peeling', { skip: !available || !fs.existsSync(baseline) }, t => {
  const source = fs.readFileSync(baseline, 'utf8');
  assert.equal(sha(source), 'E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359');
  const old = source.replace('12EE788081A34E00B10862242DF38893', oldId);
  assert.equal(sha(old), '007B4DF39CEB0C7E6777B990A9A24D352DBC399C79DCA8488E9F4E49C58FB166');
  const result = runGuard(t, old);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(sha(result.output), preHash);
});

test('unknown edited source is never rewritten just because its old literal matches', { skip: !available }, t => {
  const source = fs.readFileSync(canonical, 'utf8').replace(newId, oldId) + '\n// unrecognized source change\n';
  const result = runGuard(t, source);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.output, source);
});

test('new hash mismatch fails before writing even an otherwise known cache', { skip: !available }, t => {
  const source = fs.readFileSync(canonical, 'utf8').replace(newId, oldId);
  const result = runGuard(t, source, '0'.repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the new pinned source hash/);
  assert.equal(result.output, source);
});
