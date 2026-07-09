import * as path from "path"
import "./debug"

import { fileUrl } from "./utils"

const CONFIG: any = {}

CONFIG.distDir = path.join(__dirname, "../")

CONFIG.resolveRendererUrl = (route: string) =>
  process.env.VITE_DEV_SERVER_URL
    ? new URL(route, process.env.VITE_DEV_SERVER_URL).toString()
    : fileUrl(path.join(CONFIG.distDir, route))

CONFIG.entryUrl = CONFIG.resolveRendererUrl("index/index.html")

global.CONFIG = CONFIG

export default CONFIG
