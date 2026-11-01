'use strict';

// Native evidence validation only. Starts no process, loads no DLL, and makes
// no claim about the controller's separate overlay-pixel or input assertions.
const fs = require('node:fs');
const path = require('node:path');

const expectedEvents = Object.freeze([
  'restore-attach',
  'restore-owned-reshade-present',
  'restore-imports-complete',
  'original-dll-attach-entry',
  'original-dll-attach-return',
  'host-crt-initializer-entry',
  'actual-reshade-host-verified',
  'actual-reshade-restore-state-verified',
  'original-graphics-initializer-begin',
  'original-initializer-device-result',
  'original-initializer-queue-result',
  'original-graphics-initializer-end',
  'host-crt-initializer-return',
  'host-entry',
  'host-resize-completed',
  'host-present-completed',
]);

function check(condition, message) {
  if (!condition) throw new Error(`Actual-ReShade native evidence rejected: ${message}`);
}

function object(value, label) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function uint32(value, label, positive = false) {
  check(Number.isInteger(value) && value >= (positive ? 1 : 0) && value <= 0xffffffff,
    `${label} must be an ${positive ? 'positive ' : ''}unsigned 32-bit integer`);
}

function decimal64(value, label) {
  check(typeof value === 'string' && /^[1-9][0-9]*$/.test(value),
    `${label} must be an exact positive decimal string`);
  const result = BigInt(value);
  check(result <= 0xffffffffffffffffn, `${label} exceeds unsigned 64-bit range`);
  return result;
}

function windowsPath(value, label) {
  check(typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/u.test(value) &&
    path.win32.isAbsolute(value), `${label} must be an absolute Windows file path`);
  return path.win32.normalize(value).toLowerCase();
}

