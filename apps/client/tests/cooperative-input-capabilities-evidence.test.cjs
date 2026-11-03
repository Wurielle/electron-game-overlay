'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateReport, verifyModuleFiles, main } = require('../scripts/cooperative-input-capabilities-evidence.cjs');
const copy = value => structuredClone(value);
const WM = ['input-capabilities-v1', 'copied-wm-input-v1'];
const H = '1'.repeat(64), A = 'a'.repeat(64), F = '2'.repeat(64);
function state(member, raw = false, denied = false) {
  const strict = member === 'strict', port = strict ? 43001 : 43002, producer = strict ? 101 : 102;
  const hello = { pid: 900, path: 'C:\\Owned\\target.exe', creationTime100ns: '134000000000000001', protocolVersion: 1, capabilities: raw ? [...WM, 'copied-raw-input-buffer-v1'] : [...WM] };
  const input = { bytes: 300, packets: 1, frames: 0, interceptTrue: 0, unknownKinds: 0, types: { 'game.process': 1 }, hello };
  const output = { bytes: denied ? 0 : 400, packets: denied ? 0 : 3, frames: denied ? 0 : 1, interceptTrue: denied ? 0 : 1, unknownKinds: 0, types: denied ? {} : { 'overlay.init': 1, 'command.input.intercept': 1 } };
  const result = { member, processId: producer, targetPid: 900, runDirectory: `C:\\Owned\\runs-${member}\\stage`,
    transport: { producerPid: producer, targetPid: 900, port, tokenFingerprint: (strict ? 'b' : 'c').repeat(64) },
    hello, wireConnections: [{ localAddress: '127.0.0.1', localPort: port, remoteAddress: '127.0.0.1', remotePort: 55000 + producer, closed: denied, ...(denied ? { actualBytesWritten: 0 } : {}), inbound: input, outbound: output }],
    wire: { nativeConnections: 1, helloCount: 1, outboundBytes: output.bytes, outboundPackets: output.packets, outboundFrames: output.frames, interceptTruePackets: output.interceptTrue, outboundTypes: copy(output.types) },
    attached: !denied, rejected: denied, attachment: denied ? null : { pid: 900 }, authenticationCount: denied ? 0 : 1, connectionCount: denied ? 0 : 1, transportLostCount: 0, targetDisconnectedCount: 0,
    rendering: !denied, renderingCount: denied ? 0 : 1, trueAckCount: denied ? 0 : 1, falseAckCount: 0, fpsCount: denied ? 0 : 3, intercepting: !denied,
    surface: denied ? null : { pid: 900, surfaceId: '0x100', hwnd: '0x200' },
    capabilities: { copiedWmInput: 'supported', copiedRawInputBuffer: raw ? 'supported' : 'unsupported' },
    windows: { main: { id: 1, value: denied ? '' : 'okay', downs: denied ? 0 : 1, ups: denied ? 0 : 1, keydowns: denied ? 0 : 4, heldKeys: [] } }, events: [],
    tcp: { localAddress: '127.0.0.1', localPort: 55102, remoteAddress: '127.0.0.1', remotePort: port, owningProcess: 900, state: 'Established' } };
  if (denied) {
    result.rejection = { pid: 900, executablePath: hello.path, creationTime100ns: hello.creationTime100ns, inputCapabilities: copy(result.capabilities), requiredInputCapabilities: ['copied-raw-input-buffer'] };
    result.attachError = { code: 'target-input-capability-unsupported', stage: 'runtime-initialization', retrySafety: 'indeterminate' };
    result.events.push({ code: 'target-input-capability-unsupported', severity: 'error', context: { capability: 'copied-raw-input-buffer', support: 'unsupported' } });
  }
  return result;
}
function report(mode = 'stock') {
  const stock = mode === 'stock', strict = state('strict', !stock, stock), permissive = stock ? state('permissive') : null;
  const expected = { runtimePath: stock ? 'C:\\Owned\\seed\\d3d11.dll' : 'C:\\Owned\\runs-strict\\stage\\ReShade64.dll', runtimeSha256: H, addonSha256: A,
    adapterPath: 'C:\\Owned\\seed\\addons\\electron_game_overlay.addon64', foreignAddonPath: 'C:\\Owned\\seed\\addons\\fps_limit.addon64', foreignAddonSha256: F };
  const modules = [{ path: expected.runtimePath, sha256: H }, { path: strict.runDirectory + '\\electron_game_overlay.addon64', sha256: A }];
  if (stock) modules.push({ path: permissive.runDirectory + '\\electron_game_overlay.addon64', sha256: A }, { path: expected.adapterPath, sha256: A }, { path: expected.foreignAddonPath, sha256: F });
  const protectedBefore = (stock ? ['d3d11.dll', 'ReShade.ini', 'CapabilityWitness.ini', 'CapabilityWitness.fx', 'addons/fps_limit.addon64'] : ['ReShade64.dll']).map(RelativePath => ({ RelativePath, Sha256: H, Length: 1024, Attributes: 32, LastWriteUtcTicks: '134000000000000000' }));
  const result = { schemaVersion: 1, status: 'passed', mode, strict, permissive, modules, expected, protectedBefore, protectedAfter: copy(protectedBefore),
    inputProof: { text: 'okay', overlayValue: 'okay', gameInputUnchanged: true, sourceMode: stock ? 'wm-input' : 'raw-buffer', ...(stock ? {} : { releasedRawBufferAdvanced: true }) },
    pixels: [{ expectedRgb: [21, 101, 192], observedRgb: [21, 101, 192] }] };
  if (stock) { result.permissiveAfter = copy(permissive); result.permissiveBefore = copy(permissive); result.permissiveBefore.windows.main.value = ''; }
  return result;
}

