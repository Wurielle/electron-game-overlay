import { screen } from 'electron';
import { physicalInputToDip } from './coordinate-space.js';
import {
  normalizeOverlayDiagnosticErrorCode,
  parseOverlayDiagnostic,
} from './diagnostic.js';
import {
  createElectronOverlayWindow,
  ElectronOverlayWindow,
} from './electron-overlay-window.js';
import type {
  NativeOverlay,
  NativeRuntimeProviderMetadata,
  NativeTargetAuthorization,
  NativeTargetAuthorizationDisposition,
  NativeTargetConnection,
} from './native.js';
import type { OverlayWindowBridge } from './overlay-window-bridge.js';
import {
  getTargetFollowPhysicalBounds,
  normalizeTargetFollowOptions,
  parseOverlayGraphicsFps,
  parseOverlayTargetSurface,
  parseOverlayTargetSurfaceRemoved,
  selectTargetSurface,
  targetSurfaceKey,
} from './target-surface.js';
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
  ElectronOverlayWindowFollowTargetOptions,
  ElectronOverlayWindowOptions,
  OverlayDiagnostic,
  OverlayDiagnosticContextValue,
  OverlaySessionEventHandler,
  OverlaySessionEventMap,
  OverlaySessionEventName,
  OverlayTargetSurface,
  Disposable,
  Rect,
} from './types.js';

const MAX_PENDING_PRODUCER_DIAGNOSTICS = 32;
const PRODUCER_DIAGNOSTIC_COOLDOWN_MS = 7_500;

type ProducerDiagnosticCode =
  | 'producer-window-registered'
  | 'producer-window-publication-failed'
  | 'producer-frame-publication-started'
  | 'producer-frame-rejected'
  | 'producer-frame-publication-failed'
  | 'producer-input-forwarding-failed';

type OverlayScreen = Pick<
  typeof screen,
  'getDisplayMatching' | 'on' | 'removeListener' | 'screenToDipRect'
>;

const OVERLAY_SESSION_CONSTRUCTION_TOKEN = Symbol(
  'OverlaySession construction token',
);

/** @internal */
export type OverlaySessionTargetAuthorization = Disposable &
  Readonly<{
    disposition: NativeTargetAuthorizationDisposition;
    target?: NativeTargetConnection;
  }>;

type TargetAuthorizer = (
  pid: number,
  discoveryPath: string,
  expectedExecutablePath?: string,
  runtimeProvider?: NativeRuntimeProviderMetadata,
  signal?: AbortSignal,
) => Promise<Disposable | OverlaySessionTargetAuthorization>;
type GlobalTargetAuthorizer = () => Promise<Disposable>;

let constructOverlaySession:
  ((overlay: NativeOverlay) => OverlaySession) | undefined;
const targetAuthorizers = new WeakMap<OverlaySession, TargetAuthorizer>();
const globalTargetAuthorizers = new WeakMap<
  OverlaySession,
  GlobalTargetAuthorizer
>();

/** @internal */
export function createOverlaySession(overlay: NativeOverlay): OverlaySession {
  if (!constructOverlaySession) {
    throw new Error('OverlaySession construction is not initialized');
  }
  return constructOverlaySession(overlay);
}

/** @internal */
export async function authorizeOverlaySessionTarget(
  session: OverlaySession,
  pid: number,
  discoveryPath: string,
  expectedExecutablePath?: string,
  runtimeProvider?: NativeRuntimeProviderMetadata,
  signal?: AbortSignal,
): Promise<OverlaySessionTargetAuthorization> {
  const testHarness = session as unknown as {
    authorizeTarget?: TargetAuthorizer;
  };
  const authorizeTarget =
    targetAuthorizers.get(session) ??
    (typeof testHarness.authorizeTarget === 'function'
      ? testHarness.authorizeTarget.bind(session)
      : undefined);
  if (!authorizeTarget) {
    throw new TypeError('invalid OverlaySession instance');
  }
  return normalizeSessionTargetAuthorization(
    await authorizeTarget(
      pid,
      discoveryPath,
      expectedExecutablePath,
      runtimeProvider,
      signal,
    ),
  );
}

/** @internal */
export async function authorizeOverlaySessionGlobalTarget(
  session: OverlaySession,
): Promise<Disposable> {
  const testHarness = session as unknown as {
    authorizeGlobalTarget?: GlobalTargetAuthorizer;
  };
  const authorizeTarget =
    globalTargetAuthorizers.get(session) ??
    (typeof testHarness.authorizeGlobalTarget === 'function'
      ? testHarness.authorizeGlobalTarget.bind(session)
      : undefined);
  if (!authorizeTarget) {
    throw new TypeError('invalid OverlaySession instance');
  }
  return authorizeTarget();
}

function createSessionTargetAuthorization(
  release: Disposable,
  disposition: NativeTargetAuthorizationDisposition,
  target?: NativeTargetConnection,
): OverlaySessionTargetAuthorization {
  return Object.assign(release, {
    disposition,
    ...(target === undefined ? {} : { target }),
  });
}

function normalizeSessionTargetAuthorization(
  authorization: Disposable | NativeTargetAuthorization,
): OverlaySessionTargetAuthorization {
  if (typeof authorization === 'function') {
    const enriched =
      authorization as Partial<OverlaySessionTargetAuthorization>;
    return createSessionTargetAuthorization(
      authorization,
      enriched.disposition === 'joined-existing'
        ? 'joined-existing'
        : 'injection-owner',
      enriched.target,
    );
  }
  return createSessionTargetAuthorization(
    authorization.release,
    authorization.disposition,
    authorization.target,
  );
}

