const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:net');
const test = require('node:test');
const fixture = require('./helpers/standalone-broker-fixture.cjs');
test.after(() => fixture.disposeFixture());
// Control only the privilege-probe boundary for real pipe/filesystem/exe coverage
// on high-integrity hosted runners. Production has no bypass option.
let restorePrivilegeProbe = fixture.controlPrivilegeProbe();
test.after(() => restorePrivilegeProbe());
const windows = process.platform === 'win32';
const startupTimeout = windows ? 20000 : 2000;
const stalledTimeout = windows ? 5000 : 200;
const latencyBudget = windows ? 8000 : 500;
const slowIo = windows ? 9000 : 700;
const privilegeSetup = `require(${JSON.stringify(require.resolve('./helpers/standalone-broker-fixture.cjs'))}).controlPrivilegeProbe();`;
const protocol = require('../dist/lib/overlay-broker-protocol.js');
const bootstrap = (() => {
  try {
    return require('../dist/lib/overlay-broker-bootstrap.js');
  } catch {
    return {};
  }
})();

async function context(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ego-boot-'));
  t.after(async () => {
    try {
      for (const line of (
        await fs.readFile(path.join(root, 'launches.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')) {
        try {
          process.kill(JSON.parse(line).pid, 'SIGKILL');
        } catch {}
      }
    } catch {}
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 30,
      retryDelay: 100,
    });
  });
  return {
    root,
    options: {
      storageRoot: path.join(root, 'state'),
      pipePath:
        process.platform === 'win32'
          ? `\\\\.\\pipe\\ego-bootstrap-test-${randomUUID()}`
          : path.join(root, 'broker.sock'),
      timeoutMs: startupTimeout,
    },
  };
}
async function owner(t, pipePath) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new protocol.BrokerPacketDecoder();
    socket.on('data', (data) => {
      for (const packet of decoder.push(data))
        if (packet.value?.type === 'broker.hello')
          socket.write(
            protocol.encodeBrokerJsonPacket({
              type: 'broker.welcome',
              protocolVersion: 1,
              sessionId: 'existing',
              brokerPid: process.pid,
              capabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES,
            }),
          );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  });
}

async function distribution(
  t,
  c,
  version,
  mode = 'healthy',
  delayMs = 0,
  forceNative = false,
) {
  const source = path.join(c.root, randomUUID());
  await fs.mkdir(source);
  await fixture.writeFixtureDistribution(
    source,
    {
      version,
      mode,
      delayMs,
      log: path.join(c.root, 'launches.jsonl'),
      capabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES,
    },
    forceNative,
  );
  return source;
}

async function launches(c) {
  try {
    return (await fs.readFile(path.join(c.root, 'launches.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
  } catch {
    return [];
  }
}

test('a valid registered cache remains usable when the same bundled source payload disappears', async (t) => {
  const c = await context(t);
  const source = await distribution(t, c, '1.0.0');
  await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
    { storageRoot: c.options.storageRoot, distributionPath: source },
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, 'broker-manifest.json'), 'utf8'),
  );
  await fs.unlink(path.join(source, manifest.executable));
  await assert.doesNotReject(
    bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: source,
    }),
    'metadata identity must not let a broken own source hide its valid independent cache',
  );
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['1.0.0'],
  );
});

test('a generic standalone fixture is a real native executable with sealed adjacent configuration', async (t) => {
  const c = await context(t);
  const source = await distribution(t, c, '1.0.0', 'healthy', 0, true);
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, 'broker-manifest.json'), 'utf8'),
  );
  const fixtureHandle = await fs.open(path.join(source, manifest.executable));
  const hostHandle = await fs.open(process.execPath);
  const actual = Buffer.alloc(4);
  const expected = Buffer.alloc(4);
  try {
    await fixtureHandle.read(actual);
    await hostHandle.read(expected);
  } finally {
    await fixtureHandle.close();
    await hostHandle.close();
  }
  assert.deepEqual(
    actual,
    expected,
    'the OS must execute a real binary, not a Linux shebang or fake .exe',
  );
  assert.ok(
    manifest.files.some((file) => file.path === 'fixture-config.json'),
    'fixture mode/version/log configuration must be hash-sealed and copied',
  );
  await bootstrap.ensureOverlayBrokerRunning({
    ...c.options,
    timeoutMs: 20000,
    distributionPath: source,
  });
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['1.0.0'],
  );
});

