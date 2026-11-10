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
  RUNTIME_PAYLOAD_NAMES: names,
} = require('../dist/lib/runtime-payload-store.js');
const storage = require('../dist/lib/runtime-stage-storage.js');
const {
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
  inspectReShadeRuntimeStorage,
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
async function staged(f, label, { high = false, consumer = null } = {}) {
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
