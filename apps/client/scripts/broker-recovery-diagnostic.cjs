'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const MAX_CLAIM_BYTES = 64 * 1024;
const positivePid = n => Number.isInteger(n) && n > 0 && n <= 0xffffffff;
const hash = value => createHash('sha256').update(value).digest('hex');
const filename = pid => `electron-overlay-transport-v1.pid-${pid}.recovery.json`;
const safety = () => ({ observationOnly: true, exclusiveUseVerified: false, injectionCountVerified: false, nativeRecoveryVerified: false });
function canonicalPid(value) {
 if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !positivePid(Number(value))) throw Error('invalid-target-pid');
 return Number(value);
}
async function readClaim(root, targetPid) {
 const out = { targetPid, status: 'unavailable' }; let handle;
 try {
  const file = path.join(root, filename(targetPid));
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) return { ...out, status: 'not-regular' };
  if (before.size > MAX_CLAIM_BYTES) return { ...out, status: 'oversized' };
  handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const opened = await handle.stat();
  if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) return out;
  const buffer = Buffer.alloc(MAX_CLAIM_BYTES + 1); let size = 0;
  while (size < buffer.length) { const r = await handle.read(buffer, size, buffer.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
  if (size > MAX_CLAIM_BYTES) return { ...out, status: 'oversized' };
  const after = await handle.stat(); const current = await fs.lstat(file);
  if (after.size !== size || after.mtimeMs !== opened.mtimeMs || current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== after.mtimeMs) return out;
  let value; try { value = JSON.parse(buffer.toString('utf8', 0, size)); } catch { return { ...out, status: 'invalid-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...out, status: 'invalid-schema' };
  if (value.schemaVersion !== 1) return { ...out, status: 'unsupported-schema' };
  // Observation subset only: never interpret credentials or follow route paths.
  if (value.targetPid !== targetPid || !['intent', 'publishing', 'published'].includes(value.phase) || !['discoveryPath', 'staticDiscoveryPath', 'leaseId'].every(k => typeof value[k] === 'string')) return { ...out, status: 'invalid-schema' };
  return { targetPid, status: 'observed', phase: value.phase, leaseFingerprint: hash(value.leaseId), routeFingerprint: hash(JSON.stringify([value.discoveryPath, value.staticDiscoveryPath])), claimReportedBrokerPid: positivePid(value.record?.pid) ? value.record.pid : null, claimReportedBrokerPidVerified: false };
 } catch { return out; } finally { await handle?.close().catch(() => {}); }
}
async function observeClaims(root, targetPid) {
 if (targetPid !== undefined) return { status: 'scoped', truncated: false, records: [await readClaim(root, targetPid)] };
 const result = { status: 'available', truncated: false, records: [] }; let dir; let scanned = 0;
 try {
  dir = await fs.opendir(root);
  for await (const entry of dir) {
   if (++scanned > 256) { result.truncated = true; break; }
   const match = /^electron-overlay-transport-v1\.pid-([1-9][0-9]*)\.recovery\.json$/.exec(entry.name);
   if (!match || !positivePid(Number(match[1]))) continue;
   if (result.records.length === 64) { result.truncated = true; break; }
   result.records.push(await readClaim(root, Number(match[1])));
  }
 } catch { result.status = 'unavailable'; } finally { await dir?.close().catch(() => {}); }
 return result;
}
function loadSdk() {
 const metadata = require.resolve('electron-game-overlay/package.json', { paths: [path.resolve(__dirname, '..')] });
 return { version: require(metadata).version, protocol: require(path.join(path.dirname(metadata), 'dist/lib/overlay-broker-protocol.js')) };
}
function hello(pipePath, sdk, signal) {
 return new Promise(resolve => {
  const socket = new (require('node:net').Socket)();
  const decoder = new sdk.protocol.BrokerPacketDecoder(); let bytes = 0; let prefix = Buffer.alloc(0); let done = false;
  const finish = value => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); resolve(value); };
  const abort = () => finish(null);
  const timer = setTimeout(abort, 2000);
  signal?.addEventListener('abort', abort, { once: true });
  socket.on('error', abort); socket.on('close', abort);
  socket.on('data', chunk => {
   try {
    bytes += chunk.length; if (bytes > 65536) return finish(null);
    // Admit only a single bounded JSON welcome before using the SDK decoder.
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix.length < 5) return;
    if (prefix.readUInt8(4) !== 1 || prefix.readUInt32LE(0) > 16384) return finish(null);
    if (prefix.length < 5 + prefix.readUInt32LE(0)) return;
    const packets = decoder.push(prefix.subarray(0, 5 + prefix.readUInt32LE(0)));
    const v = packets[0]?.value;
    finish(v?.type === 'broker.welcome' && v.protocolVersion === 1 && positivePid(v.brokerPid) && typeof v.sessionId === 'string' && v.sessionId.length > 0 && Array.isArray(v.capabilities) && sdk.protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES.every(c => v.capabilities.includes(c)) ? { pid: v.brokerPid } : null);
   } catch { finish(null); }
  });
  if (signal?.aborted) return abort();
  try { socket.connect(pipePath, () => {
   try { socket.write(sdk.protocol.encodeBrokerJsonPacket({ type: 'broker.hello', clientPid: process.pid, sdkVersion: sdk.version, protocolMin: 1, protocolMax: 1, requiredCapabilities: sdk.protocol.OVERLAY_BROKER_REQUIRED_CAPABILITIES })); } catch { abort(); }
  }); } catch { abort(); }
 });
}
async function observeBroker(options) {
 const result = { status: 'unavailable', identityStatus: 'unavailable', pid: null, creationTime100ns: null, executableName: null, sameUser: false, recognized: false };
 try {
  const sdk = options.sdk ?? loadSdk();
  const pipePath = options.pipePath ?? sdk.protocol.defaultOverlayBrokerPipePath();
  let query = options.queryIdentity;
  if (!query) {
   if (process.platform !== 'win32') return result;
   query = require('./windows-broker-identity.cjs').queryWindowsBrokerIdentity;
  }
  const before = await query(pipePath);
  if (options.signal?.aborted) return result;
  const welcome = await hello(pipePath, sdk, options.signal);
  if (!welcome) return result;
  const after = await query(pipePath);
  if (!before || !after || before.pid !== welcome.pid || after.pid !== welcome.pid || typeof before.creationTime100ns !== 'string' || !/^[1-9][0-9]*$/.test(before.creationTime100ns) || before.creationTime100ns !== after.creationTime100ns || typeof before.executablePath !== 'string' || before.executablePath !== after.executablePath || before.sameUser !== true || after.sameUser !== true) return { ...result, status: 'identity-mismatch' };
  const recognized = path.win32.basename(after.executablePath) === 'electron-game-overlay-broker.exe';
  if (!recognized) return { ...result, status: 'unrecognized-server-image', sameUser: true };
  return { ...result, status: 'ready', identityStatus: 'os-corroborated', pid: after.pid, creationTime100ns: after.creationTime100ns, executableName: 'electron-game-overlay-broker.exe', sameUser: true, recognized: true };
 } catch { return result; }
}
async function captureSnapshot(options = {}) {
 if (options.targetPid !== undefined && !positivePid(options.targetPid)) throw Error('invalid-target-pid');
 const claimRoot = options.claimRoot ?? path.join(os.userInfo().homedir, '.electron-game-overlay', 'broker-v1');
 const broker = await observeBroker(options);
 return { ...safety(), observationEffects, broker, claims: await observeClaims(claimRoot, options.targetPid) };
}
const observationEffects = 'Each hello creates a transient broker client and can delay idle shutdown (including the 30-second idle retirement); this is not a zero-effects probe.';
function protectedRoot() { return path.join(os.userInfo().homedir, '.electron-game-overlay'); }
function within(root, candidate) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
async function canonicalCandidate(candidate) {
 let current = path.resolve(candidate); const tail = [];
 for (let i = 0; i < 256; i++) {
  try { return path.join(await fs.realpath(current), ...tail.reverse()); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('unsafe-output'); const parent = path.dirname(current); if (parent === current) throw Error('unsafe-output'); tail.push(path.basename(current)); current = parent; }
 }
 throw Error('unsafe-output');
}
function validateOptions(options) {
 if (typeof options.outputDir !== 'string' || !path.isAbsolute(options.outputDir) || !Number.isInteger(options.samples) || options.samples < 1 || options.samples > 180 || !Number.isInteger(options.intervalMs) || options.intervalMs < 500 || options.intervalMs > 10000 || options.samples * options.intervalMs > 600000) throw Error('invalid-arguments');
 if (options.targetPid !== undefined && !positivePid(options.targetPid)) throw Error('invalid-target-pid');
 if (within(protectedRoot(), options.outputDir)) throw Error('unsafe-output');
 return options;
}
function parseArgs(argv) {
 if (argv.length === 1 && argv[0] === '--help') return { help: true };
 const options = { samples: 1, intervalMs: 2000 }; const seen = new Set();
 for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i]; const value = argv[i + 1];
  if (seen.has(flag) || value === undefined) throw Error('invalid-arguments'); seen.add(flag);
  if (flag === '--output-dir') options.outputDir = value;
  else if (flag === '--target-pid') options.targetPid = canonicalPid(value);
  else if (flag === '--samples' || flag === '--interval-ms') { if (!/^[1-9][0-9]*$/.test(value)) throw Error('invalid-arguments'); options[flag === '--samples' ? 'samples' : 'intervalMs'] = Number(value); }
  else throw Error('invalid-arguments');
 }
 return validateOptions(options);
}
function wait(ms, signal) {
 return new Promise(resolve => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
 });
}
function untilAborted(pending, signal) {
 return new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener('abort', abort); resolve(); };
  signal.addEventListener('abort', abort, { once: true });
  // Observe both late outcomes even after cancellation has settled this caller.
  Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  if (signal.aborted) abort();
 });
}
async function runObserver(options, boundaries = {}) {
 validateOptions(options);
 if (within(await canonicalCandidate(protectedRoot()), await canonicalCandidate(options.outputDir))) throw Error('unsafe-output');
 await fs.mkdir(options.outputDir, { recursive: true });
 const file = path.join(options.outputDir, `broker-recovery-${require('node:crypto').randomUUID()}.json`);
 const handle = await fs.open(file, 'wx', 0o600);
 const report = { schemaVersion: 1, ...safety(), observationEffects, status: 'incomplete', samples: [] };
 const save = async () => { const bytes = Buffer.from(JSON.stringify(report, null, 2)); if (bytes.length > 4 * 1024 * 1024) throw Error('report-budget'); await handle.write(bytes, 0, bytes.length, 0); await handle.truncate(bytes.length); await handle.sync(); };
 const controller = new AbortController(); const abort = () => controller.abort();
 let deadline;
 try {
  await save(); // Durable failure default precedes SDK/FFI loading or observation.
  process.on('SIGINT', abort); boundaries.signal?.addEventListener('abort', abort, { once: true }); if (boundaries.signal?.aborted) abort();
  const started = Date.now(); deadline = setTimeout(abort, Math.min(600000, Math.max(2000, options.samples * options.intervalMs)));
  let previousInstance = null; const oldAnchors = new Map();
  for (let i = 0; i < options.samples && !controller.signal.aborted; i++) {
   const snapshot = await untilAborted((boundaries.capture ?? captureSnapshot)({ targetPid: options.targetPid, signal: controller.signal }), controller.signal);
   if (controller.signal.aborted) break;
   const currentInstance = snapshot.broker?.pid && snapshot.broker?.creationTime100ns ? [snapshot.broker.pid, snapshot.broker.creationTime100ns] : null;
   const newAnchors = new Map((snapshot.claims?.records ?? []).filter(r => r.status === 'observed').map(r => [r.targetPid, JSON.stringify([r.routeFingerprint, r.leaseFingerprint])]));
   const sample = { index: i, elapsedMs: Date.now() - started, ...snapshot, brokerInstanceChanged: !!(currentInstance && previousInstance && JSON.stringify(currentInstance) !== JSON.stringify(previousInstance)), targetAnchorChanged: [...newAnchors].some(([pid, anchor]) => oldAnchors.has(pid) && oldAnchors.get(pid) !== anchor) };
   report.samples.push(sample);
   if (Buffer.byteLength(JSON.stringify(report, null, 2)) > 4 * 1024 * 1024 - 1024) { report.samples.pop(); report.status = 'budget-exhausted'; break; }
   await save(); if (currentInstance) previousInstance = currentInstance; for (const [pid, anchor] of newAnchors) oldAnchors.set(pid, anchor);
   if (i + 1 < options.samples) await wait(Math.max(0, started + (i + 1) * options.intervalMs - Date.now()), controller.signal);
  }
  if (report.status === 'incomplete') report.status = controller.signal.aborted ? 'interrupted' : 'complete';
 } catch { report.status = 'failed'; }
 finally {
  clearTimeout(deadline); controller.abort(); process.off('SIGINT', abort); boundaries.signal?.removeEventListener('abort', abort);
  try { await save(); } finally { await handle.close(); }
 }
 return report;
}
module.exports = { captureSnapshot, canonicalPid, parseArgs, runObserver };
if (require.main === module) {
 Promise.resolve().then(() => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`Usage: node broker-recovery-diagnostic.cjs --output-dir ABSOLUTE_DIR [--samples 1..180] [--interval-ms 500..10000] [--target-pid PID]\nObservation only; never authorizes target access, termination or recovery. Observation deadline at most 600000 ms; not a hard wall-clock limit: synchronous OS/native calls and report filesystem I/O cannot be preempted. Pending asynchronous captures are abandoned on cancellation.\n${observationEffects}\n`); return null; }
  return runObserver(options);
 }).then(report => {
  if (!report) return;
  process.stdout.write(`Broker observation: ${report.status}; samples: ${report.samples.length}. No ownership or native recovery verified.\n${observationEffects}\n`);
  if (report.status === 'failed') process.exitCode = 1;
 }).catch(() => { process.stderr.write('Broker diagnostic unavailable (invalid arguments or report output failure).\n'); process.exitCode = 1; });
}
