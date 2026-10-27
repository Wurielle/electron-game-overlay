'use strict';

// Opt-in: node tests/broker-mixed-package.acceptance.cjs <absolute-old-dist>
// Only the native target/injection boundary is fake; SDK graphs and IPC are real.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const newDist = path.resolve(__dirname, '../dist');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['overlay-broker-client.js', 'overlay-broker-server.js'];
const fingerprints = (root) =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      digest(fs.readFileSync(path.join(root, 'lib', file))),
    ]),
  );
const boundaries = {
  real: [
    'independently compiled old/new CommonJS SDK graphs',
    'Node local sockets/named pipes',
    'v1 handshake/framing',
    'target election and authorization',
    'window/frame routing',
    'input ownership',
    'interception OR',
    'member disconnect and target-host lifecycle',
  ],
  controlled: [
    'targetTransportFactory: recording native transport/injection boundary',
  ],
  unverified: [
    'Windows/native game execution',
    'actual DLL injection or injection count',
    'native authenticated loopback transport',
    'Electron installation/RunAsNode fuse',
    'standalone executable packaging',
    'advance-installed discovery',
    'broker process crash/restart',
    '500 applications/versions/hardware capacity',
  ],
};

if (!process.env.EGO_MIXED_ACCEPTANCE_WORKER) {
  const oldDist = process.argv[2];
  assert.ok(
    oldDist && path.isAbsolute(oldDist),
    'Pass an absolute independently built old SDK dist directory',
  );
  assert.notEqual(fs.realpathSync(oldDist), fs.realpathSync(newDist));
  const evidencePath =
    process.env.EGO_MIXED_ACCEPTANCE_EVIDENCE ||
    path.join(os.tmpdir(), `ego-mixed-package-${randomUUID()}.json`);
  const before = { old: fingerprints(oldDist), new: fingerprints(newDist) };
  const invocation = [process.execPath, __filename, oldDist];
  const run = (mutation) => {
    const args = [
      '--test',
      '--test-reporter=tap',
      ...(mutation ? ['--test-name-pattern=^new server; old then new$'] : []),
      __filename,
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        EGO_MIXED_ACCEPTANCE_WORKER: '1',
        EGO_MIXED_ACCEPTANCE_OLD_DIST: oldDist,
        EGO_MIXED_ACCEPTANCE_MUTATION: mutation ? 'interception-disabled' : '',
      },
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const counts = Object.fromEntries(
      ['tests', 'pass', 'fail', 'skipped'].map((key) => [
        key,
        Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? 0),
      ]),
    );
    const moduleGraphHashes = JSON.parse(
      output.match(/PACKAGE_GRAPHS (.*)/)?.[1] || 'null',
    );
    return {
      command: [process.execPath, ...args],
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
      counts,
      moduleGraphHashes,
      output,
    };
  };
  const baseline = run(false);
  process.stdout.write(baseline.output);
  // Characterization must detect a product regression, not an import/setup error.
  const mutation = run(true);
  const mutationDetected =
    mutation.exitCode === 1 &&
    /MUTATION_APPLIED interception-disabled/.test(mutation.output) &&
    /interception OR: live true request must reach target/.test(
      mutation.output,
    ) &&
    /ERR_ASSERTION/.test(mutation.output);
  const verification = run(false);
  const after = { old: fingerprints(oldDist), new: fingerprints(newDist) };
  const unchanged =
    JSON.stringify(before) === JSON.stringify(after) &&
    baseline.moduleGraphHashes !== null &&
    JSON.stringify(baseline.moduleGraphHashes) ===
      JSON.stringify(verification.moduleGraphHashes);
  const complete = [baseline, verification].every(
    (run) =>
      run.exitCode === 0 &&
      run.counts.tests === 5 &&
      run.counts.pass === 5 &&
      run.counts.fail === 0 &&
      run.counts.skipped === 0,
  );
  const evidence = {
    command: invocation,
    platform: process.platform,
    node: process.version,
    oldDist,
    newDist,
    hashesBefore: before,
    hashesAfter: after,
    filesUnchanged: unchanged,
    coverageBoundaries: boundaries,
    baseline,
    mutation: {
      ...mutation,
      detected: mutationDetected,
      scope:
        'one compiled new-server module transformed in memory; no disk writes',
    },
    verification,
    success: complete && mutationDetected && unchanged,
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `# mutation sensitivity: ${mutationDetected ? 'verified' : 'NOT verified'}`,
  );
  console.log(
    `# clean rerun: ${verification.counts.pass}/${verification.counts.tests}; source hashes unchanged: ${unchanged}`,
  );
  console.log(`# evidence: ${evidencePath}`);
  process.exitCode = evidence.success ? 0 : 1;
} else {
  const oldDist = process.env.EGO_MIXED_ACCEPTANCE_OLD_DIST;
  const mutate =
    process.env.EGO_MIXED_ACCEPTANCE_MUTATION === 'interception-disabled';

  // Each SDK has a private module cache, including all relative product dependencies.
  // No global require patch and no alternate routing/protocol implementation.
  const loadGraph = (root, mutation = false) => {
    root = fs.realpathSync(root);
    const cache = new Map();
    const hashes = new Map();
    const load = (filename) => {
      if (cache.has(filename)) return cache.get(filename).exports;
      assert.ok(
        filename.startsWith(`${root}${path.sep}`),
        'Product module must remain in its SDK graph',
      );
      assert.equal(
        path.extname(filename),
        '.js',
        'Native addon loading is forbidden',
      );
      let source = fs.readFileSync(filename, 'utf8');
      hashes.set(path.relative(root, filename), digest(source));
      if (
        mutation &&
        filename === path.join(root, 'lib/overlay-broker-server.js')
      ) {
        const needle = 'this.transport.setInputIntercept(intercept)';
        assert.equal(
          source.split(needle).length,
          2,
          'Mutation must alter exactly one product call',
        );
        source = source.replace(
          needle,
          'this.transport.setInputIntercept(false)',
        );
        console.log('# MUTATION_APPLIED interception-disabled');
      }
      const loaded = new Module(filename, module);
      loaded.filename = filename;
      loaded.paths = Module._nodeModulePaths(path.dirname(filename));
      cache.set(filename, loaded);
      loaded.require = (id) => {
        assert.ok(
          id !== 'electron' && !id.endsWith('.node'),
          'Electron/native execution is forbidden',
        );
        const resolved = Module._resolveFilename(id, loaded);
        return resolved.startsWith(`${root}${path.sep}`)
          ? load(resolved)
          : require(resolved);
      };
      loaded._compile(source, filename);
      loaded.loaded = true;
      return loaded.exports;
    };
    return {
      root,
      hashes,
      client: load(path.join(root, 'lib/overlay-broker-client.js'))
        .OverlayBrokerClient,
      server: load(path.join(root, 'lib/overlay-broker-server.js'))
        .OverlayBrokerServer,
    };
  };
  const old = loadGraph(oldDist);
  const current = loadGraph(newDist, mutate);
  test('old and new packages contain distinct actual compiled client/server code and module graphs', () => {
    assert.notEqual(old.root, current.root);
    assert.notEqual(old.client, current.client);
    assert.notEqual(old.server, current.server);
    for (const filename of sourceFiles) {
      assert.notEqual(
        old.hashes.get(`lib${path.sep}${filename}`),
        current.hashes.get(`lib${path.sep}${filename}`),
        `${filename}: rebuild new SDK; version labels are not compatibility evidence`,
      );
      const withoutLabel = (root) =>
        digest(
          fs
            .readFileSync(path.join(root, 'lib', filename), 'utf8')
            .replace(/const SDK_VERSION\s*=\s*[^;]+;/g, '')
            .replace(/^\/\/# sourceMappingURL=.*$/gm, ''),
        );
      assert.notEqual(
        withoutLabel(old.root),
        withoutLabel(current.root),
        `${filename}: actual implementation must differ beyond SDK version labels/source maps`,
      );
    }
    for (const name of [
      'overlay-broker-protocol.js',
      'overlay-loopback-transport.js',
    ]) {
      for (const graph of [old, current])
        assert.ok(graph.hashes.has(`lib${path.sep}${name}`));
    }
    console.log(
      `# PACKAGE_GRAPHS ${JSON.stringify({ old: Object.fromEntries(old.hashes), new: Object.fromEntries(current.hashes) })}`,
    );
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 3_000;
    while (!predicate() && Date.now() < deadline) await delay(5);
    assert.ok(predicate(), label);
  };
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Timed out awaiting actual SDK authorization')),
            3_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const window = (name) => ({
    name,
    transparent: true,
    rect: { x: 10, y: 20, width: 2, height: 1 },
    caption: { left: 0, right: 0, top: 0, height: 0 },
    scaleFactorMicros: 1_000_000,
  });

  class ControlledNativeBoundary {
    constructor(pid) {
      this.pid = pid;
      this.windows = new Map();
      this.frames = new Map();
      this.authorizations = [];
      this.intercepts = [];
      this.stopped = false;
      this.started = false;
    }
    start() {
      this.started = true;
    }
    whenReady() {
      return Promise.resolve();
    }
    stop() {
      this.stopped = true;
    }
    setEventCallback(callback) {
      this.callback = callback;
    }
    setDiagnosticCallback(callback) {
      this.diagnosticCallback = callback;
    }
    async authorizeTarget(
      pid,
      discoveryPath,
      expectedExecutablePath,
      routeContext,
    ) {
      const entry = {
        pid,
        discoveryPath,
        expectedExecutablePath,
        routeContext,
        released: false,
      };
      this.authorizations.push(entry);
      return () => {
        entry.released = true;
      };
    }
    setInputIntercept(value) {
      this.intercepts.push(value);
    }
    addWindow(id, details) {
      this.windows.set(id, structuredClone(details));
    }
    closeWindow(id) {
      this.windows.delete(id);
      this.frames.delete(id);
    }
    sendWindowBounds(id, details) {
      Object.assign(this.windows.get(id), structuredClone(details));
    }
    sendFrameBuffer(id, pixels, width, height) {
      this.frames.set(id, { pixels: Buffer.from(pixels), width, height });
      return true;
    }
    raiseWindowForSnapshot() {}
    emit(event, payload) {
      this.callback(event, structuredClone(payload));
    }
  }

  for (const [serverName, graph] of [
    ['new', current],
    ['old', old],
  ]) {
    for (const order of [
      ['old', 'new'],
      ['new', 'old'],
    ]) {
      test(
        `${serverName} server; ${order.join(' then ')}`,
        { timeout: 15_000 },
        async () => {
          const temp = fs.mkdtempSync(
            path.join(process.env.TMPDIR || os.tmpdir(), 'ego-mix-'),
          );
          const pipePath =
            process.platform === 'win32'
              ? `\\\\.\\pipe\\ego-mix-${randomUUID()}`
              : path.join(temp, 'broker.sock');
          const exe = path.resolve(temp, 'fixture-game.exe');
          // The current live process provides authoritative liveness without faking it.
          const pid = process.pid;
          const transports = [];
          const clients = [];
          const server = new graph.server({
            pipePath,
            idleShutdownMs: false,
            runtimeProviderElectionWindowMs: 0,
            targetTransportFactory(targetPid) {
              const transport = new ControlledNativeBoundary(targetPid);
              transports.push(transport);
              return transport;
            },
          });
          const connect = async (name, generation) => {
            const sdk = name === 'old' ? old : current;
            const client = new sdk.client({
              pipePath,
              connectTimeoutMs: 3_000,
              runtimeGeneration: generation,
              targetTransportMin: 1,
              targetTransportMax: 1,
              spawnBroker() {
                assert.fail(
                  'Explicit running fixture broker must not spawn another process',
                );
              },
            });
            const events = [];
            client.setEventCallback((event, payload) =>
              events.push({ event, payload }),
            );
            clients.push(client);
            client.start();
            await bounded(client.whenReady());
            return { client, events, name };
          };
          const authorize = ({ client }, tag) =>
            client.authorizeTarget(
              pid,
              path.resolve(temp, tag, 'transport.json'),
              exe,
            );
          const frame = (app, byte) =>
            app.client.sendFrameBuffer(7, Buffer.alloc(8, byte), 2, 1);
          const input = (id, x) =>
            transports[0].emit('game.input', {
              pid,
              windowId: id,
              kind: 'mouseMove',
              x,
              y: 1,
            });
          let barrierSequence = 100;
          const barrier = async (apps) => {
            const fps = ++barrierSequence;
            transports[0].emit('game.graphics.fps', { pid, fps });
            await waitFor(
              () =>
                apps.every((app) =>
                  app.events.some(
                    (entry) =>
                      entry.event === 'game.graphics.fps' &&
                      entry.payload.fps === fps,
                  ),
                ),
              'Real socket event barrier',
            );
          };
          try {
            await server.start();
            const first = await connect(order[0], 1);
            first.client.addWindow(7, window('first-app'));
            frame(first, 11);
            const owner = await bounded(authorize(first, 'first'));
            assert.equal(owner.disposition, 'injection-owner');
            const second = await connect(order[1], 99);
            second.client.addWindow(7, window('second-app'));
            frame(second, 22);
            let joined = false;
            const pending = authorize(second, 'second').then((value) => {
              joined = true;
              return value;
            });
            void pending.catch(() => {});
            await delay(30);
            assert.equal(
              joined,
              false,
              'Later higher generation waits for authentication, never injects',
            );
            assert.equal(transports.length, 1, 'One target transport');
            const transport = transports[0];
            assert.ok(
              transport instanceof ControlledNativeBoundary &&
                transport.started,
            );
            assert.equal(
              transport.authorizations.length,
              1,
              'Exactly one native-boundary route authorization',
            );
            transport.emit('game.process', { pid, path: exe });
            const member = await bounded(pending);
            assert.equal(member.disposition, 'joined-existing');
            assert.equal(
              member.target.discoveryPath,
              transport.authorizations[0].discoveryPath,
            );
            await waitFor(
              () => transport.windows.size === 2 && transport.frames.size === 2,
              'Both scenes materialized',
            );
            const idFor = (name) =>
              [...transport.windows].find(
                ([, details]) => details.name === name,
              )?.[0];
            const firstId = idFor('first-app');
            const secondId = idFor('second-app');
            assert.ok(Number.isInteger(firstId) && Number.isInteger(secondId));
            assert.notEqual(
              firstId,
              secondId,
              'Same app-local ID maps to distinct target IDs',
            );
            assert.deepEqual(
              transport.frames.get(firstId).pixels,
              Buffer.alloc(8, 11),
            );
            assert.deepEqual(
              transport.frames.get(secondId).pixels,
              Buffer.alloc(8, 22),
            );
            input(secondId, 1);
            await barrier([first, second]);
            assert.equal(
              first.events.filter((entry) => entry.event === 'game.input')
                .length,
              0,
              'No foreign input',
            );
            assert.equal(
              second.events.filter((entry) => entry.event === 'game.input')
                .length,
              1,
            );
            assert.equal(
              second.events.find((entry) => entry.event === 'game.input')
                .payload.windowId,
              7,
            );
            input(firstId, 2);
            await barrier([first, second]);
            assert.equal(
              first.events.filter((entry) => entry.event === 'game.input')
                .length,
              1,
            );
            assert.equal(
              first.events.find((entry) => entry.event === 'game.input').payload
                .windowId,
              7,
            );
            assert.equal(
              second.events.filter((entry) => entry.event === 'game.input')
                .length,
              1,
              'No reverse foreign input',
            );

            const intercept = async (app, value, expected) => {
              const count = transport.intercepts.length;
              app.client.setInputIntercept(value);
              await waitFor(
                () => transport.intercepts.length > count,
                'Interception request processed over socket',
              );
              assert.equal(
                transport.intercepts.at(-1),
                expected,
                'interception OR: live true request must reach target',
              );
            };
            await intercept(first, true, true);
            await intercept(second, false, true);
            await intercept(first, false, false);
            await intercept(second, true, true);
            await intercept(first, true, true);

            const late = await connect('new', 100);
            const lateAuthorization = await bounded(
              authorize(late, 'late-newer'),
            );
            assert.equal(
              lateAuthorization.disposition,
              'joined-existing',
              'Late newer actual new client cannot obtain another injection grant',
            );
            assert.equal(
              lateAuthorization.target.discoveryPath,
              transport.authorizations[0].discoveryPath,
            );
            assert.equal(transport.authorizations.length, 1);
            late.client.stop();
            first.client.stop();
            await waitFor(
              () =>
                transport.windows.size === 1 && !transport.windows.has(firstId),
              'Exiting owner removes only its scene',
            );
            assert.equal(
              transport.intercepts.at(-1),
              true,
              'Remaining true request survives owner exit',
            );
            assert.equal(
              transport.authorizations[0].released,
              false,
              'Member exit must not release target route',
            );
            assert.equal(transport.stopped, false);
            frame(second, 33);
            await waitFor(
              () =>
                transport.frames
                  .get(secondId)
                  ?.pixels.equals(Buffer.alloc(8, 33)),
              'Survivor still renders',
            );
            const inputsBefore = second.events.filter(
              (entry) => entry.event === 'game.input',
            ).length;
            input(secondId, 3);
            await barrier([second]);
            assert.equal(
              second.events.filter((entry) => entry.event === 'game.input')
                .length,
              inputsBefore + 1,
              'Survivor still receives input',
            );
            await intercept(second, false, false);
            await intercept(second, true, true);
            second.client.stop();
            await waitFor(
              () =>
                transport.windows.size === 0 &&
                transport.intercepts.at(-1) === false,
              'Last member cleanup',
            );
            assert.equal(
              transport.authorizations[0].released,
              false,
              'Zero-member interval retains route',
            );
            assert.equal(transport.stopped, false);
            assert.equal(transports.length, 1);
            assert.equal(
              transport.authorizations.length,
              1,
              'No second native-boundary authorization',
            );
            transport.emit('game.process.disconnected', { pid, path: exe });
            await waitFor(
              () => transport.stopped && transport.authorizations[0].released,
              'Only authoritative target exit releases route',
            );
          } finally {
            clients.forEach((client) => client.stop());
            await server.stop();
            fs.rmSync(temp, { recursive: true, force: true });
          }
        },
      );
    }
  }
}
