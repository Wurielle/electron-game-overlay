'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const evidence = require('./evidence-ui-busy-2026-11-01.json');

test('the old negative remains failed and establishes no feature acceptance', () => {
  const negative = evidence.negativeControl;
  assert.equal(negative.runtimeGeneration, 15);
  assert.equal(negative.architecture, 'x64');
  assert.equal(negative.status, 'failed');
  assert.equal(negative.expectedFailureControl, true);
  assert.equal(negative.featureAcceptancePassed, false);
  assert.equal(negative.nativeWin32Error, 1460);
  assert.equal(negative.failureCode, 'runtime-input-routing-failed');
  assert.match(negative.retainedNativeLogLine, /Win32 error 1460/);
  assert.equal(negative.completedInputWindows, 0);
});

test('both positive architectures retain matched native identities and post-resume readiness', () => {
  assert.deepEqual(evidence.positiveControls.map(control => control.architecture), ['x64', 'Win32']);
  for (const control of evidence.positiveControls) {
    assert.equal(control.status, 'passed');
    assert.equal(control.runtimeGeneration, 16);
    assert.equal(control.addonBuildId, 'E8FE3783F29E4FB297D8B006D0087725');
    assert.equal(control.packageManifest.matchedRetainedStagedPeBytes, true);
    assert.equal(control.packageManifest.record.addonSha256.toLowerCase(), control.hashes.addon);
    assert.equal(control.packageManifest.record.reshadeRuntimeSha256.toLowerCase(), control.hashes.runtime);
    assert.notEqual(control.uiBusy.ownerThreadId, control.uiBusy.presentationThreadId);
    assert.ok(control.uiBusy.observedMs >= 2800);
    assert.ok(control.uiBusy.nativePresentCalls >= 6);
    assert.equal(control.uiBusy.adoptions, 2);
    for (const event of control.uiBusy.postResumeReadyEvents) assert.ok(event.afterResumeMs >= 0);
  }
  assert.equal(evidence.negativeControl.hashes.host, evidence.positiveControls[0].hashes.host);
});

test('positive evidence separates DOM delivery from native blocking, release and stopped-producer state', () => {
  for (const control of evidence.positiveControls) {
    const blocked = control.keyboard.interceptedAfterLifecycle;
    assert.equal(blocked.expectedBlocked, true);
    assert.equal(blocked.acknowledgementSnapshot, true);
    assert.ok(blocked.domDeltas.down > 0 && blocked.domDeltas.up > 0);
    for (const value of Object.values(blocked.nativeDeltas)) assert.equal(value, 0);
    for (const value of Object.values(blocked.pollDownSamples)) assert.equal(value, 0);
    for (const name of ['releasedBeforeLifecycle', 'releasedAfterLifecycle', 'releasedAfterProducerDisconnect']) {
      const released = control.keyboard[name];
      assert.equal(released.expectedBlocked, false);
      assert.ok(released.newNativeSamplesDuringActualHold >= 3);
      assert.equal(released.outsideUninjectedControllerObservedDown, true);
      for (const value of Object.values(released.nativeDeltas)) assert.ok(value > 0);
      for (const value of Object.values(released.pollDownSamples)) assert.ok(value > 0);
    }
    assert.equal(control.keyboard.releasedAfterLifecycle.acknowledgementSnapshot, false);
    assert.equal(control.keyboard.releasedAfterProducerDisconnect.producerSnapshotIsStale, true);
    assert.equal(control.cursor.baseline, control.cursor.released);
    assert.notEqual(control.cursor.baseline, control.cursor.text);
    assert.equal(control.cursor.clipBaseline, control.cursor.clipReleased);
    assert.equal(control.retirement.nativeRetirements, 2);
    assert.equal(control.retirement.renderFailures, 0);
    assert.equal(control.retirement.quarantines, 0);
    assert.deepEqual(control.retirement.windowAndRankIdsAfterProducerExit, []);
    for (const child of control.retirement.childExitCodes) {
      assert.equal(child.exitCode, 0);
      assert.equal(child.cleanupTerminationRequested, false);
    }
  }
});

test('controlled synthetic evidence does not claim broader game or capability acceptance', () => {
  for (const key of ['automaticProcessAttachmentProven', 'realGameAcceptanceProven',
    'physicalInputProven', 'bufferedRawInputAcceptanceProven', 'packageCompatibilityClaim']) {
    assert.equal(evidence.scope[key], false, key);
  }
  assert.match(evidence.scope.sdkContinuityLimit, /entry shim alone does not establish/i);
});
