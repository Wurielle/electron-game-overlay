import { BrowserWindow, screen } from "electron";
import { toNativeCursor } from "./cursor.js";
import { ElectronOverlayWindow } from "./electron-overlay-window.js";
import type { NativeOverlay } from "./native.js";
import type {
  ElectronOverlayWindowOptions,
  OverlayEventHandler,
  OverlayHotkey,
  Rect,
} from "./types.js";

export class OverlaySession {
  private readonly windows = new Map<string, ElectronOverlayWindow>();
  private readonly eventHandlers = new Set<OverlayEventHandler>();
  private readonly quitHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  private scaleFactor = 1.0;
  private started = false;
  private quitting = false;
  private closed = false;

  public readonly input = {
    intercept: () => this.setInputIntercept(true),
    release: () => this.setInputIntercept(false),
  };

  constructor(private readonly overlay: NativeOverlay) {}

  public start() {
    if (this.started) {
      return;
    }

    this.scaleFactor = screen.getDisplayNearestPoint({
      x: 0,
      y: 0,
    }).scaleFactor;

    this.overlay.start();
    this.overlay.setEventCallback((event: string, payload: any) => {
      this.handleEvent(event, payload);
      this.emitEvent(event, payload);
    });

    this.started = true;
  }

  public close() {
    if (this.closed) {
      return;
    }

    this.emitQuit();

    for (const window of Array.from(this.windows.values())) {
      window.destroy();
    }
    this.windows.clear();

    if (this.started) {
      this.overlay.stop();
      this.started = false;
    }

    this.closed = true;
    this.emitClose();
  }

  public onQuit(handler: () => void) {
    if (this.quitting) {
      handler();
      return () => {};
    }

    this.quitHandlers.add(handler);

    return () => {
      this.quitHandlers.delete(handler);
    };
  }

  public onClose(handler: () => void) {
    if (this.closed) {
      handler();
      return () => {};
    }

    this.closeHandlers.add(handler);

    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  public setHotkeys(hotkeys: OverlayHotkey[]) {
    this.ensureStarted();
    this.overlay.setHotkeys(hotkeys);
  }

  public onEvent(handler: OverlayEventHandler) {
    this.eventHandlers.add(handler);

    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  public createElectronWindow(options: ElectronOverlayWindowOptions) {
    this.ensureStarted();
    const overlayWindow = new ElectronOverlayWindow(this, options);
    this.windows.set(overlayWindow.id, overlayWindow);
    overlayWindow.show();
    return overlayWindow;
  }

  public getWindow(id: string) {
    return this.windows.get(id) || null;
  }

  public injectProcessByTitle(title: string) {
    this.ensureStarted();
    console.log(`--------------------\n try inject ${title}`);
    for (const window of this.overlay.getTopWindows()) {
      if (window.title && window.title.indexOf(title) !== -1) {
        console.log(`--------------------\n injecting ${JSON.stringify(window)}`);
        this.overlay.injectProcess(window);
      }
    }
  }

  public setInputIntercept(intercept: boolean) {
    this.ensureStarted();
    this.overlay.sendCommand({
      command: "input.intercept",
      intercept,
    });
  }

  public registerWindow(window: ElectronOverlayWindow) {
    this.ensureStarted();
    const browserWindow = window.browserWindow;
    const bounds = this.getScaledBounds(browserWindow);
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    this.overlay.addWindow(browserWindow.id, {
      name: window.name,
      transparent: window.transparent,
      resizable: browserWindow.isResizable(),
      maxWidth: browserWindow.isResizable()
        ? display.bounds.width
        : browserWindow.getBounds().width,
      maxHeight: browserWindow.isResizable()
        ? display.bounds.height
        : browserWindow.getBounds().height,
      minWidth: browserWindow.isResizable()
        ? 100
        : browserWindow.getBounds().width,
      minHeight: browserWindow.isResizable()
        ? 100
        : browserWindow.getBounds().height,
      nativeHandle: browserWindow.getNativeWindowHandle().readUInt32LE(0),
      rect: bounds,
      caption: {
        left: Math.floor(window.dragBorder * this.scaleFactor),
        right: Math.floor(window.dragBorder * this.scaleFactor),
        top: Math.floor(window.dragBorder * this.scaleFactor),
        height: Math.floor(window.captionHeight * this.scaleFactor),
      },
      dragBorderWidth: Math.floor(window.dragBorder),
    });
  }

  public unregisterWindow(window: ElectronOverlayWindow) {
    this.overlay.closeWindow(window.nativeId);
  }

  public removeWindow(window: ElectronOverlayWindow) {
    this.windows.delete(window.id);
  }

  public syncWindowBounds(window: ElectronOverlayWindow) {
    this.ensureStarted();
    this.overlay.sendWindowBounds(window.nativeId, {
      rect: this.getScaledBounds(window.browserWindow),
    });
  }

  public sendFrame(
    window: ElectronOverlayWindow,
    image: Electron.NativeImage
  ) {
    if (this.quitting || !window.visible) {
      return;
    }

    this.overlay.sendFrameBuffer(
      window.nativeId,
      image.getBitmap(),
      image.getSize().width,
      image.getSize().height
    );
  }

  public sendCursor(type: string) {
    this.ensureStarted();
    this.overlay.sendCommand({
      command: "cursor",
      cursor: toNativeCursor(type),
    });
  }

  public forwardGameInput(payload: any) {
    const window = BrowserWindow.fromId(payload.windowId);
    if (!window) {
      return;
    }

    const inputEvent = this.overlay.translateInputEvent(payload);
    if (!inputEvent) {
      return;
    }

    if ("x" in inputEvent) {
      inputEvent.x = Math.round(inputEvent.x / this.scaleFactor);
    }
    if ("y" in inputEvent) {
      inputEvent.y = Math.round(inputEvent.y / this.scaleFactor);
    }

    window.webContents.sendInputEvent(inputEvent);
  }

  private handleEvent(event: string, payload: any) {
    if (event === "game.input") {
      this.forwardGameInput(payload);
    } else if (event === "game.window.focused") {
      console.log("focusWindowId", payload.focusWindowId);

      BrowserWindow.getAllWindows().forEach((window) => {
        window.blurWebView();
      });

      const focusWin = BrowserWindow.fromId(payload.focusWindowId);
      if (focusWin) {
        focusWin.focusOnWebView();
      }
    }
  }

  private emitEvent(event: string, payload: any) {
    for (const handler of this.eventHandlers) {
      handler(event, payload);
    }
  }

  private emitQuit() {
    if (this.quitting) {
      return;
    }

    this.quitting = true;
    for (const handler of this.quitHandlers) {
      handler();
    }
  }

  private emitClose() {
    for (const handler of this.closeHandlers) {
      handler();
    }
    this.closeHandlers.clear();
  }

  private getScaledBounds(window: Electron.BrowserWindow): Rect {
    const bounds = window.getBounds();
    return {
      x: bounds.x,
      y: bounds.y,
      width: Math.floor(bounds.width * this.scaleFactor),
      height: Math.floor(bounds.height * this.scaleFactor),
    };
  }

  private ensureStarted() {
    if (!this.started) {
      this.start();
    }
  }
}
