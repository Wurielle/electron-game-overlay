const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InputEventTranslator,
  parseNativeInputMessage,
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

test('authenticated input envelopes are canonicalized with authoritative PID ownership', () => {
  const legacy = {
    type: 'game.input',
    windowId: 7,
    msg: WINDOWS_MESSAGE.mouseMove,
    wparam: 0,
    lparam: point(-12, 34),
  };
  const parsedLegacy = parseNativeInputMessage(legacy, 4321);
  assert.deepEqual(parsedLegacy, {
    pid: 4321,
    windowId: 7,
    msg: WINDOWS_MESSAGE.mouseMove,
    wparam: 0,
    lparam: point(-12, 34),
  });
  assert.equal(Object.isFrozen(parsedLegacy), true);
  assert.notEqual(parsedLegacy, legacy);

  const parsedTaggedBoundary = parseNativeInputMessage(
    {
      type: 'game.input',
      windowId: 0xffff_ffff,
      msg: WINDOWS_MESSAGE.mouseHorizontalWheel,
      wparam: 0xffff_ffff,
      lparam: 0xffff_ffff,
      scaleFactorMicros: 0xffff_ffff,
    },
    0xffff_ffff,
  );
  assert.deepEqual(parsedTaggedBoundary, {
    pid: 0xffff_ffff,
    windowId: 0xffff_ffff,
    msg: WINDOWS_MESSAGE.mouseHorizontalWheel,
    wparam: 0xffff_ffff,
    lparam: 0xffff_ffff,
    scaleFactorMicros: 0xffff_ffff,
  });
});

test('authenticated input envelopes accept exactly the routable producer messages', () => {
  const routableMessages = [
    WINDOWS_MESSAGE.keyDown,
    WINDOWS_MESSAGE.keyUp,
    WINDOWS_MESSAGE.char,
    WINDOWS_MESSAGE.sysKeyDown,
    WINDOWS_MESSAGE.sysKeyUp,
    WINDOWS_MESSAGE.sysChar,
    WINDOWS_MESSAGE.uniChar,
    WINDOWS_MESSAGE.mouseMove,
    WINDOWS_MESSAGE.leftButtonDown,
    WINDOWS_MESSAGE.leftButtonUp,
    WINDOWS_MESSAGE.leftButtonDoubleClick,
    WINDOWS_MESSAGE.rightButtonDown,
    WINDOWS_MESSAGE.rightButtonUp,
    WINDOWS_MESSAGE.rightButtonDoubleClick,
    WINDOWS_MESSAGE.middleButtonDown,
    WINDOWS_MESSAGE.middleButtonUp,
    WINDOWS_MESSAGE.middleButtonDoubleClick,
    WINDOWS_MESSAGE.mouseWheel,
    WINDOWS_MESSAGE.mouseHorizontalWheel,
  ];

  for (const msg of routableMessages) {
    assert.notEqual(
      parseNativeInputMessage(
        {
          type: 'game.input',
          windowId: 7,
          msg,
          wparam: 0,
          lparam: 0,
        },
        4321,
      ),
      null,
    );
  }
});

test('authenticated input envelope parsing rejects coercion, bad ranges, and non-producer fields', async (t) => {
  const base = {
    type: 'game.input',
    windowId: 7,
    msg: WINDOWS_MESSAGE.mouseMove,
    wparam: 0,
    lparam: 0,
  };
  const cases = [
    ['null record', null],
    ['array record', []],
    ['wrong type', { ...base, type: 'game.input.other' }],
    ['wire PID', { ...base, pid: 9999 }],
    ['extra field', { ...base, secret: 'must-not-cross' }],
    [
      'formerly coercible fields',
      { ...base, msg: '512', wparam: null, lparam: [0] },
    ],
    ['unknown message', { ...base, msg: 0xffff_ffff }],
    ['dead-character message', { ...base, msg: WINDOWS_MESSAGE.deadChar }],
    [
      'system dead-character message',
      { ...base, msg: WINDOWS_MESSAGE.sysDeadChar },
    ],
    [
      'unsupported X-button message',
      { ...base, msg: WINDOWS_MESSAGE.xButtonDown },
    ],
  ];

  for (const field of ['type', 'windowId', 'msg', 'wparam', 'lparam']) {
    const missing = { ...base };
    delete missing[field];
    cases.push([`missing ${field}`, missing]);
  }

  const invalidNumbers = [null, '1', true, [], {}, -1, 1.5, 0x1_0000_0000];
  for (const field of ['windowId', 'msg', 'wparam', 'lparam']) {
    for (const invalid of invalidNumbers) {
      cases.push([
        `${field} rejects ${JSON.stringify(invalid)}`,
        { ...base, [field]: invalid },
      ]);
    }
  }
  cases.push(['zero windowId', { ...base, windowId: 0 }]);

  for (const invalid of [0, ...invalidNumbers]) {
    cases.push([
      `scaleFactorMicros rejects ${JSON.stringify(invalid)}`,
      { ...base, scaleFactorMicros: invalid },
    ]);
  }

  for (const [name, value] of cases) {
    await t.test(name, () => {
      assert.equal(parseNativeInputMessage(value, 4321), null);
    });
  }
  for (const invalidPid of [0, -1, 1.5, 0x1_0000_0000]) {
    await t.test(`authoritative PID rejects ${invalidPid}`, () => {
      assert.equal(parseNativeInputMessage(base, invalidPid), null);
    });
  }
});

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