function validateEvidence({ launcher, host, trace }) {
  object(launcher, 'launcher');
  object(host, 'host');
  check(launcher.schemaVersion === 1 && host.schemaVersion === 1, 'unsupported native report schema');
  check(launcher.scope === 'isolated-first-import-reshade-controlled-host-proof', 'unexpected launcher scope');
  check(host.scope === 'controlled-first-import-actual-ReShade-D3D12-pre-main-proof', 'unexpected host scope');
  uint32(launcher.pid, 'launcher.pid', true);
  decimal64(launcher.creationTime100ns, 'launcher.creationTime100ns');
  check(host.pid === launcher.pid && host.creationTime100ns === launcher.creationTime100ns,
    'host identity does not match the native retained process instance');
  check(launcher.passed === true && launcher.phase === 'complete' && launcher.identityVerified === true &&
    launcher.ownedChildJobBound === true && launcher.createProcessCalls === 1 &&
    launcher.helperCreationRejected === false && launcher.resumed === true &&
    launcher.previousSuspendCount === 1 && launcher.timedOut === false &&
    launcher.terminatedOwnedChild === false && launcher.errorCode === 0 && launcher.childExitCode === 0 &&
    launcher.failure === '', 'launcher did not complete one bounded, owned suspended-child launch');

  const targetPath = windowsPath(launcher.targetPath, 'launcher.targetPath');
  const directory = path.win32.dirname(targetPath);
  check(path.win32.basename(targetPath) === 'early_reshade_bootstrap_host.exe',
    'target is not the fixed controlled host');
  check(windowsPath(host.exactImagePath, 'host.exactImagePath') === targetPath,
    'host executable differs from the retained target');
  const reshadePath = windowsPath(launcher.reshadePath, 'launcher.reshadePath');
  const architecture = /^reshade(32|64)\.dll$/u.exec(path.win32.basename(reshadePath));
  check(architecture !== null && path.win32.dirname(reshadePath) === directory,
    'ReShade must be the architecture-named runtime in the owned stage');
  const restorePath = windowsPath(launcher.restorePath, 'launcher.restorePath');
  check(path.win32.dirname(restorePath) === directory &&
    path.win32.basename(restorePath) === `early_reshade_restore${architecture[1]}.dll`,
  'restorer must match the runtime architecture and owned stage');
  check(windowsPath(host.reshadeModulePath, 'host.reshadeModulePath') === reshadePath &&
    windowsPath(host.restorerModulePath, 'host.restorerModulePath') === restorePath,
  'mapped module reports differ from the exact first-import paths');

  uint32(launcher.ordinal1Rva, 'launcher.ordinal1Rva', true);
  uint32(launcher.ansiCodePage, 'launcher.ansiCodePage', true);
  check(launcher.firstImportDllCount === 2 && typeof launcher.ordinal1Name === 'string' &&
    launcher.ordinal1Name.trim().length > 0 && launcher.ordinal1Name.length <= 1024 &&
    !/[\u0000-\u001f]/u.test(launcher.ordinal1Name) &&
    launcher.restoreOrdinal1Validated === true && launcher.ansiPathsRoundTripVerified === true,
  'first-import PE/ordinal or lossless path validation was not completed');
  check(launcher.loadsReShade === true && launcher.productionActivation === false,
    'launcher must identify an isolated actual-ReShade proof');

  decimal64(host.windowHandle, 'host.windowHandle');
  uint32(host.nativePresentSuccesses, 'host.nativePresentSuccesses', true);
  uint32(host.framesAfterResize, 'host.framesAfterResize', true);
  uint32(host.elapsedMs, 'host.elapsedMs');
  check(host.status === 'passed' && host.resultHr === '0x00000000' && host.failure === '' &&
    host.nativePresentSuccesses >= 120 && host.framesAfterResize >= 60 &&
    host.nativePresentSuccesses - host.framesAfterResize >= 60 &&
    host.resizeSuccesses === 1 && host.resizeRequested === true && host.resizeAfterFrames === 0,
  'native graphics did not complete the controlled pre/post-resize presentation gate');
  check(host.lifetimeMs === 180000 && host.elapsedMs <= 225000,
    'native lifetime does not match the isolated bounded proof');
  check(host.originalDllAttachEntered === true && host.originalDllAttachReturned === true &&
    host.graphicsInitializationPhase === 'exe-crt-before-main' &&
    host.preMainInitializerReturned === true && host.preMainInitializerOkay === true &&
    host.initializerEntered === true && host.initializerReturned === true &&
    host.initializerTraceOkay === true && host.initializerReferencesTransferred === true &&
    host.initializerDeviceHr === '0x00000000' && host.initializerQueueHr === '0x00000000' &&
    host.queueDeviceIdentityMatches === true,
  'supported pre-main graphics initialization or exact device/queue identity is incomplete');
  check(host.reshadePresentBeforeCrt === true && host.reshadeFromStageBeforeCrt === true &&
    host.reshadeExportsValidBeforeCrt === true && host.reshadeModuleCountBeforeCrt === 1 &&
    host.reshadeModuleEnumerationCompleteBeforeCrt === true && host.restoreStateVerified === true,
  'owned ReShade or restored imports were not verified before graphics initialization');
  check(host.closeRequested === true && host.windowDestroyed === true && host.cleanupCompleted === true &&
    host.stopReason === 'close-requested', 'host did not close and clean up through its owned normal path');
  check(host.hostCallsLoadLibrary === false && host.provesAutomaticAttachment === false &&
    host.physicalKeyboardProven === false,
  'host must exclude direct DLL loading, automatic attachment, and physical-input claims');

  object(host.restoreState, 'host.restoreState');
  const state = host.restoreState;
  check(state.structSize === 40 && state.abiVersion === 1 && state.processId === launcher.pid &&
    state.creationTime100ns === launcher.creationTime100ns && state.restoredImports === 1 &&
    state.ownedHostPresent === 1, 'restoration POD does not match ABI 1 and the retained process instance');
  uint32(state.threadId, 'host.restoreState.threadId', true);
  const module = decimal64(state.reshadeModule, 'host.restoreState.reshadeModule');
  if (architecture[1] === '32') check(module <= 0xffffffffn, '32-bit module handle exceeds its address width');

  check(Array.isArray(trace) && trace.length === expectedEvents.length,
    'trace must contain exactly the bounded expected native event sequence');
  let priorQpc = 0n;
  let initializationThread;
  for (let index = 0; index < trace.length; index++) {
    const entry = trace[index];
    object(entry, `trace[${index}]`);
    check(entry.schemaVersion === 1 && entry.pid === launcher.pid &&
      entry.creationTime100ns === launcher.creationTime100ns,
    `trace[${index}] does not belong to this exact process instance`);
    check(entry.event === expectedEvents[index], `trace[${index}] must be ${expectedEvents[index]}`);
    check(entry.statusCode === '0x00000000', `trace[${index}] reported a failed native status`);
    uint32(entry.threadId, `trace[${index}].threadId`, true);
    uint32(entry.count, `trace[${index}].count`);
    const qpc = decimal64(entry.qpc, `trace[${index}].qpc`);
    check(qpc >= priorQpc, `trace[${index}] has a regressing timestamp`);
    priorQpc = qpc;
    initializationThread ??= entry.threadId;
    check(entry.threadId === initializationThread,
      `trace[${index}] changed the initial loader/graphics thread`);
    const expectedCount = index === 14 ? 1 : index === 15 ? host.nativePresentSuccesses : 0;
    check(entry.count === expectedCount, `trace[${index}] has an unexpected lifecycle count`);
  }
  check(state.threadId === initializationThread,
    'restoration POD did not originate on the verified initial thread');

  return Object.freeze({
    schemaVersion: 1,
    scope: 'validated-isolated-first-import-actual-ReShade-native-proof',
    passed: true,
    processId: launcher.pid,
    creationTime100ns: launcher.creationTime100ns,
    targetPath: launcher.targetPath,
    reshadePath: launcher.reshadePath,
    restorePath: launcher.restorePath,
    architecture: architecture[1] === '64' ? 'x64' : 'Win32',
    initializationThreadId: initializationThread,
    traceEventCount: trace.length,
    ownedReShadeFirstImportProven: true,
    importsRestoredBeforeGraphicsProven: true,
    d3d12PreMainGraphicsProven: true,
    graphicsInitializationPhase: 'exe-crt-before-main',
    nativeResizeLifecycleProven: true,
    realPresentCount: host.nativePresentSuccesses,
    realPostResizePresentCount: host.framesAfterResize,
    loadsReShade: true,
    renderedOverlayPixelsProven: false,
    syntheticForegroundInputProven: false,
    physicalKeyboardProven: false,
    automaticAttachmentProven: false,
    productionActivation: false,
  });
}

function readRegular(file, maximumBytes = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBytes,
    `${path.basename(file)} must be a bounded regular file`);
  return fs.readFileSync(file, 'utf8');
}

if (require.main === module) {
  try {
    check(process.argv.length === 3, 'usage: node validate-sdk-proof.cjs <owned-stage-directory>');
    const directory = fs.realpathSync(process.argv[2]);
    check(fs.statSync(directory).isDirectory(), 'stage must be an existing directory');
    check(readRegular(path.join(directory, 'owned-run.txt'), 128) === 'EGO_EARLY_RESHADE_BOOTSTRAP_V1\n',
      'stage does not carry the exact controlled-run marker');
    const parse = file => JSON.parse(readRegular(path.join(directory, file)).replace(/^\uFEFF/u, ''));
    const result = validateEvidence({
      launcher: parse('launcher-result.json'),
      host: parse('host-report.json'),
      trace: readRegular(path.join(directory, 'trace.ndjson'), 32768).trim()
        .split(/\r?\n/u).map(line => JSON.parse(line)),
    });
    const destination = path.join(directory, 'native-proof-validation.json');
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      check(stat.isFile() && !stat.isSymbolicLink(), 'native-proof-validation.json must not be a link or directory');
    }
    fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateEvidence };
