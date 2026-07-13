import { getRandomInt } from '../utils/utils';
import { screen } from 'electron';
import type {
  AttachElectronOverlayWindowOptions,
  ElectronOverlayWindow,
} from 'electron-game-overlay';
import { AppWindows } from './window-names';

export type OverlayWindowContext = {
  createWindow: (
    name: string,
    options: Electron.BrowserWindowConstructorOptions,
  ) => Electron.BrowserWindow;
  attachElectronOverlayWindow: (
    window: Electron.BrowserWindow,
    options: AttachElectronOverlayWindowOptions & { name: string },
  ) => ElectronOverlayWindow;
  closeWindow: (name: string) => void;
  getMainWindow: () => Electron.BrowserWindow | null;
  isQuitting: () => boolean;
  gunFrogInputProof: boolean;
  demoPresentation: boolean;
  onGunFrogButtonsReady: () => void;
};

const HUDHOOK_CLIENT_INPUT_MARKER = 'HUDHOOK_CLIENT_';
const OVERLAY_CLIENT_INPUT_TARGET_MARKER = 'OVERLAY_CLIENT_INPUT_TARGET';

type InputProofRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DEMO_CONTROL_OVERLAY_COMPACT_SIZE = Object.freeze({
  width: 320,
  height: 170,
});

export const DEMO_CONTROL_OVERLAY_EXPANDED_SIZE = Object.freeze({
  width: 390,
  height: 390,
});

function logInputProofTarget(
  window: Electron.BrowserWindow,
  role: 'main' | 'status',
  name: string,
  target: InputProofRect,
) {
  const values = [target.x, target.y, target.width, target.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    target.width <= 0 ||
    target.height <= 0
  ) {
    throw new Error(
      `Invalid ${role}/${name} input proof rectangle: ${JSON.stringify(target)}`,
    );
  }

  const bounds = window.getContentBounds();
  const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
  console.log(
    `${OVERLAY_CLIENT_INPUT_TARGET_MARKER} ` +
      `role=${role} name=${name} ` +
      `targetX=${target.x} targetY=${target.y} ` +
      `targetWidth=${target.width} targetHeight=${target.height} ` +
      `windowX=${bounds.x} windowY=${bounds.y} ` +
      `windowWidth=${bounds.width} windowHeight=${bounds.height} ` +
      `scale=${scaleFactor}`,
  );
}

function forwardHudhookInputDiagnostics(window: Electron.BrowserWindow) {
  window.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith(HUDHOOK_CLIENT_INPUT_MARKER)) {
      console.log(message);
    }
  });
}

function enableHudhookInputProof(
  window: Electron.BrowserWindow,
  gunFrogInputProof: boolean,
  onGunFrogButtonsReady: () => void,
) {
  window.webContents.once('did-finish-load', () => {
    void window.webContents
      .executeJavaScript(
        `(() => {
        const proof = window.hudhookInputProof;
        if (!proof || typeof proof.enable !== "function") {
          throw new Error("window.hudhookInputProof is unavailable");
        }
        proof.enable();
        const inputTarget = typeof proof.getTargetRect === "function"
          ? proof.getTargetRect()
          : null;
        let gunFrogButtons = [];
        if (${JSON.stringify(gunFrogInputProof)}) {
          const gunFrogProof = window.gunFrogInputProof;
          if (!gunFrogProof || typeof gunFrogProof.enable !== "function") {
            throw new Error("window.gunFrogInputProof is unavailable");
          }
          gunFrogProof.enable();
          gunFrogButtons = gunFrogProof.getButtonRects();
        }
        return { inputTarget, gunFrogButtons };
      })()`,
      )
      .then(({ inputTarget, gunFrogButtons }) => {
        console.log(
          `HUDHOOK_CLIENT_INPUT_PROOF_ARMED rect=${JSON.stringify(inputTarget)}`,
        );
        logInputProofTarget(window, 'main', 'text', inputTarget);
        if (!gunFrogInputProof) {
          return;
        }

        if (!Array.isArray(gunFrogButtons) || gunFrogButtons.length !== 4) {
          throw new Error(
            `Expected four Gun Frog proof buttons, received ${JSON.stringify(gunFrogButtons)}`,
          );
        }
        const bounds = window.getContentBounds();
        for (const button of gunFrogButtons) {
          console.log(
            'HUDHOOK_GUN_FROG_BUTTON ' +
              `name=${button.name} ` +
              `x=${Math.round(bounds.x + button.x)} ` +
              `y=${Math.round(bounds.y + button.y)} ` +
              `width=${Math.round(button.width)} ` +
              `height=${Math.round(button.height)}`,
          );
        }
        console.log('HUDHOOK_GUN_FROG_BUTTONS_READY');
        onGunFrogButtonsReady();
      })
      .catch((error) => {
        console.warn('HUDHOOK_CLIENT_INPUT_PROOF_FAILED', error);
      });
  });
}

