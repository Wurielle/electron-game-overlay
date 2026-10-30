'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Controlled report-schema data only: no Windows or native execution is performed.
const controlledReport = { status: 'passed', platform: 'win32', windowsExecuted: true, controlledFixture: 'report-schema-only-not-Windows-execution' };
const reportScript = report => `require('node:fs').writeFileSync(process.env.EGO_WINDOWS_IDENTITY_REPORT, ${JSON.stringify(JSON.stringify(report))});`;
function fixture(t, acceptance = reportScript(controlledReport)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-diagnostic-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const harness = path.join(root, 'harness');
  const app = path.join(root, 'package/resources/app');
  fs.mkdirSync(path.join(harness, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(harness, 'tests'));
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  for (const name of ['smoke-packaged-demo.cjs', 'package-demo.cjs']) fs.copyFileSync(path.join(__dirname, '../scripts', name), path.join(harness, 'scripts', name));
  fs.writeFileSync(path.join(app, 'scripts/broker-recovery-diagnostic.cjs'), `
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['--help']);
assert.equal(process.env.PATH, '');
for (const key of Object.keys(process.env)) assert.ok(!/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NODE_TEST_CONTEXT|npm_node_execpath|EGO_WINDOWS_IDENTITY_MODULE|EGO_WINDOWS_IDENTITY_ACCEPTANCE|EGO_WINDOWS_IDENTITY_REPORT|EGO_IDENTITY_OWNED_PIPE)$/i.test(key));
process.stdout.write('Usage: broker-recovery-diagnostic [--json]');
`);
  fs.writeFileSync(path.join(app, 'scripts/windows-broker-identity.cjs'), '// controlled inventory fixture, not native execution');
  fs.writeFileSync(path.join(root, 'package/Start Broker Recovery Diagnostic.cmd'), '@rem controlled launcher inventory fixture');
  fs.writeFileSync(path.join(harness, 'tests/windows-broker-identity.acceptance.cjs'), `
const assert = require('node:assert/strict');
assert.equal(process.cwd(), ${JSON.stringify(app)});
assert.equal(process.env.PATH, '');
assert.equal(process.env.EGO_WINDOWS_IDENTITY_ACCEPTANCE, '1');
assert.equal(process.env.EGO_WINDOWS_IDENTITY_MODULE, ${JSON.stringify(path.join(app, 'scripts/windows-broker-identity.cjs'))});
assert.equal(process.env.NODE_PATH, undefined);
${acceptance}
`);
  return { app, root, report: path.join(root, 'identity.json'), probe: require(path.join(harness, 'scripts/smoke-packaged-demo.cjs')).probeRecoveryDiagnostic };
}

test('diagnostic smoke crosses real spawn boundary with isolated controlled children (not Windows acceptance)', t => {
  const f = fixture(t);
  assert.equal(typeof f.probe, 'function');
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  Object.assign(process.env, { NODE_OPTIONS: '--require=untrusted-hook', NODE_PATH: '/untrusted', ELECTRON_RUN_AS_NODE: '1', EGO_WINDOWS_IDENTITY_MODULE: '/untrusted', EGO_IDENTITY_OWNED_PIPE: 'never-use-an-existing-pipe', EGO_WINDOWS_IDENTITY_ACCEPTANCE: '1', EGO_WINDOWS_IDENTITY_REPORT: '/untrusted' });
  const result = f.probe(f.app, process.execPath, f.report);
  assert.equal(result.helpExecuted, true);
  assert.equal(result.pathEmpty, true);
  assert.equal(result.identity.controlledFixture, 'report-schema-only-not-Windows-execution');
  assert.deepEqual(result.identity, controlledReport);
  assert.equal(JSON.parse(fs.readFileSync(f.report)).status, 'passed');
});

for (const [name, fields] of [
  ['false native flag', { windowsExecuted: false }],
  ['missing native flag', { windowsExecuted: undefined }],
  ['non-boolean native flag', { windowsExecuted: 'true' }],
  ['non-Windows platform', { platform: 'linux' }],
  ['missing platform', { platform: undefined }],
  ['failed status', { status: 'failed' }],
]) {
  test(`controlled report-schema child rejects ${name} (not Windows execution)`, t => {
    const evidence = JSON.parse(JSON.stringify({ ...controlledReport, ...fields }));
    const f = fixture(t, reportScript(evidence));
    assert.throws(() => f.probe(f.app, process.execPath, f.report), /^Error: Packaged identity evidence did not pass$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.report)), evidence);
  });
}

test('packaged smoke and Windows CI invoke recovery gates and preserve failure artifacts', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '../scripts/smoke-packaged-demo.cjs'), 'utf8');
  assert.match(smoke, /report\.recoveryDiagnostic\s*=\s*(?:await\s+)?probeRecoveryDiagnostic\(app, node,/);
  const acceptance = fs.readFileSync(path.join(__dirname, 'windows-broker-identity.acceptance.cjs'), 'utf8');
  assert.match(acceptance, /process\.env\.EGO_WINDOWS_IDENTITY_MODULE/);
  assert.match(acceptance, /createRequire/);
  assert.match(acceptance, /koffi/);
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8');
  assert.match(workflow, /EGO_WINDOWS_IDENTITY_ACCEPTANCE: '1'/);
  assert.match(workflow, /EGO_WINDOWS_IDENTITY_REPORT: test-results\/windows-broker-identity\.json/);
  for (const name of ['broker-recovery-smoke.test.cjs', 'broker-recovery-diagnostic.test.cjs', 'windows-broker-identity.test.cjs', 'broker-recovery-package.test.cjs']) assert.ok(workflow.includes(name), name);
  assert.match(workflow, /if: \$\{\{ always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.build-demo \}\}[\s\S]*?name: packaged-recovery-diagnostic-results/);
});

test('failed controlled help child leaves failure-default report and fixed error', t => {
  const f = fixture(t);
  fs.writeFileSync(f.report, JSON.stringify({ status: 'passed', stale: true }));
  fs.writeFileSync(path.join(f.app, 'scripts/broker-recovery-diagnostic.cjs'), "process.stderr.write('private-path-or-token'); process.exitCode=9;");
  assert.throws(() => f.probe(f.app, process.execPath, f.report), /^Error: Packaged recovery diagnostic help failed$/);
  const report = JSON.parse(fs.readFileSync(f.report));
  assert.equal(report.status, 'failed');
  assert.equal(report.stale, undefined);
  assert.equal(report.brokerStarted, false);
  assert.equal(report.gameInjectionAttempted, false);
  assert.ok(!JSON.stringify(report).includes('private-path-or-token'));
});

test('missing packaged inventory fails closed without exposing private paths', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.app, 'scripts/windows-broker-identity.cjs'));
  assert.throws(() => f.probe(f.app, process.execPath, f.report), /^Error: Missing packaged recovery diagnostic support file$/);
  assert.equal(JSON.parse(fs.readFileSync(f.report)).status, 'failed');
});

test('controlled acceptance nonzero cannot become success and preserves report', t => {
  const f = fixture(t, 'process.exitCode = 7;');
  assert.throws(() => f.probe(f.app, process.execPath, f.report), /Packaged owned-pipe identity acceptance failed/);
  assert.equal(JSON.parse(fs.readFileSync(f.report)).status, 'failed');
});
