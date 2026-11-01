'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// This guards the actual mapped-source completion point. It does not execute
// ReShade or establish that any package/native loader was accepted.
const source = fs.readFileSync(path.resolve(__dirname,
  '../../electron-game-overlay-runtime/src/electron_game_overlay_addon.cpp'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  value => value.replace(/[^\r\n]/g, ' '));

function body(name) {
  const match = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?:noexcept\\s*)?\\{`, 'm').exec(code);
  assert.ok(match, `missing native definition ${name}`);
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < code.length; index++) {
    if (code[index] === '{') depth++;
    if (code[index] === '}' && --depth === 0) return code.slice(start, index);
  }
  assert.fail(`unbalanced native definition ${name}`);
}

test('adapter completion is an aligned zero-initialized C data export, separate from private member readiness', () => {
  assert.match(source, /extern\s+"C"\s+__declspec\(dllexport\)\s+__declspec\(align\(4\)\)\s+volatile\s+LONG\s+ElectronGameOverlayCooperativeAdapterReadyV1\s*=\s*0\s*;/u);
  assert.doesNotMatch(body('initialize_cooperative_member'), /ElectronGameOverlayCooperativeAdapterReadyV1/u);
  assert.match(body('initialize_cooperative_member'), /InterlockedExchange\(&ElectronGameOverlayCooperativeReadyV1,\s*1\)/u);
  assert.equal((code.match(/InterlockedExchange\(&ElectronGameOverlayCooperativeAdapterReadyV1,\s*1\)/gu) || []).length, 1);
});

test('dispatcher completion publishes only after every public and optional private callback registration', () => {
  const registration = body('register_dispatcher_events');
  const callbacks = [...registration.matchAll(/reshade::register_event<reshade::addon_event::([a-z_]+)>\([^;]+;/gu)];
  assert.deepEqual(callbacks.map(value => value[1]), [
    'init_swapchain', 'destroy_swapchain', 'destroy_effect_runtime', 'reshade_overlay', 'reshade_present', 'input_message',
  ]);
  const completion = /InterlockedExchange\(&ElectronGameOverlayCooperativeAdapterReadyV1,\s*1\)\s*;/u.exec(registration);
  assert.ok(completion);
  for (const callback of callbacks) assert.ok(completion.index > callback.index + callback[0].length);
  assert.match(registration, /if\s*\(g_has_private_input_observer\)\s*reshade::register_event/u);
  assert.equal(registration.slice(completion.index + completion[0].length).trim(), '', 'completion must be the final registration statement');
  assert.doesNotMatch(registration, /g_private_route_present|g_private_run_directory|g_participant_id|CooperativeReadyV1/u);
});

test('only the first dispatcher can call the registration completion path', () => {
  assert.equal((code.match(/register_dispatcher_events\(\);/gu) || []).length, 2);
  const initialize = body('AddonInit');
  assert.match(initialize, /if\s*\(!g_cooperative_dispatcher\s*\|\|\s*g_public_registered\)\s*return\s+true\s*;/u);
  assert.ok(initialize.indexOf('register_compatible_addon') < initialize.indexOf('register_dispatcher_events'));
  const attach = body('DllMain');
  assert.match(attach, /if\s*\(!g_cooperative_dispatcher\)\s*break\s*;\s*register_dispatcher_events\(\);/u);
});

test('actual dispatcher uninitialization withdraws readiness before shutdown or callback removal', () => {
  const uninitialize = body('AddonUninit');
  assert.match(uninitialize, /if\s*\(g_cooperative_dispatcher\)\s*\{\s*InterlockedExchange\(&ElectronGameOverlayCooperativeAdapterReadyV1,\s*0\)\s*;/u);
  const clear = uninitialize.indexOf('InterlockedExchange');
  assert.ok(clear < uninitialize.indexOf('shutdown_official_message_hooks'));
  assert.ok(clear < uninitialize.indexOf('unregister_compatible_addon'));
  assert.ok(clear < uninitialize.indexOf('g_public_registered = false'));
});

test('producer disconnect and surface retirement cannot withdraw the surviving dispatcher proof', () => {
  for (const name of ['release_transport', 'deactivate_dormant_input', 'destroy_own_effect_runtime', 'cooperative_release_input']) {
    assert.doesNotMatch(body(name), /ElectronGameOverlayCooperativeAdapterReadyV1/u, name);
  }
  assert.equal((code.match(/InterlockedExchange\(&ElectronGameOverlayCooperativeAdapterReadyV1,\s*0\)/gu) || []).length, 1,
    'only the actual public dispatcher unregistration path may clear callback readiness');
});

test('unregistration preserves pinned member identity and reinitialization must complete registration again', () => {
  const uninitialize = body('AddonUninit');
  assert.doesNotMatch(uninitialize, /ElectronGameOverlayCooperativeReadyV1|g_participant_id|g_module_pinned|g_cooperative\.leave/u);
  const initialize = body('AddonInit');
  assert.match(initialize, /if\s*\(!register_compatible_addon\(module\)\)\s*return\s+false\s*;\s*register_dispatcher_events\(\)\s*;/u);
  assert.doesNotMatch(initialize, /InterlockedExchange/u,
    'reinitialization cannot publish readiness before every callback is registered');
  assert.equal((code.match(/InterlockedExchange\(&ElectronGameOverlayCooperativeAdapterReadyV1,\s*1\)/gu) || []).length, 1);
});
