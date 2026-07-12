import { app as ElectronApp } from "electron"
import { parseHudhookLaunchConfig } from "electron-game-overlay"

import "./utils/config"

import { Application } from "./electron/app-entry"

const appEntry = new Application(parseHudhookLaunchConfig(process.argv))

ElectronApp.disableHardwareAcceleration()

ElectronApp.on("before-quit", () => {
    appEntry.dispose()
})

ElectronApp.on("ready", () => {
    appEntry.start()
})

ElectronApp.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        ElectronApp.quit()
    }
})

ElectronApp.on("activate", () => {
    appEntry.activate()
})
