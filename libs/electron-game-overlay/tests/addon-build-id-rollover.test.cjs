'use strict';
// Only the extracted CMake guard runs in script mode. Fixtures are reconstructed
// in owned temporary directories; no project configure, compiler, executable,
// canonical source cache or installation is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runtimeRoot = path.join(root, 'libs/electron-game-overlay-runtime');
const cmake = fs.readFileSync(path.join(runtimeRoot, 'CMakeLists.txt'), 'utf8');
const guard = cmake.match(/^function\(ego_rollover_known_addon_build_id source_path\)\r?\n[\s\S]*?^endfunction\(\)/m)?.[0];
const value = name => cmake.match(new RegExp(`set\\(${name}\\s+"([0-9A-F]+)"\\s*\\)`))?.[1];
const newId = value('ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID');
const fullHash = value('RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256');
const preHash = value('RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256');
const preX86Hash = value('RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256');
const currentPatch = path.join(runtimeRoot, 'patches/reshade-injector-cooperative-members.patch');
const historicalPatch = path.join(runtimeRoot, 'patches/reshade-injector-cooperative-members-v3.patch');
const baseline = path.join(runtimeRoot, 'tests/cooperative-injector-migration/fixtures/pre-cooperative-injector.cpp.txt');
const baselineHash = 'E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359';
const baselineId = '12EE788081A34E00B10862242DF38893';
const gen11V4Hash = 'D0A885F093B5364FF7ED1D84761E758E7544579185E9EEA8517B4058D7C29B94';
const gen12Build = {
  id: 'E975AA8639164AED979E9770674B9546',
  full: 'C436078556B22BDAD9DFCD662A745E73339758E227F0178234B41D1392956974',
  pre: '0BAE44EE68E401993FA662BAF8BE79F985F6BCB87DC3A0818BFD80FD9574DDEB',
};
const gen13Build = {
  id: '4127FD92CC904E0AA75C7784189AE969',
  full: '3A58324E3AE6CE96F3F312D965A384CB825B27B64CE3E4E95CF4B4194032946C',
  pre: '4EEA17F39E3BFF425CCD08246DDA121FE256A61B37D0FD5D93565FC83E9DAA7D',
};
const normalized = text => text.replace(/\r\n?/g, '\n');
const sha = text => createHash('sha256').update(normalized(text)).digest('hex').toUpperCase();
const previousBuilds = [
  { generation: 8, id: 'A8E9DA12477741B9979D9B1B51994EF3',
    full: '246B4B1DC7259C2EBF4BC4C4278B03B5083507FAE8BDB071B264692F73730135',
    pre: '007B4DF39CEB0C7E6777B990A9A24D352DBC399C79DCA8488E9F4E49C58FB166' },
  { generation: 9, id: '3309FB779CFC4E39BA7681AA4A7F8A6B',
    full: '88E5980C5737539918CDFD0A4070802780B44FA5FBCA2BB251B79952F180C621',
    pre: '956A8530DD5C4C9F73C3372CE6C25A13E1AB230746B6A8CC26E7EC349CE50309' },
  { generation: 10, id: '280C7D267CA94332834D85A075A453AE',
    full: '5F4C08D04AB5E720851326EB72DED1D59D9E1924036B866CAC6E56602417C377',
    pre: '816BF5F33495D3B280A2E319D565FA2D310BF10A409FDC580B6ED8B4358B71C8' },
  { generation: 11, id: 'E16461475E524DBA83398B19CDD95EBB',
    full: '5265F91C9308F755CF585EA7C3083E60DF48AED6CDC435C25518B7130A748F5B',
    pre: '1903E98A0462431D4A355A3CCE0E3B69AB8E5C67B7895080DA9F9EF8D75CA410' },
];
assert.ok(guard, 'The tracked CMake source-cache guard is required');
assert.ok(fs.existsSync(baseline), 'The tracked immutable pre-cooperative fixture is required');
assert.ok(fs.existsSync(historicalPatch), 'The tracked immutable v3 migration patch is required');
const prerequisiteReason = spawnSync('cmake', ['--version'], { windowsHide: true }).status !== 0 ? 'CMake is unavailable' :
  spawnSync('git', ['--version'], { windowsHide: true }).status !== 0 ? 'Git is unavailable' : false;
const options = { skip: prerequisiteReason };

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-addon-id-rollover-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.ok(path.basename(directory).startsWith('ego-addon-id-rollover-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function originalBaseline() {
  const source = fs.readFileSync(baseline, 'utf8');
  assert.equal(sha(source), baselineHash, 'Historical fixture must retain its independently pinned body');
  assert.equal(source.split(baselineId).length - 1, 1, 'Baseline identity must occur exactly once');
  return normalized(source);
}

function preCooperative(id) {
  return originalBaseline().replace(baselineId, id);
}

function terminal(t, patch, id) {
  const directory = temporary(t);
  const file = path.join(directory, 'tools/injector.cpp');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, originalBaseline());
  const gitEnvironment = { ...process.env, GIT_CEILING_DIRECTORIES: directory };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnvironment[key];
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', patch], {
    cwd: directory, env: gitEnvironment, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.equal(applied.status, 0, applied.stderr);
  return normalized(fs.readFileSync(file, 'utf8')).replace(baselineId, id);
}

