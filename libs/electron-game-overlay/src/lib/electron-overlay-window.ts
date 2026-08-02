import { BrowserWindow } from 'electron';
import type { OverlayWindowBridge } from './overlay-window-bridge.js';
import type {
  ElectronOverlayWindowFollowTargetOptions,
  ElectronOverlayWindowOptions,
  Rect,
} from './types.js';

const ELECTRON_OVERLAY_WINDOW_CONSTRUCTION_TOKEN = Symbol(
  'ElectronOverlayWindow construction token',
);

let constructElectronOverlayWindow:
  | ((
      bridge: OverlayWindowBridge,
      options: ElectronOverlayWindowOptions,
    ) => ElectronOverlayWindow)
  | undefined;

/** @internal */
export function createElectronOverlayWindow(
  bridge: OverlayWindowBridge,
  options: ElectronOverlayWindowOptions,
): ElectronOverlayWindow {
  if (!constructElectronOverlayWindow) {
    throw new Error('ElectronOverlayWindow construction is not initialized');
  }
  return constructElectronOverlayWindow(bridge, options);
}

export class ElectronOverlayWindow {
  static {
    constructElectronOverlayWindow = (bridge, options) =>
      new ElectronOverlayWindow(
        ELECTRON_OVERLAY_WINDOW_CONSTRUCTION_TOKEN,
        bridge,
        options,
      );
  }

  public readonly id: string;
  public readonly name: string;
  public readonly nativeId: number;
  public readonly browserWindow: Electron.BrowserWindow;
  public readonly dragBorder: number;
  public readonly captionHeight: number;
  public readonly transparent: boolean;

  private registered = false;
  private destroyed = false;
  private readonly ownsBrowserWindow: boolean;
  private readonly focusOnReady: boolean;
  private readonly closeHandlers = new Set<() => void>();
  private readonly handlePaint = (
    _event: Electron.Event,
    _dirty: Electron.Rectangle,
    image: Electron.NativeImage,
  ) => {
    this.bridge.sendFrame(this, image);
  };
  private readonly handleReadyToShow = () => {
    if (this.focusOnReady) {
      this.focus();
    }
  };
  private readonly handleWindowGeometryChanged = () => {
    if (this.registered) {
      this.bridge.syncWindowGeometry(this);
    }
  };
  private readonly handleBrowserWindowClosed = () => {
    const failure = this.finalizeDestroy(false);
    if (failure) {
      this.reportTeardownFailure(failure.error);
    }
  };

  private constructor(
    constructionToken: symbol,
    private readonly bridge: OverlayWindowBridge,
    options: ElectronOverlayWindowOptions,
  ) {
    if (constructionToken !== ELECTRON_OVERLAY_WINDOW_CONSTRUCTION_TOKEN) {
      throw new TypeError(
        'ElectronOverlayWindow instances are created by OverlaySession.windows',
      );
    }
    this.ownsBrowserWindow = options.existingWindow === undefined;
    this.browserWindow =
      options.existingWindow ||
      new BrowserWindow(getBrowserWindowOptions(options));
    this.id = options.id || options.name || String(this.browserWindow.id);
    this.name = options.name || this.id;
    this.nativeId = this.browserWindow.id;
    this.dragBorder = options.dragBorder || 0;
    this.captionHeight = options.captionHeight || 0;
    this.transparent = options.transparent || false;
    this.focusOnReady = options.focusOnReady ?? false;

    if (options.bounds) {
      this.setBounds(options.bounds);
    }

    if (options.url) {
      this.browserWindow.loadURL(options.url);
    } else if (options.file) {
      this.browserWindow.loadFile(options.file);
    }

    this.bindBrowserWindow();
  }

  public get visible() {
    return this.registered && !this.destroyed;
  }

