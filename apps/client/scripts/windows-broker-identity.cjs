'use strict';

// Point-in-time OS observation only; never authorizes termination or ownership.
function queryWindowsBrokerIdentity(pipePath, options = {}) {
  const failure = (stage, win32) => Object.assign(new Error(`Windows broker identity: ${stage}`), { code: 'ERR_BROKER_IDENTITY', stage, ...(win32 === undefined ? {} : { win32 }) });
  if ((options.platform ?? process.platform) !== 'win32') throw failure('unsupported-platform');
  if (typeof pipePath !== 'string' || !/^\\\\\.\\pipe\\[^\\\x00-\x1f]{1,240}$/.test(pipePath)) throw failure('invalid-pipe');
  const cleanup = [];
  let stage = 'ffi-load';
  try {
    const k = options.koffi ?? require('koffi');
    const kernel = k.load('kernel32.dll'), advapi = k.load('advapi32.dll');
    const bind = (lib, signature) => lib.func(signature);
    const create = bind(kernel, 'void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)');
    const server = bind(kernel, 'int __stdcall GetNamedPipeServerProcessId(void *pipe, void *pid)');
    const open = bind(kernel, 'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
    const times = bind(kernel, 'int __stdcall GetProcessTimes(void *process, void *creation, void *exitTime, void *kernelTime, void *userTime)');
    const image = bind(kernel, 'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, void *size)');
    const exit = bind(kernel, 'int __stdcall GetExitCodeProcess(void *process, void *code)');
    const current = bind(kernel, 'void * __stdcall GetCurrentProcess()');
    const close = bind(kernel, 'int __stdcall CloseHandle(void *handle)');
    const free = bind(kernel, 'void * __stdcall LocalFree(void *memory)');
    const last = bind(kernel, 'uint32_t __stdcall GetLastError()');
    const token = bind(advapi, 'int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)');
    const info = bind(advapi, 'int __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, void *needed)');
    const sidString = bind(advapi, 'int __stdcall ConvertSidToStringSidW(void *sid, void *string)');
    const check = value => { if (!value) throw failure(stage, last()); return value; };
    const own = (handle, dispose) => { cleanup.push(() => dispose(handle)); return handle; };
    stage = 'pipe-open';
    const pipe = create(pipePath, 0, 0, null, 3, 0, null);
    const openError = last();
    const pointerBits = k.sizeof('void *') * 8;
    const pipeAddress = pipe === null ? 0n : k.address(pipe);
    if (pipeAddress === 0n || BigInt.asUintN(pointerBits, pipeAddress) === (1n << BigInt(pointerBits)) - 1n) throw failure(stage, openError);
    own(pipe, close);
    stage = 'pipe-pid';
    const pidBuffer = Buffer.alloc(4); check(server(pipe, pidBuffer));
    const pid = pidBuffer.readUInt32LE(); if (!pid) throw failure('invalid-pid');
    stage = 'process-open'; const processHandle = own(check(open(0x1000, 0, pid)), close);
    stage = 'process-times'; const created = Buffer.alloc(8);
    check(times(processHandle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)));
    const creationTime100ns = created.readBigUInt64LE().toString();
    if (creationTime100ns === '0') throw failure('invalid-creation-time');
    stage = 'process-image'; const buffer = Buffer.alloc(32768 * 2), size = Buffer.alloc(4); size.writeUInt32LE(32768);
    check(image(processHandle, 0, buffer, size));
    const count = size.readUInt32LE(); if (!count || count >= 32768) throw failure('invalid-image');
    const executablePath = buffer.toString('utf16le', 0, count * 2);
    if (executablePath.includes('\0') || !/^(?:[a-z]:\\|\\\\)/i.test(executablePath)) throw failure('invalid-image');
    const readUser = handle => {
      stage = 'token-open'; const output = Buffer.alloc(k.sizeof('void *'));
      check(token(handle, 8, output)); const tokenHandle = own(k.decode(output, 0, 'void *'), close);
      stage = 'token-user'; const data = Buffer.alloc(4096), needed = Buffer.alloc(4);
      check(info(tokenHandle, 1, data, data.length, needed));
      if (needed.readUInt32LE() > data.length || needed.readUInt32LE() < k.sizeof('void *')) throw failure('invalid-token');
      const sid = k.decode(data, 0, 'void *');
      stage = 'sid-string'; const result = Buffer.alloc(k.sizeof('void *')); check(sidString(sid, result));
      const string = own(k.decode(result, 0, 'void *'), free);
      let value = '';
      // Windows SID text has a documented finite maximum; no unbounded C string decode.
      for (let i = 0; i < 184; i++) { const c = k.decode(string, i * 2, 'uint16_t'); if (!c) return value; value += String.fromCharCode(c); }
      throw failure('invalid-sid');
    };
    const sameUser = readUser(processHandle) === readUser(current());
    stage = 'process-exit'; const code = Buffer.alloc(4); check(exit(processHandle, code));
    if (code.readUInt32LE() !== 259) throw failure('server-exited');
    stage = 'pipe-recheck'; check(server(pipe, pidBuffer)); if (pidBuffer.readUInt32LE() !== pid) throw failure('server-changed');
    return { pid, creationTime100ns, executablePath, sameUser };
  } catch (error) {
    if (error?.code === 'ERR_BROKER_IDENTITY') throw error;
    throw failure(stage);
  } finally {
    for (const dispose of cleanup.reverse()) { try { dispose(); } catch { /* Attempt every owned cleanup even after a boundary exception. */ } }
  }
}

module.exports = { queryWindowsBrokerIdentity };