test('slow selected catalog payload validation leaves the own fallback a startup budget', async (t) => {
  const c = await context(t);
  const own = await distribution(t, c, '1.0.0');
  await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
    {
      storageRoot: c.options.storageRoot,
      distributionPath: await distribution(t, c, '2.0.0'),
    },
  );
  const catalog = JSON.parse(
    await fs.readFile(path.join(c.options.storageRoot, 'catalog.json'), 'utf8'),
  );
  const optionalGroup =
    path.join(c.options.storageRoot, 'cache', catalog.entries[0].id) + path.sep;
  const original = fs.open;
  let payloadReads = 0;
  fs.open = async function (filename, ...args) {
    if (
      filename.startsWith(optionalGroup) &&
      path.basename(filename).startsWith('electron-game-overlay-broker')
    ) {
      payloadReads++;
      await new Promise((resolve) => setTimeout(resolve, slowIo));
    }
    return original.call(this, filename, ...args);
  };
  const started = Date.now();
  try {
    await assert.doesNotReject(
      bootstrap.ensureOverlayBrokerRunning({
        ...c.options,
        timeoutMs: latencyBudget,
        distributionPath: own,
      }),
      'optional payload validation cannot exhaust the own fallback budget',
    );
  } finally {
    fs.open = original;
  }
  assert.ok(Date.now() - started < latencyBudget + 150);
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['1.0.0'],
  );
  await new Promise((resolve) => setTimeout(resolve, slowIo + 50));
  assert.equal(
    payloadReads,
    1,
    'expired optional validation does not continue to other payloads',
  );
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['1.0.0'],
  );
});

test('slow optional catalog metadata cannot starve ordinary own startup or its deadline', async (t) => {
  const c = await context(t);
  const own = await distribution(t, c, '1.0.0');
  await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
    {
      storageRoot: c.options.storageRoot,
      distributionPath: await distribution(t, c, '2.0.0'),
    },
  );
  const original = fs.open;
  let metadataReads = 0;
  const catalog = JSON.parse(
    await fs.readFile(path.join(c.options.storageRoot, 'catalog.json'), 'utf8'),
  );
  const optionalGroup =
    path.join(c.options.storageRoot, 'cache', catalog.entries[0].id) + path.sep;
  fs.open = async function (filename, ...args) {
    if (
      filename.startsWith(optionalGroup) &&
      path.basename(filename) === 'broker-manifest.json'
    ) {
      metadataReads++;
      await new Promise((resolve) => setTimeout(resolve, slowIo));
    }
    return original.call(this, filename, ...args);
  };
  const started = Date.now();
  try {
    await assert.doesNotReject(
      bootstrap.ensureOverlayBrokerRunning({
        ...c.options,
        timeoutMs: latencyBudget,
        distributionPath: own,
      }),
      'optional catalog latency must leave time for own startup',
    );
  } finally {
    fs.open = original;
  }
  assert.ok(
    Date.now() - started < latencyBudget + 150,
    'startup obeys its overall budget',
  );
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['1.0.0'],
  );
  assert.equal(metadataReads, 1);
  await new Promise((resolve) => setTimeout(resolve, slowIo + 50));
});

test('validates only the selected eligible cached payload and never copies an unselected own distribution', async (t) => {
  const c = await context(t);
  const own = await distribution(t, c, '1.0.0');
  const install = require('../dist/lib/overlay-broker-installation.js');
  for (const version of ['2.0.0', '3.0.0', '99.0.0-beta.1']) {
    await install.registerOverlayBrokerInstallation({
      storageRoot: c.options.storageRoot,
      distributionPath: await distribution(t, c, version),
      allowPrerelease: true,
    });
  }
  const opened = [];
  const original = fs.open;
  fs.open = async function (filename, ...args) {
    if (path.basename(filename).startsWith('electron-game-overlay-broker')) {
      opened.push(filename);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return original.call(this, filename, ...args);
  };
  try {
    await bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: own,
    });
  } finally {
    fs.open = original;
  }
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['3.0.0'],
  );
  assert.equal(
    opened.length,
    1,
    'only the chosen cached executable is hashed, immediately before launch',
  );
  assert.equal(
    opened.some((filename) => filename.startsWith(own + path.sep)),
    false,
  );
  assert.equal(
    (await fs.readdir(path.join(c.options.storageRoot, 'cache'))).length,
    3,
    'unselected own distribution is not copied',
  );
});

