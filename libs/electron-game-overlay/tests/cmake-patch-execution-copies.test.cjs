'use strict';
// Actual CMake helpers in script mode only. Patches remain passive text inputs;
// no project configure, build, native code or canonical source cache executes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const runtime = path.join(root, 'libs/electron-game-overlay-runtime');
const cmake = fs.readFileSync(path.join(runtime, 'CMakeLists.txt'), 'utf8');
const helpers = cmake.match(/# BEGIN EGO_SOURCE_CACHE_MIGRATION_HELPERS\r?\n([\s\S]*?)# END EGO_SOURCE_CACHE_MIGRATION_HELPERS/u)?.[1];
assert.ok(helpers, 'The actual marked production helper definitions are required');
assert.match(helpers, /function\(ego_normalize_reshade_patch_inputs\)/u);
const unavailable = spawnSync('cmake', ['--version'], { windowsHide: true }).status !== 0 ? 'CMake is unavailable' : false;
const options = { skip: unavailable, timeout: 30000 };
const quoted = value => `[==[${value.replace(/\\/g, '/')}]==]`;
const normalize = value => value.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-patch-copies-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.ok(path.basename(directory).startsWith('ego-patch-copies-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function run(directory, declarations, names, binary = path.join(directory, 'binary')) {
  const script = path.join(directory, 'guard.cmake');
  const report = path.join(directory, 'paths.txt');
  fs.writeFileSync(script, [
    'cmake_minimum_required(VERSION 3.24)',
    `set(CMAKE_CURRENT_SOURCE_DIR ${quoted(runtime)})`,
    `set(CMAKE_CURRENT_BINARY_DIR ${quoted(binary)})`,
    'set(NAME "MUST_NOT_EXPAND_AT_PLACEHOLDERS")',
    'set(literal "MUST_NOT_EXPAND_DOLLAR_PLACEHOLDERS")',
    declarations,
    helpers,
    'ego_normalize_reshade_patch_inputs()',
    `file(WRITE ${quoted(report)} "")`,
    ...names.map(name => `file(APPEND ${quoted(report)} "${name}|\${${name}}\n")`),
    'foreach(copy_path IN LISTS RESHAPE_SOURCE_PATCHES)',
    `  file(APPEND ${quoted(report)} "SOURCE|\${copy_path}\n")`,
    'endforeach()',
  ].join('\n'));
  const before = fs.readdirSync(directory).sort();
  const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const paths = fs.existsSync(report) ? normalize(fs.readFileSync(report, 'utf8')).trim().split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('|');
    return { name: line.slice(0, separator), file: line.slice(separator + 1) };
  }) : [];
  return { ...result, paths, binary, before };
}

function assertShortCopy(file, binary) {
  const relative = path.relative(binary, file).split(path.sep).join('/');
  assert.match(relative, /^\.ep-[0-9a-f]{8}\/p[0-9]+\.patch$/u);
  assert.ok(file.length <= 240, `Execution copy exceeds the Windows-safe limit: ${file}`);
}

