const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the built SDK does not retain removed hudhook implementation modules', () => {
  const files = readdirSync(path.resolve(__dirname, '..', 'dist', 'lib'));

  assert.ok(files.includes('overlay-loopback-transport.js'));
  assert.ok(files.includes('overlay-loopback-transport.d.ts'));
  assert.deepEqual(
    files.filter((file) => /^hudhook-(?:launcher|transport)\./.test(file)),
    [],
  );
});
