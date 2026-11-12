'use strict';
// Passive filesystem/SDK tests. No payload, native helper, application, game,
// graphics fixture or input is executed. OS query results below are mocked.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  fsp = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  cp = require('node:child_process');
const {
  stageRuntimePayload,
  pruneRuntimePayloadCache,
  sdkRuntimeCacheDirectory,
  RUNTIME_PAYLOAD_NAMES: names,
} = require('../dist/lib/runtime-payload-store.js');
const storage = require('../dist/lib/runtime-stage-storage.js');
const {
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
  inspectReShadeRuntimeStorage,
  clearOldReShadeRuntimeCache,
  pruneReShadeRuntimeStorage,
} = require('../dist/lib/reshade-launcher.js');
const {
  overlayProcessIncarnationExited,
} = require('../dist/lib/overlay-native-process-query.js');
const parent = path.resolve(__dirname, '../../../build/storage-offline/tests');
fs.mkdirSync(parent, { recursive: true });
const sha = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const imageNames = names.filter((n) => /\.(exe|dll|addon32|addon64)$/u.test(n));
async function until(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'filesystem operation did not settle');
    await new Promise((r) => setTimeout(r, 5));
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(parent, 'owned-')),
    source = path.join(root, 'source'),
    runs = path.join(root, 'runs');
  fs.mkdirSync(source);
  fs.mkdirSync(runs);
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.equal(fs.realpathSync(root).toLowerCase(), root.toLowerCase());
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [i, name] of names.entries())
    fs.writeFileSync(
      path.join(source, name),
      imageNames.includes(name)
        ? Buffer.alloc(256 * 1024, i + 1)
        : name === 'ReShade.ini'
          ? '[ADDON]\nAddonPath=.\n'
          : '{}',
    );
  function bind() {
    for (const bits of [64, 32]) {
      const suffix = bits === 64 ? '' : '32',
        hash = (name) => sha(fs.readFileSync(path.join(source, name)));
      fs.writeFileSync(
        path.join(source, `electron_game_overlay_runtime${suffix}.build.json`),
        JSON.stringify({
          schemaVersion: 3,
          kind: 'electron-game-overlay-runtime-build',
          platform: bits === 64 ? 'win32-x64' : 'win32-ia32',
          configuration: 'RelWithDebInfo',
          addonBuildId: 'CCE20935ADD44EF6A5A7973014B2E07F',
          managerProtocolSchemaVersion: 1,
          runtimeGeneration: 1,
          targetTransportMin: 1,
          targetTransportMax: 1,
          managerSourceSha256: 'A'.repeat(64),
          managerSha256: hash(
            `electron_game_overlay_reshade_manager${suffix}.exe`,
          ),
          addonSha256: hash(`electron_game_overlay.addon${bits}`),
          injectorSha256: hash(`inject${suffix}.exe`),
          reshadeRuntimeSha256: hash(`ReShade${bits}.dll`),
          reshadeConfigSha256: hash('ReShade.ini'),
          reshadeBuildStampSha256: hash(`ReShade${bits}.build.json`),
        }),
      );
    }
  }
  bind();
  const sources = () => new Map(names.map((n) => [n, path.join(source, n)]));
  const config = () =>
    parseReShadeLaunchConfig(
      ['electron.exe', '--reshade-overlay', `--reshade-runtime-dir=${source}`],
      { runsRootDirectory: runs },
    );
  return { root, source, runs, sources, config, bind };
}
function marker(directory, runId = crypto.randomUUID()) {
  fs.writeFileSync(
    path.join(directory, '.electron-game-overlay-run.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'electron-game-overlay-reshade-run',
      runId,
      directoryName: path.basename(directory),
      createdAt: new Date().toISOString(),
    }),
  );
  return runId;
}
function unmapped(directory, runId, retiredAt = new Date().toISOString()) {
  fs.writeFileSync(
    path.join(directory, '.electron-game-overlay-run-reclaimable.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'electron-game-overlay-reshade-run-reclaimable',
      runId,
      directoryName: path.basename(directory),
      retiredAt,
      privateImagesUnmapped: true,
    }),
  );
}
async function staged(f, label, { high = false, consumer = null, sdkVersion } = {}) {
  const directory = path.join(f.runs, label);
  fs.mkdirSync(directory);
  const runId = marker(directory);
  await storage.createRuntimeStorageRecord(directory, runId, consumer);
  if (high)
    for (const name of names) fs.writeFileSync(path.join(directory, name), '');
  const result = await stageRuntimePayload(
    f.sources(),
    f.runs,
    directory,
    async () => {},
    high,
    runId,
    sdkVersion,
  );
  await storage.recordRuntimeStorageArtifacts(directory, runId, result);
  return { directory, runId, result };
}
function inventory(f) {
  const seen = new Set();
  let logical = 0,
    unique = 0,
    allocated = 0,
    files = 0;
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) visit(file);
      else {
        const s = fs.statSync(file, { bigint: true });
        logical += Number(s.size);
        files++;
        const id = s.dev + ':' + s.ino;
        if (!seen.has(id)) {
          seen.add(id);
          unique += Number(s.size);
          allocated += Number(s.blocks) * 512;
        }
      }
    }
  }
  visit(f.runs);
  visit(f.runs + '.payloads-v2');
  return { logical, unique, allocated, files, uniqueFiles: seen.size };
}
function caches(f) {
  return fs.existsSync(f.runs + '.payloads-v2')
    ? fs
        .readdirSync(f.runs + '.payloads-v2')
        .filter((n) => /^[a-f0-9]{64}$/u.test(n))
    : [];
}

