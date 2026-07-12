import { BrowserWindow, screen } from 'electron';
import { physicalInputToDip } from './coordinate-space.js';
import { toNativeCursor } from './cursor.js';
import { ElectronOverlayWindow } from './electron-overlay-window.js';
import {
  createProcessInjectionUnavailableError,
  type NativeOverlay,
} from './native.js';
import type { OverlayWindowBridge } from './overlay-window-bridge.js';
import { getWindowContentBounds } from './window-content-bounds.js';
import {
  armAmbiguousPaintBarrier,
  createWindowScaleState,
  expectedWindowFrameSize,
  getPhysicalWindowGeometry,
  reconcileWindowFrame,
  reconcileWindowScale,
  resetAmbiguousPaintBarrier,
  resolveInputScaleFactor,
  sameWindowGeometry,
  scaleFactorToMicros,
  type WindowGeometry,
  type WindowFrameReconciliation,
  type WindowDisplayScale,
  type WindowScaleState,
} from './window-scale-state.js';
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
} from './types.js';

export class OverlaySession {
  private readonly windowsById = new Map<string, ElectronOverlayWindow>();
  private readonly windowsByNativeId = new Map<number, ElectronOverlayWindow>();
  private readonly windowScaleStates = new Map<number, WindowScaleState>();
  private readonly publishedWindowGeometry = new Map<number, WindowGeometry>();
  private readonly unmatchedFrameDiagnostics = new Map<number, string>();
  private readonly ambiguousCaptureTokens = new Map<number, symbol>();
  private readonly ambiguousCaptureRetryTasks = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private readonly eventHandlers = new Map<
    OverlaySessionEventName,
    Set<OverlaySessionEventHandler<OverlaySessionEventName>>
  >();
  private readonly quitHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  private screenEventsBound = false;
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
      options: AttachElectronOverlayWindowOptions = {},
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
    syncWindowGeometry: (window) => this.syncWindowGeometry(window),
    sendFrame: (window, image) => this.sendFrame(window, image),
    sendCursor: (type) => this.sendCursor(type),
  };

  private readonly handleDisplayAdded = () => {
    this.reconcileAllWindowScales();
  };

  private readonly handleDisplayRemoved = () => {
    this.reconcileAllWindowScales();
  };

  private readonly handleDisplayMetricsChanged = () => {
    this.reconcileAllWindowScales();
  };

  constructor(private readonly overlay: NativeOverlay) {}

  public start() {
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    if (this.started) {
      return;
    }

    this.overlay.start();
    this.overlay.setEventCallback((event: string, payload: any) => {
      this.handleEvent(event, payload);
    });

    this.started = true;
    this.bindScreenEvents();
  }

  /** Resolves after the authenticated hudhook rendezvous is ready for a payload. */
  public whenReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('the overlay session is closed'));
    }
    this.ensureStarted();
    return this.overlay.whenReady().then(() => undefined);
  }

  public close() {
    if (this.closed) {
      return;
    }

    this.emitQuit();
    this.unbindScreenEvents();

    for (const window of Array.from(this.windowsById.values())) {
      window.destroy();
    }
    this.windowsById.clear();
    this.windowsByNativeId.clear();
    this.windowScaleStates.clear();
    this.publishedWindowGeometry.clear();
    this.unmatchedFrameDiagnostics.clear();
    this.ambiguousCaptureTokens.clear();
    for (const retry of this.ambiguousCaptureRetryTasks.values()) {
      clearTimeout(retry);
    }
    this.ambiguousCaptureRetryTasks.clear();

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
    handler: OverlaySessionEventHandler<Event>,
  ) {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }

    handlers.add(
      handler as OverlaySessionEventHandler<OverlaySessionEventName>,
    );

    return () => {
      handlers.delete(
        handler as OverlaySessionEventHandler<OverlaySessionEventName>,
      );
    };
  }

  /** @deprecated Hudhook payload discovery and launch are application-owned. */
  public attachToProcess(
    target: OverlayProcessTarget,
  ): OverlayProcessAttachResult | OverlayProcessAttachResult[] | null {
    void target;
    throw createProcessInjectionUnavailableError();
  }

  private createWindow(options: ElectronOverlayWindowOptions) {
    this.ensureStarted();
    const overlayWindow = new ElectronOverlayWindow(this.windowBridge, options);
    this.windowsById.set(overlayWindow.id, overlayWindow);
    this.windowsByNativeId.set(overlayWindow.nativeId, overlayWindow);
    return overlayWindow;
  }

  private getWindow(id: string) {
    return this.windowsById.get(id) || null;
  }

  private setInputIntercept(intercept: boolean) {
    this.ensureStarted();
    this.overlay.sendCommand({
      command: 'input.intercept',
      intercept,
    });
  }

  private registerWindow(window: ElectronOverlayWindow) {
    this.ensureStarted();
    const browserWindow = window.browserWindow;
    const rasterBounds = getWindowContentBounds(browserWindow);
    const display = this.getWindowDisplayScale(rasterBounds);
    const state = createWindowScaleState(display, rasterBounds);
    const geometry = this.getWindowGeometry(window, state);
    this.windowScaleStates.set(window.nativeId, state);
    this.publishedWindowGeometry.set(window.nativeId, geometry);
    this.unmatchedFrameDiagnostics.delete(window.nativeId);

    this.overlay.addWindow(browserWindow.id, {
      name: window.name,
      transparent: window.transparent,
      resizable: browserWindow.isResizable(),
      nativeHandle: browserWindow.getNativeWindowHandle().readUInt32LE(0),
      ...geometry,
    });
  }

  private unregisterWindow(window: ElectronOverlayWindow) {
    this.cancelAmbiguousCapture(window);
    this.overlay.closeWindow(window.nativeId);
    this.windowScaleStates.delete(window.nativeId);
    this.publishedWindowGeometry.delete(window.nativeId);
    this.unmatchedFrameDiagnostics.delete(window.nativeId);
  }

  private removeWindow(window: ElectronOverlayWindow) {
    this.cancelAmbiguousCapture(window);
    this.windowsById.delete(window.id);
    this.windowsByNativeId.delete(window.nativeId);
    this.windowScaleStates.delete(window.nativeId);
    this.publishedWindowGeometry.delete(window.nativeId);
    this.unmatchedFrameDiagnostics.delete(window.nativeId);
  }

  private syncWindowGeometry(window: ElectronOverlayWindow) {
    this.ensureStarted();
    if (window.browserWindow.isDestroyed()) {
      return;
    }

    const rasterBounds = getWindowContentBounds(window.browserWindow);
    const desiredDisplay = this.getWindowDisplayScale(rasterBounds);
    const current =
      this.windowScaleStates.get(window.nativeId) ||
      createWindowScaleState(desiredDisplay, rasterBounds);
    const reconciliation = reconcileWindowScale(
      current,
      desiredDisplay,
      rasterBounds,
    );
    if (reconciliation.desiredRasterChanged) {
      this.cancelAmbiguousCapture(window);
    }
    this.windowScaleStates.set(window.nativeId, reconciliation.state);
    this.publishWindowGeometry(window, reconciliation.state);

    if (reconciliation.shouldInvalidate) {
      window.browserWindow.webContents.invalidate();
    }
  }

  private sendFrame(
    window: ElectronOverlayWindow,
    image: Electron.NativeImage,
  ) {
    if (this.quitting || !window.visible) {
      return;
    }

    let current = this.windowScaleStates.get(window.nativeId);
    if (!current) {
      return;
    }

    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) {
      return;
    }
    let reconciliation = reconcileWindowFrame(current, size);
    if (!reconciliation.accepted && reconciliation.reason === 'unmatched') {
      // A paint can overtake Electron's move/display notifications. Refresh the
      // desired display once before classifying the bitmap as stale.
      this.syncWindowGeometry(window);
      current = this.windowScaleStates.get(window.nativeId);
      if (!current) {
        return;
      }
      reconciliation = reconcileWindowFrame(current, size);
    }
    if (!reconciliation.accepted) {
      this.windowScaleStates.set(window.nativeId, reconciliation.state);
      if (reconciliation.recovery === 'begin-capture') {
        this.beginAmbiguousCapture(window);
      }
      this.logUnmatchedFrame(window, size, reconciliation);
      return;
    }

    this.unmatchedFrameDiagnostics.delete(window.nativeId);
    this.windowScaleStates.set(window.nativeId, reconciliation.state);
    if (reconciliation.rasterChanged) {
      console.log(
        `Electron overlay raster committed for window ${window.nativeId}: ` +
          `display ${reconciliation.state.activeDisplay.id}, ` +
          `scale ${reconciliation.scaleFactor}, frame ${size.width}x${size.height}`,
      );
    }
    this.publishWindowGeometry(
      window,
      reconciliation.state,
      reconciliation.rasterChanged,
    );

    this.overlay.sendFrameBuffer(
      window.nativeId,
      image.getBitmap(),
      size.width,
      size.height,
    );
  }

  private sendCursor(type: string) {
    this.ensureStarted();
    this.overlay.sendCommand({
      command: 'cursor',
      cursor: toNativeCursor(type),
    });
  }

  private forwardGameInput(payload: any) {
    const overlayWindow = this.windowsByNativeId.get(payload.windowId);
    const scaleState = this.windowScaleStates.get(payload.windowId);
    if (!overlayWindow || !overlayWindow.visible || !scaleState) {
      return;
    }
    const window = overlayWindow.browserWindow;

    const inputEvent = this.overlay.translateInputEvent(payload);
    if (!inputEvent) {
      return;
    }

    const inputScaleFactor = resolveInputScaleFactor(
      payload.scaleFactorMicros,
      scaleState.activeDisplay.scaleFactor,
    );
    if ('x' in inputEvent) {
      inputEvent.x = physicalInputToDip(inputEvent.x, inputScaleFactor);
    }
    if ('y' in inputEvent) {
      inputEvent.y = physicalInputToDip(inputEvent.y, inputScaleFactor);
    }

    window.webContents.sendInputEvent(inputEvent);
  }

  private handleEvent(event: string, payload: any) {
    this.emitEvent('nativeEvent', {
      event,
      payload,
    });

    if (event === 'game.input') {
      this.forwardGameInput(payload);
    } else if (event === 'game.window.focused') {
      console.log('focusWindowId', payload.focusWindowId);

      BrowserWindow.getAllWindows().forEach((window) => {
        window.blurWebView();
      });

      const focusWin = BrowserWindow.fromId(payload.focusWindowId);
      if (focusWin) {
        focusWin.focusOnWebView();
      }
      this.emitEvent('windowFocused', {
        windowId: payload.focusWindowId,
      });
    } else if (event === 'graphics.fps') {
      this.emitEvent('fps', {
        fps: payload.fps,
      });
    } else if (event === 'game.hotkey.down') {
      this.emitEvent('hotkeyDown', {
        name: payload.name,
      });
    }
  }

  private emitEvent<Event extends OverlaySessionEventName>(
    event: Event,
    payload: OverlaySessionEventMap[Event],
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

  private bindScreenEvents() {
    if (this.screenEventsBound) {
      return;
    }

    screen.on('display-added', this.handleDisplayAdded);
    screen.on('display-removed', this.handleDisplayRemoved);
    screen.on('display-metrics-changed', this.handleDisplayMetricsChanged);
    this.screenEventsBound = true;
  }

  private unbindScreenEvents() {
    if (!this.screenEventsBound) {
      return;
    }

    screen.removeListener('display-added', this.handleDisplayAdded);
    screen.removeListener('display-removed', this.handleDisplayRemoved);
    screen.removeListener(
      'display-metrics-changed',
      this.handleDisplayMetricsChanged,
    );
    this.screenEventsBound = false;
  }

  private reconcileAllWindowScales() {
    if (!this.started || this.quitting) {
      return;
    }

    for (const window of this.windowsById.values()) {
      if (!window.visible || window.browserWindow.isDestroyed()) {
        continue;
      }

      try {
        this.syncWindowGeometry(window);
      } catch (error) {
        console.warn(
          `Cannot reconcile Electron overlay display state for window ${window.nativeId}`,
          error,
        );
      }
    }
  }

  private getWindowDisplayScale(browserBounds: Rect): WindowDisplayScale {
    const display = screen.getDisplayMatching(browserBounds);
    const scaleFactor =
      Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
        ? display.scaleFactor
        : 1;

    return {
      id: display.id,
      scaleFactor,
      width: display.bounds.width,
      height: display.bounds.height,
    };
  }

  private getWindowGeometry(
    window: ElectronOverlayWindow,
    state: WindowScaleState,
  ): WindowGeometry {
    return getPhysicalWindowGeometry(
      state.activeRasterBounds,
      state.activeDisplay,
      {
        resizable: window.browserWindow.isResizable(),
        dragBorder: window.dragBorder,
        captionHeight: window.captionHeight,
      },
      state.activeFrameSize,
    );
  }

  private publishWindowGeometry(
    window: ElectronOverlayWindow,
    state: WindowScaleState,
    rasterChanged = false,
  ) {
    const geometry = this.getWindowGeometry(window, state);
    const published = this.publishedWindowGeometry.get(window.nativeId);
    if (
      !rasterChanged &&
      published &&
      sameWindowGeometry(published, geometry)
    ) {
      return;
    }

    this.overlay.sendWindowBounds(
      window.nativeId,
      rasterChanged ? { ...geometry, rasterChanged: true } : geometry,
    );
    this.publishedWindowGeometry.set(window.nativeId, geometry);
  }

  private beginAmbiguousCapture(window: ElectronOverlayWindow) {
    if (this.ambiguousCaptureTokens.has(window.nativeId)) {
      return;
    }

    const pendingRetry = this.ambiguousCaptureRetryTasks.get(window.nativeId);
    if (pendingRetry) {
      clearTimeout(pendingRetry);
      this.ambiguousCaptureRetryTasks.delete(window.nativeId);
    }

    const state = this.windowScaleStates.get(window.nativeId);
    if (!state || state.ambiguousPaintBarrier !== 'capturing') {
      return;
    }

    const token = Symbol(`ambiguous-capture-${window.nativeId}`);
    const desiredRaster = getDesiredRasterSnapshot(state);
    this.ambiguousCaptureTokens.set(window.nativeId, token);
    void this.captureDesiredRaster(window, token, desiredRaster);
  }

  private async captureDesiredRaster(
    window: ElectronOverlayWindow,
    token: symbol,
    desiredRaster: DesiredRasterSnapshot,
  ) {
    const webContents = window.browserWindow.webContents;
    try {
      const rendererReady = await this.waitForRendererRaster(
        window,
        token,
        desiredRaster,
      );
      if (!this.isCurrentAmbiguousCapture(window, token, desiredRaster)) {
        return;
      }
      if (!rendererReady) {
        this.scheduleAmbiguousCaptureRetry(window, token, desiredRaster);
        return;
      }

      // This capture request is issued after the renderer acknowledged the
      // desired DPR and viewport, establishing a causal frame boundary.
      const image = await webContents.capturePage({
        x: 0,
        y: 0,
        width: desiredRaster.bounds.width,
        height: desiredRaster.bounds.height,
      });
      if (!this.isCurrentAmbiguousCapture(window, token, desiredRaster)) {
        return;
      }

      const expectedSize = expectedWindowFrameSize(
        desiredRaster.bounds,
        desiredRaster.scaleFactor,
      );
      const capturedSize = image.getSize();
      if (!frameSizeWithinTolerance(capturedSize, expectedSize)) {
        console.warn(
          `Cannot recover ambiguous Electron overlay raster for window ${window.nativeId}: ` +
            `capture ${capturedSize.width}x${capturedSize.height}, ` +
            `expected approximately ${expectedSize.width}x${expectedSize.height}`,
        );
        this.scheduleAmbiguousCaptureRetry(window, token, desiredRaster);
        return;
      }

      const state = this.windowScaleStates.get(window.nativeId);
      if (!state) {
        return;
      }
      this.windowScaleStates.set(
        window.nativeId,
        armAmbiguousPaintBarrier(state),
      );
      this.ambiguousCaptureTokens.delete(window.nativeId);
      this.sendFrame(window, image);
    } catch (error) {
      if (this.ambiguousCaptureTokens.get(window.nativeId) === token) {
        console.warn(
          `Cannot recover ambiguous Electron overlay raster for window ${window.nativeId}`,
          error,
        );
        this.scheduleAmbiguousCaptureRetry(window, token, desiredRaster);
      }
    } finally {
      if (this.ambiguousCaptureTokens.get(window.nativeId) === token) {
        this.ambiguousCaptureTokens.delete(window.nativeId);
      }
    }
  }

  private async waitForRendererRaster(
    window: ElectronOverlayWindow,
    token: symbol,
    desiredRaster: DesiredRasterSnapshot,
  ) {
    const deadline = Date.now() + 2_000;
    while (this.isCurrentAmbiguousCapture(window, token, desiredRaster)) {
      const renderer =
        (await window.browserWindow.webContents.executeJavaScript(
          '({ dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight })',
        )) as RendererRasterSnapshot;
      if (rendererMatchesDesiredRaster(renderer, desiredRaster)) {
        return true;
      }
      if (Date.now() >= deadline) {
        console.warn(
          `Renderer did not acknowledge the desired Electron overlay raster for window ${window.nativeId}`,
        );
        return false;
      }

      await waitForDelay(16);
    }

    return false;
  }

  private scheduleAmbiguousCaptureRetry(
    window: ElectronOverlayWindow,
    token: symbol,
    desiredRaster: DesiredRasterSnapshot,
  ) {
    if (
      this.ambiguousCaptureTokens.get(window.nativeId) !== token ||
      this.ambiguousCaptureRetryTasks.has(window.nativeId)
    ) {
      return;
    }

    this.ambiguousCaptureTokens.delete(window.nativeId);
    const retry = setTimeout(() => {
      this.ambiguousCaptureRetryTasks.delete(window.nativeId);
      if (
        !window.visible ||
        window.browserWindow.isDestroyed() ||
        window.browserWindow.webContents.isDestroyed()
      ) {
        return;
      }

      const state = this.windowScaleStates.get(window.nativeId);
      if (
        !state ||
        state.ambiguousPaintBarrier !== 'capturing' ||
        !sameDesiredRasterSnapshot(state, desiredRaster)
      ) {
        return;
      }

      this.windowScaleStates.set(
        window.nativeId,
        resetAmbiguousPaintBarrier(state),
      );
      window.browserWindow.webContents.invalidate();
    }, 250);
    this.ambiguousCaptureRetryTasks.set(window.nativeId, retry);
  }

  private isCurrentAmbiguousCapture(
    window: ElectronOverlayWindow,
    token: symbol,
    desiredRaster: DesiredRasterSnapshot,
  ) {
    if (
      this.ambiguousCaptureTokens.get(window.nativeId) !== token ||
      !window.visible ||
      window.browserWindow.isDestroyed()
    ) {
      return false;
    }

    const state = this.windowScaleStates.get(window.nativeId);
    return (
      !!state &&
      state.ambiguousPaintBarrier === 'capturing' &&
      sameDesiredRasterSnapshot(state, desiredRaster)
    );
  }

  private cancelAmbiguousCapture(window: ElectronOverlayWindow) {
    this.ambiguousCaptureTokens.delete(window.nativeId);
    const retry = this.ambiguousCaptureRetryTasks.get(window.nativeId);
    if (retry) {
      clearTimeout(retry);
      this.ambiguousCaptureRetryTasks.delete(window.nativeId);
    }
  }

  private logUnmatchedFrame(
    window: ElectronOverlayWindow,
    size: Electron.Size,
    reconciliation: Extract<WindowFrameReconciliation, { accepted: false }>,
  ) {
    const diagnostic = [
      size.width,
      size.height,
      reconciliation.activeSize.width,
      reconciliation.activeSize.height,
      reconciliation.desiredSize.width,
      reconciliation.desiredSize.height,
      reconciliation.reason,
    ].join(':');
    if (this.unmatchedFrameDiagnostics.get(window.nativeId) === diagnostic) {
      return;
    }

    this.unmatchedFrameDiagnostics.set(window.nativeId, diagnostic);
    console.warn(
      `Suppressing ${reconciliation.reason} Electron overlay frame for window ${window.nativeId}: ` +
        `received ${size.width}x${size.height}, ` +
        `active ${reconciliation.activeSize.width}x${reconciliation.activeSize.height}, ` +
        `desired ${reconciliation.desiredSize.width}x${reconciliation.desiredSize.height}`,
    );
  }

  private ensureStarted() {
    if (!this.started) {
      this.start();
    }
  }
}

