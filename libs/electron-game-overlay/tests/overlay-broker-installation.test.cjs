const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');
const api = (() => {
  try {
    return require('../dist/lib/overlay-broker-installation.js');
  } catch {
    return {};
  }
})();

async function fixture(t, version = '1.0.0') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ego-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, randomUUID());
  await fs.mkdir(source);
  const executable =
    process.platform === 'win32'
      ? 'electron-game-overlay-broker.exe'
      : 'electron-game-overlay-broker';
  const data = Buffer.from('standalone fixture payload');
  await fs.writeFile(path.join(source, executable), data, { mode: 0o700 });
  const manifest = {
    schema: 1,
    version,
    protocolMin: 1,
    protocolMax: 1,
    platform: process.platform,
    arch: process.arch,
    executable,
    files: [
      {
        path: executable,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    ],
    future: { ignored: true },
  };
  await fs.writeFile(
    path.join(source, 'broker-manifest.json'),
    JSON.stringify(manifest),
  );
  return {
    root,
    source,
    manifest,
    options: {
      storageRoot: path.join(root, 'state'),
      distributionPath: source,
    },
  };
}

test('all registration owners participate after content deduplication beyond entry 64', async (t) => {
  const f = await fixture(t);
  const newer = await fixture(t, '9.0.0');
  await api.registerOverlayBrokerInstallation(f.options);
  await api.registerOverlayBrokerInstallation({
    ...f.options,
    distributionPath: newer.source,
  });
  const filename = path.join(f.options.storageRoot, 'catalog.json');
  const catalog = JSON.parse(await fs.readFile(filename, 'utf8'));
  // Resolve IDs from validated cached manifests, not registration sort order.
  const cached = await api.discoverOverlayBrokerInstallations(f.options);
  const oldId = cached.find((entry) => entry.manifest.version === '1.0.0').id;
  const newId = cached.find((entry) => entry.manifest.version === '9.0.0').id;
  catalog.entries = Array.from({ length: 499 }, (_, index) => ({
    id: oldId,
    registrationId: index.toString(16).padStart(64, '0'),
  }));
  catalog.entries.push({ id: newId, registrationId: 'f'.repeat(64) });
  await fs.writeFile(filename, JSON.stringify(catalog));
  await fs.rm(newer.source, { recursive: true });
  const original = fs.opendir;
  const walks = new Map();
  fs.opendir = async function (directory, ...args) {
    if (path.dirname(directory) === path.join(f.options.storageRoot, 'cache'))
      walks.set(directory, (walks.get(directory) ?? 0) + 1);
    return original.call(this, directory, ...args);
  };
  try {
    const result = await api.discoverOverlayBrokerInstallations(f.options);
    assert.equal(
      result[0].manifest.version,
      '9.0.0',
      'inactive newest owner after 499 repeated-content owners must participate',
    );
    assert.equal(
      walks.get(path.join(f.options.storageRoot, 'cache', oldId)),
      1,
      'deduplicate content before metadata I/O',
    );
  } finally {
    fs.opendir = original;
  }
});

