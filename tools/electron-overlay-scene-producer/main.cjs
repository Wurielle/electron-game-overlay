const fs = require('node:fs');
const path = require('node:path');

const { app, ipcMain, screen } = require('electron');

const GUN_FROG_BUTTON_PROOF = process.argv.includes(
  '--hudhook-gun-frog-buttons',
);
const WINDOW_NAME = 'ExampleMainOverlay';
const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 360;
const INITIAL_BOUNDS = GUN_FROG_BUTTON_PROOF
  ? {
      x: 64,
      y: 270,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    }
  : {
      x: 64,
      y: 72,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    };
const MOVED_BOUNDS = {
  x: 176,
  y: 128,
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
};
const FRAME_RATE = 30;
const FRONT_WINDOW_NAME = 'ExamplePopupOverlay';
const FRONT_WINDOW_WIDTH = 320;
const FRONT_WINDOW_HEIGHT = 220;
const FRONT_BOUNDS = GUN_FROG_BUTTON_PROOF
  ? {
      x: 800,
      y: 100,
      width: FRONT_WINDOW_WIDTH,
      height: FRONT_WINDOW_HEIGHT,
    }
  : {
      x: 200,
      y: 136,
      width: FRONT_WINDOW_WIDTH,
      height: FRONT_WINDOW_HEIGHT,
    };
const GUN_FROG_BUTTON_OVERLAYS = [
  {
    name: 'continue',
    label: 'CONTINUE',
    left: 36,
    top: 80,
    width: 335,
    height: 56,
    color: '#dc2626',
  },
  {
    name: 'new-game',
    label: 'NEW GAME',
    left: 36,
    top: 154,
    width: 335,
    height: 56,
    color: '#ea580c',
  },
  {
    name: 'settings',
    label: 'SETTINGS',
    left: 36,
    top: 227,
    width: 335,
    height: 56,
    color: '#ca8a04',
  },
  {
    name: 'quit',
    label: 'QUIT',
    left: 36,
    top: 301,
    width: 335,
    height: 56,
    color: '#9333ea',
  },
];
const INITIAL_LIFECYCLE_DELAY_MS = 2500;
const LIFECYCLE_STEP_DELAY_MS = 750;
const TARGET_CONNECTION_TIMEOUT_MS = 30000;
const READY_MARKER = 'HUDHOOK_CLIENT_WINDOW_READY';
const TARGET_CONNECTED_MARKER = 'HUDHOOK_CLIENT_WINDOW_TARGET_CONNECTED';
const MULTIWINDOW_READY_MARKER = 'HUDHOOK_CLIENT_MULTIWINDOW_READY';
const MULTIWINDOW_TARGET_CONNECTED_MARKER =
  'HUDHOOK_CLIENT_MULTIWINDOW_TARGET_CONNECTED';
const MULTIWINDOW_COMMAND_CHANNEL = 'hudhook-client-multiwindow-command';
const DEVICE_SCALE_ARGUMENT = '--hudhook-device-scale-factor=';
const SUPPORTED_DEVICE_SCALE_FACTORS = new Set([1, 1.25, 1.5, 2]);
const EXIT_AFTER_LIFECYCLE = process.argv.includes('--exit-after-lifecycle');
const AUTOMATED_INPUT_PROOF = process.argv.includes(
  '--hudhook-client-input-runner',
);
const MANUAL_INPUT_PROOF = process.argv.includes(
  '--hudhook-client-input-manual',
);
const AUTOMATED_MULTIWINDOW_PROOF = process.argv.includes(
  '--hudhook-client-multiwindow-runner',
);
const MANUAL_MULTIWINDOW_PROOF = process.argv.includes(
  '--hudhook-client-multiwindow-manual',
);
const MULTIWINDOW_PROOF =
  AUTOMATED_MULTIWINDOW_PROOF || MANUAL_MULTIWINDOW_PROOF;
if (GUN_FROG_BUTTON_PROOF && !MANUAL_MULTIWINDOW_PROOF) {
  throw new Error(
    '--hudhook-gun-frog-buttons requires --hudhook-client-multiwindow-manual',
  );
}
const INPUT_PROOF =
  AUTOMATED_INPUT_PROOF || MANUAL_INPUT_PROOF || MULTIWINDOW_PROOF;
const INPUT_CONTROL_ARGUMENT = '--input-control-file=';
const inputControlArgument = process.argv.find((argument) =>
  argument.startsWith(INPUT_CONTROL_ARGUMENT),
);
const INPUT_CONTROL_FILE = inputControlArgument
  ? path.resolve(inputControlArgument.slice(INPUT_CONTROL_ARGUMENT.length))
  : null;
const deviceScaleArguments = process.argv.filter((argument) =>
  argument.startsWith(DEVICE_SCALE_ARGUMENT),
);
if (deviceScaleArguments.length > 1) {
  throw new Error(`${DEVICE_SCALE_ARGUMENT}<scale> may only be supplied once`);
}
const deviceScaleValue = deviceScaleArguments[0]?.slice(
  DEVICE_SCALE_ARGUMENT.length,
);
const REQUESTED_DEVICE_SCALE_FACTOR = deviceScaleValue
  ? Number(deviceScaleValue)
  : 1;
if (
  (deviceScaleValue && !/^\d+(?:\.\d+)?$/.test(deviceScaleValue)) ||
  !SUPPORTED_DEVICE_SCALE_FACTORS.has(REQUESTED_DEVICE_SCALE_FACTOR)
) {
  throw new Error(
    `${DEVICE_SCALE_ARGUMENT}<scale> must be one of 1, 1.25, 1.5, or 2`,
  );
}
const EXPECTED_BACK_FRAME_WIDTH = Math.floor(
  WINDOW_WIDTH * REQUESTED_DEVICE_SCALE_FACTOR,
);
const EXPECTED_BACK_FRAME_HEIGHT = Math.floor(
  WINDOW_HEIGHT * REQUESTED_DEVICE_SCALE_FACTOR,
);
const EXPECTED_FRONT_FRAME_WIDTH = Math.floor(
  FRONT_WINDOW_WIDTH * REQUESTED_DEVICE_SCALE_FACTOR,
);
const EXPECTED_FRONT_FRAME_HEIGHT = Math.floor(
  FRONT_WINDOW_HEIGHT * REQUESTED_DEVICE_SCALE_FACTOR,
);
const OVERLAY_FILE = path.resolve(
  __dirname,
  '../../../apps/client/public/index/example-main-overlay.html',
);
const POPUP_OVERLAY_FILE = path.resolve(
  __dirname,
  '../../../apps/client/public/index/example-popup-overlay.html',
);

