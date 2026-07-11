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

## Manual input mode

Run the hands-on input demo from the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInputManual -Wait
```

You do not need to run `client:dev`; the repository runner builds and starts the
required producer and controlled host. Wait for the runner to print this message
before interacting:

```text
Manual input is ready.
```

The producer's redirected stdout log records the underlying
`HUDHOOK_CLIENT_INPUT_MANUAL_READY` marker.

The producer has now enabled the proof instrumentation on the real
`ExampleMainOverlay` page and requested `session.input.intercept()`. Click the
real text field in the composited overlay, type into it, and scroll over it. No
automated input is sent and interception is not automatically released.

When finished, close the controlled host with its title-bar X. Escape and
Alt+F4 are intercepted and forwarded to Electron, so neither closes the host in
this mode. Moving focus away temporarily suspends interception; refocusing the
host reapplies the guarded filter, with both transitions reported by the runner.
Manual mode remains attached even if `-Wait` is omitted. After the host closes,
it cleans only the host and per-run Electron process tree that it launched; the
documented command keeps `-Wait` explicit for consistency.

## Deterministic automated input mode

The same producer also has a runner-only automated input mode. After the page
and injected target are ready, `--hudhook-client-input-runner` asks the page for
the actual text-input DOM rectangle, logs it together with the current overlay
origin, and calls `session.input.intercept()`. It does not run the move/hide/show
lifecycle.
The public native-event acknowledgement produces
`HUDHOOK_CLIENT_INPUT_INTERCEPT_ENABLED`.

That acknowledgement reports routing state after the payload's guarded filter
transition; the repository runner also requires the separate
`hudhook input filter enabled at render boundary` marker before sending input.

The repository runner supplies a unique `--input-control-file=<path>`. It writes
`release` only after proving that intercepted Escape did not close the controlled
host. The producer then calls `session.input.release()` and waits for the matching
acknowledgement before printing:

```text
HUDHOOK_CLIENT_INPUT_INTERCEPT_DISABLED
HUDHOOK_CLIENT_INPUT_LIFECYCLE_COMPLETE
```

The runner additionally waits for
`hudhook input filter disabled at render boundary` before sending released Escape.

Use the deterministic end-to-end mode rather than launching its internal flag
manually:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
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
