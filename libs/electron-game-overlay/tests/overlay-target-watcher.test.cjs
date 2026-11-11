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
      Error,
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

for (const fastExit of [false, true]) test(`mixed broad policy survives an unopened unrelated selection, fastExit=${fastExit}`, async t => {
  const root = 'C:/owned-refusal/', a = root + 'A.exe', b = root + 'B.exe', c = root + 'fast-exit.exe';
  const f = fixture(t, { earlyPolicy: {allow:[root + '**'],deny:[]}, config:{runtimeDirectory:'C:/sdk',injectorFutureTargets:2} });
  await f.start(); const first = f.launches[0];
  first.emit({type:'injector-watcher-ready',creationCutoff100ns:'10'}); await f.watcher.ready;
  const select = (launcher, instance) => launcher.emit({type:'target-selected',...instance});
  const firstA = identity(40,'100',a), failedB = identity(41,'200',b), refused = identity(42,'300',c);
  f.observer.onCreated(firstA); select(first,firstA); returned(first,40,a); connected(first,40,a);
  first.completion.resolve({pid:40}); await tick(); f.observer.onExited(firstA);
  const second = f.launches[1]; second.emit({type:'injector-watcher-ready',creationCutoff100ns:'10'});
  f.observer.onCreated(failedB); select(second,failedB); await tick();
  const unrelated = f.launches[2]; unrelated.emit({type:'injector-watcher-ready',creationCutoff100ns:'10'});
  f.observer.onCreated(refused); if(fastExit) f.observer.onExited(refused);
  // Native V2 comes from its retained read-only handle, before the full open.
  // No legacy selection, injector success or transport authentication occurs.
  select(unrelated,refused);
  unrelated.completion.reject(Object.assign(new Error('Failed to open target application process!'),{code:'injector-failed',stage:'injector',retrySafety:'definite-safe'}));
  await tick();
  const next = f.launches[3]; assert.ok(next,'refusal must not exhaust broad discovery');
  next.emit({type:'injector-watcher-ready',creationCutoff100ns:'10'});
  assert.equal(next.calls[0].policyResume.creationCutoff100ns,'10');
  for(const instance of [failedB,...(fastExit?[]:[refused])]) assert.equal(next.calls[0].policyResume.excludedInstances.some(x=>x.pid===instance.pid && x.creationTime100ns===instance.creationTime100ns),true);
  if(fastExit) assert.equal(unrelated.confirmed.length,1);
  second.completion.reject(Object.assign(new Error('B runtime timeout'),{code:'runtime-initialization-timeout',stage:'runtime-initialization',retrySafety:'indeterminate'}));
  await tick(); f.observer.onCreated(failedB); if(!fastExit) f.observer.onCreated(refused);
  assert.equal(f.launches.length,4,'neither a definite refusal nor an uncertain live instance is blindly retried');
  f.observer.onExited(failedB);
  const freshA = identity(43,'400',a); f.observer.onCreated(freshA); select(next,freshA); returned(next,43,a); connected(next,43,a); next.completion.resolve({pid:43});
  await tick(); f.observer.onExited(refused);
  assert.equal(f.watcher.targets.length,1); assert.equal(f.watcher.targets[0].pid,43); assert.equal(f.watcher.targets[0].status,'connected');
  assert.equal(f.events.some(e=>e.type==='error'&&!e.target&&!e.selector),false);
  assert.equal(f.observer.disposed,false); assert.equal(second.calls.length,1); assert.equal(unrelated.calls.length,1);
});

test('legacy selector-only refusal explicitly blocks discovery without guessing an instance or retrying', async t => {
  const f=fixture(t,{earlyPolicy:{allow:['C:/owned-refusal/**'],deny:[]}}); await f.start();
  const first=f.launches[0]; first.emit({type:'injector-watcher-ready',creationCutoff100ns:'10'}); await f.watcher.ready;
  first.completion.reject(Object.assign(new Error('legacy unselected open refusal'),{code:'injector-failed',retrySafety:'definite-safe'})); await tick();
  assert.equal(f.events.some(e=>e.type==='discovery-blocked'&&e.selector&&!e.target),true);
  assert.equal(f.events.some(e=>e.type==='error'&&!e.target&&!e.selector),false);
  assert.equal(f.launches.length,1); assert.equal(f.watcher.targets.length,0); assert.equal(f.observer.disposed,false);
});