test('repeated actual SDK prepare/dispose stores one snapshot, distinct private images, and no retired run payloads', async (t) => {
  const f = fixture(t);
  let baseline;
  for (let i = 0; i < 12; i++) {
    const launcher = new ReShadeOverlayLauncher(f.config());
    let directory;
    launcher.onEvent((e) => {
      if (e.type === 'runtime-staged') directory = e.runDirectory;
    });
    await launcher.prepare();
    const data = inventory(f);
    if (i === 0) baseline = data;
    else
      assert.equal(
        data.allocated,
        baseline.allocated,
        'restarting the SDK must not allocate another payload',
      );
    for (const name of names) {
      const a = fs.statSync(path.join(directory, name), { bigint: true }),
        b = fs.statSync(path.join(f.source, name), { bigint: true });
      assert.notEqual(a.ino, b.ino);
    }
    launcher.dispose();
    await until(() => !fs.existsSync(directory));
    assert.equal(fs.readdirSync(f.runs).length, 0);
    assert.equal(caches(f).length, 1);
  }
});

test('proven retired runs remove every payload alias and bound diagnostics; cancellation and SDK restart do not prove exit', async (t) => {
  const f = fixture(t),
    target = { pid: 4242, creationTime100ns: '134387773076910574' };
  const s = await staged(f, 'selected');
  await storage.recordRuntimeStorageAttempt(s.directory, s.runId, target);
  fs.writeFileSync(
    path.join(s.directory, 'ReShade.log'),
    Buffer.alloc(2 * 1024 * 1024, 65),
  );
  const alive = inventory(f);
  await storage.compactRuntimeStorageRun(s.directory);
  assert.deepEqual(inventory(f), alive);
  assert.equal(
    await storage.recoverRuntimeStorageRun(s.directory, async () => false),
    false,
    'fresh SDK instance with live/unknown target must retain it',
  );
  for (const name of names)
    assert.equal(fs.existsSync(path.join(s.directory, name)), true);
  assert.equal(
    await storage.recoverRuntimeStorageRun(s.directory, async (identity) => {
      assert.deepEqual(identity, target);
      return true;
    }),
    true,
  );
  const cache = path.join(
      f.runs + '.payloads-v2',
      caches(f)[0],
      'ReShade64.dll',
    ),
    before = {
      mode: fs.statSync(cache).mode,
      sha: sha(fs.readFileSync(cache)),
      ino: fs.statSync(cache).ino,
    };
  await storage.compactRuntimeStorageRun(s.directory);
  for (const name of names)
    assert.equal(fs.existsSync(path.join(s.directory, name)), false);
  assert.equal(
    fs.statSync(path.join(s.directory, 'ReShade.log')).size,
    64 * 1024,
  );
  assert.deepEqual(
    {
      mode: fs.statSync(cache).mode,
      sha: sha(fs.readFileSync(cache)),
      ino: fs.statSync(cache).ino,
    },
    before,
    'unlinking a stage must not mutate cache attributes or bytes',
  );
  assert.ok(inventory(f).allocated < alive.allocated);
});

test('passive high-lane files stay single-link, create no medium snapshot and release all copies on proof', async (t) => {
  const f = fixture(t),
    measurements = [];
  for (let i = 0; i < 8; i++) {
    const s = await staged(f, 'high-' + i, { high: true });
    assert.equal(fs.existsSync(f.runs + '.payloads-v2'), false);
    for (const name of names)
      assert.equal(fs.statSync(path.join(s.directory, name)).nlink, 1);
    const active = inventory(f);
    assert.ok(active.allocated > 1024 * 1024);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
    for (const name of names)
      assert.equal(fs.existsSync(path.join(s.directory, name)), false);
    const retired = inventory(f);
    assert.ok(retired.allocated < (i + 1) * 32 * 1024);
    measurements.push({ active, retired });
  }
  fs.writeFileSync(
    path.resolve(
      __dirname,
      '../../../build/storage-offline/high-lane-allocation.json',
    ),
    JSON.stringify(
      {
        scope:
          'Passive source/filesystem model only; no high-token or MIC claims',
        measurements,
      },
      null,
      2,
    ),
  );
});

test('version rollover bounds unused verified caches while keeping active and indeterminate versions', async (t) => {
  const f = fixture(t),
    held = await staged(f, 'indeterminate');
  await storage.recordRuntimeStorageAttempt(held.directory, held.runId, {
    pid: 4242,
    creationTime100ns: '134387773076910574',
  });
  const heldBytes = fs.readFileSync(path.join(held.directory, 'ReShade64.dll'));
  for (let i = 1; i <= 8; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 50 + i),
    );
    f.bind();
    const s = await staged(f, 'version-' + i);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
    await pruneRuntimePayloadCache(f.runs);
    assert.ok(
      caches(f).length <= 3,
      'at most two unused versions plus the held version',
    );
    assert.deepEqual(
      fs.readFileSync(path.join(held.directory, 'ReShade64.dll')),
      heldBytes,
    );
  }
  unmapped(held.directory, held.runId);
  await storage.compactRuntimeStorageRun(held.directory);
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(caches(f).length, 2);
});

test('public cache clearing removes only strictly older verified SDK versions with no active aliases', async (t) => {
  const f = fixture(t);
  const current = require('../package.json').version;
  const equal = `${current.split('+')[0]}+equivalent`;
  const cache = sdkRuntimeCacheDirectory(f.runs);
  const versionDirectory = (version) => path.join(cache, crypto.createHash('sha256').update(version).digest('hex'));
  const held = await staged(f, 'held-older', { sdkVersion: '0.0.1' });
  await storage.recordRuntimeStorageAttempt(held.directory, held.runId, {
    pid: 4242, creationTime100ns: '134387773076910574',
  });
  for (const [label, sdkVersion] of [['old', '0.0.2'], ['current', current], ['equal', equal], ['newer', '999.0.0']]) {
    const run = await staged(f, label, { sdkVersion });
    unmapped(run.directory, run.runId);
    await storage.compactRuntimeStorageRun(run.directory);
  }
  const currentAgain = await staged(f, 'current-again', { sdkVersion: current });
  assert.equal(fs.readdirSync(cache).length, 5);
  assert.equal(
    fs.statSync(path.join(currentAgain.directory, 'inject.exe')).ino,
    fs.statSync(path.join(versionDirectory(current), 'inject.exe')).ino,
  );
  const foreign = path.join(cache, 'a'.repeat(64));
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'foreign'), 'preserve');
  const options = { runsRootDirectory: f.runs };
  assert.deepEqual(await clearOldReShadeRuntimeCache(options), ['0.0.2']);
  for (const version of ['0.0.1', current, equal, '999.0.0'])
    assert.ok(fs.existsSync(versionDirectory(version)));
  assert.equal(fs.readFileSync(path.join(foreign, 'foreign'), 'utf8'), 'preserve');
  unmapped(held.directory, held.runId);
  await storage.compactRuntimeStorageRun(held.directory);
  assert.deepEqual(await clearOldReShadeRuntimeCache(options), ['0.0.1']);
  assert.deepEqual(await clearOldReShadeRuntimeCache(options), []);
});

test('a different native payload cannot replace the same SDK version folder', async (t) => {
  const f = fixture(t);
  const sdkVersion = require('../package.json').version;
  const first = await staged(f, 'first', { sdkVersion });
  const directory = path.join(sdkRuntimeCacheDirectory(f.runs), crypto.createHash('sha256').update(sdkVersion).digest('hex'));
  const runtime = path.join(directory, 'ReShade64.dll');
  const previous = fs.readFileSync(runtime);
  fs.writeFileSync(path.join(f.source, 'ReShade64.dll'), 'different runtime');
  f.bind();
  await assert.rejects(staged(f, 'collision', { sdkVersion }), /cache ownership does not match its content identity/);
  assert.deepEqual(fs.readFileSync(runtime), previous);
  assert.deepEqual(fs.readFileSync(path.join(first.directory, 'ReShade64.dll')), previous);
  assert.equal(fs.readdirSync(sdkRuntimeCacheDirectory(f.runs)).length, 1);
});

test('concurrent preparations lease snapshots and retain distinct participant identities', async (t) => {
  const f = fixture(t),
    sessions = await Promise.all(
      Array.from({ length: 8 }, (_, i) => staged(f, 'concurrent-' + i)),
    );
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(caches(f).length, 1);
  const ids = (name) =>
    new Set(sessions.map((s) => fs.statSync(path.join(s.directory, name)).ino));
  assert.equal(ids('ReShade64.dll').size, 1);
  assert.equal(ids('electron_game_overlay.addon64').size, 8);
  assert.equal(ids('ReShade.ini').size, 8);
  for (const s of sessions) {
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
  }
  assert.equal(
    fs.statSync(
      path.join(f.runs + '.payloads-v2', caches(f)[0], 'ReShade64.dll'),
    ).nlink,
    1,
  );
});

test('a durable preparation lease protects an otherwise unused version until its owning stage is proved unused', async (t) => {
  const f = fixture(t),
    first = await staged(f, 'first');
  unmapped(first.directory, first.runId);
  await storage.compactRuntimeStorageRun(first.directory);
  const id = first.result.payloadId,
    cache = path.join(f.runs + '.payloads-v2', id),
    lease = path.join(f.root, 'owned-preparation-lease');
  fs.linkSync(path.join(cache, '.electron-game-overlay-payload.json'), lease);
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 70 + i),
    );
    f.bind();
    const s = await staged(f, 'roll-' + i);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
    await pruneRuntimePayloadCache(f.runs);
    assert.equal(fs.existsSync(cache), true);
  }
  fs.unlinkSync(lease);
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(caches(f).length, 2);
  assert.equal(fs.existsSync(cache), false);
});

test('interrupted cache collection resumes from its bound quarantine receipt without publishing partial snapshots', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 80 + i),
    );
    f.bind();
    const s = await staged(f, 'roll-' + i);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
  }
  const original = fsp.unlink;
  let interrupted = false;
  fsp.unlink = async (file) => {
    if (
      String(file).includes('.collecting-') &&
      path.basename(file) === 'inject32.exe'
    ) {
      interrupted = true;
      throw Object.assign(new Error('owned interruption'), { code: 'EBUSY' });
    }
    return original(file);
  };
  try {
    await pruneRuntimePayloadCache(f.runs);
  } finally {
    fsp.unlink = original;
  }
  assert.equal(interrupted, true);
  const root = f.runs + '.payloads-v2';
  assert.ok(fs.readdirSync(root).some((n) => n.startsWith('.collecting-')));
  for (const id of caches(f))
    for (const name of names)
      assert.equal(
        fs.existsSync(path.join(root, id, name)),
        true,
        'published snapshots must stay complete',
      );
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(caches(f).length, 2);
  assert.equal(
    fs.readdirSync(root).some((n) => n.startsWith('.collecting-')),
    false,
  );
});

test('cache collection preserves foreign entries without repairing or deleting them', async (t) => {
  const f = fixture(t),
    first = await staged(f, 'foreign');
  unmapped(first.directory, first.runId);
  await storage.compactRuntimeStorageRun(first.directory);
  const directory = path.join(f.runs + '.payloads-v2', first.result.payloadId);
  fs.writeFileSync(path.join(directory, 'foreign.addon64'), 'foreign bytes');
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 90 + i),
    );
    f.bind();
    const s = await staged(f, 'new-' + i);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
  }
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(
    fs.readFileSync(path.join(directory, 'foreign.addon64'), 'utf8'),
    'foreign bytes',
  );
  assert.equal(caches(f).length, 3);
});

test('collection rechecks aliases after quarantine when another SDK instance has just prepared the old version', async (t) => {
  const f = fixture(t),
    first = await staged(f, 'initial');
  unmapped(first.directory, first.runId);
  await storage.compactRuntimeStorageRun(first.directory);
  const oldSource = path.join(f.root, 'old-source');
  fs.mkdirSync(oldSource);
  for (const name of names)
    fs.copyFileSync(path.join(f.source, name), path.join(oldSource, name));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 100 + i),
    );
    f.bind();
    const s = await staged(f, 'roll-' + i);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
  }
  const oldCache = path.join(f.runs + '.payloads-v2', first.result.payloadId),
    original = fsp.rename;
  let raced;
  fsp.rename = async (from, to) => {
    if (from === oldCache && !raced) {
      raced = await staged(
        {
          ...f,
          sources: () =>
            new Map(names.map((n) => [n, path.join(oldSource, n)])),
        },
        'racing-preparation',
      );
    }
    return original(from, to);
  };
  try {
    await pruneRuntimePayloadCache(f.runs);
  } finally {
    fsp.rename = original;
  }
  assert.ok(raced);
  assert.equal(fs.existsSync(oldCache), true);
  for (const name of names)
    assert.equal(
      sha(fs.readFileSync(path.join(raced.directory, name))),
      sha(fs.readFileSync(path.join(oldSource, name))),
    );
});

