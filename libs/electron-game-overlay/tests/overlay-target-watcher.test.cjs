const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const path = require('node:path');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture(t, options = {}) {
  const launches = [],
    events = [],
    handlers = new Map(),
    sessionReady = deferred(),
    observationReady = deferred();
  let observer;
  class Launcher {
    constructor() {
      this.handlers = new Set();
      this.prepareGate = deferred();
      this.quiesceGate = deferred();
      if (!options.holdPreparation) this.prepareGate.resolve();
      this.completion = deferred();
      this.calls = [];
      this.confirmed = [];
      launches.push(this);
    }
    prepare() {
      return this.prepareGate.promise;
    }
    onEvent(fn) {
      this.handlers.add(fn);
      return () => this.handlers.delete(fn);
    }
    attach(session, selector) {
      this.calls.push(selector);
      return this.completion.promise;
    }
    emit(event) {
      for (const fn of this.handlers) fn(event);
    }
    async quiesceUnselectedPolicyWatcher() {
      this.quiesceCalls = (this.quiesceCalls ?? 0) + 1;
      const safe = options.holdQuiescence
        ? await this.quiesceGate.promise
        : !options.uncertainQuiescence;
      if (safe) this.dispose();
      return safe;
    }
    dispose() {
      this.disposed = true;
    }
    confirmTargetExited(pid) {
      this.confirmed.push(pid);
    }
  }
  const file = path.resolve(__dirname, '../dist/lib/overlay-target-watcher.js'),
    req = createRequire(file),
    module = { exports: {} };
  runInNewContext(
    readFileSync(file, 'utf8'),
    {
      module,
      exports: module.exports,
      process,
      console,
      Buffer,
      require: (id) =>
        id === './reshade-launcher.js'
          ? {
              ReShadeOverlayLauncher: Launcher,
              createReShadeLaunchConfig: () => ({
                runtimeDirectory: 'C:\\sdk',
              }),
            }
          : id === './process-observer.js'
            ? {
                observeOverlayProcesses(o) {
                  observer = {
                    ...o,
                    ready: observationReady.promise,
                    disposed: false,
                    dispose() {
                      this.disposed = true;
                    },
                  };
                  return observer;
                },
              }
            : req(id),
    },
    { filename: file },
  );
  const session = {
    whenReady: () => sessionReady.promise,
    onClose(fn) {
      handlers.set('close', fn);
      return () => handlers.delete('close');
    },
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
  };
  const watcher = new module.exports.OverlayTargetWatcher(session, {
    ...options,
    onEvent: (e) => events.push(e),
  });
  t.after(() => watcher.dispose());
  if (!options.holdSession) sessionReady.resolve();
  return {
    watcher,
    get launches() {
      return launches.filter((l) => l.calls.length > 0);
    },
    prepared: launches,
    events,
    handlers,
    observationReady,
    get observer() {
      return observer;
    },
    async start() {
      await tick();
      observationReady.resolve();
      await tick();
    },
  };
}
const game = { processName: 'game.exe', executablePath: 'C:\\Games\\game.exe' };
const identity = (
  pid = 42,
  time = '9007199254740993',
  file = game.executablePath,
) => Object.freeze({ pid, creationTime100ns: time, executablePath: file });
const returned = (l, pid = 42, file = game.executablePath) =>
  l.emit({
    type: 'injector-returned',
    result: { injectorTargetPid: pid, targetExecutablePath: file },
  });
const connected = (l, pid = 42, file = game.executablePath) =>
  l.emit({ type: 'target-connected', pid, path: file });