test('hundreds of distinct registered versions rank before bounded lazy validation', async (t) => {
  const f = await fixture(t, '0.0.1');
  const filename = path.join(f.options.storageRoot, 'catalog.json');
  const canonical = await fs.realpath(f.source);
  const owner = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex');
  // Register real independent content snapshots; no fixture executable is run.
  for (let index = 0; index < 500; index++) {
    f.manifest.version = `1.0.${index}`;
    await fs.writeFile(
      path.join(f.source, 'broker-manifest.json'),
      JSON.stringify(f.manifest),
    );
    await api.registerOverlayBrokerInstallation(f.options);
    const current = JSON.parse(await fs.readFile(filename, 'utf8'));
    const entry = current.entries.find(
      (entry) => entry.registrationId === owner,
    );
    // Retain each version as a distinct owner; catalog order deliberately puts newest last.
    entry.registrationId = index.toString(16).padStart(64, '0');
    await fs.writeFile(filename, JSON.stringify(current));
  }
  await fs.rm(f.source, { recursive: true });
  const original = fs.open;
  let payloadReads = 0;
  let manifestReads = 0;
  fs.open = async function (name, ...args) {
    if (name.startsWith(path.join(f.options.storageRoot, 'cache'))) {
      if (path.basename(name) === 'broker-manifest.json') {
        manifestReads++;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else payloadReads++;
    }
    return original.call(this, name, ...args);
  };
  try {
    const iterator = api.iterateOverlayBrokerInstallations(
      f.options,
      Date.now() + 4000,
    );
    const first = await iterator.next();
    await iterator.return();
    assert.equal(
      first.value?.manifest.version,
      '1.0.499',
      'newest inactive distinct version must participate within the bounded startup budget',
    );
    assert.equal(payloadReads, 1, 'only selected payload is hashed');
    assert.ok(
      manifestReads <= 2,
      'validated catalog ranking hints avoid scanning 500 manifests before selection',
    );
    const legacy = JSON.parse(await fs.readFile(filename, 'utf8'));
    legacy.entries.forEach((entry, index) => {
      delete entry.rankingVersion;
      if (index % 2) delete entry.registrationId;
    });
    await fs.writeFile(filename, JSON.stringify(legacy));
    const unlimited = api.iterateOverlayBrokerInstallations(f.options);
    assert.equal(
      (await unlimited.next()).value?.manifest.version,
      '1.0.499',
      'all 500 distinct legacy entries participate without an arbitrary prefix limit',
    );
    await unlimited.return();
  } finally {
    fs.open = original;
  }
});

test('catalog mutations preserve additive document and other-owner fields including legacy entries', async (t) => {
  const f = await fixture(t);
  await api.registerOverlayBrokerInstallation(f.options);
  const filename = path.join(f.options.storageRoot, 'catalog.json');
  const catalog = JSON.parse(await fs.readFile(filename, 'utf8'));
  catalog.futureCatalog = { nested: ['safe', 1, null], __protoSafe: true };
  catalog.entries.push({ id: 'a'.repeat(64), futureOwner: { retained: true } });
  catalog.entries[0].futureOwner = { data: ['unchanged'] };
  await fs.writeFile(filename, JSON.stringify(catalog));
  await api.unregisterOverlayBrokerInstallation('f'.repeat(64), f.options);
  assert.deepEqual(
    JSON.parse(await fs.readFile(filename, 'utf8')),
    catalog,
    'no-op unregister must not project away unknown fields or rewrite legacy owners',
  );
  await api.registerOverlayBrokerInstallation(f.options);
  const updated = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.deepEqual(updated.futureCatalog, catalog.futureCatalog);
  assert.deepEqual(
    updated.entries.find((entry) => entry.id === 'a'.repeat(64)),
    catalog.entries[1],
    'register preserves other-owner fields',
  );
});

test('mutation refuses unsupported malformed oversized and unreadable existing catalogs without overwrite', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.options.storageRoot, { recursive: true });
  const filename = path.join(f.options.storageRoot, 'catalog.json');
  for (const contents of [
    JSON.stringify({ schema: 2, futureCatalog: true, entries: [] }),
    '{broken',
    ' '.repeat(1024 * 1024 + 1),
    JSON.stringify({ schema: 1, entries: [null] }),
    JSON.stringify({ schema: 1, entries: [{ id: '../escape' }] }),
    JSON.stringify({
      schema: 1,
      entries: [{ id: 'a'.repeat(64), registrationId: 42 }],
    }),
    JSON.stringify({
      schema: 1,
      entries: Array.from({ length: 4097 }, () => ({ id: 'a'.repeat(64) })),
    }),
  ]) {
    await fs.writeFile(filename, contents);
    for (const mutate of [
      () => api.unregisterOverlayBrokerInstallation('f'.repeat(64), f.options),
      () => api.registerOverlayBrokerInstallation(f.options),
    ]) {
      await assert.rejects(
        mutate(),
        undefined,
        'an existing unsupported or malformed catalog must not be initialized as empty',
      );
      assert.equal(
        await fs.readFile(filename, 'utf8'),
        contents,
        'failed mutation retains exact original bytes',
      );
    }
  }
  const contents = JSON.stringify({
    schema: 1,
    entries: [],
    futureCatalog: 'unreadable',
  });
  await fs.writeFile(filename, contents);
  const original = fs.open;
  fs.open = async function (name, ...args) {
    if (name === filename)
      throw Object.assign(new Error('controlled access denied'), {
        code: 'EACCES',
      });
    return original.call(this, name, ...args);
  };
  try {
    await assert.rejects(
      api.unregisterOverlayBrokerInstallation('f'.repeat(64), f.options),
      /access denied/,
    );
    await assert.rejects(
      api.registerOverlayBrokerInstallation(f.options),
      /access denied/,
    );
  } finally {
    fs.open = original;
  }
  assert.equal(await fs.readFile(filename, 'utf8'), contents);
  await fs.rm(filename);
  await fs.mkdir(filename);
  await assert.rejects(
    api.unregisterOverlayBrokerInstallation('f'.repeat(64), f.options),
    /metadata/,
  );
  assert.equal((await fs.stat(filename)).isDirectory(), true);
});

