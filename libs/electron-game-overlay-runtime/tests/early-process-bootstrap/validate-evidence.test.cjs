'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvidence } = require('./validate-evidence.cjs');

function evidence() {
  const pid = 1234;
  const creationTime100ns = '134380243768718097';
  const events = [
    'bootstrap-attach', 'bootstrap-ready', 'original-dll-attach-entry',
    'original-dll-attach-return', 'host-crt-initializer-entry',
    'original-graphics-initializer-begin', 'bootstrap-create-device-enter',
    'bootstrap-create-device-return', 'original-initializer-device-result',
    'original-initializer-queue-result', 'original-graphics-initializer-end',
    'host-crt-initializer-return', 'host-entry', 'host-present-completed',
  ];
  return {
    launcher: {
      schemaVersion: 1, scope: 'isolated-first-import-controlled-host-proof', passed: true,
      phase: 'complete', pid, creationTime100ns,
      targetPath: 'C:\\owned\\run-1\\early_process_bootstrap_host.exe',
      bootstrapPath: 'C:\\owned\\run-1\\early_process_bootstrap64.dll',
      identityVerified: true, ownedChildJobBound: true, resumed: true, previousSuspendCount: 1, timedOut: false,
      createProcessCalls: 1, helperCreationRejected: false,
      terminatedOwnedChild: false, errorCode: 0, childExitCode: 0,
      loadsReShade: false, productionActivation: false,
    },
    host: {
      schemaVersion: 1, scope: 'controlled-first-import-D3D12-pre-main-proof', passed: true,
      processId: pid, creationTime100ns, framesRequested: 60, framesCompleted: 60,
      originalDllAttachEntered: true, originalDllAttachReturned: true,
      graphicsInitializationPhase: 'exe-crt-before-main', preMainInitializerReturned: true,
      initializerEntered: true, initializerReturned: true, initializerTraceOkay: true,
      initializerReferencesTransferred: true, initializerDeviceHr: '0x00000000',
      initializerQueueHr: '0x00000000', resultHr: '0x00000000', queueDeviceIdentityMatches: true,
      loadsReShade: false, provesAutomaticAttachment: false, bootstrapOrderingValidatedByController: false,
    },
    trace: events.map((event, index) => ({
      schemaVersion: 1, event, pid, creationTime100ns, threadId: 1235,
      qpc: (100000000000n + BigInt(index)).toString(), statusCode: '0x00000000',
      count: index === 6 || index === 7 ? 1 : index === 13 ? 60 : 0,
    })),
  };
}

test('binds ordered first-import hook evidence to one exact controlled child and 60 real presents', () => {
  const result = validateEvidence(evidence());
  assert.deepEqual(result, {
    schemaVersion: 1, scope: 'validated-isolated-first-import-controlled-host-proof', passed: true,
    processId: 1234, creationTime100ns: '134380243768718097',
    targetPath: 'C:\\owned\\run-1\\early_process_bootstrap_host.exe',
    initializationThreadId: 1235, traceEventCount: 14,
    firstImportOrderingProven: true, d3d12InitializerHookProven: true, realPresentCount: 60,
    graphicsInitializationPhase: 'exe-crt-before-main',
    loadsReShade: false, productionActivation: false, automaticAttachmentProven: false,
  });
  assert.ok(Object.isFrozen(result));
});

const invalid = [
  ['another host PID', data => { data.host.processId++; }],
  ['a reused PID with another creation time', data => { data.trace[3].creationTime100ns = '134380243768718098'; }],
  ['lossy numeric creation time', data => { data.launcher.creationTime100ns = 134380243768718097; }],
  ['a dropped hook return', data => { data.trace.splice(7, 1); }],
  ['a duplicate hook enter', data => { data.trace.splice(7, 0, { ...data.trace[6] }); }],
  ['the original DLL attaching before bootstrap readiness', data => {
    [data.trace[1], data.trace[2]] = [data.trace[2], data.trace[1]];
  }],
  ['a failed hook result', data => { data.trace[7].statusCode = '0x80004005'; }],
  ['a failed bootstrap event', data => { data.trace[1].event = 'bootstrap-hook-failed'; }],
  ['another loader thread', data => { data.trace[3].threadId++; }],
  ['a regressing clock', data => { data.trace[8].qpc = '1'; }],
  ['a second device call', data => { data.trace[6].count = 2; }],
  ['incomplete presentations', data => { data.host.framesCompleted = 59; }],
  ['a substituted frame count', data => { data.host.framesCompleted = data.host.framesRequested = data.trace[13].count = 120; }],
  ['the old unsupported DLLMain graphics stress scope', data => { data.host.scope = 'controlled-first-import-D3D12-initializer-proof'; }],
  ['missing original DLL attach evidence', data => { delete data.host.originalDllAttachEntered; }],
  ['an incomplete original DLL attach', data => { data.host.originalDllAttachReturned = false; }],
  ['another graphics initialization phase', data => { data.host.graphicsInitializationPhase = 'dll-process-attach'; }],
  ['an incomplete pre-main initializer', data => { data.host.preMainInitializerReturned = false; }],
  ['a failed original queue initialization', data => { data.host.initializerQueueHr = '0x80004005'; }],
  ['unverified queue/device identity', data => { data.host.queueDeviceIdentityMatches = false; }],
  ['a timed-out child', data => { data.launcher.timedOut = true; }],
  ['missing owned-child job evidence', data => { delete data.launcher.ownedChildJobBound; }],
  ['an unbound owned child', data => { data.launcher.ownedChildJobBound = false; }],
  ['a second process-creation attempt', data => { data.launcher.createProcessCalls = 2; }],
  ['a rejected helper-creation fallback', data => { data.launcher.helperCreationRejected = true; }],
  ['a terminated child', data => { data.launcher.terminatedOwnedChild = true; }],
  ['an unexpected suspend count', data => { data.launcher.previousSuspendCount = 2; }],
  ['another target executable', data => { data.launcher.targetPath = 'C:\\owned\\run-1\\game.exe'; }],
  ['a bootstrap from another directory', data => { data.launcher.bootstrapPath = 'C:\\other\\early_process_bootstrap64.dll'; }],
  ['a ReShade success claim', data => { data.launcher.loadsReShade = true; }],
  ['a production activation claim', data => { data.launcher.productionActivation = true; }],
  ['an automatic attachment claim', data => { data.host.provesAutomaticAttachment = true; }],
  ['host self-certified ordering', data => { data.host.bootstrapOrderingValidatedByController = true; }],
];

for (const [label, mutate] of invalid) {
  test(`rejects ${label}`, () => {
    const data = evidence();
    mutate(data);
    assert.throws(() => validateEvidence(data), /First-import evidence rejected:/);
  });
}

test('allows equal QPC timestamps without weakening event-file ordering', () => {
  const data = evidence();
  for (const item of data.trace) item.qpc = '100000000000';
  assert.equal(validateEvidence(data).firstImportOrderingProven, true);
});
