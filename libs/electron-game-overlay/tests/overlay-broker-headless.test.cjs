const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function runHeadlessMain(args, fixture) {
  return spawnSync(
    process.execPath,
    [
      '-e',
      `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(id, ...rest) {
      if (id.toLowerCase() === 'electron' || /overlay-broker-(bootstrap|native-provider|server)\\.js$/.test(id)) {
        throw new Error('Service/native load is forbidden during setup: ' + id);
      }
      return original.call(this, id, ...rest);
    };
    const fixture = ${JSON.stringify(fixture ?? null)};
    if (fixture) {
      // Explicit OS-token-home boundary; HOME/TMPDIR do not choose the catalog.
      const os = require('node:os');
      const user = os.userInfo();
      os.userInfo = () => ({ ...user, homedir: fixture.root });
      Object.defineProperty(process, 'execPath', { value: require('node:path').join(fixture.source, fixture.executable) });
    }
    process.argv = [process.execPath, 'fixture-broker', ...${JSON.stringify(args)}];
    void require(${JSON.stringify(path.join(process.env.EGO_BROKER_TEST_LIB_DIR || path.resolve(__dirname, '../dist/lib'), 'overlay-broker-entry.js'))}).runOverlayBrokerMain();
  `,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
}

const sdkRoot = path.resolve(__dirname, '..');
const compiledLib =
  process.env.EGO_BROKER_TEST_LIB_DIR || path.join(sdkRoot, 'dist/lib');

function setupFixture(t, version = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-headless-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'distribution');
  const storageRoot = path.join(root, 'user-state');
  fs.mkdirSync(source);
  const executable = `electron-game-overlay-broker${process.platform === 'win32' ? '.exe' : ''}`;
  // Deliberately non-executable fixture bytes: setup copies but must never run them.
  const payload = Buffer.from('not a real executable: setup-only fixture');
  fs.writeFileSync(path.join(source, executable), payload, { mode: 0o700 });
  fs.writeFileSync(
    path.join(source, 'broker-manifest.json'),
    JSON.stringify({
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
          size: payload.length,
          sha256: require('node:crypto')
            .createHash('sha256')
            .update(payload)
            .digest('hex'),
        },
      ],
    }),
  );
  return {
    root,
    source,
    storageRoot,
    executable,
    payload,
    options: { distributionPath: source, storageRoot },
  };
}

async function invokeSetup(args, options) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    const { runOverlayBrokerSetup } = require(
      path.join(compiledLib, 'overlay-broker-setup.js'),
    );
    return { handled: await runOverlayBrokerSetup(args, options), lines };
  } finally {
    console.log = original;
  }
}

function packageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-headless-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'node_modules/electron-game-overlay');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(
    path.join(sdkRoot, 'package.json'),
    path.join(target, 'package.json'),
  );
  fs.cpSync(path.dirname(compiledLib), path.join(target, 'dist'), {
    recursive: true,
  });
  fs.cpSync(
    path.dirname(require.resolve('tslib/package.json')),
    path.join(root, 'node_modules/tslib'),
    { recursive: true },
  );
  return { root, target };
}