for (const failure of [
  { code: 'target-preloaded-member-elevation-rejected', stage: 'target-preflight', retrySafety: 'definite-safe', windowsErrorCode: 5 },
  { code: 'target-startup-readiness-failed', stage: 'target-preflight', retrySafety: 'definite-safe', windowsErrorCode: 1460 },
  { code: 'target-module-inspection-failed', stage: 'target-preflight', retrySafety: 'definite-safe', windowsErrorCode: 299 },
  { code: 'injector-failed', stage: 'injector', retrySafety: 'indeterminate' },
  { code: 'runtime-initialization-timeout', stage: 'runtime-initialization', retrySafety: 'indeterminate' },
]) for (const exitBeforeFailure of [false, true]) {
  test(`broad policy mixed A-success B-${failure.code} new-A-success, exitBeforeFailure=${exitBeforeFailure}`, async t => {
    const { createOverlayProcessPolicy } = require('../dist/lib/process-policy.js');
    const a = 'C:/owned-mixed/steamapps/A.exe', b = 'C:/owned-mixed/steamapps/B.exe';
    const policy = createOverlayProcessPolicy({ allow: ['C:/owned-mixed/steamapps/**'], deny: ['**/denied.exe'] });
    const f = fixture(t, { earlyPolicy: policy, config: { runtimeDirectory: 'C:\\sdk', injectorFutureTargets: 2 } });
    await f.start();
    const first = f.launches[0];
    first.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
    await f.watcher.ready;
    const select = (launcher, instance) => launcher.emit({ type: 'target-selected', ...instance });
    const firstA = identity(40, '100', a), failedB = identity(41, '200', b);
    f.observer.onCreated(firstA); select(first, firstA); returned(first, 40, a); connected(first, 40, a);
    first.completion.resolve({ pid: 40 });
    await tick();
    assert.equal(f.watcher.targets[0].status, 'connected');
    const second = f.launches[1];
    second.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
    f.observer.onExited(firstA);
    await tick();
    assert.equal(first.confirmed.length, 1);
    f.observer.onCreated(failedB); select(second, failedB);
    await tick();
    const successor = f.launches[2];
    successor.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
    assert.equal(successor.calls[0].policyResume.excludedInstances.some(instance => instance.pid === 41 && instance.creationTime100ns === '200'), true);
    const error = Object.assign(new Error('owned synthetic failure'), failure);
    if (exitBeforeFailure) f.observer.onExited(failedB);
    second.completion.reject(error);
    await tick();
    if (!exitBeforeFailure) {
      assert.equal(f.watcher.targets[0].status, 'failed');
      assert.equal(f.events.some(event => event.type === 'error' && event.error.code === failure.code &&
        event.error.stage === failure.stage && event.error.retrySafety === failure.retrySafety &&
        event.target.identity.creationTime100ns === '200'), true);
      assert.equal(second.disposed, undefined, 'uncertain live attempt must retain its reservation');
      f.observer.onCreated(failedB);
      f.handlers.get('targetTransportLost')({ pid: 41 });
      assert.equal(second.calls.length, 1);
      assert.equal(f.launches.length, 3, 'no same-live-process reinjection');
      f.observer.onExited(failedB);
    }
    await tick();
    assert.equal(f.watcher.targets.length, 0);
    // Recycle B's PID for a new A, then deliver a delayed old-B exit/result.
    const newA = identity(41, '300', a);
    f.observer.onCreated(newA); select(successor, newA);
    f.observer.onExited(failedB);
    returned(second, 41, b); connected(second, 41, b);
    returned(successor, 41, a); connected(successor, 41, a);
    successor.completion.resolve({ pid: 41 });
    await tick();
    assert.equal(f.observer.disposed, false);
    assert.equal(f.watcher.targets.length, 1);
    assert.equal(f.watcher.targets[0].identity.creationTime100ns, '300');
    assert.equal(f.watcher.targets[0].status, 'connected');
    assert.equal(f.watcher.targets[0].cancelled, false);
    assert.equal(f.events.some(event => event.type === 'error' && !event.target && !event.selector), false, 'consumer must never receive a global stop signal for a target failure');
    f.observer.onExited(newA);
    await tick();
    assert.equal(successor.confirmed.length, 1);
  });
}
test('a failed live broad-policy B retains its instance while a distinct new A authenticates', async t => {
  const root = 'C:/owned-mixed/steamapps/', a = root + 'A.exe', b = root + 'B.exe';
  const f = fixture(t, { earlyPolicy: { allow: [root + '**'], deny: [] } });
  await f.start(); const first = f.launches[0];
  first.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' }); await f.watcher.ready;
  const failed = identity(41, '100', b); f.observer.onCreated(failed);
  first.emit({ type: 'target-selected', ...failed });
  first.completion.reject(Object.assign(new Error('uncertain live B'), { retrySafety: 'indeterminate' }));
  await tick();
  const next = f.launches[1]; next.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  f.observer.onCreated(failed); f.observer.onCreated(failed);
  const fresh = identity(42, '200', a); f.observer.onCreated(fresh);
  next.emit({ type: 'target-selected', ...fresh }); returned(next, fresh.pid, a); connected(next, fresh.pid, a);
  await tick();
  assert.equal(f.watcher.targets.find(target => target.pid === 41).status, 'failed');
  assert.equal(f.watcher.targets.find(target => target.pid === 42).status, 'connected');
  assert.equal(first.calls.length, 1); assert.equal(first.disposed, undefined);
  f.observer.onExited(failed);
  assert.equal(first.confirmed.length, 1);
  assert.equal(f.watcher.targets.length, 1); assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(f.events.some(event => event.type === 'error' && !event.target && !event.selector), false);
});

