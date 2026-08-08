import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Tray,
} from 'electron';
import * as path from 'path';
import {
  createDemoControlOverlayWindow,
  createExampleMainOverlayWindow,
  createExamplePopupOverlayWindow,
  createExampleStatusOverlayWindow,
  createExampleVideoOverlayWindow,
  DEMO_CONTROL_OVERLAY_COMPACT_SIZE,
  DEMO_CONTROL_OVERLAY_EXPANDED_SIZE,
} from './example-overlay-windows';
import type { OverlayWindowContext } from './example-overlay-windows';
import {
  CompatibilityRunRecorder,
  resolveCompatibilityRunsRoot,
  type CompatibilityRunMode,
} from './compatibility-run-recorder';
import {
  ElectronGameOverlay,
  isReShadeOperationError,
  ReShadeOverlayLauncher,
  type ElectronOverlayWindow,
  type OverlayDiagnostic,
  type OverlayGraphicsFps,
  type OverlaySession,
  type OverlayTargetSurface,
  type ReShadeDiagnostic,
  type ReShadeLaunchConfig,
  type ReShadeTarget,
} from 'electron-game-overlay';
import {
  INPUT_INTERCEPT_ACCELERATOR,
  InputInterceptShortcut,
} from './input-intercept-shortcut';
import {
  ForkedProcessWatcher,
  SteamGameAutoAttacher,
} from './steam-game-auto-attacher';
import { logReShadeLauncherEvent } from './reshade-launcher-logging';
import { TargetInputInterceptState } from './target-input-intercept-state';
import { AppWindows } from './window-names';

const AUTO_START_OVERLAY_FLAG = '--start-overlay-session';
const GUN_FROG_INPUT_PROOF_FLAG = '--gun-frog-input-proof';
const STEAM_AUTO_ATTACH_FLAG = '--steam-auto-attach';
const DEMO_PRESENTATION_FLAG = '--demo-presentation';
const AUTO_START_OVERLAY_MARKER = 'RESHADE_CLIENT_OVERLAY_SESSION_READY';
const RESHADE_CONFIGURED_MARKER = 'RESHADE_CLIENT_CONFIGURED';
const RESHADE_ATTACHMENT_STATE_MARKER = 'RESHADE_CLIENT_ATTACHMENT_STATE';
const COMPATIBILITY_RUN_RECORDER_MARKER =
  'ELECTRON_GAME_OVERLAY_COMPATIBILITY_RUN';
const DEMO_STATE_CHANGED_CHANNEL = 'overlay:state-changed';

type ReShadeAttachmentPhase = 'idle' | 'attaching' | 'connected';

type ReShadeAttachmentState = Readonly<{
  phase: ReShadeAttachmentPhase;
  processName: string | null;
  pid: number | null;
  error: string | null;
  diagnostic: ReShadeDiagnostic | null;
}>;

class Application {
  private windows: Map<string, Electron.BrowserWindow>;
  private overlayWindows: Map<string, ElectronOverlayWindow>;
  private tray: Electron.Tray | null;
  private markQuit = false;
  private overlayStarted = false;
  private inputInterceptRequested = false;
  private inputInterceptEffective = false;
  private latestOverlayDiagnostic: OverlayDiagnostic | null = null;
  private latestOverlayFps: number | null = null;
  private overlayFpsEventCount = 0;
  private advertisedTargetSurfaceIdentity: string | null = null;
  private readonly targetInputInterceptState = new TargetInputInterceptState();
  private overlay: ElectronGameOverlay;
  private overlaySession: OverlaySession;
  private readonly reshadeLauncher: ReShadeOverlayLauncher | null;
  private readonly steamGameAutoAttacher: SteamGameAutoAttacher | null;
  private readonly inputInterceptShortcut: InputInterceptShortcut;
  private compatibilityRunRecorder: CompatibilityRunRecorder | null = null;
  private reshadeAttachment: ReShadeAttachmentState = {
    phase: 'idle',
    processName: null,
    pid: null,
    error: null,
    diagnostic: null,
  };
  private reshadeAttachmentAttempt = 0;
  private readonly gunFrogInputProof: boolean;
  private readonly demoPresentationEnabled: boolean;
  private gunFrogInterceptRequested = false;
  private gunFrogButtonsReady = false;
  private gunFrogTargetConnected = false;
  private gunFrogProofReadyLogged = false;
  private demoControlRaiseQueued = false;
  private disposed = false;