// Make Electron's screen metrics, renderer DPR, OSR bitmap, and the SDK's
// native-pixel metadata share the proof's explicitly requested scale.
app.setPath(
  'userData',
  path.join(app.getPath('temp'), `hudhook-client-window-${process.pid}`),
);
app.commandLine.appendSwitch(
  'force-device-scale-factor',
  String(REQUESTED_DEVICE_SCALE_FACTOR),
);
app.disableHardwareAcceleration();

let overlay = null;
let session = null;
let overlayWindow = null;
let frontOverlayWindow = null;
let disposeNativeEvent = null;
let cleanupStarted = false;
let pageLoaded = false;
let frontPageLoaded = false;
let readyLogged = false;
let targetConnected = false;
let lifecycleStarted = false;
let observedFrames = 0;
let observedFrontFrames = 0;
let observedBackFrameSize = null;
let observedFrontFrameSize = null;
let observedDisplayScaleFactor = null;
let backDevicePixelRatio = null;
let frontDevicePixelRatio = null;
let backMultiwindowTarget = null;
let frontMultiwindowTarget = null;
let multiwindowIpcBound = false;
let targetConnectionTimeout = null;
let inputInterceptRequested = false;
let inputInterceptEnabled = false;
let inputReleaseRequested = false;
let inputReleaseAcknowledged = false;
let manualInputReadyLogged = false;
let lastInputControlCommand = '';
const lifecycleTimers = new Set();

