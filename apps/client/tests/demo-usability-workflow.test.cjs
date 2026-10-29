'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8'));
const steps = workflow.jobs['packaged-broker'].steps;
const manual = "${{ github.event_name == 'workflow_dispatch' && inputs.build-demo }}";

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
