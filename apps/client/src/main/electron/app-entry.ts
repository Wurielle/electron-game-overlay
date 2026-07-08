import { BrowserWindow, ipcMain, Menu, shell, Tray } from "electron";
import * as path from "path";
import {
  createExampleMainOverlayWindow,
  createExamplePopupOverlayWindow,
  createExampleStatusOverlayWindow,
  createExampleVideoOverlayWindow,
} from "./example-overlay-windows";
import type { OverlayWindowContext } from "./example-overlay-windows";
import {
  ElectronGameOverlay,
  type OverlayHotkey,
  type OverlaySession,
} from "@libs/electron-game-overlay-sdk";
import { AppWindows } from "./window-names";

const SHOW_EXAMPLE_VIDEO_OVERLAY_HOTKEY = "app.showExampleVideoOverlay";

const EXAMPLE_OVERLAY_HOTKEYS: OverlayHotkey[] = [
  {
    name: "overlay.hotkey.toggleInputIntercept",
    keyCode: 113,
    modifiers: { ctrl: true },
  },
  {
    name: SHOW_EXAMPLE_VIDEO_OVERLAY_HOTKEY,
    keyCode: 114,
    modifiers: { ctrl: true },
  },
];

class Application {
  private windows: Map<string, Electron.BrowserWindow>;
  private tray: Electron.Tray | null;
  private markQuit = false;
  private overlay: ElectronGameOverlay;
  private overlaySession: OverlaySession;

  constructor() {
    this.windows = new Map();
    this.tray = null;

    this.overlay = new ElectronGameOverlay();
    this.overlaySession = this.overlay.createSession();
    this.overlaySession.onQuit(() => {
      this.markQuit = true;
    });
    this.overlaySession.on("fps", (payload) => {
      this.handleOverlayFps(payload.fps);
    });
    this.overlaySession.on("hotkeyDown", (payload) => {
      this.handleOverlayHotkeyDown(payload.name);
    });
  }

  get mainWindow() {
    return this.windows.get(AppWindows.main) || null;
  }

  set mainWindow(window: Electron.BrowserWindow | null) {
    if (!window) {
      this.windows.delete(AppWindows.main);
    } else {
      this.windows.set(AppWindows.main, window);
      window.on("closed", () => {
        this.mainWindow = null;
      });

      window.loadURL(global.CONFIG.entryUrl);

      window.on("ready-to-show", () => {
        this.showAndFocusWindow(AppWindows.main);
      });

      window.webContents.on("did-fail-load", () => {
        window.reload();
      });

      window.on("close", (event) => {
        if (this.markQuit) {
          return;
        }
        event.preventDefault();
        window.hide();
        return false;
      });

      if (global.DEBUG) {
        window.webContents.openDevTools();
      }
    }
  }

  public getWindow(window: string) {
    return this.windows.get(window) || null;
  }

  public createMainWindow() {
    const options: Electron.BrowserWindowConstructorOptions = {
      height: 600,
      width: 800,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    };
    const mainWindow = this.createWindow(AppWindows.main, options);
    this.mainWindow = mainWindow;
    return mainWindow;
  }

  public openMainWindow() {
    let mainWindow = this.mainWindow;
    if (!mainWindow) {
      mainWindow = this.createMainWindow();
    }
    mainWindow.show();
    mainWindow.focus();
  }

  public closeMainWindow() {
    const mainWindow = this.mainWindow;
    if (mainWindow) {
      mainWindow.close();
    }
  }

  public closeAllWindows() {
    const windows = this.windows.values();
    for (const window of windows) {
      window.close();
    }
  }

  public closeWindow(name: string) {
    const window = this.windows.get(name);
    if (window) {
      window.close();
    }
  }

  public hideWindow(name: string) {
    const window = this.windows.get(name);
    if (window) {
      window.hide();
    }
  }

  public showAndFocusWindow(name: string) {
    const window = this.windows.get(name);
    if (window) {
      window.show();
      window.focus();
    }
  }

  public setupSystemTray() {
    if (!this.tray) {
      this.tray = new Tray(
        path.join(global.CONFIG.distDir, "assets/icon-16.png")
      );
      const contextMenu = Menu.buildFromTemplate([
        {
          label: "OpenMainWindow",
          click: () => {
            this.showAndFocusWindow(AppWindows.main);
          },
        },
        {
          label: "Quit",
          click: () => {
            this.quit();
          },
        },
      ]);
      this.tray.setToolTip("WelCome");
      this.tray.setContextMenu(contextMenu);

      this.tray.on("click", () => {
        this.showAndFocusWindow(AppWindows.main);
      });
    }
  }

  public start() {
    this.createMainWindow();
    this.setupSystemTray();
    this.setupIpc();
  }

  public activate() {
    this.openMainWindow();
  }

  public quit() {
    this.overlay.dispose();
    this.closeMainWindow();
    this.closeAllWindows();
    if (this.tray) {
      this.tray.destroy();
    }
  }

  public openLink(url: string) {
    shell.openExternal(url);
  }

  private createWindow(
    name: string,
    option: Electron.BrowserWindowConstructorOptions
  ) {
    const window = new BrowserWindow(option);
    this.windows.set(name, window);
    window.on("closed", () => {
      this.windows.delete(name);
    });
    window.webContents.on("new-window", (e, url) => {
      e.preventDefault();
      shell.openExternal(url);
    });

    if (global.DEBUG) {
      window.webContents.on(
        "before-input-event",
        (event: Electron.Event, input: Electron.Input) => {
          if (input.key === "F12" && input.type === "keyDown") {
            window.webContents.openDevTools();
          }
        }
      );
    }

    return window;
  }

  private setupIpc() {
    ipcMain.once("start", () => {
      console.log("starting overlay...");
      this.overlaySession.start();
      this.overlaySession.setHotkeys(EXAMPLE_OVERLAY_HOTKEYS);

      createExampleMainOverlayWindow(this.getOverlayWindowContext());
      createExampleStatusOverlayWindow(this.getOverlayWindowContext());
    });

    ipcMain.on("inject", (event, arg) => {
      this.overlaySession.attachToProcess({ title: arg });
    });

    ipcMain.on("showExamplePopupOverlay", () => {
      createExamplePopupOverlayWindow(this.getOverlayWindowContext());
    });

    ipcMain.on("showExampleVideoOverlay", () => {
      this.showExampleVideoOverlay();
    });

    ipcMain.on("startIntercept", () => {
      this.overlaySession.input.intercept();
    });

    ipcMain.on("stopIntercept", () => {
      this.overlaySession.input.release();
    });
  }

  private handleOverlayFps(fps: number) {
    const statusWindow = this.getWindow(AppWindows.exampleStatusOverlay);
    if (statusWindow) {
      statusWindow.webContents.send("fps", fps);
    }
  }

  private handleOverlayHotkeyDown(name: string) {
    if (name === SHOW_EXAMPLE_VIDEO_OVERLAY_HOTKEY) {
      this.showExampleVideoOverlay();
    }
  }

  private getOverlayWindowContext(): OverlayWindowContext {
    return {
      createWindow: (name, options) => this.createWindow(name, options),
      attachElectronOverlayWindow: (
        window,
        { name, dragBorder, captionHeight, transparent }
      ) =>
        this.overlaySession.windows.attach(window, {
          id: name,
          name,
          dragBorder,
          captionHeight,
          transparent,
        }),
      closeWindow: (name) => this.closeWindow(name),
      getMainWindow: () => this.mainWindow,
      isQuitting: () => this.markQuit,
    };
  }

  private showExampleVideoOverlay() {
    createExampleVideoOverlayWindow(this.getOverlayWindowContext());
  }
}

export { Application };
