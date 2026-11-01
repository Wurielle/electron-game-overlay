const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
require('./helpers/source-packaging-loader.cjs');
const {
  packageOverlayForElectronBuilder,
  verifyOverlayPackage,
  createOverlayAfterPack,
} = require('../dist/packaging.js');
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-packaging-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const sdk = path.join(root, 'pnpm-store', 'electron-game-overlay'),
    out = path.join(root, 'out'),
    leaf = path.join(sdk, 'dist');
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
  const payload = require('./helpers/cooperative-package-fixture.cjs').writeCooperativeDistribution(path.join(sdk, 'dist'), { packageVersion: '0.1.0-rc.5', ...options });
  return {
    root,
    sdk,
    out,
    leaf,
    payload,
    sealedCount: payload.files.length,
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
  assert.equal(result.sealedPayloads, f.sealedCount);
  assert.equal(
    await fs.readFile(
      path.join(
        f.destination,
        'dist/node_modules/tslib/CopyrightNotice.txt',
      ),
      'utf8',
    ),
    'Controlled immutable dependency notice\n',
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
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  const original = await fs.readFile(
    path.join(f.leaf, 'node_modules/tslib/CopyrightNotice.txt'),
  );
  assert.equal(original.toString(), 'Controlled immutable dependency notice\n');
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
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  await fs.unlink(
    path.join(
      f.destination,
      'dist/node_modules/tslib/CopyrightNotice.txt',
    ),
  );
  await assert.rejects(verifyOverlayPackage(f.destination), /ENOENT|payload/i);
});
test('changed compiled SDK payload is rejected before replacing output', async (t) => {
  const f = await fixture(t);
  await f.write('dist/lib/module.js', 'different');
  await assert.rejects(
    packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }),
    /hash|size|payload/i,
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
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
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

test('public package verifier keeps retained schema-29 SDKs valid without adding new patch provenance', async t => {
  const f = await fixture(t, { runtimeGeneration: 14, addonBuildId: '412D57BEA49440738CC4C3903038F2E7' });
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  const stamp = JSON.parse(await fs.readFile(path.join(f.destination, 'dist/runtime/win32-x64/reshade/ReShade64.build.json')));
  assert.equal(stamp.schemaVersion, 29);
  assert.equal(stamp.ownedLateD3d11PatchSha256, undefined);
});
test('public package verifier rejects schema-30 missing provenance even after legitimate hashes are rebound', async t => {
  const f = await fixture(t);
  const relative = 'runtime/win32-x64/reshade/ReShade32.build.json';
  const stamp = JSON.parse(await fs.readFile(path.join(f.leaf, relative)));
  delete stamp.ownedLateD3d11PatchSha256;
  f.payload.write(relative, JSON.stringify(stamp)); f.payload.bindNativeHashes(); f.payload.seal();
  await assert.rejects(verifyOverlayPackage(f.sdk), /owned late D3D11 patch provenance/i);
  await assert.rejects(packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }), /owned late D3D11 patch provenance/i);
  await assert.rejects(fs.stat(f.destination), /ENOENT/);
});
