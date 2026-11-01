const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// These guards cover the mapped native host boundary. Rust and SDK socket
// tests cover capability negotiation and required-capability rejection.
const filename = path.resolve(__dirname,
  '../../electron-game-overlay-runtime/src/electron_game_overlay_addon.cpp');
const source = fs.readFileSync(filename, 'utf8');
const lexical = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const blank = value => value.replace(/[^\r\n]/g, ' ');
const code = source.replace(lexical, blank);
const literals = source.replace(lexical,
  value => value.startsWith('//') || value.startsWith('/*') ? blank(value) : value);

function definition(name) {
  const signature = new RegExp(`\\b(?:bool|ego_transport\\s*\\*)\\s*${name}\\s*\\(([^)]*)\\)\\s*\\{`, 'm').exec(code);
  assert.ok(signature, `missing native function ${name}`);
  const start = signature.index + signature[0].length;
  let depth = 1;
  for (let end = start; end < code.length; end++) {
    if (code[end] === '{') depth++;
    if (code[end] === '}' && --depth === 0) {
      return { body: code.slice(start, end), literals: literals.slice(start, end) };
    }
  }
  assert.fail(`unbalanced native function ${name}`);
}

test('copied buffered raw input requires the actual mapped host ABI and private gate', () => {
  const registration = definition('register_compatible_addon');
  assert.match(registration.body,
    /HMODULE\s+const\s+host\s*=\s*reshade::internal::get_reshade_module_handle\s*\(\s*\)/);
  assert.match(registration.literals,
    /const\s+auto\s+host_abi\s*=[\s\S]*?GetProcAddress\s*\(\s*host\s*,\s*"ElectronGameOverlayReShadeHostAbi"\s*\)/);
  assert.match(registration.literals,
    /const\s+bool\s+has_private_gate\s*=\s*GetProcAddress\s*\(\s*host\s*,\s*"ElectronGameOverlayReShadeAddonGate"\s*\)\s*!=\s*nullptr/);
  assert.match(registration.body,
    /g_has_private_input_observer\s*=\s*host_abi\s*!=\s*nullptr\s*&&\s*\*host_abi\s*==\s*1\s*&&\s*has_private_gate\s*;/);
  assert.doesNotMatch(registration.body,
    /\b(?:EGO_ADDON_BUILD_ID|EGO_NATIVE_RUNTIME_GENERATION|package_version|build_id|distribution_manifest)\b/);
});

test('native transport capabilities are supplied atomically to the constructor', () => {
  const { body } = definition('retain_transport');
  assert.match(body,
    /const\s+std::uint64_t\s+input_capabilities\s*=\s*EGO_INPUT_CAPABILITY_COPIED_WM_INPUT\s*\|\s*\(\s*g_has_private_input_observer\s*\?\s*EGO_INPUT_CAPABILITY_COPIED_RAW_INPUT_BUFFER\s*:\s*0\s*\)\s*;/);
  assert.match(body,
    /const\s+ego_status\s+status\s*=\s*ego_transport_create_for_directory_with_input_capabilities\s*\(\s*EGO_ABI_VERSION\s*,\s*reinterpret_cast<const\s+std::uint8_t\s*\*>\s*\(\s*g_private_run_directory\.data\s*\(\s*\)\s*\)\s*,\s*g_private_run_directory\.size\s*\(\s*\)\s*,\s*input_capabilities\s*,\s*&g_transport\s*\)/);
  const capabilities = body.indexOf('const std::uint64_t input_capabilities');
  const create = body.indexOf('ego_transport_create_for_directory_with_input_capabilities');
  const firstPublication = body.indexOf('publish_runtime_diagnostic');
  const firstReference = body.indexOf('++g_transport_references');
  assert.ok(capabilities >= 0 && capabilities < create);
  assert.ok(create < firstPublication && firstPublication < firstReference,
    'the worker must receive capabilities before transport readiness or references are published');
});

test('native startup cannot advertise optimistic capabilities and downgrade after connecting', () => {
  const { body } = definition('retain_transport');
  const creations = [...body.matchAll(/\b(ego_transport_create\w*)\s*\(/g)]
    .map(match => match[1]);
  assert.deepEqual(creations, ['ego_transport_create_for_directory_with_input_capabilities']);
  assert.doesNotMatch(code, /\bego_transport_(?:set|update|configure)\w*capabilit\w*\s*\(/);
  assert.match(body,
    /if\s*\(\s*status\s*!=\s*EGO_STATUS_OK\s*\)\s*\{[^}]*g_transport\s*=\s*nullptr\s*;\s*return\s+nullptr\s*;/);
  assert.ok(body.indexOf('status != EGO_STATUS_OK') < body.indexOf('publish_runtime_diagnostic'),
    'failed capability-aware construction must not publish a usable transport');
});
