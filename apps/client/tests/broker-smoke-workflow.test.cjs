'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/broker-compatibility.yml'), 'utf8'));
const steps = workflow.jobs['packaged-broker'].steps;
const manual = "${{ github.event_name == 'workflow_dispatch' && inputs.build-demo }}";

test('controlled host builds and packaging are manual-only and use fresh six-cell outputs', () => {
  const build = steps.find(s => s.name === 'Build the six controlled smoke hosts');
  const pack = steps.find(s => s.name === 'Package controlled hosts for the portable demos');
  assert.ok(build && pack, 'manual controlled-host build and packaging steps are required');
  assert.equal(build.if, manual); assert.equal(pack.if, manual);
  const native = steps.findIndex(s => s.name === 'Check native injection instance binding');
  assert.ok(native >= 0 && steps.indexOf(build) > native);
  for (const value of ['electron-game-overlay-runtime-production', 'electron-game-overlay-runtime-production-x86', 'd3d9_overlay_test_host', 'd3d10_overlay_test_host', 'd3d11_overlay_test_host', 'd3d12_overlay_test_host', 'RelWithDebInfo']) assert.ok(build.run.includes(value), value);
  for (const value of ['package-broker-smoke-hosts.cjs', '--host-root64', '--host-root32', '--revision', '$env:GITHUB_SHA', 'ElectronGameOverlayDemo-win32-x64/smoke', 'ElectronGameOverlayDemo-baseline-win32-x64/smoke', 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }']) assert.ok(pack.run.includes(value), value);
  assert.ok(steps.indexOf(pack) < steps.findIndex(s => s.name === 'Archive the portable Electron demo'));
});

test('each manual package has revision metadata and smoke manifests remain available as evidence', () => {
  const revision = steps.find(s => s.name === 'Record the current SDK revision');
  assert.ok(revision); assert.equal(revision.if, manual);
  for (const value of ['SDK-REVISION.json', 'sdkSourceRevision', 'sdkImplementationSha256', "role = 'current'"]) assert.ok(revision.run.includes(value), value);
  const pack = steps.findIndex(s => s.name === 'Package controlled hosts for the portable demos');
  assert.ok(steps.indexOf(revision) < pack);
  const evidence = steps.find(s => s.with?.name === 'portable-smoke-host-manifests');
  assert.ok(evidence); assert.equal(evidence.if, "${{ always() && github.event_name == 'workflow_dispatch' && inputs.build-demo }}");
  assert.ok(evidence.with.path.includes('smoke/manifest.json'));
  assert.equal(evidence.with['if-no-files-found'], 'error');
  assert.equal(workflow.on.workflow_dispatch.inputs['build-demo'].default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs['build-two-app-demo'].default, false);
});
