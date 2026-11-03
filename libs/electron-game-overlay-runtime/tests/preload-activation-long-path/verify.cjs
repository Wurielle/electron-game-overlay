'use strict';
// Read-only assertions over the isolated native reports, followed by an owned
// verification record. These checks establish readiness, never graphics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: { mode: { type: 'string' }, report: { type: 'string' }, source: { type: 'string' }, architecture: { type: 'string' } } });
assert.ok(['baseline', 'candidate'].includes(values.mode), '--mode baseline|candidate is required');
const root = path.resolve(__dirname, '../../../..');
const build = fs.realpathSync(path.join(root, 'build'));
const inside = file => {
  assert.equal(typeof file, 'string');
  const real = fs.realpathSync(file), relative = path.relative(build, real);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'Evidence must stay beneath the SDK build directory');
  assert.ok(fs.lstatSync(real).isFile());
  return real;
};
const reportPath = inside(values.report), sourcePath = inside(values.source);
const reportBytes = fs.readFileSync(reportPath), source = fs.readFileSync(sourcePath);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = JSON.parse(reportBytes);
// Original retained x64 reports predate the explicit architecture field. Their
// architecture-specific DLL leaves still establish the original scope.
const architecture = report.architecture ?? (report.cases?.every(c => c.canonicalPath.endsWith('.addon64')) ? 'x64' : undefined);
assert.ok(['x64', 'x86'].includes(architecture), 'Missing or unsupported probe architecture');
if (values.architecture !== undefined) assert.equal(architecture, values.architecture);
if (report.pointerBytes !== undefined) assert.equal(report.pointerBytes, architecture === 'x64' ? 8 : 4);
assert.equal(report.status, 'probe-completed');
assert.equal(report.schemaVersion, 1);
assert.equal(report.sourceRawSha256, digest(source));
assert.equal(report.sourceNormalizedSha256, digest(Buffer.from(source.toString('utf8').replace(/\r\n/g, '\n'))));
assert.equal(report.explicitRemoteMutationCalls, 0);
const lengths = [233, 259, 260, 289, 293, 320];
const states = { member: [0, 1, 2, 3], legacy: [0, 1, 2], invalid: [1], unrelated: [1] };
const cases = new Map();
for (const c of report.cases) {
  const key = [c.variant, c.canonicalLength, c.state, c.scenario].join('/');
  assert.ok(!cases.has(key), 'Duplicate case ' + key); cases.set(key, c);
  assert.equal(c.moduleLoaded, true, key); assert.equal(c.loadError, 0, key);
  assert.equal(c.k32Found, true, key); assert.equal(c.k32Error, 0, key);
  assert.equal(c.addressReference, true, key);
  assert.equal(c.explicitRemoteMutationCalls, 0, key);
  assert.equal(c.modulePath, '\\\\?\\' + c.canonicalPath, key);
  assert.equal(c.canonicalPath.length, c.canonicalLength, key);
  assert.equal(path.win32.extname(c.canonicalPath), architecture === 'x64' ? '.addon64' : '.addon32', key);
  assert.equal(c.directAdapterReady, c.variant !== 'legacy' && (c.state === 1 || c.state === 3), key);
  assert.equal(c.directCooperativeReady, c.variant === 'legacy' ? c.state === 1 : c.state !== 3, key);
}
let assertions = 0;
for (const length of lengths) for (const [variant, variants] of Object.entries(states)) for (const state of variants) {
  const key = [variant, length, state, 0].join('/'), c = cases.get(key);
  assert.ok(c, 'Missing case ' + key);
  const ready = variant === 'member' ? state === 1 || state === 3 : variant === 'legacy' && state === 1;
  assert.equal(c.expectedReady, ready, key);
  const baselineReady = length === 233 && ready;
  assert.equal(c.exactReady, values.mode === 'candidate' ? ready : baselineReady, key);
  assert.equal(c.semanticPass, c.exactReady === ready, key);
  assert.equal(c.selectorEnumerationCalls, values.mode === 'candidate' ? 1 : 0, key);
  assert.equal(c.toolhelpFound, length === 233, key);
  assert.equal(c.toolhelpFirstError, length === 233 ? 0 : 234, key);
  ++assertions;
}
if (values.mode === 'candidate') {
  for (let scenario = 1; scenario <= 7; scenario++) {
    const key = ['member', 293, 1, scenario].join('/'), c = cases.get(key);
    assert.ok(c, 'Missing API seam ' + key);
    assert.equal(c.expectedReady, scenario === 2, key);
    assert.equal(c.exactReady, scenario === 2, key);
    assert.equal(c.semanticPass, true, key);
    assert.equal(c.selectorEnumerationCalls, scenario === 2 ? 2 : scenario === 3 ? 8 : 1, key);
    ++assertions;
  }
}
assert.equal(cases.size, values.mode === 'candidate' ? 61 : 54);
const verification = { schemaVersion: 1, status: 'passed', mode: values.mode, cases: cases.size,
  architecture, pointerBytes: architecture === 'x64' ? 8 : 4,
  independentlyAssertedCases: assertions, sourceRawSha256: report.sourceRawSha256,
  sourceNormalizedSha256: report.sourceNormalizedSha256, reportSha256: digest(reportBytes),
  scope: 'Exact native readiness selector with inert local DLLs and deterministic API failure/growth seams; no graphics or consumer acceptance',
  explicitRemoteMutationCalls: 0 };
fs.writeFileSync(path.join(path.dirname(reportPath), 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
console.log(JSON.stringify(verification));
