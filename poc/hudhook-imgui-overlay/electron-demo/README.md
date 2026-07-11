# Electron frame producer

This small Electron 16 application creates one fixed, opaque 640 x 360 offscreen `BrowserWindow` and sends its full paint frames through the repository's public `electron-game-overlay` SDK. The SDK owns an authenticated loopback TCP transport and forwards bounded binary BGRA frames without loading a native Node add-on.

It does not inject a graphics payload. The hudhook POC runner starts this process alongside the controlled D3D11 host and injector.

From the repository root on Windows:

```powershell
.\node_modules\electron\dist\electron.exe `
  .\poc\hudhook-imgui-overlay\electron-demo `
  --no-sandbox
```

Successful startup and the first forwarded full frame produce this stdout marker:

```text
HUDHOOK_ELECTRON_DEMO_READY
```

Only one Electron overlay producer/target pair should run at a time because the v1 rendezvous is intentionally single-session. Stop the process with Ctrl+C when running it manually; the demo closes its overlay session and disposes the SDK during normal shutdown.
