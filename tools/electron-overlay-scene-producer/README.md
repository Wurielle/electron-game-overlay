# Electron scene producer

This controlled producer exercises the public `electron-game-overlay` SDK
against the production injected runtime. It loads the repository's real
`apps/client/public/index/example-main-overlay.html` into offscreen Electron
windows and publishes them through
`ElectronGameOverlay -> OverlaySession -> session.windows.create()`.

The default production scene contains overlapping `ExampleMainOverlay` and
`ExamplePopupOverlay` surfaces. Their public bounds are Electron
device-independent pixels (DIP); OSR bitmaps, wire geometry, native hit testing,
and composition use physical pixels. The SDK converts returned input back to
DIP using the scale that was active when the native router created the packet.

## Run with the production runtime

From the repository root, use the dedicated launchers:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-electron-scene.ps1
```

Each launcher builds the transport engine, SDK, pinned ReShade runtime,
`electron_game_overlay.addon64`, controlled host, and this producer. It stages
an isolated run under `build/electron-game-overlay-runtime`, starts the target,
and requests interception after the authenticated producer/target rendezvous is
ready. No separate `client:dev` process is required.

Use `-NoLaunch` to build and stage without starting the host and producer. The
parameterized `scripts/run-electron-scene.ps1` is the internal automation entry
point; human testing should use the named test-case scripts above.

## What to test

The producer registers a green 640 x 360 BACK window and an overlapping blue
320 x 220 FRONT window. Each page has a striped caption handle, text field, and
role-specific diagnostics.

While interception is acknowledged:

1. Click the exposed content of either window and verify it moves to the front.
2. Click and type into both text fields.
3. Drag a striped caption and then click the window at its new position.
4. Drag a pointer outside a window before releasing it to verify capture.
5. Use the page controls to hide, show, or raise either window.
6. Confirm the controlled host's legacy, raw, polling, pointer, cursor, and
   confinement oracle remains frozen.
7. Use **Release input** on the BACK window, then verify normal target input and
   cursor confinement resume.

Close the controlled host with its title-bar X when finished. The runner keeps
the target in the foreground, records producer output beside `ReShade.log`, and
cleans only the processes it launched.

## Geometry and raster contract

The SDK derives each surface from `BrowserWindow.getContentBounds()`, not the
outer frame. It maintains desired and active display scale independently per
window. A move, resize, or display-metrics event requests repaint while the
published scene remains coherent at the active scale.

A matching OSR paint commits the new scale and complete physical geometry. An
old-scale frame remains valid while the transition is pending; an unrelated
size is suppressed. Electron can differ from nominal floor-scaled dimensions by
one pixel, so the accepted bitmap dimensions become the authoritative physical
rectangle and fixed-size constraints. Ambiguous paints are resolved with a
renderer DPR/viewport acknowledgement followed by a cropped `capturePage()`
barrier.

A raster-changing bounds update clears the latest compositable pixels until its
matching frame arrives. That prevents old pixels from being drawn with new
geometry without prematurely retiring the cached GPU texture.

## Log markers

Some marker and internal flag names retain the `HUDHOOK_` / `--hudhook-`
prefix. They are protocol-compatible historical names shared by the accepted
test harness; they do not indicate that the production runtime loads hudhook.
Useful producer markers include:

```text
HUDHOOK_CLIENT_WINDOW_READY
HUDHOOK_CLIENT_WINDOW_TARGET_CONNECTED pid=<pid>
HUDHOOK_CLIENT_MULTIWINDOW_DEVICE_SCALE ...
HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_ENABLED
HUDHOOK_CLIENT_MULTIWINDOW_INPUT ...
HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_DISABLED
HUDHOOK_CLIENT_MULTIWINDOW_LIFECYCLE_COMPLETE
```

The producer rejects input-ordering faults and router resets. The runtime runner
additionally requires the exact host PID, graphics API, uploaded windows,
composition, interception acknowledgement, and safe release markers.

## Producer-only launch

For transport development, the producer can be started without a target:

```powershell
.\node_modules\electron\dist\electron.exe `
  .\tools\electron-overlay-scene-producer `
  --no-sandbox
```

Interactive modes require an injected target to connect within their timeout.
Only one producer/target rendezvous may be active at a time. Stop a producer-only
launch with Ctrl+C.

## Historical hudhook reuse

The retained `poc/hudhook-imgui-overlay` launchers reuse this producer for
historical regression testing. Their dedicated cases remain under
`poc/hudhook-imgui-overlay/scripts/test-cases`; they are not production build
inputs. The old `HUDHOOK_` marker names are intentionally stable so those
recorded gates remain comparable.
