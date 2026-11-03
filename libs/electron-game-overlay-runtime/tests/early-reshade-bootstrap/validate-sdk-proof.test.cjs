'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateEvidence } = require('./validate-sdk-proof.cjs');

function validEvidence(bits = '64') {
  const stage = 'C:\\owned-proof\\run-one\\stage';
  const pid = 10240;
  const creation = '134380266650351343';
  const thread = 20480;
  const names = [
    'restore-attach', 'restore-owned-reshade-present', 'restore-imports-complete',
    'original-dll-attach-entry', 'original-dll-attach-return', 'host-crt-initializer-entry',
    'actual-reshade-host-verified', 'actual-reshade-restore-state-verified',
    'original-graphics-initializer-begin', 'original-initializer-device-result',
    'original-initializer-queue-result', 'original-graphics-initializer-end',
    'host-crt-initializer-return', 'host-entry', 'host-resize-completed', 'host-present-completed',
  ];
  return {
    launcher: {
      schemaVersion: 1, scope: 'isolated-first-import-reshade-controlled-host-proof',
      passed: true, phase: 'complete', pid, creationTime100ns: creation,
      targetPath: `${stage}\\early_reshade_bootstrap_host.exe`,
      reshadePath: `${stage}\\ReShade${bits}.dll`,
      restorePath: `${stage}\\early_reshade_restore${bits}.dll`,
      identityVerified: true, ownedChildJobBound: true, createProcessCalls: 1,
      helperCreationRejected: false, resumed: true, previousSuspendCount: 1,
      timedOut: false, terminatedOwnedChild: false, errorCode: 0, childExitCode: 0,
      failure: '', firstImportDllCount: 2, ordinal1Name: 'D2D1CreateFactory', ordinal1Rva: 4096,
      restoreOrdinal1Validated: true, ansiCodePage: 1252, ansiPathsRoundTripVerified: true,
      loadsReShade: true, productionActivation: false,
    },
    host: {
      schemaVersion: 1, scope: 'controlled-first-import-actual-ReShade-D3D12-pre-main-proof',
      pid, creationTime100ns: creation, exactImagePath: `${stage}\\early_reshade_bootstrap_host.exe`,
      windowHandle: '1048576', status: 'passed', failure: '', resultHr: '0x00000000',
      elapsedMs: 10000, lifetimeMs: 180000, resizeAfterFrames: 0, resizeRequested: true,
      nativePresentSuccesses: 600, resizeSuccesses: 1, framesAfterResize: 240,
      originalDllAttachEntered: true, originalDllAttachReturned: true,
      graphicsInitializationPhase: 'exe-crt-before-main', preMainInitializerReturned: true,
      preMainInitializerOkay: true, initializerEntered: true, initializerReturned: true,
      initializerTraceOkay: true, initializerReferencesTransferred: true,
      initializerDeviceHr: '0x00000000', initializerQueueHr: '0x00000000', queueDeviceIdentityMatches: true,
      reshadeModulePath: `${stage}\\ReShade${bits}.dll`, reshadePresentBeforeCrt: true,
      reshadeFromStageBeforeCrt: true, reshadeExportsValidBeforeCrt: true,
      reshadeModuleCountBeforeCrt: 1, reshadeModuleEnumerationCompleteBeforeCrt: true,
      restorerModulePath: `${stage}\\early_reshade_restore${bits}.dll`, restoreStateVerified: true,
      restoreState: {
        structSize: 40, abiVersion: 1, processId: pid, threadId: thread,
        creationTime100ns: creation, restoredImports: 1, ownedHostPresent: 1,
        reshadeModule: bits === '64' ? '140700000000000' : '2147483648',
      },
      closeRequested: true, windowDestroyed: true, cleanupCompleted: true,
      stopReason: 'close-requested', hostCallsLoadLibrary: false,
      provesAutomaticAttachment: false, physicalKeyboardProven: false,
    },
    trace: names.map((event, index) => ({
      schemaVersion: 1, event, pid, creationTime100ns: creation,
      threadId: thread, qpc: String(1000 + index), statusCode: '0x00000000',
      count: index === 14 ? 1 : index === 15 ? 600 : 0,
    })),
  };
}