test('actual package broker subpath resolves and loads without Electron or the root SDK', (t) => {
  const f = packageFixture(t);
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (id.toLowerCase() === 'electron') throw new Error('Electron is forbidden');
      return original.call(this, id, ...args);
    };
    const resolved = require.resolve('electron-game-overlay/broker');
    assert.equal(resolved, ${JSON.stringify(path.join(f.target, 'dist/broker.js'))});
    const api = require('electron-game-overlay/broker');
    assert.deepEqual(Object.keys(api).sort(), ['registerOverlayBrokerInstallation', 'unregisterOverlayBrokerInstallation']);
    assert.equal(typeof api.registerOverlayBrokerInstallation, 'function');
    assert.equal(typeof api.unregisterOverlayBrokerInstallation, 'function');
    assert.ok(!require.cache[${JSON.stringify(path.join(f.target, 'dist/index.js'))}]);
  `,
    ],
    { cwd: f.root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('broker subpath supports ESM imports and the emitted public TypeScript contract', (t) => {
  const f = packageFixture(t);
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import Module from 'node:module';
    const original = Module._load;
    Module._load = function(id, ...rest) {
      if (id.toLowerCase() === 'electron') throw new Error('Electron is forbidden');
      return original.call(this, id, ...rest);
    };
    const api = await import('electron-game-overlay/broker');
    if (typeof api.registerOverlayBrokerInstallation !== 'function') throw new Error('Missing registration export');
  `,
    ],
    { cwd: f.root, encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  fs.writeFileSync(
    path.join(f.root, 'consumer.ts'),
    `
    import { registerOverlayBrokerInstallation, unregisterOverlayBrokerInstallation,
      type OverlayBrokerInstallationOptions } from 'electron-game-overlay/broker';
    const options: OverlayBrokerInstallationOptions = { distributionPath: '/standalone', allowPrerelease: true };
    const id: Promise<string> = registerOverlayBrokerInstallation(options);
    const ordinary: Promise<string> = registerOverlayBrokerInstallation();
    const removed: Promise<void> = unregisterOverlayBrokerInstallation('a'.repeat(64));
    void [id, ordinary, removed];
    // @ts-expect-error Test-only storage roots are not public API.
    const internal: OverlayBrokerInstallationOptions = { storageRoot: '/not-public' };
    // @ts-expect-error Internal discovery is not exported by the installer subpath.
    import { discoverOverlayBrokerInstallations } from 'electron-game-overlay/broker';
  `,
  );
  fs.writeFileSync(
    path.join(f.root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: 'nodenext',
        target: 'es2022',
        types: [],
      },
      files: ['consumer.ts'],
    }),
  );
  const checked = spawnSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '-p',
      path.join(f.root, 'tsconfig.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

test('standalone main setup registers and unregisters without loading service or native modules', (t) => {
  const f = setupFixture(t);
  const registered = runHeadlessMain(['--register'], f);
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  assert.equal(registered.stderr, '');
  const id = registered.stdout.trim();
  assert.match(id, /^[0-9a-f]{64}$/);
  const catalogPath = path.join(
    f.root,
    '.electron-game-overlay/broker-v1/catalog.json',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(catalogPath, 'utf8')).entries[0].registrationId,
    id,
  );
  const unregistered = runHeadlessMain(['--unregister', id], f);
  assert.equal(
    unregistered.status,
    0,
    unregistered.stderr || unregistered.stdout,
  );
  assert.equal(unregistered.stderr, '');
  assert.equal(unregistered.stdout, '');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(catalogPath, 'utf8')).entries,
    [],
  );
});

test('standalone --help exits before loading service or native-provider modules', () => {
  const result = runHeadlessMain(['--help']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /--register \[--allow-prerelease\]/);
  assert.match(result.stdout, /--unregister <registration-id>/);
  assert.match(result.stdout, /current OS user/i);
  assert.match(result.stdout, /SYSTEM|different administrator/i);
  assert.match(result.stdout, /no arguments.*broker service/i);
  assert.match(result.stdout, /executable directory.*registration ID/i);
  assert.match(result.stdout, /does not opt clients into previews/i);
});

test('setup --register publishes a real isolated per-user catalog and independent cache', async (t) => {
  const f = setupFixture(t);
  const executablePath = Object.getOwnPropertyDescriptor(process, 'execPath');
  let result;
  try {
    Object.defineProperty(process, 'execPath', {
      value: path.join(f.source, f.executable),
    });
    result = await invokeSetup(['--register'], { storageRoot: f.storageRoot });
  } finally {
    Object.defineProperty(process, 'execPath', executablePath);
  }
  assert.equal(result.handled, true);
  assert.equal(result.lines.length, 1);
  assert.match(result.lines[0], /^[0-9a-f]{64}$/);
  const catalog = JSON.parse(
    fs.readFileSync(path.join(f.storageRoot, 'catalog.json'), 'utf8'),
  );
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].registrationId, result.lines[0]);
  const group = path.join(f.storageRoot, 'cache', catalog.entries[0].id);
  const [copy] = fs.readdirSync(group);
  const cached = path.join(group, copy, f.executable);
  assert.deepEqual(fs.readFileSync(cached), f.payload);
  fs.rmSync(f.source, { recursive: true });
  assert.deepEqual(
    fs.readFileSync(cached),
    f.payload,
    'copy survives source uninstall',
  );
});

test('setup --unregister removes only its registration and retains cached files and claims', async (t) => {
  const f = setupFixture(t);
  const other = setupFixture(t);
  const first = await invokeSetup(['--register'], f.options);
  const second = await invokeSetup(['--register'], {
    ...other.options,
    storageRoot: f.storageRoot,
  });
  const catalogPath = path.join(f.storageRoot, 'catalog.json');
  const before = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const group = path.join(f.storageRoot, 'cache', before.entries[0].id);
  const [copy] = fs.readdirSync(group);
  const cached = path.join(group, copy, f.executable);
  const claimPath = path.join(f.storageRoot, 'fixture-active-claim.json');
  const claim = '{"phase":"published","fixture":true}';
  fs.writeFileSync(claimPath, claim);
  const result = await invokeSetup(['--unregister', first.lines[0]], {
    storageRoot: f.storageRoot,
  });
  assert.equal(result.handled, true);
  assert.deepEqual(result.lines, []);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.deepEqual(
    catalog.entries.map((entry) => entry.registrationId),
    second.lines,
  );
  assert.deepEqual(fs.readFileSync(cached), f.payload);
  assert.equal(fs.readFileSync(claimPath, 'utf8'), claim);
  await invokeSetup(['--unregister', first.lines[0]], {
    storageRoot: f.storageRoot,
  });
});

