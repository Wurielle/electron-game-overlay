import { getRandomInt } from "../utils/utils";
import type {
  AttachElectronOverlayWindowOptions,
  ElectronOverlayWindow,
} from "electron-game-overlay";
import { AppWindows } from "./window-names";

export type OverlayWindowContext = {
  createWindow: (
    name: string,
    options: Electron.BrowserWindowConstructorOptions
  ) => Electron.BrowserWindow;
  attachElectronOverlayWindow: (
    window: Electron.BrowserWindow,
    options: AttachElectronOverlayWindowOptions & { name: string }
  ) => ElectronOverlayWindow;
  closeWindow: (name: string) => void;
  getMainWindow: () => Electron.BrowserWindow | null;
  isQuitting: () => boolean;
};

const HUDHOOK_CLIENT_INPUT_MARKER = "HUDHOOK_CLIENT_";

function forwardHudhookInputDiagnostics(window: Electron.BrowserWindow) {
  window.webContents.on("console-message", (_event, _level, message) => {
    if (message.startsWith(HUDHOOK_CLIENT_INPUT_MARKER)) {
      console.log(message);
    }
  });
}

function enableHudhookInputProof(window: Electron.BrowserWindow) {
  window.webContents.once("did-finish-load", () => {
    void window.webContents
      .executeJavaScript(`(() => {
        const proof = window.hudhookInputProof;
        if (!proof || typeof proof.enable !== "function") {
          throw new Error("window.hudhookInputProof is unavailable");
        }
        proof.enable();
        return typeof proof.getTargetRect === "function"
          ? proof.getTargetRect()
          : null;
      })()`)
      .then((rect) => {
        console.log(
          `HUDHOOK_CLIENT_INPUT_PROOF_ARMED rect=${JSON.stringify(rect)}`
        );
      })
      .catch((error) => {
        console.warn("HUDHOOK_CLIENT_INPUT_PROOF_FAILED", error);
      });
  });
}

export function createExampleMainOverlayWindow(context: OverlayWindowContext) {
  const options: Electron.BrowserWindowConstructorOptions = {
    x: 1,
    y: 1,
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
  enableHudhookInputProof(window);
  window.loadURL(
    global.CONFIG.resolveRendererUrl("index/example-main-overlay.html")
  );

  window.webContents.on(
    "paint",
    (event, dirty, image: Electron.NativeImage) => {
      if (context.isQuitting()) {
        return;
      }

      const mainWindow = context.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send("exampleMainOverlayImage", {
          image: image.toDataURL(),
        });
      }
    }
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name: "ExampleMainOverlay",
    dragBorder: 10,
    captionHeight: 40,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}

export function createExampleStatusOverlayWindow(context: OverlayWindowContext) {
  const options: Electron.BrowserWindowConstructorOptions = {
    x: 100,
    y: 200,
    height: 50,
    width: 200,
    frame: false,
    show: false,
    transparent: true,
    resizable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  };

  const name = AppWindows.exampleStatusOverlay;
  const window = context.createWindow(name, options);
  forwardHudhookInputDiagnostics(window);
  window.loadURL(
    global.CONFIG.resolveRendererUrl("index/example-status-overlay.html")
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
    x: 0,
    y: 200,
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
    global.CONFIG.resolveRendererUrl("index/example-popup-overlay.html")
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
    x: 0,
    y: 0,
    webPreferences: {
      offscreen: true,
      nodeIntegration: true,
    },
  });

  window.loadURL(
    global.CONFIG.resolveRendererUrl("example-video-overlay/index.html")
  );

  const overlayWindow = context.attachElectronOverlayWindow(window, {
    name,
    transparent: true,
  });
  overlayWindow.show();
  return overlayWindow;
}