test('preparation retries safely when cache collection wins immediately before its lease acquisition', async (t) => {
  const f = fixture(t),
    first = await staged(f, 'initial');
  unmapped(first.directory, first.runId);
  await storage.compactRuntimeStorageRun(first.directory);
  const oldSource = path.join(f.root, 'old-source');
  fs.mkdirSync(oldSource);
  for (const name of names)
    fs.copyFileSync(path.join(f.source, name), path.join(oldSource, name));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 110 + i),
    );
    f.bind();
    const s = await staged(f, 'roll-' + i);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
  }
  const oldCache = path.join(f.runs + '.payloads-v2', first.result.payloadId),
    original = fsp.link;
  let collected = false;
  fsp.link = async (from, to) => {
    if (
      from === path.join(oldCache, '.electron-game-overlay-payload.json') &&
      !collected
    ) {
      collected = true;
      await pruneRuntimePayloadCache(f.runs);
      assert.equal(fs.existsSync(oldCache), false);
    }
    return original(from, to);
  };
  let recovered;
  try {
    recovered = await staged(
      {
        ...f,
        sources: () => new Map(names.map((n) => [n, path.join(oldSource, n)])),
      },
      'retried',
    );
  } finally {
    fsp.link = original;
  }
  assert.equal(collected, true);
  assert.ok(recovered);
  for (const name of names)
    assert.equal(
      sha(fs.readFileSync(path.join(recovered.directory, name))),
      sha(fs.readFileSync(path.join(oldSource, name))),
    );
});

test('legacy exit proof compacts full copies; weak, corrupt, unknown and foreign records are preserved', async (t) => {
  const f = fixture(t);
  const s = await staged(f, 'legacy');
  fs.unlinkSync(path.join(s.directory, storage.RUNTIME_STORAGE_MARKER_NAME));
  // Replace stage links with private old-style full copies, without executing.
  for (const name of names) {
    fs.unlinkSync(path.join(s.directory, name));
    fs.copyFileSync(path.join(f.source, name), path.join(s.directory, name));
  }
  const before = inventory(f);
  await storage.compactRuntimeStorageRun(s.directory);
  assert.deepEqual(inventory(f), before);
  const report = await inspectReShadeRuntimeStorage({
    runsRootDirectory: f.runs,
  });
  assert.equal(report.entries[0].state, 'exit-proof-missing');
  let queried = false;
  assert.equal(
    await storage.recoverRuntimeStorageRun(s.directory, async () => {
      queried = true;
      return true;
    }),
    false,
  );
  assert.equal(queried, false);
  unmapped(s.directory, s.runId);
  await storage.compactRuntimeStorageRun(s.directory);
  for (const name of names)
    assert.equal(fs.existsSync(path.join(s.directory, name)), false);
  fs.writeFileSync(path.join(s.directory, 'foreign.addon64'), 'foreign bytes');
  assert.equal(
    await storage.runtimeStorageDiagnosticBytes(s.directory),
    undefined,
  );
});

test('a crashed prepared producer requires exact producer-exit proof; attempted unknown targets remain uncertain', async (t) => {
  const f = fixture(t),
    consumer = { pid: 555, creationTime100ns: '134387773076910574' };
  const prepared = await staged(f, 'prepared', { consumer });
  assert.equal(
    await storage.recoverRuntimeStorageRun(
      prepared.directory,
      async () => false,
    ),
    false,
  );
  assert.equal(
    await storage.recoverRuntimeStorageRun(prepared.directory, async (id) => {
      assert.deepEqual(id, consumer);
      return true;
    }),
    true,
  );
  await storage.compactRuntimeStorageRun(prepared.directory);
  assert.ok(
    names.every((n) => !fs.existsSync(path.join(prepared.directory, n))),
  );
  const attempted = await staged(f, 'unknown', { consumer });
  await storage.recordRuntimeStorageAttempt(
    attempted.directory,
    attempted.runId,
    null,
  );
  let queried = false;
  assert.equal(
    await storage.recoverRuntimeStorageRun(attempted.directory, async () => {
      queried = true;
      return true;
    }),
    false,
  );
  assert.equal(queried, false);
});

test('explicit maintenance recovers a recorded exact target via native OS evidence and leaves unidentifiable legacy runs untouched', async (t) => {
  const f = fixture(t),
    s = await staged(f, 'target'),
    target = { pid: 4242, creationTime100ns: '134387773076910574' };
  await storage.recordRuntimeStorageAttempt(s.directory, s.runId, target);
  const legacy = path.join(f.runs, 'old-unidentified');
  fs.mkdirSync(legacy);
  marker(legacy);
  fs.writeFileSync(path.join(legacy, 'ReShade64.dll'), 'unproven old image');
  const original = cp.execFile;
  let calls = 0;
  cp.execFile = (file, args, options, cb) => {
    calls++;
    assert.deepEqual(args, ['--query-process-image', '4242']);
    queueMicrotask(() =>
      cb(
        null,
        JSON.stringify({
          schemaVersion: 1,
          kind: 'electron-game-overlay-process-image',
          pid: 4242,
          executablePath: 'C:\\owned\\game.exe',
          creationTime100ns: '134387773076910575',
        }),
        '',
      ),
    );
  };
  t.after(() => (cp.execFile = original));
  const report = await pruneReShadeRuntimeStorage({ config: f.config() });
  assert.equal(calls, 1);
  assert.equal(
    report.entries.find((e) => e.directory === legacy).state,
    'exit-proof-missing',
  );
  assert.ok(names.every((n) => !fs.existsSync(path.join(s.directory, n))));
  assert.equal(
    fs.readFileSync(path.join(legacy, 'ReShade64.dll'), 'utf8'),
    'unproven old image',
  );
});

