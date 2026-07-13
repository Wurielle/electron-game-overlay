import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  shell,
  Tray,
} from 'electron';
import * as path from 'path';
import {
  createExampleMainOverlayWindow,
  createExamplePopupOverlayWindow,
  createExampleStatusOverlayWindow,
  createExampleVideoOverlayWindow,
} from './example-overlay-windows';
import type { OverlayWindowContext } from './example-overlay-windows';
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  type ElectronOverlayWindow,
  type OverlayHotkey,
  type OverlaySession,
  type ReShadeLaunchConfig,
  type ReShadeTarget,
} from 'electron-game-overlay';
import {
  INPUT_INTERCEPT_ACCELERATOR,
  InputInterceptShortcut,
} from './input-intercept-shortcut';
import { AppWindows } from './window-names';

const SHOW_EXAMPLE_VIDEO_OVERLAY_HOTKEY = 'app.showExampleVideoOverlay';
const AUTO_START_OVERLAY_FLAG = '--start-overlay-session';
const GUN_FROG_INPUT_PROOF_FLAG = '--gun-frog-input-proof';
const AUTO_START_OVERLAY_MARKER = 'RESHADE_CLIENT_OVERLAY_SESSION_READY';
const RESHADE_CONFIGURED_MARKER = 'RESHADE_CLIENT_CONFIGURED';
const RESHADE_ATTACHMENT_STATE_MARKER = 'RESHADE_CLIENT_ATTACHMENT_STATE';
const DEMO_STATE_CHANGED_CHANNEL = 'overlay:state-changed';

type ReShadeAttachmentPhase = 'idle' | 'attaching' | 'connected';

type ReShadeAttachmentState = Readonly<{
  phase: ReShadeAttachmentPhase;
  processName: string | null;
  pid: number | null;
  error: string | null;
}>;

