# Existing client window producer

This controlled Electron producer loads the repository's real
`apps/client/public/index/example-main-overlay.html` through the public
`ElectronGameOverlay -> OverlaySession -> session.windows.create()` API. It
creates one transparent, fixed 640 x 360 offscreen window named
`ExampleMainOverlay` at native overlay position `(64, 72)`.

The BrowserWindow enables Node integration and disables context isolation,
matching the real client settings required by the page's
`window.require('electron')` call. Each non-empty paint is checked for a full
640 x 360 BGRA bitmap before the producer prints:

```text
HUDHOOK_CLIENT_WINDOW_READY
```

After readiness, the producer waits up to 30 seconds for the public session's
`game.process` native event from the injected payload. It logs the connected
target PID, waits 2.5 seconds for initial composition, and then runs this
deterministic lifecycle sequence with 750 ms between steps:

1. Move to `(176, 128)` with `ElectronOverlayWindow.setBounds()`, producing a
   native `window.bounds` message.
2. Call `ElectronOverlayWindow.hide()`, producing a native `window.close`
   message without destroying the BrowserWindow.
3. Call `ElectronOverlayWindow.show()` to re-register the same window, then
   invalidate its web contents to publish a fresh frame.

The corresponding stdout markers are:

```text
HUDHOOK_CLIENT_WINDOW_TARGET_CONNECTED pid=<pid>
HUDHOOK_CLIENT_WINDOW_MOVED x=176 y=128
HUDHOOK_CLIENT_WINDOW_HIDDEN event=window.close
HUDHOOK_CLIENT_WINDOW_RESHOWN
HUDHOOK_CLIENT_WINDOW_LIFECYCLE_COMPLETE
```

The overlay remains registered and the producer keeps running after the
sequence. The recommended repository-root command is:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientWindow -Wait
```

For a producer-only launch, use:

```powershell
.\node_modules\electron\dist\electron.exe `
  .\poc\hudhook-imgui-overlay\electron-client-window-demo `
  --no-sandbox
```

The manual producer needs an injected target to connect within 30 seconds.
Stop it with Ctrl+C. Normal shutdown destroys the overlay window, closes the
session, and disposes the SDK. For an unattended attached smoke test, add
`--exit-after-lifecycle`; the process exits successfully 750 ms after the final
lifecycle step.

Only one Electron overlay producer should run at a time because the current
native add-on uses a fixed IPC host name.