for (const [name, response, exited] of [
  [
    'different incarnation',
    {
      record: {
        schemaVersion: 1,
        kind: 'electron-game-overlay-process-image',
        pid: 4242,
        executablePath: 'C:\\owned\\game.exe',
        creationTime100ns: '134387773076910575',
      },
    },
    true,
  ],
  [
    'same live incarnation',
    {
      record: {
        schemaVersion: 1,
        kind: 'electron-game-overlay-process-image',
        pid: 4242,
        executablePath: 'C:\\owned\\game.exe',
        creationTime100ns: '134387773076910574',
      },
    },
    false,
  ],
  [
    'native absent PID',
    {
      error: { code: 5 },
      record: {
        schemaVersion: 1,
        kind: 'electron-game-overlay-reshade-addon-manager-result',
        operation: 'query-process-image',
        status: 'error',
        code: 'process-query-failed',
        message:
          'Unable to open the process for read-only identity inspection.',
        windowsError: 87,
      },
    },
    true,
  ],
  [
    'access denied',
    {
      error: { code: 5 },
      record: {
        schemaVersion: 1,
        kind: 'electron-game-overlay-reshade-addon-manager-result',
        operation: 'query-process-image',
        status: 'error',
        code: 'process-query-failed',
        message:
          'Unable to open the process for read-only identity inspection.',
        windowsError: 5,
      },
    },
    false,
  ],
  ['timeout', { error: { code: 'ETIMEDOUT' }, stdout: '' }, false],
  ['malformed', { stdout: '{}\n{}' }, false],
  [
    'wrong native operation',
    {
      error: { code: 5 },
      record: {
        schemaVersion: 1,
        kind: 'electron-game-overlay-reshade-addon-manager-result',
        operation: 'prepare',
        status: 'error',
        code: 'process-query-failed',
        message:
          'Unable to open the process for read-only identity inspection.',
        windowsError: 87,
      },
    },
    false,
  ],
])
  test('exact OS exit probe: ' + name, async (t) => {
    const original = cp.execFile;
    cp.execFile = (file, args, options, cb) => {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      queueMicrotask(() =>
        cb(
          response.error ?? null,
          response.stdout ?? JSON.stringify(response.record),
          '',
        ),
      );
    };
    t.after(() => (cp.execFile = original));
    assert.equal(
      await overlayProcessIncarnationExited(
        { pid: 4242, creationTime100ns: '134387773076910574' },
        path.resolve(parent, 'passive-manager.exe'),
      ),
      exited,
    );
  });

test('the leased v2 store never rewrites or collects an older unleased v1 store', async (t) => {
  const f = fixture(t),
    s = await staged(f, 'initial');
  unmapped(s.directory, s.runId);
  await storage.compactRuntimeStorageRun(s.directory);
  const modern = path.join(f.runs + '.payloads-v2', s.result.payloadId),
    legacy = path.join(f.runs + '.payloads-v1', s.result.payloadId);
  fs.mkdirSync(legacy, { recursive: true });
  for (const name of names)
    fs.copyFileSync(path.join(modern, name), path.join(legacy, name));
  const record = JSON.parse(
    fs.readFileSync(
      path.join(modern, '.electron-game-overlay-payload.json'),
      'utf8',
    ),
  );
  record.kind = 'electron-game-overlay-payload-v1';
  fs.writeFileSync(
    path.join(legacy, '.electron-game-overlay-payload.json'),
    JSON.stringify(record),
  );
  const before = new Map(
    fs.readdirSync(legacy).map((name) => [
      name,
      {
        hash: sha(fs.readFileSync(path.join(legacy, name))),
        ino: fs.statSync(path.join(legacy, name)).ino,
        mode: fs.statSync(path.join(legacy, name)).mode,
      },
    ]),
  );
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(
      path.join(f.source, 'ReShade64.dll'),
      Buffer.alloc(256 * 1024, 120 + i),
    );
    f.bind();
    const next = await staged(f, 'upgrade-' + i);
    unmapped(next.directory, next.runId);
    await storage.compactRuntimeStorageRun(next.directory);
    await pruneRuntimePayloadCache(f.runs);
  }
  for (const [name, info] of before)
    assert.deepEqual(
      {
        hash: sha(fs.readFileSync(path.join(legacy, name))),
        ino: fs.statSync(path.join(legacy, name)).ino,
        mode: fs.statSync(path.join(legacy, name)).mode,
      },
      info,
    );
  const report = await inspectReShadeRuntimeStorage({
    runsRootDirectory: f.runs,
  });
  assert.equal(report.legacyPayloadStoreDirectory, f.runs + '.payloads-v1');
  assert.equal(report.payloadStoreDirectory, f.runs + '.payloads-v2');
});