test('catalog growth cannot publish a document that exceeds its readable metadata bound', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.options.storageRoot, { recursive: true });
  const filename = path.join(f.options.storageRoot, 'catalog.json');
  const base = JSON.stringify({ schema: 1, entries: [], futureCatalog: '' });
  const original = JSON.stringify({
    schema: 1,
    entries: [],
    futureCatalog: 'x'.repeat(1024 * 1024 - Buffer.byteLength(base)),
  });
  await fs.writeFile(filename, original);
  await assert.rejects(
    api.registerOverlayBrokerInstallation(f.options),
    /limit|size|exceeds/,
  );
  assert.equal(await fs.readFile(filename, 'utf8'), original);
});

test('ranking hints cannot authorize a mismatched manifest or bypass legacy discovery', async (t) => {
  const f = await fixture(t);
  const newer = await fixture(t, '9.0.0');
  await api.registerOverlayBrokerInstallation({
    ...f.options,
    distributionPath: newer.source,
  });
  await fs.rm(newer.source, { recursive: true });
  const filename = path.join(f.options.storageRoot, 'catalog.json');
  const original = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const hint of ['999.0.0', 'invalid', undefined]) {
    const catalog = structuredClone(original);
    if (hint === undefined) {
      delete catalog.entries[0].rankingVersion;
      delete catalog.entries[0].registrationId;
    } else catalog.entries[0].rankingVersion = hint;
    await fs.writeFile(filename, JSON.stringify(catalog));
    const [candidate] = await api.discoverOverlayBrokerInstallations(f.options);
    assert.equal(
      candidate.manifest.version,
      hint === '999.0.0' ? '1.0.0' : '9.0.0',
      'hint mismatch refuses the candidate; invalid/missing hints use validated legacy manifests',
    );
  }
});

test('cache metadata walks stop after 64 real directory entries including irrelevant files', async (t) => {
  const f = await fixture(t);
  await api.registerOverlayBrokerInstallation(f.options);
  const catalog = JSON.parse(
    await fs.readFile(path.join(f.options.storageRoot, 'catalog.json'), 'utf8'),
  );
  const group = path.join(
    f.options.storageRoot,
    'cache',
    catalog.entries[0].id,
  );
  await Promise.all(
    Array.from({ length: 96 }, (_, index) =>
      fs.writeFile(path.join(group, `irrelevant-${index}`), 'ignored'),
    ),
  );
  const original = fs.opendir;
  const walks = [];
  fs.opendir = async function (directory, ...args) {
    const realDirectory = await original.call(this, directory, ...args);
    if (directory !== group) return realDirectory;
    const walk = { visited: 0 };
    walks.push(walk);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const entry of realDirectory) {
          walk.visited++;
          yield entry;
        }
      },
    };
  };
  try {
    await api.discoverOverlayBrokerInstallations(f.options);
  } finally {
    fs.opendir = original;
  }
  assert.ok(walks.length > 0, 'must observe actual cache-group enumeration');
  assert.ok(
    walks.every((walk) => walk.visited <= 64),
    `all entries count toward the metadata budget: ${JSON.stringify(walks)}`,
  );
});