test('best-effort replacement preparation failure stays scoped to the triggering target', async t => {
  const f = fixture(t, { acceptBestEffort: () => true, holdPreparation: true });
  await f.start(); f.prepared[0].prepareGate.resolve(); await f.watcher.ready;
  f.observer.onCreated(identity());
  f.prepared[1].prepareGate.reject(new Error('owned spare staging failure'));
  await tick();
  assert.equal(f.events.some(event => event.type === 'error' && event.target?.identity.creationTime100ns === identity().creationTime100ns), true);
  assert.equal(f.events.some(event => event.type === 'error' && !event.target && !event.selector), false);
  assert.equal(f.observer.disposed, false); assert.equal(f.launches[0].disposed, undefined);
});

test('a successor preparation failure during startup stays selector-scoped and preserves the selected target', async t => {
  const file = 'C:/owned-mixed/steamapps/A.exe';
  const f = fixture(t, { earlyPolicy: { allow: ['C:/owned-mixed/steamapps/**'], deny: [] }, holdPreparation: true });
  await f.start();
  f.prepared[0].prepareGate.resolve();
  await tick();
  const first = f.launches[0];
  const readiness = f.watcher.ready.catch(error => error);
  first.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  f.observer.onCreated(identity(40, '100', file));
  first.emit({ type: 'target-selected', ...identity(40, '100', file) });
  connected(first, 40, file);
  await tick();
  f.prepared[1].prepareGate.reject(new Error('owned successor staging failure'));
  await readiness; await tick();
  assert.equal(f.observer.disposed, false);
  assert.equal(first.disposed, undefined);
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(f.watcher.targets[0].cancelled, false);
  assert.equal(f.events.some(event => event.type === 'error' && !event.target && !event.selector), false);
  assert.equal(f.events.some(event => event.type === 'discovery-blocked' && event.selector), true);
});

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