type DesiredRasterSnapshot = {
  scaleFactor: number;
  scaleFactorMicros: number;
  bounds: Rect;
};

type RendererRasterSnapshot = {
  dpr: number;
  width: number;
  height: number;
};

function getDesiredRasterSnapshot(
  state: WindowScaleState,
): DesiredRasterSnapshot {
  return {
    scaleFactor: state.desiredDisplay.scaleFactor,
    scaleFactorMicros: scaleFactorToMicros(state.desiredDisplay.scaleFactor),
    bounds: { ...state.desiredRasterBounds },
  };
}

function sameDesiredRasterSnapshot(
  state: WindowScaleState,
  snapshot: DesiredRasterSnapshot,
) {
  return (
    scaleFactorToMicros(state.desiredDisplay.scaleFactor) ===
      snapshot.scaleFactorMicros &&
    state.desiredRasterBounds.width === snapshot.bounds.width &&
    state.desiredRasterBounds.height === snapshot.bounds.height
  );
}

function rendererMatchesDesiredRaster(
  renderer: RendererRasterSnapshot,
  desired: DesiredRasterSnapshot,
) {
  return (
    Number.isFinite(renderer.dpr) &&
    Number.isFinite(renderer.width) &&
    Number.isFinite(renderer.height) &&
    scaleFactorToMicros(renderer.dpr) === desired.scaleFactorMicros &&
    Math.abs(renderer.width - desired.bounds.width) <= 2 &&
    Math.abs(renderer.height - desired.bounds.height) <= 2
  );
}

function waitForDelay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function frameSizeWithinTolerance(
  actual: Electron.Size,
  expected: Electron.Size,
) {
  return (
    Number.isSafeInteger(actual.width) &&
    Number.isSafeInteger(actual.height) &&
    actual.width > 0 &&
    actual.height > 0 &&
    Math.abs(actual.width - expected.width) <= 1 &&
    Math.abs(actual.height - expected.height) <= 1
  );
}