function enableStatusInputProof(window: Electron.BrowserWindow) {
  window.webContents.once('did-finish-load', () => {
    void window.webContents
      .executeJavaScript(
        `(() => {
        const target = document.getElementById("hudhook-status-input-target");
        if (!(target instanceof HTMLInputElement)) {
          throw new Error("status input proof target is unavailable");
        }
        const rect = target.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
      })()`,
      )
      .then((target) => {
        logInputProofTarget(window, 'status', 'text', target);
      })
      .catch((error) => {
        console.warn('OVERLAY_CLIENT_INPUT_TARGET_FAILED role=status', error);
      });
  });
}

export function createDemoControlOverlayWindow(context: OverlayWindowContext) {
  const name = AppWindows.demoControlOverlay;
  const window = context.createWindow(name, {
    x: 24,
    y: 24,
    ...DEMO_CONTROL_OVERLAY_COMPACT_SIZE,
    frame: false,
    show: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  window.loadURL(
    global.CONFIG.resolveRendererUrl('index/demo-control-overlay.html'),
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name,
    dragBorder: 8,
    captionHeight: 54,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}

export function createExampleMainOverlayWindow(context: OverlayWindowContext) {
  const options: Electron.BrowserWindowConstructorOptions = {
    x: context.gunFrogInputProof ? 64 : context.demoPresentation ? 440 : 1,
    y: context.gunFrogInputProof ? 270 : context.demoPresentation ? 24 : 1,
    height: 360,
    width: 640,
    frame: false,
    show: false,
    transparent: true,
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  };

  const window = context.createWindow(AppWindows.exampleMainOverlay, options);
  forwardHudhookInputDiagnostics(window);
  enableHudhookInputProof(
    window,
    context.gunFrogInputProof,
    context.onGunFrogButtonsReady,
  );
  window.loadURL(
    global.CONFIG.resolveRendererUrl('index/example-main-overlay.html'),
  );

  window.webContents.on(
    'paint',
    (event, dirty, image: Electron.NativeImage) => {
      if (context.isQuitting()) {
        return;
      }

      const mainWindow = context.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('exampleMainOverlayImage', {
          image: image.toDataURL(),
        });
      }
    },
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name: 'ExampleMainOverlay',
    dragBorder: 10,
    captionHeight: 40,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}

export function createExampleStatusOverlayWindow(
  context: OverlayWindowContext,
) {
  const options: Electron.BrowserWindowConstructorOptions = {
    x: context.gunFrogInputProof ? 800 : context.demoPresentation ? 440 : 100,
    y: context.gunFrogInputProof ? 100 : context.demoPresentation ? 400 : 200,
    height: 50,
    width: 200,
    frame: false,
    show: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  };

  const name = AppWindows.exampleStatusOverlay;
  const window = context.createWindow(name, options);
  forwardHudhookInputDiagnostics(window);
  enableStatusInputProof(window);
  window.loadURL(
    global.CONFIG.resolveRendererUrl('index/example-status-overlay.html'),
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}

export function createExamplePopupOverlayWindow(context: OverlayWindowContext) {
  const options: Electron.BrowserWindowConstructorOptions = {
    x: context.gunFrogInputProof ? 800 : context.demoPresentation ? 440 : 0,
    y: context.demoPresentation ? 480 : 200,
    height: 220,
    width: 320,
    resizable: false,
    frame: false,
    show: false,
    transparent: true,
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  };

  const name = `example-popup-overlay ${getRandomInt(1, 10000)}`;
  const window = context.createWindow(name, options);
  window.loadURL(
    global.CONFIG.resolveRendererUrl('index/example-popup-overlay.html'),
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name,
    dragBorder: 30,
    captionHeight: 40,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}

export function createExampleVideoOverlayWindow(context: OverlayWindowContext) {
  const name = AppWindows.exampleVideoOverlay;
  context.closeWindow(name);

  const window = context.createWindow(name, {
    width: 480,
    height: 270,
    frame: false,
    show: false,
    transparent: true,
    resizable: false,
    x: context.demoPresentation ? 780 : 0,
    y: context.demoPresentation ? 400 : 0,
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
    },
  });

  window.loadURL(
    global.CONFIG.resolveRendererUrl('example-video-overlay/index.html'),
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}
