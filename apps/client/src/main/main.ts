import { app as ElectronApp } from "electron"

import "./utils/config"

import { Application } from "./electron/app-entry"
import { parseHudhookLaunchConfig } from "./electron/hudhook-launch"

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