test('a crashed unattempted publisher is collected only after exact owner-exit proof releases its publication lease', async (t) => {
  const f = fixture(t),
    directory = path.join(f.runs, 'crashed-publisher');
  fs.mkdirSync(directory);
  const runId = marker(directory),
    consumer = { pid: 1234, creationTime100ns: '134387773076910574' };
  await storage.createRuntimeStorageRecord(directory, runId, consumer);
  const store = f.runs + '.payloads-v2',
    leaf = '.publishing-' + crypto.randomUUID(),
    pending = path.join(store, leaf);
  fs.mkdirSync(pending, { recursive: true });
  const identity = JSON.stringify(
      [...f.sources()].map(([name, file]) => [
        name,
        sha(fs.readFileSync(file)).toLowerCase(),
      ]),
    ),
    payloadId = crypto.createHash('sha256').update(identity).digest('hex');
  const lease = path.join(directory, '.electron-game-overlay-publishing-lease');
  fs.writeFileSync(
    lease,
    JSON.stringify({
      schemaVersion: 1,
      kind: 'electron-game-overlay-publishing-v1',
      payloadId,
      identity,
      runId,
      temporaryName: leaf,
      sessionDirectoryName: path.basename(directory),
    }),
  );
  fs.linkSync(
    lease,
    path.join(pending, '.electron-game-overlay-publishing.json'),
  );
  fs.writeFileSync(
    path.join(pending, 'inject.exe'),
    'partial, never published image bytes',
  );
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(
    fs.existsSync(pending),
    true,
    'a live publication lease is not garbage',
  );
  assert.equal(
    await storage.recoverRuntimeStorageRun(directory, async () => false),
    false,
  );
  await storage.compactRuntimeStorageRun(directory);
  assert.equal(fs.existsSync(lease), true);
  assert.equal(
    await storage.recoverRuntimeStorageRun(directory, async (id) => {
      assert.deepEqual(id, consumer);
      return true;
    }),
    true,
  );
  await storage.compactRuntimeStorageRun(directory);
  assert.equal(fs.existsSync(lease), false);
  await pruneRuntimePayloadCache(f.runs);
  assert.equal(
    fs.existsSync(pending),
    false,
    'the positively unused partial publication must not accumulate',
  );
});

test('diagnostic-only quarantine resumes after restart, while a foreign entry prevents whole-directory deletion', async (t) => {
  const f = fixture(t);
  for (const foreign of [false, true]) {
    const s = await staged(f, 'retired-' + foreign);
    unmapped(s.directory, s.runId);
    await storage.compactRuntimeStorageRun(s.directory);
    const quarantine = path.join(
      f.runs,
      '.electron-game-overlay-retired-' + crypto.randomUUID(),
    );
    fs.renameSync(s.directory, quarantine);
    if (foreign)
      fs.writeFileSync(
        path.join(quarantine, 'foreign.addon64'),
        'foreign content',
      );
    await pruneReShadeRuntimeStorage({
      config: f.config(),
      maxRecoveryProbes: 0,
    });
    assert.equal(fs.existsSync(quarantine), foreign);
  }
});

test('large private mutable INI is removed after proof, and linked diagnostic bytes are never trimmed', async (t) => {
  const f = fixture(t),
    s = await staged(f, 'private-data'),
    external = path.join(f.root, 'foreign-log');
  fs.writeFileSync(external, Buffer.alloc(1024 * 1024, 65));
  fs.linkSync(external, path.join(s.directory, 'ReShade.log'));
  fs.writeFileSync(
    path.join(s.directory, 'ReShade.ini'),
    Buffer.alloc(256 * 1024, 66),
  );
  const before = sha(fs.readFileSync(external));
  unmapped(s.directory, s.runId);
  await storage.compactRuntimeStorageRun(s.directory);
  assert.equal(fs.existsSync(path.join(s.directory, 'ReShade.ini')), false);
  assert.equal(sha(fs.readFileSync(external)), before);
  assert.equal(fs.statSync(external).nlink, 2);
  assert.equal(
    await storage.runtimeStorageDiagnosticBytes(s.directory),
    undefined,
  );
});

test('retired diagnostic data is bounded by stream, directory count and total bytes', async (t) => {
  const f = fixture(t),
    now = Date.now();
  for (let i = 0; i < 18; i++) {
    const s = await staged(f, 'budget-' + String(i).padStart(2, '0'));
    for (const name of [
      'ReShade.log',
      'inject.stdout.log',
      'inject.stderr.log',
    ])
      fs.writeFileSync(
        path.join(s.directory, name),
        Buffer.alloc(128 * 1024, 65 + i),
      );
    unmapped(
      s.directory,
      s.runId,
      new Date(now - (18 - i) * 1000).toISOString(),
    );
  }
  await pruneReShadeRuntimeStorage({
    config: f.config(),
    maxRecoveryProbes: 0,
  });
  const directories = fs.readdirSync(f.runs);
  assert.equal(directories.length, 16);
  let bytes = 0;
  for (const name of directories) {
    const directory = path.join(f.runs, name);
    assert.ok(names.every((n) => !fs.existsSync(path.join(directory, n))));
    const count = await storage.runtimeStorageDiagnosticBytes(directory);
    assert.equal(typeof count, 'number');
    bytes += count;
    for (const log of ['ReShade.log', 'inject.stdout.log', 'inject.stderr.log'])
      assert.equal(fs.statSync(path.join(directory, log)).size, 64 * 1024);
  }
  assert.ok(bytes <= 4 * 1024 * 1024);
  fs.writeFileSync(
    path.resolve(
      __dirname,
      '../../../build/storage-offline/diagnostic-budget.json',
    ),
    JSON.stringify(
      {
        directories: directories.length,
        retainedBytes: bytes,
        maximumBytes: 4 * 1024 * 1024,
        payloadFilesRetained: 0,
      },
      null,
      2,
    ),
  );
});

