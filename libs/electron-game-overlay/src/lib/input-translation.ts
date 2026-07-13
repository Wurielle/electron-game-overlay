export interface NativeInputMessage {
  pid?: number;
  windowId: number;
  msg: number;
  wparam: number;
  lparam: number;
}

export interface TranslatedInputEvent {
  type: string;
  keyCode?: string;
  modifiers: string[];
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  canScroll?: boolean;
}

export const WINDOWS_MESSAGE = {
  keyDown: 0x0100,
  keyUp: 0x0101,
  char: 0x0102,
  deadChar: 0x0103,
  sysKeyDown: 0x0104,
  sysKeyUp: 0x0105,
  sysChar: 0x0106,
  sysDeadChar: 0x0107,
  uniChar: 0x0109,
  mouseMove: 0x0200,
  leftButtonDown: 0x0201,
  leftButtonUp: 0x0202,
  leftButtonDoubleClick: 0x0203,
  rightButtonDown: 0x0204,
  rightButtonUp: 0x0205,
  rightButtonDoubleClick: 0x0206,
  middleButtonDown: 0x0207,
  middleButtonUp: 0x0208,
  middleButtonDoubleClick: 0x0209,
  mouseWheel: 0x020a,
  xButtonDown: 0x020b,
  xButtonUp: 0x020c,
  xButtonDoubleClick: 0x020d,
  mouseHorizontalWheel: 0x020e,
} as const;

const VIRTUAL_KEY = {
  shift: 0x10,
  control: 0x11,
  alt: 0x12,
  capsLock: 0x14,
  enter: 0x0d,
  pageUp: 0x21,
  pageDown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  leftMeta: 0x5b,
  rightMeta: 0x5c,
  numpad0: 0x60,
  numpad9: 0x69,
  multiply: 0x6a,
  add: 0x6b,
  clear: 0x0c,
  subtract: 0x6d,
  decimal: 0x6e,
  divide: 0x6f,
  numLock: 0x90,
  leftShift: 0xa0,
  rightShift: 0xa1,
  leftControl: 0xa2,
  rightControl: 0xa3,
  leftAlt: 0xa4,
  rightAlt: 0xa5,
} as const;

const MOUSE_KEY_STATE = {
  leftButton: 0x0001,
  rightButton: 0x0002,
  shift: 0x0004,
  control: 0x0008,
  middleButton: 0x0010,
} as const;

const KEY_CODES = new Map<number, string>([
  [1, 'LButton'],
  [2, 'RButton'],
  [4, 'MButton'],
  [5, 'XButotn1'],
  [6, 'XButotn2'],
  [8, 'Backspace'],
  [9, 'Tab'],
  [13, 'Enter'],
  [16, 'Shift'],
  [17, 'Ctrl'],
  [18, 'Alt'],
  [19, 'Pause'],
  [20, 'CapsLock'],
  [27, 'Escape'],
  [32, ' '],
  [33, 'PageUp'],
  [34, 'PageDown'],
  [35, 'End'],
  [36, 'Home'],
  [37, 'Left'],
  [38, 'Up'],
  [39, 'Right'],
  [40, 'Down'],
  [45, 'Insert'],
  [46, 'Delete'],
  [48, '0'],
  [49, '1'],
  [50, '2'],
  [51, '3'],
  [52, '4'],
  [53, '5'],
  [54, '6'],
  [55, '7'],
  [56, '8'],
  [57, '9'],
  [65, 'A'],
  [66, 'B'],
  [67, 'C'],
  [68, 'D'],
  [69, 'E'],
  [70, 'F'],
  [71, 'G'],
  [72, 'H'],
  [73, 'I'],
  [74, 'J'],
  [75, 'K'],
  [76, 'L'],
  [77, 'M'],
  [78, 'N'],
  [79, 'O'],
  [80, 'P'],
  [81, 'Q'],
  [82, 'R'],
  [83, 'S'],
  [84, 'T'],
  [85, 'U'],
  [86, 'V'],
  [87, 'W'],
  [88, 'X'],
  [89, 'Y'],
  [90, 'Z'],
  [91, 'Meta'],
  [92, 'Meta'],
  [93, 'ContextMenu'],
  [96, '0'],
  [97, '1'],
  [98, '2'],
  [99, '3'],
  [100, '4'],
  [101, '5'],
  [102, '6'],
  [103, '7'],
  [104, '8'],
  [105, '9'],
  [106, '*'],
  [107, '+'],
  [109, '-'],
  [110, '.'],
  [111, '/'],
  [112, 'F1'],
  [113, 'F2'],
  [114, 'F3'],
  [115, 'F4'],
  [116, 'F5'],
  [117, 'F6'],
  [118, 'F7'],
  [119, 'F8'],
  [120, 'F9'],
  [121, 'F10'],
  [122, 'F11'],
  [123, 'F12'],
  [144, 'NumLock'],
  [145, 'ScrollLock'],
  [160, 'Shift'],
  [161, 'Shift'],
  [162, 'Control'],
  [163, 'Control'],
  [164, 'Alt'],
  [165, 'Alt'],
  [182, 'My Computer'],
  [183, 'My Calculator'],
  [186, ';'],
  [187, '='],
  [188, '},'],
  [189, '-'],
  [190, '.'],
  [191, '/'],
  [192, '`'],
  [219, '['],
  [220, '\\'],
  [221, ']'],
  [222, "'"],
  [250, 'Play'],
]);

