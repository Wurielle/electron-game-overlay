'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const reportFile = path.resolve(process.argv[2] || '');
const sourceFile = path.resolve(process.argv[3] || '');
const root = path.resolve(__dirname, '../../../..'), build = fs.realpathSync(path.join(root, 'build'));
for (const file of [reportFile, sourceFile]) {
  const relative = path.relative(build, fs.realpathSync(file));
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
const digest = data => createHash('sha256').update(data).digest('hex');
const bytes = fs.readFileSync(reportFile), source = fs.readFileSync(sourceFile), report = JSON.parse(bytes);
assert.equal(report.status, 'probe-completed');
assert.equal(report.sourceRawSha256, digest(source));
assert.equal(report.sourceNormalizedSha256, digest(Buffer.from(source.toString('utf8').replace(/\r\n/g, '\n'))));
assert.ok(['x64', 'x86'].includes(report.architecture));
assert.equal(report.pointerBytes, report.architecture === 'x64' ? 8 : 4);
assert.ok([34, 38].includes(report.cases.length));
assert.equal(report.cases.filter(c => c.mode === 'immediate').length, 32);
assert.equal(report.cases.filter(c => c.mode === 'local-module-churn').length, report.cases.length - 34);
for (const mode of ['suspended-then-resumed', 'persistent-suspended-then-resumed']) {
  assert.equal(report.cases.filter(c => c.mode === mode).length, 1, 'Missing or duplicate suspended control ' + mode);
}
assert.equal(report.explicitRemoteMutationCalls, 0); assert.equal(report.ownedChildrenRemaining, 0);
const observations = report.cases.flatMap(c => c.observations);
for (const c of report.cases) {
  assert.equal(c.eventuallyInspectable, true); assert.equal(c.ownedChildExited, true);
  assert.match(c.creationTime100ns, /^[1-9][0-9]+$/);
  const last = c.observations.at(-1);
  assert.equal(last.inspectionError, 0); assert.ok(last.moduleBytes >= report.pointerBytes);
  assert.equal(last.moduleBytes % report.pointerBytes, 0); assert.equal(last.childMainReached, true);
  assert.equal(last.enumError, 0);
  for (const o of c.observations) {
    assert.equal(o.identityVerified, true); assert.equal(o.alive, true);
    assert.equal(o.explicitRemoteMutationCalls, 0); assert.equal(o.enumCalls, 1);
    if (o.enumError !== 0) assert.equal(o.inspectionError, o.enumError);
    if (process.argv[4] === '--require-recovery' && o.enumError === 0 &&
        (o.moduleBytes === 0 || o.moduleBytes % report.pointerBytes !== 0)) {
      assert.equal(o.inspectionError, 299, 'Incomplete module data must never authorize a clear result');
    }
  }
  if (c.mode.includes('suspended')) {
    assert.ok(c.suspendedObservations > 0);
    const beforeResume = c.observations.slice(0, c.suspendedObservations);
    assert.ok(beforeResume.every(o => !o.childMainReached));
    assert.ok(beforeResume.some(o => o.enumError === 299), 'Expected actual suspended-loader ERROR_PARTIAL_COPY reproduction');
  }
}
const recovery = report.recoveryCases || [];
assert.ok(recovery.length === 0 || (recovery.length >= 4 && recovery.length <= 20));
if (recovery.length !== 0) for (const mode of ['steady', 'resume-during-recovery', 'persistent-suspended', 'exit-during-recovery']) {
  assert.equal(recovery.filter(c => c.mode === mode).length, 1, 'Missing or duplicate native recovery control ' + mode);
}
if (process.argv[4] === '--require-recovery') {
  assert.ok(recovery.length >= 4, 'Candidate must execute the real recovery helper');
  if (report.cases.length === 38) assert.ok(recovery.length > 4, 'Candidate must record real module-churn recovery');
}
for (const c of recovery) {
  assert.equal(c.partialOutputsCleared, true);
  assert.equal(c.ownedChildExited, true);
  assert.equal(c.explicitRemoteMutationCalls, 0);
  assert.ok(c.attempts >= 1 && c.attempts <= 256);
  assert.equal(c.lastError, c.returnedError);
  if (c.mode === 'steady') {
    assert.equal(c.returnedError, 0); assert.equal(c.firstError, 0); assert.equal(c.attempts, 1);
    assert.ok(c.lastModuleBytes >= report.pointerBytes);
  } else if (c.mode === 'churn-during-recovery') {
    assert.equal(c.initialObservation.inspectionError, 299);
    assert.equal(c.returnedError, 0); assert.ok(c.lastModuleBytes >= report.pointerBytes);
    assert.ok([0, 299].includes(c.firstError));
  } else {
    assert.equal(c.initialObservation.inspectionError, 299);
    assert.equal(c.firstError, 299);
    if (c.mode === 'resume-during-recovery') {
      assert.equal(c.returnedError, 0); assert.ok(c.attempts > 1);
      assert.ok(c.lastModuleBytes >= report.pointerBytes);
    } else if (c.mode === 'persistent-suspended') {
      assert.equal(c.returnedError, 299); assert.ok(c.elapsedMs >= 240);
    } else {
      assert.equal(c.mode, 'exit-during-recovery');
      assert.equal(c.returnedError, 1067); assert.equal(c.ownedControlTermination, true);
    }
  }
}
if (recovery.length > 4) assert.ok(recovery.some(c => c.mode === 'churn-during-recovery' && c.firstError === 299 && c.attempts > 1));
const errors = observations.filter(o => o.inspectionError !== 0);
const result = {
  schemaVersion: 1, status: 'passed', architecture: report.architecture, cases: report.cases.length,
  observations: observations.length, inspection299: observations.filter(o => o.inspectionError === 299).length,
  enum299: observations.filter(o => o.enumError === 299).length,
  remoteRead299: observations.filter(o => o.failedReadError === 299).length,
  zeroModuleListObservations: observations.filter(o => o.enumError === 0 && o.moduleBytes === 0).length,
  zeroModuleListReturnedClear: observations.filter(o => o.enumError === 0 && o.moduleBytes === 0 && o.inspectionError === 0).length,
  zeroModuleListRejected: observations.filter(o => o.enumError === 0 && o.moduleBytes === 0 && o.inspectionError !== 0).length,
  immediateFirst299: report.cases.filter(c => c.mode === 'immediate' && c.observations[0].inspectionError === 299).length,
  churnCases: report.cases.filter(c => c.mode === 'local-module-churn').length,
  churnInspection299: report.cases.filter(c => c.mode === 'local-module-churn').flatMap(c => c.observations).filter(o => o.inspectionError === 299).length,
  churnRemoteRead299: report.cases.filter(c => c.mode === 'local-module-churn').flatMap(c => c.observations).filter(o => o.failedReadError === 299).length,
  recoveryCases: recovery.map(c => ({ mode: c.mode, returnedError: c.returnedError, firstError: c.firstError, attempts: c.attempts, elapsedMs: c.elapsedMs })),
  ownedControlTerminations: recovery.filter(c => c.ownedControlTermination).length,
  errorCodes: [...new Set(errors.map(o => o.inspectionError))].sort(),
  sourceRawSha256: report.sourceRawSha256, sourceNormalizedSha256: report.sourceNormalizedSha256,
  reportSha256: digest(bytes), explicitRemoteMutationCalls: 0, ownedChildrenRemaining: 0,
  scope: 'Read-only exact helper observations and controlled recovery; not graphics or consumer acceptance',
};
fs.writeFileSync(path.join(path.dirname(reportFile), 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