test('ready waits for observer baseline and every native watcher, never injection completion', async (t) => {
  const f = fixture(t, { earlyTargets: [game, { processName: 'other.exe' }] });
  await tick();
  assert.equal(f.launches.length, 0);
  f.observationReady.resolve();
  await tick();
  assert.equal(f.launches.length, 2);
  let ready = false;
  f.watcher.ready.then(() => (ready = true));
  f.launches[0].emit({ type: 'injector-watcher-ready' });
  await tick();
  assert.equal(ready, false);
  f.launches[1].emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  assert.equal(ready, true);
});
test('early native selection deduplicates observer creation and handles authentication arriving first', async (t) => {
  let predicates = 0;
  const f = fixture(t, {
    earlyTargets: [game],
    acceptBestEffort: () => {
      predicates++;
      return true;
    },
  });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  f.observer.onCreated(identity());
  f.observer.onCreated(identity(43, '9007199254740994'));
  f.handlers.get('targetConnected')({
    pid: 43,
    executablePath: game.executablePath,
  });
  assert.equal(f.watcher.targets.length, 0);
  assert.equal(predicates, 0);
  assert.equal(f.launches.length, 1);
  returned(l, 43);
  connected(l, 43);
  assert.equal(f.watcher.targets[0].identity.pid, 43);
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(f.events.filter((e) => e.type === 'connected').length, 1);
  f.handlers.get('targetTransportLost')({ pid: 43 });
  assert.equal(f.watcher.targets[0].status, 'transport-lost');
  f.handlers.get('targetConnected')({
    pid: 43,
    executablePath: game.executablePath,
  });
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(f.launches.length, 1);
});
test('authoritative exit disposes and rearms a fresh launcher; unrelated exits are ignored', async (t) => {
  const f = fixture(t, { earlyTargets: [game] });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  f.observer.onExited(identity(99, '9', 'C:\\other.exe'));
  assert.equal(f.observer.disposed, false);
  f.observer.onCreated(identity());
  returned(l);
  connected(l);
  f.observer.onExited(identity());
  await tick();
  assert.deepEqual(l.confirmed, [42]);
  assert.equal(l.disposed, true);
  assert.equal(f.launches.length, 2);
  assert.equal(f.watcher.targets.length, 0);
  assert.equal(f.events.filter((e) => e.type === 'exited').length, 1);
});
test('exit before injector result is retained and consumed only for the same observed incarnation', async (t) => {
  const f = fixture(t, { earlyTargets: [game] });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  f.observer.onCreated(identity());
  f.observer.onExited(identity());
  assert.equal(f.launches.length, 1);
  returned(l);
  await tick();
  assert.deepEqual(l.confirmed, [42]);
  assert.equal(f.launches.length, 2);
  connected(l);
  assert.equal(
    f.watcher.targets.length,
    0,
    'late old callbacks cannot recreate an exited target',
  );
});
test('best-effort failure remains reserved until OS exit, never transport loss or an arbitrary deletion', async (t) => {
  const f = fixture(t, { acceptBestEffort: () => true });
  await f.start();
  await f.watcher.ready;
  f.observer.onCreated(identity());
  const l = f.launches[0];
  l.completion.reject(Error('indeterminate injection'));
  await tick();
  assert.equal(f.watcher.targets[0].status, 'failed');
  assert.equal(l.disposed, undefined);
  f.handlers.get('targetConnected')({
    pid: 42,
    executablePath: game.executablePath,
  });
  assert.equal(
    f.watcher.targets[0].status,
    'connected',
    'late authentication may recover a retained attempt without injection',
  );
  f.handlers.get('targetTransportLost')({ pid: 42 });
  assert.equal(f.launches.length, 1);
  assert.equal(l.confirmed.length, 0);
  f.observer.onExited(identity());
  assert.deepEqual(l.confirmed, [42]);
  f.observer.onCreated(identity(42, '9007199254740994'));
  assert.equal(f.launches.length, 2);
  assert.equal(
    f.watcher.targets[0].identity.creationTime100ns,
    '9007199254740994',
  );
});
test('policy removal cancels synchronously and blocks duplicate fallback or re-add of uncertain selectors', async (t) => {
  const f = fixture(t, { earlyTargets: [game] });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  const revision = f.watcher.update({ acceptBestEffort: () => true });
  assert.equal(l.disposed, true);
  await revision;
  f.observer.onCreated(identity());
  assert.equal(f.launches.length, 1);
  await f.watcher.update({ earlyTargets: [game] });
  assert.equal(f.events.at(-1).type, 'discovery-blocked');
  assert.equal(f.launches.length, 1);
  returned(l);
  f.observer.onExited(identity());
  const fresh = f.watcher.update({ earlyTargets: [game] });
  await tick();
  assert.equal(f.launches.length, 2);
  f.launches[1].emit({ type: 'injector-watcher-ready' });
  await fresh;
});
test('updates before baseline never arm early and an updated predicate only retains or cancels known targets', async (t) => {
  const f = fixture(t, { earlyTargets: [game] });
  const revision = f.watcher.update({ acceptBestEffort: () => true });
  await tick();
  assert.equal(f.launches.length, 0);
  f.observationReady.resolve();
  await revision;
  await f.watcher.ready;
  // Cancelled early reservation stays fail-closed. Another path uses best effort.
  const other = identity(7, '7', 'C:\\Other\\new.exe');
  f.observer.onCreated(other);
  const l = f.launches[0];
  connected(l, 7, other.executablePath);
  await f.watcher.update({ acceptBestEffort: () => true });
  assert.equal(l.disposed, undefined);
  const cancellation = f.watcher.cancel();
  assert.equal(l.disposed, true);
  await cancellation;
  assert.equal(f.watcher.targets[0].cancelled, true);
});
test('observer failure cancels all work without asserting target exit or rearming', async (t) => {
  const f = fixture(t, { acceptBestEffort: () => true });
  await f.start();
  await f.watcher.ready;
  f.observer.onCreated(identity());
  f.observer.onError(Error('native observer failed'));
  assert.equal(f.launches[0].disposed, true);
  assert.equal(f.launches[0].confirmed.length, 0);
  assert.equal(
    f.events.some((e) => e.type === 'exited'),
    false,
  );
  assert.throws(() => f.watcher.update({}), /stopped/);
});
test('mismatched exit and recycled PID results fail closed instead of confirming an unrelated incarnation', async (t) => {
  for (const mode of ['mismatch', 'recycle']) {
    const f = fixture(t, { earlyTargets: [game] });
    await f.start();
    const l = f.launches[0];
    l.emit({ type: 'injector-watcher-ready' });
    await f.watcher.ready;
    f.observer.onCreated(identity());
    if (mode === 'mismatch') f.observer.onExited(identity(42, '8'));
    else {
      f.observer.onExited(identity());
      f.observer.onCreated(identity(42, '8'));
      returned(l);
    }
    assert.equal(l.confirmed.length, 0);
    assert.equal(f.observer.disposed, true);
    assert.equal(f.launches.length, 1);
  }
});
test('abort and session close stop resources; dispose before initial readiness settles without fabricated exit', async (t) => {
  for (const mode of ['abort', 'close', 'dispose']) {
    const signal = new AbortController();
    const f = fixture(t, { signal: signal.signal, earlyTargets: [game] });
    await tick();
    const rejection = assert.rejects(f.watcher.ready, /disposed|stopped/);
    if (mode === 'abort') signal.abort();
    else if (mode === 'close') f.handlers.get('close')();
    else f.watcher.dispose();
    f.observationReady.resolve();
    await rejection;
    assert.equal(f.observer.disposed, true);
    assert.equal(f.launches.length, 0);
    assert.equal(
      f.events.some((e) => e.type === 'exited'),
      false,
    );
  }
});
test('invalid/overlapping selectors are rejected before any observation; application callback failures are isolated', async (t) => {
  for (const earlyTargets of [
    [{ processName: '*.exe' }],
    [{ processName: 'game.exe', executablePath: 'C:\\other.exe' }],
    [game, { processName: 'GAME.exe' }],
  ]) {
    assert.throws(() => fixture(t, { earlyTargets }), /exact|overlap/);
  }
  const f = fixture(t, {
    acceptBestEffort: () => {
      throw Error('policy failed');
    },
  });
  await f.start();
  await f.watcher.ready;
  f.watcher.onEvent(() => {
    throw Error('observer callback failed');
  });
  f.observer.onCreated(identity());
  assert.equal(f.launches.length, 0);
  assert.equal(f.events.at(-1).type, 'error');
});

