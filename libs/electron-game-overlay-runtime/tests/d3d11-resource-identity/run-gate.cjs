'use strict';
// Real production hooks, offscreen native COM boundaries only. No game/input/UI.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--architecture', '--runtime', '--baseline-runtime'].includes(args[i]));
  assert.ok(args[i + 1]); options[args[i]] = args[i + 1];
}
const architecture = options['--architecture'] ?? 'x64';
assert.ok(['x64', 'x86'].includes(architecture));
const base = path.join(root, 'build/overlay-compatibility');
const build = path.join(base, 'native-fixture-' + architecture);
const runtime = path.resolve(options['--runtime'] ?? path.join(root, 'libs/electron-game-overlay-runtime/dist', architecture === 'x64' ? 'win32-x64/ReShade64.dll' : 'win32-ia32/ReShade32.dll'));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const execute = (exe, args, timeout = 120000) => {
  const r = cp.spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${exe} failed\n${r.stdout}\n${r.stderr}`);
  return r;
};
fs.mkdirSync(base, { recursive: true });
execute('cmake.exe', ['-S', __dirname, '-B', build, '-A', architecture === 'x64' ? 'x64' : 'Win32']);
execute('cmake.exe', ['--build', build, '--config', 'Release', '--parallel', '4']);
const fixture = path.join(build, 'Release/d3d11_resource_identity.exe');
const cases = [
  ['clean', '-', 'hardware', 'expect-match'],
  ['current-hardware', runtime, 'hardware', 'expect-match'],
  ['current-video', runtime, 'video', 'expect-match'],
  ['current-warp', runtime, 'warp', 'expect-match'],
];
if (options['--baseline-runtime']) cases.push(['baseline-regression', path.resolve(options['--baseline-runtime']), 'hardware', 'expect-mismatch']);
const results = [];
for (const [name, dll, mode, expectation] of cases) {
  const directory = path.join(base, 'identity-' + architecture + '-' + name);
  const owner = path.join(directory, '.fixture-owner.json');
  if (fs.existsSync(directory)) {
    assert.equal(JSON.parse(fs.readFileSync(owner, 'utf8')).kind, 'ego-offscreen-identity-fixture');
  } else {
    fs.mkdirSync(path.join(directory, 'addons'), { recursive: true });
    fs.writeFileSync(owner, JSON.stringify({ kind: 'ego-offscreen-identity-fixture', architecture, name }));
  }
  fs.writeFileSync(path.join(directory, 'ReShade.ini'), '[ADDON]\nAddonPath=' + path.join(directory, 'addons') + '\n');
  const run = execute(fixture, [dll, directory, mode, expectation], 20000);
  fs.writeFileSync(path.join(directory, 'stdout.log'), run.stdout);
  fs.writeFileSync(path.join(directory, 'stderr.log'), run.stderr);
  const records = run.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const final = records.at(-1);
  assert.equal(final.status, 'passed'); assert.equal(final.offscreen, true);
  if (name === 'current-hardware') assert.equal(final.wrapped, true);
  results.push({ name, expectation, runtime: dll, runtimeSha256: dll === '-' ? null : sha(dll), records });
}
const report = { kind: 'ego-d3d11-composition-resource-identity-native-regression', status: 'passed', architecture, fixtureSha256: sha(fixture), cases: results,
  scope: 'Actual D3D11 devices and offscreen composition swapchains under the supplied production ReShade DLL; first back buffer, resource/IUnknown interfaces, resize, reference balance, video support and unwrapped WARP. No HWND, Present, overlay, application, game or input acceptance.',
  runtimeCopiesCreated: 0, actualHighTokenAcceptance: false };
const output = path.join(base, 'identity-' + architecture + '-report.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, architecture, cases: results.length, output }));