async function waitForAbortable<T>(
  operation: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return await operation;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([Promise.resolve(operation), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export class OverlaySession {
  static {
    constructOverlaySession = (overlay) =>
      new OverlaySession(OVERLAY_SESSION_CONSTRUCTION_TOKEN, overlay);
  }

  private readonly windowsById = new Map<string, ElectronOverlayWindow>();
  private readonly electronScreen: OverlayScreen = screen;
  private readonly windowsByNativeId = new Map<number, ElectronOverlayWindow>();
  private readonly windowScaleStates = new Map<number, WindowScaleState>();
  private readonly publishedWindowGeometry = new Map<number, WindowGeometry>();
  private readonly targetSurfaces = new Map<string, OverlayTargetSurface>();
  private readonly targetExecutablePaths = new Map<number, string>();
  private readonly targetFollowOptions = new Map<
    number,
    ElectronOverlayWindowFollowTargetOptions
  >();
  private readonly targetFollowRestoreBounds = new Map<number, Rect>();
  private readonly unmatchedFrameDiagnostics = new Map<number, string>();
  private readonly producerFramePublicationStarted = new Set<number>();
  private readonly producerDiagnosticPublicationTimes = new Map<
    string,
    number
  >();
  private readonly pendingProducerDiagnostics: OverlayDiagnostic[] = [];
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
  private readonly targetAuthorizationReleases = new Set<Disposable>();
  private screenEventsBound = false;
  private producerDiagnosticFlushScheduled = false;
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

  public readonly targets = {
    list: (): readonly OverlayTargetSurface[] =>
      Object.freeze(Array.from(this.targetSurfaces.values())),
    get: (pid: number, surfaceId: string): OverlayTargetSurface | null =>
      this.targetSurfaces.get(targetSurfaceKey(pid, surfaceId)) ?? null,
  };

  private readonly windowBridge: OverlayWindowBridge = {
    registerWindow: (window) => this.registerWindow(window),
    unregisterWindow: (window) => this.unregisterWindow(window),
    removeWindow: (window) => this.removeWindow(window),
    syncWindowGeometry: (window) => this.handleWindowGeometryChanged(window),
    followTarget: (window, options) => this.followWindowTarget(window, options),
    stopFollowingTarget: (window) => this.stopWindowFollowingTarget(window),
    sendFrame: (window, image) => this.sendFrame(window, image),
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

  private constructor(
    constructionToken: symbol,
    private readonly overlay: NativeOverlay,
  ) {
    if (constructionToken !== OVERLAY_SESSION_CONSTRUCTION_TOKEN) {
      throw new TypeError(
        'OverlaySession instances are created by ElectronGameOverlay.createSession()',
      );
    }
    targetAuthorizers.set(
      this,
      (pid, discoveryPath, expectedExecutablePath, runtimeProvider, signal) =>
        this.#authorizeTarget(
          pid,
          discoveryPath,
          expectedExecutablePath,
          runtimeProvider,
          signal,
        ),
    );
    globalTargetAuthorizers.set(this, () => this.#authorizeGlobalTarget());
  }

  public start() {
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    if (this.quitting) {
      throw new Error('the overlay session is closing');
    }
    if (this.started) {
      return;
    }

    this.started = true;
    let backendStartAttempted = false;
    try {
      this.overlay.setEventCallback((event: string, payload: unknown) => {
        this.handleEvent(event, payload);
      });
      this.overlay.setDiagnosticCallback?.((diagnostic: unknown) => {
        this.handleDiagnostic(diagnostic);
      });
      if (this.closed || !this.started) {
        return;
      }
      backendStartAttempted = true;
      this.overlay.start();
      if (this.closed || !this.started) {
        return;
      }
      this.bindScreenEvents();
    } catch (error) {
      this.started = false;
      try {
        this.unbindScreenEvents();
      } catch (cleanupError) {
        console.error(
          'Unable to remove Electron screen listeners after overlay startup failed',
          cleanupError,
        );
      }
      if (backendStartAttempted && !this.closed) {
        try {
          this.overlay.stop();
        } catch (cleanupError) {
          console.error(
            'Unable to stop the overlay backend after startup failed',
            cleanupError,
          );
        }
      }
      throw error;
    }
  }

  /** Resolves after the authenticated overlay transport is ready for a runtime. */
  public whenReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('the overlay session is closed'));
    }
    this.ensureStarted();
    return this.overlay.whenReady().then(() => undefined);
  }

  async #authorizeTarget(
    pid: number,
    discoveryPath: string,
    expectedExecutablePath?: string,
    runtimeProvider?: NativeRuntimeProviderMetadata,
    signal?: AbortSignal,
  ): Promise<OverlaySessionTargetAuthorization> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
      throw new RangeError(
        'the overlay target PID must be a positive uint32 integer',
      );
    }
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    signal?.throwIfAborted();
    if (typeof discoveryPath !== 'string' || discoveryPath.length === 0) {
      throw new TypeError(
        'the overlay target discovery path must be a non-empty string',
      );
    }
    if (
      expectedExecutablePath !== undefined &&
      (typeof expectedExecutablePath !== 'string' ||
        expectedExecutablePath.length === 0 ||
        expectedExecutablePath.includes('\0'))
    ) {
      throw new TypeError(
        'the expected overlay target executable path must be a non-empty string without NUL characters',
      );
    }

    this.ensureStarted();
    await waitForAbortable(this.overlay.whenReady(), signal);
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    signal?.throwIfAborted();

    const backendAuthorization = await this.overlay.authorizeTarget?.(
      pid,
      discoveryPath,
      expectedExecutablePath,
      runtimeProvider,
      signal,
    );
    if (!backendAuthorization) {
      if (this.closed) {
        throw new Error('the overlay session is closed');
      }
      return createSessionTargetAuthorization(
        () => undefined,
        'injection-owner',
      );
    }
    const normalized =
      normalizeSessionTargetAuthorization(backendAuthorization);
    if (signal?.aborted) {
      normalized();
      signal.throwIfAborted();
    }
    if (this.closed) {
      normalized();
      throw new Error('the overlay session is closed');
    }

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.targetAuthorizationReleases.delete(release);
      normalized();
    };
    this.targetAuthorizationReleases.add(release);
    return createSessionTargetAuthorization(
      release,
      normalized.disposition,
      normalized.target,
    );
  }

  async #authorizeGlobalTarget(): Promise<Disposable> {
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    this.ensureStarted();
    await this.overlay.whenReady();
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    const backendRelease = await this.overlay.authorizeGlobalTarget?.();
    if (!backendRelease) {
      return () => undefined;
    }
    if (this.closed) {
      backendRelease();
      throw new Error('the overlay session is closed');
    }
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.targetAuthorizationReleases.delete(release);
      backendRelease();
    };
    this.targetAuthorizationReleases.add(release);
    return release;
  }

  public close() {
    if (this.closed || this.quitting) {
      return;
    }

    this.emitQuit();
    try {
      this.unbindScreenEvents();
    } catch (error) {
      this.reportLifecycleCleanupFailure(
        'remove Electron screen listeners',
        error,
      );
    }

    for (const window of Array.from(this.windowsById.values())) {
      try {
        window.destroy();
      } catch (error) {
        this.reportLifecycleCleanupFailure(
          `destroy overlay window ${window.nativeId}`,
          error,
        );
      }
    }
    this.windowsById.clear();
    this.windowsByNativeId.clear();
    this.windowScaleStates.clear();
    this.publishedWindowGeometry.clear();
    this.targetSurfaces.clear();
    this.targetExecutablePaths.clear();
    this.targetFollowOptions.clear();
    this.targetFollowRestoreBounds.clear();
    this.unmatchedFrameDiagnostics.clear();
    this.producerFramePublicationStarted.clear();
    this.producerDiagnosticPublicationTimes.clear();
    this.pendingProducerDiagnostics.length = 0;
    this.producerDiagnosticFlushScheduled = false;
    this.ambiguousCaptureTokens.clear();
    for (const retry of this.ambiguousCaptureRetryTasks.values()) {
      clearTimeout(retry);
    }
    this.ambiguousCaptureRetryTasks.clear();

    for (const release of Array.from(this.targetAuthorizationReleases)) {
      try {
        release();
      } catch (error) {
        this.reportLifecycleCleanupFailure(
          'release an overlay target authorization',
          error,
        );
      }
    }
    this.targetAuthorizationReleases.clear();

    if (this.started) {
      try {
        this.overlay.stop();
      } catch (error) {
        this.reportLifecycleCleanupFailure('stop the overlay backend', error);
      } finally {
        this.started = false;
      }
    }

    this.closed = true;
    this.emitClose();
  }

  public onQuit(handler: () => void) {
    if (this.quitting) {
      this.invokeLifecycleHandler('quit', handler);
      return () => {};
    }

    this.quitHandlers.add(handler);

    return () => {
      this.quitHandlers.delete(handler);
    };
  }

  public onClose(handler: () => void) {
    if (this.closed) {
      this.invokeLifecycleHandler('close', handler);
      return () => {};
    }

    this.closeHandlers.add(handler);

    return () => {
      this.closeHandlers.delete(handler);
    };
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

  private createWindow(options: ElectronOverlayWindowOptions) {
    if (
      options.existingWindow &&
      !options.existingWindow.webContents.isOffscreen()
    ) {
      throw new TypeError(
        'an attached BrowserWindow must be created with webPreferences.offscreen: true',
      );
    }
    const requestedId = options.id || options.name;
    if (requestedId && this.windowsById.has(requestedId)) {
      throw new Error(
        `an overlay window with id "${requestedId}" already exists`,
      );
    }
    if (
      options.existingWindow &&
      this.windowsByNativeId.has(options.existingWindow.id)
    ) {
      throw new Error(
        `BrowserWindow ${options.existingWindow.id} is already attached to this overlay session`,
      );
    }
    this.ensureStarted();
    const overlayWindow = createElectronOverlayWindow(
      this.windowBridge,
      options,
    );
    if (
      this.windowsById.has(overlayWindow.id) ||
      this.windowsByNativeId.has(overlayWindow.nativeId)
    ) {
      overlayWindow.destroy();
      throw new Error(
        `overlay window ${overlayWindow.id} conflicts with an existing window in this session`,
      );
    }
    this.windowsById.set(overlayWindow.id, overlayWindow);
    this.windowsByNativeId.set(overlayWindow.nativeId, overlayWindow);
    return overlayWindow;
  }

  private getWindow(id: string) {
    return this.windowsById.get(id) || null;
  }

  private followWindowTarget(
    window: ElectronOverlayWindow,
    options: ElectronOverlayWindowFollowTargetOptions,
  ) {
    this.ensureStarted();
    const normalizedOptions = normalizeTargetFollowOptions(options);
    if (!this.targetFollowOptions.has(window.nativeId)) {
      this.targetFollowRestoreBounds.set(
        window.nativeId,
        getWindowContentBounds(window.browserWindow),
      );
    }
    this.targetFollowOptions.set(window.nativeId, normalizedOptions);
    this.applyTargetFollow(window);
  }

  private stopWindowFollowingTarget(window: ElectronOverlayWindow) {
    if (!this.targetFollowOptions.delete(window.nativeId)) {
      return;
    }
    const restoreBounds = this.targetFollowRestoreBounds.get(window.nativeId);
    this.targetFollowRestoreBounds.delete(window.nativeId);
    if (window.browserWindow.isDestroyed()) {
      return;
    }
    if (
      restoreBounds &&
      !sameRect(getWindowContentBounds(window.browserWindow), restoreBounds)
    ) {
      window.browserWindow.setContentBounds(restoreBounds, false);
    }
    if (window.visible && this.started) {
      this.syncWindowGeometry(window);
    }
  }

  private handleWindowGeometryChanged(window: ElectronOverlayWindow) {
    try {
      if (this.targetFollowOptions.has(window.nativeId)) {
        this.applyTargetFollow(window);
      } else {
        this.syncWindowGeometry(window);
      }
    } catch (error) {
      this.reportWindowBoundsFailure(window, error);
    }
  }

  private applyTargetFollow(window: ElectronOverlayWindow) {
    const options = this.targetFollowOptions.get(window.nativeId);
    if (!options || window.browserWindow.isDestroyed()) {
      return;
    }

    const surface = selectTargetSurface(
      Array.from(this.targetSurfaces.values()),
      options,
    );
    if (!surface) {
      return;
    }

    const physicalBounds = getTargetFollowPhysicalBounds(
      surface,
      options.area ?? 'render',
    );
    if (physicalBounds.width <= 0 || physicalBounds.height <= 0) {
      return;
    }

    const converted = this.electronScreen.screenToDipRect(null, physicalBounds);
    const targetBounds = {
      x: converted.x,
      y: converted.y,
      width: Math.max(1, converted.width),
      height: Math.max(1, converted.height),
    };
    const currentBounds = getWindowContentBounds(window.browserWindow);
    if (!sameRect(currentBounds, targetBounds)) {
      window.browserWindow.setContentBounds(targetBounds, false);
    }

    if (window.visible) {
      this.syncWindowGeometry(window);
    }
  }

  private reapplyTargetFollowers() {
    for (const window of this.windowsById.values()) {
      if (this.targetFollowOptions.has(window.nativeId)) {
        this.handleWindowGeometryChanged(window);
      }
    }
  }

  private setInputIntercept(intercept: boolean) {
    this.ensureStarted();
    this.overlay.setInputIntercept(intercept);
  }

  private registerWindow(window: ElectronOverlayWindow) {
    this.ensureStarted();
    try {
      this.applyTargetFollow(window);
      const browserWindow = window.browserWindow;
      const rasterBounds = getWindowContentBounds(browserWindow);
      const display = this.getWindowDisplayScale(rasterBounds);
      const state = createWindowScaleState(display, rasterBounds);
      const geometry = this.getWindowGeometry(window, state);

      this.overlay.addWindow(browserWindow.id, {
        name: window.name,
        transparent: window.transparent,
        ...geometry,
      });

      this.windowScaleStates.set(window.nativeId, state);
      this.publishedWindowGeometry.set(window.nativeId, geometry);
      this.unmatchedFrameDiagnostics.delete(window.nativeId);
      this.producerFramePublicationStarted.delete(window.nativeId);
      this.publishProducerDiagnostic('producer-window-registered', {
        windowId: window.nativeId,
      });
    } catch (error) {
      this.windowScaleStates.delete(window.nativeId);
      this.publishedWindowGeometry.delete(window.nativeId);
      this.unmatchedFrameDiagnostics.delete(window.nativeId);
      this.producerFramePublicationStarted.delete(window.nativeId);
      this.publishProducerFailure(
        'producer-window-publication-failed',
        {
          windowId: window.nativeId,
          operation: 'register',
        },
        error,
      );
      throw error;
    }
  }

  private unregisterWindow(window: ElectronOverlayWindow) {
    try {
      this.overlay.closeWindow(window.nativeId);
    } catch (error) {
      this.publishProducerFailure(
        'producer-window-publication-failed',
        {
          windowId: window.nativeId,
          operation: 'close',
        },
        error,
      );
      throw error;
    }
    this.cancelAmbiguousCapture(window);
    this.windowScaleStates.delete(window.nativeId);
    this.publishedWindowGeometry.delete(window.nativeId);
    this.unmatchedFrameDiagnostics.delete(window.nativeId);
    this.producerFramePublicationStarted.delete(window.nativeId);
  }

  private removeWindow(window: ElectronOverlayWindow) {
    this.cancelAmbiguousCapture(window);
    if (this.windowsById.get(window.id) === window) {
      this.windowsById.delete(window.id);
    }
    if (this.windowsByNativeId.get(window.nativeId) !== window) {
      return;
    }
    this.windowsByNativeId.delete(window.nativeId);
    this.windowScaleStates.delete(window.nativeId);
    this.publishedWindowGeometry.delete(window.nativeId);
    this.targetFollowOptions.delete(window.nativeId);
    this.targetFollowRestoreBounds.delete(window.nativeId);
    this.unmatchedFrameDiagnostics.delete(window.nativeId);
    this.producerFramePublicationStarted.delete(window.nativeId);
    this.clearProducerDiagnosticStateForWindow(window.nativeId);
  }

  private syncWindowGeometry(window: ElectronOverlayWindow) {
    this.ensureStarted();
    if (window.browserWindow.isDestroyed()) {
      return;
    }

    try {
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
      if (!this.publishWindowGeometry(window, reconciliation.state)) {
        return;
      }
      this.windowScaleStates.set(window.nativeId, reconciliation.state);

      if (reconciliation.shouldInvalidate) {
        try {
          window.browserWindow.webContents.invalidate();
        } catch (error) {
          // Bounds publication and scale-state commit already succeeded. Until
          // renderer invalidation has its own fixed diagnostic stage, keep
          // this local instead of misreporting a bounds transport failure.
          console.warn(
            `Cannot invalidate Electron overlay window ${window.nativeId} after a raster change`,
            error,
          );
        }
      }
    } catch (error) {
      this.reportWindowBoundsFailure(window, error);
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

    let size: Electron.Size;
    try {
      size = image.getSize();
    } catch (error) {
      this.reportFramePublicationFailure(window, 'bitmap', error);
      return;
    }
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

    let bitmap: Buffer;
    try {
      bitmap = image.toBitmap();
    } catch (error) {
      this.reportFramePublicationFailure(window, 'bitmap', error);
      return;
    }

    if (
      !this.publishWindowGeometry(
        window,
        reconciliation.state,
        reconciliation.rasterChanged,
      )
    ) {
      return;
    }

    this.unmatchedFrameDiagnostics.delete(window.nativeId);
    this.windowScaleStates.set(window.nativeId, reconciliation.state);

    try {
      const published = this.overlay.sendFrameBuffer(
        window.nativeId,
        bitmap,
        size.width,
        size.height,
      );
      if (published === false) {
        this.reportFramePublicationFailure(window, 'transport');
        return;
      }
    } catch (error) {
      this.reportFramePublicationFailure(window, 'transport', error);
      return;
    }

    if (!this.producerFramePublicationStarted.has(window.nativeId)) {
      this.producerFramePublicationStarted.add(window.nativeId);
      this.publishProducerDiagnostic('producer-frame-publication-started', {
        windowId: window.nativeId,
        width: size.width,
        height: size.height,
      });
    }
  }

  private forwardGameInput(payload: any) {
    let pid: unknown;
    let windowId = 0;
    let stage: 'translate' | 'focus' | 'dispatch' = 'translate';
    try {
      pid = payload?.pid;
      windowId = payload?.windowId;
      const overlayWindow = this.windowsByNativeId.get(windowId);
      const scaleState = this.windowScaleStates.get(windowId);
      if (!overlayWindow || !overlayWindow.visible || !scaleState) {
        return;
      }

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

      stage = 'focus';
      const webContents = this.focusInputWebContents(overlayWindow);
      if (!webContents) {
        return;
      }

      // Reassert Chromium page focus immediately before dispatch. Electron's
      // WebContents.focus() is a no-op for offscreen rendering, while this OSR
      // API focuses the render widget without activating a native window or
      // taking foreground ownership away from the game.
      stage = 'dispatch';
      webContents.sendInputEvent(inputEvent);
    } catch (error) {
      this.reportInputForwardingFailure(pid, windowId, stage, error);
    }
  }

  private focusInputWebContents(window: ElectronOverlayWindow) {
    const browserWindow = window.browserWindow;
    if (browserWindow.isDestroyed()) {
      return null;
    }
    const webContents = browserWindow.webContents;
    if (webContents.isDestroyed()) {
      return null;
    }

    browserWindow.focusOnWebView();
    return webContents;
  }

  private handleEvent(event: string, payload: unknown) {
    if (event === 'game.process') {
      const target = parseTargetLifecycleEvent(payload);
      if (target) {
        this.targetExecutablePaths.set(target.pid, target.executablePath);
        this.emitEvent('targetConnected', target);
      }
    } else if (event === 'game.input') {
      this.forwardGameInput(payload);
    } else if (event === 'game.target.surface') {
      this.retainTargetSurface(payload);
    } else if (event === 'game.target.surface.removed') {
      this.removeTargetSurface(payload);
    } else if (event === 'game.process.transport-lost') {
      const target = parseTargetLifecycleEvent(
        payload,
        this.targetExecutablePaths,
      );
      if (target) {
        this.emitEvent('targetTransportLost', target);
      }
    } else if (event === 'game.process.disconnected') {
      const target = parseTargetLifecycleEvent(
        payload,
        this.targetExecutablePaths,
      );
      if (!target) {
        return;
      }
      this.removeTargetSurfacesForProcess(target.pid);
      this.clearProducerDiagnosticStateForProcess(target.pid);
      this.targetExecutablePaths.delete(target.pid);
      this.emitEvent('targetDisconnected', target);
    } else if (event === 'game.input.intercept') {
      const state = parseInputInterceptionEvent(payload);
      if (state) {
        this.emitEvent('inputInterceptionChanged', state);
      }
    } else if (event === 'game.window.focused') {
      const focus = parseWindowFocusedEvent(payload);
      if (!focus) {
        return;
      }
      const { pid, windowId: focusWindowId } = focus;
      let diagnosticFocusWindowId = this.windowsByNativeId.has(focusWindowId)
        ? focusWindowId
        : 0;

      const sessionWindows = new Set(this.windowsByNativeId.values());
      for (const window of this.windowsById.values()) {
        sessionWindows.add(window);
      }
      for (const window of sessionWindows) {
        try {
          window.browserWindow.blurWebView();
        } catch (error) {
          this.reportInputForwardingFailure(pid, 0, 'blur', error);
        }
      }

      try {
        const overlayWindow =
          this.windowsByNativeId.get(focusWindowId) ??
          Array.from(sessionWindows).find(
            (window) => window.nativeId === focusWindowId,
          );
        if (overlayWindow) {
          diagnosticFocusWindowId = overlayWindow.nativeId;
          this.focusInputWebContents(overlayWindow);
        }
      } catch (error) {
        this.reportInputForwardingFailure(
          pid,
          diagnosticFocusWindowId,
          'focus',
          error,
        );
      }
      this.emitEvent('windowFocused', focus);
    } else if (event === 'game.graphics.fps') {
      const fps = parseOverlayGraphicsFps(payload);
      if (fps) {
        this.emitEvent('fps', fps);
      }
    }
  }

  private handleDiagnostic(payload: unknown) {
    let diagnostic: OverlayDiagnostic | null = null;
    try {
      diagnostic = parseOverlayDiagnostic(payload);
    } catch {
      // A backend diagnostic is observational and cannot interrupt the session.
    }
    if (diagnostic) {
      this.emitEvent('diagnostic', diagnostic);
    }
  }

  private retainTargetSurface(payload: unknown) {
    const surface = parseOverlayTargetSurface(payload);
    if (!surface) {
      return;
    }

    const key = targetSurfaceKey(surface.pid, surface.surfaceId);
    const existing = this.targetSurfaces.get(key);
    if (existing && existing.revision >= surface.revision) {
      return;
    }

    // Delete first so iteration order remains the surface change order. The
    // default follow selector intentionally tracks its newest member.
    this.targetSurfaces.delete(key);
    this.targetSurfaces.set(key, surface);
    this.reapplyTargetFollowers();
    this.emitEvent('targetSurfaceChanged', surface);
  }

  private removeTargetSurface(payload: unknown) {
    const removed = parseOverlayTargetSurfaceRemoved(payload);
    if (!removed) {
      return;
    }

    const key = targetSurfaceKey(removed.pid, removed.surfaceId);
    const existing = this.targetSurfaces.get(key);
    if (!existing || existing.revision > removed.revision) {
      return;
    }

    this.targetSurfaces.delete(key);
    this.reapplyTargetFollowers();
    this.emitEvent('targetSurfaceRemoved', removed);
  }

  private removeTargetSurfacesForProcess(pid: unknown) {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      return;
    }

    const removedSurfaces = [];
    for (const [key, surface] of Array.from(this.targetSurfaces.entries())) {
      if (surface.pid !== pid) {
        continue;
      }
      this.targetSurfaces.delete(key);
      removedSurfaces.push(
        Object.freeze({
          pid: surface.pid,
          surfaceId: surface.surfaceId,
          revision: surface.revision,
        }),
      );
    }
    if (removedSurfaces.length > 0) {
      this.reapplyTargetFollowers();
      for (const removed of removedSurfaces) {
        this.emitEvent('targetSurfaceRemoved', removed);
      }
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
      try {
        handler(payload);
      } catch (error) {
        console.warn(`Electron overlay ${event} event handler failed`, error);
      }
    }
  }

  private emitQuit() {
    if (this.quitting) {
      return;
    }

    this.quitting = true;
    const handlers = Array.from(this.quitHandlers);
    this.quitHandlers.clear();
    for (const handler of handlers) {
      this.invokeLifecycleHandler('quit', handler);
    }
  }

  private emitClose() {
    const handlers = Array.from(this.closeHandlers);
    this.closeHandlers.clear();
    for (const handler of handlers) {
      this.invokeLifecycleHandler('close', handler);
    }
  }

  private invokeLifecycleHandler(kind: 'quit' | 'close', handler: () => void) {
    try {
      handler();
    } catch (error) {
      try {
        console.error(`Electron overlay session ${kind} handler failed`, error);
      } catch {
        // A diagnostic sink must not break session teardown.
      }
    }
  }

  private reportLifecycleCleanupFailure(operation: string, error: unknown) {
    try {
      console.error(`Unable to ${operation} during overlay teardown`, error);
    } catch {
      // A diagnostic sink must not break session teardown.
    }
  }

  private bindScreenEvents() {
    if (this.screenEventsBound) {
      return;
    }

    const removeRegistrations: Array<() => void> = [];
    try {
      this.electronScreen.on('display-added', this.handleDisplayAdded);
      removeRegistrations.push(() =>
        this.electronScreen.removeListener(
          'display-added',
          this.handleDisplayAdded,
        ),
      );
      this.electronScreen.on('display-removed', this.handleDisplayRemoved);
      removeRegistrations.push(() =>
        this.electronScreen.removeListener(
          'display-removed',
          this.handleDisplayRemoved,
        ),
      );
      this.electronScreen.on(
        'display-metrics-changed',
        this.handleDisplayMetricsChanged,
      );
      removeRegistrations.push(() =>
        this.electronScreen.removeListener(
          'display-metrics-changed',
          this.handleDisplayMetricsChanged,
        ),
      );
    } catch (error) {
      while (removeRegistrations.length > 0) {
        try {
          removeRegistrations.pop()?.();
        } catch {
          // Preserve the registration failure; startup cleanup reports stop
          // failures separately and the session remains retryable.
        }
      }
      throw error;
    }
    this.screenEventsBound = true;
  }

  private unbindScreenEvents() {
    if (!this.screenEventsBound) {
      return;
    }

    this.electronScreen.removeListener(
      'display-added',
      this.handleDisplayAdded,
    );
    this.electronScreen.removeListener(
      'display-removed',
      this.handleDisplayRemoved,
    );
    this.electronScreen.removeListener(
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
        if (this.targetFollowOptions.has(window.nativeId)) {
          this.applyTargetFollow(window);
        } else {
          this.syncWindowGeometry(window);
        }
      } catch (error) {
        this.reportWindowBoundsFailure(window, error);
      }
    }
  }

  private getWindowDisplayScale(browserBounds: Rect): WindowDisplayScale {
    const display = this.electronScreen.getDisplayMatching(browserBounds);
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
    const geometry = getPhysicalWindowGeometry(
      state.activeRasterBounds,
      state.activeDisplay,
      {
        dragBorder: window.dragBorder,
        captionHeight: window.captionHeight,
      },
      state.activeFrameSize,
    );
    if (!this.targetFollowOptions.has(window.nativeId)) {
      return geometry;
    }

    return {
      ...geometry,
      rect: {
        x: 0,
        y: 0,
        width: state.activeFrameSize.width,
        height: state.activeFrameSize.height,
      },
      caption: { left: 0, right: 0, top: 0, height: 0 },
    };
  }

  private publishWindowGeometry(
    window: ElectronOverlayWindow,
    state: WindowScaleState,
    rasterChanged = false,
  ): boolean {
    const geometry = this.getWindowGeometry(window, state);
    const published = this.publishedWindowGeometry.get(window.nativeId);
    if (
      !rasterChanged &&
      published &&
      sameWindowGeometry(published, geometry)
    ) {
      return true;
    }

    try {
      this.overlay.sendWindowBounds(
        window.nativeId,
        rasterChanged ? { ...geometry, rasterChanged: true } : geometry,
      );
    } catch (error) {
      this.reportWindowBoundsFailure(window, error);
      return false;
    }
    this.publishedWindowGeometry.set(window.nativeId, geometry);
    return true;
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
    this.publishProducerDiagnostic('producer-frame-rejected', {
      windowId: window.nativeId,
      reason: reconciliation.reason,
      width: size.width,
      height: size.height,
      activeWidth: reconciliation.activeSize.width,
      activeHeight: reconciliation.activeSize.height,
      desiredWidth: reconciliation.desiredSize.width,
      desiredHeight: reconciliation.desiredSize.height,
    });
    console.warn(
      `Suppressing ${reconciliation.reason} Electron overlay frame for window ${window.nativeId}: ` +
        `received ${size.width}x${size.height}, ` +
        `active ${reconciliation.activeSize.width}x${reconciliation.activeSize.height}, ` +
        `desired ${reconciliation.desiredSize.width}x${reconciliation.desiredSize.height}`,
    );
  }

  private reportWindowBoundsFailure(
    window: ElectronOverlayWindow,
    error: unknown,
  ) {
    if (
      this.publishProducerFailure(
        'producer-window-publication-failed',
        {
          windowId: window.nativeId,
          operation: 'bounds',
        },
        error,
      )
    ) {
      console.warn(
        `Cannot publish Electron overlay bounds for window ${window.nativeId}`,
        error,
      );
    }
  }

  private reportFramePublicationFailure(
    window: ElectronOverlayWindow,
    stage: 'bitmap' | 'transport',
    error?: unknown,
  ) {
    if (
      this.publishProducerFailure(
        'producer-frame-publication-failed',
        {
          windowId: window.nativeId,
          stage,
        },
        error,
      )
    ) {
      console.warn(
        `Cannot publish Electron overlay frame for window ${window.nativeId} during ${stage}`,
        error,
      );
    }
  }

  private reportInputForwardingFailure(
    pid: unknown,
    windowId: unknown,
    stage: 'translate' | 'focus' | 'blur' | 'dispatch',
    error: unknown,
  ) {
    const safeWindowId =
      typeof windowId === 'number' &&
      Number.isSafeInteger(windowId) &&
      windowId >= 0 &&
      windowId <= 0xffffffff
        ? windowId
        : 0;
    if (
      this.publishProducerFailure(
        'producer-input-forwarding-failed',
        {
          windowId: safeWindowId,
          stage,
        },
        error,
        pid,
      )
    ) {
      console.warn(
        `Cannot forward intercepted input for window ${safeWindowId} during ${stage}`,
        error,
      );
    }
  }

  private publishProducerFailure(
    code:
      | 'producer-window-publication-failed'
      | 'producer-frame-publication-failed'
      | 'producer-input-forwarding-failed',
    context: Readonly<Record<string, OverlayDiagnosticContextValue>>,
    error?: unknown,
    pid?: unknown,
  ): boolean {
    const errorCode = producerDiagnosticErrorCode(error);
    return this.publishProducerDiagnostic(
      code,
      {
        ...context,
        ...(errorCode === undefined ? {} : { errorCode }),
      },
      pid,
    );
  }

  private publishProducerDiagnostic(
    code: ProducerDiagnosticCode,
    context: Readonly<Record<string, OverlayDiagnosticContextValue>>,
    pid?: unknown,
  ): boolean {
    let diagnostic: OverlayDiagnostic | null = null;
    try {
      diagnostic = parseOverlayDiagnostic({
        schemaVersion: 1,
        source: 'electron-game-overlay',
        code,
        ...(pid === undefined ? {} : { pid }),
        context,
      });
    } catch {
      return false;
    }
    if (!diagnostic) {
      return false;
    }

    const windowId = diagnostic.context?.windowId ?? 0;
    const discriminator =
      diagnostic.context?.operation ??
      diagnostic.context?.stage ??
      diagnostic.context?.reason ??
      '';
    const rateKey =
      `p${diagnostic.pid ?? 0}:w${windowId}:` +
      `${diagnostic.code}:${String(discriminator)}`;
    const now = Date.now();
    const lastPublished = this.producerDiagnosticPublicationTimes.get(rateKey);
    if (
      lastPublished !== undefined &&
      now >= lastPublished &&
      now - lastPublished < PRODUCER_DIAGNOSTIC_COOLDOWN_MS
    ) {
      return false;
    }
    this.producerDiagnosticPublicationTimes.set(rateKey, now);

    if (
      this.pendingProducerDiagnostics.length >= MAX_PENDING_PRODUCER_DIAGNOSTICS
    ) {
      this.pendingProducerDiagnostics.shift();
    }
    this.pendingProducerDiagnostics.push(diagnostic);
    if (!this.producerDiagnosticFlushScheduled) {
      this.producerDiagnosticFlushScheduled = true;
      queueMicrotask(() => this.flushProducerDiagnostics());
    }
    return true;
  }

  private flushProducerDiagnostics() {
    this.producerDiagnosticFlushScheduled = false;
    if (this.closed) {
      this.pendingProducerDiagnostics.length = 0;
      return;
    }

    const diagnostics = this.pendingProducerDiagnostics.splice(0);
    for (const diagnostic of diagnostics) {
      if (this.closed) {
        break;
      }
      this.emitEvent('diagnostic', diagnostic);
    }
  }

  private clearProducerDiagnosticStateForWindow(windowId: number) {
    const marker = `:w${windowId}:`;
    for (const key of this.producerDiagnosticPublicationTimes.keys()) {
      if (key.includes(marker)) {
        this.producerDiagnosticPublicationTimes.delete(key);
      }
    }
  }

  private clearProducerDiagnosticStateForProcess(pid: unknown) {
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid > 0xffffffff
    ) {
      return;
    }
    const prefix = `p${pid}:`;
    for (const key of this.producerDiagnosticPublicationTimes.keys()) {
      if (key.startsWith(prefix)) {
        this.producerDiagnosticPublicationTimes.delete(key);
      }
    }
  }

  private ensureStarted() {
    if (this.closed) {
      throw new Error('the overlay session is closed');
    }
    if (this.quitting) {
      throw new Error('the overlay session is closing');
    }
    if (!this.started) {
      this.start();
    }
  }
}

function producerDiagnosticErrorCode(
  error: unknown,
): string | number | undefined {
  let candidate = error;
  if (
    (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
  ) {
    try {
      candidate = Reflect.get(error, 'code');
    } catch {
      return undefined;
    }
  }
  return normalizeOverlayDiagnosticErrorCode(candidate);
}

function parseTargetLifecycleEvent(
  payload: unknown,
  knownExecutablePaths?: ReadonlyMap<number, string>,
): OverlaySessionEventMap['targetConnected'] | null {
  if (!isEventRecord(payload) || !isValidTargetPid(payload.pid)) {
    return null;
  }
  const executablePath =
    typeof payload.path === 'string' &&
    payload.path.length > 0 &&
    !payload.path.includes('\0')
      ? payload.path
      : knownExecutablePaths?.get(payload.pid);
  if (!executablePath) {
    return null;
  }
  return Object.freeze({ pid: payload.pid, executablePath });
}

function parseInputInterceptionEvent(
  payload: unknown,
): OverlaySessionEventMap['inputInterceptionChanged'] | null {
  if (
    !isEventRecord(payload) ||
    !isValidTargetPid(payload.pid) ||
    typeof payload.intercepting !== 'boolean'
  ) {
    return null;
  }
  return Object.freeze({
    pid: payload.pid,
    intercepting: payload.intercepting,
  });
}

function parseWindowFocusedEvent(
  payload: unknown,
): OverlaySessionEventMap['windowFocused'] | null {
  if (
    !isEventRecord(payload) ||
    !isValidTargetPid(payload.pid) ||
    !Number.isSafeInteger(payload.focusWindowId) ||
    (payload.focusWindowId as number) < 0 ||
    (payload.focusWindowId as number) > 0xffffffff
  ) {
    return null;
  }
  return Object.freeze({
    pid: payload.pid,
    windowId: payload.focusWindowId as number,
  });
}

function isEventRecord(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
  );
}

function isValidTargetPid(pid: unknown): pid is number {
  return (
    typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    pid <= 0xffffffff
  );
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

function sameRect(left: Rect, right: Rect) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