test('bundled discovery resolves physical asarUnpacked assets without reading or extracting an archive', async (t) => {
  const f = await fixture(t);
  const archive = path.join(f.root, 'app.asar');
  await fs.writeFile(archive, 'read-only application archive', { mode: 0o400 });
  const relative = path.join('node_modules', 'electron-game-overlay', 'dist');
  const physical = path.join(
    archive + '.unpacked',
    relative,
    'broker',
    `${process.platform}-${process.arch}`,
  );
  await fs.mkdir(path.dirname(physical), { recursive: true });
  await fs.cp(f.source, physical, { recursive: true });
  const virtualModule = path.join(
    archive,
    relative,
    'lib',
    'overlay-broker-installation.js',
  );
  const Module = require('node:module');
  const loaded = new Module(virtualModule, module);
  loaded.filename = virtualModule;
  loaded.paths = module.paths;
  loaded._compile(
    await fs.readFile(
      require.resolve('../dist/lib/overlay-broker-installation.js'),
      'utf8',
    ),
    virtualModule,
  );
  assert.equal(
    loaded.exports.bundledOverlayBrokerDistributionPath(),
    physical,
    'an OS executable must resolve outside app.asar',
  );
  const [candidate] = await loaded.exports.discoverOverlayBrokerInstallations({
    storageRoot: f.options.storageRoot,
  });
  assert.equal(candidate.manifest.version, '1.0.0');
  assert.equal(
    await fs.readFile(archive, 'utf8'),
    'read-only application archive',
  );
});

test('filesystem fixtures work when TMPDIR is unset, as on Windows', async (t) => {
  const old = process.env.TMPDIR;
  const oldTmp = process.env.TMP;
  if (old) process.env.TMP = old;
  delete process.env.TMPDIR;
  try {
    await assert.doesNotReject(
      fixture(t),
      'fixtures must use the host temporary directory',
    );
  } finally {
    if (old !== undefined) process.env.TMPDIR = old;
    if (oldTmp === undefined) delete process.env.TMP;
    else process.env.TMP = oldTmp;
  }
});

module.exports.fixture = fixture;

test('identical content deduplicates without sharing application registration ownership', async (t) => {
  const a = await fixture(t, '2.0.0');
  const b = await fixture(t, '2.0.0');
  const optionsA = a.options;
  const optionsB = { ...b.options, storageRoot: optionsA.storageRoot };
  const idA = await api.registerOverlayBrokerInstallation(optionsA);
  const idB = await api.registerOverlayBrokerInstallation(optionsB);
  assert.notEqual(
    idA,
    idB,
    'independent application paths must own distinct registrations',
  );
  assert.match(idA, /^[0-9a-f]{64}$/);
  assert.equal(await api.registerOverlayBrokerInstallation(optionsA), idA);
  const catalog = JSON.parse(
    await fs.readFile(path.join(optionsA.storageRoot, 'catalog.json'), 'utf8'),
  );
  assert.equal(catalog.entries.length, 2);
  assert.equal(
    new Set(catalog.entries.map((entry) => entry.id)).size,
    1,
    'identical content shares a cache group',
  );
  assert.equal(
    (await fs.readdir(path.join(optionsA.storageRoot, 'cache'))).length,
    1,
  );
  await api.unregisterOverlayBrokerInstallation(idA, optionsA);
  await api.unregisterOverlayBrokerInstallation(idA, optionsA);
  const remaining = JSON.parse(
    await fs.readFile(path.join(optionsA.storageRoot, 'catalog.json'), 'utf8'),
  );
  assert.equal(remaining.entries.length, 1);
  assert.equal(remaining.entries[0].registrationId, idB);
  await fs.rm(b.source, { recursive: true });
  assert.equal(
    (
      await api.discoverOverlayBrokerInstallations({
        storageRoot: optionsA.storageRoot,
        distributionPath: path.join(a.root, 'missing'),
      })
    )[0].manifest.version,
    '2.0.0',
  );
});

test('ignores absent stale corrupt oversized and unknown-schema catalogs while preserving own startup', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.options.storageRoot, { recursive: true });
  for (const catalog of [
    undefined,
    '{broken',
    ' '.repeat(1024 * 1024 + 1),
    JSON.stringify({ schema: 2, entries: [] }),
    JSON.stringify({
      schema: 1,
      additive: true,
      entries: [
        { id: 'f'.repeat(64), future: true },
        { id: '../escape' },
        null,
        { executable: 'sh -c nope' },
      ],
    }),
  ]) {
    const filename = path.join(f.options.storageRoot, 'catalog.json');
    if (catalog === undefined) await fs.rm(filename, { force: true });
    else await fs.writeFile(filename, catalog);
    const candidates = await api.discoverOverlayBrokerInstallations(f.options);
    assert.deepEqual(
      candidates.map((candidate) => candidate.manifest.version),
      ['1.0.0'],
    );
  }
});

