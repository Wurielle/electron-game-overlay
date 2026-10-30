'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = path.join(__dirname, '../scripts/windows-broker-identity.cjs');
const pipe = '\\\\.\\pipe\\owned-identity-fixture';
function fixture(change = {}) {
  const calls = [], closed = [], freed = [];
  let pidReads = 0, tokens = 0;
  const api = {
    CreateFileW(p, access, share, security, disposition, flags, template) { assert.equal(p, pipe); assert.deepEqual([access, share, security, disposition, flags, template], [0, 0, null, 3, 0, null]); return Object.hasOwn(change, 'pipeHandle') ? change.pipeHandle : 10; },
    GetNamedPipeServerProcessId(h, out) { assert.equal(h, change.pipeHandle ?? 10); if (change.serverError) return 0; out.writeUInt32LE(change.mismatch && pidReads++ ? 99 : change.pid ?? 42); return 1; },
    OpenProcess(access, inherit, pid) { assert.deepEqual([access, inherit, pid], [0x1000, 0, 42]); return 20; },
    GetProcessTimes(h, created, exited, kernel, user) { for (const b of [created, exited, kernel, user]) assert.equal(b.length, 8); created.writeBigUInt64LE(134123456789012345n); return 1; },
    QueryFullProcessImageNameW(h, flags, out, size) { assert.equal(flags, 0); assert.equal(size.readUInt32LE(), 32768); assert.equal(out.length, 65536); const s = 'C:\\private\\node.exe'; out.write(s, 'utf16le'); size.writeUInt32LE(change.oversize ? 32769 : s.length); return 1; },
    GetExitCodeProcess(h, out) { out.writeUInt32LE(change.dead ? 0 : 259); return 1; },
    GetCurrentProcess() { return -1; },
    OpenProcessToken(h, access, out) { assert.equal(access, 8); out.writeBigUInt64LE(BigInt(30 + tokens++)); return 1; },
    GetTokenInformation(h, kind, out, size, needed) { assert.equal(kind, 1); assert.equal(size, 4096); assert.equal(out.length, 4096); out.writeBigUInt64LE(BigInt(h)); needed.writeUInt32LE(16); return 1; },
    ConvertSidToStringSidW(sid, out) { out.writeBigUInt64LE(BigInt(sid + 100)); return 1; },
    CloseHandle(h) { closed.push(h); return 1; }, LocalFree(p) { freed.push(p); return null; }, GetLastError() { return change.lastError ? change.lastError() : change.serverError && calls.includes('GetNamedPipeServerProcessId') ? 87 : 5; },
  };
  const koffi = { address(handle) { return typeof handle === 'object' && handle !== null ? require('koffi').address(handle) : BigInt(handle ?? 0); }, sizeof() { return 8; }, decode(b, offset, type) { if (Buffer.isBuffer(b)) return Number(b.readBigUInt64LE(offset)); const s = change.otherUser && b === 131 ? 'S-1-5-22' : 'S-1-5-21'; return offset / 2 < s.length ? s.charCodeAt(offset / 2) : 0; }, load() { return { func(signature) { const name = signature.match(/__stdcall (\w+)\(/)[1]; return (...args) => { calls.push(name); if (change.fail === name) { if (change.throw) throw Error('SECRET SID PATH'); return name === 'OpenProcess' || name === 'CreateFileW' ? null : 0; } return api[name](...args); }; } }; } };
  return { koffi, calls, closed, freed };
}
function query(f) { assert.ok(fs.existsSync(source), 'producer identity API must exist'); return require(source).queryWindowsBrokerIdentity(pipe, { platform: 'win32', koffi: f.koffi }); }
test('real Koffi INVALID_HANDLE_VALUE preserves pipe-open Win32 error without PID query or cleanup', () => {
  const k = require('koffi');
  // Decode pointer bytes in owned memory; never dereference the invalid address.
  const bytes = Buffer.alloc(k.sizeof('void *'), 0xff);
  const handle = k.decode(bytes, 0, 'void *');
  assert.equal(typeof handle, 'object');
  assert.equal(k.address(handle), (1n << BigInt(bytes.length * 8)) - 1n);
  let win32 = 5;
  const f = fixture({ pipeHandle: handle, serverError: true, lastError: () => win32 });
  // An addon boundary may overwrite the thread-local error from CreateFileW.
  f.koffi.address = pointer => { win32 = 87; return k.address(pointer); };
  f.koffi.sizeof = k.sizeof;
  let error;
  try { query(f); } catch (caught) { error = caught; }
  assert.deepEqual({ stage: error?.stage, win32: error?.win32, calls: f.calls, closed: f.closed, freed: f.freed }, {
    stage: 'pipe-open', win32: 5, calls: ['CreateFileW', 'GetLastError'], closed: [], freed: [],
  });
});
test('real Koffi valid External pipe follows the complete identity and cleanup path', t => {
  const k = require('koffi');
  const handle = k.alloc('uint8_t', 1);
  t.after(() => k.free(handle));
  const f = fixture({ pipeHandle: handle });
  f.koffi.address = k.address; f.koffi.sizeof = k.sizeof;
  assert.equal(query(f).pid, 42);
  assert.equal(f.calls.filter(name => name === 'GetNamedPipeServerProcessId').length, 2);
  assert.deepEqual(f.closed, [31, 30, 20, handle]);
  assert.deepEqual(f.freed, [131, 130]);
});
test('NULL pipe failure preserves the original Win32 error and owns no handles', () => {
  const f = fixture({ pipeHandle: null, serverError: true });
  assert.throws(() => query(f), { stage: 'pipe-open', win32: 5 });
  assert.deepEqual(f.calls, ['CreateFileW', 'GetLastError']);
  assert.deepEqual(f.closed, []);
});
test('producer uses owned pipe kernel PID, limited rights, exact FILETIME and same-user tokens', () => {
  const f = fixture(); assert.deepEqual(query(f), { pid: 42, creationTime100ns: '134123456789012345', executablePath: 'C:\\private\\node.exe', sameUser: true });
  assert.deepEqual(f.closed.sort((a,b)=>a-b), [10,20,30,31]); assert.deepEqual(f.freed.sort(), [130,131]);
});
test('zero creation time is rejected rather than claimed as identity', () => {
  const f = fixture(); const load = f.koffi.load;
  f.koffi.load = (...args) => { const lib = load(...args), func = lib.func; lib.func = signature => { const fn = func(signature); return signature.includes('GetProcessTimes(') ? (...a) => { const r = fn(...a); a[1].fill(0); return r; } : fn; }; return lib; };
  assert.throws(() => query(f), { code: 'ERR_BROKER_IDENTITY', stage: 'invalid-creation-time' });
  assert.deepEqual(f.closed, [20, 10]);
});
for (const [change, stage] of [[{pid:0},'invalid-pid'], [{dead:true},'server-exited'], [{mismatch:true},'server-changed'], [{oversize:true},'invalid-image']]) test(`rejects ${stage} and closes all acquired resources`, () => {
  const f = fixture(change); assert.throws(() => query(f), { code:'ERR_BROKER_IDENTITY', stage });
  assert.ok(f.closed.includes(10)); assert.equal(new Set(f.closed).size, f.closed.length);
  if (stage === 'server-exited' || stage === 'server-changed') { assert.deepEqual(f.freed.sort(), [130,131]); assert.equal(f.closed.length, 4); }
});
test('different current TokenUser returns false, never exposes SID', () => { const f = fixture({otherUser:true}); assert.equal(query(f).sameUser, false); assert.deepEqual(f.freed.sort(), [130,131]); });
for (const name of ['CreateFileW','GetNamedPipeServerProcessId','OpenProcess','GetProcessTimes','QueryFullProcessImageNameW','OpenProcessToken','GetTokenInformation','ConvertSidToStringSidW','GetExitCodeProcess']) for (const throws of [false,true]) test(`normalizes ${name} ${throws ? 'exception' : 'Win32 error'} and unwinds resources`, () => {
  const f = fixture({fail:name,throw:throws}); assert.throws(() => query(f), e => e.code === 'ERR_BROKER_IDENTITY' && e.message.length < 100 && !e.message.includes('SECRET'));
  const opened = f.calls.includes('OpenProcess') && name !== 'OpenProcess' ? [10,20] : name === 'CreateFileW' ? [] : [10];
  for (const h of opened) assert.ok(f.closed.includes(h));
  if (['GetTokenInformation','ConvertSidToStringSidW'].includes(name)) assert.ok(f.closed.includes(30));
  if (name === 'GetExitCodeProcess') { assert.deepEqual(f.closed.sort((a,b)=>a-b), [10,20,30,31]); assert.deepEqual(f.freed.sort(), [130,131]); }
});
test('second SID conversion failure frees first SID and both token handles', () => {
  const f = fixture(); const load = f.koffi.load; let n = 0;
  f.koffi.load = (...a) => { const lib=load(...a), func=lib.func; lib.func=s => { const fn=func(s); return s.includes('ConvertSidToStringSidW(') ? (...args) => ++n === 2 ? 0 : fn(...args) : fn; }; return lib; };
  assert.throws(() => query(f), {stage:'sid-string'}); assert.deepEqual(f.freed,[130]); assert.deepEqual(f.closed.sort((a,b)=>a-b),[10,20,30,31]);
});
test('SID decode exception frees allocated OS strings and handles', () => { const f=fixture(); const decode=f.koffi.decode; f.koffi.decode=(...a)=>{if(!Buffer.isBuffer(a[0])) throw Error('SECRET'); return decode(...a);}; assert.throws(()=>query(f),{stage:'sid-string'}); assert.deepEqual(f.freed,[130]); assert.deepEqual(f.closed.sort((a,b)=>a-b),[10,20,30]); });
test('SID decoding is bounded and exhaustion releases OS allocation', () => { const f=fixture(); const decode=f.koffi.decode; let reads=0; f.koffi.decode=(...a)=>{if(!Buffer.isBuffer(a[0])) { reads++; return 65; } return decode(...a);}; assert.throws(()=>query(f),{stage:'invalid-sid'}); assert.equal(reads,184); assert.deepEqual(f.freed,[130]); assert.deepEqual(f.closed.sort((a,b)=>a-b),[10,20,30]); });
test('cleanup exceptions do not prevent attempts to release other owned resources', () => { const f=fixture({fail:'LocalFree',throw:true}); assert.equal(query(f).pid,42); assert.equal(f.calls.filter(n=>n==='LocalFree').length,2); assert.deepEqual(f.closed.sort((a,b)=>a-b),[10,20,30,31]); });
test('rejects unsupported hosts and malformed endpoints before loading FFI', () => { const api=require(source); assert.throws(()=>api.queryWindowsBrokerIdentity(pipe,{platform:'linux'}),{stage:'unsupported-platform'}); assert.throws(()=>api.queryWindowsBrokerIdentity('C:\\secret',{platform:'win32'}),{stage:'invalid-pipe'}); });
