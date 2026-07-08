type ElectronGameOverlay = typeof import("@libs/electron-game-overlay");

export function loadNativeLib(): ElectronGameOverlay {
  return require("@libs/electron-game-overlay");
}
