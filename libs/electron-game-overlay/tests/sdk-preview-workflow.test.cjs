'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const workflow = require('yaml').parse(fs.readFileSync(path.resolve(__dirname,'../../../.github/workflows/broker-compatibility.yml'),'utf8'));
const steps = workflow.jobs['packaged-broker'].steps;

test('SDK candidate is packaged and installed after the real native build on ordinary PRs', () => {
  const build = steps.findIndex(s=>s.name==='Build native runtimes and packaged SDK');
  const pack = steps.findIndex(s=>s.name==='Package SDK release candidate');
  const install = steps.findIndex(s=>s.name==='Check installed SDK candidate');
  assert.ok(pack>build && install>pack,'candidate packing/install must follow genuine native build');
  assert.equal(steps[pack].if,undefined);
  assert.ok(steps[pack].run.includes('scripts/package-sdk.cjs'));
  assert.ok(steps[install].run.includes('broker-package-install.acceptance.cjs'));
  assert.ok(steps[install].run.includes('tarballSha256'),'installed repack must match delivered tarball');
});

test('standalone consumer is exercised with genuine Electron and retained failure evidence', () => {
  const consumer = steps.find(s=>s.name==='Check standalone SDK consumer');
  assert.ok(consumer,'external consumer acceptance required');
  assert.equal(consumer.if,undefined);
  assert.ok(consumer.run.includes('sdk-preview-consumer.acceptance.cjs'));
  assert.ok(consumer.run.includes('--example-root examples/basic-overlay'));
  const installElectron=steps.find(s=>s.name==='Install the locked Electron runtime for the manual demo');
  assert.ok(installElectron && installElectron.if===undefined,'same locked Electron must also be available for ordinary consumer CI');
  const reports=steps.find(s=>s.with?.name==='sdk-preview-verification-results');
  assert.equal(reports?.if,'always()');
  assert.equal(reports.with.path,'test-results/sdk-preview-*.json');
});

test('candidate download contains tarball and plain consumer without publishing a release', () => {
  const upload=steps.find(s=>s.with?.name==='ego-sdk-preview');
  assert.ok(upload,'downloadable candidate artifact required');
  assert.equal(upload.with.path,'artifacts/sdk-preview-download/');
  const collect=steps.find(s=>s.name==='Collect SDK candidate download');
  assert.ok(collect.run.includes('examples/basic-overlay'));
  assert.ok(collect.run.includes('*.tgz'));
});

test('downloaded consumer retains the tests advertised by its npm test script', t => {
  const collect = steps.find(s => s.name === 'Collect SDK candidate download');
  assert.match(collect.run, /Copy-Item -Recurse examples\/basic-overlay\/tests artifacts\/sdk-preview-download\/consumer\//);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-download-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const example = path.resolve(__dirname, '../../../examples/basic-overlay');
  const list = collect.run.match(/foreach \(\$file in @\(([^)]+)\)\)/);
  assert.ok(list, 'consumer file collection must remain explicit');
  for (const match of list[1].matchAll(/'([^']+)'/g)) fs.copyFileSync(path.join(example, match[1]), path.join(root, match[1]));
  fs.cpSync(path.join(example, 'tests'), path.join(root, 'tests'), { recursive: true });
  assert.ok(fs.existsSync(path.join(root, 'tests/main.test.cjs')));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(metadata.scripts.test, 'node --test tests/*.test.cjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/*.test.cjs'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /# tests 5\b/);
  assert.match(result.stdout, /# pass 5\b/);
});