test('ignores damaged registered payloads and accepts additive catalog fields', async (t) => {
  const f = await fixture(t);
  const newer = await fixture(t, '2.0.0');
  const options = {
    storageRoot: f.options.storageRoot,
    distributionPath: newer.source,
  };
  const id = await api.registerOverlayBrokerInstallation(options);
  const catalogPath = path.join(f.options.storageRoot, 'catalog.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  catalog.future = { enabled: true };
  catalog.entries[0].future = true;
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  const [candidate] = await api.discoverOverlayBrokerInstallations(f.options);
  assert.equal(catalog.entries[0].registrationId, id);
  assert.equal(candidate.id, catalog.entries[0].id);
  await fs.chmod(candidate.executablePath, 0o600);
  await fs.writeFile(candidate.executablePath, 'tampered');
  assert.deepEqual(
    (await api.discoverOverlayBrokerInstallations(f.options)).map(
      (candidate) => candidate.manifest.version,
    ),
    ['1.0.0'],
  );
});

test('semver numeric prerelease ordering and equal-version ties are deterministic', async (t) => {
  const f = await fixture(t, '0.0.1');
  for (const version of [
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-beta.1',
    '1.0.0+build.2',
    '1.0.0+build.1',
  ]) {
    const other = await fixture(t, version);
    await api.registerOverlayBrokerInstallation({
      storageRoot: f.options.storageRoot,
      distributionPath: other.source,
      allowPrerelease: true,
    });
  }
  const candidates = await api.discoverOverlayBrokerInstallations({
    ...f.options,
    allowPrerelease: true,
  });
  assert.equal(candidates[0].manifest.version.split('+')[0], '1.0.0');
  assert.ok(candidates[0].id < candidates[1].id);
  assert.deepEqual(
    candidates.slice(2).map((c) => c.manifest.version),
    ['1.0.0-beta.11', '1.0.0-beta.2', '1.0.0-beta.1', '0.0.1'],
  );
});

test('a damaged cached copy is never overwritten and does not prevent own bundled fallback', async (t) => {
  const f = await fixture(t);
  const [first] = await api.discoverOverlayBrokerInstallations(f.options);
  await fs.chmod(first.executablePath, 0o600);
  await fs.writeFile(first.executablePath, 'corrupt retained file');
  const [replacement] = await api.discoverOverlayBrokerInstallations(f.options);
  assert.ok(replacement, 'own bundled fallback must remain available');
  assert.notEqual(replacement.directory, first.directory);
  assert.equal(
    await fs.readFile(first.executablePath, 'utf8'),
    'corrupt retained file',
  );
  assert.equal(
    await fs.readFile(replacement.executablePath, 'utf8'),
    'standalone fixture payload',
  );
});

test('serializes concurrent cross-process registrations without losing entries', async (t) => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const fixtures = await Promise.all(
    Array.from({ length: 10 }, (_, i) => fixture(t, `1.0.${i}`)),
  );
  const storageRoot = fixtures[0].options.storageRoot;
  const gate = path.join(fixtures[0].root, 'gate');
  const modulePath =
    require.resolve('../dist/lib/overlay-broker-installation.js');
  const jobs = fixtures.map((f, i) =>
    promisify(execFile)(process.execPath, [
      '-e',
      `
    const fs = require('node:fs/promises');
    (async () => {
      await fs.writeFile(${JSON.stringify(gate)} + '.${i}', 'ready');
      for (;;) { try { await fs.access(${JSON.stringify(gate)}); break; } catch {} await new Promise(r => setTimeout(r, 5)); }
      console.log(await require(${JSON.stringify(modulePath)}).registerOverlayBrokerInstallation(${JSON.stringify({ storageRoot, distributionPath: f.source })}));
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `,
    ]),
  );
  const outcomes = Promise.all(jobs);
  while (
    (await fs.readdir(fixtures[0].root)).filter((p) => p.startsWith('gate.'))
      .length < fixtures.length
  )
    await new Promise((r) => setTimeout(r, 5));
  await fs.writeFile(gate, 'go');
  const ids = (await outcomes).map((result) => result.stdout.trim());
  const catalog = JSON.parse(
    await fs.readFile(path.join(storageRoot, 'catalog.json'), 'utf8'),
  );
  assert.deepEqual(
    catalog.entries.map((entry) => entry.registrationId).sort(),
    ids.sort(),
  );
});