const cmakeArgument = text => `[==[${text.replace(/\\/g, '/')}]==]`;
function runGuard(t, input, overrides = {}) {
  const directory = temporary(t);
  const file = path.join(directory, 'source/tools/injector.cpp');
  const binary = path.join(directory, 'scratch');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(binary);
  fs.writeFileSync(file, input);
  const before = fs.readFileSync(file);
  const script = path.join(directory, 'guard.cmake');
  fs.writeFileSync(script, [
    'cmake_minimum_required(VERSION 3.24)',
    `set(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID "${newId}")`,
    `set(RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 "${overrides.fullHash || fullHash}")`,
    `set(RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256 "${overrides.preHash || preHash}")`,
    `set(RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256 "${preX86Hash}")`,
    `set(RESHAPE_COOPERATIVE_MEMBERS_PATCH ${cmakeArgument(overrides.currentPatch || currentPatch)})`,
    ...(overrides.historicalPatch ? [`set(RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH ${cmakeArgument(overrides.historicalPatch)})`] : []),
    'set(GIT_EXECUTABLE "git")',
    `set(CMAKE_CURRENT_SOURCE_DIR ${cmakeArgument(overrides.runtimeRoot || runtimeRoot)})`,
    `set(CMAKE_CURRENT_BINARY_DIR ${cmakeArgument(binary)})`,
    guard,
    `ego_rollover_known_addon_build_id(${cmakeArgument(file)})`,
  ].join('\n'));
  const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return { ...result, before, output: fs.readFileSync(file), directory };
}

function assertAccepted(result, expectedHash) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(sha(result.output.toString('utf8')), expectedHash);
}

function assertRejectedWithoutWriting(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, 'Invalid input or contract must fail the isolated CMake guard');
  assert.deepEqual(result.output, result.before, 'Rejected migration must preserve every original source byte');
}

for (const previous of previousBuilds) {
  test(`known generation ${previous.generation} v3 full cache migrates its real historical body to the current v4 pin`, options, t => {
    const old = terminal(t, historicalPatch, previous.id);
    assert.equal(sha(old), previous.full, 'Historical source is reconstructed from frozen v3, never the new canonical body');
    const input = previous.generation % 2 ? old : old.replace(/\n/g, '\r\n');
    assert.equal(sha(input), previous.full, 'Line-ending fixture must preserve the historical normalized body');
    const result = runGuard(t, input);
    assertAccepted(result, fullHash);
    assert.equal(result.output.toString('utf8').split(newId).length - 1, 1);
  });
  test(`known generation ${previous.generation} pre-cooperative cache keeps the lower-stack migration boundary`, options, t => {
    const old = preCooperative(previous.id);
    assert.equal(sha(old), previous.pre);
    assertAccepted(runGuard(t, old), preHash);
  });
  test(`unknown edits to generation ${previous.generation} v3 source fail without rewriting its matching old identity`, options, t => {
    const source = terminal(t, historicalPatch, previous.id) + '\r\n// unrecognized source change\r\n';
    assertRejectedWithoutWriting(runGuard(t, source));
  });
}

test('known generation 11 v4 authoring source rolls only its exact identity to the current v4 pin', options, t => {
  const source = terminal(t, currentPatch, previousBuilds[3].id);
  assert.equal(sha(source), gen11V4Hash);
  assertAccepted(runGuard(t, source), fullHash);
});

test('known generation 12 v4 source rolls its independently pinned body to the current v4 identity', options, t => {
  const source = terminal(t, currentPatch, gen12Build.id);
  assert.equal(sha(source), gen12Build.full);
  assertAccepted(runGuard(t, source), fullHash);
});

test('known generation 12 pre-cooperative source retains the exact historical lower-stack bridge', options, t => {
  const source = preCooperative(gen12Build.id);
  assert.equal(sha(source), gen12Build.pre);
  assertAccepted(runGuard(t, source), preHash);
});

test('known generation 13 v4 source rolls its independently pinned body to the current v4 identity', options, t => {
  const source = terminal(t, currentPatch, gen13Build.id);
  assert.equal(sha(source), gen13Build.full);
  assertAccepted(runGuard(t, source), fullHash);
});

test('known generation 13 pre-cooperative source retains the exact historical lower-stack bridge', options, t => {
  const source = preCooperative(gen13Build.id);
  assert.equal(sha(source), gen13Build.pre);
  assertAccepted(runGuard(t, source), preHash);
});