  constructor(reshadeConfig: ReShadeLaunchConfig | null = null) {
    this.windows = new Map();
    this.overlayWindows = new Map();
    this.tray = null;
    this.gunFrogInputProof = process.argv.includes(GUN_FROG_INPUT_PROOF_FLAG);
    this.demoPresentationEnabled =
      process.argv.includes(DEMO_PRESENTATION_FLAG) && !this.gunFrogInputProof;

    this.overlay = new ElectronGameOverlay();
    this.overlaySession = this.overlay.createSession();
    this.reshadeLauncher = reshadeConfig
      ? new ReShadeOverlayLauncher(reshadeConfig)
      : null;
    this.reshadeLauncher?.onEvent((event) =>
      this.handleReShadeLauncherEvent(event),
    );
    const steamAutoAttachRequested = process.argv.includes(
      STEAM_AUTO_ATTACH_FLAG,
    );
    if (
      steamAutoAttachRequested &&
      (reshadeConfig?.autoTargetProcess || reshadeConfig?.expectedTargetPid)
    ) {
      throw new Error(
        `${STEAM_AUTO_ATTACH_FLAG} cannot be combined with a configured ReShade auto target`,
      );
    }
    this.steamGameAutoAttacher =
      steamAutoAttachRequested && reshadeConfig
        ? new SteamGameAutoAttacher({
            session: this.overlaySession,
            reshadeConfig,
            launcherEventHandler: (event) =>
              this.handleReShadeLauncherEvent(event),
            watcherFactory: () =>
              new ForkedProcessWatcher(
                resolveProcessWatcherEntry(),
                reshadeConfig.injectorPath,
              ),
          })
        : null;
    if (steamAutoAttachRequested && !reshadeConfig) {
      console.warn(
        `${STEAM_AUTO_ATTACH_FLAG} was ignored because ReShade is not configured`,
      );
    }
    this.steamGameAutoAttacher?.onStateChange(() => {
      const autoAttachState = this.steamGameAutoAttacher?.state;
      if (autoAttachState) {
        this.compatibilityRunRecorder?.recordAutoAttachState(autoAttachState);
      }
      if (
        this.gunFrogInputProof &&
        this.steamGameAutoAttacher?.state.targets.some(
          (target) =>
            target.phase === 'connected' &&
            target.processName.toLowerCase() === 'gun frog.exe',
        )
      ) {
        this.markGunFrogTargetConnected();
      }
      this.publishDemoState();
    });
    this.inputInterceptShortcut = new InputInterceptShortcut(
      globalShortcut,
      () => this.toggleInputInterceptFromShortcut(),
    );
    this.overlaySession.onQuit(() => {
      this.markQuit = true;
    });
    this.overlaySession.on('fps', (payload) => {
      this.handleOverlayFps(payload);
    });
    this.overlaySession.on('diagnostic', (diagnostic) => {
      this.handleOverlayDiagnostic(diagnostic);
    });
    this.overlaySession.on('targetSurfaceChanged', (surface) => {
      this.compatibilityRunRecorder?.recordTargetSurface(surface);
      this.publishDemoState();
    });
    this.overlaySession.on('targetSurfaceRemoved', (surface) => {
      this.compatibilityRunRecorder?.recordTargetSurfaceRemoved(surface);
      this.publishDemoState();
    });
    this.overlaySession.on('targetConnected', ({ pid, executablePath }) => {
      this.handleOverlayTargetConnected(pid, executablePath);
    });
    this.overlaySession.on('targetTransportLost', ({ pid, executablePath }) => {
      this.handleOverlayTargetTransportLost(pid, executablePath);
    });
    this.overlaySession.on('targetDisconnected', ({ pid, executablePath }) => {
      this.handleOverlayTargetDisconnected(pid, executablePath);
    });
    this.overlaySession.on(
      'inputInterceptionChanged',
      ({ pid, intercepting }) => {
        this.handleOverlayInputInterceptionChanged(pid, intercepting);
      },
    );
    this.overlaySession.on('windowFocused', ({ pid, windowId }) => {
      this.compatibilityRunRecorder?.recordNativeEvent('game.window.focused', {
        pid,
        focusWindowId: windowId,
      });
      this.keepDemoControlOverlayOnTop(windowId);
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
    this.startCompatibilityRunRecorder();
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

    if (this.steamGameAutoAttacher) {
      this.startOverlaySession();
      this.steamGameAutoAttacher.start();
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
    void this.steamGameAutoAttacher?.dispose();
    this.inputInterceptShortcut.dispose();
    this.reshadeLauncher?.dispose();
    this.overlay.dispose();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.compatibilityRunRecorder?.close();
    this.compatibilityRunRecorder = null;
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
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
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

    ipcMain.handle(
      'overlay:inject',
      async (event, processName: string, pid?: number) =>
        this.attachOverlayToProcess(processName, pid),
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

    ipcMain.handle('overlay:create-popup', () => {
      this.ensureOverlaySessionStarted();
      createExamplePopupOverlayWindow(this.getOverlayWindowContext());
      this.publishDemoState();
      return this.getDemoState();
    });

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
    if (this.demoPresentationEnabled) {
      this.syncDemoControlOverlay();
    } else {
      this.ensureExampleOverlayWindow(AppWindows.exampleMainOverlay).show();
      this.ensureExampleOverlayWindow(AppWindows.exampleStatusOverlay).show();
    }

    return this.getDemoState();
  }

  private async attachOverlayToProcess(processName: string, pid?: number) {
    if (this.steamGameAutoAttacher) {
      throw new Error(
        'Manual injection is disabled while Steam process auto-attach is enabled',
      );
    }
    if (!this.reshadeLauncher) {
      throw new Error(
        'ReShade injection is not configured; restart the client with the explicit ReShade startup options',
      );
    }

    const normalizedProcessName = processName.trim();
    if (!normalizedProcessName) {
      throw new Error('Enter a game executable name before injecting');
    }
    const normalizedPid = normalizeOptionalTargetPid(pid);
    if (this.reshadeAttachment.phase !== 'idle') {
      throw new Error(
        this.reshadeAttachment.phase === 'attaching'
          ? `ReShade is already attaching to ${this.reshadeAttachment.processName}${this.reshadeAttachment.pid ? ` (PID ${this.reshadeAttachment.pid})` : ''}`
          : `ReShade is already connected to ${this.reshadeAttachment.processName} (PID ${this.reshadeAttachment.pid})`,
      );
    }

    const attempt = ++this.reshadeAttachmentAttempt;
    this.setReShadeAttachmentState({
      phase: 'attaching',
      processName: normalizedProcessName,
      pid: normalizedPid ?? null,
      error: null,
      diagnostic: null,
    });
    try {
      this.startOverlaySession();
      const result = await this.requestReShadeInjection({
        processName: normalizedProcessName,
        ...(normalizedPid === undefined ? {} : { pid: normalizedPid }),
      });
      if (this.isCurrentReShadeAttachment(attempt, 'attaching')) {
        this.setReShadeAttachmentState({
          phase: 'connected',
          processName: normalizedProcessName,
          pid: result.pid,
          error: null,
          diagnostic: null,
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
            pid: normalizedPid ?? null,
            error: attachmentError,
            diagnostic: getReShadeDiagnostic(error),
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
    this.compatibilityRunRecorder?.recordInputRequested(intercept);
    this.syncDemoControlOverlay();
    this.refreshInputInterceptEffective();
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
    const state = this.getDemoState();
    const publishedWindowIds = new Set<number>();
    for (const window of this.windows.values()) {
      if (
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        publishedWindowIds.has(window.id)
      ) {
        continue;
      }
      publishedWindowIds.add(window.id);
      window.webContents.send(DEMO_STATE_CHANGED_CHANNEL, state);
    }
  }

  private setExampleOverlayWindowVisible(name: string, visible: boolean) {
    if (visible) {
      const overlayWindow = this.ensureExampleOverlayWindow(name);
      overlayWindow.show();
      if (name !== AppWindows.demoControlOverlay) {
        this.keepDemoControlOverlayOnTop(overlayWindow.nativeId);
      }
    } else {
      this.overlayWindows.get(name)?.hide();
    }
    this.publishDemoState();
  }

  private ensureExampleOverlayWindow(name: string) {
    const existing = this.overlayWindows.get(name);
    if (existing && !existing.browserWindow.isDestroyed()) {
      return existing;
    }

    let overlayWindow: ElectronOverlayWindow;
    if (name === AppWindows.demoControlOverlay) {
      overlayWindow = createDemoControlOverlayWindow(
        this.getOverlayWindowContext(),
      );
    } else if (name === AppWindows.exampleMainOverlay) {
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
        if (!this.disposed) {
          this.publishDemoState();
        }
      }
    });
  }

  private syncDemoControlOverlay() {
    if (!this.demoPresentationEnabled) {
      return;
    }
    const overlayWindow = this.ensureExampleOverlayWindow(
      AppWindows.demoControlOverlay,
    );
    overlayWindow.show();
    overlayWindow.setBounds(
      this.inputInterceptRequested
        ? DEMO_CONTROL_OVERLAY_EXPANDED_SIZE
        : DEMO_CONTROL_OVERLAY_COMPACT_SIZE,
    );
  }

  private getDemoState() {
    const { targetSurfaces, targetSurface } =
      this.getDemoTargetSurfaceSnapshot();
    return {
      overlayStarted: this.overlayStarted,
      inputInterceptRequested: this.inputInterceptRequested,
      inputInterceptEffective: this.inputInterceptEffective,
      runtime: this.reshadeLauncher ? 'reshade' : null,
      presentation: this.demoPresentationEnabled
        ? {
            enabled: true as const,
            shortcut: INPUT_INTERCEPT_ACCELERATOR,
            menuExpanded: this.inputInterceptRequested,
          }
        : null,
      steamAutoAttach: this.steamGameAutoAttacher?.state ?? null,
      attachment: this.reshadeAttachment,
      diagnostic: this.latestOverlayDiagnostic,
      targetSurface,
      targetSurfaces,
      latestOverlayFps: this.latestOverlayFps,
      overlayFpsEventCount: this.overlayFpsEventCount,
      windows: {
        [AppWindows.demoControlOverlay]:
          this.overlayWindows.get(AppWindows.demoControlOverlay)?.visible ||
          false,
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

  private getDemoTargetSurfaceSnapshot(): Readonly<{
    targetSurfaces: readonly OverlayTargetSurface[];
    targetSurface: OverlayTargetSurface | null;
  }> {
    const targetSurfaces = this.overlaySession.targets.list();
    const activeAttachmentPid = this.getActiveAttachmentPid();
    let targetSurface: OverlayTargetSurface | null = null;
    for (let index = targetSurfaces.length - 1; index >= 0; index -= 1) {
      const candidate = targetSurfaces[index];
      if (
        candidate &&
        (activeAttachmentPid === null || candidate.pid === activeAttachmentPid)
      ) {
        targetSurface = candidate;
        break;
      }
    }

    const identity = targetSurface
      ? `${targetSurface.pid}:${targetSurface.surfaceId}`
      : null;
    if (identity !== this.advertisedTargetSurfaceIdentity) {
      this.advertisedTargetSurfaceIdentity = identity;
      this.latestOverlayFps = null;
    }

    return { targetSurfaces, targetSurface };
  }

  private getActiveAttachmentPid(): number | null {
    return this.reshadeAttachment.phase !== 'idle'
      ? this.reshadeAttachment.pid
      : null;
  }

  private handleOverlayFps(payload: OverlayGraphicsFps) {
    this.compatibilityRunRecorder?.recordFps(payload);
    const { targetSurface } = this.getDemoTargetSurfaceSnapshot();
    const acceptedTargetPid =
      this.getActiveAttachmentPid() ?? targetSurface?.pid ?? null;
    if (payload.pid !== acceptedTargetPid) {
      return;
    }

    this.latestOverlayFps = payload.fps;
    this.overlayFpsEventCount += 1;
    this.publishDemoState();
    for (const name of [
      AppWindows.demoControlOverlay,
      AppWindows.exampleStatusOverlay,
    ]) {
      const window = this.getWindow(name);
      if (window && !window.webContents.isDestroyed()) {
        window.webContents.send('fps', payload.fps);
      }
    }
  }

  private handleOverlayDiagnostic(diagnostic: OverlayDiagnostic) {
    this.compatibilityRunRecorder?.recordOverlayDiagnostic(diagnostic);
    this.latestOverlayDiagnostic = diagnostic;
    const marker =
      `OVERLAY_SESSION_DIAGNOSTIC source=${diagnostic.source} ` +
      `severity=${diagnostic.severity} code=${diagnostic.code}` +
      `${diagnostic.pid === undefined ? '' : ` pid=${diagnostic.pid}`}`;
    if (diagnostic.severity === 'error') {
      console.error(marker, diagnostic.message, diagnostic.context ?? {});
    } else if (diagnostic.severity === 'warning') {
      console.warn(marker, diagnostic.message, diagnostic.context ?? {});
    } else {
      console.log(marker, diagnostic.message, diagnostic.context ?? {});
    }
    this.publishDemoState();
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
      demoPresentation: this.demoPresentationEnabled,
      onGunFrogButtonsReady: () => {
        this.gunFrogButtonsReady = true;
        this.maybeLogGunFrogProofReady();
      },
    };
  }

  private handleOverlayTargetConnected(pid: number, executablePath: string) {
    this.compatibilityRunRecorder?.recordNativeEvent('game.process', {
      pid,
      path: executablePath,
    });
    this.latestOverlayDiagnostic = null;
    this.targetInputInterceptState.connect(pid);
    this.refreshInputInterceptEffective();
    this.handleReShadeTargetReconnected(pid);
  }

  private handleOverlayTargetTransportLost(
    pid: number,
    executablePath: string,
  ) {
    this.compatibilityRunRecorder?.recordNativeEvent(
      'game.process.transport-lost',
      { pid, path: executablePath },
    );
    this.handleTargetTransportEnded(pid);
    this.handleReShadeTargetTransportLost(pid);
  }

  private handleOverlayTargetDisconnected(pid: number, executablePath: string) {
    this.compatibilityRunRecorder?.recordNativeEvent(
      'game.process.disconnected',
      { pid, path: executablePath },
    );
    this.handleTargetTransportEnded(pid);
    this.handleReShadeTargetDisconnected(pid);
  }

  private handleOverlayInputInterceptionChanged(
    pid: number,
    intercepting: boolean,
  ) {
    if (!this.targetInputInterceptState.acknowledge(pid, intercepting)) {
      return;
    }
    this.compatibilityRunRecorder?.recordInputAcknowledged(pid, intercepting);
    this.refreshInputInterceptEffective();
    console.log(
      `HUDHOOK_CLIENT_INPUT_INTERCEPT_ACK intercepting=${intercepting}`,
    );
    this.maybeLogGunFrogProofReady();
  }

  private keepDemoControlOverlayOnTop(focusWindowId: number) {
    if (
      !this.demoPresentationEnabled ||
      this.demoControlRaiseQueued ||
      !Number.isSafeInteger(focusWindowId) ||
      focusWindowId <= 0
    ) {
      return;
    }
    const controlOverlay = this.overlayWindows.get(
      AppWindows.demoControlOverlay,
    );
    if (!controlOverlay?.visible || focusWindowId === controlOverlay.nativeId) {
      return;
    }

    this.demoControlRaiseQueued = true;
    queueMicrotask(() => {
      this.demoControlRaiseQueued = false;
      const current = this.overlayWindows.get(AppWindows.demoControlOverlay);
      if (
        this.disposed ||
        current !== controlOverlay ||
        !current.visible ||
        current.browserWindow.isDestroyed()
      ) {
        return;
      }
      current.hide();
      current.show();
      current.browserWindow.webContents.invalidate();
    });
  }

  private handleTargetTransportEnded(pid: number) {
    this.targetInputInterceptState.disconnect(pid);
    this.refreshInputInterceptEffective();
  }

  private refreshInputInterceptEffective() {
    const effective = this.targetInputInterceptState.isEffective(
      this.inputInterceptRequested,
    );
    if (this.inputInterceptEffective === effective) {
      return;
    }
    this.inputInterceptEffective = effective;
    this.compatibilityRunRecorder?.recordInputEffective(effective);
    this.publishDemoState();
  }

  private handleReShadeTargetReconnected(pid: number) {
    if (
      this.reshadeAttachment.phase !== 'connected' ||
      this.reshadeAttachment.pid !== pid
    ) {
      return;
    }

    this.markGunFrogTargetConnected();
  }

  private handleReShadeTargetTransportLost(pid: number) {
    if (
      this.reshadeAttachment.phase === 'connected' &&
      this.reshadeAttachment.pid !== pid
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
    this.gunFrogTargetConnected = false;
    this.gunFrogProofReadyLogged = false;
    this.publishDemoState();
  }

  private handleReShadeTargetDisconnected(disconnectedPid: number) {
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
    this.gunFrogTargetConnected = false;
    this.gunFrogProofReadyLogged = false;
    this.setReShadeAttachmentState(
      {
        phase: 'idle',
        processName,
        pid: disconnectedPid,
        error: null,
        diagnostic: null,
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
    this.compatibilityRunRecorder?.recordAttachmentState(state, reason);
    const diagnostic =
      state.diagnostic === null
        ? ''
        : ` code=${state.diagnostic.code} stage=${state.diagnostic.stage}${
            state.diagnostic.runtimeStartupCode === undefined
              ? ''
              : ` runtimeStartup=${state.diagnostic.runtimeStartupCode}`
          }`;
    console.log(
      `${RESHADE_ATTACHMENT_STATE_MARKER} phase=${state.phase} processName=${JSON.stringify(state.processName)} pid=${state.pid ?? 'none'}${reason ? ` reason=${reason}` : ''}${diagnostic}`,
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

  private startCompatibilityRunRecorder() {
    if (!this.reshadeLauncher || this.compatibilityRunRecorder) {
      return;
    }

    const mode: CompatibilityRunMode = this.steamGameAutoAttacher
      ? 'steam-auto-attach'
      : this.reshadeLauncher.config.autoTargetProcess
        ? 'automatic-target'
        : 'manual';
    try {
      const rootDirectory = resolveCompatibilityRunsRoot(
        process.env.ELECTRON_GAME_OVERLAY_COMPATIBILITY_RUNS_DIR,
        path.join(app.getPath('logs'), 'compatibility-runs'),
      );
      const recorder = new CompatibilityRunRecorder({
        rootDirectory,
        mode,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        onError: (error) => {
          console.warn(
            `${COMPATIBILITY_RUN_RECORDER_MARKER}_DISABLED detail=${JSON.stringify(error.message)}`,
          );
        },
      });
      this.compatibilityRunRecorder = recorder;
      recorder.recordInputRequested(this.inputInterceptRequested);
      recorder.recordInputEffective(this.inputInterceptEffective);
      console.log(
        `${COMPATIBILITY_RUN_RECORDER_MARKER}_STARTED events=${JSON.stringify(recorder.eventsPath)} summary=${JSON.stringify(recorder.summaryPath)}`,
      );
    } catch (error) {
      console.warn(
        `${COMPATIBILITY_RUN_RECORDER_MARKER}_DISABLED detail=${JSON.stringify(getErrorMessage(error))}`,
      );
    }
  }

  private handleReShadeLauncherEvent(
    event: Parameters<typeof logReShadeLauncherEvent>[0],
  ) {
    logReShadeLauncherEvent(event);
    this.compatibilityRunRecorder?.recordLauncherEvent(event);
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getReShadeDiagnostic(error: unknown): ReShadeDiagnostic | null {
  return isReShadeOperationError(error) ? error.diagnostic : null;
}

function normalizeOptionalTargetPid(pid: unknown): number | undefined {
  if (pid === undefined || pid === null) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(pid) ||
    (pid as number) <= 0 ||
    (pid as number) > 0xffffffff
  ) {
    throw new RangeError(
      'Target PID must be an integer between 1 and 4294967295',
    );
  }
  return pid as number;
}

function resolveProcessWatcherEntry(): string {
  const clientRoot = process.env.VITE_DEV_SERVER_URL
    ? path.resolve(global.CONFIG.distDir, '..')
    : global.CONFIG.distDir;
  return path.join(clientRoot, 'process-watcher', 'index.cjs');
}

export { Application };
