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
  type ElectronOverlayWindow,
  type OverlayHotkey,
  type OverlaySession,
} from "electron-game-overlay";
import {
  HUDHOOK_CONFIGURED_MARKER,
  HUDHOOK_TARGET_CONNECTED_MARKER,
  HudhookOverlayLauncher,
  type HudhookLaunchConfig,
  type HudhookTarget,
} from "./hudhook-launch";
import { AppWindows } from "./window-names";

const SHOW_EXAMPLE_VIDEO_OVERLAY_HOTKEY = "app.showExampleVideoOverlay";
const AUTO_START_OVERLAY_FLAG = "--start-overlay-session";
const AUTO_START_OVERLAY_MARKER = "HUDHOOK_CLIENT_OVERLAY_SESSION_READY";

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
  private overlayWindows: Map<string, ElectronOverlayWindow>;
  private tray: Electron.Tray | null;
  private markQuit = false;
  private overlayStarted = false;
  private inputIntercepting = false;
  private overlay: ElectronGameOverlay;
  private overlaySession: OverlaySession;
  private readonly hudhookLauncher: HudhookOverlayLauncher | null;
  private readonly connectedHudhookTargetPids = new Set<number>();
  private disposed = false;

  constructor(hudhookConfig: HudhookLaunchConfig | null = null) {
    this.windows = new Map();
    this.overlayWindows = new Map();
    this.tray = null;

    this.overlay = new ElectronGameOverlay();
    this.overlaySession = this.overlay.createSession();
    this.hudhookLauncher = hudhookConfig
      ? new HudhookOverlayLauncher(hudhookConfig)
      : null;
    this.overlaySession.onQuit(() => {
      this.markQuit = true;
    });
    this.overlaySession.on("fps", (payload) => {
      this.handleOverlayFps(payload.fps);
    });
    this.overlaySession.on("hotkeyDown", (payload) => {
      this.handleOverlayHotkeyDown(payload.name);
    });
    this.overlaySession.on("nativeEvent", (payload) => {
      this.handleNativeOverlayEvent(payload);
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
    this.setupIpc();
    this.createMainWindow();
    this.setupSystemTray();

    if (this.hudhookLauncher) {
      console.log(
        `${HUDHOOK_CONFIGURED_MARKER} backend=${this.hudhookLauncher.config.backend} runtime=${JSON.stringify(this.hudhookLauncher.config.runtimeDirectory)}`
      );
    }

    if (process.argv.includes(AUTO_START_OVERLAY_FLAG)) {
      const state = this.startOverlaySession();
      console.log(
        `${AUTO_START_OVERLAY_MARKER} windows=${JSON.stringify(state.windows)}`
      );
    }

    const autoTargetProcess = this.hudhookLauncher?.config.autoTargetProcess;
    if (autoTargetProcess) {
      this.ensureOverlaySessionStarted();
      void this.requestHudhookInjection({
        processName: autoTargetProcess,
      }).catch(() => {
        // HudhookOverlayLauncher emits the bounded failure diagnostics. Keep the
        // Electron producer alive so the attached runner can collect its logs.
      });
    }
  }

  public activate() {
    this.openMainWindow();
  }

  public quit() {
    this.dispose();
    this.closeMainWindow();
    this.closeAllWindows();
  }

  public dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.hudhookLauncher?.dispose();
    this.overlay.dispose();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
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
    ipcMain.handle("overlay:get-state", () => this.getDemoState());

    ipcMain.handle("overlay:start", () => this.startOverlaySession());

    ipcMain.handle("overlay:inject", async (event, title: string) =>
      this.attachOverlayToTitle(title)
    );

    ipcMain.handle(
      "overlay:set-input-intercept",
      (event, intercept: boolean) => {
        this.ensureOverlaySessionStarted();
        this.setInputIntercept(intercept);
        return this.getDemoState();
      }
    );

    ipcMain.handle(
      "overlay:set-window-visible",
      (event, name: string, visible: boolean) => {
        this.ensureOverlaySessionStarted();
        this.setExampleOverlayWindowVisible(name, visible);
        return this.getDemoState();
      }
    );

    ipcMain.on("start", () => {
      this.startOverlaySession();
    });

    ipcMain.on("inject", (event, arg) => {
      void this.attachOverlayToTitle(arg).catch((error) => {
        console.error(
          "Cannot attach the overlay to the requested target",
          error
        );
      });
    });

    ipcMain.on("showExamplePopupOverlay", () => {
      this.ensureOverlaySessionStarted();
      createExamplePopupOverlayWindow(this.getOverlayWindowContext());
    });

    ipcMain.on("showExampleVideoOverlay", () => {
      this.setExampleOverlayWindowVisible(AppWindows.exampleVideoOverlay, true);
    });

    ipcMain.on("startIntercept", () => {
      this.ensureOverlaySessionStarted();
      this.setInputIntercept(true);
    });

    ipcMain.on("stopIntercept", () => {
      this.ensureOverlaySessionStarted();
      this.setInputIntercept(false);
    });
  }

  private startOverlaySession() {
    this.ensureOverlaySessionStarted();
    this.ensureExampleOverlayWindow(AppWindows.exampleMainOverlay).show();
    this.ensureExampleOverlayWindow(AppWindows.exampleStatusOverlay).show();

    return this.getDemoState();
  }

  private async attachOverlayToTitle(title: string) {
    this.startOverlaySession();
    if (this.hudhookLauncher) {
      await this.requestHudhookInjection({ windowTitle: title });
    } else {
      this.overlaySession.attachToProcess({ title });
    }
    return this.getDemoState();
  }

  private requestHudhookInjection(target: HudhookTarget) {
    if (!this.hudhookLauncher) {
      return Promise.reject(new Error("hudhook injection is not configured"));
    }
    return this.hudhookLauncher.launch(target);
  }

  private ensureOverlaySessionStarted() {
    if (!this.overlayStarted) {
      console.log("starting overlay...");
      this.overlaySession.start();
      this.overlaySession.setHotkeys(EXAMPLE_OVERLAY_HOTKEYS);
      this.overlayStarted = true;
    }
  }

  private setInputIntercept(intercept: boolean) {
    if (intercept) {
      this.overlaySession.input.intercept();
    } else {
      this.overlaySession.input.release();
    }
    this.inputIntercepting = intercept;
  }

  private setExampleOverlayWindowVisible(name: string, visible: boolean) {
    if (visible) {
      this.ensureExampleOverlayWindow(name).show();
      return;
    }

    this.overlayWindows.get(name)?.hide();
  }

  private ensureExampleOverlayWindow(name: string) {
    const existing = this.overlayWindows.get(name);
    if (existing && !existing.browserWindow.isDestroyed()) {
      return existing;
    }

    let overlayWindow: ElectronOverlayWindow;
    if (name === AppWindows.exampleMainOverlay) {
      overlayWindow = createExampleMainOverlayWindow(
        this.getOverlayWindowContext()
      );
    } else if (name === AppWindows.exampleStatusOverlay) {
      overlayWindow = createExampleStatusOverlayWindow(
        this.getOverlayWindowContext()
      );
    } else if (name === AppWindows.exampleVideoOverlay) {
      overlayWindow = createExampleVideoOverlayWindow(
        this.getOverlayWindowContext()
      );
    } else {
      throw new Error(`Unknown example overlay window: ${name}`);
    }

    this.trackOverlayWindow(name, overlayWindow);
    return overlayWindow;
  }

  private trackOverlayWindow(name: string, overlayWindow: ElectronOverlayWindow) {
    this.overlayWindows.set(name, overlayWindow);
    overlayWindow.onClose(() => {
      if (this.overlayWindows.get(name) === overlayWindow) {
        this.overlayWindows.delete(name);
      }
    });
  }

  private getDemoState() {
    return {
      overlayStarted: this.overlayStarted,
      inputIntercepting: this.inputIntercepting,
      windows: {
        [AppWindows.exampleMainOverlay]:
          this.overlayWindows.get(AppWindows.exampleMainOverlay)?.visible ||
          false,
        [AppWindows.exampleStatusOverlay]:
          this.overlayWindows.get(AppWindows.exampleStatusOverlay)?.visible ||
          false,
        [AppWindows.exampleVideoOverlay]:
          this.overlayWindows.get(AppWindows.exampleVideoOverlay)?.visible ||
          false,
      },
    };
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

  private handleNativeOverlayEvent({
    event,
    payload,
  }: {
    event: string;
    payload: any;
  }) {
    if (
      event !== "game.process" ||
      !this.hudhookLauncher ||
      !this.hudhookLauncher.hasRequestedInjection
    ) {
      return;
    }

    const pid = payload?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return;
    }
    const expectedTargetPid = this.hudhookLauncher.config.expectedTargetPid;
    if (expectedTargetPid !== undefined && pid !== expectedTargetPid) {
      console.warn(
        `Ignored hudhook target connection from unexpected pid=${pid}; expected pid=${expectedTargetPid}`
      );
      return;
    }
    if (!this.hudhookLauncher.acceptTargetConnection(pid)) {
      return;
    }
    if (this.connectedHudhookTargetPids.has(pid)) {
      return;
    }

    this.connectedHudhookTargetPids.add(pid);
    console.log(`${HUDHOOK_TARGET_CONNECTED_MARKER} pid=${pid}`);
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
    this.setExampleOverlayWindowVisible(AppWindows.exampleVideoOverlay, true);
  }
}

export { Application };
