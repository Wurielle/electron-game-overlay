'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8'));
const steps = workflow.jobs['packaged-broker'].steps;
const manual = "${{ github.event_name == 'workflow_dispatch' && inputs.build-demo }}";
const regular = workflow.jobs['sdk-tests'].steps;

test('SDK regression checks apply to development pull requests', () => {
  assert.ok(workflow.on.pull_request.branches.includes('dev'), 'dev pull requests must run SDK verification');
});

test('ordinary pull requests run encountered application regressions without manual-demo gating', () => {
  const unit = regular.find(s => s.name === 'Check encountered application regressions');
  assert.ok(unit, 'application regressions must not require a manual demo build');
  assert.equal(unit.if, undefined);
  assert.ok(unit.run.includes('--require ./apps/client/tests/helpers/register-typescript.cjs'));
  for (const file of ['input-intercept-shortcut.test.mjs', 'app-demo-shortcuts.test.mjs', 'app-demo-focus.test.mjs', 'demo-main-window.test.cjs', 'target-input-intercept-state.test.mjs', 'steam-game-auto-attacher.test.mjs', 'process-watcher-bridge.test.mjs', 'input-proof-ui.test.mjs', 'package-broker-test-bundle.test.cjs', 'package-demo.test.cjs', 'package-broker-smoke-hosts.test.cjs', 'broker-smoke-host-runner.test.cjs', 'run-popup-video-regression.test.cjs', 'demo-usability-workflow.test.cjs']) {
    assert.ok(unit.run.includes('apps/client/tests/' + file), file);
  }
  assert.ok(unit.run.includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));
});

test('ordinary pull requests exercise genuine Electron Main popup/video geometry', () => {
  const ui = regular.find(s => s.name === 'Check real Electron Main popup and video geometry');
  assert.ok(ui, 'Main regression acceptance must run on pull requests');
  assert.equal(ui.if, undefined);
  assert.equal(ui.run, 'node apps/client/tests/real-electron-demo-main.acceptance.cjs test-results/real-electron-demo-main.json');
});

test('ordinary pull requests exercise the actual popup/video SDK graph and reconnect with a pinned older SDK', () => {
  const graph = regular.find(s => s.name === 'Check popup and video registration with the pinned previous SDK');
  assert.ok(graph, 'the graph regression cannot remain a local-only runner');
  assert.equal(graph.if, undefined);
  for (const required of ['2d1cd28b7f51460a6a5f58b20fd9e8df219bea48', 'run-popup-video-regression.cjs', '--previous-lib', '--previous-server-lib', '--controlled-native-window-order', '--reconnect', 'test-results/popup-video-regression.json']) assert.ok(graph.run.includes(required), required);
  assert.ok(graph.run.includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));
});

test('manual demo verification runs independent-shortcut and bounded-window regressions', () => {
  const build = steps.find(s => s.name === 'Build and package the manual Electron demo');
  assert.ok(build);
  for (const file of ['input-intercept-shortcut.test.mjs', 'app-demo-shortcuts.test.mjs', 'demo-main-window.test.cjs']) {
    assert.ok(build.run.includes('apps/client/tests/' + file), file);
  }
});

test('genuine Electron Main-window usability is checked before packaging and always retains its report', () => {
  const ui = steps.find(s => s.name === 'Check real Electron bounded Main-window usability');
  assert.ok(ui, 'bounded Main-window Electron acceptance is required');
  assert.equal(ui.if, manual);
  assert.equal(ui.run, 'node apps/client/tests/real-electron-demo-main.acceptance.cjs test-results/real-electron-demo-main.json');
  assert.ok(steps.indexOf(ui) < steps.findIndex(s => s.name === 'Build and package the manual Electron demo'));
  const artifact = steps.find(s => s.with?.name === 'demo-electron-input-results');
  assert.ok(artifact.with.path.includes('test-results/real-electron-demo-main.json'));
  assert.equal(artifact.if, "${{ always() && github.event_name == 'workflow_dispatch' && inputs.build-demo }}");
});