test('dispose settles readiness even while the session never becomes ready', async (t) => {
  const f = fixture(t, { holdSession: true });
  const rejected = assert.rejects(f.watcher.ready, /disposed/);
  f.watcher.dispose();
  await rejected;
  assert.equal(f.observer, undefined);
});

test('best-effort readiness stages a spare before discovery and consumes it without another preparation barrier', async (t) => {
  const f = fixture(t, { acceptBestEffort: () => true, holdPreparation: true });
  await f.start();
  let ready = false;
  f.watcher.ready.then(() => (ready = true));
  await tick();
  assert.equal(ready, false);
  assert.equal(f.prepared.length, 1);
  f.prepared[0].prepareGate.resolve();
  await f.watcher.ready;
  f.observer.onCreated(identity());
  assert.equal(f.launches[0], f.prepared[0]);
  assert.equal(
    f.prepared.length,
    2,
    'replacement staging is separate from injection',
  );
});
test('narrowing an uncertain name selector blocks only overlapping discovery', async (t) => {
  const f = fixture(t, { earlyTargets: [{ processName: 'game.exe' }] });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  await f.watcher.update({
    earlyTargets: [game],
    acceptBestEffort: () => true,
  });
  assert.equal(f.events.at(-1).type, 'discovery-blocked');
  assert.equal(l.disposed, true);
  f.observer.onCreated(identity());
  f.observer.onCreated(identity(9, '9', 'C:\\other.exe'));
  assert.equal(
    f.launches.length,
    2,
    'unrelated authorized exact-PID discovery continues',
  );
});
test('a predicate cancelling policy cannot authorize a post-cancellation injection', async (t) => {
  const f = fixture(t);
  await f.start();
  await f.watcher.ready;
  await f.watcher.update({
    acceptBestEffort: () => {
      void f.watcher.cancel();
      return true;
    },
  });
  f.observer.onCreated(identity());
  assert.equal(f.launches.length, 0);
  assert.equal(f.watcher.targets.length, 0);
});

