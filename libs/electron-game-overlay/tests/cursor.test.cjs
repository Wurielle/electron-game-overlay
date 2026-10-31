const test = require('node:test');
const assert = require('node:assert/strict');
const { electronCursorCode, isCursorCode } = require('../dist/lib/cursor.js');
test('Chromium cursor names map to bounded target-process system resources', () => {
  for (const [type, code] of [
    ['pointer', 32512],
    ['default', 32512],
    ['hand', 32649],
    ['text', 32513],
    ['ew-resize', 32644],
    ['ns-resize', 32645],
    ['nesw-resize', 32643],
    ['nwse-resize', 32642],
    ['move', 32646],
    ['not-allowed', 32648],
    ['none', 0],
    ['custom', 32512],
    ['unknown', 32512],
  ]) {
    assert.equal(electronCursorCode(type), code, type);
    assert.equal(isCursorCode(code), true);
  }
  for (const value of [null, '32512', -1, 32516, Infinity, {}, 1.5])
    assert.equal(isCursorCode(value), false);
});
