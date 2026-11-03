'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// These source guards protect native lifetime/publication boundaries. The
// console filename fixture and graphics demos provide execution coverage.
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

function requiredPosition(text, anchor, start = 0) {
  const position = text.indexOf(anchor, start);
  assert.ok(position >= 0, `missing native ordering anchor ${anchor}`);
  return position;
}

test('preload classification and invalid-name rejection precede registry or public publication', () => {
  const attach = body('initialize_addon_process');
  const classify = requiredPosition(attach, 'ego::preloaded_addon::classify_filename');
  const invalid = requiredPosition(attach, 'preload_filename_kind::invalid');
  const open = requiredPosition(attach, 'g_cooperative.open');
  assert.ok(classify < invalid && invalid < open);
  assert.match(attach.slice(invalid, open), /return\s+FALSE\s*;/u);
  assert.match(attach, /if\s*\(is_preloaded_member\(\)\)\s*NAME\s*=\s*g_preload_identity\.public_name\.data\(\)/u);
});

test('every valid folder-loaded module registers metadata while only the dispatcher registers events', () => {
  assert.match(body('register_compatible_addon'),
    /register_public_metadata\s*=\s*g_cooperative_dispatcher\s*\|\|\s*is_preloaded_member\(\)/u);
  assert.match(body('AddonInit'), /if\s*\(g_cooperative_dispatcher\)\s*register_dispatcher_events\(\)/u);
  assert.match(body('initialize_addon_process'), /if\s*\(g_cooperative_dispatcher\)\s*register_dispatcher_events\(\)/u);
  assert.match(body('register_dispatcher_events'), /if\s*\(g_dispatcher_events_registered\)\s*return/u);
});

test('thread notifications keep filename storage outside the DllMain stack frame', () => {
  assert.match(source, /__declspec\(noinline\)\s+BOOL\s+initialize_addon_process\(HMODULE\s+module\)/u);
  assert.match(body('DllMain'), /case\s+DLL_PROCESS_ATTACH\s*:\s*return\s+initialize_addon_process\(module\)/u);
  assert.doesNotMatch(body('DllMain'), /std::array|wchar_t|GetModuleFileNameW|classify_filename|\bnew\b/u);
  assert.match(body('initialize_addon_process'), /path_capacity\s*=\s*32768/u);
  assert.match(body('initialize_addon_process'), /std::unique_ptr<wchar_t\[\]>\s+path\(new\s*\(std::nothrow\)\s+wchar_t\[path_capacity\]\)/u);
});

test('preloaded activation validates an owned canonical route before the existing-member success path', () => {
  const initialize = body('initialize_cooperative_member');
  const fastPath = requiredPosition(initialize, 'g_participant_id.load');
  assert.ok(requiredPosition(initialize, 'std::filesystem::canonical') < fastPath);
  assert.ok(requiredPosition(initialize, 'has_owned_stage_marker(canonical)') < fastPath);
  assert.ok(requiredPosition(initialize, 'return ERROR_ALREADY_ASSIGNED') < fastPath);
  assert.ok(requiredPosition(initialize, 'g_preload_bound_directory = directory') < requiredPosition(initialize, 'reserve_participant'));
  assert.match(initialize, /else\s+if\s*\(is_preloaded_member\(\)\)\s*return\s+ERROR_INVALID_FUNCTION/u);
  assert.match(body('ElectronGameOverlayActivatePreloadedMemberV1'),
    /initialize_cooperative_member\(request,\s*true,\s*true\)/u);
});

test('automatic preload startup cannot admit a participant or retain private transport', () => {
  const automatic = body('initialize_automatic_member');
  assert.match(automatic, /if\s*\(is_preloaded_member\(\)\)\s*return\s+ERROR_NOT_READY/u);
  assert.ok(requiredPosition(automatic, 'return ERROR_NOT_READY') < requiredPosition(automatic, 'initialize_cooperative_member'));
  const transport = body('initialize_own_surface_transport');
  const guard = requiredPosition(transport, 'g_participant_id.load');
  const defer = requiredPosition(transport, 'return', guard);
  assert.ok(defer < requiredPosition(transport, 'retain_transport'));
  assert.ok(defer < requiredPosition(transport, 'transport_initialization_complete = true'));
  assert.ok(defer < requiredPosition(transport, 'swapchain_ready_published = true'));
});

test('a dormant first adapter still reaches hook readiness and active peer frame callbacks', () => {
  assert.match(body('can_drive_dormant_adapter'), /is_preloaded_member\(\)\s*&&\s*g_cooperative_dispatcher/u);
  for (const name of ['initialize_own_surface', 'on_reshade_overlay']) {
    assert.match(body(name), /initialize_automatic_member\(\)\s*!=\s*ERROR_SUCCESS\s*&&\s*!can_drive_dormant_adapter\(\)/u);
  }
  const overlay = body('on_reshade_overlay');
  assert.ok(requiredPosition(overlay, 'advance_own_surface_startup') < requiredPosition(overlay, 'snapshot_participants'));
  assert.ok(requiredPosition(overlay, 'g_adapter_window_ready.load') < requiredPosition(overlay, 'snapshot_participants'));
});

test('dormant baseline teardown uses the same callback snapshot rather than a racing participant id', () => {
  for (const name of ['on_destroy_swapchain', 'on_destroy_effect_runtime']) {
    const destroy = body(name);
    assert.match(destroy, /participant\.callbacks\.destroy_surface\s*==\s*cooperative_destroy_surface/u);
    assert.match(destroy, /if\s*\(!own_surface_destroyed\)\s*cooperative_destroy_surface\(nullptr,/u);
    assert.doesNotMatch(destroy, /g_participant_id/u);
    assert.equal((destroy.match(/snapshot_participants\(\)/gu) || []).length, 1);
  }
});

test('only the first dormant adapter pins without participant admission and handles failure explicitly', () => {
  const initialize = body('AddonInit');
  assert.match(initialize, /can_drive_dormant_adapter\(\)\s*&&\s*!g_module_pinned\.load/u);
  assert.doesNotMatch(initialize, /reserve_participant/u);
  assert.ok(requiredPosition(initialize, 'pin_cooperative_modules') < requiredPosition(initialize, 'register_dispatcher_events'));
  assert.match(initialize, /AddonUninit\(module,\s*g_reshade_host_module\);\s*g_cooperative\.abandon_dispatcher_claim\(\);\s*g_cooperative_dispatcher\s*=\s*false;\s*return\s+false/u);
  const member = body('initialize_cooperative_member');
  assert.ok(requiredPosition(member, 'reserve_participant') < requiredPosition(member, 'pin_cooperative_modules'));
});

test('stock unload removes preload metadata while retaining the irrevocable member binding', () => {
  const uninitialize = body('AddonUninit');
  assert.match(uninitialize, /if\s*\(g_cooperative_dispatcher\s*\|\|\s*is_preloaded_member\(\)\)/u);
  assert.doesNotMatch(uninitialize, /g_preload_bound_directory|g_participant_id|g_module_pinned|g_cooperative\.leave/u);
  assert.match(source, /static_assert\(sizeof\(member_initialize_v1\)\s*==\s*65544\)/u);
  assert.match(source, /static_assert\(alignof\(member_initialize_v1\)\s*==\s*4\)/u);
  assert.match(source, /EXPORT:ElectronGameOverlayActivatePreloadedMemberV1=_ElectronGameOverlayActivatePreloadedMemberV1@4/u);
});
