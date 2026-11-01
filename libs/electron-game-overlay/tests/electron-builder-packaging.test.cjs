const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { createHash } = require('node:crypto');
const {
  packageOverlayForElectronBuilder,
  verifyOverlayPackage,
  createOverlayAfterPack,
} = require('../dist/packaging.js');
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-packaging-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const sdk = path.join(root, 'pnpm-store', 'electron-game-overlay'),
    out = path.join(root, 'out'),
    leaf = path.join(sdk, 'dist/broker/win32-x64');
  const write = async (relative, bytes) => {
    const f = path.join(sdk, relative);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, bytes);
  };
  await fs.mkdir(out, { recursive: true });
  await write(
    'package.json',
    JSON.stringify({ name: 'electron-game-overlay', version: '0.1.0-rc.5' }),
  );
  await write('LICENSE', 'GPL');
  await write('SDK_PROVENANCE.json', '{"workingTreeDirty":true}');
  await write('node_modules/.bin/electron.cmd', 'peer wrapper must not copy');
  await write('private-source.txt', 'not distributed');
  const payload = {
    'electron-game-overlay-broker.exe': 'inert fixture, never executed',
    'node_modules/tslib/CopyrightNotice.txt': 'immutable nested notice',
    'node_modules/tslib/tslib.js': 'fixture module',
    'licenses/node.txt': 'node notice',
    'lib/module.js': 'module',
    'runtime/THIRD-PARTY-NOTICES.txt': 'runtime notice',
  };
  const files = [];
  for (const [name, value] of Object.entries(payload)) {
    const bytes = Buffer.from(value);
    await write('dist/broker/win32-x64/' + name, bytes);
    files.push({ path: name, size: bytes.length, sha256: sha(bytes) });
    if (/^(lib|runtime)\//.test(name)) await write('dist/' + name, bytes);
  }
  await write('dist/index.js', 'module.exports={}');
  await write('dist/index.d.ts', 'export {}');
  await write(
    'dist/broker/win32-x64/broker-manifest.json',
    JSON.stringify({
      schema: 1,
      version: '0.1.0-rc.5',
      protocolMin: 1,
      protocolMax: 1,
      platform: 'win32',
      arch: 'x64',
      executable: 'electron-game-overlay-broker.exe',
      files,
    }),
  );
  return {
    root,
    sdk,
    out,
    leaf,
    write,
    context: { appOutDir: out, electronPlatformName: 'win32' },
    destination: path.join(
      out,
      'resources/app.asar.unpacked/node_modules/electron-game-overlay',
    ),
  };
}
test('afterPack restores pruned sealed notices and copies the full distribution without peer wrappers', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.destination, { recursive: true });
  await fs.writeFile(
    path.join(f.destination, 'obsolete.txt'),
    'pruned previous output',
  );
  const result = await packageOverlayForElectronBuilder(f.context, {
    packageRoot: f.sdk,
  });
  assert.equal(result.sealedPayloads, 6);
  assert.equal(
    await fs.readFile(
      path.join(
        f.destination,
        'dist/broker/win32-x64/node_modules/tslib/CopyrightNotice.txt',
      ),
      'utf8',
    ),
    'immutable nested notice',
  );
  await assert.rejects(
    fs.stat(path.join(f.destination, 'node_modules/.bin/electron.cmd')),
    /ENOENT/,
  );
  await assert.rejects(
    fs.stat(path.join(f.destination, 'private-source.txt')),
    /ENOENT/,
  );
  await assert.rejects(
    fs.stat(path.join(f.destination, 'obsolete.txt')),
    /ENOENT/,
  );
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, 6);
  const original = await fs.readFile(
    path.join(f.leaf, 'node_modules/tslib/CopyrightNotice.txt'),
  );
  assert.equal(original.toString(), 'immutable nested notice');
  // Repeated afterPack remains safe and produces the same complete package.
  await createOverlayAfterPack({ packageRoot: f.sdk })(f.context);
});
test('tampered source fails before replacing existing build output; packaged tampering fails verification', async (t) => {
  const f = await fixture(t);
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  const notice = path.join(f.leaf, 'node_modules/tslib/CopyrightNotice.txt');
  await fs.writeFile(notice, 'pruned');
  await assert.rejects(
    packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }),
    /hash|size|payload/i,
  );
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, 6);
  await fs.unlink(
    path.join(
      f.destination,
      'dist/broker/win32-x64/node_modules/tslib/CopyrightNotice.txt',
    ),
  );
  await assert.rejects(verifyOverlayPackage(f.destination), /ENOENT|payload/i);
});
test('SDK/provider root mirror mismatch is rejected even when standalone payload remains sealed', async (t) => {
  const f = await fixture(t);
  await f.write('dist/lib/module.js', 'different');
  await assert.rejects(
    packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }),
    /mirror mismatch/,
  );
  await assert.rejects(fs.stat(f.destination), /ENOENT/);
});
test('pnpm package-root junction is supported; payload/output junctions and overlap are refused', async (t) => {
  const f = await fixture(t),
    link = path.join(f.root, 'node_modules/electron-game-overlay');
  await fs.mkdir(path.dirname(link), { recursive: true });
  try {
    await fs.symlink(f.sdk, link, 'junction');
  } catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) {
      t.skip('junction unavailable');
      return;
    }
    throw e;
  }
  await packageOverlayForElectronBuilder(f.context, { packageRoot: link });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, 6);
  const escape = path.join(f.root, 'escape');
  await fs.mkdir(escape);
  const out2 = path.join(f.root, 'out2');
  await fs.mkdir(out2);
  await fs.symlink(escape, path.join(out2, 'resources'), 'junction');
  await assert.rejects(
    packageOverlayForElectronBuilder(
      { appOutDir: out2, electronPlatformName: 'win32' },
      { packageRoot: link },
    ),
    /escapes/,
  );
  assert.deepEqual(await fs.readdir(escape), []);
  await fs.symlink(escape, path.join(f.sdk, 'dist/unsafe'), 'junction');
  await assert.rejects(
    packageOverlayForElectronBuilder(f.context, { packageRoot: link }),
    /Symbolic link/,
  );
});
test('non-Windows afterPack is a no-op and Node-only packaging import starts no Electron or broker', async () => {
  assert.equal(
    await packageOverlayForElectronBuilder({
      appOutDir: 'missing',
      electronPlatformName: 'linux',
    }),
    undefined,
  );
  assert.equal(
    Object.keys(require.cache).some((f) =>
      /[\\/]electron[\\/]index.js$/.test(f),
    ),
    false,
  );
});
