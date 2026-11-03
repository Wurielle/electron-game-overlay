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
test('public package verifier preserves the earlier generation-15 implementation without a CLI patch claim', async t => {
  const f = await fixture(t, { runtimeGeneration: 15, addonBuildId: 'BCE6C5C8746F4300861300B2BDA3594E', firstHostResultPatch: false });
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  const stamp = JSON.parse(await fs.readFile(path.join(f.destination, 'dist/runtime/win32-x64/reshade/ReShade64.build.json')));
  assert.equal(stamp.schemaVersion, 30);
  assert.equal(stamp.injectorFirstHostResultPatchSha256, undefined);
});
test('public package verifier rejects current CLI metadata downgrade after every payload hash is rebound', async t => {
  const f = await fixture(t);
  for (const bits of [64, 32]) {
    const relative = 'runtime/win32-x64/reshade/ReShade' + bits + '.build.json';
    const stamp = JSON.parse(await fs.readFile(path.join(f.leaf, relative)));
    delete stamp.injectorFirstHostResultPatchSha256;
    f.payload.write(relative, JSON.stringify(stamp));
  }
  f.payload.bindNativeHashes(); f.payload.seal();
  await assert.rejects(verifyOverlayPackage(f.sdk), /first-host result patch provenance mismatch/i);
  await assert.rejects(packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }), /first-host result patch provenance mismatch/i);
  await assert.rejects(fs.stat(f.destination), /ENOENT/);
});
test('public package verification preserves retained generation-16 packages without preload capability', async t => {
  const f = await fixture(t, { runtimeGeneration: 16, addonBuildId: 'E8FE3783F29E4FB297D8B006D0087725' });
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  const stamp = JSON.parse(await fs.readFile(path.join(f.destination, 'dist/runtime/win32-x64/reshade/ReShade64.build.json')));
  assert.equal(stamp.addonPreloadProtocol, undefined);
  assert.equal(stamp.injectorAddonPreloadPatchSha256, undefined);
});
test('current preload capability cannot disappear from one architecture before Electron packaging', async t => {
  const f = await fixture(t);
  const relative = 'runtime/win32-x64/reshade/electron_game_overlay_runtime32.build.json';
  const stamp = JSON.parse(await fs.readFile(path.join(f.leaf, relative))); delete stamp.addonPreloadProtocol;
  f.payload.write(relative, JSON.stringify(stamp)); f.payload.seal();
  await assert.rejects(verifyOverlayPackage(f.sdk), /preload|manifests disagree/i);
  await assert.rejects(packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }), /preload|manifests disagree/i);
  await assert.rejects(fs.stat(f.destination), /ENOENT/);
});

test('public verification and afterPack preserve retained generation-18 preload packages without the later ordering provenance', async t => {
  const f = await fixture(t, { runtimeGeneration: 18, addonBuildId: '17E16E01C9A243E18EE19D814420E519' });
  const original = await fs.readFile(path.join(f.leaf, 'overlay-manifest.json'));
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json')), original);
  for (const bits of [64, 32]) {
    const stamp = JSON.parse(await fs.readFile(path.join(f.destination, 'dist/runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(stamp.addonPreloadProtocol, 1);
    assert.equal(stamp.injectorAddonPreloadPatchSha256, 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D');
    assert.equal(stamp.injectorPreloadedFirstHostPatchSha256, undefined);
  }
});

test('fully rebound current ordering provenance removal fails before replacing a valid Electron package', async t => {
  const f = await fixture(t);
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  const original = await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json'));
  const relative = 'runtime/win32-x64/reshade/ReShade32.build.json';
  const stamp = JSON.parse(await fs.readFile(path.join(f.leaf, relative)));
  delete stamp.injectorPreloadedFirstHostPatchSha256;
  f.payload.write(relative, JSON.stringify(stamp)); f.payload.bindNativeHashes(); f.payload.seal();
  await assert.rejects(verifyOverlayPackage(f.sdk), /preloaded first-host patch provenance mismatch.*32/i);
  await assert.rejects(packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }), /preloaded first-host patch provenance mismatch.*32/i);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json')), original);
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
});

test('public verification and afterPack preserve retained generation-19 packages without long-path provenance', async t => {
  const f = await fixture(t, { runtimeGeneration: 19 });
  const original = await fs.readFile(path.join(f.leaf, 'overlay-manifest.json'));
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json')), original);
  for (const bits of [64, 32]) {
    const stamp = JSON.parse(await fs.readFile(path.join(f.destination, 'dist/runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(stamp.injectorPreloadedFirstHostPatchSha256, 'A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309');
    assert.equal(stamp.injectorPreloadLongPathPatchSha256, undefined);
  }
});

for (const value of [undefined, '0'.repeat(64)]) test('fully rebound current long-path provenance ' + (value === undefined ? 'removal' : 'substitution') + ' fails before replacing a valid Electron package', async t => {
  const f = await fixture(t);
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  const original = await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json'));
  const relative = 'runtime/win32-x64/reshade/ReShade32.build.json';
  const stamp = JSON.parse(await fs.readFile(path.join(f.leaf, relative)));
  if (value === undefined) delete stamp.injectorPreloadLongPathPatchSha256;
  else stamp.injectorPreloadLongPathPatchSha256 = value;
  f.payload.write(relative, JSON.stringify(stamp)); f.payload.bindNativeHashes(); f.payload.seal();
  await assert.rejects(verifyOverlayPackage(f.sdk), /preload long-path patch provenance mismatch.*32/i);
  await assert.rejects(packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }), /preload long-path patch provenance mismatch.*32/i);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json')), original);
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
});

test('public verification and afterPack preserve retained generation-20 packages without adapter-ready long-path provenance', async t => {
  const f = await fixture(t, { runtimeGeneration: 20 });
  const original = await fs.readFile(path.join(f.leaf, 'overlay-manifest.json'));
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json')), original);
  for (const bits of [64, 32]) {
    const stamp = JSON.parse(await fs.readFile(path.join(f.destination, 'dist/runtime/win32-x64/reshade/ReShade' + bits + '.build.json')));
    assert.equal(stamp.injectorPreloadLongPathPatchSha256, 'FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B');
    assert.equal(stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256, undefined);
  }
});

for (const value of [undefined, '0'.repeat(64)]) test('fully rebound current adapter-ready long-path provenance ' + (value === undefined ? 'removal' : 'substitution') + ' fails before replacing a valid Electron package', async t => {
  const f = await fixture(t);
  await packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk });
  const original = await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json'));
  const relative = 'runtime/win32-x64/reshade/ReShade32.build.json';
  const stamp = JSON.parse(await fs.readFile(path.join(f.leaf, relative)));
  if (value === undefined) delete stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256;
  else stamp.ownedLateD3d11AdapterReadyLongPathPatchSha256 = value;
  f.payload.write(relative, JSON.stringify(stamp)); f.payload.bindNativeHashes(); f.payload.seal();
  await assert.rejects(verifyOverlayPackage(f.sdk), /adapter-ready long-path patch provenance mismatch.*32/i);
  await assert.rejects(packageOverlayForElectronBuilder(f.context, { packageRoot: f.sdk }), /adapter-ready long-path patch provenance mismatch.*32/i);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'dist/overlay-manifest.json')), original);
  assert.equal((await verifyOverlayPackage(f.destination)).sealedPayloads, f.sealedCount);
});
