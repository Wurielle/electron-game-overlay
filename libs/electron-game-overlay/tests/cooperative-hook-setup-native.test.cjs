const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Source boundary guards complement actual owner-thread/graphics acceptance;
// these tests never install a hook, create a transport, or execute native code.
const filename = path.resolve(__dirname,
  '../../electron-game-overlay-runtime/src/electron_game_overlay_addon.cpp');
const source = fs.readFileSync(filename, 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  value => value.replace(/[^\r\n]/g, ' '));

function braced(text, opening, label) {
  let depth = 1;
  for (let end = opening + 1; end < text.length; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}' && --depth === 0) return text.slice(opening + 1, end);
  }
  assert.fail(`unbalanced native block ${label}`);
}

function definition(name) {
  const signature = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?:noexcept\\s*)?\\{`, 'm').exec(code);
  assert.ok(signature, `missing native function ${name}`);
  return braced(code, signature.index + signature[0].lastIndexOf('{'), name);
}

function conditional(body, condition, label) {
  const match = condition.exec(body);
  assert.ok(match, `missing native condition ${label}`);
  return braced(body, match.index + match[0].lastIndexOf('{'), label);
}

test('cross-thread hook setup posts a generation request and same-thread setup installs directly', () => {
  const install = definition('install_official_window_subclass');
  assert.match(install, /const\s+std::scoped_lock\s+setup_lock\s*\(\s*owner\.setup_mutex\s*\)/);
  assert.match(install, /GetCurrentThreadId\s*\(\s*\)\s*==\s*thread_id\s*&&\s*complete_official_subclass_setup\s*\(\s*owner\s*,\s*root\s*,\s*official_subclass_id\s*\(\s*owner\s*\)\s*\)/);
  assert.match(install, /PostMessageW\s*\(\s*root\s*,[\s\S]*?official_subclass_install\s*,\s*static_cast<LPARAM>\s*\(\s*official_subclass_id\s*\(\s*owner\s*\)\s*\)/);
  assert.doesNotMatch(install, /\b(?:SendMessage\w*|SetWindowSubclass|SetWindowsHookEx\w*)\s*\(/);
  assert.doesNotMatch(code, /\bWH_CALLWNDPROC\b/);
  assert.match(definition('complete_official_subclass_setup'),
    /SetWindowSubclass\s*\(\s*window\s*,\s*official_window_subclass\s*,\s*static_cast<UINT_PTR>\s*\(\s*cookie\s*\)\s*,\s*reinterpret_cast<DWORD_PTR>\s*\(\s*&owner\s*\)/);
});

test('the queued setup request is serviced before the private-observer input bypass', () => {
  const hook = definition('official_get_message_hook');
  assert.match(hook, /if\s*\(\s*service_official_subclass_setup\s*\(\s*\*details\s*\)\s*\|\|\s*g_has_private_input_observer\s*\)\s*return\s+CallNextHookEx/);
  assert.ok(hook.indexOf('service_official_subclass_setup') < hook.indexOf('g_has_private_input_observer'));
  const service = definition('service_official_subclass_setup');
  assert.match(service, /const\s+std::scoped_lock\s+setup_lock\s*\(\s*owner\.setup_mutex\s*\)/);
  assert.doesNotMatch(service, /g_official_hook_mutex/);
  assert.match(service, /complete_official_subclass_setup\s*\(\s*owner\s*,\s*message\.hwnd\s*,\s*cookie\s*\)/);
  assert.match(service, /message\.message\s*=\s*WM_NULL\s*;\s*message\.wParam\s*=\s*0\s*;\s*message\.lParam\s*=\s*0\s*;/);
});

test('owner-slot reuse cannot install or remove a subclass with an obsolete generation', () => {
  assert.match(code, /std::mutex\s+setup_mutex\s*;/);
  assert.match(code, /std::atomic<std::uintptr_t>\s+setup_cookie\s*=\s*0\s*;/);
  assert.match(definition('official_subclass_id'), /return\s+owner\.setup_cookie\.load\s*\(\s*std::memory_order_acquire\s*\)/);
  const retain = definition('retain_official_hook_owner');
  assert.match(retain, /g_official_setup_cookie_sequence\.compare_exchange_weak\s*\(\s*cookie\s*,\s*cookie\s*\+\s*1/);
  assert.match(retain, /cookie\s*=\s*cookie\s*==\s*\(std::numeric_limits<std::uintptr_t>::max\)\s*\(\s*\)\s*\?\s*0\s*:\s*cookie\s*\+\s*1/);
  assert.match(retain, /const\s+std::scoped_lock\s+setup_lock\s*\(\s*owner\.setup_mutex\s*\)[\s\S]*?owner\.setup_cookie\.store\s*\(\s*cookie/);
  const complete = definition('complete_official_subclass_setup');
  assert.match(complete, /!owner\.setup_pending\s*\|\|\s*cookie\s*==\s*0\s*\|\|\s*official_subclass_id\s*\(\s*owner\s*\)\s*!=\s*cookie/);
  assert.match(complete, /owner\.root_window\.load\s*\([^)]*\)\s*!=\s*reinterpret_cast<std::uintptr_t>\s*\(\s*window\s*\)/);
  assert.match(complete, /owner\.thread_id\.load\s*\([^)]*\)\s*!=\s*GetCurrentThreadId\s*\(\s*\)/);
  const subclass = definition('official_window_subclass');
  assert.match(subclass, /subclass_id\s*!=\s*0\s*&&\s*subclass_id\s*==\s*official_subclass_id\s*\(\s*\*owner\s*\)/);
  assert.match(subclass, /wparam\s*==\s*official_subclass_remove\s*&&\s*static_cast<UINT_PTR>\s*\(\s*lparam\s*\)\s*==\s*subclass_id/);
});

test('cancellation invalidates pending setup under its mutex before checking subclass completion', () => {
  const remove = definition('remove_official_window_subclass');
  assert.match(remove, /^\s*\{\s*const\s+std::scoped_lock\s+setup_lock\s*\(\s*owner\.setup_mutex\s*\)\s*;\s*owner\.setup_pending\s*=\s*false\s*;\s*\}\s*if\s*\(\s*!owner\.subclass_ready\.load/);
  assert.match(remove, /RemoveWindowSubclass\s*\(\s*root\s*,\s*official_window_subclass\s*,\s*official_subclass_id\s*\(\s*owner\s*\)\s*\)/);
  assert.match(remove, /official_subclass_remove\s*,\s*static_cast<LPARAM>\s*\(\s*official_subclass_id\s*\(\s*owner\s*\)\s*\)/);
});

test('retry posting is bounded while a queued current-generation acknowledgement can rescue a timeout', () => {
  assert.match(code, /official_setup_timeout_ms\s*=\s*5000\s*;/);
  assert.match(code, /official_setup_retry_ms\s*=\s*250\s*;/);
  const retain = definition('retain_official_hook_owner');
  assert.match(retain, /owner\.setup_deadline\s*=\s*GetTickCount64\s*\(\s*\)\s*\+\s*official_setup_timeout_ms/);
  const install = definition('install_official_window_subclass');
  assert.match(install, /!owner\.setup_pending\s*\|\|\s*owner\.setup_terminal\s*\|\|\s*owner\.setup_deadline_reported\s*\)\s*return\s+false/);
  const timeout = conditional(install, /if\s*\(\s*now\s*>=\s*owner\.setup_deadline\s*\)\s*\{/, 'setup deadline');
  assert.match(timeout, /owner\.setup_deadline_reported\s*=\s*true/);
  assert.match(timeout, /owner\.install_error\.store\s*\(\s*ERROR_TIMEOUT/);
  assert.match(timeout, /return\s+false\s*;/);
  assert.doesNotMatch(timeout, /owner\.setup_pending\s*=\s*false/);
  assert.ok(install.indexOf('now >= owner.setup_deadline') < install.indexOf('PostMessageW'));
  assert.match(install, /if\s*\(\s*now\s*>=\s*owner\.setup_next_retry\s*\)\s*\{\s*owner\.setup_next_retry\s*=\s*now\s*\+\s*official_setup_retry_ms/);
  assert.doesNotMatch(definition('complete_official_subclass_setup'), /setup_deadline(?:_reported)?/);
  assert.doesNotMatch(definition('service_official_subclass_setup'), /setup_deadline(?:_reported)?/);
  const advance = definition('advance_official_hook_setup');
  assert.ok(advance.indexOf('owner->hook_ready.load') < advance.indexOf('owner->setup_deadline_reported'),
    'a real late acknowledgement must win over the earlier timeout diagnostic');
});

test('transport retention and requested swapchain readiness are independently published once', () => {
  const initialize = definition('initialize_own_surface_transport');
  assert.match(initialize, /const\s+std::scoped_lock\s+initialization_lock\s*\(\s*data\.transport_initialization_mutex\s*\)/);
  const construction = conditional(initialize, /if\s*\(\s*!data\.transport_initialization_complete\s*\)\s*\{/, 'transport completion');
  assert.match(construction, /data\.transport\s*=\s*retain_transport\s*\(\s*\)\s*;\s*data\.transport_initialization_complete\s*=\s*true/);
  assert.equal((initialize.match(/\bretain_transport\s*\(/g) || []).length, 1);
  const publication = conditional(initialize, /if\s*\(\s*publish_ready\s*&&\s*!data\.swapchain_ready_published\s*\)\s*\{/, 'ready publication');
  assert.match(publication, /publish_runtime_diagnostic\s*\(\s*data\.transport\s*,\s*EGO_RUNTIME_DIAGNOSTIC_SWAPCHAIN_READY\s*\)\s*;\s*data\.swapchain_ready_published\s*=\s*true/);
});

test('pending startup creates no transport or failure, while terminal and deadline failures remain visible', () => {
  const startup = definition('advance_own_surface_startup');
  const pending = conditional(startup, /if\s*\(\s*status\s*==\s*official_setup_status::pending\s*\)\s*\{/, 'pending startup');
  assert.match(pending, /return\s+false\s*;/);
  assert.doesNotMatch(pending, /retain_transport|initialize_own_surface_transport|publish_input_routing_failure|EGO_STATUS_INITIALIZATION_FAILED/);
  assert.ok(startup.indexOf('status == official_setup_status::pending') <
    startup.indexOf('initialize_own_surface_transport(data, status == official_setup_status::ready)'));
  const failed = conditional(startup, /if\s*\(\s*status\s*==\s*official_setup_status::failed\s*\)\s*\{/, 'failed startup');
  assert.match(failed, /!data\.official_hook_failure_reported/);
  assert.match(failed, /publish_input_routing_failure\s*\(\s*data\.transport\s*,\s*EGO_STATUS_INITIALIZATION_FAILED\s*\)/);
  assert.match(definition('advance_official_hook_setup'), /owner->setup_terminal\s*\|\|\s*owner->setup_deadline_reported\s*\?\s*official_setup_status::failed\s*:\s*official_setup_status::pending/);
});

test('the dispatcher readiness boundary gates every participant preparation and input callback', () => {
  const overlay = definition('on_reshade_overlay');
  assert.match(overlay, /if\s*\(\s*data\s*==\s*nullptr\s*\|\|\s*!advance_own_surface_startup\s*\(\s*\*data\s*\)\s*\)\s*return/);
  assert.match(overlay, /if\s*\(\s*!g_adapter_window_ready\.load\s*\(\s*std::memory_order_acquire\s*\)\s*\)\s*return/);
  const acknowledge = overlay.indexOf('g_adapter_window_ready.store(true');
  const boundary = overlay.indexOf('!g_adapter_window_ready.load');
  const prepare = overlay.indexOf('participant.callbacks.prepare_frame(participant.context, runtime)');
  const flush = overlay.indexOf('participant.callbacks.flush_input(participant.context, runtime)');
  assert.ok(acknowledge >= 0 && acknowledge < boundary && boundary < prepare && prepare < flush);
  assert.ok(boundary < overlay.indexOf('drain_cooperative_sources'));
  assert.doesNotMatch(overlay.slice(0, boundary), /participant\.callbacks\.(?:prepare_frame|flush_input)\s*\(/);
});

test('numeric HWND reuse on the same process and thread still requires the module-specific generation witness', () => {
  const property = definition('official_owner_property_name');
  assert.match(property, /std::to_wstring\s*\(\s*reinterpret_cast<std::uintptr_t>\s*\(\s*&g_official_hook_owners\s*\)\s*\)/);
  assert.match(property, /return\s+name\.c_str\s*\(\s*\)/);
  const matches = definition('official_owner_window_matches');
  assert.match(matches, /const\s+auto\s+cookie\s*=\s*owner\.setup_cookie\.load/);
  assert.match(matches, /GetWindowThreadProcessId\s*\(\s*window\s*,\s*&process_id\s*\)/);
  assert.match(matches, /return\s+cookie\s*!=\s*0\s*&&\s*window\s*!=\s*nullptr\s*&&\s*process_id\s*==\s*GetCurrentProcessId\s*\(\s*\)\s*&&\s*thread_id\s*==\s*owner\.thread_id\.load\s*\([^)]*\)\s*&&\s*reinterpret_cast<std::uintptr_t>\s*\(\s*GetPropW\s*\(\s*window\s*,\s*official_owner_property_name\s*\(\s*\)\s*\)\s*\)\s*==\s*cookie/);
  const retain = definition('retain_official_hook_owner');
  const reuse = retain.slice(0, retain.indexOf('++owner.references'));
  assert.match(reuse, /!official_owner_window_matches\s*\(\s*owner\s*,\s*root\s*\)\s*\)\s*\{\s*continue\s*;/);
  assert.ok(reuse.includes('owner.thread_id.load') && reuse.includes('process_id != GetCurrentProcessId()'));
  const complete = definition('complete_official_subclass_setup');
  assert.match(complete, /!official_owner_window_matches\s*\(\s*owner\s*,\s*window\s*\)/);
  assert.ok(complete.indexOf('!official_owner_window_matches') < complete.indexOf('SetWindowSubclass'));
});

test('new owner publication establishes its HWND generation property before exposing the root', () => {
  const retain = definition('retain_official_hook_owner');
  assert.match(retain, /SetPropW\s*\(\s*root\s*,\s*official_owner_property_name\s*\(\s*\)\s*,\s*reinterpret_cast<HANDLE>\s*\(\s*cookie\s*\)\s*\)/);
  const cookie = retain.indexOf('owner.setup_cookie.store(cookie');
  const witness = retain.indexOf('SetPropW');
  const publish = retain.indexOf('owner.root_window.store');
  assert.ok(cookie >= 0 && cookie < witness && witness < publish,
    'a ready or pending owner must never publish before its exact HWND witness');
  const failedProperty = conditional(retain,
    /if\s*\(\s*cookie\s*!=\s*0\s*&&\s*SetPropW[\s\S]*?==\s*FALSE\s*\)\s*\{/,
    'owner property failure');
  assert.match(failedProperty, /owner\.setup_pending\s*=\s*false\s*;\s*owner\.setup_terminal\s*=\s*true/);
});

test('window destruction cancels its setup and cannot remove a replacement generation property', () => {
  const subclass = definition('official_window_subclass');
  assert.match(subclass, /subclass_id\s*==\s*official_subclass_id\s*\(\s*\*owner\s*\)\s*&&\s*official_owner_window_matches\s*\(\s*\*owner\s*,\s*window\s*\)/);
  const destroyed = conditional(subclass,
    /if\s*\(\s*owner_valid\s*&&\s*message\s*==\s*WM_NCDESTROY\s*\)\s*\{/,
    'window incarnation retirement');
  const cancellation = braced(destroyed, destroyed.indexOf('{'), 'destruction setup cancellation');
  assert.match(cancellation, /const\s+std::scoped_lock\s+setup_lock\s*\(\s*owner->setup_mutex\s*\)/);
  assert.match(cancellation, /owner->setup_pending\s*=\s*false\s*;\s*owner->setup_terminal\s*=\s*true/);
  assert.match(cancellation, /owner->hook_ready\.store\s*\(\s*false/);
  assert.match(cancellation, /owner->subclass_ready\.store\s*\(\s*false/);
  assert.match(destroyed, /remove_official_owner_property\s*\(\s*\*owner\s*,\s*window\s*\)/);
  assert.match(destroyed, /RemoveWindowSubclass\s*\(\s*window\s*,\s*official_window_subclass\s*,\s*subclass_id\s*\)/);
  const removeProperty = definition('remove_official_owner_property');
  assert.match(removeProperty, /if\s*\(\s*window\s*!=\s*nullptr\s*&&\s*cookie\s*!=\s*0\s*&&\s*reinterpret_cast<std::uintptr_t>\s*\(\s*GetPropW\s*\(\s*window\s*,\s*official_owner_property_name\s*\(\s*\)\s*\)\s*\)\s*==\s*cookie\s*\)\s*RemovePropW\s*\(\s*window\s*,\s*official_owner_property_name\s*\(\s*\)\s*\)/);
  assert.equal((code.match(/\bRemovePropW\s*\(/g) || []).length, 1,
    'all generation-property removal must pass the exact-cookie check');
});
