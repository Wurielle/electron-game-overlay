'use strict';

// Standalone, opt-in feasibility experiment; never imported by production code.
const fs = require('node:fs');
const reportArg = process.argv.indexOf('--report');
const reportFile = reportArg >= 0 ? process.argv[reportArg + 1] : `${__filename}.report.json`;
const report = {
  schemaVersion: 1, kind: 'private-windows-pipe-acl-feasibility',
  platform: process.platform, node: process.versions.node, uv: process.versions.uv,
  status: 'failed', stage: 'setup', nativeExecuted: false, observations: [],
  requestedRights: 'READ_CONTROL|WRITE_DAC (0x00060000)',
  exclusions: ['atomic secure creation', 'actual accepted-peer PID authentication',
    'cross-user denial', 'ordinary medium-token acceptance', 'production broker acceptance'],
  tokenScope: 'actual existing host token only; no token creation, filtering or impersonation',
};
function save() { fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`); }
// Invalidate stale success before native setup or fallible harness imports.
save();

async function main() {
  if (process.platform !== 'win32') throw new Error('windows-required-native-refused');
  if (!process.argv.includes('--run-native')) throw new Error('explicit-native-opt-in-required');
  if (process.versions.node !== '26.12.1' || process.versions.uv !== '1.52.1') {
    throw new Error('exact-node-and-libuv-required');
  }
  const path = require('node:path');
  const os = require('node:os');
  const net = require('node:net');
  const crypto = require('node:crypto');
  const { spawn } = require('node:child_process');
  const compiler = process.env.EGO_PIPE_ACL_CL;
  if (!compiler || !path.isAbsolute(compiler) || path.basename(compiler).toLowerCase() !== 'cl.exe') {
    throw new Error('absolute-msvc-cl-required');
  }
  const source = path.resolve(__dirname, '../../electron-game-overlay-runtime/NativeRuntime/tests/pipe-acl-feasibility.cpp');
  const children = new Set();
  const sockets = new Set();
  const servers = new Set();
  const cleanupErrors = [];
  let root;
  const end = Date.now() + 150000;
  let cleaning = false;
  const budget = (ms) => cleaning ? ms : Math.max(1, Math.min(ms, end - Date.now()));
  async function bounded(promise, ms, stage) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(stage)), budget(ms));
    })]); } finally { clearTimeout(timer); }
  }
  async function run(exe, args, native, ms) {
    if (Date.now() >= end) throw new Error('total-deadline');
    const child = spawn(exe, args, { cwd: root, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let bytes = 0;
    let text = '';
    let fault;
    const closed = new Promise((resolve) => {
      child.once('error', () => { fault = new Error('child-spawn-failed'); });
      child.once('spawn', () => { if (native) { report.nativeExecuted = true; save(); } });
      child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
      bytes += data.length;
      if (bytes > 32768) { fault = new Error('child-output-limit'); child.kill(); }
      else text += data.toString('utf8');
    });
    let result;
    try { result = await bounded(closed, ms, 'child-timeout'); }
    catch (error) { child.kill(); await bounded(closed, 2000, 'child-reap-timeout'); throw error; }
    if (fault) throw fault;
    if (!native) {
      if (result.code !== 0) throw new Error('fixture-build-failed');
      return;
    }
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('helper-output-invalid'); }
    if (value.schemaVersion !== 1 || value.nativeExecuted !== true) throw new Error('helper-envelope-invalid');
    report.observations.push(value); save();
    if (result.code !== 0 || value.status !== 'passed') throw new Error(`helper-${value.stage || 'failed'}`);
    return value;
  }
  async function connect(name) {
    const socket = net.createConnection(name); sockets.add(socket);
    socket.on('error', () => {});
    await bounded(new Promise((resolve, reject) => {
      socket.once('connect', resolve); socket.once('error', reject);
    }), 2000, 'connect-timeout');
    return socket;
  }
  async function echo(socket, payload) {
    await bounded(new Promise((resolve, reject) => {
      let received = '';
      const clean = () => { socket.off('data', data); socket.off('error', error); socket.off('close', close); };
      const error = () => { clean(); reject(new Error('echo-socket-error')); };
      const close = () => { clean(); reject(new Error('echo-closed')); };
      const data = (chunk) => {
        received += chunk.toString('utf8');
        if (received === payload) { clean(); resolve(); }
        else if (received.length >= payload.length) { clean(); reject(new Error('echo-mismatch')); }
      };
      socket.on('data', data); socket.once('error', error); socket.once('close', close);
      socket.write(payload);
    }), 2000, 'echo-timeout');
  }
  async function dropSockets() {
    const waits = [...sockets].map((socket) => new Promise((resolve) => {
      if (socket.closed) return resolve();
      socket.once('close', resolve); socket.destroy();
    }));
    await bounded(Promise.all(waits), 2000, 'socket-cleanup-timeout'); sockets.clear();
  }
  async function closeServer(server) {
    await bounded(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      2000, 'server-cleanup-timeout'); servers.delete(server);
  }
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-pipe-acl-'));
    report.stage = 'build'; save();
    const helper = path.join(root, 'pipe-acl-feasibility.exe');
    await run(compiler, ['/nologo', '/std:c++17', '/EHsc', '/W4', '/DUNICODE', '/D_UNICODE',
      source, `/Fe:${helper}`, `/Fo:${path.join(root, 'fixture.obj')}`, '/link', 'Advapi32.lib'], false, 30000);
    report.stage = 'identity'; save();
    const identity = await run(helper, ['identity', String(process.pid)], true, 3000);
    if (!/^[1-9][0-9]{0,19}$/.test(identity.creationTime) || identity.serverPid !== process.pid) {
      throw new Error('identity-invalid');
    }
    report.actualHostToken = identity.hostToken;
    report.ordinaryMediumTokenAcceptance = 'pending; observed host facts do not establish supported desktop-token scope';
    const name = `\\\\.\\pipe\\ego-acl-fixture-${process.pid}-${crypto.randomUUID()}`;
    const probe = (mode) => run(helper, [mode, String(process.pid), identity.creationTime, name], true, 3000);
    for (let generation = 0; generation < 2; generation++) {
      report.stage = `listener-${generation}`; save();
      const server = net.createServer((socket) => {
        sockets.add(socket); socket.on('error', () => {});
        socket.on('data', (data) => socket.write(data));
      });
      servers.add(server);
      server.on('error', () => {});
      await bounded(new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(name, resolve);
      }), 2000, 'listen-timeout');
      // Baseline observes the fresh/recreated default ACL; it does not assert a broad default.
      await probe('inspect');
      const gap = await connect(name);
      await echo(gap, `before-${generation}`);
      await probe('apply'); // Child has closed its own handle before resolving.
      await echo(gap, `after-${generation}`);
      report.observations.push({ phase: 'preconnected-gap', generation,
        retainedOwnSocketDuplexAfterNarrowing: true,
        meaning: 'existing same-user handle survived; no cross-user or revocation claim' });
      for (let round = 0; round < 2; round++) {
        const held = await Promise.all(Array.from({ length: 6 }, () => connect(name)));
        await Promise.all(held.map((socket, i) => echo(socket, `duplex-${generation}-${round}-${i}`)));
        for (let i = 0; i < 6; i++) await probe('verify');
        report.observations.push({ phase: 'multiple-and-replenished', generation, round,
          simultaneousNodeClients: held.length, independentAclReadbacks: 6 });
        await dropSockets();
        await probe('verify'); // Zero Node clients, helper reopen, same object/name.
      }
      await dropSockets();
      await closeServer(server);
    }
    report.stage = 'assertions-complete';
    report.status = 'passed';
    report.conclusion = 'Private client-handle DACL feasibility only; excluded security guarantees remain pending';
  } finally {
    cleaning = true;
    // Each cleanup is attempted independently, including failed setup and partial allocation.
    const cleanupEnd = Date.now() + 8000;
    for (const child of children) {
      try { child.kill(); await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cleanup-child-timeout')), 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      }); } catch { cleanupErrors.push('child-cleanup'); }
    }
    endCleanup: for (const socket of sockets) { socket.destroy(); if (Date.now() > cleanupEnd) break endCleanup; }
    for (const server of servers) {
      try { await closeServer(server); } catch { cleanupErrors.push('server-cleanup'); }
    }
    if (root) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { cleanupErrors.push('root-cleanup'); } }
    report.cleanup = cleanupErrors.length ? { status: 'failed', errors: cleanupErrors } : { status: 'completed' };
    if (cleanupErrors.length) { report.status = 'failed'; throw new Error('cleanup-failed'); }
    save();
  }
}
main().catch((error) => {
  report.status = 'failed';
  // Do not leak pipe paths, account SIDs or compiler diagnostics into evidence.
  report.error = /^[a-z0-9-]+$/.test(error.message) ? error.message : 'fixture-operation-failed';
  save(); process.exitCode = 1;
});