test('public maintenance isolates inaccessible stages throughout compaction, quarantine and budget scans', async (t) => {
  for (const phase of ['compact-EPERM', 'quarantine-EACCES', 'budget-EPERM']) {
    await t.test(phase, async (t) => {
      const f = fixture(t),
        now = Date.now(),
        warnings = [];
      for (let i = 0; i < 20; i++) {
        const directory = path.join(
          f.runs,
          'medium-' + String(i).padStart(2, '0'),
        );
        fs.mkdirSync(directory);
        const id = marker(directory);
        unmapped(directory, id, new Date(now - (20 - i) * 1000).toISOString());
      }
      const protectedName = phase.startsWith('quarantine')
        ? '.electron-game-overlay-retired-' + crypto.randomUUID()
        : '000-protected';
      const protectedDirectory = path.join(f.runs, protectedName);
      fs.mkdirSync(protectedDirectory);
      const id = marker(protectedDirectory);
      unmapped(protectedDirectory, id, new Date(now).toISOString());
      await storage.createRuntimeStorageRecord(protectedDirectory, id, null);
      const protectedLeaf = path.join(
        protectedDirectory,
        phase.startsWith('compact')
          ? 'electron-game-overlay-owned-runtime-v1.marker'
          : 'inject.stdout.log',
      );
      fs.writeFileSync(protectedLeaf, 'protected bytes');
      const foreign = path.join(f.runs, 'foreign');
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, 'data'), 'foreign bytes');
      const before = fs.statSync(protectedLeaf, { bigint: true });
      const method = phase.startsWith('compact') ? 'unlink' : 'lstat';
      const original = fsp[method],
        originalWarn = console.warn;
      let denied = 0,
        stats = 0;
      fsp[method] = async (file, ...args) => {
        if (
          String(file) === protectedLeaf &&
          (!phase.startsWith('budget') || (!args[0]?.bigint && ++stats >= 2))
        ) {
          denied++;
          throw Object.assign(new Error('inaccessible owned test stage'), {
            code: phase.includes('EACCES') ? 'EACCES' : 'EPERM',
            path: String(file),
          });
        }
        return original(file, ...args);
      };
      console.warn = (value) => warnings.push(String(value));
      try {
        await pruneReShadeRuntimeStorage({
          config: f.config(),
          maxRecoveryProbes: 0,
        });
        assert.ok(denied > 0, 'the inaccessible entry must be exercised');
        assert.ok(
          warnings.some((w) => w.includes(JSON.stringify(protectedDirectory))),
        );
        assert.ok(
          !warnings.some((w) => w.includes('Unable to scan completed')),
        );
        assert.equal(
          fs.readdirSync(f.runs).filter((n) => n.startsWith('medium-')).length,
          16,
        );
        assert.equal(fs.readFileSync(protectedLeaf, 'utf8'), 'protected bytes');
        const after = fs.statSync(protectedLeaf, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.mode, before.mode);
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.equal(
          fs.readFileSync(path.join(foreign, 'data'), 'utf8'),
          'foreign bytes',
        );
      } finally {
        fsp[method] = original;
        console.warn = originalWarn;
      }
      // An authorized later sweep can resume the preserved entry.
      await pruneReShadeRuntimeStorage({
        config: f.config(),
        maxRecoveryProbes: 0,
      });
      assert.equal(
        fs.readdirSync(f.runs).filter((n) => n !== 'foreign').length,
        16,
      );
      assert.equal(
        fs.readFileSync(path.join(foreign, 'data'), 'utf8'),
        'foreign bytes',
      );
    });
  }
});

test('write-protected retired metadata is left in place until an authorized sweep', async (t) => {
  const f = fixture(t);
  const directory = path.join(f.runs, 'protected-diagnostics');
  const accessible = path.join(f.runs, 'accessible-diagnostics');
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  for (const run of [directory, accessible]) {
    fs.mkdirSync(run);
    unmapped(run, marker(run), expired);
  }
  const protectedLeaf = path.join(directory, '.electron-game-overlay-run.json');
  const before = fs.readFileSync(protectedLeaf);
  const originalOpen = fsp.open, originalRename = fsp.rename, originalWarn = console.warn;
  const warnings = [];
  const renamed = [];
  fsp.open = async (file, flags, ...args) => {
    if (file === protectedLeaf && flags === 'r+') {
      throw Object.assign(new Error('fixture models a mandatory write denial'), { code: 'EPERM' });
    }
    return originalOpen(file, flags, ...args);
  };
  fsp.rename = async (from, to) => {
    renamed.push(from);
    return originalRename(from, to);
  };
  console.warn = (value) => warnings.push(String(value));
  try {
    await pruneReShadeRuntimeStorage({ config: f.config(), maxRecoveryProbes: 0 });
    assert.ok(warnings.some((warning) => warning.includes(JSON.stringify(directory))));
    assert.equal(renamed.includes(directory), false);
    assert.equal(fs.existsSync(accessible), false);
    assert.deepEqual(fs.readFileSync(protectedLeaf), before);
  } finally {
    fsp.open = originalOpen;
    fsp.rename = originalRename;
    console.warn = originalWarn;
  }
  await pruneReShadeRuntimeStorage({ config: f.config(), maxRecoveryProbes: 0 });
  assert.equal(fs.existsSync(directory), false);
});

test('a denied recovery proof publication preserves that attempt and still recovers its peer', async (t) => {
  const f = fixture(t),
    first = await staged(f, '000-denied'),
    second = await staged(f, 'later');
  const identity = { pid: 4242, creationTime100ns: '134387773076910574' };
  for (const s of [first, second])
    await storage.recordRuntimeStorageAttempt(s.directory, s.runId, identity);
  const originalExec = cp.execFile,
    originalRename = fsp.rename,
    originalWarn = console.warn;
  const warnings = [];
  let probes = 0,
    denied = 0;
  cp.execFile = (file, args, options, cb) => {
    probes++;
    assert.deepEqual(args, ['--query-process-image', '4242']);
    queueMicrotask(() =>
      cb(
        null,
        JSON.stringify({
          schemaVersion: 1,
          kind: 'electron-game-overlay-process-image',
          pid: 4242,
          executablePath: 'C:\\owned\\game.exe',
          creationTime100ns: '134387773076910575',
        }),
        '',
      ),
    );
  };
  fsp.rename = async (from, to) => {
    if (
      to ===
      path.join(first.directory, '.electron-game-overlay-run-reclaimable.json')
    ) {
      denied++;
      throw Object.assign(new Error('proof publication denied'), {
        code: 'EPERM',
      });
    }
    return originalRename(from, to);
  };
  console.warn = (value) => warnings.push(String(value));
  try {
    const report = await pruneReShadeRuntimeStorage({
      config: f.config(),
      maxRecoveryProbes: 2,
    });
    assert.equal(probes, 2);
    assert.equal(denied, 1);
    assert.ok(
      warnings.some((w) => w.includes(JSON.stringify(first.directory))),
    );
    assert.equal(
      report.entries.find((e) => e.directory === first.directory).state,
      'exact-target-recorded',
    );
    assert.ok(names.every((n) => fs.existsSync(path.join(first.directory, n))));
    assert.ok(
      names.every((n) => !fs.existsSync(path.join(second.directory, n))),
    );
  } finally {
    cp.execFile = originalExec;
    fsp.rename = originalRename;
    console.warn = originalWarn;
  }
});

