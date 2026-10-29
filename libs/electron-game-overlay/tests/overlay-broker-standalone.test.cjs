const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { connect } = require('node:net');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sdkRoot = path.resolve(__dirname, '..');
const builder = path.join(sdkRoot, 'scripts/build-standalone-broker.cjs');
const compiledLib =
  process.env.EGO_BROKER_TEST_LIB_DIR || path.join(sdkRoot, 'dist/lib');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const executable = `electron-game-overlay-broker${process.platform === 'win32' ? '.exe' : ''}`;
const serviceProbeBoundary =
  process.platform === 'win32' ? ' (controlled Windows token probe)' : '';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-sea-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'staged-runtime');
  const reshade = path.join(runtime, 'win32-x64/reshade');
  fs.mkdirSync(reshade, { recursive: true });
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const assets = {
      [`electron_game_overlay.addon${bits}`]: `synthetic-addon-${bits}`,
      [`electron_game_overlay_reshade_manager${suffix}.exe`]: `synthetic-manager-${bits}`,
      [`inject${suffix}.exe`]: `synthetic-injector-${bits}`,
      [`ReShade${bits}.dll`]: `synthetic-reshade-${bits}`,
      'ReShade.ini': 'synthetic-config',
    };
    const stamp = JSON.stringify({
      runtimeSha256: hash(assets[`ReShade${bits}.dll`]),
      injectorSha256: hash(assets[`inject${suffix}.exe`]),
    });
    assets[`ReShade${bits}.build.json`] = stamp;
    assets[`electron_game_overlay_runtime${suffix}.build.json`] =
      JSON.stringify({
        schemaVersion: 3,
        kind: 'electron-game-overlay-runtime-build',
        platform: bits === 64 ? 'win32-x64' : 'win32-ia32',
        configuration: 'RelWithDebInfo',
        addonBuildId: '31D321732C1B424796593C0778FB722E',
        managerProtocolSchemaVersion: 1,
        managerSourceSha256: 'A'.repeat(64),
        runtimeGeneration: 1,
        targetTransportMin: 1,
        targetTransportMax: 1,
        addonSha256: hash(
          assets[`electron_game_overlay.addon${bits}`],
        ).toUpperCase(),
        managerSha256: hash(
          assets[`electron_game_overlay_reshade_manager${suffix}.exe`],
        ).toUpperCase(),
        injectorSha256: hash(assets[`inject${suffix}.exe`]).toUpperCase(),
        reshadeRuntimeSha256: hash(assets[`ReShade${bits}.dll`]).toUpperCase(),
        reshadeConfigSha256: hash(assets['ReShade.ini']).toUpperCase(),
        reshadeBuildStampSha256: hash(stamp).toUpperCase(),
      });
    for (const [name, contents] of Object.entries(assets))
      fs.writeFileSync(path.join(reshade, name), contents);
  }
  return { root, runtime, reshade, output: path.join(root, 'distribution') };
}

function powershellRuntimeManifests(f, architectures = [64, 32]) {
  for (const bits of architectures) {
    const suffix = bits === 64 ? '' : '32';
    const file = path.join(
      f.reshade,
      `electron_game_overlay_runtime${suffix}.build.json`,
    );
    // Windows PowerShell 5 ConvertTo-Json | Set-Content -Encoding UTF8:
    // one EF BB BF prefix, CRLF formatting, and a final CRLF.
    const json = JSON.stringify(
      JSON.parse(fs.readFileSync(file, 'utf8')),
      null,
      4,
    );
    fs.writeFileSync(file, `\uFEFF${json.replace(/\n/g, '\r\n')}\r\n`);
  }
}

for (const architectures of [[64, 32], [32]]) {
  test(
    `packages PowerShell UTF8 BOM runtime manifests (${architectures.join('/')}-bit) without changing bytes`,
    { timeout: 120_000 },
    (t) => {
      const f = fixture(t);
      powershellRuntimeManifests(f, architectures);
      const result = build(f);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(f.output, 'broker-manifest.json'), 'utf8'),
      );
      assert.ok(
        fs.statSync(path.join(f.output, executable)).size > 1_000_000,
        'builds a genuine SEA',
      );
      for (const name of fs.readdirSync(f.reshade)) {
        const relative = `runtime/win32-x64/reshade/${name}`;
        const original = fs.readFileSync(path.join(f.reshade, name));
        const packaged = fs.readFileSync(path.join(f.output, relative));
        assert.deepEqual(packaged, original, name);
        const entry = manifest.files.find((entry) => entry.path === relative);
        assert.equal(entry.size, original.length, name);
        assert.equal(entry.sha256, hash(original), name);
      }
    },
  );
}