test('optional registration discovers the highest stable cached version while its supplying app is stopped', async (t) => {
  const old = await fixture(t, '1.9.0');
  const newer = await fixture(t, '2.0.0');
  const preview = await fixture(t, '3.0.0-beta.2');
  assert.equal(typeof api.registerOverlayBrokerInstallation, 'function');
  const options = { storageRoot: old.options.storageRoot };
  const id = await api.registerOverlayBrokerInstallation({
    ...options,
    distributionPath: newer.source,
  });
  const registered = JSON.parse(
    await fs.readFile(path.join(options.storageRoot, 'catalog.json'), 'utf8'),
  ).entries.find((entry) => entry.registrationId === id);
  await assert.rejects(
    api.registerOverlayBrokerInstallation({
      ...options,
      distributionPath: preview.source,
    }),
    /prerelease/i,
  );
  await api.registerOverlayBrokerInstallation({
    ...options,
    distributionPath: preview.source,
    allowPrerelease: true,
  });
  await fs.rm(newer.source, { recursive: true });
  await fs.rm(preview.source, { recursive: true });
  assert.deepEqual(
    (await api.discoverOverlayBrokerInstallations(old.options)).map(
      (c) => c.manifest.version,
    ),
    ['2.0.0', '1.9.0'],
  );
  assert.deepEqual(
    (
      await api.discoverOverlayBrokerInstallations({
        ...old.options,
        allowPrerelease: true,
      })
    ).map((c) => c.manifest.version),
    ['3.0.0-beta.2', '2.0.0', '1.9.0'],
  );
  await api.unregisterOverlayBrokerInstallation(id, options);
  assert.deepEqual(
    (await api.discoverOverlayBrokerInstallations(old.options)).map(
      (c) => c.manifest.version,
    ),
    ['1.9.0'],
  );
  assert.equal(
    (
      await fs.stat(path.join(options.storageRoot, 'cache', registered.id))
    ).isDirectory(),
    true,
  );
});

test('rejects tampered source and unsafe distribution files before caching', async (t) => {
  for (const mutation of [
    'tamper',
    'symlink',
    'traversal',
    'platform',
    'arch',
    'schema',
    'hash',
    'size',
    'version',
    'extra',
    'directory',
    'oversized',
  ]) {
    const f = await fixture(t);
    const executablePath = path.join(f.source, f.manifest.executable);
    if (mutation === 'tamper') await fs.writeFile(executablePath, 'changed');
    if (mutation === 'symlink') {
      await fs.rename(executablePath, executablePath + '.real');
      await fs.symlink(executablePath + '.real', executablePath);
    }
    if (mutation === 'traversal') f.manifest.files[0].path = '../escape';
    if (mutation === 'platform') f.manifest.platform = 'foreign';
    if (mutation === 'arch') f.manifest.arch = 'foreign';
    if (mutation === 'schema') f.manifest.schema = 2;
    if (mutation === 'hash') f.manifest.files[0].sha256 = 'a'.repeat(64);
    if (mutation === 'size') f.manifest.files[0].size++;
    if (mutation === 'version') f.manifest.version = '01.0.0';
    if (mutation === 'extra')
      await fs.writeFile(path.join(f.source, 'undeclared.js'), 'untrusted');
    if (mutation === 'directory') {
      await fs.rm(executablePath);
      await fs.mkdir(executablePath);
    }
    await fs.writeFile(
      path.join(f.source, 'broker-manifest.json'),
      mutation === 'oversized'
        ? ' '.repeat(1024 * 1024 + 1)
        : JSON.stringify(f.manifest),
    );
    const candidates = await api.discoverOverlayBrokerInstallations(f.options);
    assert.equal(candidates.length, 0, mutation);
  }
});

test('ordinary unregistered discovery caches its own standalone distribution independently of source', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof api.discoverOverlayBrokerInstallations, 'function');
  const [candidate] = await api.discoverOverlayBrokerInstallations(f.options);
  assert.equal(candidate.manifest.version, '1.0.0');
  assert.notEqual(candidate.directory, f.source);
  await fs.rm(f.source, { recursive: true });
  assert.equal(
    (await fs.readFile(candidate.executablePath)).toString(),
    'standalone fixture payload',
  );
  await assert.rejects(
    fs.access(path.join(f.options.storageRoot, 'catalog.json')),
  );
});
