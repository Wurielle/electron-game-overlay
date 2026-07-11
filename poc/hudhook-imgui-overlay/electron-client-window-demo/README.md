# Existing client window producer

This controlled Electron producer loads the repository's real
`apps/client/public/index/example-main-overlay.html` through the public
`ElectronGameOverlay -> OverlaySession -> session.windows.create()` API. It
creates one transparent, fixed 640 x 360 offscreen window named
`ExampleMainOverlay` at Electron DIP position `(64, 72)`. The multi-window
runner modes additionally create an overlapping transparent
`ExamplePopupOverlay`, using the same public SDK without adding a z-order field.

The BrowserWindow enables Node integration and disables context isolation,
matching the real client settings required by the page's
`window.require('electron')` call. Each non-empty paint is checked against the
physical dimensions expected from the configured device scale before the
producer prints:

```text
HUDHOOK_CLIENT_WINDOW_READY
```

After readiness, the producer waits up to 30 seconds for the public session's
`game.process` native event from the injected payload. It logs the connected
target PID, waits 2.5 seconds for initial composition, and then runs this
deterministic lifecycle sequence with 750 ms between steps:

1. Move to `(176, 128)` with `ElectronOverlayWindow.setBounds()`, producing a
   physical-pixel `window.bounds` message from those public DIP coordinates.
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
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-window-lifecycle.ps1
```

The complete set of zero-argument, human-facing launchers is catalogued in
[`scripts/test-cases/README.md`](../scripts/test-cases/README.md). The
parameterized `scripts/run-electron-dx11.ps1` runner remains available as the
advanced/CI interface. Multi-window cases temporarily clear and then restore
`HUDHOOK_ELECTRON_WINDOW` automatically.

## Multi-window modes

Run the deterministic two-window acceptance proof from the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-multiwindow-automated-125.ps1
```

The producer registers green 640 x 360 `ExampleMainOverlay` at `(64, 72)` as
BACK, then overlapping blue 320 x 220 `ExamplePopupOverlay` at `(200, 136)` as
FRONT; those values are Electron DIP. At the forced 1.25 factor, the SDK sends
physical rectangles `(80, 90, 800 x 450)` and `(250, 170, 400 x 275)`, matching
the Electron 16 OSR bitmap dimensions. Both pages expose aligned text fields
below their SDK captions and role-specific proof events. The runner proves
initial BACK>FRONT composition,
FRONT-only overlap input and keyboard focus, FRONT capture during an out-of-bounds
pointer gesture, click-to-front from exposed BACK client content without lifecycle traffic,
close/re-register ordering in both directions, BACK-only overlap routing after it
is raised, and FRONT hide/show without disturbing BACK. After those original-bounds
checks, it drags FRONT's striped caption handle by a physical delta equivalent to
`(+96, +72)` DIP and verifies the composited physical rect moves without a
producer lifecycle or `window.bounds` event. FIFO-drained
page hover barriers bracket the no-DOM-input assertion, after which the runner
proves returned physical input converts back to the target's unchanged local DIP
coordinates and the vacated caption point uses the new hit-test rect.
The final phases cover guarded interception release, normal released-Escape host
exit, and exact-process cleanup. Rust tests cover
alpha-zero fallthrough and atomic ordered scene/router publication below that
end-to-end boundary.

The producer's scale evidence is:

```text
HUDHOOK_CLIENT_MULTIWINDOW_DEVICE_SCALE requestedScale=1.25 displayScale=1.25 backDpr=1.25 frontDpr=1.25 backFrame=800x450 frontFrame=400x275
```

For hands-on testing, run:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-multiwindow-manual.ps1
```

Wait for `Manual multi-window input is ready.` Each page has a high-contrast
striped `:: DRAG BACK ::` or `:: DRAG FRONT ::` handle inside its SDK-declared
caption. Drag that handle to move the composited window. This is distinct from
pressing in a text field and dragging outside the window, which only demonstrates
pointer-capture ownership. Click/type in either field and use the in-page controls
to hide/show or raise BACK and FRONT. Close the controlled host with its title-bar
X when finished; Escape and Alt+F4 remain intercepted while the host is focused.
No `client:dev` process is needed. Manual mode remains attached, reports
focus-loss suspension/resumption, and cleans only its per-run Electron tree and
controlled host.

These modes intentionally express explicit raises through the existing
hide/show lifecycle: close removes one registration and show appends its
replacement on top. Click-to-front is maintained inside the injected payload.
Caption movement is also payload-local: it immediately republishes the render and
hit-test rect but deliberately leaves the hidden producer `BrowserWindow` bounds
unchanged. A producer lifecycle event, external `setBounds()`, or reconnect can
therefore restore producer-owned placement. The public SDK and existing IPC
schema still have no persistent z-order or payload-to-producer placement field.
The producer flags `--hudhook-client-multiwindow-runner` and
`--hudhook-client-multiwindow-manual` are runner internals; use the repository
commands above so injection, readiness checks, verification, and cleanup remain
coordinated.

## Manual input mode

Run the hands-on input demo from the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-manual.ps1
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
it cleans only the host and per-run Electron process tree that it launched. The
test-case launcher selects the attached behavior for you.

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
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-automated.ps1
```

## Producer-only launch

For a producer-only launch, use:

```powershell
.\node_modules\electron\dist\electron.exe `
  .\poc\hudhook-imgui-overlay\electron-client-window-demo `
  --no-sandbox
```

The interactive input and multi-window proof variants need an injected target to
connect within 30 seconds. Repository proof modes force a uniform device scale
(1 by default); the automated `-ClientMultiWindow` proof accepts `1`, `1.25`,
`1.5`, and `2`, with a fixed launcher for each value in the test-case catalog.
The 1.25 launcher remains the primary acceptance proof documented above. All
modes disable Electron hardware acceleration so frame and input coordinates
remain deterministic. The 1.25 multi-window run is
bounded forced-scale evidence only: the session caches the Electron 16 display
factor nearest `(0, 0)`, and real PMv2/mixed-monitor changes, physical/VM DPI
behavior, and Electron 42 OSR remain unverified. Stop a
producer-only launch with Ctrl+C. Normal shutdown destroys
the overlay windows, closes the session, and disposes the SDK. For an unattended
attached one-window smoke test, add `--exit-after-lifecycle`; the process exits
successfully 750 ms after the final lifecycle step.

Only one controlled runner or Electron overlay producer may run at a time. Do
not run the modes concurrently because the current native add-on uses a fixed
IPC host name.
