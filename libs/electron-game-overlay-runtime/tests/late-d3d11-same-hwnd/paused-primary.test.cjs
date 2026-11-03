'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const host = fs.readFileSync(path.join(__dirname, 'host.cpp'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '../../scripts/run-late-d3d11-same-hwnd-proof.ps1'), 'utf8');
const producer = fs.readFileSync(path.join(__dirname, '../late-d3d11-adoption/scene-producer.cjs'), 'utf8');
const commandSource = producer.slice(producer.indexOf('async function command(value) {'), producer.indexOf('app.whenReady().then'));

function producerCommand(allowed, electronLifecycle = false) {
  const calls = [];
  const state = { window: { nativeId: 7 }, focusedWindowId: 0, explicitFocusCount: 0 };
  const app = new EventEmitter();
  let liveWindows = 1;
  let exited = false;
  app.quit = () => { calls.push('quit'); app.emit('before-quit'); exited = true; };
  app.exit = code => { calls.push(`exit:${code}`); exited = true; };
  const closeLastWindow = () => {
    if (--liveWindows === 0 && !app.emit('window-all-closed')) app.quit();
  };
  const context = vm.createContext({
    state, allowWindowRecreation: allowed, app, process: new EventEmitter(),
    cleanup() { calls.push('cleanup'); },
    fail(error) { throw error; },
    persist() { calls.push('persist'); },
    window: { nativeId: 7, close() { calls.push('close:7'); if (electronLifecycle) closeLastWindow(); } },
  });
  context.createSceneWindow = async () => {
    if (exited) throw new Error('Electron quit before the replacement BrowserWindow could be created.');
    calls.push('create');
    liveWindows++;
    context.window = { nativeId: 8 };
    state.window.nativeId = 8;
  };
  if (electronLifecycle) {
    const lifecycle = producer.slice(producer.indexOf("process.on('uncaughtException', fail);"),
      producer.indexOf('async function snapshot()'));
    vm.runInContext(lifecycle, context);
  }
  vm.runInContext(commandSource + '; globalThis.executeCommand = command;', context);
  return { calls, state, execute: context.executeCommand, closeLastWindow, exited: () => exited };
}

test('actual producer recreation command rejects without its explicit opt-in', async () => {
  const fixture = producerCommand(false);
  await assert.rejects(fixture.execute({ action: 'recreate-window', sequence: 1 }), /not enabled/);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.state.window.nativeId, 7);
});

test('actual producer command creates a fresh registration without implicit focus or session restart', async () => {
  const fixture = producerCommand(true);
  await fixture.execute({ action: 'recreate-window', sequence: 4 });
  assert.deepEqual(fixture.calls, ['close:7', 'create']);
  assert.equal(fixture.state.previousNativeId, 7);
  assert.equal(fixture.state.window.nativeId, 8);
  assert.equal(fixture.state.recreationCount, 1);
  assert.equal(fixture.state.commandSequence, 4);
  assert.equal(fixture.state.focusedWindowId, 0);
  assert.equal(fixture.state.explicitFocusCount, 0);
  assert.match(producer, /allowWindowRecreation\s*=\s*arguments_\['allow-window-recreation'\]\s*===\s*'true'/);
});

test('opt-in recreation survives actual last-window-close dispatch and still exits on command', async () => {
  const fixture = producerCommand(true, true);
  await fixture.execute({ action: 'recreate-window', sequence: 3 });
  assert.deepEqual(fixture.calls, ['close:7', 'create']);
  assert.equal(fixture.exited(), false);
  assert.equal(fixture.state.window.nativeId, 8);
  assert.equal(fixture.state.commandSequence, 3);
  assert.equal(fixture.state.focusedWindowId, 0);
  await fixture.execute({ action: 'exit', sequence: 4 });
  assert.deepEqual(fixture.calls, ['close:7', 'create', 'persist', 'cleanup', 'exit:0']);
  assert.equal(fixture.exited(), true);
  assert.equal(fixture.state.status, 'stopped');
});

test('default producer does not install the opt-in last-window keepalive', () => {
  const fixture = producerCommand(false, true);
  fixture.closeLastWindow();
  assert.deepEqual(fixture.calls, ['quit', 'cleanup']);
  assert.equal(fixture.exited(), true);
});

