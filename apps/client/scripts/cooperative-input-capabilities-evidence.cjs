'use strict';

// Recorded-evidence assertions only. This helper does not run native code,
// inspect a target process, inject input, or replace the controller's pixels.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { inspectPe } = require('./cooperative-game-evidence.cjs');
const WM = 'copied-wm-input-v1', RAW = 'copied-raw-input-buffer-v1', BASE = 'input-capabilities-v1';
function check(value, message) { if (!value) throw new Error(`Input capability evidence: ${message}`); }
function object(value, label) { check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`); return value; }
function count(value, label) { check(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative integer.`); return value; }
function positive(value, label) { check(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer.`); return value; }
function port(value, label) { check(positive(value, label) <= 65535, `${label} must be a TCP port.`); return value; }
function digest(value, label) { check(typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value), `${label} must be a SHA-256 digest.`); return value.toLowerCase(); }
function image(value, label) { check(typeof value === 'string' && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/])/iu.test(value), `${label} must be an absolute Windows path.`); return path.win32.normalize(value).toLowerCase(); }
function sameImage(a, b) { return image(a, 'image') === image(b, 'image'); }
function loopback(value) { return typeof value === 'string' && net.isIP(value) !== 0 && /^(?:127\.[0-9]+\.[0-9]+\.[0-9]+|::1|::ffff:127\.[0-9]+\.[0-9]+\.[0-9]+)$/iu.test(value); }
function identity(value, state, label) {
  object(value, label);
  check(positive(value.pid, `${label}.pid`) === state.targetPid, `${label} names another target PID.`);
  const filename = value.path ?? value.executablePath;
  const executablePath = image(filename, `${label}.path`);
  check(typeof value.creationTime100ns === 'string' && /^[1-9][0-9]{0,19}$/u.test(value.creationTime100ns) && BigInt(value.creationTime100ns) <= 18446744073709551615n, `${label} lacks exact process-creation identity.`);
  return { pid: value.pid, executablePath, creationTime100ns: value.creationTime100ns };
}
function hello(value, state, buffered, label) {
  const id = identity(value, state, label);
  check(value.protocolVersion === 1, `${label} has the wrong transport protocol.`);
  check(Array.isArray(value.capabilities) && value.capabilities.every(token => typeof token === 'string'), `${label} lacks actual hello tokens.`);
  check(value.capabilities.includes(BASE) && value.capabilities.includes(WM), `${label} did not explicitly advertise copied WM_INPUT.`);
  check(value.capabilities.includes(RAW) === buffered, `${label} buffered-input support contradicts the host lane.`);
  return id;
}
function summaries(value, label) {
  object(value, label);
  for (const key of ['bytes', 'packets', 'frames', 'interceptTrue', 'unknownKinds']) count(value[key], `${label}.${key}`);
  object(value.types, `${label}.types`);
  for (const [type, amount] of Object.entries(value.types)) { check(/^[a-z][a-z0-9.-]{0,99}$/u.test(type), `${label} has malformed packet type.`); count(amount, `${label}.${type}`); }
  check(!value.error && value.unknownKinds === 0, `${label} has undecodable wire evidence.`);
  check(value.packets === value.frames + Object.values(value.types).reduce((sum, amount) => sum + amount, 0), `${label} packet counters disagree.`);
  return value;
}
function wire(state, buffered, label) {
  const aggregate = object(state.wire, `${label}.wire`);
  const records = state.wireConnections;
  check(Array.isArray(records) && records.length > 0 && records.length <= 256, `${label} lacks bounded actual socket observations.`);
  const sums = { nativeConnections: records.length, helloCount: 0, outboundBytes: 0, outboundPackets: 0, outboundFrames: 0, interceptTruePackets: 0, outboundTypes: {} };
  for (const [index, record] of records.entries()) {
    object(record, `${label}.wireConnections[${index}]`);
    check(loopback(record.localAddress) && loopback(record.remoteAddress), `${label} socket is not loopback.`);
    check(port(record.localPort, `${label}.localPort`) === state.transport.port, `${label} socket uses another producer port.`);
    port(record.remotePort, `${label}.remotePort`);
    const input = summaries(record.inbound, `${label}.inbound`), output = summaries(record.outbound, `${label}.outbound`);
    if (input.hello) check(JSON.stringify(hello(input.hello, state, buffered, `${label}.socketHello`)) === JSON.stringify(identity(state.hello, state, `${label}.hello`)), `${label} socket changed native process identity.`);
    sums.helloCount += input.types['game.process'] || 0;
    sums.outboundBytes += output.bytes; sums.outboundPackets += output.packets; sums.outboundFrames += output.frames; sums.interceptTruePackets += output.interceptTrue;
    for (const [type, amount] of Object.entries(output.types)) sums.outboundTypes[type] = (sums.outboundTypes[type] || 0) + amount;
    if (record.actualBytesWritten !== undefined) check(count(record.actualBytesWritten, `${label}.actualBytesWritten`) === output.bytes, `${label} observed bytes differ from socket bytesWritten.`);
  }
  for (const [key, amount] of Object.entries(sums)) if (key !== 'outboundTypes') check(count(aggregate[key], `${label}.wire.${key}`) === amount, `${label} aggregate ${key} disagrees with socket evidence.`);
  const sorted = value => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  check(JSON.stringify(sorted(aggregate.outboundTypes)) === JSON.stringify(sorted(sums.outboundTypes)), `${label} aggregate packet types disagree.`);
  check(sums.helloCount > 0, `${label} has no actual native hello.`);
  const latestHello = records.filter(record => record.inbound.hello).at(-1)?.inbound.hello;
  check(JSON.stringify(latestHello) === JSON.stringify(state.hello), `${label} latest hello was not copied from its actual socket.`);
  return sums;
}
function state(value, buffered, label) {
  object(value, label);
  positive(value.processId, `${label}.processId`); positive(value.targetPid, `${label}.targetPid`);
  const transport = object(value.transport, `${label}.transport`);
  check(transport.producerPid === value.processId && transport.targetPid === value.targetPid, `${label} private route names another app or game.`);
  port(transport.port, `${label}.transport.port`); digest(transport.tokenFingerprint, `${label}.transport.tokenFingerprint`);
  image(value.runDirectory, `${label}.runDirectory`);
  for (const key of ['authenticationCount', 'connectionCount', 'transportLostCount', 'targetDisconnectedCount', 'renderingCount', 'trueAckCount', 'falseAckCount', 'fpsCount']) count(value[key], `${label}.${key}`);
  const id = hello(value.hello, value, buffered, `${label}.hello`), observedWire = wire(value, buffered, label);
  check(!value.error, `${label} contains a fixture error.`);
  return { value, identity: id, wire: observedWire };
}
function accepted(value, buffered, label) {
  const observed = state(value, buffered, label);
  check(value.attached === true && value.rejected === false && value.connectionCount === 1 && value.authenticationCount === 1, `${label} did not retain one accepted authentication.`);
  check(value.transportLostCount === 0 && value.targetDisconnectedCount === 0, `${label} lost its accepted route.`);
  check(value.rendering === true && value.renderingCount > 0 && value.trueAckCount > 0 && value.fpsCount > 0, `${label} lacks rendered/intercepted native evidence.`);
  check(value.surface && value.surface.pid === value.targetPid, `${label} lacks its current target surface.`);
  check(observed.wire.outboundBytes > 0 && observed.wire.outboundFrames > 0 && observed.wire.outboundTypes['overlay.init'] > 0 && observed.wire.interceptTruePackets > 0, `${label} has no complete accepted scene/frame/interception snapshot.`);
  const support = object(value.capabilities ?? value.authenticatedTarget?.inputCapabilities, `${label}.capabilities`);
  check(support.copiedWmInput === 'supported' && support.copiedRawInputBuffer === (buffered ? 'supported' : 'unsupported'), `${label} public capability read contradicts native hello.`);
  return observed;
}
function rejected(value) {
  const observed = state(value, false, 'strict');
  check(value.rejected === true && value.attached === false && value.attachment === null, 'Strict stock route was not rejected before attachment.');
  check(value.authenticationCount === 0 && value.connectionCount === 0 && value.trueAckCount === 0 && value.renderingCount === 0 && value.rendering === false && value.intercepting === false && value.surface === null, 'Strict stock route received authentication, scene, surface or true ACK.');
  for (const key of ['outboundBytes', 'outboundPackets', 'outboundFrames', 'interceptTruePackets']) check(observed.wire[key] === 0, `Strict stock route received ${key}.`);
  for (const record of value.wireConnections) check(record.actualBytesWritten === 0, 'Strict socket lacks proof of zero actual bytes written before capability rejection.');
  check(Object.keys(observed.wire.outboundTypes).length === 0, 'Strict stock route received outbound control types.');
  const rejection = object(value.rejection, 'strict.rejection');
  check(rejection.pid === value.targetPid && sameImage(rejection.executablePath, value.hello.path) && rejection.creationTime100ns === value.hello.creationTime100ns, 'Typed rejection does not identify the credential-validated native process.');
  check(JSON.stringify(rejection.requiredInputCapabilities) === JSON.stringify(['copied-raw-input-buffer']), 'Strict rejection names another required feature.');
  check(rejection.inputCapabilities?.copiedWmInput === 'supported' && rejection.inputCapabilities?.copiedRawInputBuffer === 'unsupported', 'Strict typed rejection did not report stock buffered input unsupported.');
  check(value.attachError?.code === 'target-input-capability-unsupported', 'Launcher did not return its typed unsupported result.');
  check(Array.isArray(value.events) && value.events.some(event => event.code === 'target-input-capability-unsupported' && event.severity === 'error' && event.context?.capability === 'copied-raw-input-buffer' && event.context?.support === 'unsupported'), 'Strict route lacks a typed unsupported diagnostic.');
  check(!value.events.some(event => event.code === 'target-authenticated' || event.code === 'runtime-scene-rendering-started'), 'Rejected route contains authentication or scene diagnostics.');
  return observed;
}
function continuity(beforeValue, afterValue) {
  const before = accepted(beforeValue, false, 'permissiveBefore'), after = accepted(afterValue, false, 'permissiveAfter');
  check(beforeValue.processId === afterValue.processId && JSON.stringify(before.identity) === JSON.stringify(after.identity), 'Permissive peer identity changed during strict rejection.');
  check(JSON.stringify(beforeValue.transport) === JSON.stringify(afterValue.transport), 'Permissive private route changed during strict rejection.');
  const normalizeTcp = (value, snapshot) => {
    object(value, 'tcp');
    check(loopback(value.localAddress) && loopback(value.remoteAddress), 'Permissive TCP observation is not loopback.');
    port(value.localPort, 'tcp.localPort'); port(value.remotePort, 'tcp.remotePort');
    check(value.state === 5 || String(value.state).toLowerCase() === 'established', 'Permissive TCP was not Established.');
    check((value.owningProcess === snapshot.targetPid && value.remotePort === snapshot.transport.port) || (value.owningProcess === snapshot.processId && value.localPort === snapshot.transport.port), 'Permissive TCP tuple belongs to another route/process.');
    return { ...value, state: 'established' };
  };
  check(JSON.stringify(normalizeTcp(beforeValue.tcp, beforeValue)) === JSON.stringify(normalizeTcp(afterValue.tcp, afterValue)), 'Permissive TCP connection changed during strict rejection.');
  check(afterValue.fpsCount >= beforeValue.fpsCount && afterValue.windows?.main?.value !== beforeValue.windows?.main?.value, 'Permissive peer has no continued input after strict rejection.');
}
function modules(report) {
  const expected = object(report.expected, 'expected'), mapped = report.modules;
  check(Array.isArray(mapped) && mapped.length > 0, 'Mapped native module evidence is missing.');
  const seen = new Set();
  for (const module of mapped) { object(module, 'module'); const key = image(module.path, 'module.path'); check(!seen.has(key), 'Duplicate mapped module path.'); seen.add(key); digest(module.sha256, 'module.sha256'); }
  const exact = (filename, sha, label) => { const matches = mapped.filter(module => sameImage(module.path, filename)); check(matches.length === 1 && digest(matches[0].sha256, label) === digest(sha, label), `${label} module path/hash mismatch.`); return matches[0]; };
  exact(expected.runtimePath, expected.runtimeSha256, 'runtime');
  check(mapped.filter(module => /^reshade(?:32|64)\.dll$/iu.test(path.win32.basename(module.path)) && !sameImage(module.path, expected.runtimePath)).length === 0, 'A second project ReShade runtime was mapped.');
  const engines = mapped.filter(module => digest(module.sha256, 'module.sha256') === digest(expected.addonSha256, 'expected.addonSha256'));
  const wanted = report.mode === 'stock' ? 3 : 1;
  check(engines.length === wanted, `Expected ${wanted} exact project add-on modules.`);
  for (const participant of [report.strict, ...(report.permissive ? [report.permissive] : [])]) check(engines.filter(module => sameImage(path.win32.dirname(module.path), participant.runDirectory)).length === 1, 'A participant lacks its separate source-matching engine.');
  if (report.mode === 'stock') { exact(expected.adapterPath, expected.addonSha256, 'adapter'); exact(expected.foreignAddonPath, expected.foreignAddonSha256, 'foreign add-on'); }
}
function preservation(report) {
  check(Array.isArray(report.protectedBefore) && report.protectedBefore.length >= (report.mode === 'stock' ? 5 : 1) && Array.isArray(report.protectedAfter), 'Protected-file snapshots are missing.');
  const normalized = values => values.map(value => {
    object(value, 'protected file'); check(typeof value.RelativePath === 'string' && value.RelativePath.length > 0 && !path.win32.isAbsolute(value.RelativePath) && !value.RelativePath.split(/[\\/]/u).includes('..'), 'Protected file path must stay within its owned seed.');
    check(Number.isSafeInteger(value.Attributes) && value.Attributes >= 0, 'Protected snapshot lacks exact file attributes.');
    check(typeof value.LastWriteUtcTicks === 'string' && /^[1-9][0-9]{0,19}$/u.test(value.LastWriteUtcTicks) && BigInt(value.LastWriteUtcTicks) <= 18446744073709551615n, 'Protected file timestamp must be a lossless decimal string.');
    return { relativePath: value.RelativePath.replaceAll('\\', '/').toLowerCase(), length: count(value.Length, 'protected.Length'), sha256: digest(value.Sha256, 'protected.Sha256'), attributes: value.Attributes, lastWriteUtcTicks: value.LastWriteUtcTicks };
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const before = normalized(report.protectedBefore), after = normalized(report.protectedAfter);
  check(new Set(before.map(value => value.relativePath)).size === before.length, 'Protected snapshot repeats a file.');
  if (report.mode === 'stock') for (const required of ['d3d11.dll', 'reshade.ini', 'capabilitywitness.ini', 'capabilitywitness.fx', 'addons/fps_limit.addon64']) check(before.some(value => value.relativePath === required), `Protected stock snapshot lacks ${required}.`);
  check(JSON.stringify(before) === JSON.stringify(after), 'Stock runtime/configuration/preset/effect/foreign files changed.');
}
function validateReport(report) {
  object(report, 'report'); check(report.schemaVersion === 1 && report.status === 'passed' && ['stock', 'owned'].includes(report.mode), 'Report must name a passed stock/owned capability run.');
  const strict = report.mode === 'stock' ? rejected(report.strict) : accepted(report.strict, true, 'strict');
  if (report.target !== undefined) check(JSON.stringify(identity(report.target, report.strict, 'target')) === JSON.stringify(strict.identity), 'Native hello does not identify the exact controller-owned target instance.');
  const proof = object(report.inputProof, 'inputProof');
  check(typeof proof.text === 'string' && proof.text.length > 0 && typeof proof.overlayValue === 'string' && proof.overlayValue.endsWith(proof.text) && proof.gameInputUnchanged === true, 'Native overlay text/input-blocking proof is missing.');
  const active = report.mode === 'stock' ? report.permissive : report.strict;
  check(active.windows?.main?.value === proof.overlayValue && active.windows.main.keydowns > 0 && active.windows.main.downs > 0 && active.windows.main.ups > 0, 'Input proof does not match completed DOM pointer/keyboard observations.');
  if (report.mode === 'stock') {
    const permissive = accepted(report.permissive, false, 'permissive');
    check(JSON.stringify(strict.identity) === JSON.stringify(permissive.identity), 'Stock peers do not identify the same native target instance.');
    check(report.strict.processId !== report.permissive.processId && report.strict.transport.port !== report.permissive.transport.port && report.strict.transport.tokenFingerprint !== report.permissive.transport.tokenFingerprint, 'Stock peers do not have independent app routes.');
    check(proof.sourceMode === 'wm-input', 'Stock permissive proof must use supported WM_INPUT.');
    continuity(report.permissiveBefore, report.permissiveAfter);
    check(proof.overlayValue === report.permissiveBefore.windows.main.value + proof.text, 'Permissive input proof did not append the controller text after strict rejection.');
    check(report.permissiveAfter.processId === report.permissive.processId, 'Continuity belongs to another permissive app.');
  } else {
    check(report.permissive === null && proof.sourceMode === 'raw-buffer' && proof.releasedRawBufferAdvanced === true, 'Owned positive must prove buffered input and game release.');
  }
  modules(report);
  if (report.mode === 'stock' || report.protectedBefore !== undefined) preservation(report);
  if (report.protectedAfterCleanup !== undefined) preservation({ ...report, protectedAfter: report.protectedAfterCleanup });
  if (report.moduleFileVerification !== undefined) {
    const verified = object(report.moduleFileVerification, 'moduleFileVerification');
    check(verified.moduleFilesVerified === true && verified.reShadeHostCount === 1 && verified.egoEngineCount === (report.mode === 'stock' ? 3 : 1), 'Recorded PE module verification is incomplete.');
    check(verified.inspectedModuleCount === report.modules.length && sameImage(verified.runtimePath, report.expected.runtimePath) && digest(verified.runtimeSha256, 'verified.runtimeSha256') === digest(report.expected.runtimeSha256, 'expected.runtimeSha256') && digest(verified.addonSha256, 'verified.addonSha256') === digest(report.expected.addonSha256, 'expected.addonSha256'), 'Recorded PE verification does not match this module report.');
  }
  check(Array.isArray(report.pixels) && report.pixels.length > 0, 'Native pixel observations are missing.');
  for (const pixel of report.pixels) {
    for (const key of ['expectedRgb', 'observedRgb']) check(Array.isArray(pixel[key]) && pixel[key].length === 3 && pixel[key].every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Pixel RGB observations are malformed.');
    check(pixel.expectedRgb.every((value, index) => Math.abs(value - pixel.observedRgb[index]) <= 8), 'Native overlay calibration pixels did not match.');
  }
  check(!JSON.stringify(report).match(/"(?:token|password|rawPayload)"\s*:/u), 'Evidence must not contain credentials or raw packet payload.');
  return { schemaVersion: 1, status: 'validated', mode: report.mode, nativeExecuted: false,
    scope: 'Recorded native hello/socket/module/file/input consistency; execution and foreground/pixel observations remain controller evidence.' };
}
function verifyModuleFiles(report) {
  let total = 0;
  const inspected = report.modules.map(module => {
    check(path.isAbsolute(module.path), 'Mapped file path must be absolute on this machine.');
    check(fs.lstatSync(module.path).isFile(), 'Mapped image must be a regular file.');
    const descriptor = fs.openSync(module.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(descriptor); total += before.size;
      check(before.isFile() && before.size > 0 && before.size <= 128 * 1024 * 1024 && total <= 1024 * 1024 * 1024, 'Mapped image bytes exceed the evidence bounds.');
      const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
      check(before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === before.size, 'Mapped image file changed while it was inspected.');
      check(createHash('sha256').update(bytes).digest('hex') === digest(module.sha256, 'mapped.sha256'), 'Mapped image file hash differs from the report.');
      return { path: module.path, sha256: module.sha256.toLowerCase(), ...inspectPe(bytes) };
    } finally { fs.closeSync(descriptor); }
  });
  const hosts = inspected.filter(module => module.isReShade);
  check(hosts.length === 1 && sameImage(hosts[0].path, report.expected.runtimePath), 'PE export inspection did not find exactly the expected single ReShade host.');
  const engines = inspected.filter(module => module.addon);
  check(engines.length === (report.mode === 'stock' ? 3 : 1) && engines.every(module => module.sha256 === report.expected.addonSha256.toLowerCase()), 'PE export inspection found an unexpected EGO engine or version.');
  return { moduleFilesVerified: true, inspectedModuleCount: inspected.length, reShadeHostCount: hosts.length, egoEngineCount: engines.length,
    runtimePath: report.expected.runtimePath, runtimeSha256: report.expected.runtimeSha256.toLowerCase(), addonSha256: report.expected.addonSha256.toLowerCase() };
}
function main(args) {
  check((args.length === 2 || (args.length === 3 && args[2] === '--verify-module-files')) && args[0] === '--report' && path.isAbsolute(args[1]), 'Use --report <absolute JSON path> [--verify-module-files].');
  const descriptor = fs.openSync(args[1], 'r');
  try { const stat = fs.fstatSync(descriptor); check(stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024, 'Report must be a bounded regular JSON file.'); const report = JSON.parse(fs.readFileSync(descriptor, 'utf8').replace(/^\uFEFF/u, '')); const result = validateReport(report); if (args.length === 3) return { ...result, moduleFileVerification: verifyModuleFiles(report) }; check(report.moduleFileVerification?.moduleFilesVerified === true, 'Final report lacks retained actual module-file verification.'); if (report.mode === 'stock') check(Array.isArray(report.protectedAfterCleanup), 'Final stock report lacks post-exit protected-file evidence.'); return result; }
  finally { fs.closeSync(descriptor); }
}
module.exports = { validateReport, verifyModuleFiles, main };
if (require.main === module) { try { console.log(JSON.stringify(main(process.argv.slice(2)))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
