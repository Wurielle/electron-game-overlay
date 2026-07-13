import type { ElectronOverlayWindow } from './electron-overlay-window.js';
import type { ElectronOverlayWindowFollowTargetOptions } from './types.js';

export type OverlayWindowBridge = {
  registerWindow: (window: ElectronOverlayWindow) => void;
  unregisterWindow: (window: ElectronOverlayWindow) => void;
  removeWindow: (window: ElectronOverlayWindow) => void;
  syncWindowGeometry: (window: ElectronOverlayWindow) => void;
  followTarget: (
    window: ElectronOverlayWindow,
    options: ElectronOverlayWindowFollowTargetOptions,
  ) => void;
  stopFollowingTarget: (window: ElectronOverlayWindow) => void;
  sendFrame: (
    window: ElectronOverlayWindow,
    image: Electron.NativeImage,
  ) => void;
  sendCursor: (type: string) => void;
};
