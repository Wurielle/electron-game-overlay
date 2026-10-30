'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const source = path.resolve(__dirname, '../src/lib/overlay-process-identity.ts');
const loaded = new Module(source, module);
loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, source);
const { isValidProcessCreationTime100ns: valid } = loaded.exports;
test('process creation identity preserves canonical uint64 FILETIME strings without numeric coercion', () => {
  for (const value of ['1', '9007199254740993', '18446744073709551615']) assert.equal(valid(value), true, `canonical value must be accepted: ${value}`);
  for (const value of [undefined, null, 1, 9007199254740992, 1n, '', '0', '00', '01', '+1', '-1', ' 1', '1 ', '1\n', '1\r', '1\r\n', '1\u2028', '1\u2029', '1.0', '1e1', '18446744073709551616', '1'.repeat(1000), '١', {}, []]) assert.equal(valid(value), false, 'noncanonical or overflowing evidence must be rejected');
});
