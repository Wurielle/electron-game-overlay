const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

function runMainWithPrivilegeProbe(probe) {
  const filename = path.resolve(
    __dirname,
    '../dist/lib/overlay-broker-entry.js',
  );
  return spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const childProcess = require('node:child_process');
    const events = [];
    const probe = ${JSON.stringify(probe)};
    Object.defineProperty(process, 'platform', { value: 'win32' });
    require('node:fs').realpath.native = (input, callback) => {
      assert.equal(input, ${JSON.stringify('\\\\?\\GLOBALROOT\\SystemRoot\\System32')});
      queueMicrotask(() => callback(null, ${JSON.stringify('Z:\\OS Installation\\System32')}));
    };
    childProcess.execFile = (file, args, options, callback) => {
      assert.equal(file, ${JSON.stringify('Z:\\OS Installation\\System32\\whoami.exe')});
      assert.deepEqual(args, ['/groups', '/fo', 'csv', '/nh']);
      assert.equal(options.cwd, ${JSON.stringify('Z:\\OS Installation\\System32')});
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 2000);
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.encoding, 'utf8');
      events.push('probe');
      setImmediate(() => {
        events.push('probe-complete');
        callback(probe.error ? new Error('controlled probe failure') : null, probe.output);
      });
    };
    require('node:net').createServer = () => {
      events.push('unexpected-listener');
      throw new Error('No real listener is allowed in this privilege-boundary fixture');
    };
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (id === './overlay-broker-server.js') {
        events.push('load-server');
        return { OverlayBrokerServer: class {
          constructor() { events.push('construct'); }
          async start() { events.push('listen'); }
        } };
      }
      if (id === './overlay-broker-native-provider.js') {
        events.push('load-provider');
        return { async prepareStandaloneOverlayNativeProvider() {
          events.push('prepare');
        } };
      }
      if (id.toLowerCase() === 'electron') throw new Error('Electron is forbidden');
      return original.call(this, id, ...args);
    };
    process.once('exit', () => console.log(JSON.stringify(events)));
    process.argv = [process.execPath, 'fixture-broker'];
    void require(${JSON.stringify(filename)}).runOverlayBrokerMain();
  `,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
}

for (const [name, probe, diagnostic] of [
  [
    'high integrity',
    { output: '"Mandatory Label","S-1-16-12288"' },
    /requires proven medium Windows integrity/,
  ],
  [
    'system integrity',
    { output: '"Mandatory Label","S-1-16-16384"' },
    /requires proven medium Windows integrity/,
  ],
  [
    'unknown integrity',
    { output: '' },
    /requires proven medium Windows integrity/,
  ],
  [
    'failed token probe',
    { output: '', error: true },
    /Unable to prove medium Windows integrity/,
  ],
]) {
  test(`no-argument standalone refuses ${name} before service/provider modules or listener`, () => {
    const result = runMainWithPrivilegeProbe(probe);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, diagnostic);
    assert.deepEqual(JSON.parse(result.stdout), ['probe', 'probe-complete']);
  });
}

test('no-argument standalone awaits the controlled token probe before loading service/provider modules', () => {
  const result = runMainWithPrivilegeProbe({
    output: '"Mandatory Label","S-1-16-8192"',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [
    'probe',
    'probe-complete',
    'load-server',
    'load-provider',
    'prepare',
    'construct',
    'listen',
  ]);
});

function entryHarness(fail = false) {
  const calls = [];
  const provider = {
    dispose() {
      calls.push('dispose');
    },
  };
  const filename = path.resolve(
    __dirname,
    '../dist/lib/overlay-broker-entry.js',
  );
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (id) => {
    if (id === './overlay-broker-native-provider.js')
      return {
        async prepareStandaloneOverlayNativeProvider() {
          calls.push('prepare');
          return provider;
        },
      };
    if (id === './overlay-broker-server.js')
      return {
        OverlayBrokerServer: class {
          constructor(options) {
            calls.push(['construct', options]);
          }
          async start() {
            calls.push('listen');
            if (fail) throw new Error('fixture listener failure');
          }
          async stop() {
            calls.push('stop');
            provider.dispose();
          }
        },
      };
    return require(id);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { run: loaded.exports.runOverlayBrokerServer, provider, calls };
}

test('standalone startup failure disposes the prepared provider before returning the error', async () => {
  const { run, calls } = entryHarness(true);
  await assert.rejects(run('fixture-endpoint'), /fixture listener failure/);
  assert.deepEqual(calls.slice(-2), ['stop', 'dispose']);
});

test('standalone entry prepares its cached native provider before accepting clients', async () => {
  const { run, provider, calls } = entryHarness();
  await run('fixture-endpoint');
  assert.deepEqual(calls, [
    'prepare',
    [
      'construct',
      {
        pipePath: 'fixture-endpoint',
        nativeRuntimeProvider: provider,
      },
    ],
    'listen',
  ]);
});
