const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const path = require('node:path');
function fixture(options = {}) {
  const file = path.resolve(__dirname, '../dist/lib/process-observer.js');
  const req = createRequire(file),
    module = { exports: {} };
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => {
    child.killed = true;
  };
  let invocation;
  runInNewContext(
    readFileSync(file, 'utf8'),
    {
      module,
      exports: module.exports,
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
      require: (id) =>
        id === 'node:child_process'
          ? {
              spawn(...args) {
                invocation = args;
                return child;
              },
            }
          : id === './reshade-launcher.js'
            ? {
                parseReShadeLaunchConfig() {
                  return {
                    injectorPath: 'C:\\SDK\\inject.exe',
                    injectorFutureTargets: 1,
                    runtimeProvider: { runtimeGeneration: 4 },
                  };
                },
              }
            : req(id),
    },
    { filename: file },
  );
  const created = [],
    exited = [],
    errors = [];
  const observer = module.exports.observeOverlayProcesses({
    onCreated: (value) => created.push(value),
    onExited: (value) => exited.push(value),
    onError: (value) => errors.push(value),
    ...options,
  });
  return { observer, child, created, exited, errors, invocation };
}
test('public observer streams Unicode and exact uint64 identities, matches exits and fails closed', async () => {
  const f = fixture();
  assert.equal(f.invocation[1][0], '--observe-future-path-contains');
  f.child.stdout.write('EGO_PROCESS_OBSERVER_READY_V2\r\n');
  await f.observer.ready;
  const bytes = Buffer.from(
    'EGO_PROCESS_CREATE_V2\t42\t9007199254740993\tC:\\日本語\\é.exe\r\n',
  );
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  assert.equal(f.created[0].executablePath, 'C:\\日本語\\é.exe');
  assert.equal(f.created[0].creationTime100ns, '9007199254740993');
  f.child.stdout.write(
    'EGO_PROCESS_DELETE_V2\t42\t9007199254740993\tC:\\日本語\\é.exe\n',
  );
  assert.equal(f.exited[0], f.created[0]);
  f.child.stdout.write(
    'EGO_PROCESS_CREATE_V2\t42\t9007199254740994\tC:\\日本語\\é.exe\n',
  );
  f.child.emit('exit', 1);
  assert.equal(f.created.length, 2);
  assert.equal(
    f.exited.length,
    1,
    'observer failure never fabricates target exit',
  );
  assert.equal(f.errors.length, 1);
  assert.equal(f.child.killed, true);
});
test('dispose and abort before ready reject readiness once without process exit callbacks', async () => {
  for (const cancel of ['dispose', 'abort']) {
    const controller = new AbortController(),
      f = fixture({ signal: controller.signal });
    const rejected = assert.rejects(f.observer.ready, /disposed|cancelled/);
    if (cancel === 'dispose') f.observer.dispose();
    else controller.abort();
    await rejected;
    f.observer.dispose();
    f.child.emit('exit');
    assert.equal(f.exited.length, 0);
    assert.equal(f.child.killed, true);
  }
});
test('mismatched exit identity terminates observation without claiming PID exit', async () => {
  const f = fixture();
  f.child.stdout.write('EGO_PROCESS_OBSERVER_READY_V2\n');
  await f.observer.ready;
  f.child.stdout.write('EGO_PROCESS_CREATE_V2\t42\t7\tC:\\Game.exe\n');
  f.child.stdout.write('EGO_PROCESS_DELETE_V2\t42\t8\tC:\\Game.exe\n');
  assert.equal(f.exited.length, 0);
  assert.equal(f.errors.length, 1);
});
