const { createOverlayAfterPack } = require('electron-game-overlay/packaging');
module.exports = {
  appId: 'example.managed-overlay',
  asar: true,
  npmRebuild: false,
  files: ['main.cjs'],
  asarUnpack: ['node_modules/electron-game-overlay/**/*'],
  afterPack: createOverlayAfterPack(),
};
