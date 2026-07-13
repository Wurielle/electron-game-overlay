import { BrowserWindow } from 'electron';
import type { OverlayWindowBridge } from './overlay-window-bridge.js';
import type {
  ElectronOverlayWindowFollowTargetOptions,
  ElectronOverlayWindowOptions,
  Rect,
} from './types.js';

export class ElectronOverlayWindow {
  public readonly id: string;
  public readonly name: string;
  public readonly nativeId: number;
  public readonly browserWindow: Electron.BrowserWindow;
  public readonly dragBorder: number;
  public readonly captionHeight: number;
  public readonly transparent: boolean;

  private registered = false;
  private destroyed = false;
  private readonly closeHandlers = new Set<() => void>();

  constructor(
    private readonly bridge: OverlayWindowBridge,
    options: ElectronOverlayWindowOptions,
  ) {
    this.browserWindow =
      options.existingWindow ||
      new BrowserWindow(getBrowserWindowOptions(options));
    this.id = options.id || options.name || String(this.browserWindow.id);
    this.name = options.name || this.id;
    this.nativeId = this.browserWindow.id;
    this.dragBorder = options.dragBorder || 0;
    this.captionHeight = options.captionHeight || 0;
    this.transparent = options.transparent || false;

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
  }

  public hide() {
    if (!this.registered) {
      return;
    }

    this.bridge.unregisterWindow(this);
    this.registered = false;
  }

  public destroy() {
    if (this.destroyed) {
      return;
    }

    this.hide();
    this.destroyed = true;
    this.bridge.removeWindow(this);
    this.emitClose();

    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.close();
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
    this.browserWindow.webContents.on(
      'paint',
      (event, dirty, image: Electron.NativeImage) => {
        this.bridge.sendFrame(this, image);
      },
    );

    this.browserWindow.on('ready-to-show', () => {
      this.focus();
    });

    const syncWindowGeometry = () => {
      if (this.registered) {
        this.bridge.syncWindowGeometry(this);
      }
    };

    this.browserWindow.on('move', syncWindowGeometry);
    this.browserWindow.on('resize', syncWindowGeometry);

    this.browserWindow.on('closed', () => {
      this.hide();
      this.destroyed = true;
      this.bridge.removeWindow(this);
      this.emitClose();
    });

    this.browserWindow.webContents.on('cursor-changed', (event, type) => {
      this.bridge.sendCursor(type);
    });
  }

  private emitClose() {
    for (const handler of this.closeHandlers) {
      handler();
    }
    this.closeHandlers.clear();
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