function signedWord(value: number): number {
  const word = value & 0xffff;
  return word >= 0x8000 ? word - 0x10000 : word;
}

function highWord(value: number): number {
  return (value >>> 16) & 0xffff;
}

function isExtended(lparam: number): boolean {
  return ((lparam >>> 24) & 1) !== 0;
}

function isKeyboardMessage(msg: number): boolean {
  return (
    msg === WINDOWS_MESSAGE.keyDown ||
    msg === WINDOWS_MESSAGE.keyUp ||
    msg === WINDOWS_MESSAGE.sysKeyDown ||
    msg === WINDOWS_MESSAGE.sysKeyUp
  );
}

/**
 * Converts the Win32 messages emitted by the injected runtime into Electron's
 * sendInputEvent shape. Modifier state is reconstructed from the ordered input
 * stream because this pure TypeScript replacement cannot call GetAsyncKeyState.
 */
export class InputEventTranslator {
  private readonly pressedKeys = new Set<number>();
  private capsLock = false;
  private numLock = false;
  private pendingHighSurrogate: number | null = null;

  public reset(): void {
    this.pressedKeys.clear();
    this.capsLock = false;
    this.numLock = false;
    this.pendingHighSurrogate = null;
  }

  public translate(
    event: NativeInputMessage,
  ): TranslatedInputEvent | undefined {
    const msg = event.msg >>> 0;
    const wparam = event.wparam >>> 0;
    const lparam = event.lparam >>> 0;

    if (
      this.pendingHighSurrogate !== null &&
      msg !== WINDOWS_MESSAGE.char &&
      msg !== WINDOWS_MESSAGE.sysChar
    ) {
      this.pendingHighSurrogate = null;
    }

    if (isKeyboardMessage(msg)) {
      const down =
        msg === WINDOWS_MESSAGE.keyDown || msg === WINDOWS_MESSAGE.sysKeyDown;
      this.updateKeyboardState(wparam, lparam, down);
      return {
        type: down ? 'keyDown' : 'keyUp',
        keyCode: KEY_CODES.get(wparam) ?? '',
        modifiers: this.getKeyboardModifiers(wparam, lparam),
      };
    }

    if (msg === WINDOWS_MESSAGE.char || msg === WINDOWS_MESSAGE.sysChar) {
      const codeUnit = wparam & 0xffff;
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        this.pendingHighSurrogate = codeUnit;
        return undefined;
      }

      let keyCode: string;
      if (
        this.pendingHighSurrogate !== null &&
        codeUnit >= 0xdc00 &&
        codeUnit <= 0xdfff
      ) {
        keyCode = String.fromCharCode(this.pendingHighSurrogate, codeUnit);
      } else {
        keyCode = String.fromCharCode(codeUnit);
      }
      this.pendingHighSurrogate = null;
      return {
        type: 'char',
        keyCode,
        modifiers: this.getKeyboardModifiers(wparam, lparam),
      };
    }

    if (msg === WINDOWS_MESSAGE.uniChar) {
      if (
        wparam === 0xffff ||
        wparam > 0x10ffff ||
        (wparam >= 0xd800 && wparam <= 0xdfff)
      ) {
        return undefined;
      }
      return {
        type: 'char',
        keyCode: String.fromCodePoint(wparam),
        modifiers: this.getKeyboardModifiers(wparam, lparam),
      };
    }

    if (
      msg === WINDOWS_MESSAGE.deadChar ||
      msg === WINDOWS_MESSAGE.sysDeadChar
    ) {
      this.pendingHighSurrogate = null;
      return undefined;
    }

