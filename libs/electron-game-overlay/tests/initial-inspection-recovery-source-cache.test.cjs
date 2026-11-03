'use strict';
// Synthetic source-text/Git and CMake-P fixtures only. No native binaries,
// canonical source cache, desktop process or game are built or executed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const runtime = path.resolve(__dirname, '../../electron-game-overlay-runtime');
const cmake = fs.readFileSync(path.join(runtime, 'CMakeLists.txt'), 'utf8');
const fixtureRoot = path.join(runtime, 'tests/cooperative-injector-migration/fixtures/late-source-cache');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const normalized = text => text.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const textSha = text => sha(normalized(text));
const q = value => `[==[${value.replace(/\\/g, '/')}]==]`;
const block = name => cmake.match(new RegExp(`# BEGIN ${name}\\r?\\n([\\s\\S]*?)# END ${name}`))?.[1];
const extract = name => cmake.match(new RegExp(`^function\\(${name}[^\\n]*\\)\\r?\\n[\\s\\S]*?^endfunction\\(\\)`, 'm'))?.[0];
const tables = block('EGO_SOURCE_CACHE_MIGRATION_TABLES');
const helpers = block('EGO_SOURCE_CACHE_MIGRATION_HELPERS');
const tableEnd = cmake.indexOf('# END EGO_SOURCE_CACHE_MIGRATION_TABLES');
const derivedVectors = cmake.slice(tableEnd, cmake.indexOf('set_property(DIRECTORY', tableEnd));
const scalarPins = [...cmake.matchAll(/^set\((?:RESHAPE_[A-Z0-9_]+|ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID)\s+"[0-9a-fA-F]+"\s*\)/gm)].map(match => match[0]);
const pin = name => cmake.match(new RegExp(`set\\(${name}\\s+"([0-9A-F]+)"\\s*\\)`))?.[1];
const GEN19_INJECTOR = 'A8ECF5046DD3BEDB748B77202504B234E39444FD96A9EAFC35A5877FEBC683E6';
const GEN20_INJECTOR = '91D82243D81D2CDC082DA1AF9BFF55A13315BF59F1FE5F9ACA1DFAE8442C8A10';
const GEN20_PATCH_SHA = 'FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B';
const GEN20_INL = 'AEA939BCC391BC5C2F63683558B78A88222BD5E9C4B81EFB5069CAA346F724BE';
const GEN21_INL = '36753053450815B934A6117B1C072A2100AA86032DF30D937F9A127CA0F7A5F0';
const GEN21_PATCH_SHA = 'BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6';
const GEN22_INJECTOR = '58ED5A9C5F0B0806D7D4AE65D060271AD8D62676A62332F0BE6FEAD88B6D8BFA';
const GEN22_PATCH_SHA = '5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7';
const ADDON_ID = 'CCE20935ADD44EF6A5A7973014B2E07F';
const inlRelative = 'source/ego_owned_late_d3d11/owned_late_d3d11.inl';
const patch = name => path.join(runtime, 'patches', name);
const injectorPatch = patch('reshade-injector-preload-long-path.patch');
const hostPatch = patch('reshade-owned-late-d3d11-adapter-ready-long-path.patch');
const recoveryPatch = patch('reshade-injector-initial-inspection-recovery.patch');
const patches = {
  RESHAPE_COOPERATIVE_MEMBERS_PATCH: patch('reshade-injector-cooperative-members.patch'),
  RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH: patch('reshade-injector-cooperative-members-v3.patch'),
  RESHAPE_OWNED_LATE_D3D11_PATCH: patch('reshade-owned-late-d3d11.patch'),
  RESHAPE_FIRST_HOST_RESULT_PATCH: patch('reshade-injector-first-host-result.patch'),
  RESHAPE_PRELOADED_ADDON_PATCH: patch('reshade-injector-preloaded-addon.patch'),
  RESHAPE_PRELOADED_FIRST_HOST_PATCH: patch('reshade-injector-preloaded-first-host.patch'),
  RESHAPE_PRELOAD_LONG_PATH_PATCH: injectorPatch,
  RESHAPE_ADAPTER_READY_LONG_PATH_PATCH: hostPatch,
  RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH: recoveryPatch,
};
const unavailable = spawnSync('cmake', ['--version'], { windowsHide: true }).status !== 0 ? 'CMake unavailable' :
  spawnSync('git', ['--version'], { windowsHide: true }).status !== 0 ? 'Git unavailable' : false;
const options = { skip: unavailable, timeout: 30000 };

function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function git(directory, args) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(directory) };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function copyShape(source, shape) {
  for (const entry of manifest.entries) {
    const file = path.join(source, entry.path), record = entry[shape];
    if (!record) { if (fs.existsSync(file)) fs.unlinkSync(file); continue; }
    const text = fs.readFileSync(path.join(fixtureRoot, record.fixture), 'utf8');
    assert.equal(textSha(text), record.normalizedSha256, `Frozen ${shape}: ${entry.path}`);
    write(file, normalized(text));
  }
}
function apply(f, input) {
  const file = path.join(f.directory, `input-${crypto.randomBytes(4).toString('hex')}.patch`);
  write(file, normalized(fs.readFileSync(input, 'utf8')));
  git(f.source, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', file]);
}
function sourceSha(file) { return textSha(fs.readFileSync(file, 'utf8')); }
function fixture(t, generation = 21) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-inspection-cache-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.ok(path.basename(directory).startsWith('ego-inspection-cache-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source'), binary = path.join(directory, 'binary');
  fs.mkdirSync(source); fs.mkdirSync(binary);
  copyShape(source, 'pristine'); write(path.join(source, '.gitattributes'), '* text\n');
  git(source, ['init', '--quiet']); git(source, ['config', 'core.autocrlf', 'true']);
  git(source, ['config', 'user.name', 'EGO isolated fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']); git(source, ['add', '--all']);
  const hooks = path.join(directory, 'empty-hooks'); fs.mkdirSync(hooks);
  git(source, ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test fixture']);
  const f = { directory, source, binary, commit: git(source, ['rev-parse', 'HEAD']),
    injector: path.join(source, 'tools/injector.cpp'), inl: path.join(source, inlRelative) };
  copyShape(source, 'base');
  const pre = fs.readFileSync(path.join(runtime, 'tests/cooperative-injector-migration/fixtures/pre-cooperative-injector.cpp.txt'), 'utf8');
  assert.equal(textSha(pre), 'E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359');
  write(f.injector, normalized(pre).replace('12EE788081A34E00B10862242DF38893', ADDON_ID));
  for (const name of ['RESHAPE_COOPERATIVE_MEMBERS_PATCH', 'RESHAPE_OWNED_LATE_D3D11_PATCH',
    'RESHAPE_FIRST_HOST_RESULT_PATCH', 'RESHAPE_PRELOADED_ADDON_PATCH', 'RESHAPE_PRELOADED_FIRST_HOST_PATCH']) apply(f, patches[name]);
  assert.equal(sourceSha(f.injector), GEN19_INJECTOR, 'Independently reconstructed generation 19');
  assert.equal(sourceSha(f.inl), GEN20_INL, 'Frozen host implementation through generation 20');
  if (generation >= 20) { apply(f, injectorPatch); assert.equal(sourceSha(f.injector), GEN20_INJECTOR); }
  if (generation >= 21) { apply(f, hostPatch); assert.equal(sourceSha(f.inl), GEN21_INL); }
  if (generation >= 22) { apply(f, recoveryPatch); assert.equal(sourceSha(f.injector), GEN22_INJECTOR); }
  return f;
}
function snapshot(source) {
  const files = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === '.git') continue;
      const name = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) files.push({ path: name, link: fs.readlinkSync(file) });
      else if (entry.isDirectory()) walk(file, name + '/');
      else files.push({ path: name, sha256: sha(fs.readFileSync(file)) });
    }
  }
  walk(source); return files;
}
function vector(f) { return manifest.entries.map(entry => [entry.path, sourceSha(path.join(f.source, entry.path))]); }
function run(f, action, overrides = {}) {
  assert.ok(tables && helpers && derivedVectors.includes('RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCHED_CONTENT_SHA256'));
  const calls = {
    tail: [`ego_apply_initial_inspection_recovery_source_tail(${q(f.source)})`],
    reverse: [`ego_apply_initial_inspection_recovery_source_tail(${q(f.source)} REVERSE)`],
    prepare: [`ego_prepare_owned_late_source_cache(${q(f.source)})`],
    forward: [`ego_prepare_owned_late_source_cache(${q(f.source)})`, `ego_rollover_known_addon_build_id(${q(f.injector)})`,
      ...['ego_apply_owned_late_source_tail', 'ego_apply_first_host_result_source_tail', 'ego_apply_preloaded_addon_source_tail',
        'ego_apply_preloaded_first_host_source_tail', 'ego_apply_preload_long_path_source_tail',
        'ego_apply_adapter_ready_long_path_source_tail', 'ego_apply_initial_inspection_recovery_source_tail'].map(name => `${name}(${q(f.source)})`),
      'set(RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256 "${RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCHED_CONTENT_SHA256}")',
      `verify_reshade_patched_source(${q(f.source)})`],
  };
  assert.ok(calls[action]);
  const script = path.join(f.directory, `guard-${crypto.randomBytes(4).toString('hex')}.cmake`);
  write(script, ['cmake_minimum_required(VERSION 3.24)', 'set(GIT_EXECUTABLE "git")',
    `set(CMAKE_CURRENT_SOURCE_DIR ${q(runtime)})`, `set(CMAKE_CURRENT_BINARY_DIR ${q(f.binary)})`, ...scalarPins,
    `set(RESHAPE_PINNED_COMMIT "${f.commit}")`,
    ...Object.entries(patches).map(([name, file]) => `set(${name} ${q(overrides[name] || file)})`),
    ...Object.entries(overrides.pins || {}).map(([name, value]) => `set(${name} "${value}")`),
    tables, derivedVectors, extract('verify_reshade_pinned_commit'), extract('verify_reshade_patched_source'), helpers,
    ...calls[action]].join('\n'));
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return spawnSync('cmake', ['-P', script], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
}
function accepted(result) { assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr || result.stdout); }
function rejected(f, action, overrides) {
  const before = snapshot(f.source), result = run(f, action, overrides);
  assert.equal(result.error, undefined, result.error?.message); assert.notEqual(result.status, 0, 'Unknown input fails closed');
  assert.deepEqual(snapshot(f.source), before, 'Rejected operation preserves every source byte and path');
  return result;
}

