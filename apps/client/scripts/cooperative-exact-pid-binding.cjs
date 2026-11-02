'use strict';

const path = require('node:path');

// Capture only the bounded nonsecret argv used by an exact-PID injector. The
// controller independently compares its creation binding to a retained OS
// handle; a legacy PID-only stdout line is not a creation-time witness.
function collectExactPidBinding(invocation, target) {
  const args = invocation?.arguments;
  if (!Array.isArray(args) || args.length < 5 || args.length > 10 || args.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !path.isAbsolute(args[0]) || path.resolve(args[0]).toLowerCase() !== path.resolve(target.executablePath).toLowerCase() ||
      !path.isAbsolute(invocation.executable || '') || !path.isAbsolute(invocation.workingDirectory || '')) {
    throw new Error('Injector invocation did not bind the exact target image.');
  }
  const flags = new Map();
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (flags.has(key) || !['--pid', '--expected-creation-time-100ns', '--preloaded-addon-name', '--addon-only'].includes(key)) {
      throw new Error('Injector invocation has ambiguous exact-target flags.');
    }
    if (key === '--addon-only') flags.set(key, true);
    else {
      index++;
      if (index >= args.length || args[index].startsWith('--')) throw new Error('Injector invocation omitted a flag value.');
      flags.set(key, args[index]);
    }
  }
  const targetPid = flags.get('--pid');
  const created = flags.get('--expected-creation-time-100ns');
  if (!/^[1-9][0-9]{0,9}$/u.test(targetPid || '') || Number(targetPid) !== target.pid || Number(targetPid) > 0xffffffff ||
      !/^[1-9][0-9]{0,19}$/u.test(created || '') || BigInt(created) > 0xffffffffffffffffn) {
    throw new Error('Injector invocation omitted or changed its creation-bound PID.');
  }
  const selectedLeaf = flags.get('--preloaded-addon-name');
  if (selectedLeaf !== undefined && !/^ego-preload-[a-f0-9]{32}-[A-Fa-f0-9]{32}-[a-f0-9]{16}\.addon64$/u.test(selectedLeaf)) {
    throw new Error('Injector invocation has an invalid preloaded add-on selector.');
  }
  const runDirectory = path.resolve(invocation.workingDirectory);
  const injectorExecutable = path.resolve(invocation.executable);
  if (path.dirname(injectorExecutable).toLowerCase() !== runDirectory.toLowerCase() || path.basename(injectorExecutable).toLowerCase() !== 'inject.exe') {
    throw new Error('Injector invocation escaped its owned stage.');
  }
  return {
    pid: Number(targetPid), creationTime100ns: created, executablePath: path.resolve(args[0]),
    runDirectory, injectorExecutable, arguments: [...args],
    ...(selectedLeaf === undefined ? {} : { preloadedAddonName: selectedLeaf }),
  };
}

module.exports = { collectExactPidBinding };