test('controlled early acceptance rejects only owned-image fallback and tolerates unrelated machine processes', async (t) => {
  const { createEarlyTargetFallbackGuard } = require('./managed-target-policy.fixture.cjs');
  const guard = createEarlyTargetFallbackGuard(game.executablePath);
  assert.throws(() => guard(identity()), /Early discovery must never use exact-PID fallback/);
  assert.throws(() => guard(identity(43, '9007199254740994', 'c:/GAMES/GAME.exe')), /Early discovery/);
  assert.equal(guard(identity(99, '9', 'C:\\Windows\\System32\\unrelated.exe')), false);
  const f = fixture(t, { earlyTargets: [game], acceptBestEffort: guard });
  await f.start();
  const launcher = f.launches[0];
  launcher.emit({ type: 'injector-watcher-ready' });
  await f.watcher.ready;
  f.observer.onCreated(identity(99, '9', 'C:\\Windows\\System32\\unrelated.exe'));
  f.observer.onCreated(identity());
  returned(launcher);
  connected(launcher);
  assert.equal(f.launches.length, 1, 'the owned image uses only its prearmed native attempt');
  assert.equal(f.watcher.targets[0].mode, 'early');
  assert.equal(f.events.some(event => event.type === 'error'), false);
  f.observer.onExited(identity(99, '9', 'C:\\Windows\\System32\\unrelated.exe'));
  f.observer.onExited(identity());
  await tick();
  assert.equal(f.launches.length, 2, 'the early selector rearms after authoritative owned-target exit');
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
    assert.equal(f.observer.disposed, false);
    assert.equal(f.launches.length, 1);
    assert.equal(f.events.some(event => event.type === 'error' && event.selector), true);
    assert.equal(f.events.some(event => event.type === 'error' && !event.target && !event.selector), false);
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

function trackInitialReadiness(watcher) {
  const state = { status: 'pending' };
  watcher.ready.then(
    () => { state.status = 'fulfilled'; },
    (error) => { state.status = 'rejected'; state.error = error; },
  );
  return state;
}

test('startup revision: replacing a preparing policy waits for the current watcher and ignores obsolete preparation failure', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, {
    earlyPolicy: { allow: [broad] },
    holdPreparation: true,
  });
  await f.start();
  const initial = f.prepared[0];
  const state = trackInitialReadiness(f.watcher);
  const update = f.watcher.update({
    earlyPolicy: { allow: [broad, '**/database-game.exe'] },
  });
  await tick();
  assert.equal(initial.disposed, true);
  assert.equal(state.status, 'pending', 'retiring a policy is not a controller startup failure');
  assert.equal(f.prepared.length, 2);
  assert.equal(f.events.some((event) => event.type === 'ready'), false);
  const current = f.prepared[1];
  current.prepareGate.resolve();
  await tick();
  assert.equal(f.launches.length, 1);
  initial.prepareGate.reject(Error('obsolete preparation failed'));
  await tick();
  assert.equal(initial.calls.length, 0);
  assert.equal(state.status, 'pending');
  assert.equal(f.events.some((event) => event.type === 'error'), false);
  current.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await Promise.all([f.watcher.ready, update]);
  assert.equal(state.status, 'fulfilled');
  assert.equal(f.events.filter((event) => event.type === 'ready').length, 1);
  await f.watcher.update({ earlyPolicy: { allow: [broad, '**/database-game.exe'] } });
  assert.equal(f.observer.disposed, false);
});

test('startup revision: rapid replacement of an unselected native watcher waits for quiescence and arms only the latest policy', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] }, holdQuiescence: true });
  await f.start();
  const initial = f.launches[0];
  const state = trackInitialReadiness(f.watcher);
  const intermediate = f.watcher.update({ earlyPolicy: { allow: [broad, '**/intermediate.exe'] } });
  const latest = f.watcher.update({ earlyPolicy: { allow: [broad, '**/latest.exe'] } });
  initial.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await tick();
  assert.equal(initial.quiesceCalls, 1);
  assert.equal(state.status, 'pending');
  assert.equal(f.launches.length, 1, 'no replacement runs before checked quiescence');
  initial.quiesceGate.resolve(true);
  await tick();
  assert.equal(f.launches.length, 2);
  const current = f.launches[1];
  assert.deepEqual(Array.from(current.calls[0].processPolicy.allow), [broad.toLowerCase(), '**/latest.exe'].sort());
  assert.equal(f.events.some((event) => event.type === 'ready' || event.type === 'error'), false);
  current.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await Promise.all([f.watcher.ready, intermediate, latest]);
  assert.equal(f.events.filter((event) => event.type === 'armed').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'ready').length, 1);
});

test('startup revision: an armed callback replacing policy cannot publish obsolete controller readiness', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] } });
  await f.start();
  const state = trackInitialReadiness(f.watcher);
  let replacement;
  f.watcher.onEvent((event) => {
    if (event.type === 'armed' && !replacement) {
      replacement = f.watcher.update({ earlyPolicy: { allow: [broad, '**/database-game.exe'] } });
    }
  });
  f.launches[0].emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  await tick();
  assert.ok(replacement);
  assert.equal(state.status, 'pending', 'the readiness continuation must recheck policy after the armed callback');
  assert.equal(f.events.filter((event) => event.type === 'ready').length, 0);
  assert.equal(f.launches.length, 2);
  f.launches[1].emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await Promise.all([f.watcher.ready, replacement]);
  assert.equal(f.events.filter((event) => event.type === 'ready').length, 1);
  assert.equal(f.events.some((event) => event.type === 'error'), false);
});

