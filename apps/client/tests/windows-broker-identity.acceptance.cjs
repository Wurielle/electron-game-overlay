'use strict';
if (process.argv[2] === '--owned-fixture') {
  const net = require('node:net');
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.on('data', data => { if (data.toString() === 'ping') socket.end('pong'); }); });
  const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(1)); }, 15000);
  process.on('message', message => { if (message === 'stop') { clearTimeout(deadline); for (const socket of sockets) socket.destroy(); server.close(() => { process.disconnect(); }); } });
  server.on('error', () => process.exit(1));
  server.listen(process.env.EGO_IDENTITY_OWNED_PIPE, () => process.send({ pid: process.pid }));
} else {
// Run explicitly with EGO_WINDOWS_IDENTITY_ACCEPTANCE=1 and a private Node executable.
// Failure-default evidence is written before producer/Koffi/fixture imports.
const fs = require('node:fs');
const reportFile = process.env.EGO_WINDOWS_IDENTITY_REPORT || require('node:path').join(__dirname, 'windows-broker-identity.acceptance-result.json');
const report = { status: 'failed', stage: 'setup', platform: process.platform, windowsExecuted: false };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
save();
(async () => {
  if (process.env.EGO_WINDOWS_IDENTITY_ACCEPTANCE !== '1') throw Error('opt-in-required');
  if (process.platform !== 'win32') throw Error('windows-required');
  const assert = require('node:assert/strict');
  const net = require('node:net');
  const { fork } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const identityModule = process.env.EGO_WINDOWS_IDENTITY_MODULE || require('node:path').resolve(__dirname, '../scripts/windows-broker-identity.cjs');
  const { queryWindowsBrokerIdentity } = require(identityModule);
  // Resolve native dependencies from the selected shipped helper, never the checkout.
  const identityRequire = require('node:module').createRequire(identityModule);
  const pipe = `\\\\.\\pipe\\ego-owned-identity-${randomUUID()}`;
  let child, socket;
  const bounded = (promise, ms = 5000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture-deadline')), ms); })]).finally(() => clearTimeout(timer)); };
  try {
    const env = { ...process.env, EGO_IDENTITY_OWNED_PIPE: pipe };
    for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NODE_TEST_CONTEXT)$/i.test(key)) delete env[key];
    // Only the retained owned child can be shut down. Never discover/kill another process.
    child = fork(__filename, ['--owned-fixture'], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const ready = await bounded(new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(Error('fixture-exited-before-ready'))); }));
    assert.equal(ready.pid, child.pid);
    report.stage = 'os-query'; save();
    const identity = queryWindowsBrokerIdentity(pipe, { koffi: identityRequire('koffi') });
    report.windowsExecuted = true;
    assert.equal(identity.pid, child.pid);
    assert.match(identity.creationTime100ns, /^[1-9][0-9]+$/);
    assert.ok(BigInt(identity.creationTime100ns) > 0n);
    assert.equal(identity.executablePath.toLowerCase(), fs.realpathSync.native(process.execPath).toLowerCase());
    assert.equal(identity.sameUser, true);
    report.stage = 'service-continuity'; save();
    socket = net.connect(pipe);
    const reply = await bounded(new Promise((resolve, reject) => { socket.once('connect', () => socket.write('ping')); socket.once('data', b => resolve(b.toString())); socket.once('error', reject); }));
    assert.equal(reply, 'pong');
    socket.destroy(); socket = null;
    child.send('stop');
    await bounded(exited);
    assert.equal(child.exitCode, 0);
    report.status = 'passed'; report.stage = 'complete'; report.assertions = ['kernel-pid-owned-child', 'real-creation-time', 'real-image', 'current-token-user', 'probe-close-service-continuity', 'owned-fixture-clean-exit'];
  } finally {
    socket?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      // Bounded teardown solely through this fixture ChildProcess, never a numeric discovered PID.
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await bounded(exited, 3000);
    }
  }
})().catch(error => { report.status = 'failed'; report.error = ['opt-in-required', 'windows-required', 'fixture-deadline'].includes(error.message) ? error.message : 'acceptance-failed'; process.exitCode = 1; }).finally(save);
}