test('preview setup requires the explicit flag without globally opting startup into previews', async (t) => {
  const f = setupFixture(t, '2.0.0-preview.1');
  await assert.rejects(
    invokeSetup(['--register'], { ...f.options, allowPrerelease: true }),
    /Prerelease registration requires allowPrerelease/,
  );
  assert.equal(fs.existsSync(path.join(f.storageRoot, 'catalog.json')), false);
  const result = await invokeSetup(
    ['--register', '--allow-prerelease'],
    f.options,
  );
  assert.equal(result.handled, true);
  assert.match(result.lines[0], /^[0-9a-f]{64}$/);
  const { discoverOverlayBrokerInstallations } = require(
    path.join(compiledLib, 'overlay-broker-installation.js'),
  );
  const discovery = {
    storageRoot: f.storageRoot,
    distributionPath: path.join(f.root, 'missing-own-distribution'),
  };
  assert.deepEqual(await discoverOverlayBrokerInstallations(discovery), []);
  const optedIn = await discoverOverlayBrokerInstallations({
    ...discovery,
    allowPrerelease: true,
  });
  assert.equal(optedIn.length, 1);
  assert.equal(optedIn[0].manifest.version, '2.0.0-preview.1');
});

test(
  'real Node SEA --help runs adjacent SDK modules without Node on PATH or service loading',
  { timeout: 120_000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-headless-sea-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(compiledLib, path.join(root, 'lib'), { recursive: true });
    fs.cpSync(
      path.dirname(require.resolve('tslib/package.json')),
      path.join(root, 'node_modules/tslib'),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ type: 'commonjs' }),
    );
    const executable = path.join(
      root,
      `broker${process.platform === 'win32' ? '.exe' : ''}`,
    );
    fs.writeFileSync(
      path.join(root, 'bootstrap.cjs'),
      `
    const { createRequire } = require('node:module');
    const load = createRequire(process.execPath);
    const Module = load('node:module');
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (id.toLowerCase() === 'electron' || /overlay-broker-(bootstrap|native-provider|server)\\.js$/.test(id)) {
        throw new Error('Unexpected service/native module load: ' + id);
      }
      return original.call(this, id, ...args);
    };
    void load('./lib/overlay-broker-entry.js').runOverlayBrokerMain();
  `,
    );
    const config = path.join(root, 'sea-config.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        main: 'bootstrap.cjs',
        output: executable,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: 'none',
      }),
    );
    const built = spawnSync(process.execPath, ['--build-sea', config], {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
    });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    assert.ok(
      fs.statSync(executable).size > 1_000_000,
      'a genuine runtime executable, not a script fixture',
    );
    fs.chmodSync(executable, 0o700);
    const result = spawnSync(executable, ['--help'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: '',
        NODE_PATH: '',
        NODE_OPTIONS: '',
        ELECTRON_RUN_AS_NODE: '0',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /--register \[--allow-prerelease\]/);
    assert.match(result.stdout, /--unregister <registration-id>/);
  },
);

test('unknown and malformed setup commands fail without loading service modules', (t) => {
  const f = setupFixture(t);
  const id = 'a'.repeat(64);
  for (const args of [
    ['--unknown'],
    ['--allow-prerelease'],
    ['--help', '--register'],
    ['--register', '--allow-prerelease', '--allow-prerelease'],
    ['--allow-prerelease', '--register'],
    ['--register', '/arbitrary/source'],
    ['--register', '--storage-root', '/elsewhere'],
    ['--register', '--help'],
    ['--unregister'],
    ['--unregister', 'bad-id'],
    ['--unregister', id.toUpperCase()],
    ['--unregister', `${id}\n`],
    ['--unregister', `${id}\r`],
    ['--unregister', ` ${id}`],
    ['--unregister', `${id} `],
    ['--unregister', id, '--allow-prerelease'],
    ['--unregister', '--help'],
    ['--unregister', id, 'extra'],
    ['--register=true'],
    ['cmd.exe', '/c', 'echo bad'],
    ['--', '--help'],
    [''],
  ]) {
    const result = runHeadlessMain(args, f);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(
      result.stderr,
      /Invalid broker setup arguments/,
      JSON.stringify(args),
    );
    assert.doesNotMatch(result.stderr, /forbidden during setup/);
    assert.equal(result.stdout, '');
    assert.equal(
      fs.existsSync(path.join(f.root, '.electron-game-overlay')),
      false,
    );
  }
});