test('obsolete null corrupt or reused-PID launch journals cannot permanently disable coordinator startup', async (t) => {
  for (const journal of [
    JSON.stringify({ schema: 1, pid: null }),
    '{broken',
    JSON.stringify({ schema: 1, pid: process.pid }),
  ]) {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0');
    await fs.mkdir(c.options.storageRoot, { recursive: true });
    const filename = path.join(
      c.options.storageRoot,
      `launch-${createHash('sha256')
        .update(
          process.platform === 'win32'
            ? c.options.pipePath.toLowerCase()
            : c.options.pipePath,
        )
        .digest('hex')}.json`,
    );
    await fs.writeFile(filename, journal);
    const claim = path.join(c.options.storageRoot, 'target-claim.json');
    await fs.writeFile(
      claim,
      'possibly consumed target claim: must not change',
    );
    await assert.doesNotReject(
      bootstrap.ensureOverlayBrokerRunning({
        ...c.options,
        distributionPath: source,
      }),
      'obsolete launch metadata must not deny startup',
    );
    assert.equal(
      (await launches(c)).length,
      1,
      'a coordinator can start to adopt existing native claims',
    );
    assert.equal(
      await fs.readFile(claim, 'utf8'),
      'possibly consumed target claim: must not change',
    );
    assert.equal(
      await fs.readFile(filename, 'utf8'),
      journal,
      'obsolete journal is not an authority or mutated',
    );
  }
});

test(
  'cross-process first starters launch only one detached standalone',
  {},
  async (t) => {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0', 'healthy', 200);
    const { promisify } = require('node:util');
    const { execFile } = require('node:child_process');
    const options = {
      ...c.options,
      distributionPath: source,
      timeoutMs: windows ? startupTimeout : 4000,
    };
    const modulePath =
      require.resolve('../dist/lib/overlay-broker-bootstrap.js');
    await Promise.all(
      Array.from({ length: 6 }, () =>
        promisify(execFile)(process.execPath, [
          '-e',
          `${privilegeSetup} require(${JSON.stringify(modulePath)}).ensureOverlayBrokerRunning(${JSON.stringify(options)}).catch(e => { console.error(e); process.exitCode = 1; })`,
        ]),
      ),
    );
    assert.equal((await launches(c)).length, 1);
  },
);

test(
  'standalone children discard inherited Node hooks including Windows case variants',
  {},
  async (t) => {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0');
    const keys = [
      'NODE_OPTIONS',
      'NODE_PATH',
      'ELECTRON_RUN_AS_NODE',
      'Node_Options',
      'Node_Path',
      'Electron_Run_As_Node',
    ];
    const old = keys.map((key) => process.env[key]);
    try {
      for (const key of keys)
        process.env[key] =
          key.toUpperCase() === 'NODE_OPTIONS'
            ? '--require=/nonexistent-ego-test-hook'
            : 'fixture';
      await bootstrap.ensureOverlayBrokerRunning({
        ...c.options,
        distributionPath: source,
      });
      assert.deepEqual((await launches(c))[0].inheritedHooks, []);
    } finally {
      keys.forEach((key, index) => {
        if (old[index] === undefined) delete process.env[key];
        else process.env[key] = old[index];
      });
    }
  },
);

test('shared launch accepts only a proven medium Windows integrity label, never environment claims', () => {
  assert.equal(typeof bootstrap.assertOverlayBrokerIntegrityOutput, 'function');
  assert.doesNotThrow(() =>
    bootstrap.assertOverlayBrokerIntegrityOutput(
      '"Mandatory Label\\\\Medium Mandatory Level","Label","S-1-16-8192",""',
    ),
  );
  for (const output of [
    '',
    'USERNAME=normal; ADMIN=false',
    'S-1-16-12288',
    'S-1-16-16384',
    'S-1-16-8448',
    'S-1-16-8192 S-1-16-12288',
    'S-1-16-8192extra',
  ]) {
    assert.throws(
      () => bootstrap.assertOverlayBrokerIntegrityOutput(output),
      /elevat|integrity|medium/i,
    );
  }
});

