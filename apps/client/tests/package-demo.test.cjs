const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyProductionGraph, validateClientAssets, validatePayloads } = require('../scripts/package-demo.cjs');

test('packaged manifest has concrete installed versions, not workspace install paths', () => {
  const { createAppManifest } = require('../scripts/package-demo.cjs');
  assert.equal(typeof createAppManifest, 'function');
  const manifest = createAppManifest({ version: '1.0.1', dependencies: { sdk: 'file:libs/sdk', monitor: '^3' } }, {
    dependencies: { sdk: { version: '0.0.1' }, monitor: { version: '3.0.2' } },
  });
  assert.deepEqual(manifest.dependencies, { sdk: '0.0.1', monitor: '3.0.2' });
  assert.equal(manifest.main, 'dist/main/main.js');
});

test('package output cannot overlap source or dependency trees', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const { packageDemo } = require('../scripts/package-demo.cjs');
  const root = path.resolve(__dirname, '../../..');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const parent of ['node_modules/electron/dist', 'apps/client/dist', 'libs/electron-game-overlay']) {
      assert.throws(() => packageDemo(path.join(root, parent, 'not-a-package-output')), /output.*artifacts/i);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('file URL assets resolve; absolute URLs and missing support files fail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-assets-test-'));
  try {
    for (const name of ['index', 'main', 'process-watcher']) fs.mkdirSync(path.join(root, name));
    for (const name of ['renderer.js', 'main/main.js', 'process-watcher/index.cjs']) fs.writeFileSync(path.join(root, name), '// fixture');
    fs.writeFileSync(path.join(root, 'index/index.html'), '<script src="../renderer.js"></script>');
    validateClientAssets(root);
    fs.writeFileSync(path.join(root, 'index/index.html'), '<script src="/renderer.js"></script>');
    assert.throws(() => validateClientAssets(root), /relative/);
    fs.writeFileSync(path.join(root, 'index/index.html'), '<script src="../missing.js"></script>');
    assert.throws(() => validateClientAssets(root), /missing|ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing genuine native payload is an explicit packaging failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-payload-test-'));
  try { assert.throws(() => validatePayloads(root), /ENOENT|missing/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows runtime harness refuses Linux rather than fabricating execution', { skip: process.platform === 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/smoke-packaged-demo.cjs'), '--package', path.join(os.tmpdir(), 'unused-demo')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires Windows x64/);
});

test('production closure dereferences workspace, preserves nested versions, excludes Electron and dev trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-package-test-'));
  try {
    const write = (p, value) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); };
    const sdk = path.join(root, 'sdk');
    write(path.join(sdk, 'package.json'), '{"name":"sdk"}');
    write(path.join(sdk, 'dist/index.js'), 'module.exports=1');
    write(path.join(sdk, 'src/dev.ts'), 'not shipped');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(sdk, path.join(root, 'node_modules/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
    const a = path.join(root, 'node_modules/a');
    const nested = path.join(a, 'node_modules/b');
    write(path.join(a, 'package.json'), '{"name":"a"}');
    write(path.join(nested, 'package.json'), '{"name":"b","version":"2"}');
    write(path.join(a, 'node_modules/dev/package.json'), '{}');
    const output = path.join(root, 'out');
    copyProductionGraph(root, output, { dependencies: { sdk: { path: path.join(root, 'node_modules/sdk'), dependencies: { electron: { path: '/not/copied' } } }, a: { path: a, dependencies: { b: { path: nested } } } } });
    assert.equal(fs.lstatSync(path.join(output, 'node_modules/sdk')).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/sdk/src')), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/sdk/dist/index.js')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'node_modules/a/node_modules/b/package.json'))).version, '2');
    assert.equal(fs.existsSync(path.join(output, 'node_modules/a/node_modules/dev')), false);
    assert.equal(fs.existsSync(path.join(output, 'node_modules/electron')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