test('CRLF/BOM inputs retain literal placeholders and rebind scalar/list aliases to exact LF execution copies', options, t => {
  const directory = temporary(t);
  const first = path.join(directory, 'descriptive-original-injector-patch-name.patch');
  const second = path.join(directory, 'another-source.patch');
  const firstText = 'diff --git a/example.cpp b/example.cpp\n--- a/example.cpp\n+++ b/example.cpp\n@@ -1 +1 @@\n-old\n+const char *value = "@NAME@ ${literal}";\n';
  const secondText = 'diff --git a/other.cpp b/other.cpp\n--- a/other.cpp\n+++ b/other.cpp\n@@ -1 +1 @@\n-a\n+b\n';
  fs.writeFileSync(first, '\uFEFF' + firstText.replace(/\n/g, '\r\n'));
  fs.writeFileSync(second, secondText);
  const originals = [fs.readFileSync(first), fs.readFileSync(second)];
  const names = ['RESHAPE_SAMPLE_PATCH', 'RESHAPE_ALIAS_PATCH'];
  const result = run(directory, [
    `set(RESHAPE_SAMPLE_PATCH ${quoted(first)})`,
    `set(RESHAPE_ALIAS_PATCH ${quoted(first)})`,
    `set(RESHAPE_SOURCE_PATCHES ${quoted(first)} ${quoted(second)})`,
  ].join('\n'), names);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.paths.length, 4);
  const expected = [firstText, firstText, firstText, secondText];
  for (const [index, entry] of result.paths.entries()) {
    assertShortCopy(entry.file, result.binary);
    assert.notEqual(path.resolve(entry.file), first);
    assert.notEqual(path.resolve(entry.file), second);
    assert.deepEqual(fs.readFileSync(entry.file), Buffer.from(expected[index]));
  }
  assert.deepEqual(fs.readFileSync(first), originals[0]);
  assert.deepEqual(fs.readFileSync(second), originals[1]);
});

test('overlong binary directories fail before any execution directory or copy is written', options, t => {
  const directory = temporary(t);
  const input = path.join(directory, 'original.patch');
  const bytes = Buffer.from('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n');
  fs.writeFileSync(input, bytes);
  const binary = path.join(directory, 'too-long-' + 'x'.repeat(180));
  assert.ok((binary + '/.ep-12345678/p999.patch').length > 240);
  const result = run(directory, `set(RESHAPE_SAMPLE_PATCH ${quoted(input)})\nset(RESHAPE_SOURCE_PATCHES ${quoted(input)})`, ['RESHAPE_SAMPLE_PATCH'], binary);
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /normalized patch execution directory exceeds the Windows-safe bound/u);
  assert.equal(fs.existsSync(binary), false);
  assert.equal(result.paths.length, 0);
  assert.deepEqual(fs.readdirSync(directory).sort(), result.before);
  assert.deepEqual(fs.readFileSync(input), bytes);
});

test('every actual runtime patch declaration receives a short byte-exact execution copy without changing originals', options, t => {
  const directory = temporary(t);
  const declarations = cmake.slice(cmake.indexOf('set(RESHAPE_SOURCE_PATCHES'), cmake.indexOf('# BEGIN EGO_SOURCE_CACHE_MIGRATION_TABLES'));
  const names = [...declarations.matchAll(/^set\((RESHAPE_[A-Z0-9_]+_PATCH)\s/gmu)].map(match => match[1]);
  const scalarOriginals = names.map(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const relative = declarations.match(new RegExp(`set\\(${escaped}\\s+"\\$\\{CMAKE_CURRENT_SOURCE_DIR\\}/([^"\\r\\n]+)"`))?.[1];
    assert.ok(relative, `Actual patch path is not a local literal: ${name}`);
    return path.join(runtime, relative);
  });
  const sourceBlock = declarations.match(/^set\(RESHAPE_SOURCE_PATCHES\s+([\s\S]*?)^\)/mu)?.[1];
  assert.ok(sourceBlock);
  const sourceOriginals = [...sourceBlock.matchAll(/"\$\{CMAKE_CURRENT_SOURCE_DIR\}\/([^"\r\n]+)"/gu)].map(match => path.join(runtime, match[1]));
  const originals = [...scalarOriginals, ...sourceOriginals];
  assert.ok(originals.length >= 32, 'The complete production patch input set must be exercised');
  const bytes = originals.map(file => fs.readFileSync(file));
  const result = run(directory, declarations, names);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.paths.length, originals.length);
  for (const [index, entry] of result.paths.entries()) {
    assertShortCopy(entry.file, result.binary);
    assert.deepEqual(fs.readFileSync(entry.file), Buffer.from(normalize(bytes[index].toString('utf8'))), originals[index]);
    assert.deepEqual(fs.readFileSync(originals[index]), bytes[index]);
  }
});
