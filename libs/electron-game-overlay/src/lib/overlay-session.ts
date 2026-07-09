import { BrowserWindow, screen } from "electron";
import { toNativeCursor } from "./cursor.js";
import { ElectronOverlayWindow } from "./electron-overlay-window.js";
import type { NativeOverlay } from "./native.js";
import type { OverlayWindowBridge } from "./overlay-window-bridge.js";
import type {
  AttachElectronOverlayWindowOptions,
  CreateElectronOverlayWindowOptions,
  ElectronOverlayWindowOptions,
  OverlayHotkey,
  OverlayProcessAttachResult,
  OverlayProcessTarget,
  OverlaySessionEventHandler,
  OverlaySessionEventMap,
  OverlaySessionEventName,
  Rect,
} from "./types.js";

export class OverlaySession {
  private readonly windowsById = new Map<string, ElectronOverlayWindow>();
  private readonly eventHandlers = new Map<
    OverlaySessionEventName,
    Set<OverlaySessionEventHandler<OverlaySessionEventName>>
  >();
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

  public readonly windows = {
    create: (options: CreateElectronOverlayWindowOptions) =>
      this.createWindow(options),
    attach: (
      window: Electron.BrowserWindow,
      options: AttachElectronOverlayWindowOptions = {}
    ) =>
      this.createWindow({
        ...options,
        existingWindow: window,
      }),
    get: (id: string) => this.getWindow(id),
  };

  private readonly windowBridge: OverlayWindowBridge = {
    registerWindow: (window) => this.registerWindow(window),
    unregisterWindow: (window) => this.unregisterWindow(window),
    removeWindow: (window) => this.removeWindow(window),
    syncWindowBounds: (window) => this.syncWindowBounds(window),
    sendFrame: (window, image) => this.sendFrame(window, image),
    sendCursor: (type) => this.sendCursor(type),
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
    });

    this.started = true;
  }

  public close() {
    if (this.closed) {
      return;
    }

    this.emitQuit();

    for (const window of Array.from(this.windowsById.values())) {
      window.destroy();
    }
    this.windowsById.clear();

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

  public on<Event extends OverlaySessionEventName>(
    event: Event,
    handler: OverlaySessionEventHandler<Event>
  ) {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }

    handlers.add(
      handler as OverlaySessionEventHandler<OverlaySessionEventName>
    );

    return () => {
      handlers.delete(
        handler as OverlaySessionEventHandler<OverlaySessionEventName>
      );
    };
  }

  public attachToProcess(target: OverlayProcessTarget) {
    this.ensureStarted();
    if ("pid" in target) {
      return this.injectProcessByPid(target.pid, target.includeMinimized);
    }

    return this.injectProcessByTitle(target.title, target.includeMinimized);
  }

  private createWindow(options: ElectronOverlayWindowOptions) {
    this.ensureStarted();
    const overlayWindow = new ElectronOverlayWindow(this.windowBridge, options);
    this.windowsById.set(overlayWindow.id, overlayWindow);
    return overlayWindow;
  }

  private getWindow(id: string) {
    return this.windowsById.get(id) || null;
  }

  private injectProcessByTitle(
    title: string,
    includeMinimized = false
  ): OverlayProcessAttachResult[] {
    console.log(`--------------------\n try inject ${title}`);
    const results: OverlayProcessAttachResult[] = [];
    for (const window of this.overlay.getTopWindows(includeMinimized)) {
      if (window.title && window.title.indexOf(title) !== -1) {
        console.log(`--------------------\n injecting ${JSON.stringify(window)}`);
        results.push(this.overlay.injectProcess(window));
      }
    }
    return results;
  }

  private injectProcessByPid(
    pid: number,
    includeMinimized = false
  ): OverlayProcessAttachResult | null {
    const window = this.overlay
      .getTopWindows(includeMinimized)
      .find((candidate) => candidate.processId === pid);

    if (!window) {
      return null;
    }

    console.log(`--------------------\n injecting ${JSON.stringify(window)}`);
    return this.overlay.injectProcess(window);
  }

  private setInputIntercept(intercept: boolean) {
    this.ensureStarted();
    this.overlay.sendCommand({
      command: "input.intercept",
      intercept,
    });
  }

  private registerWindow(window: ElectronOverlayWindow) {
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

  private unregisterWindow(window: ElectronOverlayWindow) {
    this.overlay.closeWindow(window.nativeId);
  }

  private removeWindow(window: ElectronOverlayWindow) {
    this.windowsById.delete(window.id);
  }

  private syncWindowBounds(window: ElectronOverlayWindow) {
    this.ensureStarted();
    this.overlay.sendWindowBounds(window.nativeId, {
      rect: this.getScaledBounds(window.browserWindow),
    });
  }

  private sendFrame(
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

  private sendCursor(type: string) {
    this.ensureStarted();
    this.overlay.sendCommand({
      command: "cursor",
      cursor: toNativeCursor(type),
    });
  }

  private forwardGameInput(payload: any) {
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
    this.emitEvent("nativeEvent", {
      event,
      payload,
    });

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
      this.emitEvent("windowFocused", {
        windowId: payload.focusWindowId,
      });
    } else if (event === "graphics.fps") {
      this.emitEvent("fps", {
        fps: payload.fps,
      });
    } else if (event === "game.hotkey.down") {
      this.emitEvent("hotkeyDown", {
        name: payload.name,
      });
    }
  }

  private emitEvent<Event extends OverlaySessionEventName>(
    event: Event,
    payload: OverlaySessionEventMap[Event]
  ) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(payload);
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