test('paused primary remains live but cannot present or advance its count', () => {
  assert.match(host, /primary_paused\s*=\s*g_options\.case_name\s*==\s*"primary-paused"\s*&&\s*g_evidence\.lifecycle_applied/);
  assert.match(host, /primary_first\s*&&\s*g_graphics\.swapchain\s*!=\s*nullptr\s*&&\s*!primary_paused/);
  assert.match(host, /return\s+primary_first\s*\|\|\s*g_graphics\.swapchain\s*==\s*nullptr\s*\|\|\s*primary_paused\s*\|\|/);
  assert.match(host, /case_name\s*==\s*"primary-paused"\)[\s\S]*primary_frames_at_pause\s*=\s*g_evidence\.primary_frames_after_load/);
  assert.match(controller, /primaryFramesAfterLoad\s*-eq\s*\$Native\.primaryFramesAtPause/);
});

test('first adoption evidence observes the actual count transition around native Present', () => {
  const render = host.slice(host.indexOf('bool render_chain('), host.indexOf('bool render_frame('));
  const before = render.indexOf('const auto adoptions_before');
  const present = render.indexOf('chain->Present', before);
  const after = render.indexOf('adoption_successes != adoptions_before', present);
  const identity = render.indexOf('first_adopted_native = reinterpret_cast<std::uintptr_t>(chain)', after);
  assert.ok(before >= 0 && before < present && present < after && after < identity);
  assert.equal((host.match(/const auto adoptions_before/g) || []).length, 1);
  assert.match(controller, /firstAdoptedRole\s*-ne\s*'primary'/);
  assert.match(controller, /firstAdoptedNative\s*-ne\s*\$Initial\.Native\.primarySwapchainNative/);
});