test('removing a redundant named selector preserves its authenticated target while best-effort still authorizes it', async (t) => {
  const f = fixture(t, { earlyTargets: [game], acceptBestEffort: () => true });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  f.observer.onCreated(identity());
  returned(l);
  connected(l);
  const updatesBefore = f.events.length;
  await f.watcher.update({ earlyTargets: [], acceptBestEffort: () => true });
  assert.equal(l.disposed, undefined);
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(f.watcher.targets[0].cancelled, false);
  assert.equal(
    f.events.slice(updatesBefore).some((e) => e.type === 'cancelled'),
    false,
  );
  assert.equal(l.calls.length, 1);
  const revoke = f.watcher.update({ acceptBestEffort: () => false });
  assert.equal(l.disposed, true);
  assert.equal(f.watcher.targets[0].cancelled, true);
  await revoke;
});
test('native folder policy preserves active targets when a redundant path rule disappears and denies override callbacks', async (t) => {
  const broad = '**/steamapps/**',
    file = 'C:\\Steam\\steamapps\\common\\game.exe',
    p = { allow: [broad, '**/game.exe'], deny: ['**/UnityCrashHandler64.exe'] };
  const f = fixture(t, { earlyPolicy: p, acceptBestEffort: () => true });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await f.watcher.ready;
  f.observer.onCreated(identity(42, '100', file));
  l.emit({
    type: 'target-selected',
    pid: 42,
    creationTime100ns: '100',
    executablePath: file,
  });
  connected(l, 42, file);
  await tick();
  assert.equal(f.launches.length, 2);
  const successor = f.launches[1];
  assert.equal(successor.calls[0].policyResume.creationCutoff100ns, '10');
  assert.equal(
    successor.calls[0].policyResume.excludedInstances[0].creationTime100ns,
    '100',
  );
  const revision = f.watcher.update({
    earlyPolicy: { allow: [broad], deny: p.deny },
    acceptBestEffort: () => true,
  });
  await tick();
  const next = f.launches.at(-1);
  next.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await revision;
  assert.equal(l.disposed, undefined);
  assert.equal(successor.disposed, true);
  assert.equal(f.watcher.targets[0].cancelled, false);
  f.observer.onCreated(
    identity(7, '101', 'C:\\Steam\\steamapps\\UnityCrashHandler64.exe'),
  );
  assert.equal(f.watcher.targets.length, 1);
  const revoke = f.watcher.update({
    earlyPolicy: { allow: [broad], deny: ['**/game.exe'] },
    acceptBestEffort: () => true,
  });
  assert.equal(l.disposed, true);
  assert.equal(f.watcher.targets[0].cancelled, true);
  await tick();
  f.launches
    .at(-1)
    .emit({ type: 'injector-watcher-ready', creationCutoff100ns: '30' });
  await revoke;
});

test('adding then removing a covered literal allow retains the armed native successor and its active target', async (t) => {
  const broad = 'C:/Steam/steamapps/**',
    file = 'C:/Steam/steamapps/common/game.exe';
  const policy = { allow: [broad], deny: ['**/UnityCrashHandler64.exe'] };
  const f = fixture(t, { earlyPolicy: policy });
  await f.start();
  const l = f.launches[0];
  l.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await f.watcher.ready;
  l.emit({
    type: 'target-selected',
    pid: 42,
    creationTime100ns: '100',
    executablePath: file,
  });
  connected(l, 42, file);
  await tick();
  assert.equal(f.launches.length, 2);
  const successor = f.launches[1];
  successor.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await tick();
  await f.watcher.update({
    earlyPolicy: { allow: [broad, file], deny: policy.deny },
  });
  await f.watcher.update({ earlyPolicy: policy });
  assert.equal(f.launches.length, 2);
  assert.equal(l.disposed, undefined);
  assert.equal(successor.disposed, undefined);
  assert.equal(f.watcher.targets[0].cancelled, false);
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(
    f.events.some((e) => e.type === 'cancelled'),
    false,
  );
});