test('startup revision: cancelling policy before initial preparation completes settles an empty current policy without failing the controller', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] }, holdPreparation: true });
  await f.start();
  const initial = f.prepared[0];
  const state = trackInitialReadiness(f.watcher);
  const cancellation = f.watcher.cancel();
  await tick();
  assert.equal(state.status, 'fulfilled');
  await Promise.all([f.watcher.ready, cancellation]);
  initial.prepareGate.reject(Error('obsolete cancelled preparation failed'));
  await tick();
  assert.equal(f.launches.length, 0);
  assert.equal(f.events.some((event) => event.type === 'error'), false);
  const replacement = f.watcher.update({ earlyPolicy: { allow: [broad] } });
  await tick();
  f.prepared[1].prepareGate.resolve();
  await tick();
  f.launches[0].emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await replacement;
  assert.equal(f.observer.disposed, false);
});

test('startup revision: a genuine current replacement preparation failure still rejects initial readiness', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] }, holdPreparation: true });
  await f.start();
  const state = trackInitialReadiness(f.watcher);
  const update = f.watcher.update({ earlyPolicy: { allow: [broad, '**/database-game.exe'] } });
  await tick();
  assert.equal(state.status, 'pending');
  assert.equal(f.prepared.length, 2);
  const failed = assert.rejects(f.watcher.ready, /current replacement preparation failed/);
  f.prepared[1].prepareGate.reject(Error('current replacement preparation failed'));
  await failed;
  await update.catch(() => undefined);
  assert.equal(f.events.some((event) => event.type === 'ready'), false);
  assert.equal(f.events.some((event) => event.type === 'error' && /current replacement preparation failed/.test(event.error.message)), true);
  assert.equal(f.observer.disposed, true);
});

test('startup revision: removing best effort does not wait for an obsolete spare preparation', async (t) => {
  const f = fixture(t, { acceptBestEffort: () => true, holdPreparation: true });
  await f.start();
  const spare = f.prepared[0];
  const state = trackInitialReadiness(f.watcher);
  const update = f.watcher.update({});
  await tick();
  assert.equal(spare.disposed, true);
  assert.equal(state.status, 'fulfilled', 'current empty policy must not wait for a disposed spare');
  await Promise.all([f.watcher.ready, update]);
  spare.prepareGate.reject(Error('obsolete spare preparation failed'));
  await tick();
  assert.equal(f.prepared.length, 1);
  assert.equal(f.launches.length, 0);
  assert.equal(f.events.filter((event) => event.type === 'ready').length, 1);
  assert.equal(f.events.some((event) => event.type === 'error'), false);
  assert.equal(f.observer.disposed, false);
});

test('startup revision: dispose interrupts a held current preparation and settles both startup and update without ready', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] }, holdPreparation: true });
  await f.start();
  const state = trackInitialReadiness(f.watcher);
  const update = f.watcher.update({ earlyPolicy: { allow: [broad, '**/database-game.exe'] } });
  const updateState = { status: 'pending' };
  update.then(
    () => { updateState.status = 'fulfilled'; },
    (error) => { updateState.status = 'rejected'; updateState.error = error; },
  );
  await tick();
  assert.equal(state.status, 'pending');
  assert.equal(f.prepared.length, 2);
  const rejected = assert.rejects(f.watcher.ready, /disposed|stopped/);
  f.watcher.dispose();
  await tick();
  assert.equal(state.status, 'rejected');
  assert.equal(updateState.status, 'rejected');
  assert.match(updateState.error.message, /disposed|stopped/);
  await Promise.all([rejected, update.catch(() => undefined)]);
  for (const launcher of f.prepared) assert.equal(launcher.disposed, true);
  assert.equal(f.observer.disposed, true);
  assert.equal(f.events.some((event) => event.type === 'ready'), false);
});

test('startup revision: uncertain native replacement rejects initial discovery readiness without failing the live controller', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] }, uncertainQuiescence: true });
  await f.start();
  const initial = f.launches[0];
  const rejected = assert.rejects(f.watcher.ready, /uncertain|blocked/i);
  const update = f.watcher.update({ earlyPolicy: { allow: [broad, '**/database-game.exe'] } });
  await Promise.all([rejected, update.catch(() => undefined)]);
  assert.equal(initial.quiesceCalls, 1);
  assert.equal(initial.disposed, undefined, 'an uncertain native watcher must stay reserved');
  assert.equal(f.launches.length, 1);
  assert.equal(f.observer.disposed, false, 'discovery blockage is not a controller-wide failure');
  assert.equal(f.events.some((event) => event.type === 'discovery-blocked'), true);
  assert.equal(f.events.some((event) => event.type === 'ready'), false);
  assert.equal(f.events.some((event) => event.type === 'error' && !event.selector && !event.target), false);
  await f.watcher.update({});
  assert.equal(initial.quiesceCalls, 1, 'blocked discovery never retries the uncertain stop');
});

