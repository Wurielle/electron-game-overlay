export type Disposable = () => void;

export type OverlayEventHandler = (event: string, payload: any) => void;

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

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ElectronOverlayWindowOptions = {
  id?: string;
  name?: string;
  existingWindow?: Electron.BrowserWindow;
  browserWindow?: Electron.BrowserWindowConstructorOptions;
  url?: string;
  file?: string;
  bounds?: Partial<Rect>;
  dragBorder?: number;
  captionHeight?: number;
  transparent?: boolean;
};
