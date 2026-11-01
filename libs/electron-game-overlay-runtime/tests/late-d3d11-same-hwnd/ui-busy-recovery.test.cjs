'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const host = fs.readFileSync(path.join(__dirname, 'host.cpp'), 'utf8');
const runner = fs.readFileSync(path.join(__dirname, '../../scripts/run-late-d3d11-same-hwnd-proof.ps1'), 'utf8');
const launcher = fs.readFileSync(path.join(__dirname, '../../scripts/test-cases/late-d3d11-ui-busy-hook-recovery.ps1'), 'utf8');
const worker = host.slice(host.indexOf('bool exercise_busy_ui_adoption()'), host.indexOf('bool wait_for_retirements('));

test('UI delay is opt-in and starts before the first adopted Present', () => {
  assert.match(host, /std::uint64_t\s+ui_busy_ms\s*=\s*0/);
  assert.match(worker, /if\s*\(g_options\.ui_busy_ms\s*==\s*0\)\s*return\s+true/);
  assert.match(worker, /adoption_successes\s*!=\s*0/);
  assert.match(host, /if\s*\(!load_and_adopt\(\)\s*\|\|\s*!exercise_busy_ui_adoption\(\)\)\s*break/);
  assert.match(host, /parse_number\(value,\s*2500,\s*3500,\s*g_options\.ui_busy_ms\)/);
});

test('only the worker renders while the UI deliberately does not pump, then joins before reuse', () => {
  const start = worker.indexOf('std::thread worker');
  const sleep = worker.indexOf('Sleep(static_cast<DWORD>(g_options.ui_busy_ms))');
  const stop = worker.indexOf('stop.store(true');
  const join = worker.indexOf('worker.join()');
  const result = worker.indexOf('g_evidence.ui_busy_completed =');
  assert.ok(start >= 0 && start < sleep && sleep < stop && stop < join && join < result);
  assert.match(worker.slice(start, sleep), /while\s*\(!stop\.load[^\n]*\)\s*if\s*\(!render_frame\(\)\)/);
  assert.doesNotMatch(worker, /PeekMessage|DispatchMessage|TranslateMessage|sample_native_key_polling/);
  assert.match(worker, /owner_thread\s*!=\s*present_thread/);
  assert.match(worker, /ui_busy_present_calls\s*>=\s*6/);
  assert.match(worker, /ui_busy_adoption_successes\s*==\s*2/);
});

test('controller requires post-resume readiness and preserves actual native/DOM/cursor/release oracles', () => {
  assert.match(runner, /uiBusyOwnerThreadId\s*-eq\s*0[\s\S]*uiBusyPresentThreadId\s*-eq\s*\$Initial\.Native\.uiBusyOwnerThreadId/);
  assert.match(runner, /\$ReadyEvents[\s\S]*targetConnected[\s\S]*runtime-swapchain-ready/);
  assert.match(runner, /\$ReadyEvents\s*\|\s*Where-Object\s*\{\s*\$_\.at\s*-lt\s*\$Initial\.Native\.uiBusyEndUnixMs/);
  assert.match(runner, /CursorIs\(32513\)/);
  assert.match(runner, /CursorState\(\)\s*-eq\s*\$Proof\.cursorBaseline/);
  assert.match(runner, /ClipState\(\)\s*-eq\s*\$Proof\.clipBaseline/);
  for (const oracle of ["Capture-HeldKey 'interceptedAfterLifecycle' $true", "Capture-HeldKey 'releasedAfterLifecycle' $false",
    "Capture-HeldKey 'releasedAfterProducerDisconnect' $false", 'rawKeyDownMessages', 'rawPointerDownMessages',
    'asyncDownSamples', 'keyStateDownSamples', 'keyboardStateDownSamples', 'Assert-WithdrawnPixel']) {
    assert.ok(runner.includes(oracle), `missing strict post-resume oracle ${oracle}`);
  }
});

test('human launcher fixes the delayed case without changing existing launcher defaults', () => {
  assert.match(launcher, /-Case\s+primary-paused\s+-UiBusyMilliseconds\s+2800\s+@PSBoundParameters/);
  assert.doesNotMatch(launcher, /\$Prototype|\$DiagnosticInputOnly/);
  for (const name of ['primary-resize', 'primary-final-destroy', 'primary-paused']) {
    const existing = fs.readFileSync(path.join(__dirname, `../../scripts/test-cases/late-d3d11-same-hwnd-${name}.ps1`), 'utf8');
    assert.doesNotMatch(existing, /UiBusyMilliseconds|ui-busy-ms/);
  }
  assert.match(runner, /uiBusyHookRecoveryProven\s*=\s*-not\s*\$DiagnosticInputOnly/);
});