  public onClose(handler: () => void) {
    if (this.destroyed) {
      handler();
      return () => {};
    }

    this.closeHandlers.add(handler);

    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  public show() {
    if (this.destroyed || this.registered) {
      return;
    }

    this.bridge.registerWindow(this);
    this.registered = true;
    if (!this.browserWindow.webContents.isDestroyed()) {
      try {
        this.browserWindow.webContents.invalidate();
      } catch (error) {
        console.warn(
          `Cannot request the initial Electron overlay frame for window ${this.nativeId}`,
          error,
        );
      }
    }
  }

  public hide() {
    if (!this.registered) {
      return;
    }

    this.bridge.unregisterWindow(this);
    this.registered = false;
  }

  public destroy() {
    const failure = this.finalizeDestroy(this.ownsBrowserWindow);
    if (failure) {
      throw failure.error;
    }
  }

  public close() {
    this.destroy();
  }

  public focus() {
    this.browserWindow.focusOnWebView();
  }

  public blur() {
    this.browserWindow.blurWebView();
  }

  public setBounds(bounds: Partial<Rect>) {
    const current = this.browserWindow.getBounds();
    this.browserWindow.setBounds({
      ...current,
      ...bounds,
    });

    if (this.registered) {
      this.bridge.syncWindowGeometry(this);
    }
  }

  public getBounds() {
    return this.browserWindow.getBounds();
  }

  /** Keeps this window's OSR surface sized to a live injected render target. */
  public followTarget(options: ElectronOverlayWindowFollowTargetOptions = {}) {
    if (this.destroyed) {
      return;
    }
    this.bridge.followTarget(this, options);
  }

  public stopFollowingTarget() {
    if (this.destroyed) {
      return;
    }
    this.bridge.stopFollowingTarget(this);
  }

  private bindBrowserWindow() {
    this.browserWindow.webContents.on('paint', this.handlePaint);
    this.browserWindow.on('ready-to-show', this.handleReadyToShow);
    this.browserWindow.on('move', this.handleWindowGeometryChanged);
    this.browserWindow.on('resize', this.handleWindowGeometryChanged);
    this.browserWindow.on('closed', this.handleBrowserWindowClosed);
  }

  private unbindBrowserWindow() {
    this.browserWindow.removeListener('closed', this.handleBrowserWindowClosed);
    this.browserWindow.webContents.removeListener('paint', this.handlePaint);
    this.browserWindow.removeListener('ready-to-show', this.handleReadyToShow);
    this.browserWindow.removeListener('move', this.handleWindowGeometryChanged);
    this.browserWindow.removeListener(
      'resize',
      this.handleWindowGeometryChanged,
    );
  }

  private finalizeDestroy(destroyOwnedBrowserWindow: boolean) {
    if (this.destroyed) {
      return undefined;
    }

    const wasRegistered = this.registered;
    this.registered = false;
    this.destroyed = true;
    let failure: { error: unknown } | undefined;
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failure ??= { error };
      }
    };

    attempt(() => this.unbindBrowserWindow());
    if (wasRegistered) {
      attempt(() => this.bridge.unregisterWindow(this));
    }
    attempt(() => this.bridge.removeWindow(this));
    if (destroyOwnedBrowserWindow) {
      attempt(() => {
        if (!this.browserWindow.isDestroyed()) {
          this.browserWindow.destroy();
        }
      });
    }
    this.emitClose();
    return failure;
  }

  private reportTeardownFailure(error: unknown) {
    try {
      console.error(
        `Electron overlay window ${this.nativeId} teardown failed`,
        error,
      );
    } catch {
      // A diagnostic sink must not break Electron's closed event.
    }
  }

  private emitClose() {
    const handlers = Array.from(this.closeHandlers);
    this.closeHandlers.clear();
    for (const handler of handlers) {
      try {
        handler();
      } catch (error) {
        try {
          console.error('Electron overlay window close handler failed', error);
        } catch {
          // A diagnostic sink must not break window teardown.
        }
      }
    }
  }
}

function getBrowserWindowOptions(
  options: ElectronOverlayWindowOptions,
): Electron.BrowserWindowConstructorOptions {
  const bounds = options.bounds || {};
  const browserWindowOptions = options.browserWindow || {};

  return {
    ...browserWindowOptions,
    ...bounds,
    show: browserWindowOptions.show || false,
    webPreferences: {
      ...browserWindowOptions.webPreferences,
      offscreen: true,
    },
  };
}
