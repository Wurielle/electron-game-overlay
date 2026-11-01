'use strict';

// These assertions validate recorded observations. They do not execute input,
// inspect an OS process, or substitute for the controller's native pixel checks.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const UINT64_MAX = 18446744073709551615n;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Surface lifecycle evidence: ${message}`);
}

function record(value, label) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  return value;
}

function count(value, label) {
  requireCondition(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative integer.`);
  return value;
}

function pid(value, label) {
  requireCondition(Number.isInteger(value) && value > 0 && value <= 0xffffffff, `${label} must be a positive uint32 PID.`);
  return value;
}

function port(value, label) {
  requireCondition(Number.isInteger(value) && value > 0 && value <= 65535, `${label} must be a TCP port.`);
  return value;
}

function gameIdentity(value, targetPid, label) {
  record(value, label);
  requireCondition(pid(value.pid, `${label}.pid`) === targetPid, `${label}.pid must identify the exact target.`);
  const executablePath = value.executablePath ?? value.path;
  const absoluteImage = (imagePath) => typeof imagePath === 'string' && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/])/iu.test(imagePath);
  requireCondition(absoluteImage(executablePath), `${label}.executablePath must be an absolute Windows image path.`);
  if (value.executablePath !== undefined && value.path !== undefined) requireCondition(absoluteImage(value.path) && path.win32.normalize(value.path).toLowerCase() === path.win32.normalize(value.executablePath).toLowerCase(), `${label} has conflicting image path fields.`);
  requireCondition(typeof value.creationTime100ns === 'string' && /^[1-9][0-9]{0,19}$/u.test(value.creationTime100ns) && BigInt(value.creationTime100ns) <= UINT64_MAX, `${label}.creationTime100ns must be an exact canonical positive uint64 string.`);
  return { pid: value.pid, executablePath: path.win32.normalize(executablePath).toLowerCase(), creationTime100ns: value.creationTime100ns };
}

function windowStates(value, label) {
  record(value, label);
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  requireCondition(entries.length > 0 && Object.hasOwn(value, 'main'), `${label} must contain a main window.`);
  const seen = new Set();
  for (const [name, window] of entries) {
    record(window, `${label}.${name}`);
    pid(window.id, `${label}.${name}.id`);
    requireCondition(!seen.has(window.id), `${label} repeats a window ID.`);
    seen.add(window.id);
    requireCondition(typeof window.value === 'string', `${label}.${name}.value must be a string.`);
    for (const key of ['downs', 'ups']) count(window[key], `${label}.${name}.${key}`);
    requireCondition(Array.isArray(window.heldKeys) && window.heldKeys.every((key) => typeof key === 'string'), `${label}.${name}.heldKeys must be a key-name array.`);
  }
  return entries;
}

function snapshot(value, label) {
  record(value, label);
  requireCondition(typeof value.member === 'string' && value.member.length > 0, `${label}.member must identify the app.`);
  const processId = pid(value.processId, `${label}.processId`);
  const targetPid = pid(value.targetPid, `${label}.targetPid`);
  const identity = gameIdentity(value.authenticatedTarget, targetPid, `${label}.authenticatedTarget`);
  const transport = record(value.transport, `${label}.transport`);
  requireCondition(pid(transport.producerPid, `${label}.transport.producerPid`) === processId, `${label}.transport must belong to this app process.`);
  requireCondition(pid(transport.targetPid, `${label}.transport.targetPid`) === targetPid, `${label}.transport must bind the exact game PID.`);
  port(transport.port, `${label}.transport.port`);
  requireCondition(typeof transport.tokenFingerprint === 'string' && /^[0-9a-f]{16,64}$/iu.test(transport.tokenFingerprint), `${label}.transport.tokenFingerprint must be a retained credential fingerprint.`);
  const windows = windowStates(value.windows, `${label}.windows`);
  for (const key of ['connectionCount', 'authenticationCount', 'transportLostCount', 'targetDisconnectedCount', 'removedSurfaceCount', 'fpsCount']) count(value[key], `${label}.${key}`);
  requireCondition(value.connectionCount > 0 && value.authenticationCount > 0, `${label} must contain authenticated connection evidence.`);
  requireCondition(value.targetDisconnectedCount === 0, `${label} reports target disconnection.`);
  return { value, processId, targetPid, identity, transport, windows };
}

function surface(value, targetPid, label) {
  record(value, label);
  requireCondition(value.pid === targetPid, `${label} must belong to the same target PID.`);
  for (const key of ['surfaceId', 'hwnd']) requireCondition(typeof value[key] === 'string' && /^0x[1-9a-f][0-9a-f]{0,15}$/u.test(value[key]), `${label}.${key} must be a nonzero canonical native identifier.`);
  requireCondition(Number.isSafeInteger(value.revision) && value.revision > 0, `${label}.revision must be a positive state revision.`);
  return value;
}

function tcp(value, state, label) {
  record(value, label);
  const loopback = (address) => typeof address === 'string' && net.isIP(address) !== 0 && /^(?:127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|::1|::ffff:127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/iu.test(address);
  requireCondition(loopback(value.localAddress) && loopback(value.remoteAddress), `${label} must describe the loopback target connection.`);
  port(value.localPort, `${label}.localPort`);
  port(value.remotePort, `${label}.remotePort`);
  pid(value.owningProcess, `${label}.owningProcess`);
  requireCondition(value.state === 5 || (typeof value.state === 'string' && value.state.toLowerCase() === 'established'), `${label} must be Established.`);
  if (value.owningProcess === state.targetPid) requireCondition(value.remotePort === state.transport.port, `${label} target socket does not reach its producer port.`);
  else if (value.owningProcess === state.processId) requireCondition(value.localPort === state.transport.port, `${label} producer socket does not use its retained route port.`);
  else requireCondition(false, `${label} belongs to neither the exact target nor the app.`);
  return { localAddress: value.localAddress.toLowerCase(), localPort: value.localPort, remoteAddress: value.remoteAddress.toLowerCase(), remotePort: value.remotePort, owningProcess: value.owningProcess, state: 'established' };
}

function sameIdentityAndRoute(before, after, label) {
  requireCondition(before.value.member === after.value.member && before.processId === after.processId, `${label} changed application identity.`);
  requireCondition(JSON.stringify(before.identity) === JSON.stringify(after.identity), `${label} changed authenticated game identity.`);
  for (const key of ['producerPid', 'port', 'tokenFingerprint', 'targetPid']) requireCondition(before.transport[key] === after.transport[key], `${label} changed the retained transport ${key}.`);
  requireCondition(JSON.stringify(before.windows.map(([name, window]) => [name, window.id])) === JSON.stringify(after.windows.map(([name, window]) => [name, window.id])), `${label} changed retained window identities.`);
}

function monotonic(before, after, label) {
  for (const key of ['connectionCount', 'authenticationCount', 'transportLostCount', 'removedSurfaceCount', 'fpsCount']) requireCondition(after.value[key] >= before.value[key], `${label} reset ${key}.`);
}

function releasedKeys(state, label) {
  for (const [name, window] of state.windows) requireCondition(window.heldKeys.length === 0, `${label}.${name} retains held keys.`);
}

function result(kind, checks) {
  return { status: 'validated', kind, checks };
}

function assertPromotion(beforeValue, afterValue) {
  const before = snapshot(beforeValue, 'promotion.before');
  const after = snapshot(afterValue, 'promotion.after');
  sameIdentityAndRoute(before, after, 'Promotion');
  monotonic(before, after, 'Promotion');
  for (const state of [before, after]) {
    requireCondition(state.value.connectionCount === 1 && state.value.authenticationCount === 1, 'Promotion must retain the original single connection/authentication.');
    requireCondition(state.value.transportLostCount === 0, 'Promotion reports transport loss.');
    releasedKeys(state, 'Promotion');
  }
  const first = surface(beforeValue.surface, before.targetPid, 'promotion.before.surface');
  const second = surface(afterValue.surface, after.targetPid, 'promotion.after.surface');
  requireCondition(first.surfaceId !== second.surfaceId && first.hwnd !== second.hwnd, 'Promotion did not change from the primary surface/window to a distinct presenter.');
  requireCondition(JSON.stringify(tcp(beforeValue.tcp, before, 'promotion.before.tcp')) === JSON.stringify(tcp(afterValue.tcp, after, 'promotion.after.tcp')), 'Promotion replaced the established TCP tuple.');
  requireCondition(afterValue.fpsCount > beforeValue.fpsCount, 'Promotion has no fresh FPS observation.');
  requireCondition(afterValue.windows.main.value !== beforeValue.windows.main.value, 'Promotion has no new main-window text observation.');
  requireCondition(afterValue.windows.main.downs > beforeValue.windows.main.downs && afterValue.windows.main.ups > beforeValue.windows.main.ups, 'Promotion has no completed new main-window pointer interaction.');
  return result('promotion', ['same app/game identity and retained route', 'one uninterrupted authenticated TCP connection', 'distinct promoted presenter and fresh FPS', 'retained windows with new text and completed pointer interaction']);
}

function assertRecreated(beforeValue, destroyedValue, afterValue) {
  const before = snapshot(beforeValue, 'recreation.before');
  const destroyed = snapshot(destroyedValue, 'recreation.destroyed');
  const after = snapshot(afterValue, 'recreation.after');
  sameIdentityAndRoute(before, destroyed, 'Final surface destruction');
  sameIdentityAndRoute(before, after, 'Surface recreation');
  monotonic(before, destroyed, 'Final surface destruction');
  monotonic(destroyed, after, 'Surface recreation');
  const first = surface(beforeValue.surface, before.targetPid, 'recreation.before.surface');
  requireCondition(destroyedValue.surface === null, 'Final destruction did not clear the target surface.');
  requireCondition(destroyedValue.removedSurfaceCount > beforeValue.removedSurfaceCount, 'Final destruction has no surface-removed observation.');
  const recreated = surface(afterValue.surface, after.targetPid, 'recreation.after.surface');
  const reusedSurfaceId = first.surfaceId === recreated.surfaceId;
  if (reusedSurfaceId) requireCondition(recreated.revision > first.revision, 'Reused surface pointer has no newer revision after final removal.');
  tcp(beforeValue.tcp, before, 'recreation.before.tcp');
  tcp(afterValue.tcp, after, 'recreation.after.tcp');
  requireCondition(afterValue.fpsCount > beforeValue.fpsCount, 'Recreation has no fresh FPS observation.');
  return { ...result('recreation', ['same app/game identity and retained route/windows', 'final surface cleared after removal notification', 'fresh presenter and FPS; reused pointer requires a newer revision', 'target stayed connected; native TCP reauthentication permitted']), reconnected: afterValue.connectionCount > beforeValue.connectionCount, reusedSurfaceId };
}

function assertNoImplicitFocus(beforeValue, afterValue, sent) {
  const before = snapshot(beforeValue, 'noImplicitFocus.before');
  const after = snapshot(afterValue, 'noImplicitFocus.after');
  sameIdentityAndRoute(before, after, 'No implicit focus');
  monotonic(before, after, 'No implicit focus');
  requireCondition(typeof sent === 'string' && sent.length > 0 && sent.length <= 256, 'No implicit focus requires the controller\'s attempted text marker.');
  requireCondition(afterValue.focusedWindowId === null || afterValue.focusedWindowId === 0, 'Recreated surface implicitly focused an overlay window.');
  releasedKeys(before, 'No implicit focus before');
  releasedKeys(after, 'No implicit focus after');
  for (const [name, first] of before.windows) {
    const second = afterValue.windows[name];
    count(first.keydowns, `noImplicitFocus.before.windows.${name}.keydowns`);
    count(second.keydowns, `noImplicitFocus.after.windows.${name}.keydowns`);
    requireCondition(first.value === second.value && first.keydowns === second.keydowns, `Unfocused ${name} received the attempted text or a keydown.`);
    requireCondition(first.downs === second.downs && first.ups === second.ups, `No implicit focus ${name} pointer counters changed during the keyboard-only check.`);
  }
  return { ...result('noImplicitFocus', ['no native focused overlay window', 'all retained window values and DOM keydown counters unchanged', 'no held keys or new pointer transitions']), attemptedText: sent };
}

function validateReport(report) {
  record(report, 'report');
  const results = [];
  if (Object.hasOwn(report, 'promotion')) {
    const evidence = record(report.promotion, 'report.promotion');
    results.push(assertPromotion(evidence.before, evidence.after));
  }
  if (Object.hasOwn(report, 'recreation')) {
    const evidence = record(report.recreation, 'report.recreation');
    results.push(assertRecreated(evidence.before, evidence.destroyed, evidence.after));
  }
  if (Object.hasOwn(report, 'noImplicitFocus')) {
    const evidence = record(report.noImplicitFocus, 'report.noImplicitFocus');
    results.push(assertNoImplicitFocus(evidence.before, evidence.after, evidence.sent));
  }
  requireCondition(results.length > 0, 'Report contains no named lifecycle evidence.');
  return { schemaVersion: 1, status: 'validated', nativeExecuted: false, scope: 'Recorded snapshot consistency; input execution, OS observations and native pixels are the controller\'s evidence.', results };
}

function main(args) {
  requireCondition(args.length === 2 && args[0] === '--report' && path.isAbsolute(args[1]), 'Use --report <absolute JSON path>.');
  const descriptor = fs.openSync(args[1], 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    requireCondition(stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024, 'Report must be a bounded regular JSON file.');
    return validateReport(JSON.parse(fs.readFileSync(descriptor, 'utf8').replace(/^\uFEFF/u, '')));
  } finally { fs.closeSync(descriptor); }
}

module.exports = { assertPromotion, assertRecreated, assertNoImplicitFocus, validateReport, main };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