test('binds actual-ReShade first imports, restoration, supported pre-main graphics and one real resize', () => {
  const fixture = validEvidence();
  const before = structuredClone(fixture);
  const result = validateEvidence(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.architecture, 'x64');
  assert.equal(result.ownedReShadeFirstImportProven, true);
  assert.equal(result.importsRestoredBeforeGraphicsProven, true);
  assert.equal(result.realPresentCount, 600);
  assert.equal(result.realPostResizePresentCount, 240);
  assert.equal(result.renderedOverlayPixelsProven, false);
  assert.equal(result.syntheticForegroundInputProven, false);
  assert.equal(result.productionActivation, false);
  assert.deepEqual(fixture, before);
  assert.equal(Object.isFrozen(result), true);
});

test('accepts the matching 32-bit runtime/restorer and bounded module identity', () => {
  assert.equal(validateEvidence(validEvidence('32')).architecture, 'Win32');
});

const rejections = [
  ['another host PID', evidence => { evidence.host.pid++; }],
  ['a reused PID with a different creation FILETIME', evidence => { evidence.host.creationTime100ns = '134380266650351344'; }],
  ['lossy numeric creation time', evidence => { evidence.launcher.creationTime100ns = Number(evidence.launcher.creationTime100ns); }],
  ['the earlier no-ReShade proof scope', evidence => { evidence.host.scope = 'controlled-first-import-D3D12-pre-main-proof'; }],
  ['an unowned job', evidence => { evidence.launcher.ownedChildJobBound = false; }],
  ['missing owned-job evidence', evidence => { delete evidence.launcher.ownedChildJobBound; }],
  ['a helper-process fallback', evidence => { evidence.launcher.createProcessCalls = 2; evidence.launcher.helperCreationRejected = true; }],
  ['an unexpected resume count', evidence => { evidence.launcher.previousSuspendCount = 2; }],
  ['a native timeout', evidence => { evidence.launcher.timedOut = true; }],
  ['a terminated target', evidence => { evidence.launcher.terminatedOwnedChild = true; }],
  ['a failed child exit', evidence => { evidence.launcher.childExitCode = 1; }],
  ['a different target executable', evidence => { evidence.launcher.targetPath = 'C:\\owned-proof\\run-one\\stage\\game.exe'; }],
  ['a runtime outside the owned stage', evidence => { evidence.launcher.reshadePath = 'C:\\foreign\\ReShade64.dll'; }],
  ['a mismatched restorer architecture', evidence => { evidence.launcher.restorePath = evidence.launcher.restorePath.replace('64', '32'); }],
  ['a different mapped runtime', evidence => { evidence.host.reshadeModulePath = 'C:\\foreign\\ReShade64.dll'; }],
  ['a different mapped restorer', evidence => { evidence.host.restorerModulePath = 'C:\\foreign\\early_reshade_restore64.dll'; }],
  ['an absent ordinal-1 RVA', evidence => { evidence.launcher.ordinal1Rva = 0; }],
  ['an absent ordinal name', evidence => { evidence.launcher.ordinal1Name = ''; }],
  ['an unchecked restorer ordinal', evidence => { evidence.launcher.restoreOrdinal1Validated = false; }],
  ['a lossy ANSI import path', evidence => { evidence.launcher.ansiPathsRoundTripVerified = false; }],
  ['a different import count', evidence => { evidence.launcher.firstImportDllCount = 1; }],
  ['an unsupported DLL-main graphics phase', evidence => { evidence.host.graphicsInitializationPhase = 'dll-process-attach'; }],
  ['a failed pre-main initializer', evidence => { evidence.host.preMainInitializerOkay = false; }],
  ['a failed graphics HRESULT', evidence => { evidence.host.initializerDeviceHr = '0x887A0004'; }],
  ['an unverified device/queue identity', evidence => { evidence.host.queueDeviceIdentityMatches = false; }],
  ['a runtime not present before CRT', evidence => { evidence.host.reshadePresentBeforeCrt = false; }],
  ['a runtime from an unverified stage', evidence => { evidence.host.reshadeFromStageBeforeCrt = false; }],
  ['unverified host exports', evidence => { evidence.host.reshadeExportsValidBeforeCrt = false; }],
  ['no enumerated ReShade host', evidence => { evidence.host.reshadeModuleCountBeforeCrt = 0; }],
  ['two enumerated ReShade hosts', evidence => { evidence.host.reshadeModuleCountBeforeCrt = 2; }],
  ['incomplete pre-main ReShade enumeration', evidence => { evidence.host.reshadeModuleEnumerationCompleteBeforeCrt = false; }],
  ['missing pre-main ReShade enumeration', evidence => { delete evidence.host.reshadeModuleEnumerationCompleteBeforeCrt; }],
  ['unverified restoration state', evidence => { evidence.host.restoreStateVerified = false; }],
  ['another restoration ABI', evidence => { evidence.host.restoreState.abiVersion = 2; }],
  ['another restoration size', evidence => { evidence.host.restoreState.structSize = 32; }],
  ['a restoration claim from another process', evidence => { evidence.host.restoreState.processId++; }],
  ['a restoration claim from another process incarnation', evidence => { evidence.host.restoreState.creationTime100ns = '134380266650351344'; }],
  ['imports that were not restored', evidence => { evidence.host.restoreState.restoredImports = 0; }],
  ['an absent owned host', evidence => { evidence.host.restoreState.ownedHostPresent = 0; }],
  ['an absent restored module handle', evidence => { evidence.host.restoreState.reshadeModule = '0'; }],
  ['a restoration claim from another thread', evidence => { evidence.host.restoreState.threadId++; }],
  ['a missing resize', evidence => { evidence.host.resizeSuccesses = 0; }],
  ['an automatic-timing resize', evidence => { evidence.host.resizeAfterFrames = 300; }],
  ['a resize without an owned request', evidence => { evidence.host.resizeRequested = false; }],
  ['insufficient post-resize presentations', evidence => { evidence.host.framesAfterResize = 59; }],
  ['insufficient pre-resize presentations', evidence => { evidence.host.framesAfterResize = 550; }],
  ['incomplete cleanup', evidence => { evidence.host.cleanupCompleted = false; }],
  ['an undestroyed target window', evidence => { evidence.host.windowDestroyed = false; }],
  ['lifetime expiry replacing the owned close path', evidence => { evidence.host.stopReason = 'lifetime-expired'; evidence.host.closeRequested = false; }],
  ['the host loading its own ReShade', evidence => { evidence.host.hostCallsLoadLibrary = true; }],
  ['a production activation claim', evidence => { evidence.launcher.productionActivation = true; }],
  ['an automatic attachment claim', evidence => { evidence.host.provesAutomaticAttachment = true; }],
  ['a physical-key claim', evidence => { evidence.host.physicalKeyboardProven = true; }],
  ['a dropped restore completion event', evidence => { evidence.trace.splice(2, 1); }],
  ['a duplicated event', evidence => { evidence.trace.splice(2, 0, evidence.trace[2]); }],
  ['the original DLL initializing before import restoration', evidence => { [evidence.trace[2], evidence.trace[3]] = [evidence.trace[3], evidence.trace[2]]; }],
  ['a failed native trace status', evidence => { evidence.trace[7].statusCode = '0x8000FFFF'; }],
  ['a trace from a reused PID', evidence => { evidence.trace[7].creationTime100ns = '134380266650351344'; }],
  ['a trace from another process', evidence => { evidence.trace[7].pid++; }],
  ['a trace from another thread', evidence => { evidence.trace[7].threadId++; }],
  ['a regressing native clock', evidence => { evidence.trace[7].qpc = '1'; }],
  ['a substituted final frame count', evidence => { evidence.trace[15].count = 599; }],
  ['a second resize event count', evidence => { evidence.trace[14].count = 2; }],
];

for (const [label, mutate] of rejections) {
  test(`rejects ${label}`, () => {
    const evidence = validEvidence();
    mutate(evidence);
    assert.throws(() => validateEvidence(evidence), /Actual-ReShade native evidence rejected:/u);
  });
}

test('rejects a 32-bit module address wider than its actual process', () => {
  const evidence = validEvidence('32');
  evidence.host.restoreState.reshadeModule = '4294967296';
  assert.throws(() => validateEvidence(evidence), /address width/u);
});

test('retains file ordering when equal QPC ticks are observed', () => {
  const evidence = validEvidence();
  evidence.trace[1].qpc = evidence.trace[0].qpc;
  assert.equal(validateEvidence(evidence).passed, true);
});