test('initial inspection tail preserves frozen generation-19/20/21 implementation and patch pins', () => {
  assert.equal(pin('RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256'), GEN19_INJECTOR);
  assert.equal(pin('RESHAPE_PRELOAD_LONG_PATH_INJECTOR_CONTENT_SHA256'), GEN20_INJECTOR);
  assert.equal(pin('RESHAPE_PRELOAD_LONG_PATH_PATCH_SHA256'), GEN20_PATCH_SHA);
  assert.equal(sha(fs.readFileSync(injectorPatch)), GEN20_PATCH_SHA);
  assert.equal(pin('RESHAPE_ADAPTER_READY_LONG_PATH_INL_CONTENT_SHA256'), GEN21_INL);
  assert.equal(pin('RESHAPE_ADAPTER_READY_LONG_PATH_PATCH_SHA256'), GEN21_PATCH_SHA);
  assert.equal(sha(fs.readFileSync(hostPatch)), GEN21_PATCH_SHA);
  assert.equal(pin('RESHAPE_INITIAL_INSPECTION_RECOVERY_INJECTOR_CONTENT_SHA256'), GEN22_INJECTOR);
  assert.equal(pin('RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256'), GEN22_PATCH_SHA);
  assert.equal(sha(fs.readFileSync(recoveryPatch)), GEN22_PATCH_SHA);
  assert.ok(tables.includes(`"${inlRelative}=${GEN20_INL}"`));
  assert.ok(!tables.includes('RESHAPE_INITIAL_INSPECTION_RECOVERY'), 'Frozen vector stays independent of the new tail');
});
test('generation-21 to22 forward tail changes only the injector after complete vector validation', options, t => {
  const f = fixture(t), before = snapshot(f.source); accepted(run(f, 'tail'));
  assert.equal(sourceSha(f.injector), GEN22_INJECTOR);
  assert.equal(sourceSha(f.inl), GEN21_INL);
  const others = files => files.filter(file => file.path !== 'tools/injector.cpp');
  assert.deepEqual(others(snapshot(f.source)), others(before));
});
test('generation-22 terminal reuse validates the complete vector and preserves every raw byte', options, t => {
  const f = fixture(t, 22), before = snapshot(f.source);
  accepted(run(f, 'tail')); accepted(run(f, 'tail')); assert.deepEqual(snapshot(f.source), before);
});
test('generation-22 complete source independently reverse-checks the retained injector, host and inspection tails unchanged', options, t => {
  const f = fixture(t, 22), before = snapshot(f.source);
  for (const input of [injectorPatch, hostPatch, recoveryPatch]) {
    git(f.source, ['apply', '-p1', '--reverse', '--check', input]);
    assert.deepEqual(snapshot(f.source), before, `Reverse check is read-only: ${path.basename(input)}`);
  }
});
test('generation-22 reversal leaves the exact generation-21 vector and host implementation intact', options, t => {
  const f = fixture(t, 22), expected = fixture(t), before = snapshot(f.source);
  accepted(run(f, 'reverse')); assert.deepEqual(vector(f), vector(expected));
  const others = files => files.filter(file => file.path !== 'tools/injector.cpp');
  assert.deepEqual(others(snapshot(f.source)), others(before));
  accepted(run(f, 'tail')); assert.equal(sourceSha(f.injector), GEN22_INJECTOR);
});
test('generation-22 preparation reverses new injector before host and old injector, then repeatedly reapplies its exact vector', options, t => {
  const f = fixture(t, 22), expected = vector(f); accepted(run(f, 'prepare'));
  for (const entry of manifest.entries) {
    const file = path.join(f.source, entry.path);
    if (!entry.base) assert.equal(fs.existsSync(file), false, entry.path);
    else assert.equal(sourceSha(file), entry.path === 'tools/injector.cpp' ?
      pin('RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256') : entry.base.normalizedSha256, entry.path);
  }
  accepted(run(f, 'forward')); assert.deepEqual(vector(f), expected);
  accepted(run(f, 'forward')); assert.deepEqual(vector(f), expected);
});
test('new injector combined with the old generation-20 host is rejected before any tail is changed', options, t => {
  const f = fixture(t, 20); apply(f, recoveryPatch);
  assert.equal(sourceSha(f.inl), GEN20_INL); rejected(f, 'prepare'); rejected(f, 'tail');
});
for (const unknown of ['injector', 'host', 'other mapped implementation', 'extra file']) test(`generation-22 cache preserves unknown ${unknown} edits before any peel`, options, t => {
  const f = fixture(t, 22);
  const file = unknown === 'injector' ? f.injector : unknown === 'host' ? f.inl :
    path.join(f.source, unknown === 'extra file' ? 'unexpected.txt' : 'source/runtime.cpp');
  write(file, (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') + '\n// unknown source edit\n');
  rejected(f, 'prepare'); rejected(f, 'tail');
});
test('generation-22 injector reached through a directory reparse point is rejected without changing its target', options, t => {
  const f = fixture(t, 22), tools = path.join(f.source, 'tools'), external = path.join(f.directory, 'external-tools');
  fs.renameSync(tools, external);
  try { fs.symlinkSync(external, tools, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    fs.renameSync(external, tools);
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Directory reparse points unavailable'); return; }
    throw error;
  }
  const target = path.join(external, 'injector.cpp'), before = sha(fs.readFileSync(target));
  rejected(f, 'prepare'); rejected(f, 'tail');
  assert.equal(sha(fs.readFileSync(target)), before, 'The reparse target remains byte-identical');
  assert.equal(fs.lstatSync(tools).isSymbolicLink(), true);
});
for (const generation of [21, 22]) test(`generation-${generation} cache rejects a changed inspection patch before any source mutation`, options, t => {
  const f = fixture(t, generation), changed = path.join(f.directory, 'changed.patch');
  write(changed, fs.readFileSync(recoveryPatch, 'utf8') + '\n# unknown patch edit\n');
  const overrides = { RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH: changed };
  rejected(f, 'prepare', overrides); rejected(f, 'tail', overrides);
});
for (const generation of [21, 22]) test(`generation-${generation} cache rejects a wrong declared inspection patch pin unchanged`, options, t => {
  const f = fixture(t, generation), overrides = { pins: { RESHAPE_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256: '0'.repeat(64) } };
  rejected(f, 'prepare', overrides); rejected(f, 'tail', overrides);
});