    if (
      msg < WINDOWS_MESSAGE.mouseMove ||
      msg > WINDOWS_MESSAGE.mouseHorizontalWheel ||
      msg === WINDOWS_MESSAGE.xButtonDown ||
      msg === WINDOWS_MESSAGE.xButtonUp ||
      msg === WINDOWS_MESSAGE.xButtonDoubleClick
    ) {
      return undefined;
    }

    const translated = this.translateMouseMessage(msg, wparam);
    if (!translated) {
      return undefined;
    }

    return {
      ...translated,
      x: signedWord(lparam),
      y: signedWord(highWord(lparam)),
      modifiers: this.getMouseModifiers(wparam),
    };
  }

  private translateMouseMessage(
    msg: number,
    wparam: number,
  ): Omit<TranslatedInputEvent, 'modifiers' | 'x' | 'y'> | undefined {
    switch (msg) {
      case WINDOWS_MESSAGE.leftButtonDown:
        return { type: 'mouseDown', button: 'left', clickCount: 1 };
      case WINDOWS_MESSAGE.leftButtonUp:
        return { type: 'mouseUp', button: 'left', clickCount: 1 };
      case WINDOWS_MESSAGE.leftButtonDoubleClick:
        return { type: 'mouseDown', button: 'left', clickCount: 2 };
      case WINDOWS_MESSAGE.rightButtonDown:
        return { type: 'mouseDown', button: 'right', clickCount: 1 };
      case WINDOWS_MESSAGE.rightButtonUp:
        return { type: 'mouseUp', button: 'right', clickCount: 1 };
      case WINDOWS_MESSAGE.rightButtonDoubleClick:
        return { type: 'mouseDown', button: 'right', clickCount: 2 };
      case WINDOWS_MESSAGE.middleButtonDown:
        return { type: 'mouseDown', button: 'middle', clickCount: 1 };
      case WINDOWS_MESSAGE.middleButtonUp:
        return { type: 'mouseUp', button: 'middle', clickCount: 1 };
      case WINDOWS_MESSAGE.middleButtonDoubleClick:
        return { type: 'mouseDown', button: 'middle', clickCount: 2 };
      case WINDOWS_MESSAGE.mouseMove:
        return { type: 'mouseMove' };
      case WINDOWS_MESSAGE.mouseWheel:
        return {
          type: 'mouseWheel',
          deltaY: signedWord(highWord(wparam)),
          canScroll: true,
        };
      case WINDOWS_MESSAGE.mouseHorizontalWheel:
        return {
          type: 'mouseWheel',
          deltaX: -signedWord(highWord(wparam)),
          canScroll: true,
        };
      default:
        return undefined;
    }
  }

  private updateKeyboardState(
    key: number,
    lparam: number,
    down: boolean,
  ): void {
    const resolvedKey = this.resolveModifierKey(key, lparam);
    if (down) {
      const wasPressed = this.pressedKeys.has(resolvedKey);
      this.pressedKeys.add(resolvedKey);
      if (!wasPressed && key === VIRTUAL_KEY.capsLock) {
        this.capsLock = !this.capsLock;
      } else if (!wasPressed && key === VIRTUAL_KEY.numLock) {
        this.numLock = !this.numLock;
      }
    } else {
      this.pressedKeys.delete(resolvedKey);
    }
  }

  private resolveModifierKey(key: number, lparam: number): number {
    if (key === VIRTUAL_KEY.shift) {
      const scanCode = (lparam >>> 16) & 0xff;
      return scanCode === 0x36 ? VIRTUAL_KEY.rightShift : VIRTUAL_KEY.leftShift;
    }
    if (key === VIRTUAL_KEY.control) {
      return isExtended(lparam)
        ? VIRTUAL_KEY.rightControl
        : VIRTUAL_KEY.leftControl;
    }
    if (key === VIRTUAL_KEY.alt) {
      return isExtended(lparam) ? VIRTUAL_KEY.rightAlt : VIRTUAL_KEY.leftAlt;
    }
    return key;
  }

  private hasAny(...keys: number[]): boolean {
    return keys.some((key) => this.pressedKeys.has(key));
  }

  private getKeyboardModifiers(key: number, lparam: number): string[] {
    const modifiers: string[] = [];
    if (this.hasAny(VIRTUAL_KEY.leftShift, VIRTUAL_KEY.rightShift)) {
      modifiers.push('shift');
    }
    if (this.hasAny(VIRTUAL_KEY.leftControl, VIRTUAL_KEY.rightControl)) {
      modifiers.push('control');
    }
    if (
      this.hasAny(VIRTUAL_KEY.leftAlt, VIRTUAL_KEY.rightAlt) ||
      ((lparam >>> 29) & 1) !== 0
    ) {
      modifiers.push('alt');
    }
    if (this.hasAny(VIRTUAL_KEY.leftMeta, VIRTUAL_KEY.rightMeta)) {
      modifiers.push('meta');
    }
    if (this.numLock) {
      modifiers.push('numLock');
    }
    if (this.capsLock) {
      modifiers.push('capsLock');
    }

    if (key === VIRTUAL_KEY.enter) {
      if (isExtended(lparam)) {
        modifiers.push('isKeypad');
      }
    } else if (
      key === VIRTUAL_KEY.insert ||
      key === VIRTUAL_KEY.delete ||
      key === VIRTUAL_KEY.home ||
      key === VIRTUAL_KEY.end ||
      key === VIRTUAL_KEY.pageUp ||
      key === VIRTUAL_KEY.pageDown ||
      key === VIRTUAL_KEY.up ||
      key === VIRTUAL_KEY.down ||
      key === VIRTUAL_KEY.left ||
      key === VIRTUAL_KEY.right
    ) {
      if (!isExtended(lparam)) {
        modifiers.push('isKeypad');
      }
    } else if (
      key === VIRTUAL_KEY.numLock ||
      (key >= VIRTUAL_KEY.numpad0 && key <= VIRTUAL_KEY.numpad9) ||
      key === VIRTUAL_KEY.divide ||
      key === VIRTUAL_KEY.multiply ||
      key === VIRTUAL_KEY.subtract ||
      key === VIRTUAL_KEY.add ||
      key === VIRTUAL_KEY.decimal ||
      key === VIRTUAL_KEY.clear
    ) {
      modifiers.push('isKeypad');
    } else if (key === VIRTUAL_KEY.shift) {
      modifiers.push(
        this.resolveModifierKey(key, lparam) === VIRTUAL_KEY.rightShift
          ? 'right'
          : 'left',
      );
    } else if (key === VIRTUAL_KEY.control) {
      modifiers.push(isExtended(lparam) ? 'right' : 'left');
    } else if (key === VIRTUAL_KEY.alt) {
      modifiers.push(isExtended(lparam) ? 'right' : 'left');
    } else if (key === VIRTUAL_KEY.leftMeta) {
      modifiers.push('left');
    } else if (key === VIRTUAL_KEY.rightMeta) {
      modifiers.push('right');
    }

    return modifiers;
  }

  private getMouseModifiers(wparam: number): string[] {
    const modifiers: string[] = [];
    const keyState = wparam & 0xffff;
    if ((keyState & MOUSE_KEY_STATE.control) !== 0) {
      modifiers.push('control');
      this.pushModifierSide(
        modifiers,
        VIRTUAL_KEY.leftControl,
        VIRTUAL_KEY.rightControl,
      );
    }
    if ((keyState & MOUSE_KEY_STATE.shift) !== 0) {
      modifiers.push('shift');
      this.pushModifierSide(
        modifiers,
        VIRTUAL_KEY.leftShift,
        VIRTUAL_KEY.rightShift,
      );
    }
    if (this.hasAny(VIRTUAL_KEY.leftAlt, VIRTUAL_KEY.rightAlt)) {
      modifiers.push('alt');
      this.pushModifierSide(
        modifiers,
        VIRTUAL_KEY.leftAlt,
        VIRTUAL_KEY.rightAlt,
      );
    }
    if ((keyState & MOUSE_KEY_STATE.leftButton) !== 0) {
      modifiers.push('leftButtonDown');
    }
    if ((keyState & MOUSE_KEY_STATE.rightButton) !== 0) {
      modifiers.push('rightButtonDown');
    }
    if ((keyState & MOUSE_KEY_STATE.middleButton) !== 0) {
      modifiers.push('middleButtonDown');
    }
    if (this.hasAny(VIRTUAL_KEY.leftMeta, VIRTUAL_KEY.rightMeta)) {
      modifiers.push('meta');
    }
    if (this.numLock) {
      modifiers.push('numLock');
    }
    if (this.capsLock) {
      modifiers.push('capsLock');
    }
    return modifiers;
  }

  private pushModifierSide(
    modifiers: string[],
    leftKey: number,
    rightKey: number,
  ): void {
    if (this.pressedKeys.has(leftKey)) {
      modifiers.push('left');
    } else if (this.pressedKeys.has(rightKey)) {
      modifiers.push('right');
    }
  }
}