const EXAMPLE_OVERLAY_HOTKEYS: OverlayHotkey[] = [
  // Ctrl+I belongs exclusively to Electron's globalShortcut. Registering it
  // in the payload as well would make one physical keypress toggle twice.
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
  private inputInterceptRequested = false;
  private inputInterceptEffective = false;
  private overlay: ElectronGameOverlay;
  private overlaySession: OverlaySession;
  private readonly reshadeLauncher: ReShadeOverlayLauncher | null;
  private readonly inputInterceptShortcut: InputInterceptShortcut;
  private reshadeAttachment: ReShadeAttachmentState = {
    phase: 'idle',
    processName: null,
    pid: null,
    error: null,
  };
  private reshadeAttachmentAttempt = 0;
  private readonly gunFrogInputProof: boolean;
  private gunFrogInterceptRequested = false;
  private gunFrogButtonsReady = false;
  private gunFrogTargetConnected = false;
  private gunFrogProofReadyLogged = false;
  private disposed = false;

  constructor(reshadeConfig: ReShadeLaunchConfig | null = null) {
    this.windows = new Map();
    this.overlayWindows = new Map();
    this.tray = null;

    this.overlay = new ElectronGameOverlay();
    this.overlaySession = this.overlay.createSession();
    this.reshadeLauncher = reshadeConfig
      ? new ReShadeOverlayLauncher(reshadeConfig)
      : null;
    this.gunFrogInputProof = process.argv.includes(GUN_FROG_INPUT_PROOF_FLAG);
    this.inputInterceptShortcut = new InputInterceptShortcut(
      globalShortcut,
      () => this.toggleInputInterceptFromShortcut(),
    );
    this.overlaySession.onQuit(() => {
      this.markQuit = true;
    });
    this.overlaySession.on('fps', (payload) => {
      this.handleOverlayFps(payload.fps);
    });
    this.overlaySession.on('hotkeyDown', (payload) => {
      this.handleOverlayHotkeyDown(payload.name);
    });
    this.overlaySession.on('nativeEvent', ({ event, payload }) => {
      this.handleOverlayNativeEvent(event, payload);
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
      window.on('closed', () => {
        this.mainWindow = null;
      });

      window.loadURL(global.CONFIG.entryUrl);

      window.on('ready-to-show', () => {
        this.showAndFocusWindow(AppWindows.main);
      });

      window.webContents.on('did-fail-load', () => {
        window.reload();
      });

      window.on('close', (event) => {
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
        path.join(global.CONFIG.distDir, 'assets/icon-16.png'),
      );
      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'OpenMainWindow',
          click: () => {
            this.showAndFocusWindow(AppWindows.main);
          },
        },
        {
          label: 'Quit',
          click: () => {
            this.quit();
          },
        },
      ]);
      this.tray.setToolTip('WelCome');
      this.tray.setContextMenu(contextMenu);

      this.tray.on('click', () => {
        this.showAndFocusWindow(AppWindows.main);
      });
    }
  }

  public start() {
    this.setupIpc();
    this.createMainWindow();
    this.setupSystemTray();
    this.registerInputInterceptShortcut();

    if (this.reshadeLauncher) {
      console.log(
        `${RESHADE_CONFIGURED_MARKER} runtime=${JSON.stringify(this.reshadeLauncher.config.runtimeDirectory)}`,
      );
    }

    if (process.argv.includes(AUTO_START_OVERLAY_FLAG)) {
      const state = this.startOverlaySession();
      console.log(
        `${AUTO_START_OVERLAY_MARKER} windows=${JSON.stringify(state.windows)}`,
      );
    }

    const autoTargetProcess = this.reshadeLauncher?.config.autoTargetProcess;
    if (autoTargetProcess) {
      void this.attachOverlayToProcess(autoTargetProcess).catch((error) => {
        console.error('ReShade attachment failed', error);
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
    this.inputInterceptShortcut.dispose();
    this.reshadeLauncher?.dispose();
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
    option: Electron.BrowserWindowConstructorOptions,
  ) {
    const window = new BrowserWindow(option);
    this.windows.set(name, window);
    window.on('closed', () => {
      this.windows.delete(name);
    });
    window.webContents.on('new-window', (e, url) => {
      e.preventDefault();
      shell.openExternal(url);
    });

    if (global.DEBUG) {
      window.webContents.on(
        'before-input-event',
        (event: Electron.Event, input: Electron.Input) => {
          if (input.key === 'F12' && input.type === 'keyDown') {
            window.webContents.openDevTools();
          }
        },
      );
    }

    return window;
  }

  private setupIpc() {
    ipcMain.handle('overlay:get-state', () => this.getDemoState());

    ipcMain.handle('overlay:start', () => this.startOverlaySession());

    ipcMain.handle('overlay:inject', async (event, processName: string) =>
      this.attachOverlayToProcess(processName),
    );

    ipcMain.handle(
      'overlay:set-input-intercept',
      (event, intercept: boolean) => {
        this.ensureOverlaySessionStarted();
        this.setInputIntercept(intercept);
        return this.getDemoState();
      },
    );

    ipcMain.handle(
      'overlay:set-window-visible',
      (event, name: string, visible: boolean) => {
        this.ensureOverlaySessionStarted();
        this.setExampleOverlayWindowVisible(name, visible);
        return this.getDemoState();
      },
    );

    ipcMain.on('start', () => {
      this.startOverlaySession();
    });

    ipcMain.on('inject', (event, arg) => {
      void this.attachOverlayToProcess(arg).catch((error) => {
        console.error(
          'Cannot attach the overlay to the requested target',
          error,
        );
      });
    });

    ipcMain.on('showExamplePopupOverlay', () => {
      this.ensureOverlaySessionStarted();
      createExamplePopupOverlayWindow(this.getOverlayWindowContext());
    });

    ipcMain.on('showExampleVideoOverlay', () => {
      this.setExampleOverlayWindowVisible(AppWindows.exampleVideoOverlay, true);
    });

    ipcMain.on('startIntercept', () => {
      this.ensureOverlaySessionStarted();
      this.setInputIntercept(true);
    });

    ipcMain.on('stopIntercept', () => {
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

  private async attachOverlayToProcess(processName: string) {
    if (!this.reshadeLauncher) {
      throw new Error(
        'ReShade injection is not configured; restart the client with the explicit ReShade startup options',
      );
    }

    const normalizedProcessName = processName.trim();
    if (!normalizedProcessName) {
      throw new Error('Enter a game executable name before injecting');
    }
    if (this.reshadeAttachment.phase !== 'idle') {
      throw new Error(
        this.reshadeAttachment.phase === 'attaching'
          ? `ReShade is already attaching to ${this.reshadeAttachment.processName}`
          : `ReShade is already connected to ${this.reshadeAttachment.processName} (PID ${this.reshadeAttachment.pid})`,
      );
    }

    const attempt = ++this.reshadeAttachmentAttempt;
    this.setReShadeAttachmentState({
      phase: 'attaching',
      processName: normalizedProcessName,
      pid: null,
      error: null,
    });
    try {
      this.startOverlaySession();
      const result = await this.requestReShadeInjection({
        processName: normalizedProcessName,
      });
      if (this.isCurrentReShadeAttachment(attempt, 'attaching')) {
        this.setReShadeAttachmentState({
          phase: 'connected',
          processName: normalizedProcessName,
          pid: result.pid,
          error: null,
        });
        this.markGunFrogTargetConnected();
      }
      return this.getDemoState();
    } catch (error) {
      if (this.isCurrentReShadeAttachment(attempt, 'attaching')) {
        const attachmentError = getErrorMessage(error);
        const retryIsSafe = this.reshadeLauncher.state === 'idle';
        this.setReShadeAttachmentState(
          {
            // An indeterminate injector outcome remains latched in the SDK.
            // Keep the client non-idle until the launcher proves retry safety.
            phase: retryIsSafe ? 'idle' : 'attaching',
            processName: normalizedProcessName,
            pid: null,
            error: attachmentError,
          },
          retryIsSafe ? 'attach-failed' : 'attach-indeterminate',
        );
      }
      throw error;
    }
  }

  private requestReShadeInjection(target: ReShadeTarget) {
    if (!this.reshadeLauncher) {
      return Promise.reject(new Error('ReShade injection is not configured'));
    }
    return this.reshadeLauncher.attach(this.overlaySession, target);
  }

  private ensureOverlaySessionStarted() {
    if (!this.overlayStarted) {
      console.log('starting overlay...');
      this.overlaySession.start();
      this.overlaySession.setHotkeys(EXAMPLE_OVERLAY_HOTKEYS);
      this.overlayStarted = true;
    }
  }

  private setInputIntercept(intercept: boolean) {
    if (this.inputInterceptRequested === intercept) {
      return;
    }
    if (intercept) {
      this.overlaySession.input.intercept();
    } else {
      this.overlaySession.input.release();
    }
    this.inputInterceptRequested = intercept;
    this.publishDemoState();
  }

  private registerInputInterceptShortcut() {
    try {
      if (!this.inputInterceptShortcut.register()) {
        console.warn(
          `Cannot register global input interception shortcut ${INPUT_INTERCEPT_ACCELERATOR}`,
        );
      }
    } catch (error) {
      console.warn(
        `Cannot register global input interception shortcut ${INPUT_INTERCEPT_ACCELERATOR}`,
        error,
      );
    }
  }

  private toggleInputInterceptFromShortcut() {
    if (this.disposed) {
      return;
    }
    this.ensureOverlaySessionStarted();
    this.setInputIntercept(!this.inputInterceptRequested);
  }

  private publishDemoState() {
    const mainWindow = this.mainWindow;
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.isDestroyed()
    ) {
      return;
    }
    mainWindow.webContents.send(
      DEMO_STATE_CHANGED_CHANNEL,
      this.getDemoState(),
    );
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
        this.getOverlayWindowContext(),
      );
    } else if (name === AppWindows.exampleStatusOverlay) {
      overlayWindow = createExampleStatusOverlayWindow(
        this.getOverlayWindowContext(),
      );
    } else if (name === AppWindows.exampleVideoOverlay) {
      overlayWindow = createExampleVideoOverlayWindow(
        this.getOverlayWindowContext(),
      );
    } else {
      throw new Error(`Unknown example overlay window: ${name}`);
    }

    this.trackOverlayWindow(name, overlayWindow);
    return overlayWindow;
  }

  private trackOverlayWindow(
    name: string,
    overlayWindow: ElectronOverlayWindow,
  ) {
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
      inputInterceptRequested: this.inputInterceptRequested,
      inputInterceptEffective: this.inputInterceptEffective,
      runtime: this.reshadeLauncher ? 'reshade' : null,
      attachment: this.reshadeAttachment,
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
      statusWindow.webContents.send('fps', fps);
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
        { name, dragBorder, captionHeight, transparent },
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
      gunFrogInputProof: this.gunFrogInputProof,
      onGunFrogButtonsReady: () => {
        this.gunFrogButtonsReady = true;
        this.maybeLogGunFrogProofReady();
      },
    };
  }

  private handleOverlayNativeEvent(event: string, payload: any) {
    if (event === 'game.process') {
      this.handleReShadeTargetReconnected(payload);
      return;
    }

    if (event === 'game.process.transport-lost') {
      this.handleReShadeTargetTransportLost(payload);
      return;
    }

    if (event === 'game.process.disconnected') {
      this.handleReShadeTargetDisconnected(payload);
      return;
    }

    if (
      event === 'game.input.intercept' &&
      typeof payload?.intercepting === 'boolean'
    ) {
      this.inputInterceptEffective = payload.intercepting;
      console.log(
        `HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=${payload.intercepting}`,
      );
      this.publishDemoState();
      this.maybeLogGunFrogProofReady();
    }
  }

  private handleReShadeTargetReconnected(payload: any) {
    if (
      !Number.isSafeInteger(payload?.pid) ||
      payload.pid <= 0 ||
      this.reshadeAttachment.phase !== 'connected' ||
      this.reshadeAttachment.pid !== payload.pid
    ) {
      return;
    }

    this.markGunFrogTargetConnected();
  }

  private handleReShadeTargetTransportLost(payload: any) {
    if (!Number.isSafeInteger(payload?.pid) || payload.pid <= 0) {
      return;
    }

    if (
      this.reshadeAttachment.phase === 'connected' &&
      this.reshadeAttachment.pid !== payload.pid
    ) {
      return;
    }
    if (
      this.reshadeAttachment.phase !== 'connected' &&
      this.reshadeAttachment.phase !== 'attaching'
    ) {
      return;
    }

    // Transport loss is not proof that the target exited. Preserve the
    // attachment phase (and therefore the injection latch), but discard an
    // acknowledgement that no live transport can currently guarantee.
    this.inputInterceptEffective = false;
    this.gunFrogTargetConnected = false;
    this.gunFrogProofReadyLogged = false;
    this.publishDemoState();
  }

  private handleReShadeTargetDisconnected(payload: any) {
    if (!Number.isSafeInteger(payload?.pid) || payload.pid <= 0) {
      return;
    }

    const disconnectedPid = payload.pid as number;
    if (
      this.reshadeAttachment.phase !== 'connected' ||
      this.reshadeAttachment.pid !== disconnectedPid
    ) {
      return;
    }

    const processName = this.reshadeAttachment.processName;
    ++this.reshadeAttachmentAttempt;
    // Keep the requested intent so the session snapshot applies interception
    // to the next target, but never show a stale effective acknowledgement.
    this.inputInterceptEffective = false;
    this.gunFrogTargetConnected = false;
    this.gunFrogProofReadyLogged = false;
    this.setReShadeAttachmentState(
      {
        phase: 'idle',
        processName,
        pid: disconnectedPid,
        error: null,
      },
      'target-disconnected',
    );
  }

  private markGunFrogTargetConnected() {
    this.gunFrogTargetConnected = true;
    if (this.gunFrogInputProof && !this.gunFrogInterceptRequested) {
      this.gunFrogInterceptRequested = true;
      this.setInputIntercept(true);
    }
    this.maybeLogGunFrogProofReady();
  }

  private setReShadeAttachmentState(
    state: ReShadeAttachmentState,
    reason?: 'attach-failed' | 'attach-indeterminate' | 'target-disconnected',
  ) {
    this.reshadeAttachment = state;
    console.log(
      `${RESHADE_ATTACHMENT_STATE_MARKER} phase=${state.phase} processName=${JSON.stringify(state.processName)} pid=${state.pid ?? 'none'}${reason ? ` reason=${reason}` : ''}`,
    );
    this.publishDemoState();
  }

  private isCurrentReShadeAttachment(
    attempt: number,
    phase: ReShadeAttachmentPhase,
  ) {
    return (
      attempt === this.reshadeAttachmentAttempt &&
      this.reshadeAttachment.phase === phase
    );
  }

  private maybeLogGunFrogProofReady() {
    if (
      !this.gunFrogInputProof ||
      this.gunFrogProofReadyLogged ||
      !this.gunFrogButtonsReady ||
      !this.gunFrogTargetConnected ||
      !this.inputInterceptEffective
    ) {
      return;
    }

    this.gunFrogProofReadyLogged = true;
    console.log('HUDHOOK_CLIENT_GUN_FROG_PROOF_READY');
  }

  private showExampleVideoOverlay() {
    this.setExampleOverlayWindowVisible(AppWindows.exampleVideoOverlay, true);
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export { Application };