test('simulated stock evidence proves a typed zero-byte rejection beside a continuously interactive WM peer', () => {
  const value = report();
  assert.equal(validateReport(value).status, 'validated');
  assert.equal(value.strict.wire.outboundBytes, 0, 'Validator does not mutate observations.');
});
test('simulated owned evidence proves explicit buffered support, delivered input and released raw game input', () => {
  assert.equal(validateReport(report('owned')).mode, 'owned');
  for (const mutate of [r => r.strict.hello.capabilities.pop(), r => { r.inputProof.releasedRawBufferAdvanced = false; }, r => { r.inputProof.sourceMode = 'wm-input'; }]) { const value = report('owned'); mutate(value); assert.throws(() => validateReport(value)); }
});
test('rejected stock evidence cannot contain any authenticated snapshot, rendering or true ACK', () => {
  for (const mutate of [r => r.strict.authenticationCount++, r => r.strict.connectionCount++, r => r.strict.renderingCount++, r => r.strict.trueAckCount++, r => { r.strict.rendering = true; }, r => { r.strict.attachment = {}; }, r => r.strict.wireConnections[0].outbound.bytes++, r => { r.strict.attachError.code = 'timeout'; }, r => { r.strict.rejection.inputCapabilities.copiedRawInputBuffer = 'unknown'; }, r => r.strict.events.push({ code: 'runtime-scene-rendering-started' }), r => { r.strict.hello.capabilities.push('copied-raw-input-buffer-v1'); }]) { const value = report(); mutate(value); assert.throws(() => validateReport(value)); }
});
test('wire and native identity evidence must correlate to actual sockets and private producer routes', () => {
  for (const mutate of [r => r.strict.wire.helloCount++, r => r.strict.wireConnections[0].localPort++, r => { r.strict.wireConnections[0].remoteAddress = '192.168.1.2'; }, r => r.strict.wireConnections[0].inbound.hello.pid++, r => { r.strict.wireConnections[0].actualBytesWritten = 3; }, r => { r.strict.hello = { ...r.strict.hello, capabilities: [...WM, 'unobserved-token'] }; }, r => { r.strict.transport.producerPid = 999; }, r => { r.strict.transport.token = 'secret'; }]) { const value = report(); mutate(value); assert.throws(() => validateReport(value)); }
});
test('peer continuity rejects authentication, socket, private credential and process replacement', () => {
  for (const mutate of [r => r.permissiveAfter.authenticationCount++, r => r.permissiveAfter.transportLostCount++, r => r.permissiveAfter.tcp.localPort++, r => { r.permissiveAfter.transport.tokenFingerprint = F; }, r => { r.permissiveAfter.windows.main.value = ''; }, r => r.permissiveAfter.targetPid++]) { const value = report(); mutate(value); assert.throws(() => validateReport(value)); }
});
test('module, stock-file metadata, rendering pixels and input proof failures reject', () => {
  for (const mutate of [r => { r.modules[0].sha256 = F; }, r => r.modules.push({ path: 'C:\\Owned\\other\\ReShade64.dll', sha256: H }), r => r.modules.pop(), r => r.protectedAfter[0].Length++, r => r.protectedAfter[0].LastWriteUtcTicks++, r => r.protectedAfter.pop(), r => { r.protectedBefore[0].RelativePath = '../escape'; }, r => { r.pixels[0].observedRgb = [255, 255, 255]; }, r => { r.inputProof.gameInputUnchanged = false; }, r => { r.inputProof.overlayValue = 'fake'; }]) { const value = report(); mutate(value); assert.throws(() => validateReport(value)); }
});
test('protected timestamps retain exact ticks beyond JavaScript number precision', () => {
  const value = report();
  assert.equal(validateReport(value).status, 'validated');
  value.protectedAfter[0].LastWriteUtcTicks = (BigInt(value.protectedBefore[0].LastWriteUtcTicks) + 1n).toString();
  assert.throws(() => validateReport(value), /files changed/);
  value.protectedAfter[0].LastWriteUtcTicks = value.protectedBefore[0].LastWriteUtcTicks;
  value.protectedBefore[0].LastWriteUtcTicks = Number(value.protectedBefore[0].LastWriteUtcTicks);
  value.protectedAfter[0].LastWriteUtcTicks = value.protectedBefore[0].LastWriteUtcTicks;
  assert.throws(() => validateReport(value), /lossless decimal string/);
});
test('default CLI validates retained PE proof without reading removed native files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-capability-report-'));
  try {
    const filename = path.join(directory, 'report.json'), value = report();
    fs.writeFileSync(filename, JSON.stringify(value));
    assert.throws(() => main(['--report', filename]), /lacks retained actual module-file verification/);
    value.moduleFileVerification = { moduleFilesVerified: true, inspectedModuleCount: value.modules.length, reShadeHostCount: 1, egoEngineCount: 3, runtimePath: value.expected.runtimePath, runtimeSha256: H, addonSha256: A };
    value.protectedAfterCleanup = copy(value.protectedBefore);
    fs.writeFileSync(filename, JSON.stringify(value));
    assert.equal(main(['--report', filename]).status, 'validated');
    value.moduleFileVerification.reShadeHostCount = 2;
    fs.writeFileSync(filename, JSON.stringify(value)); assert.throws(() => main(['--report', filename]));
    assert.throws(() => main(['--report', filename, '--unknown-switch']));
    assert.throws(() => main(['--report', filename, '--verify-module-files'])); // Fixture-only Windows image paths do not exist.
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// File-layout unit inputs, never executable/native acceptance binaries.
function pe(entries) {
  const bytes = Buffer.alloc(0x1200); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(0x20b, 152);
  bytes.writeUInt32LE(0x200, 212); bytes.writeUInt32LE(16, 260);
  const section = 392; bytes.write('.rdata', section); bytes.writeUInt32LE(0x1000, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x1000, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x1000, 264); bytes.writeUInt32LE(0x300, 268); bytes.writeUInt32LE(entries.length, 0x214); bytes.writeUInt32LE(entries.length, 0x218);
  bytes.writeUInt32LE(0x1040, 0x21c); bytes.writeUInt32LE(0x1080, 0x220); bytes.writeUInt32LE(0x10c0, 0x224);
  let name = 0x1100;
  entries.forEach((entry, index) => { const target = 0x1400 + index * 0x80; bytes.writeUInt32LE(target, 0x240 + index * 4); bytes.writeUInt32LE(name, 0x280 + index * 4); bytes.writeUInt16LE(index, 0x2c0 + index * 2); bytes.write(entry.name + '\0', name - 0xe00); Buffer.from(entry.data).copy(bytes, target - 0xe00); name += Buffer.byteLength(entry.name) + 1; });
  return bytes;
}

test('live-file CLI hashes and inspects exports before cleanup, detecting a renamed second host', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-capability-native-files-'));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const value = report('owned'), hostBytes = pe([{ name: 'ReShadeVersion', data: Buffer.alloc(8) }]);
    const abi = Buffer.alloc(4); abi.writeUInt32LE(1);
    const addonBytes = pe([{ name: 'ElectronGameOverlayReShadeAddonBuildId', data: '0123456789ABCDEF0123456789ABCDEF\0' }, { name: 'ElectronGameOverlayReShadeAddonAbi', data: abi }]);
    const stage = path.join(directory, 'stage'); fs.mkdirSync(stage);
    const host = path.join(stage, 'unrelated-runtime.bin'), addon = path.join(stage, 'private-engine.bin');
    fs.writeFileSync(host, hostBytes); fs.writeFileSync(addon, addonBytes);
    value.strict.runDirectory = stage;
    value.expected.runtimePath = host; value.expected.runtimeSha256 = sha(hostBytes); value.expected.addonSha256 = sha(addonBytes);
    value.modules = [{ path: host, sha256: sha(hostBytes) }, { path: addon, sha256: sha(addonBytes) }];
    const filename = path.join(directory, 'report.json'); fs.writeFileSync(filename, JSON.stringify(value));
    const observed = main(['--report', filename, '--verify-module-files']);
    assert.equal(observed.moduleFileVerification.reShadeHostCount, 1);
    assert.equal(observed.moduleFileVerification.egoEngineCount, 1);
    const secondHost = path.join(stage, 'also-not-a-proxy-name.bin'); fs.writeFileSync(secondHost, hostBytes);
    const extra = copy(value); extra.modules.push({ path: secondHost, sha256: sha(hostBytes) });
    assert.equal(validateReport(extra).status, 'validated', 'Recorded names alone cannot identify the extra host.');
    assert.throws(() => verifyModuleFiles(extra), /exactly the expected single ReShade/);
    const changed = copy(value); changed.modules[0].sha256 = F;
    assert.throws(() => verifyModuleFiles(changed), /file hash differs/);
    value.moduleFileVerification = observed.moduleFileVerification;
    fs.writeFileSync(filename, JSON.stringify(value));
    fs.unlinkSync(host); fs.unlinkSync(addon);
    assert.equal(main(['--report', filename]).status, 'validated', 'Retained proof survives legitimate stage cleanup.');
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); }
});
