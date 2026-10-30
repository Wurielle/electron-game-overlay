'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/broker-recovery-diagnostic.cjs');
const diagnostic = require(script);
const capture = options => diagnostic.captureSnapshot({ queryIdentity() { throw Error('unit identity disabled; use an explicit private fixture'); }, ...options });
const sdkRoot = path.dirname(require.resolve('electron-game-overlay/package.json', { paths: [path.resolve(__dirname, '..')] }));
const protocol = require(path.join(sdkRoot, 'dist/lib/overlay-broker-protocol.js'));
const sdk = { protocol, version: require(path.join(sdkRoot, 'package.json')).version };
const identity = () => ({ pid: process.pid, creationTime100ns: '123456789', executablePath: 'C:\\private\\electron-game-overlay-broker.exe', sameUser: true });
async function fixture(t) {
 const p = await root(t); const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\ego-diag-${require('node:crypto').randomUUID()}` : path.join(p, 'socket');
 const { OverlayBrokerServer } = require(path.join(sdkRoot, 'dist/lib/overlay-broker-server.js'));
 const server = new OverlayBrokerServer({ pipePath, idleShutdownMs: false, targetTransportFactory() { throw Error('NO TARGET ACTIONS'); } });
 t.after(() => server.stop()); await server.start(); return { p, pipePath, server };
}
async function eventually(fn) { const end = Date.now() + 1500; while (!fn()) { if (Date.now() > end) assert.fail('condition deadline'); await new Promise(r => setTimeout(r, 10)); } }
test('actual SDK hello corroborates OS instance and leaves no transient client or target', { timeout: 4000 }, async t => {
 const { p, pipePath, server } = await fixture(t);
 const result = await capture({ claimRoot: p, pipePath, sdk, queryIdentity: identity });
 assert.equal(result.broker.status, 'ready'); assert.equal(result.broker.identityStatus, 'os-corroborated'); assert.equal(result.broker.pid, process.pid);
 assert.equal(result.broker.recognized, true); assert.equal(JSON.stringify(result).includes('private'), false);
 await eventually(() => server.clients.size === 0); assert.equal(server.targets.size, 0);
 const again = await capture({ claimRoot: p, pipePath, sdk, queryIdentity: identity }); assert.equal(again.broker.status, 'ready');
 await eventually(() => server.clients.size === 0);
});
test('restart, PID mismatch, wrong token, unknown image and raw failures never yield a ready PID', { timeout: 6000 }, async t => {
 const { p, pipePath } = await fixture(t);
 for (const change of [{ creationTime100ns: '999' }, { pid: 4 }, { executablePath: 'C:\\private\\node.exe' }, { sameUser: false }]) {
  let calls = 0;
  const result = await capture({ claimRoot: p, pipePath, sdk, queryIdentity: () => ++calls === 1 ? identity() : { ...identity(), ...change } });
  assert.notEqual(result.broker.status, 'ready'); assert.equal(result.broker.pid, null); assert.equal(JSON.stringify(result).includes('private'), false);
 }
 const result = await capture({ claimRoot: p, pipePath, sdk, queryIdentity() { throw Error('SECRET-OS-error'); } });
 assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
test('absent broker is unavailable and cannot invoke startup', async t => {
 const p = await root(t); let starts = 0;
 const result = await capture({ claimRoot: p, pipePath: path.join(p, 'absent'), sdk: { ...sdk, ensureBroker() { starts++; throw Error('NO'); } }, queryIdentity: identity });
 assert.equal(result.broker.status, 'unavailable'); assert.equal(starts, 0);
});
async function root(t) { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-diag-')); t.after(() => fs.rm(p, { recursive: true, force: true })); return p; }
const filename = pid => `electron-overlay-transport-v1.pid-${pid}.recovery.json`;
const claim = pid => ({ schemaVersion: 1, targetPid: pid, phase: 'published', leaseId: 'SECRET-lease', discoveryPath: '/SECRET/route', staticDiscoveryPath: '/SECRET/static', record: { pid: 90, token: 'SECRET-token', salt: 'SECRET-salt', port: 100 } });
test('claim-only unit capture forbids Windows identity helper and network without an explicit fixture override', async t => {
 const p = await root(t); const Module = require('node:module'); const originalLoad = Module._load; const originalConnect = net.Socket.prototype.connect;
 const platform = Object.getOwnPropertyDescriptor(process, 'platform'); let nativeCalls = 0; let networkCalls = 0;
 Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
 Module._load = function(request, ...args) {
  if (request.includes('windows-broker-identity')) return { queryWindowsBrokerIdentity() { nativeCalls++; return identity(); } };
  return originalLoad.call(this, request, ...args);
 };
 net.Socket.prototype.connect = function() { networkCalls++; throw Error('unit network forbidden'); };
 try {
  const result = await capture({ claimRoot: p, sdk: { ...sdk, protocol: { ...protocol, defaultOverlayBrokerPipePath: () => path.join(p, 'forbidden-default') } } });
  assert.equal(result.broker.status, 'unavailable'); assert.equal(nativeCalls, 0, 'claim-only unit capture must not call Windows identity'); assert.equal(networkCalls, 0);
 } finally { Object.defineProperty(process, 'platform', platform); Module._load = originalLoad; net.Socket.prototype.connect = originalConnect; }
});
test('observes bounded claim subset without exposing or modifying private bytes', async t => {
 const p = await root(t); const bytes = JSON.stringify(claim(42)); await fs.writeFile(path.join(p, filename(42)), bytes);
 const result = await capture({ claimRoot: p, targetPid: 42, pipePath: path.join(p, 'absent'), queryIdentity: async () => { throw Error('SECRET-error'); } });
 assert.equal(result.claims.records[0]?.status, 'observed');
 assert.equal(result.claims.records[0].targetPid, 42);
 assert.match(result.claims.records[0].leaseFingerprint, /^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(result).includes('SECRET'), false);
 assert.equal(await fs.readFile(path.join(p, filename(42)), 'utf8'), bytes);
 assert.equal(result.observationOnly, true); assert.equal(result.exclusiveUseVerified, false);
});
test('future, oversized, malformed and symlink claims remain byte-identical; enumeration capped', async t => {
 const p = await root(t);
 const cases = [[51, JSON.stringify({ ...claim(51), schemaVersion: 2 }), 'unsupported-schema'], [52, 'x'.repeat(65537), 'oversized'], [53, '{SECRET', 'invalid-json']];
 for (const [pid, bytes, status] of cases) { const f = path.join(p, filename(pid)); await fs.writeFile(f, bytes); const r = await capture({ claimRoot: p, targetPid: pid }); assert.equal(r.claims.records[0].status, status); assert.equal(await fs.readFile(f, 'utf8'), bytes); }
 const dest = path.join(p, 'source'); await fs.writeFile(dest, JSON.stringify(claim(54))); await fs.symlink(dest, path.join(p, filename(54)));
 assert.equal((await capture({ claimRoot: p, targetPid: 54 })).claims.records[0].status, 'not-regular'); assert.equal((await fs.lstat(path.join(p, filename(54)))).isSymbolicLink(), true);
 for (let pid = 100; pid < 170; pid++) await fs.writeFile(path.join(p, filename(pid)), JSON.stringify(claim(pid)));
 const r = await capture({ claimRoot: p }); assert.equal(r.claims.records.length, 64); assert.equal(r.claims.truncated, true);
});
test('canonical PID and bounded CLI arguments reject normalization and excessive duration', () => {
 for (const v of ['01', '+1', '1.0', ' 1', '0', '4294967296']) assert.throws(() => diagnostic.canonicalPid(v));
 assert.equal(diagnostic.canonicalPid('4294967295'), 4294967295);
 const parse = diagnostic.parseArgs;
 assert.throws(() => parse(['--samples', '181', '--output-dir', os.tmpdir()]));
 assert.throws(() => parse(['--samples', '180', '--interval-ms', '10000', '--output-dir', os.tmpdir()]));
 assert.throws(() => parse(['--output-dir', 'relative']));
 assert.equal(parse(['--output-dir', os.tmpdir()]).samples, 1);
});
test('bounded watch records instance and target anchor changes, saves failure default before capture, cleans SIGINT', async t => {
 const p = await root(t); const controller = new AbortController(); let count = 0; let seeded = false;
 const run = diagnostic.runObserver;
 const result = await run({ outputDir: p, samples: 2, intervalMs: 500 }, { signal: controller.signal, capture: async () => {
  const files = await fs.readdir(p); const seed = JSON.parse(await fs.readFile(path.join(p, files[0]), 'utf8')); seeded = seed.status === 'incomplete';
  count++; return { observationOnly: true, broker: { pid: 9, creationTime100ns: String(count) }, claims: { records: [{ targetPid: 42, status: 'observed', routeFingerprint: String(count), leaseFingerprint: 'x' }] } };
 }});
 assert.equal(seeded, true); assert.equal(result.samples.length, 2); assert.equal(result.samples[1].brokerInstanceChanged, true); assert.equal(result.samples[1].targetAnchorChanged, true);
 const failure = await run({ outputDir: p, samples: 1, intervalMs: 500 }, { capture: async () => { throw Error('SECRET-failure'); } }); assert.equal(failure.status, 'failed'); assert.equal(JSON.stringify(failure).includes('SECRET'), false);
 const before = process.listenerCount('SIGINT');
 const partial = await run({ outputDir: p, samples: 180, intervalMs: 500 }, { capture: async () => { process.emit('SIGINT'); return { broker: {}, claims: { records: [] } }; } });
 assert.equal(partial.status, 'interrupted'); assert.equal(process.listenerCount('SIGINT'), before); assert.equal(partial.samples.length, 0);
});
test('pending owned claim-directory read is abandoned on SIGINT or deadline without late report writes', { timeout: 7000 }, async t => {
 for (const mode of ['SIGINT', 'deadline']) await t.test(mode, async t => {
  const p = await root(t); const home = path.join(p, 'home'); const claimRoot = path.join(home, '.electron-game-overlay', 'broker-v1');
  await fs.mkdir(claimRoot, { recursive: true });
  const originalUserInfo = os.userInfo; const originalOpenDir = fs.opendir; const originalOpen = fs.open;
  const originalSetTimeout = global.setTimeout; const originalClearTimeout = global.clearTimeout;
  const controller = new AbortController(); const before = process.listenerCount('SIGINT');
  let release; let entered = false; let captureFinished = false; let closed = false; let writesAfterClose = 0; let durationTimer; let durationCleared = false;
  const pending = new Promise(resolve => { release = resolve; });
  os.userInfo = () => ({ homedir: home });
  fs.opendir = async function(dir, ...args) { if (dir === claimRoot) { entered = true; await pending; } return originalOpenDir.call(this, dir, ...args); };
  fs.open = async function(file, ...args) {
   const handle = await originalOpen.call(this, file, ...args);
   if (path.dirname(file) === path.join(p, 'reports')) {
    const write = handle.write.bind(handle); const close = handle.close.bind(handle);
    handle.write = (...args) => { if (closed) writesAfterClose++; return write(...args); };
    handle.close = async () => { await close(); closed = true; };
   }
   return handle;
  };
  global.setTimeout = (fn, ms, ...args) => { const timer = originalSetTimeout(fn, ms, ...args); if (ms === 2000) durationTimer = timer; return timer; };
  global.clearTimeout = timer => { if (timer === durationTimer) durationCleared = true; return originalClearTimeout(timer); };
  let running; let watchdog;
  try {
   running = diagnostic.runObserver({ outputDir: path.join(p, 'reports'), samples: 1, intervalMs: 500 }, { signal: controller.signal, capture: async options => {
    const snapshot = await diagnostic.captureSnapshot({ ...options, queryIdentity() { throw Error('unit identity disabled'); } });
    captureFinished = true; if (mode === 'deadline') throw Error('late capture rejection'); return snapshot;
   } });
   await eventually(() => entered);
   if (mode === 'SIGINT') process.emit('SIGINT');
   const report = await Promise.race([running, new Promise(resolve => { watchdog = originalSetTimeout(() => resolve(null), mode === 'SIGINT' ? 300 : 2600); })]);
   assert.notEqual(report, null, 'observer must settle before pending claim read is released');
   assert.equal(report.status, 'interrupted'); assert.equal(report.samples.length, 0); assert.equal(captureFinished, false);
   assert.equal(process.listenerCount('SIGINT'), before); assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
   assert.equal(closed, true); assert.equal(durationCleared, true);
   const files = await fs.readdir(path.join(p, 'reports')); const file = path.join(p, 'reports', files[0]); const bytes = await fs.readFile(file, 'utf8');
   assert.equal(JSON.parse(bytes).status, 'interrupted');
   release(); await eventually(() => captureFinished); await new Promise(resolve => originalSetTimeout(resolve, 20));
   assert.equal(await fs.readFile(file, 'utf8'), bytes); assert.equal(writesAfterClose, 0); assert.equal(report.samples.length, 0);
  } finally {
   originalClearTimeout(watchdog); release(); await running?.catch(() => {});
   os.userInfo = originalUserInfo; fs.opendir = originalOpenDir; fs.open = originalOpen; global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout;
  }
 });
});
test('SDK-relative lazy loading probes real server without importing Electron or bootstrap', async t => {
 const { p, pipePath, server } = await fixture(t); const Module = require('node:module'); const original = Module._load;
 Module._load = function(request, ...rest) { assert.ok(!/^(electron|electron-game-overlay)$/.test(request) && !/overlay-broker-(bootstrap|installation|entry)/.test(request), 'forbidden operational import'); return original.call(this, request, ...rest); };
 try { const r = await capture({ pipePath, claimRoot: p, queryIdentity: identity }); assert.equal(r.broker.status, 'ready'); } finally { Module._load = original; }
 await eventually(() => server.clients.size === 0);
 const unknown = await capture({ pipePath, claimRoot: p, sdk, queryIdentity: () => ({ ...identity(), executablePath: 'C:\\private\\node.exe' }) });
 assert.equal(unknown.broker.recognized, false); assert.equal(unknown.broker.pid, null); assert.equal(unknown.broker.status, 'unrecognized-server-image');
});
test('report budget discards over-budget sample and preserves bounded private failure-default report', async t => {
 const p = await root(t);
 const r = await diagnostic.runObserver({ outputDir: p, samples: 1, intervalMs: 500 }, { capture: async () => ({ padding: 'SECRET'.repeat(800000) }) });
 assert.equal(r.status, 'budget-exhausted'); assert.equal(r.samples.length, 0);
 const files = await fs.readdir(p); const bytes = await fs.readFile(path.join(p, files[0])); assert.ok(bytes.length <= 4194304); assert.equal(bytes.includes('SECRET'), false);
});
test('help is side-effect-free and protected ownership output directories are rejected', () => {
 const smoke = `const Module=require('node:module'),fs=require('node:fs'),os=require('node:os');const original=Module._load;Module._load=function(n,...a){if(n==='node:net'||n==='electron-game-overlay'||n.includes('windows-broker-identity')||n.includes('overlay-broker-protocol'))throw Error('forbidden probe import');return original.call(this,n,...a)};os.userInfo=()=>{throw Error('account probe forbidden')};for(const n of ['open','openSync','mkdir','mkdirSync','writeFile','writeFileSync'])fs[n]=()=>{throw Error('write forbidden')};for(const n of ['open','mkdir','writeFile'])fs.promises[n]=async()=>{throw Error('write forbidden')};process.argv=[process.execPath,${JSON.stringify(script)},'--help'];Module.runMain();`;
 const result = require('node:child_process').spawnSync(process.execPath, ['-e', smoke], { encoding: 'utf8', timeout: 2000 });
 assert.equal(result.status, 0); assert.match(result.stdout, /Usage:/); assert.match(result.stdout, /idle shutdown/);
 assert.throws(() => diagnostic.parseArgs(['--output-dir', path.join(os.userInfo().homedir, '.electron-game-overlay', 'broker-v1', 'cache')]));
});
test('output symlink alias into protected ownership tree is refused without report writes', async t => {
 const p = await root(t); const home = path.join(p, 'home'); const protectedDir = path.join(home, '.electron-game-overlay', 'broker-v1', 'cache'); await fs.mkdir(protectedDir, { recursive: true });
 const alias = path.join(p, 'alias'); await fs.symlink(protectedDir, alias, 'junction');
 const original = os.userInfo; os.userInfo = () => ({ homedir: home });
 try { await assert.rejects(diagnostic.runObserver({ outputDir: alias, samples: 1, intervalMs: 500 }), /unsafe-output/); } finally { os.userInfo = original; }
 assert.deepEqual(await fs.readdir(protectedDir), []);
});
test('watch detects replacement and route changes across unavailable observations', async t => {
 const p = await root(t); let count = 0;
 const report = await diagnostic.runObserver({ outputDir: p, samples: 3, intervalMs: 500 }, { capture: async () => {
  count++;
  return count === 2 ? { broker: { pid: null }, claims: { records: [] } } : { broker: { pid: 8, creationTime100ns: String(count) }, claims: { records: [{ targetPid: 42, status: 'observed', routeFingerprint: String(count), leaseFingerprint: 'x' }] } };
 }});
 assert.equal(report.samples[2].brokerInstanceChanged, true); assert.equal(report.samples[2].targetAnchorChanged, true);
});
test('real socket malformed, oversized and stalled welcome probes close only their own connection', { timeout: 5000 }, async t => {
 const p = await root(t); const sockets = new Set(); let reply;
 const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\ego-diag-${require('node:crypto').randomUUID()}` : path.join(p, 'socket');
 const server = net.createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); s.on('data', () => { if (reply) s.write(reply); }); });
 t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
 const good = { type: 'broker.welcome', protocolVersion: 1, capabilities: protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES, sessionId: 'SECRET-session', brokerPid: process.pid };
 for (const value of [{ ...good, protocolVersion: 2 }, { ...good, brokerPid: 0 }, { ...good, capabilities: [] }, { ...good, sessionId: 7 }, { type: 'broker.error', message: 'SECRET-error' }]) {
  reply = protocol.encodeBrokerJsonPacket(value);
  const r = await capture({ pipePath, claimRoot: p, sdk, queryIdentity: identity }); assert.notEqual(r.broker.status, 'ready'); assert.equal(JSON.stringify(r).includes('SECRET'), false); await eventually(() => sockets.size === 0);
 }
 reply = Buffer.alloc(5); reply.writeUInt32LE(16385); reply[4] = 1;
 assert.equal((await capture({ pipePath, claimRoot: p, sdk, queryIdentity: identity })).broker.status, 'unavailable');
 reply = null; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30);
 try { const r = await capture({ pipePath, claimRoot: p, sdk, queryIdentity: identity, signal: controller.signal }); assert.equal(r.broker.status, 'unavailable'); } finally { clearTimeout(timer); }
 await eventually(() => sockets.size === 0); assert.equal(server.listening, true);
 const r = await capture({ pipePath, claimRoot: p, sdk, queryIdentity: identity }); assert.equal(r.broker.status, 'unavailable'); await eventually(() => sockets.size === 0);
});
test('actual Node CLI saves partial SIGINT report and fresh reports without leaking output paths', { timeout: 5000, skip: process.platform === 'win32' ? 'POSIX process signal fixture; Windows console Ctrl+C acceptance is separate' : false }, async t => {
 const p = await root(t); const child = spawn(process.execPath, [script, '--output-dir', p, '--samples', '180', '--interval-ms', '500'], { stdio: ['ignore', 'pipe', 'pipe'] });
 const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
 const boundedExit = async () => { let timer; try { return await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture-exit-deadline')), 1500); })]); } finally { clearTimeout(timer); } };
 t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await boundedExit(); }); let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
 let files; let seed; const until = Date.now() + 1500;
 while (Date.now() < until) { files = await fs.readdir(p); try { if (files.length) seed = JSON.parse(await fs.readFile(path.join(p, files[0]), 'utf8')); } catch {} if (seed?.samples.length) break; await new Promise(r => setTimeout(r, 10)); }
 assert.equal(files.length, 1); const f = path.join(p, files[0]); assert.ok(seed?.samples.length > 0);
 child.kill('SIGINT'); const outcome = await boundedExit(); assert.equal(outcome.code, 0);
 const report = JSON.parse(await fs.readFile(f, 'utf8')); assert.equal(report.status, 'interrupted'); assert.equal(report.observationOnly, true); assert.equal(JSON.stringify(report).includes('safeToKill'), false); assert.equal(output.includes(p), false); assert.ok((await fs.stat(f)).size <= 4 * 1024 * 1024);
});
