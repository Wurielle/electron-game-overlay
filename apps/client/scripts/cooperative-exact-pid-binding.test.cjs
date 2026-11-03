'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { collectExactPidBinding } = require('./cooperative-exact-pid-binding.cjs');

const stage = path.resolve('build', 'exact-pid-binding-fixture');
const image = path.resolve('build', 'controlled-demo', 'p.exe');
const target = { pid: 12345, executablePath: image };
const leaf = `ego-preload-${'a'.repeat(32)}-${'B'.repeat(32)}-${'c'.repeat(16)}.addon64`;
const invocation = { executable: path.join(stage, 'inject.exe'), workingDirectory: stage, arguments: [image, '--pid', '12345', '--expected-creation-time-100ns', '134380000000000001'] };
test('exact-PID invocation retains the full nonsecret creation binding', () => {
  const result = collectExactPidBinding(invocation, target);
  assert.equal(result.pid, target.pid);
  assert.equal(result.creationTime100ns, '134380000000000001');
  assert.equal(result.executablePath, image);
  assert.deepEqual(result.arguments, invocation.arguments);
});
test('preloaded and unregistered addon-only invocations preserve their scopes', () => {
  assert.equal(collectExactPidBinding({ ...invocation, arguments: [...invocation.arguments, '--preloaded-addon-name', leaf] }, target).preloadedAddonName, leaf);
  assert.equal(collectExactPidBinding({ ...invocation, arguments: [...invocation.arguments, '--addon-only'] }, target).preloadedAddonName, undefined);
});

test('x86 handoff preserves the exact creation binding and selects the x86 registered implementation', () => {
  const x86 = { ...invocation, executable: path.join(stage, 'inject32.exe'),
    arguments: [...invocation.arguments, '--preloaded-addon-name', leaf.replace('.addon64', '.addon32')] };
  const result = collectExactPidBinding(x86, target);
  assert.equal(result.creationTime100ns, '134380000000000001');
  assert.equal(path.basename(result.injectorExecutable), 'inject32.exe');
  assert.equal(result.preloadedAddonName, leaf.replace('.addon64', '.addon32'));
  assert.deepEqual(result.arguments, x86.arguments);
  assert.equal(collectExactPidBinding({ ...x86, arguments: [...invocation.arguments, '--addon-only'] }, target).preloadedAddonName, undefined);
});
for (const [name, update] of [
  ['PID changed', { arguments: [image, '--pid', '12346', '--expected-creation-time-100ns', '134380000000000001'] }],
  ['creation omitted', { arguments: [image, '--pid', '12345'] }],
  ['creation overflows FILETIME', { arguments: [image, '--pid', '12345', '--expected-creation-time-100ns', '18446744073709551616'] }],
  ['duplicate PID', { arguments: [...invocation.arguments, '--pid', '12345'] }],
  ['relative image', { arguments: ['p.exe', ...invocation.arguments.slice(1)] }],
  ['different image', { arguments: [path.resolve('other.exe'), ...invocation.arguments.slice(1)] }],
  ['unknown argument', { arguments: [...invocation.arguments, '--token', 'secret'] }],
  ['selector escapes directory', { arguments: [...invocation.arguments, '--preloaded-addon-name', `../${leaf}`] }],
  ['selector value omitted', { arguments: [...invocation.arguments, '--preloaded-addon-name'] }],
  ['injector outside stage', { executable: path.resolve('other-stage', 'inject.exe') }],
  ['injector wrong executable', { executable: path.join(stage, 'other.exe') }],
  ['x86 selector with x64 injector', { arguments: [...invocation.arguments, '--preloaded-addon-name', leaf.replace('.addon64', '.addon32')] }],
  ['x64 selector with x86 injector', { executable: path.join(stage, 'inject32.exe'), arguments: [...invocation.arguments, '--preloaded-addon-name', leaf] }],
]) {
  test(name, () => assert.throws(() => collectExactPidBinding({ ...invocation, ...update }, target)));
}
