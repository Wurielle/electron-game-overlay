'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, 'host.cpp'), 'utf8');
const load = source.slice(source.indexOf('bool load_and_adopt()'), source.indexOf('bool resize_graphics('));

test('owned caller verifies and claims the registration gate before loading the first adapter', () => {
  const claim = load.indexOf('InterlockedCompareExchange(addon_gate, 1, 0)');
  const addonLoad = load.indexOf('g_graphics.addon_module = LoadLibraryExW');
  assert.ok(load.indexOf('"ElectronGameOverlayReShadeHostAbi"') < claim);
  assert.ok(load.indexOf('"ElectronGameOverlayReShadeAddonGate"') < claim);
  assert.ok(claim > 0 && claim < addonLoad);
  assert.match(load.slice(claim, addonLoad), /addon_gate_before_claim != 0/);
});

test('only a failed addon load can reopen the claimed gate', () => {
  const failureStart = load.indexOf('if (g_graphics.addon_module == nullptr)');
  const publication = load.indexOf('const LONG published_from');
  assert.match(load.slice(failureStart, publication), /GetLastError\(\);[\s\S]*InterlockedCompareExchange\(addon_gate, 0, 1\)/);
  assert.equal((load.match(/InterlockedCompareExchange\(addon_gate, 0, 1\)/g) || []).length, 1);
  assert.doesNotMatch(load.slice(publication), /InterlockedCompareExchange\(addon_gate, 0, 1\)/);
});

test('successful DllMain publication precedes member and owned-host initialization', () => {
  const publish = load.indexOf('InterlockedCompareExchange(addon_gate, 2, 1)');
  const member = load.indexOf('member_initialize_result = initialize(nullptr)');
  const bootstrap = load.indexOf('bootstrap_initialize_result = g_graphics.initialize_bootstrap(nullptr)');
  assert.ok(publish > 0 && publish < member && member < bootstrap);
  assert.match(load.slice(publish, member), /if \(published_from != 1\)/);
  assert.match(source, /"  \\"addonGatePublished\\": "/);
});
