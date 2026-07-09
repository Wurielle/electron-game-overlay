import * as nativeOverlay from "@libs/node-game-overlay";

export type NativeOverlay = typeof nativeOverlay;

export function loadNativeOverlay(): NativeOverlay {
  return nativeOverlay;
}
