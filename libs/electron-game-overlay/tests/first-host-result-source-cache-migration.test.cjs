'use strict';
// Source-text/CMake-P assertions only. These minimal Git repositories are
// synthetic fixtures, never native builds, real upstream checkouts or games.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const runtime = path.join(root, 'libs/electron-game-overlay-runtime');
const fixtureRoot = path.join(runtime, 'tests/cooperative-injector-migration/fixtures/late-source-cache');
const manifestPath = path.join(fixtureRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const preFixture = path.join(runtime, 'tests/cooperative-injector-migration/fixtures/pre-cooperative-injector.cpp.txt');
const cmake = fs.readFileSync(path.join(runtime, 'CMakeLists.txt'), 'utf8');
const normalize = text => text.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const normalizedSha = text => sha(normalize(text));
const pin = name => cmake.match(new RegExp(`set\\(${name}\\s+"([0-9A-F]+)"\\s*\\)`))?.[1];
const extract = name => cmake.match(new RegExp(`^function\\(${name}[^\\n]*\\)\\r?\\n[\\s\\S]*?^endfunction\\(\\)`, 'm'))?.[0];
const block = name => cmake.match(new RegExp(`# BEGIN ${name}\\r?\\n([\\s\\S]*?)# END ${name}`))?.[1];
const tables = block('EGO_SOURCE_CACHE_MIGRATION_TABLES');
const helpers = block('EGO_SOURCE_CACHE_MIGRATION_HELPERS');
const q = text => `[==[${text.replace(/\\/g, '/')}]==]`;
const GEN15 = Object.freeze({
  ID: 'BCE6C5C8746F4300861300B2BDA3594E',
  PRE: '3D51024529834F539601F4E2573E29591954CF5906C704C980086108DB51373B',
  V4: 'F1B4EFB815F45A61BDCF31BC7C04D2B49ED8F060CD98CD03960E0BC222FD3E8B',
  HOST: 'C5451CD3C3FFCA5072ED326EC585A0E77CE86CB5E1F17CDFAC42E4FAF9A9845C',
  FINAL: '8EC5E249B34ACD0E6315AFADFB9E6FD698B5237AE36F0C4E11BB6DDEBB404F60',
});
const ID = 'E8FE3783F29E4FB297D8B006D0087725';
const PRE = '0A452E415E4AD37B6558D0F398A2A5A7A161D752148A70B21A4E8097740CA7D9';
const V4 = 'C2F7641F12F19FD1F78ABDB608DA9EF5A8B58DB087E30552ED3EDEE42AFCDF48';
const HOST = 'A3C7F581069BF0A2AF77AAC8F2441AF98AB42073C56443C257586931F35F6AB5';
const FINAL = 'F286CDC1B9D138E4429A50C3E82749292B39F51B42592BFD9B738C889A6FA074';
const CURRENT = Object.freeze({ ID, PRE, V4, HOST, FINAL });
const patch = name => path.join(runtime, 'patches', name);
const v3Patch = patch('reshade-injector-cooperative-members-v3.patch');
const v4Patch = patch('reshade-injector-cooperative-members.patch');
const hostPatch = patch('reshade-owned-late-d3d11.patch');
const resultPatch = patch('reshade-injector-first-host-result.patch');
const HOST_PATCH_SHA = '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE';
const RESULT_PATCH_SHA = 'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554';
const unavailable = spawnSync('cmake', ['--version'], { windowsHide: true }).status !== 0 ? 'CMake is unavailable' :
  spawnSync('git', ['--version'], { windowsHide: true }).status !== 0 ? 'Git is unavailable' : false;
const options = { skip: unavailable, timeout: 30000 };

function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function body(entry, shape) {
  if (!entry[shape]) return null;
  const text = fs.readFileSync(path.join(fixtureRoot, entry[shape].fixture), 'utf8');
  assert.equal(normalizedSha(text), entry[shape].normalizedSha256, `${shape} fixture ${entry.path}`);
  return normalize(text);
}
function copyShape(source, shape) {
  for (const entry of manifest.entries) {
    const text = body(entry, shape), file = path.join(source, entry.path);
    if (text !== null) write(file, text);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
function git(source, args) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(source) };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const result = spawnSync('git', args, { cwd: source, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function apply(f, patchPath) {
  const normalized = path.join(f.directory, `input-${crypto.randomBytes(4).toString('hex')}.patch`);
  write(normalized, normalize(fs.readFileSync(patchPath, 'utf8')));
  git(f.source, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', normalized]);
}
function injectorHash(f) { return normalizedSha(fs.readFileSync(f.injector, 'utf8')); }
function fixture(t, shape = 'host', generation = 16) {
  const lane = generation === 15 ? GEN15 : CURRENT;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-first-host-cache-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.ok(path.basename(directory).startsWith('ego-first-host-cache-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source'), binary = path.join(directory, 'binary');
  fs.mkdirSync(source); fs.mkdirSync(binary);
  copyShape(source, 'pristine');
  // Committed fixture text policy, independent of the user's global Git config.
  write(path.join(source, '.gitattributes'), '* text\n');
  git(source, ['init', '--quiet']);
  git(source, ['config', 'core.autocrlf', 'true']);
  git(source, ['config', 'user.name', 'EGO isolated fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']);
  git(source, ['add', '--all']);
  const hooks = path.join(directory, 'empty-hooks'); fs.mkdirSync(hooks);
  git(source, ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test fixture']);
  const f = { directory, source, binary, lane, commit: git(source, ['rev-parse', 'HEAD']), injector: path.join(source, 'tools/injector.cpp') };
  copyShape(source, 'base');
  // Independently reconstruct each injector stage from the immutable pre-coop
  // text and frozen patches, never from mutable canonical source caches.
  const pre = normalize(fs.readFileSync(preFixture, 'utf8'));
  assert.equal(normalizedSha(pre), 'E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359');
  write(f.injector, pre.replace('12EE788081A34E00B10862242DF38893', lane.ID));
  assert.equal(injectorHash(f), lane.PRE);
  apply(f, v4Patch); assert.equal(injectorHash(f), lane.V4);
  if (shape !== 'base') { apply(f, hostPatch); assert.equal(injectorHash(f), lane.HOST); }
  if (shape === 'final') { apply(f, resultPatch); assert.equal(injectorHash(f), lane.FINAL); }
  return f;
}
function snapshot(source) {
  const files = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === '.git') continue;
      const name = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) files.push({ path: name, type: 'link', target: fs.readlinkSync(file) });
      else if (entry.isDirectory()) walk(file, name + '/');
      else files.push({ path: name, type: 'file', sha256: sha(fs.readFileSync(file)) });
    }
  }
  walk(source); return files;
}
function run(f, action = 'prepare', overrides = {}) {
  assert.ok(helpers && tables, 'Production CMake helper/table blocks are required');
  assert.ok(helpers.includes('function(ego_apply_first_host_result_source_tail '), 'Production terminal helper is required');
  const expected = ['RESHAPE_EXPECTED_PATCHED_FILES', 'RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256']
    .filter(name => !tables.includes(`set(${name}`)).map(name => cmake.match(new RegExp(`^set\\(${name}\\s+[\\s\\S]*?^\\)`, 'm'))?.[0]);
  assert.ok(expected.every(Boolean));
  const script = path.join(f.directory, `guard-${crypto.randomBytes(4).toString('hex')}.cmake`);
  const globals = [
    `set(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID "${ID}")`,
    `set(RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 "${overrides.finalHash || FINAL}")`,
    `set(RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256 "${overrides.hostHash || HOST}")`,
    `set(RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 "${V4}")`,
    `set(RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256 "${PRE}")`,
    `set(RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256 "${GEN15.FINAL}")`,
    `set(RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256 "${GEN15.HOST}")`,
    `set(RESHAPE_GEN15_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 "${GEN15.V4}")`,
    `set(RESHAPE_GEN15_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256 "${GEN15.PRE}")`,
    `set(RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256 "${pin('RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256')}")`,
    `set(RESHAPE_PINNED_COMMIT "${f.commit}")`,
    `set(RESHAPE_OWNED_LATE_D3D11_PATCH ${q(overrides.hostPatch || hostPatch)})`,
    `set(RESHAPE_OWNED_LATE_D3D11_PATCH_SHA256 "${HOST_PATCH_SHA}")`,
    `set(RESHAPE_FIRST_HOST_RESULT_PATCH ${q(overrides.resultPatch || resultPatch)})`,
    `set(RESHAPE_FIRST_HOST_RESULT_PATCH_SHA256 "${overrides.resultPatchHash || RESULT_PATCH_SHA}")`,
    `set(RESHAPE_COOPERATIVE_MEMBERS_PATCH ${q(v4Patch)})`,
    `set(RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH ${q(v3Patch)})`,
  ];
  const calls = {
    prepare: [`ego_prepare_owned_late_source_cache(${q(f.source)})`],
    recover: [`ego_recover_owned_late_source_cache(${q(f.source)} ${q(f.journalPath || path.join(f.directory, 'missing-journal.json'))})`],
    tiny: [`ego_apply_first_host_result_source_tail(${q(f.source)})`],
    forward: [`ego_prepare_owned_late_source_cache(${q(f.source)})`, `ego_rollover_known_addon_build_id(${q(f.injector)})`,
      `ego_apply_owned_late_source_tail(${q(f.source)})`, `ego_apply_first_host_result_source_tail(${q(f.source)})`],
  };
  assert.ok(calls[action]);
  write(script, ['cmake_minimum_required(VERSION 3.24)', 'set(GIT_EXECUTABLE "git")',
    `set(CMAKE_CURRENT_SOURCE_DIR ${q(runtime)})`, `set(CMAKE_CURRENT_BINARY_DIR ${q(f.binary)})`,
    ...globals, tables, ...expected, ...globals,
    extract('verify_reshade_pinned_commit'), extract('verify_reshade_patched_source'), helpers, ...calls[action]].join('\n'));
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return spawnSync('cmake', ['-P', script], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
}
function accepted(result) { assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr || result.stdout); }
function rejected(f, action = 'prepare', overrides) {
  const before = snapshot(f.source), result = run(f, action, overrides);
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, 'Unknown inputs must fail closed');
  assert.deepEqual(snapshot(f.source), before, 'Every source byte and path survives rejection unchanged');
  return result;
}
function assertBase(f) {
  for (const entry of manifest.entries) {
    const file = path.join(f.source, entry.path);
    if (!entry.base) assert.equal(fs.existsSync(file), false, entry.path);
    else assert.equal(normalizedSha(fs.readFileSync(file, 'utf8')), entry.path === 'tools/injector.cpp' ? V4 : entry.base.normalizedSha256, entry.path);
  }
}
function alteredPatch(f, input) {
  const file = path.join(f.directory, 'altered.patch');
  write(file, normalize(fs.readFileSync(input, 'utf8')) + '\n# unexpected change\n');
  return file;
}
function normalizedVector(f) {
  return manifest.entries.map(entry => [entry.path, normalizedSha(fs.readFileSync(path.join(f.source, entry.path), 'utf8'))]);
}
function recoveryFixture(t, { schema = 2, generation = 15, shape = 'final' } = {}) {
  const f = fixture(t, shape, generation);
  f.completeBefore = snapshot(f.source);
  const sourceRoot = fs.realpathSync(f.source).replace(/\\/g, '/');
  const scratchRoot = path.join(f.binary, `ego-owned-late-peel-${crypto.randomBytes(12).toString('hex')}`);
  const beforeBytes = manifest.entries.map(entry => fs.readFileSync(path.join(f.source, entry.path)));
  for (const [index, entry] of manifest.entries.entries()) write(path.join(scratchRoot, 'before', entry.path), beforeBytes[index]);
  // Model an interrupted publication from a fully validated terminal vector.
  // Schema1 retains generation15 postimages; schema2 pins current16 postimages.
  const postLane = schema === 1 ? GEN15 : CURRENT;
  copyShape(f.source, 'base');
  const pre = normalize(fs.readFileSync(preFixture, 'utf8'));
  write(f.injector, pre.replace('12EE788081A34E00B10862242DF38893', postLane.ID));
  apply(f, v4Patch); assert.equal(injectorHash(f), postLane.V4);
  const afterBytes = manifest.entries.map(entry => {
    const file = path.join(f.source, entry.path); return fs.existsSync(file) ? fs.readFileSync(file) : null;
  });
  // Keep a real mixture of before/after images, including an already-published
  // injector. Every current image still has to match a hardcoded stage body.
  for (const [index, entry] of manifest.entries.entries()) if (index % 3 === 0 && entry.path !== 'tools/injector.cpp') {
    write(path.join(f.source, entry.path), beforeBytes[index]);
  }
  const journal = {
    schemaVersion: schema, sourceRoot, scratchRoot: scratchRoot.replace(/\\/g, '/'),
    finalInjectorHash: shape === 'host' ? f.lane.HOST : f.lane.FINAL,
    before: beforeBytes.map(bytes => sha(bytes).toLowerCase()),
    after: afterBytes.map(bytes => bytes === null ? 'ABSENT' : sha(bytes).toLowerCase()),
  };
  if (schema === 2) journal.postInjectorHash = V4;
  f.journalPath = path.join(f.directory, `.ego-source-cache-${sha(sourceRoot).toLowerCase()}.journal.json`);
  f.journal = journal; f.scratchRoot = scratchRoot;
  write(f.journalPath, JSON.stringify(journal));
  return f;
}
function writeJournal(f) { write(f.journalPath, JSON.stringify(f.journal)); }
function rejectedRecovery(f) {
  const journalBefore = fs.readFileSync(f.journalPath), backupsBefore = snapshot(f.scratchRoot);
  rejected(f, 'recover');
  assert.deepEqual(fs.readFileSync(f.journalPath), journalBefore, 'Rejected recovery preserves the data-only journal');
  assert.deepEqual(snapshot(f.scratchRoot), backupsBefore, 'Rejected recovery preserves every retained preimage');
}

test('terminal source fixtures and all reconstruction stages retain exact frozen hashes', () => {
  assert.equal(normalizedSha(fs.readFileSync(manifestPath, 'utf8')), '14F88C644EECCEE8460F3490C89C8F08F43E502BD806EAECB338A79B7A8CC107');
  assert.equal(manifest.entries.length, 19);
  assert.equal(pin('ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID'), ID);
  assert.equal(pin('RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256'), FINAL);
  assert.equal(pin('RESHAPE_PRE_RESULT_INJECTOR_CONTENT_SHA256'), HOST);
  assert.equal(pin('RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256'), V4);
  assert.equal(pin('RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256'), PRE);
  for (const [name, expected] of Object.entries({
    RESHAPE_GEN15_CURRENT_INJECTOR_CONTENT_SHA256: GEN15.FINAL,
    RESHAPE_GEN15_PRE_RESULT_INJECTOR_CONTENT_SHA256: GEN15.HOST,
    RESHAPE_GEN15_PRE_LATE_V4_INJECTOR_CONTENT_SHA256: GEN15.V4,
    RESHAPE_GEN15_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256: GEN15.PRE,
  })) assert.equal(pin(name), expected, name);
  assert.equal(normalizedSha(fs.readFileSync(v4Patch, 'utf8')), 'D4FC9A85D26C8458B7D22424402018579477205317E10A38DD0B7E472A448E56');
  assert.equal(normalizedSha(fs.readFileSync(hostPatch, 'utf8')), HOST_PATCH_SHA);
  assert.equal(normalizedSha(fs.readFileSync(resultPatch, 'utf8')), RESULT_PATCH_SHA);
  for (const entry of manifest.entries) for (const shape of ['pristine', 'base']) body(entry, shape);
});
for (const shape of ['host', 'final']) test(`${shape} complete19 cache peels to the exact pre-late vector`, options, t => {
  const f = fixture(t, shape); accepted(run(f)); assertBase(f);
});
for (const shape of ['host', 'final']) test(`generation15 ${shape} complete19 cache migrates to exact generation16 pre-late vector`, options, t => {
  const f = fixture(t, shape, 15); accepted(run(f)); assertBase(f);
});
for (const shape of ['host', 'final']) test(`generation15 ${shape} complete19 cache forwards to exact generation16 terminal vector`, options, t => {
  const f = fixture(t, shape, 15), expected = fixture(t, 'final');
  accepted(run(f, 'forward')); assert.deepEqual(normalizedVector(f), normalizedVector(expected));
});
test('terminal apply changes exactly the injector and preserves every other source byte', options, t => {
  const f = fixture(t), before = snapshot(f.source); accepted(run(f, 'tiny')); assert.equal(injectorHash(f), FINAL);
  const unchanged = files => files.filter(file => file.path !== 'tools/injector.cpp');
  assert.deepEqual(unchanged(snapshot(f.source)), unchanged(before));
});
test('already-terminal apply is idempotent after complete19 validation', options, t => {
  const f = fixture(t, 'final'), before = snapshot(f.source); accepted(run(f, 'tiny')); assert.deepEqual(snapshot(f.source), before);
});
test('actual prepare and both forward tails repeatedly reproduce the complete terminal vector', options, t => {
  const f = fixture(t, 'final');
  // The production forward host helper may publish Windows CRLF. Compare all
  // 19 normalized source bodies and retain raw-byte assertions for tiny alone.
  const normalizedVector = () => manifest.entries.map(entry => [entry.path, normalizedSha(fs.readFileSync(path.join(f.source, entry.path), 'utf8'))]);
  const expected = normalizedVector(); assert.equal(expected.length, 19);
  accepted(run(f, 'forward')); assert.deepEqual(normalizedVector(), expected);
  accepted(run(f, 'forward')); assert.deepEqual(normalizedVector(), expected);
});
for (const shape of ['host', 'final']) test(`unknown injector in ${shape} cache is rejected unchanged`, options, t => {
  const f = fixture(t, shape); write(f.injector, fs.readFileSync(f.injector, 'utf8') + '\n// unknown injector\n'); rejected(f);
});
test('old-host cache with unknown non-injector bytes fails before any peel', options, t => {
  const f = fixture(t), file = path.join(f.source, 'source/input.cpp'); write(file, fs.readFileSync(file, 'utf8') + '\n// unknown input\n'); rejected(f);
});
test('already-terminal tiny apply still rejects unknown host bytes unchanged', options, t => {
  const f = fixture(t, 'final'), file = path.join(f.source, 'source/input.cpp'); write(file, fs.readFileSync(file, 'utf8') + '\n// unknown input\n'); rejected(f, 'tiny');
});
test('terminal injector mixed with the pre-late other18 is rejected unchanged', options, t => {
  const f = fixture(t, 'final'), terminal = fs.readFileSync(f.injector); copyShape(f.source, 'base'); write(f.injector, terminal); rejected(f);
});
test('a partial first-host result tail is rejected before any live change', options, t => {
  const f = fixture(t), text = normalize(fs.readFileSync(resultPatch, 'utf8'));
  const second = text.indexOf('\n@@', text.indexOf('\n@@') + 1);
  assert.ok(second > 0); const partial = path.join(f.directory, 'partial.patch'); write(partial, text.slice(0, second) + '\n');
  apply(f, partial); assert.notEqual(injectorHash(f), HOST); assert.notEqual(injectorHash(f), FINAL); rejected(f);
});
for (const action of ['tiny', 'prepare']) test(`changed terminal patch fails ${action} without live mutation`, options, t => {
  const f = fixture(t, action === 'prepare' ? 'final' : 'host'); rejected(f, action, { resultPatch: alteredPatch(f, resultPatch) });
});
test('wrong declared terminal patch hash blocks atomic application unchanged', options, t => {
  const f = fixture(t); rejected(f, 'tiny', { resultPatchHash: '0'.repeat(64) });
});
test('wrong old-host stage pin blocks reverse migration unchanged', options, t => {
  const f = fixture(t, 'final'); rejected(f, 'prepare', { hostHash: '0'.repeat(64) });
});
test('changed host patch blocks terminal reverse migration unchanged', options, t => {
  const f = fixture(t, 'final'); rejected(f, 'prepare', { hostPatch: alteredPatch(f, hostPatch) });
});
test('wrong final pin blocks staged terminal publication unchanged', options, t => {
  const f = fixture(t); rejected(f, 'tiny', { finalHash: '0'.repeat(64) });
});

for (const shape of ['host', 'final']) test(`legacy schema1 generation15 ${shape} recovery restores exact originals then migrates to16`, options, t => {
  const f = recoveryFixture(t, { schema: 1, generation: 15, shape });
  accepted(run(f, 'recover')); assert.deepEqual(snapshot(f.source), f.completeBefore); assert.equal(fs.existsSync(f.journalPath), false);
  accepted(run(f)); assertBase(f);
});
for (const generation of [15, 16]) for (const shape of ['host', 'final']) test(`schema2 generation${generation} ${shape} recovery restores exact originals from generation16 postimages`, options, t => {
  const f = recoveryFixture(t, { schema: 2, generation, shape });
  accepted(run(f, 'recover')); assert.deepEqual(snapshot(f.source), f.completeBefore); assert.equal(fs.existsSync(f.journalPath), false);
  accepted(run(f)); assertBase(f);
});
test('unknown recovery schema preserves every live byte, journal and preimage', options, t => {
  const f = recoveryFixture(t); f.journal.schemaVersion = 99; writeJournal(f); rejectedRecovery(f);
});
test('legacy schema1 cannot select generation16 before images', options, t => {
  const f = recoveryFixture(t, { schema: 1, generation: 16 }); rejectedRecovery(f);
});
test('schema2 cannot select an unknown recorded before pin', options, t => {
  const f = recoveryFixture(t); f.journal.finalInjectorHash = '0'.repeat(64); writeJournal(f); rejectedRecovery(f);
});
test('schema2 cannot select a generation15 postimage pin', options, t => {
  const f = recoveryFixture(t); f.journal.postInjectorHash = GEN15.V4; writeJournal(f); rejectedRecovery(f);
});
test('schema2 mixed generation15 injector postimage is rejected despite a forged matching raw after hash', options, t => {
  const f = recoveryFixture(t), oldBase = fixture(t, 'base', 15);
  write(f.injector, fs.readFileSync(oldBase.injector));
  const index = manifest.entries.findIndex(entry => entry.path === 'tools/injector.cpp');
  f.journal.after[index] = sha(fs.readFileSync(f.injector)).toLowerCase(); writeJournal(f); rejectedRecovery(f);
});
test('schema2 unknown host postimage is rejected despite a forged matching raw after hash', options, t => {
  const f = recoveryFixture(t), relative = 'source/input.cpp', file = path.join(f.source, relative);
  write(file, fs.readFileSync(file, 'utf8') + '\n// unknown postimage\n');
  const index = manifest.entries.findIndex(entry => entry.path === relative);
  f.journal.after[index] = sha(fs.readFileSync(file)).toLowerCase(); writeJournal(f); rejectedRecovery(f);
});