test('startup revision: a nonempty additive update before the observer baseline arms only the current policy', async (t) => {
  const broad = 'C:/controlled/target/**';
  const f = fixture(t, { earlyPolicy: { allow: [broad] } });
  const state = trackInitialReadiness(f.watcher);
  await tick();
  assert.ok(f.observer);
  const update = f.watcher.update({
    earlyPolicy: { allow: [broad, '**/database-game.exe'] },
  });
  await tick();
  assert.equal(f.prepared.length, 0, 'no initial or replacement native work precedes the observer baseline');
  assert.equal(state.status, 'pending');
  f.observationReady.resolve();
  await tick();
  assert.equal(f.prepared.length, 1, 'the superseded initial policy must never arm');
  assert.equal(f.launches.length, 1);
  const current = f.launches[0];
  assert.deepEqual(Array.from(current.calls[0].processPolicy.allow), [broad.toLowerCase(), '**/database-game.exe'].sort());
  assert.equal(state.status, 'pending');
  assert.equal(f.events.some((event) => event.type === 'ready'), false);
  current.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '20' });
  await Promise.all([f.watcher.ready, update]);
  assert.equal(f.events.filter((event) => event.type === 'armed').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'ready').length, 1);
  assert.equal(f.events.some((event) => event.type === 'error'), false);
});

test('startup revision: blocked replacement preserves an already connected allowed target and its launcher', async (t) => {
  const broad = 'C:/controlled/target/**';
  const file = 'C:/controlled/target/game.exe';
  const f = fixture(t, {
    earlyPolicy: { allow: [broad] },
    acceptBestEffort: () => false,
    holdPreparation: true,
    uncertainQuiescence: true,
  });
  await f.start();
  const state = trackInitialReadiness(f.watcher);
  assert.equal(f.prepared.length, 2);
  const spare = f.prepared[0];
  const active = f.prepared[1];
  active.prepareGate.resolve();
  await tick();
  active.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  f.observer.onCreated(identity(42, '100', file));
  active.emit({ type: 'target-selected', pid: 42, creationTime100ns: '100', executablePath: file });
  connected(active, 42, file);
  await tick();
  assert.equal(f.prepared.length, 3);
  const successor = f.prepared[2];
  successor.prepareGate.resolve();
  await tick();
  successor.emit({ type: 'injector-watcher-ready', creationCutoff100ns: '10' });
  assert.equal(state.status, 'pending', 'the staged best-effort spare still holds initial readiness');
  assert.equal(f.watcher.targets[0].status, 'connected');
  const retainedSelector = active.calls[0];
  const rejected = assert.rejects(f.watcher.ready, /uncertain|blocked/i);
  const update = f.watcher.update({
    earlyPolicy: { allow: [broad, '**/database-game.exe'] },
  });
  await Promise.all([rejected, update.catch(() => undefined)]);
  assert.equal(spare.disposed, true);
  assert.equal(successor.quiesceCalls, 1);
  assert.equal(successor.disposed, undefined);
  assert.equal(active.disposed, undefined);
  assert.equal(active.calls.length, 1);
  assert.equal(active.calls[0], retainedSelector, 'the connected target keeps its existing launcher request');
  assert.equal(active.confirmed.length, 0);
  assert.equal(f.launches.length, 2, 'blocked replacement must not inject or arm another watcher');
  assert.equal(f.watcher.targets.length, 1);
  assert.equal(f.watcher.targets[0].cancelled, false);
  assert.equal(f.watcher.targets[0].status, 'connected');
  assert.equal(f.observer.disposed, false);
  assert.equal(f.events.some((event) => event.type === 'ready' || event.type === 'cancelled'), false);
  assert.equal(f.events.some((event) => event.type === 'discovery-blocked'), true);
  assert.equal(f.events.some((event) => event.type === 'error' && !event.selector && !event.target), false);
  f.handlers.get('targetTransportLost')({ pid: 42 });
  assert.equal(f.watcher.targets[0].status, 'transport-lost');
  f.handlers.get('targetConnected')({ pid: 42, executablePath: file });
  assert.equal(f.watcher.targets[0].status, 'connected', 'the retained route can still recover without reattachment');
  assert.equal(active.calls.length, 1);
  assert.equal(active.disposed, undefined);
});
