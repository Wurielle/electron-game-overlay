export type Disposable = () => void;

export type OverlayHotkey = {
  name: string;
  keyCode: number;
  modifiers?: {
    alt?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
  };
  passthrough?: boolean;
};

export type OverlayProcessAttachResult = {
  injectHelper: string;
  injectDll: string;
  injectSucceed: boolean;
};

export type OverlayProcessTarget = (
  | {
      title: string;
    }
  | {
      pid: number;
    }
) & {
  includeMinimized?: boolean;
};

export type OverlaySessionEventMap = {
  fps: OverlayGraphicsFps;
  hotkeyDown: {
    name: string;
  };
  nativeEvent: {
    event: string;
    payload: any;
  };
  windowFocused: {
    windowId: number;
  };
  targetSurfaceChanged: OverlayTargetSurface;
  targetSurfaceRemoved: OverlayTargetSurfaceRemoved;
};

export type OverlaySessionEventName = keyof OverlaySessionEventMap;

export type OverlaySessionEventHandler<Event extends OverlaySessionEventName> =
  (payload: OverlaySessionEventMap[Event]) => void;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OverlayGraphicsApi =
  | 'd3d9'
  | 'd3d10'
  | 'd3d11'
  | 'd3d12'
  | 'opengl'
  | 'vulkan'
  | 'unknown';

export type OverlayTargetSize = Readonly<{
  width: number;
  height: number;
}>;

export type OverlayTargetRect = Readonly<Rect>;

export type OverlayTargetDpi = Readonly<{
  x: number;
  y: number;
  /** Chromium/Windows scale derived from the horizontal target DPI. */
  scaleFactor: number;
}>;

export type OverlayTargetMonitor = Readonly<{
  id: string;
  bounds: OverlayTargetRect;
  workArea: OverlayTargetRect;
}>;

/** An immutable snapshot of a render surface owned by an injected process. */
export type OverlayTargetSurface = Readonly<{
  pid: number;
  surfaceId: string;
  hwnd: string;
  revision: number;
  graphicsApi: OverlayGraphicsApi;
  renderSize: OverlayTargetSize;
  clientBounds: OverlayTargetRect;
  clientScreenBounds: OverlayTargetRect;
  windowScreenBounds: OverlayTargetRect;
  dpi: OverlayTargetDpi;
  monitor: OverlayTargetMonitor;
  focused: boolean;
  minimized: boolean;
  visible: boolean;
  fullscreen: boolean;
}>;

export type OverlayTargetSurfaceRemoved = Readonly<{
  pid: number;
  surfaceId: string;
  revision: number;
}>;

export type OverlayGraphicsFps = Readonly<{
  pid: number;
  fps: number;
}>;

export type OverlayTargetFollowArea = 'render' | 'client';

export type ElectronOverlayWindowFollowTargetOptions = Readonly<{
  pid?: number;
  surfaceId?: string;
  area?: OverlayTargetFollowArea;
}>;

export type ElectronOverlayWindowBaseOptions = {
  id?: string;
  name?: string;
  bounds?: Partial<Rect>;
  dragBorder?: number;
  captionHeight?: number;
  transparent?: boolean;
};

export type AttachElectronOverlayWindowOptions =
  ElectronOverlayWindowBaseOptions;

export type CreateElectronOverlayWindowOptions =
  ElectronOverlayWindowBaseOptions & {
    browserWindow?: Electron.BrowserWindowConstructorOptions;
    url?: string;
    file?: string;
  };

export type ElectronOverlayWindowOptions =
  CreateElectronOverlayWindowOptions & {
    existingWindow?: Electron.BrowserWindow;
  };
