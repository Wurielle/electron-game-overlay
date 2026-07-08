import type { ElectronOverlayWindow } from "./electron-overlay-window.js";

export type OverlayWindowBridge = {
  registerWindow: (window: ElectronOverlayWindow) => void;
  unregisterWindow: (window: ElectronOverlayWindow) => void;
  removeWindow: (window: ElectronOverlayWindow) => void;
  syncWindowBounds: (window: ElectronOverlayWindow) => void;
  sendFrame: (
    window: ElectronOverlayWindow,
    image: Electron.NativeImage
  ) => void;
  sendCursor: (type: string) => void;
};
