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
  fps: {
    fps: number;
  };
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
};

export type OverlaySessionEventName = keyof OverlaySessionEventMap;

export type OverlaySessionEventHandler<Event extends OverlaySessionEventName> = (
  payload: OverlaySessionEventMap[Event]
) => void;

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ElectronOverlayWindowBaseOptions = {
  id?: string;
  name?: string;
  bounds?: Partial<Rect>;
  dragBorder?: number;
  captionHeight?: number;
  transparent?: boolean;
};

export type AttachElectronOverlayWindowOptions = ElectronOverlayWindowBaseOptions;

export type CreateElectronOverlayWindowOptions =
  ElectronOverlayWindowBaseOptions & {
    browserWindow?: Electron.BrowserWindowConstructorOptions;
    url?: string;
    file?: string;
  };

export type ElectronOverlayWindowOptions = CreateElectronOverlayWindowOptions & {
  existingWindow?: Electron.BrowserWindow;
};
