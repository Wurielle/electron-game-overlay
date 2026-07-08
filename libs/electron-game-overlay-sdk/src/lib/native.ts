import * as nativeOverlay from "@libs/electron-game-overlay";

export type NativeOverlay = typeof nativeOverlay;

export function loadNativeOverlay(): NativeOverlay {
  return nativeOverlay;
}