test('retirement preserves unexpected aliases of private policy and transport metadata', async (t) => {
  const f = fixture(t),
    s = await staged(f, 'aliased-metadata');
  for (const name of [
    'ego-process-policy.txt',
    'electron-game-overlay-owned-runtime-v1.marker',
    'electron-overlay-transport-v1.json',
  ]) {
    const external = path.join(f.root, name);
    fs.writeFileSync(external, 'private metadata alias');
    fs.linkSync(external, path.join(s.directory, name));
  }
  unmapped(s.directory, s.runId);
  await storage.compactRuntimeStorageRun(s.directory);
  for (const name of [
    'ego-process-policy.txt',
    'electron-game-overlay-owned-runtime-v1.marker',
    'electron-overlay-transport-v1.json',
  ]) {
    assert.equal(fs.statSync(path.join(f.root, name)).nlink, 2);
    assert.equal(
      fs.readFileSync(path.join(s.directory, name), 'utf8'),
      'private metadata alias',
    );
  }
  assert.equal(
    await storage.runtimeStorageDiagnosticBytes(s.directory),
    undefined,
  );
});

test('immediate filesystem-process exit at the final payload deletion leaves no staging controls', async (t) => {
  for (const high of [false, true]) {
    await t.test(
      high ? 'passive high layout' : 'ordinary snapshot layout',
      async (t) => {
        const f = fixture(t),
          s = await staged(f, 'early-exit', { high });
        for (const name of storage.RUNTIME_STORAGE_TRANSIENT_NAMES) {
          const file = path.join(s.directory, name);
          if (!fs.existsSync(file)) fs.writeFileSync(file, 'owned control');
        }
        // A live or indeterminate run cannot enter the cleanup transaction.
        await storage.compactRuntimeStorageRun(s.directory);
        assert.ok(names.every((n) => fs.existsSync(path.join(s.directory, n))));
        assert.ok(
          storage.RUNTIME_STORAGE_TRANSIENT_NAMES.every((n) =>
            fs.existsSync(path.join(s.directory, n)),
          ),
        );
        unmapped(s.directory, s.runId);
        const script = `
        const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
        const directory=process.argv[1], names=${JSON.stringify(names)};
        const original=fsp.unlink;
        fsp.unlink=async(file)=>{
          await original(file);
          if(names.every(n=>!fs.existsSync(path.join(directory,n))))process.exit(0);
        };
        require(${JSON.stringify(path.resolve(__dirname, '../dist/lib/runtime-stage-storage.js'))})
          .compactRuntimeStorageRun(directory).then(()=>process.exit(2),e=>{console.error(e);process.exit(3)});
      `;
        const child = cp.spawnSync(
          process.execPath,
          ['-e', script, s.directory],
          { encoding: 'utf8', windowsHide: true, timeout: 10000 },
        );
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr);
        assert.ok(
          names.every((n) => !fs.existsSync(path.join(s.directory, n))),
        );
        for (const name of storage.RUNTIME_STORAGE_TRANSIENT_NAMES)
          assert.equal(
            fs.existsSync(path.join(s.directory, name)),
            false,
            `early exit retained ${name}`,
          );
        assert.equal(
          (await storage.inspectRuntimeStorageRun(s.directory)).unmapped,
          true,
        );
        assert.equal(
          typeof (await storage.runtimeStorageDiagnosticBytes(s.directory)),
          'number',
        );
      },
    );
  }
});

test('a temporarily shared control pauses payload retirement and resumes from persisted proof', async (t) => {
  const f = fixture(t),
    s = await staged(f, 'busy-control');
  const policy = path.join(s.directory, 'ego-process-policy.txt');
  fs.writeFileSync(policy, 'original policy');
  unmapped(s.directory, s.runId);
  const original = fsp.unlink;
  fsp.unlink = async (file) => {
    if (file === policy)
      throw Object.assign(new Error('owned test sharing violation'), {
        code: 'EBUSY',
      });
    return original(file);
  };
  try {
    await assert.rejects(storage.compactRuntimeStorageRun(s.directory), {
      code: 'EBUSY',
    });
    assert.ok(
      names.every((n) => fs.existsSync(path.join(s.directory, n))),
      'no payload checkpoint may precede the blocked control',
    );
    assert.equal(fs.readFileSync(policy, 'utf8'), 'original policy');
    assert.equal(
      (await storage.inspectRuntimeStorageRun(s.directory)).unmapped,
      true,
    );
  } finally {
    fsp.unlink = original;
  }
  await pruneReShadeRuntimeStorage({
    config: f.config(),
    maxRecoveryProbes: 0,
  });
  assert.ok(names.every((n) => !fs.existsSync(path.join(s.directory, n))));
  assert.equal(fs.existsSync(policy), false);
  assert.equal(
    typeof (await storage.runtimeStorageDiagnosticBytes(s.directory)),
    'number',
  );
});

test('identical payload bytes share one snapshot regardless of source-map insertion order', async (t) => {
  const f = fixture(t),
    first = await staged(f, 'forward'),
    second = await staged(
      { ...f, sources: () => new Map([...f.sources()].reverse()) },
      'reverse',
    );
  assert.equal(first.result.payloadId, second.result.payloadId);
  assert.equal(caches(f).length, 1);
  assert.equal(
    fs.statSync(path.join(first.directory, 'ReShade64.dll'), { bigint: true })
      .ino,
    fs.statSync(path.join(second.directory, 'ReShade64.dll'), { bigint: true })
      .ino,
  );
  assert.notEqual(
    fs.statSync(path.join(first.directory, 'electron_game_overlay.addon64'), {
      bigint: true,
    }).ino,
    fs.statSync(path.join(second.directory, 'electron_game_overlay.addon64'), {
      bigint: true,
    }).ino,
  );
});