test('paused acceptance requires fresh rank/window, exact TCP continuity, native input and disconnect withdrawal', () => {
  for (const evidence of ['registryWindowIds', 'registryRankWindowIds', 'registryFocusWindowId',
    'privateTcpAfterNewRegistration', 'rawKeyDownMessages', 'rawKeyUpMessages', 'rawPointerDownMessages',
    'releasedAfterProducerDisconnect', 'releasedPointerAfterProducerDisconnect', 'Assert-WithdrawnPixel']) {
    assert.ok(controller.includes(evidence), `missing live oracle ${evidence}`);
  }
  assert.match(controller, /registryWindowIds\s*-notcontains\s*\$OldNativeId/);
  assert.match(controller, /registryRankWindowIds\s*-notcontains\s*\$OldNativeId/);
  assert.match(controller, /privateTcpAfterNewRegistration\s*-ne\s*\$Proof\.privateTcpBeforeLifecycle/);
  assert.match(controller, /Send-SceneCommand\s+'intercept'[\s\S]*beforeProducerDisconnect[\s\S]*Send-SceneCommand\s+'exit'/);
  assert.match(controller, /@\(\$Native\.registryWindowIds\)\.Count\s*-eq\s*0[\s\S]*@\(\$Native\.registryRankWindowIds\)\.Count\s*-eq\s*0/);
  const registryInspection = host.slice(host.indexOf('void refresh_registry_evidence()'), host.indexOf('std::string json_ids('));
  assert.match(registryInspection, /OpenFileMappingW\(FILE_MAP_READ/);
  assert.doesNotMatch(registryInspection, /CreateFileMappingW|\.join\(/);
});

test('dedicated launcher and guarded producer extension leave historical case defaults available', () => {
  const launcher = fs.readFileSync(path.join(__dirname,
    '../../scripts/test-cases/late-d3d11-same-hwnd-primary-paused.ps1'), 'utf8');
  assert.match(launcher, /-Case\s+primary-paused\s+@PSBoundParameters/);
  assert.match(controller, /if\s*\(\$Case\s*-eq\s*'primary-paused'\)\s*\{\s*\$ProducerArguments\s*\+=\s*'--allow-window-recreation=true'/);
  assert.match(controller, /ValidateSet\('primary-resize',\s*'primary-final-destroy',\s*'primary-paused'\)/);
  const guard = controller.slice(controller.indexOf('function Assert-TargetForeground'), controller.indexOf('function Assert-RedPixel'));
  assert.ok(guard.indexOf('Assert-TargetAlive') < guard.indexOf('GetForegroundWindow'), 'an exited target must report retained host evidence before a foreground error');
});

test('production capability and null initializer are mandatory by default without prototype fallback', () => {
  assert.match(host, /bool\s+prototype\s*=\s*false/);
  const load = host.slice(host.indexOf('bool load_and_adopt('), host.indexOf('bool resize_graphics('));
  assert.match(load, /GetProcAddress\(g_graphics\.reshade_module,\s*"ElectronGameOverlayOwnedLateD3D11AbiV1"\)/);
  assert.match(load, /capability\s*==\s*nullptr\s*\|\|\s*\*capability\s*!=\s*1/);
  assert.match(load, /"ElectronGameOverlayInitializeOwnedLateD3D11V1"/);
  assert.match(load, /"ElectronGameOverlayQueryOwnedLateD3D11V1"/);
  assert.match(load, /if\s*\(g_options\.prototype\)[\s\S]*initialize_prototype\(&request\)[\s\S]*else\s*\{\s*g_evidence\.bootstrap_initialize_result\s*=\s*g_graphics\.initialize_bootstrap\(nullptr\)/);
  assert.match(host, /if\s*\(!g_options\.prototype\)\s*\{[\s\S]*if\s*\(!g_options\.config\.empty\(\)\)\s*return\s+false/);
  assert.match(controller, /\$Final\.bootstrapAbi\s*-ne\s*1/);
  assert.match(controller, /\$Final\.bootstrapStats\.structSize\s*-ne\s*104/);
  assert.match(controller, /stagedTemplateSha256After\s*-cne\s*\$TemplateHashBefore/);
});

test('only the internal diagnostic runner can explicitly select the old prototype ABI', () => {
  assert.match(controller, /\$Prototype\s*-and\s*-not\s*\$DiagnosticInputOnly/);
  assert.match(controller, /if\s*\(\$Prototype\)\s*\{\s*\$HostArguments\s*\+=\s*@\('--prototype',\s*'--config'/);
  assert.match(controller, /electron-game-overlay-owned-runtime-v1\.marker/);
  for (const name of ['primary-resize', 'primary-final-destroy', 'primary-paused']) {
    const wrapper = fs.readFileSync(path.join(__dirname,
      `../../scripts/test-cases/late-d3d11-same-hwnd-${name}.ps1`), 'utf8');
    assert.doesNotMatch(wrapper, /\$Prototype|--prototype|\$DiagnosticInputOnly/);
  }
});

test('production self-loading owns the adapter gate before DllMain and never fabricates registration', () => {
  const load = host.slice(host.indexOf('bool load_and_adopt('), host.indexOf('bool resize_graphics('));
  assert.match(load, /"ElectronGameOverlayReShadeHostAbi"/);
  assert.match(load, /"ElectronGameOverlayReShadeAddonGate"/);
  assert.match(load, /host_abi\s*==\s*nullptr\s*\|\|\s*\*host_abi\s*!=\s*1\s*\|\|\s*addon_gate\s*==\s*nullptr/);
  const claim = load.indexOf('InterlockedCompareExchange(addon_gate, 1, 0)');
  const addonLoad = load.indexOf('g_graphics.addon_module = LoadLibraryExW');
  const registered = load.indexOf('InterlockedCompareExchange(addon_gate, 2, 1)');
  const initializeMember = load.indexOf('g_evidence.member_initialize_result = initialize(nullptr)');
  assert.ok(claim >= 0 && claim < addonLoad && addonLoad < registered && registered < initializeMember);
  assert.match(load.slice(claim, addonLoad), /addon_gate_observed\s*!=\s*0\)\s*return\s+fail/);
  assert.match(load, /if\s*\(g_graphics\.addon_module\s*==\s*nullptr\)\s*\{[^}]*InterlockedCompareExchange\(addon_gate,\s*0,\s*1\)/);
  assert.match(load, /InterlockedCompareExchange\(addon_gate,\s*2,\s*1\)\s*!=\s*1\)\s*return\s+fail/);
  assert.equal((load.match(/InterlockedCompareExchange\(addon_gate,\s*0,\s*1\)/g) || []).length, 1);
  assert.match(controller, /\$Final\.addonGateObserved\s*-ne\s*0/);
  assert.match(controller, /\$Final\.addonGateRegistered\s*-ne\s*\$true/);
});
