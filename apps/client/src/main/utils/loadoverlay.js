/* eslint-disable @typescript-eslint/no-var-requires */
const { app } = require('electron')
const path = require('path')


function loadNativeLib() {
  const lib_path = path.join(__dirname, '../../../../libs/electron-game-overlay')
  return require(lib_path)
}

module.exports = {
  loadNativeLib,
}
