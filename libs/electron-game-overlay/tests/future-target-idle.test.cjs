const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');
const filename = path.resolve(__dirname, '../dist/lib/reshade-launcher.js');
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  const timers = new Map(),
    module = { exports: {} };
  runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      require: createRequire(filename),
      setTimeout(callback, ms) {
        const timer = {};
        timers.set(timer, { callback, ms });
        return timer;
      },
      clearTimeout(timer) {
        timers.delete(timer);
      },
      AbortController,
      Buffer,
      process,
      console,
    },
    { filename },
  );
  const session = new EventEmitter();
  session.whenReady = async () => {};
  session.on = (event, handler) => {
    EventEmitter.prototype.on.call(session, event, handler);
    return () => session.removeListener(event, handler);
  };
  session.onClose = (handler) => session.on('close', handler);
  session.authorizeGlobalTarget = async () => () => {};
  const launcher = new module.exports.ReShadeOverlayLauncher({});
  let select;
  launcher.performLaunch = () =>
    new Promise((resolve) => {
      select = resolve;
    });
  return { launcher, session, timers, select: (result) => select(result) };
}
for (const target of [
  { processName: 'fast.exe' },
  { processName: 'fast.exe', executablePath: 'C:\\Games\\fast.exe' },
  { pathContains: '\\Games\\' },
]) {
  test(`future target has no idle authentication deadline: ${JSON.stringify(target)}`, async () => {
    const f = fixture();
    let settled = false;
    const attachment = f.launcher.attach(f.session, target).then((value) => {
      settled = true;
      return value;
    });
    await drain();
    assert.equal(
      f.timers.size,
      0,
      'idle watcher must stay armed beyond 130 seconds',
    );
    f.select({
      injectorTargetPid: 42,
      targetExecutablePath: 'C:\\Games\\fast.exe',
    });
    await drain();
    assert.ok(
      [...f.timers.values()].some(
        (timer) => timer.ms === ('pathContains' in target ? 10000 : 120000),
      ),
    );
    f.session.emit('targetConnected', {
      pid: 43,
      executablePath: 'C:\\Games\\fast.exe',
    });
    await drain();
    assert.equal(settled, false);
    f.session.emit('targetConnected', {
      pid: 42,
      executablePath: 'C:\\Games\\fast.exe',
    });
    assert.equal((await attachment).pid, 42);
    assert.equal(f.timers.size, 0);
    f.launcher.dispose();
  });
}
test('exact PID has an immediate proof deadline and disposal removes it', async () => {
  const f = fixture();
  const attachment = f.launcher.attach(f.session, {
    processName: 'fast.exe',
    pid: 42,
  });
  const outcome = assert.rejects(attachment);
  await drain();
  assert.ok([...f.timers.values()].some((timer) => timer.ms === 120000));
  f.launcher.dispose();
  f.select({ injectorTargetPid: 42 });
  await outcome;
  assert.equal(f.timers.size, 0);
});
