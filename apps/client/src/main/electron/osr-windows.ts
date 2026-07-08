import * as path from "path";
import { fileUrl } from "../utils/utils";
import { AppWindows } from "./window-names";

type OverlayWindowContext = {
  createWindow: (
    name: string,
    options: Electron.BrowserWindowConstructorOptions
  ) => Electron.BrowserWindow;
  addOverlayWindow: (
    name: string,
    window: Electron.BrowserWindow,
    dragborder?: number,
    captionHeight?: number,
    transparent?: boolean
  ) => void;
  closeWindow: (name: string) => void;
  getMainWindow: () => Electron.BrowserWindow | null;
  isQuitting: () => boolean;
};

export function createOsrWindow(context: OverlayWindowContext) {
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

  const window = context.createWindow(AppWindows.osr, options);
  window.loadURL(fileUrl(path.join(global.CONFIG.distDir, "index/osr.html")));

  window.webContents.on(
    "paint",
    (event, dirty, image: Electron.NativeImage) => {
      if (context.isQuitting()) {
        return;
      }

      const mainWindow = context.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send("osrImage", {
          image: image.toDataURL(),
        });
      }
    }
  );

  context.addOverlayWindow("MainOverlay", window, 10, 40);
  return window;
}

export function createOsrStatusbarWindow(context: OverlayWindowContext) {
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

  const name = "StatusBar";
  const window = context.createWindow(name, options);
  window.loadURL(
    fileUrl(path.join(global.CONFIG.distDir, "index/statusbar.html"))
  );

  context.addOverlayWindow(name, window, 0, 0);
  return window;
}

export function createOsrTipWindow(context: OverlayWindowContext) {
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

  const name = `osrtip ${getRandomInt(1, 10000)}`;
  const window = context.createWindow(name, options);
  window.loadURL(fileUrl(path.join(global.CONFIG.distDir, "index/osrtip.html")));

  context.addOverlayWindow(name, window, 30, 40, true);
  return window;
}

export function createOverlayTipWindow(context: OverlayWindowContext) {
  const name = "OverlayTip";
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

  context.addOverlayWindow(name, window, 0, 0);
  window.loadURL(fileUrl(path.join(global.CONFIG.distDir, "doit/index.html")));

  return window;
}

function getRandomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