function log(message) {
  console.log(`[hudhook-client-window-demo] ${message}`);
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function schedule(callback, delayMs = LIFECYCLE_STEP_DELAY_MS) {
  const timer = setTimeout(() => {
    lifecycleTimers.delete(timer);

    if (!cleanupStarted) {
      callback();
    }
  }, delayMs);

  lifecycleTimers.add(timer);
  return timer;
}

function cleanup(reason) {
  if (cleanupStarted) {
    return;
  }

  targetConnectionTimeout = null;

  if (disposeNativeEvent) {
    disposeNativeEvent();
    disposeNativeEvent = null;
  }

  cleanupStarted = true;
  log(
    MULTIWINDOW_PROOF
      ? `stopping reason=${reason} backFrames=${observedFrames} frontFrames=${observedFrontFrames}`
      : `stopping reason=${reason} frames=${observedFrames}`,
  );

  for (const timer of lifecycleTimers) {
    clearTimeout(timer);
  }
  lifecycleTimers.clear();

  if (multiwindowIpcBound) {
    ipcMain.removeListener(
      MULTIWINDOW_COMMAND_CHANNEL,
      handleMultiwindowIpcCommand,
    );
    multiwindowIpcBound = false;
  }

  if (frontOverlayWindow) {
    try {
      frontOverlayWindow.destroy();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to destroy front overlay window: ${formatError(error)}`,
      );
    }
    frontOverlayWindow = null;
  }

  if (overlayWindow) {
    try {
      overlayWindow.destroy();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to destroy overlay window: ${formatError(error)}`,
      );
    }
    overlayWindow = null;
  }

  if (session) {
    try {
      session.close();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to close overlay session: ${formatError(error)}`,
      );
    }
    session = null;
  }

  if (overlay) {
    try {
      overlay.dispose();
    } catch (error) {
      console.error(
        `[hudhook-client-window-demo] failed to dispose overlay SDK: ${formatError(error)}`,
      );
    }
    overlay = null;
  }

  log('stopped');
}
function clearTargetConnectionTimeout() {
  if (!targetConnectionTimeout) {
    return;
  }

  clearTimeout(targetConnectionTimeout);
  lifecycleTimers.delete(targetConnectionTimeout);
  targetConnectionTimeout = null;
}

function armTargetConnectionTimeout() {
  if (targetConnected || targetConnectionTimeout) {
    return;
  }

  targetConnectionTimeout = schedule(() => {
    targetConnectionTimeout = null;
    fail(
      'target-connection-timeout',
      new Error(
        `no game.process event within ${TARGET_CONNECTION_TIMEOUT_MS} ms`,
      ),
    );
  }, TARGET_CONNECTION_TIMEOUT_MS);
}

function maybeStartLifecycleSequence() {
  if (!readyLogged || !targetConnected || lifecycleStarted) {
    return;
  }

  lifecycleStarted = true;
  clearTargetConnectionTimeout();
  if (MULTIWINDOW_PROOF) {
    startMultiwindowInputProofSequence().catch((error) => {
      fail('multiwindow-input-proof-start', error);
    });
  } else if (INPUT_PROOF) {
    startInputProofSequence().catch((error) => {
      fail('input-proof-start', error);
    });
  } else {
    startLifecycleSequence();
  }
}

function handleNativeEvent({ event, payload }) {
  if (event === 'game.process' && !targetConnected) {
    targetConnected = true;
    clearTargetConnectionTimeout();
    const targetPid = Number.isInteger(payload?.pid) ? payload.pid : 'unknown';
    console.log(
      `${
        MULTIWINDOW_PROOF
          ? MULTIWINDOW_TARGET_CONNECTED_MARKER
          : TARGET_CONNECTED_MARKER
      } pid=${targetPid}`,
    );
    maybeStartLifecycleSequence();
    return;
  }

  if (!INPUT_PROOF || event !== 'game.input.intercept') {
    return;
  }

  if (
    payload?.intercepting === true &&
    inputInterceptRequested &&
    !inputInterceptEnabled
  ) {
    inputInterceptEnabled = true;
    console.log(
      MULTIWINDOW_PROOF
        ? 'HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_ENABLED'
        : 'HUDHOOK_CLIENT_INPUT_INTERCEPT_ENABLED',
    );
    if (
      (MANUAL_INPUT_PROOF || MANUAL_MULTIWINDOW_PROOF) &&
      !manualInputReadyLogged
    ) {
      manualInputReadyLogged = true;
      console.log(
        MANUAL_MULTIWINDOW_PROOF
          ? 'HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_READY'
          : 'HUDHOOK_CLIENT_INPUT_MANUAL_READY',
      );
    } else if (MANUAL_INPUT_PROOF || MANUAL_MULTIWINDOW_PROOF) {
      console.log(
        MANUAL_MULTIWINDOW_PROOF
          ? 'HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_RESUMED'
          : 'HUDHOOK_CLIENT_INPUT_MANUAL_RESUMED',
      );
    }
    return;
  }

  if (
    payload?.intercepting === false &&
    (MANUAL_INPUT_PROOF || MANUAL_MULTIWINDOW_PROOF) &&
    inputInterceptRequested &&
    inputInterceptEnabled &&
    !inputReleaseRequested
  ) {
    inputInterceptEnabled = false;
    console.log(
      MANUAL_MULTIWINDOW_PROOF
        ? 'HUDHOOK_CLIENT_MULTIWINDOW_MANUAL_SUSPENDED'
        : 'HUDHOOK_CLIENT_INPUT_MANUAL_SUSPENDED',
    );
    return;
  }

  if (
    payload?.intercepting === false &&
    inputReleaseRequested &&
    !inputReleaseAcknowledged
  ) {
    inputInterceptEnabled = false;
    inputReleaseAcknowledged = true;
    if (MULTIWINDOW_PROOF) {
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_DISABLED');
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_LIFECYCLE_COMPLETE');
    } else {
      console.log('HUDHOOK_CLIENT_INPUT_INTERCEPT_DISABLED');
      console.log('HUDHOOK_CLIENT_INPUT_LIFECYCLE_COMPLETE');
    }
  }
}

function terminate(reason, exitCode) {
  cleanup(reason);
  app.exit(exitCode);
}

function fail(reason, error) {
  console.error(
    `[hudhook-client-window-demo] HUDHOOK_CLIENT_WINDOW_ERROR reason=${reason}\n${formatError(error)}`,
  );
  terminate(reason, 1);
}

function startLifecycleSequence() {
  schedule(() => {
    overlayWindow.setBounds(MOVED_BOUNDS);
    console.log(
      `HUDHOOK_CLIENT_WINDOW_MOVED x=${MOVED_BOUNDS.x} y=${MOVED_BOUNDS.y}`,
    );

    schedule(() => {
      // hide() keeps the BrowserWindow alive but sends the native SDK's
      // window.close message, allowing the same window to be registered again.
      overlayWindow.hide();
      console.log('HUDHOOK_CLIENT_WINDOW_HIDDEN event=window.close');

      schedule(() => {
        overlayWindow.show();
        overlayWindow.browserWindow.webContents.invalidate();
        console.log('HUDHOOK_CLIENT_WINDOW_RESHOWN');
        console.log('HUDHOOK_CLIENT_WINDOW_LIFECYCLE_COMPLETE');

        if (EXIT_AFTER_LIFECYCLE) {
          schedule(() => terminate('lifecycle-complete', 0));
        }
      });
    });
  }, INITIAL_LIFECYCLE_DELAY_MS);
}

function formatRectValue(value) {
  return Number(value.toFixed(2));
}

function validateNativeInputTranslation(overlayInstance) {
  const nativeOverlay = overlayInstance?.nativeOverlay;
  if (
    !nativeOverlay ||
    typeof nativeOverlay.translateInputEvent !== 'function'
  ) {
    throw new Error('native input translator is unavailable');
  }

  const translate = (msg, wparam = 0, lparam = 0) =>
    nativeOverlay.translateInputEvent({
      windowId: 1,
      msg,
      wparam,
      lparam,
    });

  const signedPoint = ((-10 & 0xffff) | ((-20 & 0xffff) << 16)) >>> 0;
  const move = translate(0x0200, 0, signedPoint);
  const wheel = translate(0x020a, (120 << 16) >>> 0);
  const horizontalWheel = translate(0x020e, (120 << 16) >>> 0);
  const sysChar = translate(0x0106, 'A'.codePointAt(0), 1 << 29);
  const pendingSurrogate = translate(0x0102, 0xd83d);
  const surrogatePair = translate(0x0102, 0xde42);
  const unicodeChar = translate(0x0109, 0x1f642);
  const rejectedTranslations = [
    ['xButtonDown', translate(0x020b, 1 << 16)],
    ['xButtonUp', translate(0x020c, 1 << 16)],
    ['xButtonDoubleClick', translate(0x020d, 1 << 16)],
    ['deadChar', translate(0x0103, 0x005e)],
    ['sysDeadChar', translate(0x0107, 0x005e)],
    ['reservedKeyboardMessage', translate(0x0108)],
    ['unicodeNoChar', translate(0x0109, 0xffff)],
    ['unicodeSurrogate', translate(0x0109, 0xd800)],
    ['unicodeOutOfRange', translate(0x0109, 0x110000)],
    ['unhandled', translate(0x0000)],
  ].filter(([, value]) => value !== undefined);

  if (
    move?.x !== -10 ||
    move?.y !== -20 ||
    wheel?.canScroll !== true ||
    Object.prototype.hasOwnProperty.call(wheel, 'canScroll ') ||
    horizontalWheel?.type !== 'mouseWheel' ||
    horizontalWheel?.deltaX !== -120 ||
    horizontalWheel?.canScroll !== true ||
    sysChar?.type !== 'char' ||
    sysChar?.keyCode !== 'A' ||
    !sysChar?.modifiers?.includes('alt') ||
    pendingSurrogate !== undefined ||
    surrogatePair?.type !== 'char' ||
    surrogatePair?.keyCode !== String.fromCodePoint(0x1f642) ||
    unicodeChar?.type !== 'char' ||
    unicodeChar?.keyCode !== String.fromCodePoint(0x1f642) ||
    rejectedTranslations.length !== 0
  ) {
    throw new Error(
      `native input translation contract failed: ${JSON.stringify({
        move,
        wheel,
        horizontalWheel,
        sysChar,
        pendingSurrogate,
        surrogatePair,
        unicodeChar,
        rejectedTranslations,
      })}`,
    );
  }

  console.log('HUDHOOK_CLIENT_INPUT_TRANSLATION_READY');
}

async function instrumentMultiwindowPage(
  window,
  { role, selector, left, top, color, caption, commands, gunFrogButtons },
) {
  const config = JSON.stringify({
    role,
    selector,
    left,
    top,
    color,
    caption,
    queueBarriers: AUTOMATED_MULTIWINDOW_PROOF,
    commands: MANUAL_MULTIWINDOW_PROOF ? commands : [],
    gunFrogButtons: gunFrogButtons || [],
    commandChannel: MULTIWINDOW_COMMAND_CHANNEL,
  });
  const result = await window.browserWindow.webContents.executeJavaScript(
    `(() => {
      const config = ${config};
      const existing = window.__hudhookMultiwindowProof;
      if (existing && typeof existing.getProofRects === 'function') {
        return existing.getProofRects();
      }

      const target = document.querySelector(config.selector);
      if (!target) {
        return { error: 'target-not-found', selector: config.selector };
      }

      const marker = (event, details = '') => {
        console.log(
          'HUDHOOK_CLIENT_MULTIWINDOW_INPUT role=' + config.role +
          ' event=' + event + (details ? ' ' + details : '')
        );
      };

      document.documentElement.style.outline = '3px solid ' + config.color;
      document.documentElement.style.outlineOffset = '-3px';
      document.body.style.backgroundColor =
        config.role === 'front'
          ? 'rgba(37, 99, 235, 0.32)'
          : 'rgba(5, 150, 105, 0.30)';

      Object.assign(target.style, {
        position: 'fixed',
        left: config.left + 'px',
        top: config.top + 'px',
        width: '220px',
        height: '28px',
        boxSizing: 'border-box',
        padding: '3px 7px',
        border: '3px solid ' + config.color,
        borderRadius: '4px',
        background: '#ffffff',
        color: '#111827',
        zIndex: '2147483646'
      });
      target.value = '';
      target.placeholder = config.role.toUpperCase() + ' input target';
      target.autocomplete = 'off';

      target.addEventListener('focus', () => marker('focus'));
      target.addEventListener('mousedown', event => {
        marker('down', 'x=' + event.clientX + ' y=' + event.clientY);
      });
      target.addEventListener('mouseup', event => {
        marker('up', 'x=' + event.clientX + ' y=' + event.clientY);
      });
      target.addEventListener('click', () => marker('click'));
      target.addEventListener('input', () => {
        marker('value', 'value=' + target.value);
      });
      target.addEventListener('keydown', event => {
        marker('key', 'key=' + JSON.stringify(event.key));
      });
      window.addEventListener('mousemove', event => {
        if (event.buttons !== 0) {
          marker(
            'drag',
            'x=' + event.clientX + ' y=' + event.clientY +
              ' buttons=' + event.buttons
          );
        }
      }, true);
      window.addEventListener('mouseup', event => {
        if (event.target !== target) {
          marker('capture-up', 'x=' + event.clientX + ' y=' + event.clientY);
        }
      }, true);

      const gunFrogButtonElements = [];
      for (const proofButton of config.gunFrogButtons) {
        const button = document.createElement('button');
        button.id = 'hudhook-gun-frog-' + proofButton.name;
        button.type = 'button';
        button.textContent = 'ELECTRON: ' + proofButton.label;
        Object.assign(button.style, {
          position: 'fixed',
          left: proofButton.left + 'px',
          top: proofButton.top + 'px',
          width: proofButton.width + 'px',
          height: proofButton.height + 'px',
          boxSizing: 'border-box',
          border: '4px solid #ffffff',
          borderRadius: '8px',
          background: proofButton.color,
          boxShadow: '0 0 0 3px #111827, 0 4px 14px #000000',
          color: '#ffffff',
          cursor: 'pointer',
          font: '900 20px sans-serif',
          letterSpacing: '1px',
          opacity: '0.96',
          textShadow: '0 2px 2px #000000',
          zIndex: '2147483647'
        });
        button.addEventListener('mousedown', event => {
          marker(
            'gun-frog-down',
            'name=' + proofButton.name +
              ' x=' + event.clientX + ' y=' + event.clientY
          );
        });
        button.addEventListener('mouseup', event => {
          marker(
            'gun-frog-up',
            'name=' + proofButton.name +
              ' x=' + event.clientX + ' y=' + event.clientY
          );
        });
        button.addEventListener('click', () => {
          marker('gun-frog-click', 'name=' + proofButton.name);
        });
        document.body.appendChild(button);
        gunFrogButtonElements.push({
          name: proofButton.name,
          element: button
        });
      }

      const captionWidth =
        window.innerWidth - config.caption.left - config.caption.right;
      const dragHandleWidth = Math.min(180, captionWidth - 16);
      const dragHandleHeight = Math.min(20, config.caption.height - 10);
      if (dragHandleWidth <= 0 || dragHandleHeight <= 0) {
        return { error: 'invalid-caption', caption: config.caption };
      }

      const dragHandle = document.createElement('div');
      dragHandle.id = 'hudhook-client-multiwindow-drag-' + config.role;
      dragHandle.textContent = ':: DRAG ' + config.role.toUpperCase() + ' ::';
      dragHandle.title =
        'Drag this caption handle to move the ' + config.role.toUpperCase() +
        ' composited overlay window';
      Object.assign(dragHandle.style, {
        position: 'fixed',
        left:
          config.caption.left + (captionWidth - dragHandleWidth) / 2 + 'px',
        top:
          config.caption.top + config.caption.height - dragHandleHeight + 'px',
        width: dragHandleWidth + 'px',
        height: dragHandleHeight + 'px',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid #ffffff',
        borderRadius: '5px',
        background:
          'repeating-linear-gradient(135deg, ' + config.color +
          ' 0 8px, rgba(17, 24, 39, 0.96) 8px 16px)',
        boxShadow: '0 0 0 2px ' + config.color + ', 0 2px 8px #000000',
        color: '#ffffff',
        cursor: 'move',
        font: '900 11px sans-serif',
        letterSpacing: '1px',
        lineHeight: dragHandleHeight + 'px',
        userSelect: 'none',
        zIndex: '2147483645'
      });
      let captionDomDragging = false;
      const captionDomMarker = (event, pointer) => {
        console.log(
          'HUDHOOK_CLIENT_MULTIWINDOW_CAPTION_DOM role=' + config.role +
          ' event=' + event +
          ' x=' + pointer.clientX + ' y=' + pointer.clientY
        );
      };
      dragHandle.addEventListener('mousedown', event => {
        if (event.button !== 0) {
          return;
        }
        captionDomDragging = true;
        captionDomMarker('start', event);
      });
      window.addEventListener('mousemove', event => {
        if (captionDomDragging) {
          captionDomMarker('move', event);
        }
      }, true);
      window.addEventListener('mouseup', event => {
        if (!captionDomDragging || event.button !== 0) {
          return;
        }
        captionDomMarker('end', event);
        captionDomDragging = false;
      }, true);
      window.addEventListener('mousemove', event => {
        if (config.queueBarriers && event.buttons === 0) {
          // This listener is registered after the caption-leak listener so
          // its marker is last for the hover event. Seeing it proves every
          // older outbound input packet has been attempted by the bridge.
          marker(
            'queue-barrier',
            'x=' + event.clientX + ' y=' + event.clientY
          );
        }
      }, true);
      document.body.appendChild(dragHandle);

      const panel = document.createElement('div');
      panel.id = 'hudhook-client-multiwindow-panel-' + config.role;
      Object.assign(panel.style, {
        position: 'fixed',
        left: '8px',
        bottom: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '7px 9px',
        border: '2px solid ' + config.color,
        borderRadius: '6px',
        background: 'rgba(17, 24, 39, 0.92)',
        color: '#ffffff',
        font: 'bold 12px sans-serif',
        zIndex: '2147483647'
      });
      if (config.gunFrogButtons.length > 0) {
        Object.assign(panel.style, {
          left: '400px',
          right: '8px',
          top: '60px',
          bottom: 'auto',
          flexDirection: 'column',
          alignItems: 'stretch'
        });
      }

      const label = document.createElement('span');
      label.textContent = config.role.toUpperCase();
      panel.appendChild(label);

      if (config.commands.length > 0) {
        const { ipcRenderer } = window.require('electron');
        for (const command of config.commands) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = command.label;
          button.addEventListener('click', () => {
            ipcRenderer.send(config.commandChannel, command.command);
          });
          panel.appendChild(button);
        }
      }
      document.body.appendChild(panel);

      const getTargetRect = () => {
        const rect = target.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      };
      const getDragHandleRect = () => {
        const rect = dragHandle.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      };
      const getGunFrogButtonRects = () =>
        gunFrogButtonElements.map(({ name, element }) => {
          const rect = element.getBoundingClientRect();
          return {
            name,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          };
        });
      const getProofRects = () => ({
        ...getTargetRect(),
        dragHandle: getDragHandleRect(),
        gunFrogButtons: getGunFrogButtonRects(),
        devicePixelRatio: window.devicePixelRatio
      });
      window.__hudhookMultiwindowProof = {
        getTargetRect,
        getDragHandleRect,
        getGunFrogButtonRects,
        getProofRects
      };
      return getProofRects();
    })()`,
    true,
  );

  if (
    !result ||
    result.error ||
    !Number.isFinite(result.x) ||
    !Number.isFinite(result.y) ||
    !Number.isFinite(result.width) ||
    !Number.isFinite(result.height) ||
    result.width <= 0 ||
    result.height <= 0 ||
    !result.dragHandle ||
    !Number.isFinite(result.dragHandle.x) ||
    !Number.isFinite(result.dragHandle.y) ||
    !Number.isFinite(result.dragHandle.width) ||
    !Number.isFinite(result.dragHandle.height) ||
    result.dragHandle.width <= 0 ||
    result.dragHandle.height <= 0 ||
    !Number.isFinite(result.devicePixelRatio)
  ) {
    throw new Error(
      `invalid ${role} multi-window target rect: ${JSON.stringify(result)}`,
    );
  }
  const targetRight = result.x + result.width;
  const targetBottom = result.y + result.height;
  const dragHandleRight = result.dragHandle.x + result.dragHandle.width;
  const dragHandleBottom = result.dragHandle.y + result.dragHandle.height;
  if (
    result.x < dragHandleRight &&
    targetRight > result.dragHandle.x &&
    result.y < dragHandleBottom &&
    targetBottom > result.dragHandle.y
  ) {
    throw new Error(
      `${role} multi-window target overlaps its caption: ` +
        `${JSON.stringify({ target: result, dragHandle: result.dragHandle })}`,
    );
  }
  if (
    Math.abs(result.devicePixelRatio - REQUESTED_DEVICE_SCALE_FACTOR) > 0.001
  ) {
    throw new Error(
      `${role} renderer devicePixelRatio ${result.devicePixelRatio} does not ` +
        `match requested scale ${REQUESTED_DEVICE_SCALE_FACTOR}`,
    );
  }

  return result;
}

function multiwindowTargetDetails(role, window, target) {
  const bounds = window.browserWindow.getBounds();
  const centerX = bounds.x + target.x + target.width / 2;
  const centerY = bounds.y + target.y + target.height / 2;
  return {
    role,
    windowId: window.browserWindow.id,
    target,
    bounds,
    centerX,
    centerY,
  };
}

function logMultiwindowTarget(details) {
  console.log(
    'HUDHOOK_CLIENT_MULTIWINDOW_TARGET ' +
      `role=${details.role} windowId=${details.windowId} ` +
      `x=${formatRectValue(details.target.x)} ` +
      `y=${formatRectValue(details.target.y)} ` +
      `width=${formatRectValue(details.target.width)} ` +
      `height=${formatRectValue(details.target.height)} ` +
      `windowX=${details.bounds.x} windowY=${details.bounds.y} ` +
      `centerX=${formatRectValue(details.centerX)} ` +
      `centerY=${formatRectValue(details.centerY)}`,
  );
}

function logMultiwindowDragHandle(details) {
  const dragHandle = details.target.dragHandle;
  const centerX = details.bounds.x + dragHandle.x + dragHandle.width / 2;
  const centerY = details.bounds.y + dragHandle.y + dragHandle.height / 2;
  console.log(
    'HUDHOOK_CLIENT_MULTIWINDOW_DRAG_HANDLE ' +
      `role=${details.role} windowId=${details.windowId} ` +
      `x=${formatRectValue(dragHandle.x)} ` +
      `y=${formatRectValue(dragHandle.y)} ` +
      `width=${formatRectValue(dragHandle.width)} ` +
      `height=${formatRectValue(dragHandle.height)} ` +
      `windowX=${details.bounds.x} windowY=${details.bounds.y} ` +
      `centerX=${formatRectValue(centerX)} ` +
      `centerY=${formatRectValue(centerY)}`,
  );
}

function logMultiwindowProducerBounds(stage) {
  for (const [role, window] of [
    ['back', overlayWindow],
    ['front', frontOverlayWindow],
  ]) {
    const bounds = window.browserWindow.getBounds();
    console.log(
      'HUDHOOK_CLIENT_MULTIWINDOW_PRODUCER_BOUNDS ' +
        `stage=${stage} role=${role} ` +
        `windowId=${window.browserWindow.id} ` +
        `x=${bounds.x} y=${bounds.y} ` +
        `width=${bounds.width} height=${bounds.height}`,
    );
  }
}

function applyMultiwindowCommand(command, source) {
  if (!MULTIWINDOW_PROOF || cleanupStarted) {
    return;
  }

  console.log(
    `HUDHOOK_CLIENT_MULTIWINDOW_COMMAND command=${command} source=${source}`,
  );
  switch (command) {
    case 'hide-front':
      frontOverlayWindow.hide();
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_FRONT_HIDDEN');
      return;
    case 'show-front':
      frontOverlayWindow.show();
      frontOverlayWindow.browserWindow.webContents.invalidate();
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_FRONT_SHOWN');
      return;
    case 'raise-front':
      frontOverlayWindow.hide();
      frontOverlayWindow.show();
      frontOverlayWindow.browserWindow.webContents.invalidate();
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_FRONT_RAISED');
      return;
    case 'raise-back':
      overlayWindow.hide();
      overlayWindow.show();
      overlayWindow.browserWindow.webContents.invalidate();
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_BACK_RAISED');
      return;
    case 'report-bounds':
      logMultiwindowProducerBounds('reported');
      return;
    case 'release':
      inputReleaseRequested = true;
      session.input.release();
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_RELEASE_REQUESTED');
      return;
    default:
      throw new Error(`unsupported multi-window command: ${command}`);
  }
}

function handleMultiwindowIpcCommand(event, command) {
  if (!MANUAL_MULTIWINDOW_PROOF || typeof command !== 'string') {
    return;
  }
  const senderId = event.sender.id;
  const controlledSenderIds = [
    overlayWindow?.browserWindow.webContents.id,
    frontOverlayWindow?.browserWindow.webContents.id,
  ];
  if (!controlledSenderIds.includes(senderId)) {
    return;
  }

  try {
    applyMultiwindowCommand(command, 'manual');
  } catch (error) {
    fail('manual-multiwindow-command', error);
  }
}

async function startMultiwindowInputProofSequence() {
  if (AUTOMATED_MULTIWINDOW_PROOF && !INPUT_CONTROL_FILE) {
    throw new Error(
      `${INPUT_CONTROL_ARGUMENT}<path> is required for the multi-window proof`,
    );
  }
  if (!backMultiwindowTarget || !frontMultiwindowTarget) {
    throw new Error('multi-window input targets are unavailable');
  }

  const back = multiwindowTargetDetails(
    'back',
    overlayWindow,
    backMultiwindowTarget,
  );
  const front = multiwindowTargetDetails(
    'front',
    frontOverlayWindow,
    frontMultiwindowTarget,
  );
  if (
    !GUN_FROG_BUTTON_PROOF &&
    (Math.abs(back.centerX - front.centerX) > 0.5 ||
      Math.abs(back.centerY - front.centerY) > 0.5)
  ) {
    throw new Error(
      `multi-window targets are not aligned: ${JSON.stringify({ back, front })}`,
    );
  }

  logMultiwindowTarget(back);
  logMultiwindowTarget(front);
  logMultiwindowDragHandle(back);
  logMultiwindowDragHandle(front);
  logMultiwindowProducerBounds('initial');
  if (GUN_FROG_BUTTON_PROOF) {
    const buttons = backMultiwindowTarget.gunFrogButtons;
    if (!Array.isArray(buttons) || buttons.length !== 4) {
      throw new Error(
        `Gun Frog button overlays are unavailable: ${JSON.stringify(buttons)}`,
      );
    }
    for (const button of buttons) {
      console.log(
        'HUDHOOK_GUN_FROG_BUTTON ' +
          `name=${button.name} ` +
          `x=${formatRectValue(INITIAL_BOUNDS.x + button.x)} ` +
          `y=${formatRectValue(INITIAL_BOUNDS.y + button.y)} ` +
          `width=${formatRectValue(button.width)} ` +
          `height=${formatRectValue(button.height)}`,
      );
    }
    console.log('HUDHOOK_GUN_FROG_BUTTONS_READY');
  } else {
    console.log(
      'HUDHOOK_CLIENT_MULTIWINDOW_OVERLAP ' +
        `x=${formatRectValue(front.centerX)} ` +
        `y=${formatRectValue(front.centerY)}`,
    );
  }

  inputInterceptRequested = true;
  session.input.intercept();
  console.log('HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_REQUESTED');
  if (AUTOMATED_MULTIWINDOW_PROOF) {
    pollInputControlFile();
  }
}

function pollInputControlFile() {
  if (cleanupStarted || inputReleaseRequested) {
    return;
  }

  let command = '';
  try {
    if (fs.existsSync(INPUT_CONTROL_FILE)) {
      command = fs.readFileSync(INPUT_CONTROL_FILE, 'utf8').trim();
    }
  } catch (error) {
    log(`input control file temporarily unavailable: ${formatError(error)}`);
  }

  if (command && command !== lastInputControlCommand) {
    lastInputControlCommand = command;
    if (AUTOMATED_MULTIWINDOW_PROOF) {
      applyMultiwindowCommand(command, 'control-file');
      if (command === 'release') {
        return;
      }
    } else if (command === 'release') {
      inputReleaseRequested = true;
      session.input.release();
      console.log('HUDHOOK_CLIENT_INPUT_RELEASE_REQUESTED');
      return;
    }
  }

  schedule(pollInputControlFile, 50);
}

async function startInputProofSequence() {
  if (AUTOMATED_INPUT_PROOF && !INPUT_CONTROL_FILE) {
    throw new Error(
      `${INPUT_CONTROL_ARGUMENT}<path> is required for the input proof`,
    );
  }

  const browserWindow = overlayWindow.browserWindow;
  const targetRect = await browserWindow.webContents.executeJavaScript(
    `(() => {
      const proof = window.hudhookInputProof;
      if (!proof || typeof proof.getTargetRect !== 'function') {
        return null;
      }
      if (typeof proof.enable !== 'function') {
        return null;
      }
      proof.enable();
      return proof.getTargetRect();
    })()`,
    true,
  );

  if (
    !targetRect ||
    !Number.isFinite(targetRect.x) ||
    !Number.isFinite(targetRect.y) ||
    !Number.isFinite(targetRect.width) ||
    !Number.isFinite(targetRect.height) ||
    targetRect.width <= 0 ||
    targetRect.height <= 0
  ) {
    throw new Error(`invalid input target rect: ${JSON.stringify(targetRect)}`);
  }

  const windowBounds = browserWindow.getBounds();
  console.log(
    'HUDHOOK_CLIENT_INPUT_TARGET ' +
      `x=${formatRectValue(targetRect.x)} ` +
      `y=${formatRectValue(targetRect.y)} ` +
      `width=${formatRectValue(targetRect.width)} ` +
      `height=${formatRectValue(targetRect.height)} ` +
      `windowX=${windowBounds.x} windowY=${windowBounds.y}`,
  );

  inputInterceptRequested = true;
  session.input.intercept();
  console.log('HUDHOOK_CLIENT_INPUT_INTERCEPT_REQUESTED');
  if (AUTOMATED_INPUT_PROOF) {
    pollInputControlFile();
  }
}

function maybeLogMultiwindowReady() {
  if (
    readyLogged ||
    !pageLoaded ||
    !frontPageLoaded ||
    !backMultiwindowTarget ||
    !frontMultiwindowTarget ||
    observedFrames === 0 ||
    observedFrontFrames === 0 ||
    !observedBackFrameSize ||
    !observedFrontFrameSize ||
    observedDisplayScaleFactor === null ||
    backDevicePixelRatio === null ||
    frontDevicePixelRatio === null
  ) {
    return;
  }

  readyLogged = true;
  console.log(
    'HUDHOOK_CLIENT_MULTIWINDOW_DEVICE_SCALE ' +
      `requestedScale=${REQUESTED_DEVICE_SCALE_FACTOR} ` +
      `displayScale=${observedDisplayScaleFactor} ` +
      `backDpr=${backDevicePixelRatio} frontDpr=${frontDevicePixelRatio} ` +
      `backFrame=${observedBackFrameSize.width}x${observedBackFrameSize.height} ` +
      `frontFrame=${observedFrontFrameSize.width}x${observedFrontFrameSize.height}`,
  );
  console.log(MULTIWINDOW_READY_MARKER);
  log(
    `frame-ready role=back name=${WINDOW_NAME} ` +
      `windowId=${overlayWindow.browserWindow.id} ` +
      `position=${INITIAL_BOUNDS.x},${INITIAL_BOUNDS.y} ` +
      `size=${WINDOW_WIDTH}x${WINDOW_HEIGHT}`,
  );
  log(
    `frame-ready role=front name=${FRONT_WINDOW_NAME} ` +
      `windowId=${frontOverlayWindow.browserWindow.id} ` +
      `position=${FRONT_BOUNDS.x},${FRONT_BOUNDS.y} ` +
      `size=${FRONT_WINDOW_WIDTH}x${FRONT_WINDOW_HEIGHT}`,
  );
  armTargetConnectionTimeout();
  maybeStartLifecycleSequence();
}

function forwardProofConsoleMessage(message) {
  if (
    typeof message === 'string' &&
    ((INPUT_PROOF && message.startsWith('HUDHOOK_CLIENT_INPUT_')) ||
      (MULTIWINDOW_PROOF && message.startsWith('HUDHOOK_CLIENT_MULTIWINDOW_')))
  ) {
    console.log(message);
  }
}

function bindRendererFailureHandlers(browserWindow, role) {
  browserWindow.webContents.on('did-fail-load', (event, code, description) => {
    fail(
      `${role}-page-load`,
      new Error(`load failed (${code}): ${description}`),
    );
  });

  browserWindow.webContents.on('render-process-gone', (event, details) => {
    fail(
      `${role}-renderer-gone`,
      new Error(`renderer exited: ${JSON.stringify(details)}`),
    );
  });
}

async function createDemo() {
  const { ElectronGameOverlay } = require('electron-game-overlay');

  observedDisplayScaleFactor = screen.getDisplayNearestPoint({
    x: 0,
    y: 0,
  }).scaleFactor;
  if (
    Math.abs(observedDisplayScaleFactor - REQUESTED_DEVICE_SCALE_FACTOR) > 0.001
  ) {
    throw new Error(
      `screen scale ${observedDisplayScaleFactor} does not match requested ` +
        `scale ${REQUESTED_DEVICE_SCALE_FACTOR}`,
    );
  }

  overlay = new ElectronGameOverlay();
  if (INPUT_PROOF) {
    validateNativeInputTranslation(overlay);
    if (MULTIWINDOW_PROOF) {
      console.log('HUDHOOK_CLIENT_MULTIWINDOW_TRANSLATION_READY');
    }
  }
  session = overlay.createSession();
  disposeNativeEvent = session.on('nativeEvent', handleNativeEvent);
  session.start();

  overlayWindow = session.windows.create({
    id: WINDOW_NAME,
    name: WINDOW_NAME,
    bounds: INITIAL_BOUNDS,
    dragBorder: 10,
    captionHeight: 40,
    transparent: true,
    browserWindow: {
      title: WINDOW_NAME,
      frame: false,
      show: false,
      transparent: true,
      resizable: false,
      useContentSize: true,
      backgroundColor: '#00000000',
      webPreferences: {
        offscreen: true,
        paintWhenInitiallyHidden: true,
        backgroundThrottling: false,
        // The existing page calls window.require('electron'), matching the
        // real client's BrowserWindow configuration.
        nodeIntegration: true,
        contextIsolation: false,
      },
    },
    file: OVERLAY_FILE,
  });

  const browserWindow = overlayWindow.browserWindow;
  browserWindow.webContents.setFrameRate(FRAME_RATE);

  browserWindow.webContents.on('console-message', (event, level, message) => {
    forwardProofConsoleMessage(message);
  });

  browserWindow.webContents.on('did-finish-load', () => {
    pageLoaded = true;
    if (!MULTIWINDOW_PROOF) {
      browserWindow.webContents.invalidate();
      return;
    }

    instrumentMultiwindowPage(overlayWindow, {
      role: 'back',
      selector: '#hudhook-client-input-target',
      left: 176,
      top: 148,
      color: '#10b981',
      caption: GUN_FROG_BUTTON_PROOF
        ? { left: 440, right: 10, top: 250, height: 40 }
        : { left: 10, right: 10, top: 10, height: 40 },
      commands: [
        { label: 'Raise FRONT', command: 'raise-front' },
        { label: 'Show FRONT', command: 'show-front' },
        { label: 'Release input', command: 'release' },
      ],
      gunFrogButtons: GUN_FROG_BUTTON_PROOF ? GUN_FROG_BUTTON_OVERLAYS : [],
    })
      .then((target) => {
        backDevicePixelRatio = target.devicePixelRatio;
        backMultiwindowTarget = target;
        browserWindow.webContents.invalidate();
        maybeLogMultiwindowReady();
      })
      .catch((error) => fail('back-multiwindow-instrumentation', error));
  });

  if (MULTIWINDOW_PROOF) {
    bindRendererFailureHandlers(browserWindow, 'back');
  } else {
    browserWindow.webContents.on(
      'did-fail-load',
      (event, code, description) => {
        fail('page-load', new Error(`load failed (${code}): ${description}`));
      },
    );

    browserWindow.webContents.on('render-process-gone', (event, details) => {
      fail(
        'renderer-gone',
        new Error(`renderer exited: ${JSON.stringify(details)}`),
      );
    });
  }

  // The SDK's own paint listener runs first and synchronously publishes this
  // same NativeImage through the overlay transport before this observer validates
  // the complete physical bitmap.
  browserWindow.webContents.on('paint', (event, dirtyRect, image) => {
    const size = image.getSize();
    const byteLength = image.getBitmap().length;
    const expectedByteLength =
      EXPECTED_BACK_FRAME_WIDTH * EXPECTED_BACK_FRAME_HEIGHT * 4;

    if (size.width === 0 && size.height === 0 && byteLength === 0) {
      return;
    }

    if (
      size.width !== EXPECTED_BACK_FRAME_WIDTH ||
      size.height !== EXPECTED_BACK_FRAME_HEIGHT ||
      byteLength !== expectedByteLength
    ) {
      fail(
        'unexpected-frame',
        new Error(
          `expected ${EXPECTED_BACK_FRAME_WIDTH}x${EXPECTED_BACK_FRAME_HEIGHT}/` +
            `${expectedByteLength} bytes, ` +
            `received ${size.width}x${size.height}/${byteLength} bytes`,
        ),
      );
      return;
    }

    observedFrames += 1;
    observedBackFrameSize = size;

    if (MULTIWINDOW_PROOF) {
      maybeLogMultiwindowReady();
      return;
    }

    if (!pageLoaded || readyLogged) {
      return;
    }

    readyLogged = true;
    console.log(READY_MARKER);
    log(
      `frame-ready name=${WINDOW_NAME} windowId=${browserWindow.id} ` +
        `position=${INITIAL_BOUNDS.x},${INITIAL_BOUNDS.y} ` +
        `size=${size.width}x${size.height} bytes=${byteLength}`,
    );
    armTargetConnectionTimeout();
    maybeStartLifecycleSequence();
  });

  browserWindow.on('closed', () => {
    if (!cleanupStarted) {
      terminate('window-closed', 0);
    }
  });

  if (MULTIWINDOW_PROOF) {
    frontOverlayWindow = session.windows.create({
      id: FRONT_WINDOW_NAME,
      name: FRONT_WINDOW_NAME,
      bounds: FRONT_BOUNDS,
      dragBorder: 30,
      captionHeight: 40,
      transparent: true,
      browserWindow: {
        title: FRONT_WINDOW_NAME,
        frame: false,
        show: false,
        transparent: true,
        resizable: false,
        useContentSize: true,
        backgroundColor: '#00000000',
        webPreferences: {
          offscreen: true,
          paintWhenInitiallyHidden: true,
          backgroundThrottling: false,
          nodeIntegration: true,
          contextIsolation: false,
        },
      },
      file: POPUP_OVERLAY_FILE,
    });

    const frontBrowserWindow = frontOverlayWindow.browserWindow;
    frontBrowserWindow.webContents.setFrameRate(FRAME_RATE);
    frontBrowserWindow.webContents.on(
      'console-message',
      (event, level, message) => {
        forwardProofConsoleMessage(message);
      },
    );
    frontBrowserWindow.webContents.on('did-finish-load', () => {
      frontPageLoaded = true;
      instrumentMultiwindowPage(frontOverlayWindow, {
        role: 'front',
        selector: 'input[type="text"]',
        left: 40,
        top: 84,
        color: '#3b82f6',
        caption: { left: 30, right: 30, top: 30, height: 40 },
        commands: [
          { label: 'Raise BACK', command: 'raise-back' },
          { label: 'Hide FRONT', command: 'hide-front' },
        ],
      })
        .then((target) => {
          frontDevicePixelRatio = target.devicePixelRatio;
          frontMultiwindowTarget = target;
          frontBrowserWindow.webContents.invalidate();
          maybeLogMultiwindowReady();
        })
        .catch((error) => fail('front-multiwindow-instrumentation', error));
    });
    bindRendererFailureHandlers(frontBrowserWindow, 'front');
    frontBrowserWindow.webContents.on('paint', (event, dirtyRect, image) => {
      const size = image.getSize();
      const byteLength = image.getBitmap().length;
      const expectedByteLength =
        EXPECTED_FRONT_FRAME_WIDTH * EXPECTED_FRONT_FRAME_HEIGHT * 4;

      if (size.width === 0 && size.height === 0 && byteLength === 0) {
        return;
      }
      if (
        size.width !== EXPECTED_FRONT_FRAME_WIDTH ||
        size.height !== EXPECTED_FRONT_FRAME_HEIGHT ||
        byteLength !== expectedByteLength
      ) {
        fail(
          'unexpected-front-frame',
          new Error(
            `expected ${EXPECTED_FRONT_FRAME_WIDTH}x${EXPECTED_FRONT_FRAME_HEIGHT}/` +
              `${expectedByteLength} bytes, ` +
              `received ${size.width}x${size.height}/${byteLength} bytes`,
          ),
        );
        return;
      }

      observedFrontFrames += 1;
      observedFrontFrameSize = size;
      maybeLogMultiwindowReady();
    });
    frontBrowserWindow.on('closed', () => {
      if (!cleanupStarted) {
        terminate('front-window-closed', 0);
      }
    });

    if (MANUAL_MULTIWINDOW_PROOF) {
      ipcMain.on(MULTIWINDOW_COMMAND_CHANNEL, handleMultiwindowIpcCommand);
      multiwindowIpcBound = true;
    }
  }

  overlayWindow.show();
  if (frontOverlayWindow) {
    frontOverlayWindow.show();
  }
  log(
    `started name=${WINDOW_NAME} file=${OVERLAY_FILE} ` +
      `position=${INITIAL_BOUNDS.x},${INITIAL_BOUNDS.y} ` +
      `size=${WINDOW_WIDTH}x${WINDOW_HEIGHT} fps=${FRAME_RATE}`,
  );
  if (frontOverlayWindow) {
    log(
      `started role=front name=${FRONT_WINDOW_NAME} file=${POPUP_OVERLAY_FILE} ` +
        `position=${FRONT_BOUNDS.x},${FRONT_BOUNDS.y} ` +
        `size=${FRONT_WINDOW_WIDTH}x${FRONT_WINDOW_HEIGHT} fps=${FRAME_RATE}`,
    );
  }
}

app.on('before-quit', () => {
  cleanup('before-quit');
});

app.on('window-all-closed', () => {
  if (!cleanupStarted) {
    app.quit();
  }
});

process.once('SIGINT', () => terminate('SIGINT', 0));
process.once('SIGTERM', () => terminate('SIGTERM', 0));

process.on('uncaughtException', (error) => {
  fail('uncaught-exception', error);
});

process.on('unhandledRejection', (error) => {
  fail('unhandled-rejection', error);
});

app
  .whenReady()
  .then(createDemo)
  .catch((error) => {
    fail('startup', error);
  });
