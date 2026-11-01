const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// The native registry fixture exercises the exact role/epoch policy. These
// guards bind it to production rendering and the singular input authority.
const source = fs.readFileSync(path.resolve(__dirname,
  '../../electron-game-overlay-runtime/src/electron_game_overlay_addon.cpp'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  value => value.replace(/[^\r\n]/g, ' '));

function block(text, opening) {
  let depth = 1;
  for (let end = opening + 1; end < text.length; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}' && --depth === 0) return text.slice(opening + 1, end);
  }
  assert.fail('unbalanced native block');
}

function definition(name) {
  const signature = new RegExp(`\\b(?:void|bool)\\s+${name}\\s*\\([^)]*\\)\\s*(?:noexcept\\s*)?\\{`, 'm').exec(code);
  assert.ok(signature, `missing native function ${name}`);
  return block(code, signature.index + signature[0].length - 1);
}

test('each eligible same-HWND Present drives preparation, input and rendering while an anchor is paused', () => {
  const prepare = definition('cooperative_prepare_frame');
  assert.match(prepare, /classify_presentation\s*\(\s*runtime->get_native\s*\(\s*\)\s*,\s*reinterpret_cast<std::uintptr_t>\s*\(\s*runtime->get_hwnd\s*\(\s*\)\s*\)\s*,\s*logical_owner\s*,\s*primary\.native_id\s*,\s*primary\.hwnd\s*\)/);
  assert.match(prepare, /if\s*\(\s*!ego::cooperative::drives_logical_frame\s*\(\s*role\s*\)\s*\)\s*return\s*;\s*if\s*\(\s*!prepare_own_frame\s*\(\s*runtime\s*,\s*logical_owner\s*\)\s*\)\s*return\s*;/);
  assert.doesNotMatch(prepare, /if\s*\(\s*!logical_owner\s*\)\s*return/);
  for (const mutation of ['publish_windows', 'set_interception', 'ego_transport_cooperative_focus_request', 'ego_transport_set_cooperative_focus']) {
    assert.ok(prepare.indexOf(mutation) > prepare.indexOf('prepare_own_frame'), `${mutation} must follow current-presenter preparation`);
  }
  const overlay = definition('on_reshade_overlay');
  assert.match(overlay, /if\s*\(\s*!ego::cooperative::drives_logical_frame\s*\(\s*role\s*\)\s*\)\s*return\s*;\s*drain_cooperative_sources/);
  assert.match(overlay, /callbacks\.flush_input[\s\S]*apply_cooperative_adapter_state\s*\(\s*runtime\s*\)[\s\S]*apply_cooperative_presentation_cursor\s*\(\s*runtime\s*\)[\s\S]*snapshot_windows[\s\S]*callbacks\.render_window\s*\([^;]*runtime/);
  assert.doesNotMatch(overlay, /if\s*\(\s*logical_owner\s*\)/);
  assert.equal((overlay.match(/drain_cooperative_sources\s*\(/g) || []).length, 1);
});

test('the current presenter advances one shared phase using its own snapshot and GPU resources', () => {
  const compose = definition('compose_electron_scene');
  assert.ok(compose.indexOf('ego_transport_get_cooperative_input_state') < compose.indexOf('ego_transport_acquire_scene'));
  assert.match(compose, /reconcile_registrations[\s\S]*registrations\s*!=\s*g_producer_registration_order[\s\S]*reorder_registrations/);
  assert.match(compose, /device\s*\*const\s+device\s*=\s*runtime->get_device\s*\(\s*\)/);
  assert.match(compose, /runtime->get_command_queue\s*\(\s*\)->wait_idle/);
  assert.doesNotMatch(compose, /find_swapchain_data|primary_surface/,
    'the current presentation must never upload or wait through a paused peer runtime');
  const prepare = definition('prepare_own_frame');
  assert.match(prepare, /g_member_input_driver\.activate\s*\(\s*runtime->get_native\s*\(\s*\)\s*\)/);
  assert.match(prepare, /publish_render_fps[\s\S]*compose_electron_scene\s*\(\s*runtime\s*,\s*\*data\s*\)/);
  const flush = definition('cooperative_flush_input');
  assert.match(flush, /g_member_input_driver\.native_id\s*\(\s*\)\s*!=\s*runtime->get_native/);
  assert.match(flush, /data->phase\s*=\s*g_cooperative_member_phase\s*;\s*update_input_ownership\s*\(\s*runtime\s*,\s*\*data\s*\)\s*;\s*g_cooperative_member_phase\s*=\s*data->phase/);
  assert.doesNotMatch(flush, /owns_primary_swapchain/);
});

test('global epoch retirement is once per logical stream and texture retirement remains local', () => {
  const prepare = definition('prepare_own_frame');
  assert.match(prepare, /g_logical_session_epoch\.observe\s*\(\s*session_epoch\s*\)/);
  assert.match(prepare, /if\s*\(\s*logical_epoch\.stale\s*\)\s*return\s+false\s*;/);
  assert.match(prepare, /if\s*\(\s*logical_epoch\.changed\s*\)[\s\S]*deactivate_dormant_input[\s\S]*reconcile_registrations[\s\S]*g_producer_registration_order\.clear/);
  assert.equal((prepare.match(/reconcile_registrations\s*\(/g) || []).length, 1);
  assert.match(prepare, /else\s+if\s*\(\s*session_epoch_changed\s*\)[\s\S]*cooperative_incarnations\.clear\s*\(\s*\)[\s\S]*retire_all_electron_textures\s*\(\s*runtime\s*,\s*\*data\s*\)/);
  assert.equal((code.match(/g_logical_session_epoch\.reset\s*\(\s*\)/g) || []).length, 2,
    'new bridge and authoritative final bridge retirement both reset logical epoch tracking');
});

test('cursor and hook teardown follow the current presenter without duplicating the window lease', () => {
  const adapter = definition('apply_cooperative_adapter_state');
  assert.match(adapter, /g_adapter_input_driver\.activate\s*\(\s*runtime->get_native\s*\(\s*\)\s*\)/);
  assert.match(adapter, /g_cooperative_adapter_phase\s*=\s*next_phase/);
  assert.doesNotMatch(adapter, /MouseDrawCursor/);
  const cursor = definition('apply_cooperative_presentation_cursor');
  assert.match(cursor, /cursor_code\.exchange[\s\S]*PostMessageW[\s\S]*MouseDrawCursor/);
  assert.match(cursor, /g_cooperative_adapter_phase\s*==\s*input_phase::enabled/);
  assert.doesNotMatch(cursor, /g_cooperative_adapter_phase\s*=(?!=)|ego_transport_|block_input_next_frame|publish_official_hook_phase/);
  const claim = definition('claim_official_input_owner');
  assert.match(claim, /route_window\.load\s*\([^)]*\)\s*!=\s*reinterpret_cast<std::uintptr_t>\s*\(\s*data\.window\s*\)\s*\)\s*return\s+false\s*;\s*owner->primary_token\.store\s*\(\s*data\.official_hook_token/);
  assert.doesNotMatch(claim, /ShowCursor|phase\.store|cursor_code\.store|retain_official_hook_owner/);
  const teardown = definition('on_destroy_effect_runtime');
  assert.match(teardown, /if\s*\(\s*g_adapter_input_driver\.release\s*\(\s*runtime->get_native\s*\(\s*\)\s*\)\s*\)[\s\S]*g_cooperative_adapter_phase\s*=\s*input_phase::disabled/);
});

test('driver retirement, admission and phase commits share control-only serialization', () => {
  const guarded = [];
  for (const match of code.matchAll(/g_logical_control\.run\s*\(\s*\[&\]\s*\{/g)) {
    guarded.push(block(code, match.index + match[0].length - 1));
  }
  const containing = needle => {
    const result = guarded.find(body => body.includes(needle));
    assert.ok(result, `${needle} must be inside the logical control boundary`);
    return result;
  };
  assert.match(containing('g_member_input_driver.release'), /deactivate_destroyed_runtime_input/);
  assert.match(containing('g_adapter_input_driver.release'), /g_cooperative_adapter_phase\s*=\s*input_phase::disabled[\s\S]*g_cooperative\.retire_input_driver_capture/);
  assert.match(containing('owner.primary_token.load'), /owner\.phase\.store[\s\S]*owner\.primary_token\.store\s*\(\s*0/);
  const admission = containing('g_logical_session_epoch.observe');
  assert.ok(admission.indexOf('logical_epoch.stale') < admission.indexOf('g_member_input_driver.activate'),
    'a rejected stale epoch must not steal current-driver authority');
  assert.match(containing('g_cooperative_member_phase = data->phase'), /ego_transport_set_cooperative_interception_checked[\s\S]*update_input_ownership[\s\S]*drain_input_messages/);
  containing('g_cooperative.publish_windows');
  containing('g_cooperative.reconcile_registrations');
  for (const body of guarded) {
    assert.doesNotMatch(body, /retire_all_electron_textures|texture_mutex|get_command_queue|create_texture|update_texture|capture_target_surface|callbacks\.(?:prepare_frame|render_window|destroy_surface)/,
      'control serialization must not include GPU work or cross-engine broadcasts');
  }
  const prepare = definition('cooperative_prepare_frame');
  assert.ok(prepare.indexOf('!prepare_own_frame') < prepare.indexOf('g_cooperative.publish_windows'));
  const destroy = definition('on_destroy_effect_runtime');
  const cleanup = containing('g_adapter_input_driver.release');
  assert.ok(destroy.indexOf(cleanup) + cleanup.length < destroy.indexOf('callbacks.destroy_surface'),
    'release the module control boundary before entering other engines');
  const overlay = definition('on_reshade_overlay');
  assert.ok(overlay.indexOf('g_adapter_input_driver.activate') < overlay.indexOf('callbacks.prepare_frame'));
  assert.ok(overlay.indexOf('claim_official_input_owner') < overlay.indexOf('callbacks.prepare_frame'),
    'stock cursor/hook teardown ownership must hand off before peer GPU work begins');
});

test('old anchor retirement preserves capture only through the validated current same-HWND driver', () => {
  const destroy = definition('on_destroy_swapchain');
  assert.ok(destroy.indexOf('return g_cooperative.primary_surface') < destroy.indexOf('g_cooperative.remove_surface'),
    'retain authoritative old anchor HWND before removing its inventory entry');
  const release = /g_logical_control\.run\s*\(\s*\[&\]\s*\{\s*g_cooperative\.release_primary_surface\s*\(\s*surface->get_native\s*\(\s*\)\s*,\s*g_adapter_input_driver\.native_id\s*\(\s*\)\s*,\s*retired_primary\.native_id\s*==\s*surface->get_native\s*\(\s*\)\s*\?\s*retired_primary\.hwnd\s*:\s*0/;
  assert.match(destroy, release,
    'the registry must validate a driver identity sampled under the same teardown/admission boundary');
});
