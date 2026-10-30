const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getWindowContentBounds,
} = require('../dist/lib/window-content-bounds.js');

test('OSR raster bounds come from BrowserWindow content rather than outer frame', () => {
  const contentBounds = { x: 108, y: 132, width: 624, height: 321 };
  const framedWindow = {
    getBounds: () => ({ x: 100, y: 100, width: 640, height: 360 }),
    getContentBounds: () => contentBounds,
  };

  const actual = getWindowContentBounds(framedWindow);
  assert.deepEqual(actual, contentBounds);
  assert.notStrictEqual(actual, contentBounds);
});
