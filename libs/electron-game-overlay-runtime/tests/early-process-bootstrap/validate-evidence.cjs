'use strict';

// Evidence validation only. This file starts no process and installs no hooks.
const fs = require('node:fs');
const path = require('node:path');

const expectedEvents = Object.freeze([
  'bootstrap-attach',
  'bootstrap-ready',
  'original-dll-attach-entry',
  'original-dll-attach-return',
  'host-crt-initializer-entry',
  'original-graphics-initializer-begin',
  'bootstrap-create-device-enter',
  'bootstrap-create-device-return',
  'original-initializer-device-result',
  'original-initializer-queue-result',
  'original-graphics-initializer-end',
  'host-crt-initializer-return',
  'host-entry',
  'host-present-completed',
]);

function check(condition, message) {
  if (!condition) throw new Error(`First-import evidence rejected: ${message}`);
}

function object(value, label) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function uint32(value, label, positive = false) {
  check(Number.isInteger(value) && value >= (positive ? 1 : 0) && value <= 0xffffffff,
    `${label} must be an ${positive ? 'positive ' : ''}unsigned 32-bit integer`);
}

function decimal64(value, label) {
  check(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), `${label} must be an exact positive decimal string`);
  const result = BigInt(value);
  check(result <= 0xffffffffffffffffn, `${label} exceeds unsigned 64-bit range`);
  return result;
}

function validateEvidence({ launcher, host, trace }) {
  object(launcher, 'launcher');
  object(host, 'host');
  check(launcher.schemaVersion === 1 && host.schemaVersion === 1, 'unsupported report schema');
  check(launcher.scope === 'isolated-first-import-controlled-host-proof', 'unexpected launcher scope');
  check(host.scope === 'controlled-first-import-D3D12-pre-main-proof', 'unexpected host scope');
  uint32(launcher.pid, 'launcher.pid', true);
  decimal64(launcher.creationTime100ns, 'launcher.creationTime100ns');
  check(host.processId === launcher.pid && host.creationTime100ns === launcher.creationTime100ns,
    'host process identity does not match the retained launcher identity');
  check(launcher.passed === true && launcher.phase === 'complete' && launcher.identityVerified === true &&
    launcher.ownedChildJobBound === true &&
    launcher.createProcessCalls === 1 && launcher.helperCreationRejected === false &&
    launcher.resumed === true && launcher.previousSuspendCount === 1 && launcher.timedOut === false &&
    launcher.terminatedOwnedChild === false && launcher.errorCode === 0 && launcher.childExitCode === 0,
  'launcher did not complete one verified suspended-child launch successfully');
  check(typeof launcher.targetPath === 'string' && path.win32.isAbsolute(launcher.targetPath) &&
    path.win32.basename(launcher.targetPath).toLowerCase() === 'early_process_bootstrap_host.exe',
  'target must be the absolute path of the controlled host');
  check(typeof launcher.bootstrapPath === 'string' && path.win32.isAbsolute(launcher.bootstrapPath) &&
    /^early_process_bootstrap(?:32|64)\.dll$/i.test(path.win32.basename(launcher.bootstrapPath)) &&
    path.win32.dirname(launcher.bootstrapPath).toLowerCase() === path.win32.dirname(launcher.targetPath).toLowerCase(),
  'bootstrap must be the architecture-named DLL beside the controlled host');
  check(launcher.loadsReShade === false && launcher.productionActivation === false,
    'launcher scope must explicitly exclude ReShade and production activation');
  check(host.passed === true && host.framesRequested === 60 && host.framesCompleted === 60 &&
    host.originalDllAttachEntered === true && host.originalDllAttachReturned === true &&
    host.graphicsInitializationPhase === 'exe-crt-before-main' && host.preMainInitializerReturned === true &&
    host.initializerEntered === true && host.initializerReturned === true && host.initializerTraceOkay === true &&
    host.initializerReferencesTransferred === true && host.queueDeviceIdentityMatches === true &&
    host.initializerDeviceHr === '0x00000000' && host.initializerQueueHr === '0x00000000' &&
    host.resultHr === '0x00000000',
  'host did not prove initializer-created graphics and exactly 60 successful presents');
  check(host.loadsReShade === false && host.provesAutomaticAttachment === false &&
    host.bootstrapOrderingValidatedByController === false,
  'host scope must exclude ReShade, automatic attachment, and self-certified ordering');
  check(Array.isArray(trace) && trace.length === expectedEvents.length,
    'trace must contain exactly the bounded expected event sequence');

  let priorQpc = 0n;
  let initializationThread;
  for (let index = 0; index < trace.length; index++) {
    const entry = trace[index];
    object(entry, `trace[${index}]`);
    check(entry.schemaVersion === 1, `trace[${index}] has an unsupported schema`);
    check(entry.pid === launcher.pid && entry.creationTime100ns === launcher.creationTime100ns,
      `trace[${index}] belongs to another process instance`);
    check(entry.event === expectedEvents[index], `trace[${index}] must be ${expectedEvents[index]}`);
    check(entry.statusCode === '0x00000000', `trace[${index}] reported a failed status`);
    uint32(entry.threadId, `trace[${index}].threadId`, true);
    uint32(entry.count, `trace[${index}].count`);
    const qpc = decimal64(entry.qpc, `trace[${index}].qpc`);
    check(qpc >= priorQpc, `trace[${index}] has a regressing QPC timestamp`);
    priorQpc = qpc;
    initializationThread ??= entry.threadId;
    if (index <= 12) check(entry.threadId === initializationThread,
      `trace[${index}] did not execute on the initial loader/entry thread`);
    const expectedCount = index === 6 || index === 7 ? 1 : index === 13 ? 60 : 0;
    check(entry.count === expectedCount, `trace[${index}] has an unexpected call/frame count`);
  }

  return Object.freeze({
    schemaVersion: 1,
    scope: 'validated-isolated-first-import-controlled-host-proof',
    passed: true,
    processId: launcher.pid,
    creationTime100ns: launcher.creationTime100ns,
    targetPath: launcher.targetPath,
    initializationThreadId: initializationThread,
    traceEventCount: trace.length,
    firstImportOrderingProven: true,
    d3d12InitializerHookProven: true,
    graphicsInitializationPhase: 'exe-crt-before-main',
    realPresentCount: 60,
    loadsReShade: false,
    productionActivation: false,
    automaticAttachmentProven: false,
  });
}

function readRegular(file) {
  check(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),
    `${path.basename(file)} must be a regular file`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

if (require.main === module) {
  try {
    check(process.argv.length === 3, 'usage: node validate-evidence.cjs <owned-stage-directory>');
    const directory = fs.realpathSync(process.argv[2]);
    check(fs.statSync(directory).isDirectory(), 'stage must be an existing directory');
    check(readRegular(path.join(directory, 'owned-run.txt')) === 'EGO_EARLY_PROCESS_BOOTSTRAP_V1\n',
      'stage does not carry the controlled-run marker');
    const result = validateEvidence({
      launcher: JSON.parse(readRegular(path.join(directory, 'launcher-result.json'))),
      host: JSON.parse(readRegular(path.join(directory, 'host-result.json'))),
      trace: readRegular(path.join(directory, 'trace.ndjson')).trim().split(/\r?\n/).map(line => JSON.parse(line)),
    });
    const destination = path.join(directory, 'validation-result.json');
    check(!fs.existsSync(destination) || (fs.lstatSync(destination).isFile() && !fs.lstatSync(destination).isSymbolicLink()),
      'validation-result.json must not be a link or directory');
    fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateEvidence };
