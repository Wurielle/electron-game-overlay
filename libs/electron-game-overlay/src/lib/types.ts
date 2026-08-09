/** A release or unsubscribe callback. Calling it more than once is safe. */
export type Disposable = () => void;

/** Component that produced an {@link OverlayDiagnostic}. */
export type OverlayDiagnosticSource =
  | 'electron-game-overlay'
  | 'electron-overlay-transport'
  | 'electron-game-overlay-runtime';

/** Severity assigned to a session observation. */
export type OverlayDiagnosticSeverity = 'info' | 'warning' | 'error';

/** Stable machine-readable code for a session observation. */
export type OverlayDiagnosticCode =
  | 'transport-ready'
  | 'transport-listener-failed'
  | 'transport-discovery-failed'
  | 'target-authorized'
  | 'target-authorization-failed'
  | 'target-authentication-rejected'
  | 'target-authenticated'
  | 'target-packet-rejected'
  | 'target-socket-error'
  | 'target-process-inspection-failed'
  | 'producer-window-registered'
  | 'producer-window-publication-failed'
  | 'producer-frame-publication-started'
  | 'producer-frame-rejected'
  | 'producer-frame-publication-failed'
  | 'producer-input-forwarding-failed'
  | 'runtime-ready'
  | 'runtime-swapchain-ready'
  | 'runtime-scene-query-failed'
  | 'runtime-scene-rendering-started'
  | 'runtime-frame-rejected'
  | 'runtime-frame-upload-failed'
  | 'runtime-input-router-reset'
  | 'runtime-input-routing-failed';

/** Scalar value accepted in structured diagnostic context. */
export type OverlayDiagnosticContextValue = string | number | boolean | null;

/**
 * An immutable asynchronous observation from a running overlay session.
 *
 * Attachment failures remain `ReShadeDiagnostic`. Current codes cover the
 * Electron producer, loopback transport, and authenticated injected-runtime
 * observations.
 */
export type OverlayDiagnostic = Readonly<{
  /** Diagnostic schema version. */
  schemaVersion: 1;
  /** Component that produced the observation. */
  source: OverlayDiagnosticSource;
  /** Operational severity of the observation. */
  severity: OverlayDiagnosticSeverity;
  /** Stable code intended for programmatic handling. */
  code: OverlayDiagnosticCode;
  /** Human-readable description intended for logs and diagnostics UI. */
  message: string;
  /** Target process associated with the observation, when applicable. */
  pid?: number;
  /** Bounded structured details whose keys depend on {@link code}. */
  context?: Readonly<Record<string, OverlayDiagnosticContextValue>>;
}>;

/** Payload type for each event accepted by {@link OverlaySession.on}. */
export type OverlaySessionEventMap = {
  /** Asynchronous producer, transport, or injected-runtime observation. */
  diagnostic: OverlayDiagnostic;
  /** Sampled frame rate of a target's primary render surface. */
  fps: OverlayGraphicsFps;
  /** An injected runtime authenticated to this session. */
  targetConnected: Readonly<{
    /** Authenticated target process identifier. */
    pid: number;
    /** Canonical executable path reported for the authenticated process. */
    executablePath: string;
  }>;
  /**
   * Transport to a target ended, without yet proving that the process exited.
   */
  targetTransportLost: Readonly<{
    /** Target process identifier. */
    pid: number;
    /** Last authenticated executable path for the target. */
    executablePath: string;
  }>;
  /** The exact target process was confirmed to have exited. */
  targetDisconnected: Readonly<{
    /** Exited target process identifier. */
    pid: number;
    /** Last authenticated executable path for the target. */
    executablePath: string;
  }>;
  /** A target acknowledged the effective interception state. */
  inputInterceptionChanged: Readonly<{
    /** Target process identifier. */
    pid: number;
    /** Whether the target is currently routing supported input to overlays. */
    intercepting: boolean;
  }>;
  /** Returned target input changed the focused overlay window. */
  windowFocused: Readonly<{
    /** Target process identifier. */
    pid: number;
    /** Backing Electron window ID, or `0` when overlay focus was cleared. */
    windowId: number;
  }>;
  /** A retained render-surface snapshot was added or updated. */
  targetSurfaceChanged: OverlayTargetSurface;
  /** A retained render surface was authoritatively removed. */
  targetSurfaceRemoved: OverlayTargetSurfaceRemoved;
};

/** Event names accepted by {@link OverlaySession.on}. */
export type OverlaySessionEventName = keyof OverlaySessionEventMap;

/** Handler for one typed {@link OverlaySessionEventName}. */
export type OverlaySessionEventHandler<Event extends OverlaySessionEventName> =
  (payload: OverlaySessionEventMap[Event]) => void;

/** Axis-aligned rectangle; the owning API defines its coordinate space. */
export type Rect = {
  /** Horizontal origin. */
  x: number;
  /** Vertical origin. */
  y: number;
  /** Non-negative horizontal extent. */
  width: number;
  /** Non-negative vertical extent. */
  height: number;
};

/** Graphics API reported by an injected target surface. */
export type OverlayGraphicsApi =
  'd3d9' | 'd3d10' | 'd3d11' | 'd3d12' | 'opengl' | 'vulkan' | 'unknown';

/** Physical pixel dimensions reported by a target. */
export type OverlayTargetSize = Readonly<{
  /** Width in physical pixels. */
  width: number;
  /** Height in physical pixels. */
  height: number;
}>;

/** Immutable target rectangle expressed in physical pixels. */
export type OverlayTargetRect = Readonly<Rect>;

/** Effective DPI of the target window. */
export type OverlayTargetDpi = Readonly<{
  /** Horizontal DPI. */
  x: number;
  /** Vertical DPI. */
  y: number;
  /** Chromium/Windows scale derived from the horizontal target DPI. */
  scaleFactor: number;
}>;

/** Monitor geometry associated with a target window. */
export type OverlayTargetMonitor = Readonly<{
  /** Canonical hexadecimal monitor-handle identifier. */
  id: string;
  /** Full monitor rectangle in physical screen coordinates. */
  bounds: OverlayTargetRect;
  /** Usable monitor work area in physical screen coordinates. */
  workArea: OverlayTargetRect;
}>;

/** An immutable snapshot of a render surface owned by an injected process. */
export type OverlayTargetSurface = Readonly<{
  /** Process that owns the render surface. */
  pid: number;
  /** Stable canonical hexadecimal surface identifier. */
  surfaceId: string;
  /** Canonical hexadecimal Win32 target-window handle. */
  hwnd: string;
  /** Monotonically increasing revision for this target's surface state. */
  revision: number;
  /** Graphics API backing the surface. */
  graphicsApi: OverlayGraphicsApi;
  /** Swap-chain or presentation dimensions in physical pixels. */
  renderSize: OverlayTargetSize;
  /** Target client area in client-local physical coordinates. */
  clientBounds: OverlayTargetRect;
  /** Target client area in physical screen coordinates. */
  clientScreenBounds: OverlayTargetRect;
  /** Outer target window in physical screen coordinates. */
  windowScreenBounds: OverlayTargetRect;
  /** Effective target-window DPI and Electron scale factor. */
  dpi: OverlayTargetDpi;
  /** Monitor containing the target window. */
  monitor: OverlayTargetMonitor;
  /** Whether the target window owns foreground focus. */
  focused: boolean;
  /** Whether the target window is minimized. */
  minimized: boolean;
  /** Whether the target window is visible. */
  visible: boolean;
  /** Whether the target surface currently occupies its monitor bounds. */
  fullscreen: boolean;
}>;

/** Identifies a render surface that is no longer retained by the session. */
export type OverlayTargetSurfaceRemoved = Readonly<{
  /** Process that owned the surface. */
  pid: number;
  /** Canonical hexadecimal identifier of the removed surface. */
  surfaceId: string;
  /** Target state revision that removed the surface. */
  revision: number;
}>;

/** Frame-rate sample from a target's primary render surface. */
export type OverlayGraphicsFps = Readonly<{
  /** Target process identifier. */
  pid: number;
  /** Sampled presentation rate in frames per second. */
  fps: number;
}>;

/** Target dimensions used while an overlay window follows a surface. */
export type OverlayTargetFollowArea = 'render' | 'client';

/** Selects the target surface and area followed by an overlay window. */
export type ElectronOverlayWindowFollowTargetOptions = Readonly<{
  /** Restricts selection to a target process. */
  pid?: number;
  /** Restricts selection to a canonical target surface identifier. */
  surfaceId?: string;
  /** Area to follow; defaults to `render`. */
  area?: OverlayTargetFollowArea;
}>;

/** Options shared by created and caller-owned overlay windows. */
export type ElectronOverlayWindowBaseOptions = {
  /** Session-local logical ID; defaults to `name` or the BrowserWindow ID. */
  id?: string;
  /** Human-readable compositor name; defaults to the resolved ID. */
  name?: string;
  /** Initial bounds in Electron device-independent pixels. */
  bounds?: Partial<Rect>;
  /** Focuses the offscreen web view after Electron reports it ready to show. */
  focusOnReady?: boolean;
  /** Draggable border thickness in Electron device-independent pixels. */
  dragBorder?: number;
  /** Draggable caption height in Electron device-independent pixels. */
  captionHeight?: number;
  /** Enables per-pixel alpha hit testing against lower overlay windows. */
  transparent?: boolean;
};

/**
 * Presentation options for a caller-owned BrowserWindow. Closing the overlay
 * wrapper unregisters it without closing the attached BrowserWindow.
 */
export type AttachElectronOverlayWindowOptions =
  ElectronOverlayWindowBaseOptions;

/** Options for an SDK-created offscreen Electron window. */
export type CreateElectronOverlayWindowOptions =
  ElectronOverlayWindowBaseOptions & {
    /**
     * Options passed to Electron's `BrowserWindow` constructor. The SDK enables
     * offscreen rendering and defaults the native window to hidden.
     */
    browserWindow?: Electron.BrowserWindowConstructorOptions;
    /** URL loaded by the backing window. Takes precedence over `file`. */
    url?: string;
    /** Local file loaded when `url` is not supplied. */
    file?: string;
  };

/** Internal normalized window options used by the session implementation. */
export type ElectronOverlayWindowOptions =
  CreateElectronOverlayWindowOptions & {
    /** Caller-owned offscreen window used by `session.windows.attach()`. */
    existingWindow?: Electron.BrowserWindow;
  };
