const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InputEventTranslator,
  WINDOWS_MESSAGE,
} = require('../dist/lib/input-translation.js');

const message = (msg, wparam = 0, lparam = 0) => ({
  windowId: 7,
  msg,
  wparam,
  lparam,
});

const point = (x, y) => ((y & 0xffff) << 16) | (x & 0xffff);
const wheel = (delta, keyState = 0) =>
  ((delta & 0xffff) << 16) | (keyState & 0xffff);

test('keyboard messages preserve the native key map and ordered modifiers', () => {
  const translator = new InputEventTranslator();
  const leftShiftScanCode = 0x2a << 16;

  assert.deepEqual(
    translator.translate(
      message(WINDOWS_MESSAGE.keyDown, 0x10, leftShiftScanCode),
    ),
    {
      type: 'keyDown',
      keyCode: 'Shift',
      modifiers: ['shift', 'left'],
    },
  );
  assert.deepEqual(
    translator.translate(message(WINDOWS_MESSAGE.keyDown, 0x41)),
    {
      type: 'keyDown',
      keyCode: 'A',
      modifiers: ['shift'],
    },
  );
  assert.deepEqual(
    translator.translate(
      message(WINDOWS_MESSAGE.keyUp, 0x10, leftShiftScanCode),
    ),
    {
      type: 'keyUp',
      keyCode: 'Shift',
      modifiers: ['left'],
    },
  );

  assert.deepEqual(
    translator.translate(message(WINDOWS_MESSAGE.keyDown, 0x0d, 1 << 24)),
    {
      type: 'keyDown',
      keyCode: 'Enter',
      modifiers: ['isKeypad'],
    },
  );
});

test('UTF-16 pairs and WM_UNICHAR become Electron char events', () => {
  const translator = new InputEventTranslator();

  assert.deepEqual(
    translator.translate(
      message(WINDOWS_MESSAGE.sysChar, 'A'.codePointAt(0), 1 << 29),
    ),
    { type: 'char', keyCode: 'A', modifiers: ['alt'] },
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.char, 0xd83d)),
    undefined,
  );
  assert.deepEqual(
    translator.translate(message(WINDOWS_MESSAGE.char, 0xde03)),
    { type: 'char', keyCode: '😃', modifiers: [] },
  );
  assert.deepEqual(
    translator.translate(message(WINDOWS_MESSAGE.uniChar, 0x1f642)),
    { type: 'char', keyCode: '🙂', modifiers: [] },
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.uniChar, 0xffff)),
    undefined,
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.uniChar, 0xd800)),
    undefined,
  );
});

test('mouse buttons, signed coordinates, wheel deltas, and key-state flags match the addon', () => {
  const translator = new InputEventTranslator();

  assert.deepEqual(
    translator.translate(
      message(
        WINDOWS_MESSAGE.leftButtonDoubleClick,
        0x0001 | 0x0004 | 0x0008,
        point(-12, 34),
      ),
    ),
    {
      type: 'mouseDown',
      button: 'left',
      clickCount: 2,
      x: -12,
      y: 34,
      modifiers: ['control', 'shift', 'leftButtonDown'],
    },
  );
  assert.deepEqual(
    translator.translate(
      message(WINDOWS_MESSAGE.mouseWheel, wheel(-120), point(300, -200)),
    ),
    {
      type: 'mouseWheel',
      deltaY: -120,
      canScroll: true,
      x: 300,
      y: -200,
      modifiers: [],
    },
  );
  assert.deepEqual(
    translator.translate(
      message(WINDOWS_MESSAGE.mouseHorizontalWheel, wheel(120), point(5, 6)),
    ),
    {
      type: 'mouseWheel',
      deltaX: -120,
      canScroll: true,
      x: 5,
      y: 6,
      modifiers: [],
    },
  );
});

test('unsupported X buttons and interrupted surrogate sequences are ignored', () => {
  const translator = new InputEventTranslator();

  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.xButtonDown)),
    undefined,
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.xButtonUp)),
    undefined,
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.xButtonDoubleClick)),
    undefined,
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.deadChar, 0x005e)),
    undefined,
  );
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.sysDeadChar, 0x005e)),
    undefined,
  );
  assert.equal(translator.translate(message(0x0108)), undefined);
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.uniChar, 0x110000)),
    undefined,
  );
  assert.equal(translator.translate(message(0x0000)), undefined);
  assert.equal(
    translator.translate(message(WINDOWS_MESSAGE.char, 0xd83d)),
    undefined,
  );
  translator.translate(message(WINDOWS_MESSAGE.keyDown, 0x41));
  assert.deepEqual(
    translator.translate(message(WINDOWS_MESSAGE.char, 0xde03)),
    { type: 'char', keyCode: '\ude03', modifiers: [] },
  );
});
