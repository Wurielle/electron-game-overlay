'use strict';
// Reconstruct production source from the retained, hashed source-text fixtures.
// No canonical build cache, network, game or graphics build is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const runtime = path.resolve(__dirname, '../../../electron-game-overlay-runtime');
const fixtures = path.join(runtime, 'tests/cooperative-injector-migration/fixtures');
const sha = text => crypto.createHash('sha256').update(text).digest('hex').toUpperCase();
const normal = text => text.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');

function reconstruct(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw new Error('Source reconstruction requires an empty owned directory');
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(directory) };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const run = args => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000,
      env,
    });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Git failed');
  };
  // Do not inherit an enclosing repository or an application-provided Git path.
  run(['init', '--quiet']);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'late-source-cache/manifest.json')));
  for (const entry of manifest.entries) {
    if (!entry.base) continue;
    const text = normal(fs.readFileSync(path.join(fixtures, 'late-source-cache', entry.base.fixture), 'utf8'));
    if (sha(text) !== entry.base.normalizedSha256) throw new Error('Frozen fixture hash mismatch: ' + entry.path);
    const file = path.join(directory, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  const injector = path.join(directory, 'tools/injector.cpp');
  const pre = normal(fs.readFileSync(path.join(fixtures, 'pre-cooperative-injector.cpp.txt'), 'utf8'));
  if (sha(pre) !== 'E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359') throw new Error('Pre-cooperative fixture hash mismatch');
  const cmake = fs.readFileSync(path.join(runtime, 'CMakeLists.txt'), 'utf8');
  const addonId = cmake.match(/set\(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID\s+"([0-9A-F]+)"/)?.[1];
  fs.writeFileSync(injector, pre.replace('12EE788081A34E00B10862242DF38893', addonId));
  for (const name of ['injector-cooperative-members', 'owned-late-d3d11', 'injector-first-host-result',
    'injector-preloaded-addon', 'injector-preloaded-first-host', 'injector-preload-long-path',
    'owned-late-d3d11-adapter-ready-long-path', 'injector-initial-inspection-recovery',
    'injector-shared-addon-directory', 'owned-late-d3d11-addon-failure-isolation', 'injector-inspection-context']) {
    run(['apply', '--whitespace=nowarn', path.join(runtime, 'patches', `reshade-${name}.patch`)]);
  }
  const expected = cmake.match(/set\(RESHAPE_INSPECTION_CONTEXT_INJECTOR_CONTENT_SHA256\s+"([0-9A-F]+)"/)?.[1];
  if (sha(normal(fs.readFileSync(injector, 'utf8'))) !== expected) throw new Error('Reconstructed production injector hash mismatch');
  return injector;
}
module.exports = { reconstruct };
if (require.main === module) console.log(reconstruct(path.resolve(process.argv[2])));