test('rejects repeated BOMs and malformed PowerShell runtime JSON', (t) => {
  const f = fixture(t);
  powershellRuntimeManifests(f);
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const file = path.join(
      f.reshade,
      `electron_game_overlay_runtime${suffix}.build.json`,
    );
    const original = fs.readFileSync(file);
    for (const invalid of [
      Buffer.concat([Buffer.from('\uFEFF'), original]),
      Buffer.from('\uFEFF{"addonSha256":'),
    ]) {
      fs.writeFileSync(file, invalid);
      const result = build(f);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`Runtime build manifest invalid for ${bits}-bit payload`),
      );
      assert.ok(!fs.existsSync(f.output));
    }
    fs.writeFileSync(file, original);
  }
});

function controlServicePrivilegeProbe(libDir) {
  if (process.platform !== 'win32') return;
  // Control only the exact OS probe in this disposable SEA service fixture.
  // This is not positive acceptance of the real Windows host token.
  fs.copyFileSync(
    require.resolve('./helpers/standalone-broker-fixture.cjs'),
    path.join(libDir, 'privilege-probe-fixture.js'),
  );
  const entry = path.join(libDir, 'overlay-broker-entry.js');
  fs.writeFileSync(
    entry,
    "require('./privilege-probe-fixture.js').controlPrivilegeProbe();\n" +
      fs.readFileSync(entry, 'utf8'),
  );
}

function build(f) {
  return spawnSync(
    process.execPath,
    [
      builder,
      '--output',
      f.output,
      '--runtime',
      f.runtime,
      '--lib',
      f.libDir ?? compiledLib,
    ],
    { cwd: sdkRoot, encoding: 'utf8' },
  );
}

const baselineCapabilities = [
  'global-window-order-v1',
  'input-arbitration-v1',
  'scene-multiplex-v1',
  'target-lease-election-v1',
  'target-telemetry-v1',
  'target-transport-v1',
];

async function rawV1Hello(pipePath) {
  const socket = connect(pipePath);
  socket.on('error', () => undefined);
  try {
    await once(socket, 'connect');
    const body = Buffer.from(
      JSON.stringify({
        type: 'broker.hello',
        protocolMin: 1,
        protocolMax: 1,
        requiredCapabilities: baselineCapabilities,
        clientPid: process.pid,
        sdkVersion: '0.0.1-frozen-v1',
      }),
    );
    const packet = Buffer.alloc(5 + body.length);
    packet.writeUInt32LE(body.length, 0);
    packet[4] = 1;
    body.copy(packet, 5);
    const received = new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.length >= 5 && data.length >= 5 + data.readUInt32LE(0)) {
          try {
            assert.equal(data[4], 1);
            resolve(
              JSON.parse(
                data.subarray(5, 5 + data.readUInt32LE(0)).toString('utf8'),
              ),
            );
          } catch (error) {
            reject(error);
          }
        }
      });
      socket.once('error', reject);
      socket.once('end', () =>
        reject(new Error('Broker closed before welcome')),
      );
    });
    socket.write(packet);
    return await received;
  } finally {
    socket.destroy();
  }
}