test('folder -> folder plus global basename -> folder preserves the exact authorized target and safely replaces armed successors', async (t) => {
  const broad = 'C:/controlled/target/**',
    file = 'C:/controlled/target/d3d11_overlay_test_host.exe';
  const initial = { allow: [broad], deny: [] };
  const f = fixture(t, { earlyPolicy: initial });
  await f.start();
  const active = f.launches[0];
  active.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await f.watcher.ready;
  active.emit({
    type: 'target-selected',
    pid: 42,
    creationTime100ns: '100',
    executablePath: file,
  });
  connected(active, 42, file);
  await tick();
  const firstSuccessor = f.launches[1];
  firstSuccessor.emit({
    type: 'injector-watcher-ready',
    creationCutoff100ns: '10',
  });
  await tick();
  const add = f.watcher.update({
    earlyPolicy: { allow: [broad, '**/d3d11_overlay_test_host.exe'], deny: [] },
  });
  await tick();
  assert.equal(firstSuccessor.quiesceCalls, 1);
  assert.equal(firstSuccessor.disposed, true);
  assert.equal(f.launches.length, 3);
  const expanded = f.launches[2];
  expanded.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await add;
  const remove = f.watcher.update({ earlyPolicy: initial });
  await tick();
  assert.equal(expanded.quiesceCalls, 1);
  assert.equal(f.launches.length, 4);
  const restored = f.launches[3];
  restored.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '30' });
  await remove;
  assert.equal(active.disposed, undefined);
  assert.equal(active.calls.length, 1);
  assert.equal(f.watcher.targets[0].cancelled, false);
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(
    f.events.some(
      (e) => e.type === 'cancelled' || e.type === 'discovery-blocked',
    ),
    false,
  );
});

test('uncertain discovery replacement reports blocked without revoking an allowed active target; a genuine deny still revokes synchronously', async (t) => {
  const broad = 'C:/controlled/target/**',
    file = 'C:/controlled/target/game.exe';
  const f = fixture(t, {
    earlyPolicy: { allow: [broad], deny: [] },
    uncertainQuiescence: true,
  });
  await f.start();
  const active = f.launches[0];
  active.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await f.watcher.ready;
  active.emit({
    type: 'target-selected',
    pid: 42,
    creationTime100ns: '100',
    executablePath: file,
  });
  connected(active, 42, file);
  await tick();
  const successor = f.launches[1];
  successor.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await tick();
  await f.watcher.update({
    earlyPolicy: { allow: [broad, '**/game.exe'], deny: [] },
  });
  assert.equal(
    f.launches.length,
    2,
    'no replacement may race uncertain mutation',
  );
  assert.equal(f.events.at(-1).type, 'discovery-blocked');
  assert.equal(active.disposed, undefined);
  assert.equal(f.watcher.targets[0].cancelled, false);
  await f.watcher.update({ earlyPolicy: { allow: [broad], deny: [] } });
  assert.equal(f.watcher.targets[0].cancelled, false);
  const revoke = f.watcher.update({
    earlyPolicy: { allow: [broad], deny: ['**/game.exe'] },
  });
  assert.equal(f.watcher.targets[0].cancelled, true);
  assert.equal(active.disposed, true);
  await revoke;
  assert.equal(f.launches.length, 2);
});

test('a later policy revision supersedes a pending discovery stop without arming its obsolete basename expansion', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, {
    earlyPolicy: { allow: [broad] },
    holdQuiescence: true,
  });
  await f.start();
  const first = f.launches[0];
  first.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await f.watcher.ready;
  const add = f.watcher.update({
    earlyPolicy: { allow: [broad, '**/game.exe'] },
  });
  const remove = f.watcher.update({ earlyPolicy: { allow: [broad] } });
  first.quiesceGate.resolve(true);
  await tick();
  assert.equal(f.launches.length, 2);
  assert.deepEqual(Array.from(f.launches[1].calls[0].processPolicy.allow), [
    broad.toLowerCase(),
  ]);
  f.launches[1].emit({
    type: 'injector-watcher-ready',
    creationCutoff100ns: '20',
  });
  await Promise.all([add, remove]);
});
