# hudhook + ImGui D3D11/D3D12 proof of concept

> **Archived production-host candidate:** Keep these launchers and controlled
> proofs as the verified Electron transport, compositor, routing, and regression
> baseline. Real Gun Frog validation showed that the game could still observe
> mouse hover/click activity while interception was active, so the selected
> production host is now the
> [Electron game overlay runtime](../../libs/electron-game-overlay-runtime/README.md).
> The controlled-host hudhook regressions remain runnable for historical work.
> The former production-client cases are archived launchers that point to their
> current runtime replacements. Reusable
> backend-neutral Electron/Rust components were promoted to
> `libs/electron-overlay-transport`; further private game-input detour expansion
> is deferred.

This standalone Windows x64 proof uses a documented local path patch over
[hudhook 0.9.1](https://github.com/veeenu/hudhook/tree/0.9.1) to inject
project-owned backend payloads, hook D3D11 and D3D12 swap chains, render Dear
ImGui, and provide safe Win32 input ownership. Graphics rendering behavior
remains the published 0.9.1 implementation.

It deliberately does not install or load ReShade. The promoted production
runtime remains a separate implementation under
`libs/electron-game-overlay-runtime`.

The payload renders:

- an always-visible diagnostics panel with frame and display information;
- every matching Electron offscreen window received through the repository's
  project-owned `electron-game-overlay` loopback transport;
- a generated RGBA checkerboard while no Electron scene is available.

The compositor treats registration order as back-to-front. `overlay.init`
preserves that order, a new or duplicate `window` registration is deduplicated
and appended on top, and a pointer-down intent raises the hit window without a
new wire message. It draws each window at signed native bounds, alpha-hit-tests
transparent pixels so input can fall through to a lower Electron window, and
follows per-window bounds, close, and re-registration events. The bridge worker
publishes an immutable ordered scene and matching router state atomically;
hudhook's render thread maintains a texture cache keyed by native window ID.
Premultiplied BGRA frames are converted to straight RGBA before publication.

Electron's public window geometry remains in device-independent pixels (DIP).
The SDK samples `BrowserWindow.getContentBounds()` rather than outer bounds, so
the wire rectangle describes the OSR content surface even for a framed or
attached producer. It scales that rectangle and caption hit regions to physical
pixels; resize constraints remain local to Electron, and Electron 16's OSR
bitmap is already physical. Hudhook therefore composes and hit-tests in native
game/swap-chain pixels. Each
outbound `game.input` packet is tagged with the scale active when it was routed,
and the SDK converts returned local physical coordinates with that packet tag so
queued input survives a later scale commit. Untagged legacy packets fall back to
the window's current active scale. Because hudhook's ImGui `display_size` already
comes from the native swap-chain buffer, the payload normalizes
`display_framebuffer_scale` to `(1, 1)` to prevent a second DPI multiplication.

Scale is tracked independently for each producer window. A move, resize, or
display-topology event changes its desired display scale and requests a repaint,
but its active geometry and input conversion stay on the old scale until an OSR
paint matches the desired physical dimensions. The matching paint commits the
new physical rect, caption hit regions, and scale identity in place without
changing scene order. Unmatched paint sizes are not published.
Paint dimensions are accepted within one pixel of the nominal floor-scaled size,
and the actual accepted bitmap width/height become authoritative geometry,
covering Electron 16 rounding such as `400 x 251` for
`320 x 200` at 1.25. If a bitmap fits both the active and desired tolerances, the
SDK rejects the ambiguous callback, waits for renderer DPR/viewport
acknowledgement, and commits only a causally subsequent `capturePage()` cropped
to the desired content rectangle. A raster-changing bounds packet sets
`rasterChanged`; the payload drops that window's latest raster from the scene
until the following framebuffer, preventing old pixels from being paired with
new metadata. This does not retire the cached GPU texture.

The project-owned Node transport listens only on an ephemeral IPv4 loopback port,
publishes a versioned discovery document with a fresh 256-bit session token, and
requires a token-authenticated `game.process` hello before exchanging state. JSON
control packets and raw premultiplied-BGRA frame packets use an incremental,
length-prefixed wire format with checked dimensions, exact source byte counts,
and explicit size limits. Controls remain FIFO barriers while adjacent unsent
frames for the same window are replaced by the newest frame.

Every announced window participates. The legacy
`HUDHOOK_ELECTRON_WINDOW` exact-name filter was removed from the shared
transport so inherited shell state cannot silently hide valid windows. The
injected payload does not load the legacy native renderer.

## Safety boundary

Use this only with the included controlled host or offline/single-player software you are allowed to modify. Do not inject it into competitive or anti-cheat-protected software.

The injector, payload, and target must have the same architecture and integrity level. This first proof is x64-only.

## Requirements

- Windows 10 or newer;
- Visual Studio 2022 C++ Build Tools and a Windows SDK;
- CMake 3.24 or newer;
- Git, used by the controlled host's CMake dependency fetch;
- Rust 1.85 or newer with the `x86_64-pc-windows-msvc` target;
- Node.js/npm with the repository dependencies installed for Electron modes;
- an internet connection for the first Cargo build.

The Cargo workspace pins hudhook to exactly `0.9.1` and commits `Cargo.lock` for reproducibility.

## Build

From a regular PowerShell opened at the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\build-dx11.ps1
.\poc\hudhook-imgui-overlay\scripts\build-dx12.ps1
```

The script locates the build tools, enters the Visual Studio developer environment, builds the existing controlled D3D11 host, builds the Rust injector and payload, recreates the ignored run directory, and stages only these files in `build/hudhook-imgui-overlay/run/dx11`:

- `d3d11_overlay_test_host.exe`;
- `hudhook_imgui_overlay_dx11.dll`;
- `hudhook_overlay_injector.exe`;
- `THIRD_PARTY_NOTICES.md`.

The clean run directory intentionally contains no ReShade proxy, configuration, or add-on files.

## Test-case launchers

Human-facing tests have zero-argument launchers under
[`scripts/test-cases`](scripts/test-cases/README.md). Run a controlled-host
launcher whose name matches the scenario you want to inspect. The three
client-bound entries are retained as discoverable archived files and exit with
migration guidance:

| Test case                                             | Launcher                              |
| ----------------------------------------------------- | ------------------------------------- |
| Hook and generated-texture smoke test                 | `dx11-hook-only.ps1`                  |
| Electron SDK/transport diagnostic producer            | `dx11-electron-diagnostic.ps1`        |
| Archived real client integration (not runnable)       | `dx11-real-client.ps1`                |
| Archived real-game client input case (not runnable)   | `dx11-real-game-input-manual.ps1`     |
| Window lifecycle regression                           | `dx11-window-lifecycle.ps1`           |
| Automated input regression                            | `dx11-input-automated.ps1`            |
| Hands-on input demo                                   | `dx11-input-manual.ps1`               |
| Automated multi-window regression at 100%             | `dx11-multiwindow-automated-100.ps1`  |
| Automated multi-window regression at 125%             | `dx11-multiwindow-automated-125.ps1`  |
| Automated multi-window regression at 150%             | `dx11-multiwindow-automated-150.ps1`  |
| Automated multi-window regression at 200%             | `dx11-multiwindow-automated-200.ps1`  |
| Hands-on multi-window demo                            | `dx11-multiwindow-manual.ps1`         |
| D3D12 hook and generated-texture smoke test           | `d3d12-hook-only.ps1`                 |
| D3D12 Electron diagnostic                             | `d3d12-electron-diagnostic.ps1`       |
| Archived D3D12 real client integration (not runnable) | `d3d12-real-client.ps1`               |
| D3D12 lifecycle regression                            | `d3d12-window-lifecycle.ps1`          |
| D3D12 automated input regression                      | `d3d12-input-automated.ps1`           |
| D3D12 hands-on input demo                             | `d3d12-input-manual.ps1`              |
| D3D12 automated multi-window regression               | `d3d12-multiwindow-automated-100.ps1` |
| D3D12 hands-on multi-window demo                      | `d3d12-multiwindow-manual.ps1`        |

The parameterized `scripts/run-electron-dx11.ps1` runner remains the underlying
advanced/CI interface for custom combinations.

## Archived client-bound launchers

The three launchers below remain discoverable so the accepted historical cases
and their replacement routes are not lost. They are intentionally not runnable:
each exits immediately with migration guidance because the production SDK no
longer contains the hudhook launcher or payloads.

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-client.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-real-client.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-game-input-manual.ps1
```

Use the current production cases instead:

- D3D11 exact-PID SDK gate:
  `libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-client-sdk-process-start-injection.ps1`;
- D3D12 SDK gate:
  `libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk.ps1`;
- hands-on permitted real-game testing: run `npm run dev`, arm the ReShade
  target by executable name or exact PID, and use **Ctrl+I** to toggle
  interception.

The markers below are the historical evidence contract from when the two
controlled real-client launchers were runnable:

- `HUDHOOK_CLIENT_OVERLAY_SESSION_READY` in `electron-client.stdout.log`;
- `HUDHOOK_CLIENT_HUDHOOK_CONFIGURED`;
- `HUDHOOK_CLIENT_HUDHOOK_INJECTOR_STARTED`;
- `HUDHOOK_CLIENT_HUDHOOK_INJECTOR_RETURNED`;
- `HUDHOOK_CLIENT_HUDHOOK_TARGET_CONNECTED pid=<controlled-host-pid>`;
- `Electron overlay metadata selected`;
- `window_name=ExampleMainOverlay`;
- `Electron frame received from hudhook transport`;
- `Electron frame uploaded to GPU`;
- `Electron overlay composed at native bounds`.

The historical runner verified that the session-ready and runtime-configured
markers preceded the injector start, and that injector start preceded both
request return and exact target connection. Request return and target connection
may race with each other.
`HUDHOOK_CLIENT_HUDHOOK_INJECTOR_RETURNED` proves only that the client's injection
request completed; the exact-PID connection and payload log remain the evidence
that the DLL actually loaded and rendered.

The payload composes all announced windows in registration order. Window
selection belongs to the Electron producer rather than ambient process
environment.

## Run the lifecycle regression demo

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-window-lifecycle.ps1
```

This focused producer loads the client's actual `ExampleMainOverlay` HTML through
the public overlay SDK. It creates a transparent 640 x 360 window at `(64, 72)`
and waits for the injected payload's `game.process` connection event before
starting its timers. It then moves to `(176, 128)`, closes, and re-registers.
The runner requires bounds, close, clear, reselection, and resume proof before
the verification deadline.

The corresponding payload markers are:

- `Electron overlay bounds updated`;
- `Electron overlay window closed`;
- `Electron overlay composition cleared`;
- `Electron overlay metadata reselected`;
- `Electron overlay composition resumed`.

## Run the deterministic multi-window regression

Launch the attached 125% proof:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-multiwindow-automated-125.ps1
```

This attached mode launches two real offscreen Electron pages with aligned,
overlapping text fields below both SDK captions. Their public bounds are DIP:
green BACK is the 640 x 360 `ExampleMainOverlay` at `(64, 72)`, registered
first; blue FRONT is the 320 x 220 `ExamplePopupOverlay` at `(200, 136)`,
registered second. At the forced 1.25 factor, the compositor receives physical
rectangles `(80, 90, 800 x 450)` and `(250, 170, 400 x 275)`. The runner requires
the producer's exact requested/display/DPR/frame-size scale marker, then an
`Electron overlay scene composed` marker with the initial
`ExampleMainOverlay>ExamplePopupOverlay` back-to-front order before sending
synthetic input.

The proof then verifies all of the following against role-specific Electron
markers and per-window payload diagnostics:

- the overlap click, focus packet, and typed value reach FRONT only;
- FRONT retains left-button pointer capture while the pointer moves outside its
  bounds, and BACK receives no pointer packet during that capture;
- clicking BACK's exposed opaque client surface below its caption raises it
  inside the payload, recomposes
  FRONT>BACK without producer lifecycle traffic, and routes the next overlap
  click to BACK only before any producer command;
- BACK close/re-register preserves its append-top order and BACK-only keyboard
  routing, then FRONT close/re-register restores FRONT to the top;
- hiding FRONT removes only that surface while BACK remains composed, and showing
  FRONT appends it on top again;
- after the original-bounds lifecycle checks, dragging FRONT's striped caption
  handle by a physical delta equivalent to `(+96, +72)` DIP moves its
  payload-local render/router rect without DOM input, producer lifecycle traffic,
  or a host `window.bounds` message; FIFO-drained page barriers bracket the
  no-leak check, then the moved text target round-trips to FRONT at its unchanged
  local DIP coordinates while the vacated caption point routes to BACK;
- interception release is acknowledged after the disabled render boundary, then
  released Escape closes the controlled host normally;
- the exact controlled Electron and host processes are gone after cleanup.

This remains evidence for one uniformly forced Electron scale factor, not a real
mixed-monitor proof. The SDK's per-window desired/active transition machinery is
covered independently, and the controlled host now establishes Per-Monitor-V2
awareness before creating its HWND, calculates the initial outer rect with
`AdjustWindowRectExForDpi`, and applies the `WM_DPICHANGED` suggested rectangle.
However, the current validation machine exposes only one 100% virtual display.
The forced 1, 1.25, 1.5, and 2 runs are uniform regressions; they do not move the
target or backing BrowserWindows between differently scaled hardware.
Target-HWND/client-origin ownership, backing-window placement, multi-target
geometry routing, physical/VM mixed-monitor behavior, and Electron 42 OSR
semantics remain unverified.

Rust tests additionally prove registration deduplication, exact-name filtering,
atomic scene metadata, alpha-zero fallthrough to a lower window, focused-keyboard
routing, and capture-owner cleanup. The completed design and acceptance record is
in
[`doc/hudhook-multiwindow-compositor-handoff.md`](../../doc/hudhook-multiwindow-compositor-handoff.md).

## Run the manual multi-window demo

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-multiwindow-manual.ps1
```

No separate `client:dev` process is needed. Wait for the runner to print
`Manual multi-window input is ready.` FRONT is blue and initially overlaps green
BACK. Drag the striped `:: DRAG BACK ::` or `:: DRAG FRONT ::` caption handle to
move that composited window. Click and type in either text field, then press in a
field and drag outside the window as a separate capture-owner test. Use the
in-page `Hide`, `Show`, and `Raise` controls to inspect composition and routing
changes yourself.

Close the controlled host with its title-bar X when finished. Escape and Alt+F4
are intercepted while the host is focused. Focus loss temporarily suspends
interception and refocusing resumes it. This mode always remains attached and
cleans only its per-run Electron process tree and controlled host.

## Run the manual input demo

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-manual.ps1
```

No separate `client:dev` process is needed. The runner builds and launches the
focused Electron producer, controlled D3D11 host, injector, and payload itself.
Wait until the runner prints:

```text
Manual input is ready.
```

The producer's redirected stdout log records the underlying
`HUDHOOK_CLIENT_INPUT_MANUAL_READY` marker.

The real `ExampleMainOverlay` text field is then interactive inside the
controlled host. Click the field, type into it, and scroll over it to exercise
the mouse, keyboard, character, and wheel paths. This mode does not synthesize
input and does not automatically release interception.

Close the controlled host with its title-bar X when finished. Escape and
Alt+F4 are intercepted and forwarded to Electron while this mode is active, so
they do not close the host. Moving focus away temporarily suspends interception;
returning to the host reapplies the guarded filter, and the runner reports both
state changes. Manual mode remains attached until the host closes, even if
`-Wait` is omitted, and then cleans only the Electron process tree and host that
it launched. The test-case launcher selects the attached behavior for you.

## Native ImGui input probe

The payload currently renders a standalone **NATIVE IMGUI INPUT PROBE** in the
lower-left corner above all Electron textures. It is intentionally independent
of Electron composition and input forwarding. The panel contains one large
native ImGui button and reports `IDLE` / `HOVERED` / `ACTIVE`, click count,
numeric `io.mouse_pos`, `io.want_capture_mouse`, effective interception, and
software-cursor state. Each accepted click also writes
`native ImGui input probe clicked` to the payload log.

The archived real-game client launcher remains discoverable at:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-game-input-manual.ps1
```

It is not runnable and exits immediately with the current ReShade workflow. The
following steps preserve the historical acceptance procedure: launch and attach
to the game through the then-current client, then first hover and click the probe
with interception off. Then press **Ctrl+I**, confirm the panel says
`INTERCEPTION ENABLED`, and test two independent gates:

1. The software cursor tracks, the native probe reaches `HOVERED`/`ACTIVE` and
   increments its click count, and the Electron overlay accepts click, drag, and
   wheel input.
2. The game camera and game UI do not move, hover, or click underneath those
   overlay interactions.

The PID-specific payload log beside the staged DLL must contain
`synchronous owned pointer input reached ImGui and Electron`; clicking the probe
also writes `native ImGui input probe clicked`. When the game polls User32 or
drains buffered raw input, the
log additionally reports `process-wide mouse polling suppression observed` with
per-API call and masked counts, including `raw_buffer_calls` and
`raw_buffer_masked`. While holding a mouse button,
toggle interception off and repeat once after focus loss/regain to verify that
neither ImGui nor Electron capture stays stuck. Finally press **Ctrl+I** again
and verify normal game input returns.

Gate 1 exercises the synchronous WndProc/raw-input seam added by the local
hudhook 0.9.1 patch. Gate 2 additionally exercises the bounded process adapter
for mouse-button polling, a game-only off-client cursor, and buffered raw mouse
records. The `GetRawInputBuffer` behavior follows ReShade's maintained blocking
pattern, while the original records are copied into the shared ImGui/Electron
queue before the game-facing copy is neutralized. The swap-chain HWND is bound
to that queue before the replacement WndProc is installed, and interception
seeds the route with the unfiltered client cursor so the first buffered click is
not route-dependent. DirectInput, broader Unity Input System device APIs, and
other device paths are not covered; if the game still reacts while the new
raw-buffer counters stay zero, that recorded stop signal is why the production
host moved to ReShade.

## Run the deterministic input regression

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-automated.ps1
```

`-ClientInput` uses the same real `ExampleMainOverlay` page and waits for the
injected target's `game.process` event before requesting input interception. The
runner first rebuilds the Electron overlay SDK so its project-owned TypeScript
input translation fixes cannot be stale. The retained proof page and controlled
producer both arm the same visible DOM target; the deterministic producer
additionally validates signed coordinates and the exact wheel field contract. The page
reports the text field's live DOM rectangle; the runner maps its center
through the overlay bounds and controlled host client area instead of relying on
hard-coded screen coordinates. It activates only the host it launched and uses
Win32 `SendInput` to click and focus the field, type
`hudhook-input-proof-2026`, and deliver a vertical wheel event.

The runner then sends Escape twice. The first Escape must be forwarded to the
focused Electron page while the controlled host remains alive. A per-run control
sentinel asks the producer to call `session.input.release()`; after both the
Electron acknowledgement and explicit payload render-boundary evidence, the
second Escape must
close the host normally. This mode is always attached and cleans only the exact
host and Electron process tree carrying its per-run token, whether or not `-Wait`
is supplied.

Electron stdout proof includes:

- `HUDHOOK_CLIENT_INPUT_TARGET x=<x> y=<y> width=<w> height=<h> ...`;
- `HUDHOOK_CLIENT_INPUT_FOCUSED` and `HUDHOOK_CLIENT_INPUT_CLICKED`;
- `HUDHOOK_CLIENT_INPUT_VALUE value=hudhook-input-proof-2026`;
- `HUDHOOK_CLIENT_INPUT_WHEEL deltaY=<delta>`;
- `HUDHOOK_CLIENT_INPUT_ESCAPE_FORWARDED`;
- `HUDHOOK_CLIENT_INPUT_LIFECYCLE_COMPLETE`.

The PID-specific payload log must also prove interception enable/release, overlay
focus, and mouse and keyboard forwarding. The original single-window input
regression remains a forced 1:1 historical baseline; the multi-window command
above is the bounded 1.25 coordinate-contract proof.

This end-to-end mode proves left-click/focus ordering, typed text, vertical wheel,
intercepted and released Escape, acknowledgements, and normal host exit. Rust
router/bridge tests separately cover horizontal-wheel conversion, pointer capture
outside the overlay bounds, outside-overlay swallowing, right/middle buttons,
system keys and extended character messages, synthetic releases on capture
cancellation/lifecycle cleanup, guarded filter transitions, adjacent mouse-move
coalescing, and at-most-once input retry classification. The TypeScript translation
test covers horizontal-wheel `deltaX`; neither horizontal wheel nor X buttons
are claimed by the DOM end-to-end proof.

Hudhook 0.9.1 publishes filter changes only during `Present`. The runner waits for
the payload's applied-filter marker rather than inferring that boundary from a
sleep. Enable and release use filtered arming/disarming drains before changing
Electron routing; each acknowledgement follows the matching applied filter marker.
Input racing either boundary may be dropped, but is never sent to both destinations.
If a target stops presenting immediately after focus loss, the upstream filter
cannot publish fail-open state until presentation resumes. Pointer capture in this
first slice is project-owned routing state: it preserves drags outside the overlay
rectangle while messages still reach the target HWND, but cross-HWND capture
remains compatibility work.

Outbound game packets leave the render callbacks through the bridge's bounded
queues and nonblocking loopback worker. Failed idempotent focus/intercept controls
retry after 250 ms; non-idempotent `game.input` packets are never replayed after
an ambiguous failure, so a transport fault can drop input but cannot duplicate a
click or key.

## Run the minimal diagnostic producer

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-electron-diagnostic.ps1
```

This original synthetic frame producer remains useful for a quick SDK/transport/upload
smoke test. Its readiness marker is `HUDHOOK_ELECTRON_DEMO_READY` in
`electron-demo.stdout.log`.

## Runner lifetime

Running an Electron mode other than `-ClientInput`, `-ClientInputManual`,
`-ClientMultiWindow`, or `-ClientMultiWindowManual` without `-Wait` returns after
verification and leaves the controlled host and only that mode's Electron process
tree alive for inspection. Close them before the next run. All four input modes
remain attached and clean their owned process trees: manual modes wait for the
title-bar X, while deterministic modes drive the host to normal exit. Only one
controlled runner or Electron overlay producer may run at a time. Do not run these
modes concurrently because this POC publishes one well-known discovery document
for the active loopback session.

## Run the hook-only fallback

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-hook-only.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-hook-only.ps1
```

This starts only the controlled host and payload. With no Electron producer, the
panel shows the generated teal checkerboard. The runner waits for the current
process's payload log to prove texture upload and first-frame rendering; it fails
instead of trusting the injector's return code alone. Resize the window to
exercise hudhook's swap-chain handling. Press Escape in the host to close it.

The payload creates a PID-suffixed log beside the injected DLL:

```text
build/hudhook-imgui-overlay/run/dx11/hudhook_imgui_overlay_dx11-<pid>.log
build/hudhook-imgui-overlay/run/dx12/hudhook_imgui_overlay_dx12-<pid>.log
```

Useful markers include:

- `hudhook overlay initialization worker started`;
- `generated RGBA texture uploaded`;
- `first ImGui frame rendered`;
- `ImGui display size changed`.

Set `HUDHOOK_POC_LOG` in the host's environment to override the default `info,hudhook=debug` tracing filter. Avoid `hudhook=trace` for long sessions because the graphics hooks trace every presentation.

Hudhook 0.9.1's D3D12 state machine logs one initial `Initialization context
incomplete` / render-error pair before the first `Present` is associated with
the observed command queue. In the controlled host it initializes on the next
frame. The launchers require later texture-upload/composition/first-frame proof
and do not treat the injector return or that transient message as success.

If the payload directory is not writable during a manual test, logging falls back to `%TEMP%\electron-game-overlay`.

## Manual injection

The injector accepts one exact target selector and an explicit backend:

```powershell
Push-Location .\build\hudhook-imgui-overlay\run\dx11
.\hudhook_overlay_injector.exe `
  --process game.exe `
  --backend d3d11
Pop-Location
```

or:

```powershell
Push-Location .\build\hudhook-imgui-overlay\run\dx11
.\hudhook_overlay_injector.exe `
  --title "Exact window title" `
  --backend d3d11 `
  --dll .\hudhook_imgui_overlay_dx11.dll
Pop-Location
```

hudhook 0.9.1 selects the first exact process-name match. Prefer `--title` when more than one matching process may exist.

The message `Injection request completed` means hudhook's remote-thread injection call returned without a Windows API error. The visible panel and payload log are the actual evidence that the DLL loaded and rendered.

### Injector limitation

The controlled runner gives the target a bounded 750 ms warm-up after HWND/DPI
readiness. The test host publishes its window just before its first stable
`Present`; racing that boundary can fault upstream D3D11 hook installation before
the payload produces a log. The warm-up reduces this controlled startup race but
does not turn the upstream injector into a production guarantee; a run with no
fresh payload evidence still fails.

The upstream hudhook 0.9.1 injector is sufficient for this controlled POC, but
was rejected as a production launcher. It does not reject a zero return from
remote `LoadLibraryW`, and its fixed `MAX_PATH` copy reads beyond the source path
buffer. The controlled runner compensates for the first issue by requiring fresh
payload evidence. A project-owned replacement was considered during the POC;
the selected production path now uses the pinned ReShade injector instead.

The injector fixes do not require modifying hudhook's graphics hooks. The
separate local path patch owns synchronous Win32 input, bounded process-input
suppression, and guarded teardown ordering for those custom hooks. Runtime DLL
ejection remains outside the supported POC path; target-process exit is the
tested teardown.

## Historical accepted scope

The completed hudhook milestone proved:

- D3D11 and D3D12 injection and Dear ImGui rendering through hudhook 0.9.1,
  with local Win32-input and guarded-teardown patches;
- the then-current real Electron client's overlay-session startup path and
  opt-in ownership of backend-specific hudhook injection requests; those
  client-bound launchers are now archived;
- simultaneous Electron windows over the authenticated Node/Rust loopback transport,
  with raw BGRA frame packets, JSON controls, registration-order back-to-front
  composition, deduplication, append-on-register,
  and click-to-front intent generations;
- signed physical-pixel bounds, transparency, and premultiplied-BGRA correction;
- DIP-to-physical conversion for complete rectangles and caption hit regions,
  with signed physical-to-DIP conversion for returned input;
- content-surface tracking through `getContentBounds()`, per-window
  desired/active scale state, bitmap-authoritative one-pixel rounding tolerance,
  and renderer-acknowledged cropped-capture recovery for ambiguous transitions;
- routing-time scale tags on input packets with legacy active-scale fallback;
- `rasterChanged` scene suppression between committed geometry and its matching
  frame, plus checked packet dimensions and exact frame byte counts;
- alpha-aware hit testing that can fall through to a lower Electron window;
- one atomic immutable scene/router publication per lifecycle, metadata, frame, or
  stack mutation;
- immediate per-window bounds metadata updates without redundant texture uploads;
- interactive SDK-caption dragging with atomic payload-local render/router bounds;
- isolated close, clear, re-register, reorder, and resume lifecycle handling;
- regular Win32 left/right/middle mouse, vertical/horizontal-wheel, keyboard,
  system-key, character, focus, and global input interception for the hit/focused
  Electron window, plus a project-owned per-window multi-button capture owner;
- a per-window GPU texture cache with replacement when frame dimensions change;
- deterministic and manual multi-window proof modes with exact-process cleanup;
- diagnostics, resize handling, proof logging, and normal target exit.

Controlled D3D12 parity is now complete: the hook-only texture/first-frame proof,
live single-window input proof, repeated Electron texture updates, and the full
two-window routing/lifecycle/caption-drag proof pass against the D3D12 host. The
historical client acceptance also covered SDK-owned injection request
orchestration for both backends through launcher files that are now archived.
Those runs used the then-current SDK-owned runtime rather than the controlled
host's POC staging directory or client-owned launcher code. All three
client-bound launcher files now exit with migration guidance. The
controlled POC finish line is complete and revalidated. Its Gun Frog suppression
failure is retained as the host-selection record. The active client/SDK now uses
the shared Node/Rust loopback transport with the production ReShade runtime.
Hudhook payloads and its injector are not production build inputs, and the
superseded native binary and Node add-on packages have been removed. The POC's
D3D11/D3D12 input, multi-window, and lifecycle launchers remain runnable
historical regressions; the retained client launcher files remain discoverable
records only.

Post-POC hardening remains tracked, but does not block that finish line:

- raw-keyboard-only text generation, DirectInput, XInput,
  GameInput, gamepads, broader polling/device suppression, and faithful X1/X2 mouse-button delivery (Electron 16
  cannot represent those buttons through `sendInputEvent`, so interception
  intentionally swallows them);
- target-game display ownership, physical client-origin mapping, backing
  `BrowserWindow` placement, and per-target geometry routing;
- manual mixed-scale hardware/VM acceptance beyond the forced uniform
  1/1.25/1.5/2 regressions available on the current single 100% virtual display;
- safe deferred retirement of superseded GPU textures: hudhook 0.9.1 exposes
  texture load/replace but no texture-removal API;
- per-target rendezvous and a production same-user discovery-file threat model
  beyond the controlled one-producer, token-authenticated loopback session;
- broader D3D12 driver/debug-layer coverage for repeated texture replacement;
  the controlled adapter passes, while upstream 0.9.1 does not explicitly
  transition an existing shader-resource texture back to copy-destination;
- SDK-owned one-payload backend auto-detection with a typed explicit fallback
  for ambiguous targets, plus a production-quality project-owned injector beyond
  the controlled integration, including exact-PID target selection instead of
  the current controlled process-name selector;
- x86 targets and any anti-cheat compatibility work.

The input/interactivity design remains in
[`doc/hudhook-input-interactivity-handoff.md`](../../doc/hudhook-input-interactivity-handoff.md).
The completed multi-window design and acceptance record is in
[`doc/hudhook-multiwindow-compositor-handoff.md`](../../doc/hudhook-multiwindow-compositor-handoff.md).

Click-to-front order and caption-drag placement are payload-local because the
current wire schema has no persistent z-order or payload-to-producer bounds
field. The rendered and hit-test rect moves immediately, but the hidden Electron
`BrowserWindow` retains its producer-owned bounds. A reconnect or later producer
registration/bounds event can therefore restore that placement. Hide/show changes
the host registration list through the existing close/re-register lifecycle and
consequently affects later initialization too. CPU scene/router publication is
atomic, but a newly published alpha frame can precede its corresponding GPU upload
by one `Present`, creating a narrow visual-versus-hit-test timing window.

The controlled POC is finished. The Gun Frog rerun failed the game-suppression
boundary and is retained as the decision record that moved production ownership
to ReShade; it is not a pending hudhook acceptance item. Target-display/client-
origin ownership, manual mixed-scale hardware/VM acceptance, safe texture
retirement, and related geometry/DPI edge cases remain relevant only to retained
historical regression work.
The local hudhook fork changes Win32 input ownership and guarded hook teardown;
graphics rendering behavior and render backends remain the published 0.9.1
implementation. Replace the path patch with a pinned upstream revision after
the reusable lifecycle/input seams are contributed.