function launch(t, output, pipePath, cwd) {
  const child = spawn(path.join(output, executable), [], {
    cwd,
    env: {
      ...process.env,
      PATH: '',
      NODE_PATH: '',
      NODE_OPTIONS: '',
      ELECTRON_RUN_AS_NODE: '0',
      TMPDIR: cwd,
      TEMP: cwd,
      TMP: cwd,
      ELECTRON_GAME_OVERLAY_BROKER_PIPE: pipePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const exited = once(child, 'exit');
  // Observe a startup failure even before a later awaited assertion.
  exited.catch(() => undefined);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  return {
    child,
    exited,
    get stderr() {
      return stderr;
    },
  };
}

async function waitForWelcome(processes, pipePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await rawV1Hello(pipePath);
    } catch (error) {
      if (
        processes.every(
          ({ child }) => child.exitCode !== null || child.signalCode !== null,
        )
      ) {
        assert.fail(
          `Broker exited before handshake: ${processes.map((p) => p.stderr).join('\n')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(
    `Timed out waiting for broker: ${processes.map((p) => p.stderr).join('\n')}`,
  );
}

function isolatedPipe(f) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ego-sea-${require('node:crypto').randomUUID()}`
    : path.join(f.root, 'broker.sock');
}

test(
  'packaged native artifacts are eligible before the standalone listener opens',
  { timeout: 120_000 },
  async (t) => {
    const f = fixture(t);
    const result = build(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const { prepareStandaloneOverlayNativeProvider } = require(
      path.join(compiledLib, 'overlay-broker-native-provider.js'),
    );
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const diagnostics = [];
    let provider;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      provider = await prepareStandaloneOverlayNativeProvider({
        executablePath: path.join(f.output, executable),
        runsRootDirectory: path.join(f.root, 'runs'),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      assert.ok(provider, JSON.stringify(diagnostics));
    } finally {
      Object.defineProperty(process, 'platform', original);
      provider?.dispose();
    }
  },
);

test(
  `relocated SEA authenticates frozen v1 without Node or Electron on PATH and shuts down cleanly${serviceProbeBoundary}`,
  { timeout: 120_000 },
  async (t) => {
    const f = fixture(t);
    const sourceLib = path.join(f.root, 'source-lib');
    fs.cpSync(compiledLib, sourceLib, { recursive: true });
    controlServicePrivilegeProbe(sourceLib);
    const result = spawnSync(
      process.execPath,
      [
        builder,
        '--output',
        f.output,
        '--runtime',
        f.runtime,
        '--lib',
        sourceLib,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const relocated = path.join(f.root, 'cache-copy');
    fs.cpSync(f.output, relocated, { recursive: true });
    for (const original of [f.output, f.runtime, sourceLib])
      fs.rmSync(original, { recursive: true });
    assert.ok(!fs.existsSync(path.join(relocated, 'node_modules/electron')));
    // A cache copy must not inherit a supplying application's module format.
    fs.writeFileSync(
      path.join(f.root, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    const pipePath = isolatedPipe(f);
    const broker = launch(t, relocated, pipePath, f.root);
    const welcome = await waitForWelcome([broker], pipePath);
    assert.equal(welcome.type, 'broker.welcome');
    assert.equal(welcome.protocolVersion, 1);
    assert.equal(welcome.brokerPid, broker.child.pid);
    assert.equal(typeof welcome.sessionId, 'string');
    for (const capability of baselineCapabilities)
      assert.ok(welcome.capabilities.includes(capability));
    broker.child.kill('SIGTERM');
    const [code, signal] = await broker.exited;
    if (process.platform !== 'win32') {
      assert.equal(code, 0, broker.stderr);
      assert.equal(signal, null);
      assert.ok(
        !fs.existsSync(pipePath),
        'controlled shutdown releases the local socket',
      );
    }
    assert.equal(broker.stderr, '');
  },
);

function listFiles(root, prefix = '') {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${prefix}${entry.name}`;
      return entry.isDirectory()
        ? listFiles(path.join(root, entry.name), `${relative}/`)
        : [relative];
    })
    .sort();
}

test(
  `simultaneous standalone starters retain one v1 singleton and the loser exits quietly${serviceProbeBoundary}`,
  { timeout: 120_000 },
  async (t) => {
    const f = fixture(t);
    const sourceLib = path.join(f.root, 'service-lib');
    fs.cpSync(compiledLib, sourceLib, { recursive: true });
    controlServicePrivilegeProbe(sourceLib);
    const result = build({ ...f, libDir: sourceLib });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const pipePath = isolatedPipe(f);
    const starters = [
      launch(t, f.output, pipePath, f.root),
      launch(t, f.output, pipePath, f.root),
    ];
    const welcome = await waitForWelcome(starters, pipePath);
    const winner = starters.find(
      (broker) => broker.child.pid === welcome.brokerPid,
    );
    assert.ok(winner);
    const loser = starters.find((broker) => broker !== winner);
    const [code, signal] = await loser.exited;
    assert.equal(code, 0, loser.stderr);
    assert.equal(signal, null);
    assert.equal(loser.stderr, '');
    const again = await rawV1Hello(pipePath);
    assert.equal(
      again.brokerPid,
      winner.child.pid,
      'winner remains authoritative after race',
    );
    winner.child.kill('SIGTERM');
    await winner.exited;
  },
);

test('normal SDK build packages the standalone broker only after both runtime stages', () => {
  const project = require('../project.json');
  const commands = project.targets.build.options.commands;
  const standalone = commands.indexOf(
    'node scripts/build-standalone-broker.cjs',
  );
  assert.ok(
    standalone >= 0,
    'normal builds must produce the standalone distribution',
  );
  const stages = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) =>
      command.includes('stage-game-overlay-runtime.ps1'),
    );
  assert.equal(stages.length, 2);
  assert.ok(stages.every(({ index }) => index < standalone));
  assert.equal(project.targets.build.options.parallel, false);
});

test(
  'refuses output paths that overlap the staged source assets',
  { timeout: 120_000 },
  (t) => {
    const f = fixture(t);
    for (const output of [
      f.runtime,
      f.root,
      path.join(f.runtime, 'nested-output'),
    ]) {
      const result = build({ ...f, output });
      assert.notEqual(
        result.status,
        0,
        'packaging must never delete or contaminate its own source',
      );
      assert.match(result.stderr, /overlap/i);
      assert.ok(fs.existsSync(path.join(f.reshade, 'ReShade64.dll')));
    }
  },
);

test(
  'refuses an incomplete staged runtime before publishing a distribution',
  { timeout: 120_000 },
  (t) => {
    const f = fixture(t);
    const assets = fs.readdirSync(f.reshade);
    for (const name of assets) {
      const file = path.join(f.reshade, name);
      const bytes = fs.readFileSync(file);
      fs.unlinkSync(file);
      const result = build(f);
      assert.notEqual(
        result.status,
        0,
        `missing ${name} must not produce a broker`,
      );
      assert.match(result.stderr, /runtime.*missing|required.*runtime/i);
      assert.ok(!fs.existsSync(f.output));
      fs.writeFileSync(file, bytes);
    }
  },
);

test(
  'refuses corrupt staged native payloads instead of sealing their corruption',
  { timeout: 120_000 },
  (t) => {
    const f = fixture(t);
    powershellRuntimeManifests(f);
    for (const name of fs.readdirSync(f.reshade)) {
      const file = path.join(f.reshade, name);
      const bytes = fs.readFileSync(file);
      fs.appendFileSync(file, 'corrupt');
      const result = build(f);
      assert.notEqual(
        result.status,
        0,
        `corrupt ${name} must not produce a broker`,
      );
      assert.match(result.stderr, /runtime.*(invalid|integrity)|SHA-256/i);
      assert.ok(!fs.existsSync(f.output));
      fs.writeFileSync(file, bytes);
    }
  },
);

test(
  'identical inputs produce identical ordered manifests across build directories',
  { timeout: 120_000 },
  (t) => {
    const f = fixture(t);
    const first = build(f);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const initial = fs.readFileSync(
      path.join(f.output, 'broker-manifest.json'),
      'utf8',
    );
    const secondOutput = path.join(f.root, 'second-distribution');
    const second = build({ ...f, output: secondOutput });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(
      fs.readFileSync(path.join(secondOutput, 'broker-manifest.json'), 'utf8'),
      initial,
    );
  },
);

test(
  'builds a real SEA with a complete deterministic asset manifest',
  { timeout: 120_000 },
  (t) => {
    const f = fixture(t);
    const result = build(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(f.output, 'broker-manifest.json'), 'utf8'),
    );
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.version, require('../package.json').version);
    assert.equal(manifest.protocolMin, 1);
    assert.equal(manifest.protocolMax, 1);
    assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.arch, process.arch);
    assert.equal(manifest.executable, executable);
    const files = listFiles(f.output).filter(
      (name) => name !== 'broker-manifest.json',
    );
    assert.deepEqual(
      manifest.files.map((entry) => entry.path),
      files,
    );
    assert.ok(files.includes(executable));
    assert.ok(
      files.includes('licenses/node.txt'),
      'ship the embedded Node runtime license',
    );
    assert.ok(
      files.includes('licenses/electron-game-overlay.txt'),
      'ship the broker license',
    );
    assert.equal(
      fs.readFileSync(
        path.join(f.output, 'licenses/electron-game-overlay.txt'),
        'utf8',
      ),
      fs.readFileSync(path.resolve(sdkRoot, '../../LICENSE'), 'utf8'),
    );
    assert.ok(
      fs.statSync(path.join(f.output, executable)).size > 1_000_000,
      'SEA embeds a real Node runtime',
    );
    assert.ok(files.includes('lib/overlay-broker-entry.js'));
    assert.ok(files.includes('node_modules/tslib/tslib.js'));
    assert.ok(files.includes('runtime/win32-x64/reshade/ReShade32.dll'));
    assert.ok(files.includes('runtime/win32-x64/reshade/ReShade64.dll'));
    assert.ok(
      files.every((name) => !name.endsWith('.map') && !name.endsWith('.ts')),
    );
    for (const entry of manifest.files) {
      assert.match(entry.path, /^[a-zA-Z0-9._/-]+$/);
      assert.ok(!entry.path.split('/').includes('..'));
      const bytes = fs.readFileSync(path.join(f.output, entry.path));
      assert.equal(entry.size, bytes.length, entry.path);
      assert.equal(entry.sha256, hash(bytes), entry.path);
    }
  },
);
