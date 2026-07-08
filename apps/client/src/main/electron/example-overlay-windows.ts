import * as path from "path";
import { fileUrl, getRandomInt } from "../utils/utils";
import type { ElectronOverlayWindow } from "./electron-game-overlay";
import { AppWindows } from "./window-names";

export type OverlayWindowContext = {
  createWindow: (
    name: string,
    options: Electron.BrowserWindowConstructorOptions
  ) => Electron.BrowserWindow;
  createElectronOverlayWindow: (
    name: string,
    window: Electron.BrowserWindow,
    dragBorder?: number,
    captionHeight?: number,
    transparent?: boolean
  ) => ElectronOverlayWindow;
  closeWindow: (name: string) => void;
  getMainWindow: () => Electron.BrowserWindow | null;
  isQuitting: () => boolean;
};

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
  window.loadURL(
    fileUrl(path.join(global.CONFIG.distDir, "index/example-main-overlay.html"))
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

  return context.createElectronOverlayWindow(
    "ExampleMainOverlay",
    window,
    10,
    40
  );
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
  window.loadURL(
    fileUrl(
      path.join(global.CONFIG.distDir, "index/example-status-overlay.html")
    )
  );

  return context.createElectronOverlayWindow(name, window, 0, 0);
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
    fileUrl(
      path.join(global.CONFIG.distDir, "index/example-popup-overlay.html")
    )
  );

  return context.createElectronOverlayWindow(name, window, 30, 40, true);
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
    fileUrl(path.join(global.CONFIG.distDir, "example-video-overlay/index.html"))
  );

  return context.createElectronOverlayWindow(name, window, 0, 0);
}
