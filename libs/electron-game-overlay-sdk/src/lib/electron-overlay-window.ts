import { BrowserWindow } from "electron";
import type { OverlaySession } from "./overlay-session.js";
import type { ElectronOverlayWindowOptions, Rect } from "./types.js";

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

  constructor(
    private readonly session: OverlaySession,
    options: ElectronOverlayWindowOptions
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

  public show() {
    if (this.destroyed || this.registered) {
      return;
    }

    this.session.registerWindow(this);
    this.registered = true;
  }

  public hide() {
    if (!this.registered) {
      return;
    }

    this.session.unregisterWindow(this);
    this.registered = false;
  }

  public destroy() {
    if (this.destroyed) {
      return;
    }

    this.hide();
    this.destroyed = true;
    this.session.removeWindow(this);

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
      this.session.syncWindowBounds(this);
    }
  }

  public getBounds() {
    return this.browserWindow.getBounds();
  }

  private bindBrowserWindow() {
    this.browserWindow.webContents.on(
      "paint",
      (event, dirty, image: Electron.NativeImage) => {
        this.session.sendFrame(this, image);
      }
    );

    this.browserWindow.on("ready-to-show", () => {
      this.focus();
    });

    this.browserWindow.on("resize", () => {
      console.log(`${this.name} resizing`);
      if (this.registered) {
        this.session.syncWindowBounds(this);
      }
    });

    this.browserWindow.on("closed", () => {
      this.hide();
      this.destroyed = true;
      this.session.removeWindow(this);
    });

    this.browserWindow.webContents.on("cursor-changed", (event, type) => {
      this.session.sendCursor(type);
    });
  }
}

function getBrowserWindowOptions(
  options: ElectronOverlayWindowOptions
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
