const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Guard the native authority boundary that router/socket tests cannot observe:
// a stale inactive-epoch read is not destruction of the actual graphics owner.
const filename = path.resolve(__dirname,
  '../../electron-game-overlay-runtime/src/electron_game_overlay_addon.cpp');
const source = fs.readFileSync(filename, 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  value => value.replace(/[^\r\n]/g, ' '));

function definition(name) {
  const signature = new RegExp(`\\b(?:void|bool)\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`, 'm').exec(code);
  assert.ok(signature, `missing native function ${name}`);
  const start = signature.index + signature[0].length;
  let depth = 1;
  for (let end = start; end < code.length; end++) {
    if (code[end] === '{') depth++;
    if (code[end] === '}' && --depth === 0) {
      return { parameters: signature[1], body: code.slice(start, end) };
    }
  }
  assert.fail(`unbalanced native function ${name}`);
}

test('native deactivation requires an explicit acknowledgement authority', () => {
  const { parameters, body } = definition('deactivate_input');
  assert.match(parameters, /bool\s+acknowledge\s*$/);
  assert.doesNotMatch(parameters, /acknowledge\s*=/);
  assert.match(body, /acknowledge\s*\?\s*ego_transport_retire_input_filter\s*\(\s*data\.transport\s*\)\s*:\s*ego_transport_apply_input_filter\s*\(\s*data\.transport\s*,\s*0\s*,\s*0\s*\)/);
  assert.doesNotMatch(body, /ego_transport_apply_input_filter\s*\(\s*data\.transport\s*,\s*0\s*,\s*1\s*\)/);
});

test('inactive-session observations and query failures cannot retire a new session', () => {
  const dormant = definition('deactivate_dormant_input').body;
  assert.match(dormant, /deactivate_input\s*\(\s*data\s*,\s*true\s*,\s*false\s*\)/);
  assert.doesNotMatch(dormant, /ego_transport_retire_input_filter\s*\(/);
  const prepare = definition('prepare_own_frame').body;
  assert.ok((prepare.match(/deactivate_dormant_input\s*\(\s*\*data\s*\)/g) || []).length >= 3,
    'query failure, epoch cleanup, and retained dormancy must use transitional deactivation');
  assert.doesNotMatch(prepare, /\bdeactivate_input\s*\(|\bego_transport_retire_input_filter\s*\(/);
});

test('only destruction of the current logical driver commits terminal retirement', () => {
  const destroyed = definition('deactivate_destroyed_runtime_input').body;
  assert.match(destroyed, /deactivate_input\s*\(\s*data\s*,\s*false\s*,\s*true\s*\)/);
  const destruction = definition('destroy_own_effect_runtime').body;
  assert.match(destruction, /if\s*\(\s*g_member_input_driver\.release\s*\(\s*runtime->get_native\s*\(\s*\)\s*\)\s*\)\s*(?:\{\s*)?deactivate_destroyed_runtime_input\s*\(\s*\*data\s*\)/);
  assert.doesNotMatch(destruction, /owns_primary_swapchain/,
    'a paused former primary must not retire input after another same-HWND presenter has taken over');
  const calls = [...code.matchAll(/\bdeactivate_input\s*\(([^)]*)\)/g)]
    .map(match => match[1].replace(/\s+/g, ''))
    .filter(argumentsText => !argumentsText.startsWith('swapchain_data&'));
  assert.deepEqual(calls.sort(), ['data,false,true', 'data,true,false']);
  assert.equal((code.match(/\bego_transport_retire_input_filter\s*\(/g) || []).length, 1);
});

test('normal rendering still uses a checked grant and terminal filter acknowledgement', () => {
  const flush = definition('cooperative_flush_input').body;
  assert.match(flush, /ego_transport_set_cooperative_interception_checked\s*\(/);
  assert.match(flush, /data->cooperative_input_revision/);
  assert.ok(flush.indexOf('ego_transport_set_cooperative_interception_checked') <
    flush.indexOf('update_input_ownership'));
  const update = definition('update_input_ownership').body;
  assert.match(update, /const\s+bool\s+acknowledge\s*=\s*data\.phase\s*==\s*input_phase::disabled\s*\|\|\s*data\.phase\s*==\s*input_phase::enabled/);
  assert.match(update, /ego_transport_apply_input_filter\s*\(\s*data\.transport\s*,\s*routing_enabled\s*\?\s*1U\s*:\s*0U\s*,\s*acknowledge\s*\?\s*1U\s*:\s*0U\s*\)/);
});