test(
  'the real Windows host privilege probe accepts or refuses consistently with the actual token',
  { skip: !windows },
  async (t) => {
    restorePrivilegeProbe();
    try {
      const { execFile } = require('node:child_process');
      const { promisify } = require('node:util');
      const directory = '\\\\?\\GLOBALROOT\\SystemRoot\\System32';
      let output = '';
      try {
        ({ stdout: output } = await promisify(execFile)(
          `${directory}\\whoami.exe`,
          ['/groups', '/fo', 'csv', '/nh'],
          {
            cwd: directory,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
            timeout: 2000,
            maxBuffer: 65536,
          },
        ));
      } catch {
        /* Unavailable host proof must refuse, too. */
      }
      const labels = [...output.matchAll(/S-1-16-([0-9]+)/g)].map(
        (match) => match[1],
      );
      const medium = labels.length === 1 && labels[0] === '8192';
      t.diagnostic(
        `real host integrity labels: ${labels.join(',') || 'unavailable'}; expected ${medium ? 'accept' : 'refuse'}`,
      );
      if (medium)
        await assert.doesNotReject(bootstrap.assertOverlayBrokerPrivilege());
      else {
        const c = await context(t);
        await assert.rejects(
          bootstrap.ensureOverlayBrokerRunning({
            ...c.options,
            distributionPath: path.join(
              c.root,
              'untrusted-catalog-distribution',
            ),
          }),
          /integrity|medium|unsupported/i,
        );
        await assert.rejects(fs.access(c.options.storageRoot), {
          code: 'ENOENT',
        });
        assert.deepEqual(await launches(c), []);
      }
    } finally {
      restorePrivilegeProbe = fixture.controlPrivilegeProbe();
    }
  },
);

test(
  'rechecks a legacy owner that appears during distribution validation before spawning',
  {},
  async (t) => {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0');
    const payload = Buffer.alloc(32 * 1024 * 1024, 7);
    await fs.writeFile(path.join(source, 'payload.bin'), payload);
    const manifestPath = path.join(source, 'broker-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.files.push({
      path: 'payload.bin',
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const startup = bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      timeoutMs: windows ? startupTimeout : 5000,
      distributionPath: source,
    });
    const deadline = Date.now() + startupTimeout;
    for (;;) {
      try {
        if (
          (await fs.readdir(path.join(c.options.storageRoot, 'cache'))).some(
            (name) => name.startsWith('.staging-'),
          )
        )
          break;
      } catch {}
      assert.ok(
        Date.now() < deadline,
        'must observe in-progress independent cache publication',
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await owner(t, c.options.pipePath);
    await startup;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await launches(c)).length, 0);
  },
);

test(
  'falls back only after the selected child has actually exited',
  {},
  async (t) => {
    const c = await context(t);
    const own = await distribution(t, c, '1.0.0');
    const failed = await distribution(t, c, '2.0.0', 'exit');
    await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
      { storageRoot: c.options.storageRoot, distributionPath: failed },
    );
    await bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: own,
    });
    const records = await launches(c);
    assert.deepEqual(
      records.map((entry) => entry.version),
      ['2.0.0', '1.0.0'],
    );
    assert.throws(() => process.kill(records[0].pid, 0), { code: 'ESRCH' });
  },
);

test('an occupied endpoint must prove v1 rather than merely accepting a connection', async (t) => {
  const c = await context(t);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(c.options.pipePath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(
    bootstrap.ensureOverlayBrokerRunning({ ...c.options, timeoutMs: 60 }),
    /handshake|uncertain/i,
  );
  await assert.rejects(fs.access(c.options.storageRoot));
});

test(
  'a later higher registered broker never preempts a healthy earlier standalone',
  {},
  async (t) => {
    const c = await context(t);
    const own = await distribution(t, c, '1.0.0');
    await bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: own,
    });
    const newer = await distribution(t, c, '99.0.0');
    await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
      { storageRoot: c.options.storageRoot, distributionPath: newer },
    );
    await bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: newer,
    });
    assert.deepEqual(
      (await launches(c)).map((entry) => entry.version),
      ['1.0.0'],
    );
  },
);

test(
  'SDK startup uses the independent standalone bootstrap without auto-registering',
  { timeout: windows ? 30000 : 5000 },
  async (t) => {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0');
    const {
      OverlayBrokerClient,
    } = require('../dist/lib/overlay-broker-client.js');
    const client = new OverlayBrokerClient({
      pipePath: c.options.pipePath,
      connectTimeoutMs: windows ? startupTimeout : 2500,
      brokerInstallation: {
        storageRoot: c.options.storageRoot,
        distributionPath: source,
      },
    });
    t.after(() => client.stop());
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    client.start();
    await client.whenReady();
    assert.equal((await launches(c)).length, 1);
    await assert.rejects(
      fs.access(path.join(c.options.storageRoot, 'catalog.json')),
    );
  },
);