test('current v4 source is byte-for-byte idempotent on repeated guard execution', options, t => {
  const source = terminal(t, currentPatch, newId);
  assert.equal(sha(source), fullHash);
  const first = runGuard(t, source);
  assertAccepted(first, fullHash);
  assert.deepEqual(first.output, first.before);
  const second = runGuard(t, first.output);
  assertAccepted(second, fullHash);
  assert.deepEqual(second.output, first.output);
});

test('wrong expected v4 output hash fails before writing even a known v3 full cache', options, t => {
  const source = terminal(t, historicalPatch, previousBuilds[3].id);
  assertRejectedWithoutWriting(runGuard(t, source, { fullHash: '0'.repeat(64) }));
});

test('wrong expected pre-cooperative output hash fails before writing a known lower-stack cache', options, t => {
  assertRejectedWithoutWriting(runGuard(t, preCooperative(previousBuilds[3].id), { preHash: '0'.repeat(64) }));
});

test('an edited current v4 source is rejected rather than peeled or normalized', options, t => {
  const source = terminal(t, currentPatch, newId) + '\n// local v4 change\n';
  assertRejectedWithoutWriting(runGuard(t, source));
});

test('unsupported bare-CR source is rejected without rewriting otherwise recognized historical bytes', options, t => {
  const source = terminal(t, historicalPatch, previousBuilds[3].id).replace(/\n/g, '\r');
  assert.equal(sha(source), previousBuilds[3].full);
  assertRejectedWithoutWriting(runGuard(t, source));
});

test('a substituted current migration patch cannot alter a recognized v3 source', options, t => {
  const directory = temporary(t);
  const patch = path.join(directory, 'unexpected-v4.patch');
  fs.writeFileSync(patch, fs.readFileSync(currentPatch, 'utf8') + '\n# unexpected patch bytes\n');
  const source = terminal(t, historicalPatch, previousBuilds[3].id);
  assertRejectedWithoutWriting(runGuard(t, source, { currentPatch: patch }));
});

test('a substituted historical migration patch fails before changing recognized source bytes', options, t => {
  const directory = temporary(t);
  const patches = path.join(directory, 'patches');
  fs.mkdirSync(patches);
  fs.writeFileSync(path.join(patches, path.basename(historicalPatch)), fs.readFileSync(historicalPatch, 'utf8') + '\n# unexpected patch bytes\n');
  const source = terminal(t, historicalPatch, previousBuilds[3].id);
  assertRejectedWithoutWriting(runGuard(t, source, { runtimeRoot: directory }));
});

test('CRLF and BOM migration patch copies apply their exact normalized bytes to a BOM source', options, t => {
  const directory = temporary(t);
  const copies = {};
  for (const [name, original] of [['historicalPatch', historicalPatch], ['currentPatch', currentPatch]]) {
    copies[name] = path.join(directory, name + '.patch');
    fs.writeFileSync(copies[name], '\uFEFF' + normalized(fs.readFileSync(original, 'utf8')).replace(/\n/g, '\r\n'));
  }
  const source = terminal(t, historicalPatch, previousBuilds[3].id);
  assertAccepted(runGuard(t, '\uFEFF' + source.replace(/\n/g, '\r\n'), copies), fullHash);
});

test('the pinned pristine upstream injector remains unchanged for the historical patch stack', options, t => {
  const repository = path.join(root, 'build/electron-game-overlay-runtime/_deps/reshade-src');
  if (!fs.existsSync(repository)) { t.skip('Retained upstream Git objects are unavailable'); return; }
  const result = spawnSync('git', ['-C', repository, 'show', '4a50d1eddace85734871d91792ff214f13f66c01:tools/injector.cpp'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) { t.skip('The pinned upstream injector Git object is unavailable'); return; }
  assert.equal(sha(result.stdout), '26CFBBFFD692ACFB24BD19CBD93B3C7F81F24555EA67B75C55FAD14861E38B00');
  const observed = runGuard(t, result.stdout);
  assertAccepted(observed, '26CFBBFFD692ACFB24BD19CBD93B3C7F81F24555EA67B75C55FAD14861E38B00');
  assert.deepEqual(observed.output, observed.before);
});

const preX86Fixture = process.env.EGO_PRE_X86_INJECTOR_FIXTURE;
test('a retained pre-x86 injector keeps its historical boundary byte-for-byte', {
  skip: prerequisiteReason || (!preX86Fixture ? 'No independently retained pre-x86 fixture; EGO_PRE_X86_INJECTOR_FIXTURE may provide the pinned source' : false),
}, t => {
  const source = fs.readFileSync(preX86Fixture, 'utf8');
  assert.equal(sha(source), preX86Hash);
  const observed = runGuard(t, source);
  assertAccepted(observed, preX86Hash);
  assert.deepEqual(observed.output, observed.before);
});