test(
  'bootstrap process death releases launch arbitration without changing native target claims',
  {},
  async (t) => {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0', 'stall');
    const options = {
      ...c.options,
      distributionPath: source,
      timeoutMs: stalledTimeout,
    };
    const { promisify } = require('node:util');
    const { execFile } = require('node:child_process');
    await promisify(execFile)(process.execPath, [
      '-e',
      `${privilegeSetup} require(${JSON.stringify(require.resolve('../dist/lib/overlay-broker-bootstrap.js'))}).ensureOverlayBrokerRunning(${JSON.stringify(options)}).catch(e => console.log(e.message))`,
    ]);
    const [child] = await launches(c);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    const claim = path.join(c.options.storageRoot, 'target-claim.json');
    await fs.writeFile(claim, 'possibly consumed native ownership');
    const replacement = await distribution(t, c, '1.0.1');
    await bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: replacement,
    });
    assert.deepEqual(
      (await launches(c)).map((entry) => entry.version),
      ['1.0.0', '1.0.1'],
    );
    assert.doesNotThrow(
      () => process.kill(child.pid, 0),
      'coordinator availability does not imply an old process or native target exited',
    );
    assert.equal(
      await fs.readFile(claim, 'utf8'),
      'possibly consumed native ownership',
    );
  },
);

test('a timed-out unbound coordinator does not hold launch arbitration indefinitely', async (t) => {
  const c = await context(t);
  const stalled = await distribution(t, c, '1.0.0', 'stall');
  await assert.rejects(
    bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: stalled,
      timeoutMs: stalledTimeout,
    }),
    /live|uncertain|timeout/i,
  );
  const [prior] = await launches(c);
  assert.ok(prior, 'the stalled coordinator really launched');
  const claim = path.join(c.options.storageRoot, 'target-claim.json');
  await fs.writeFile(claim, 'native ownership remains possibly consumed');
  const healthy = await distribution(t, c, '1.0.1');
  await assert.doesNotReject(
    bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: healthy,
    }),
    'launch mutex is short-lived, not permanent coordinator availability authority',
  );
  assert.doesNotThrow(
    () => process.kill(prior.pid, 0),
    'replacement does not claim the old coordinator or target exited',
  );
  assert.deepEqual(
    (await launches(c)).map((entry) => entry.version),
    ['1.0.0', '1.0.1'],
  );
  assert.equal(
    await fs.readFile(claim, 'utf8'),
    'native ownership remains possibly consumed',
  );
});

test(
  'does not fall through to a lower candidate while the selected child is still live during startup',
  {},
  async (t) => {
    const c = await context(t);
    const own = await distribution(t, c, '1.0.0');
    const stalled = await distribution(t, c, '2.0.0', 'stall');
    await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
      { storageRoot: c.options.storageRoot, distributionPath: stalled },
    );
    const options = {
      ...c.options,
      distributionPath: own,
      timeoutMs: stalledTimeout,
    };
    await assert.rejects(
      bootstrap.ensureOverlayBrokerRunning(options),
      /live|uncertain|timeout/i,
    );
    const [child] = await launches(c);
    assert.ok(child);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.equal((await launches(c)).length, 1);
  },
);

test(
  'serializes simultaneous first starters and rechecks the owner inside the launch lock',
  {},
  async (t) => {
    const c = await context(t);
    const source = await distribution(t, c, '1.0.0', 'healthy', 180);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        bootstrap.ensureOverlayBrokerRunning({
          ...c.options,
          distributionPath: source,
        }),
      ),
    );
    assert.equal((await launches(c)).length, 1);
  },
);

test(
  'starts the highest registered standalone independently of a stopped or uninstalled supplying app',
  {},
  async (t) => {
    const c = await context(t);
    const own = await distribution(t, c, '1.0.0');
    const newer = await distribution(t, c, '2.0.0');
    await require('../dist/lib/overlay-broker-installation.js').registerOverlayBrokerInstallation(
      { storageRoot: c.options.storageRoot, distributionPath: newer },
    );
    await fs.rm(newer, { recursive: true });
    await bootstrap.ensureOverlayBrokerRunning({
      ...c.options,
      distributionPath: own,
    });
    assert.deepEqual(
      (await launches(c)).map((entry) => entry.version),
      ['2.0.0'],
    );
  },
);

test('a healthy existing v1 owner wins without requiring any installation or catalog', async (t) => {
  const c = await context(t);
  await owner(t, c.options.pipePath);
  assert.equal(typeof bootstrap.ensureOverlayBrokerRunning, 'function');
  await bootstrap.ensureOverlayBrokerRunning({
    ...c.options,
    distributionPath: path.join(c.root, 'missing'),
  });
  await assert.rejects(fs.access(c.options.storageRoot));
});
