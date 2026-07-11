# hudhook + ImGui D3D11 proof of concept

This standalone Windows x64 proof uses upstream [hudhook 0.9.1](https://github.com/veeenu/hudhook/tree/0.9.1) unchanged to inject a project-owned DLL, hook a D3D11 swap chain, and render Dear ImGui.

It deliberately does not install or load ReShade. The completed ReShade POC remains beside it as a separate reference implementation.

The payload renders:

- an always-visible diagnostics panel with frame and display information;
- every matching Electron offscreen window received through the repository's
  existing `electron-game-overlay` / `node-game-overlay` flow;
- a generated RGBA checkerboard while no Electron scene is available.

The compositor treats registration order as back-to-front. `overlay.init`
preserves that order, a new or duplicate `window` registration is deduplicated
and appended on top, and a pointer-down intent raises the hit window without a
new wire message. It draws each window at signed native bounds, alpha-hit-tests
transparent pixels so input can fall through to a lower Electron window, and
follows per-window bounds, close, and re-registration events. The IPC worker
publishes an immutable ordered scene and matching router state atomically;
hudhook's render thread maintains a texture cache keyed by native window ID.
Premultiplied BGRA frames are converted to straight RGBA before publication.

`HUDHOOK_ELECTRON_WINDOW`, when set, is an optional exact-name filter. Without
it, every announced window participates. The injected payload does not load the
legacy native renderer.

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
```

The script locates the build tools, enters the Visual Studio developer environment, builds the existing controlled D3D11 host, builds the Rust injector and payload, recreates the ignored run directory, and stages only these files in `build/hudhook-imgui-overlay/run/dx11`:

- `d3d11_overlay_test_host.exe`;
- `hudhook_imgui_overlay_dx11.dll`;
- `hudhook_overlay_injector.exe`;
- `THIRD_PARTY_NOTICES.md`.

The clean run directory intentionally contains no ReShade proxy, configuration, or add-on files.

## Run the real client integration (recommended)

From a regular PowerShell at the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Client -Wait
```

`-Client` builds the repository's real Electron application, launches it with the
opt-in `--start-overlay-session` flag, waits for its existing overlay session to
register `ExampleMainOverlay`, starts the controlled D3D11 host, injects the
hudhook payload, and requires fresh receipt, upload, selection, and composition
evidence in the host's PID-specific log.

Expected result: the real transparent `ExampleMainOverlay` is drawn inside the
controlled host at its native Electron bounds, with the diagnostics kept separate
in the top-right corner. Press Escape in the host when finished. With `-Wait`, the
runner stops only the Electron process tree it launched and returns the host exit
code.

Useful proof markers are:

- `HUDHOOK_CLIENT_OVERLAY_SESSION_READY` in `electron-client.stdout.log`;
- `Electron overlay metadata selected`;
- `window_name=ExampleMainOverlay`;
- `Electron frame received from node-game-overlay`;
- `Electron frame uploaded to GPU`;
- `Electron overlay composed at native bounds`.

Set `HUDHOOK_ELECTRON_WINDOW` before launching the runner to filter composition
and routing to one exact announced window name. Without it, the payload composes
all announced windows in registration order.

## Run the lifecycle regression demo

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientWindow -Wait
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

Make sure the optional single-window filter is absent, then launch the attached
proof:

```powershell
Remove-Item Env:HUDHOOK_ELECTRON_WINDOW -ErrorAction SilentlyContinue
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -Wait
```

This attached mode launches two real offscreen Electron pages with aligned,
overlapping text fields below both SDK captions: green BACK is the 640 x 360
`ExampleMainOverlay` at
`(64, 72)`, registered first; blue FRONT is the 320 x 220
`ExamplePopupOverlay` at `(200, 136)`, registered second. The runner requires an
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
  handle by `(+96, +72)` moves its payload-local render/router rect to
  `(296, 208)` without DOM input, producer lifecycle traffic, or a host
  `window.bounds` message; FIFO-drained page barriers bracket the no-leak check,
  then the moved text target routes to FRONT at its unchanged local `(150, 98)`
  coordinates while the vacated caption point routes to BACK;
- interception release is acknowledged after the disabled render boundary, then
  released Escape closes the controlled host normally;
- the exact controlled Electron and host processes are gone after cleanup.

Rust tests additionally prove registration deduplication, exact-name filtering,
atomic scene metadata, alpha-zero fallthrough to a lower window, focused-keyboard
routing, and capture-owner cleanup. The completed design and acceptance record is
in
[`doc/hudhook-multiwindow-compositor-handoff.md`](../../doc/hudhook-multiwindow-compositor-handoff.md).

## Run the manual multi-window demo

```powershell
Remove-Item Env:HUDHOOK_ELECTRON_WINDOW -ErrorAction SilentlyContinue
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindowManual -Wait
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
cleans only its per-run Electron process tree and controlled host; `-Wait` is kept
explicit in the documented command for consistency.

## Run the manual input demo

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInputManual -Wait
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
it launched. The documented command keeps `-Wait` explicit for consistency with
the other attached demos.

## Run the deterministic input regression

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
```

`-ClientInput` uses the same real `ExampleMainOverlay` page and waits for the
injected target's `game.process` event before requesting input interception. The
runner first rebuilds the Electron overlay SDK and x64 native add-on so its input
translation fixes cannot be stale. A proof-only page hook then validates signed
coordinates and the exact wheel field contract before enabling its DOM markers.
Normal uses of the example page do not install those listeners or log field text. The
page reports the text field's live DOM rectangle; the runner maps its center
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
focus, and mouse and keyboard forwarding. The controlled producer forces a 1:1
device scale for this first coordinate-contract regression.

This end-to-end mode proves left-click/focus ordering, typed text, vertical wheel,
intercepted and released Escape, acknowledgements, and normal host exit. Rust
router/bridge tests separately cover horizontal-wheel conversion, pointer capture
outside the overlay bounds, outside-overlay swallowing, right/middle buttons,
system keys and extended character messages, synthetic releases on capture
cancellation/lifecycle cleanup, guarded filter transitions, adjacent mouse-move
coalescing, and at-most-once input retry classification. The native translation
self-test covers horizontal-wheel `deltaX`; neither horizontal wheel nor X buttons
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

Outbound `WM_COPYDATA` runs only on the IPC worker with a two-second
`SendMessageTimeoutW`. Failed idempotent focus/intercept controls retry after 250 ms;
non-idempotent `game.input` packets are never retried after an ambiguous failure,
so a transport fault can drop input but cannot duplicate a click or key. Explicit
host rejection is not retried.

## Run the minimal diagnostic producer

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Wait
```

This original synthetic frame producer remains useful for a quick SDK/IPC/upload
smoke test. Its readiness marker is `HUDHOOK_ELECTRON_DEMO_READY` in
`electron-demo.stdout.log`.

## Runner lifetime

Running an Electron mode other than `-ClientInput`, `-ClientInputManual`,
`-ClientMultiWindow`, or `-ClientMultiWindowManual` without `-Wait` returns after
verification and leaves the controlled host and only that mode's Electron process
tree alive for inspection. Close them before the next run. All four input modes
remain attached and clean their owned process trees: manual modes wait for the
title-bar X, while deterministic modes drive the host to normal exit. Only one
controlled runner or Electron overlay host may run at a time. Do not run these
modes concurrently because the current native add-on uses a fixed IPC host name.

## Run the hook-only fallback

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-dx11.ps1
```

This starts only the controlled host and payload. With no Electron producer, the
panel shows the generated teal checkerboard. The runner waits for the current
process's payload log to prove texture upload and first-frame rendering; it fails
instead of trusting the injector's return code alone. Resize the window to
exercise hudhook's swap-chain handling. Press Escape in the host to close it.

The payload creates a PID-suffixed log beside the injected DLL:

```text
build/hudhook-imgui-overlay/run/dx11/hudhook_imgui_overlay_dx11-<pid>.log
```

Useful markers include:

- `hudhook overlay initialization worker started`;
- `generated RGBA texture uploaded`;
- `first ImGui frame rendered`;
- `ImGui display size changed`.

Set `HUDHOOK_POC_LOG` in the host's environment to override the default `info,hudhook=debug` tracing filter. Avoid `hudhook=trace` for long sessions because the D3D11 hook traces every presentation.

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

The upstream hudhook 0.9.1 injector is sufficient for this controlled POC, but it is not the intended production launcher. It does not reject a zero return from remote `LoadLibraryW`, and its fixed `MAX_PATH` copy reads beyond the source path buffer. The controlled runner compensates for the first issue by requiring fresh payload evidence, but the production launcher should use a small project-owned injector—or an upstream hudhook fix—that sizes the remote buffer from the actual path and validates every Windows API result.

This does not require forking or modifying hudhook's graphics hooks, renderer lifecycle, or ImGui integration.

## Current scope

This milestone now covers:

- D3D11 injection and Dear ImGui rendering through upstream hudhook 0.9.1;
- the real built Electron client's existing overlay-session startup path;
- simultaneous Electron windows over the existing Node/shared-memory IPC, with
  registration-order back-to-front composition, deduplication, append-on-register,
  and click-to-front intent generations;
- signed native bounds, transparency, and premultiplied-BGRA correction;
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

Remaining work is:

- raw-input-only games, DirectInput, XInput, GameInput, gamepads, and faithful
  X1/X2 mouse-button delivery (Electron 16 cannot represent those buttons through
  `sendInputEvent`, so interception intentionally swallows them);
- DPI and device-scale-factor reconciliation beyond the controlled 1:1 setup;
- safe deferred retirement of superseded GPU textures: hudhook 0.9.1 exposes
  texture load/replace but no texture-removal API;
- D3D12 and eventual one-payload backend auto-detection;
- a production-quality project-owned injector;
- x86 targets and any anti-cheat compatibility work.

The input/interactivity design remains in
[`doc/hudhook-input-interactivity-handoff.md`](../../doc/hudhook-input-interactivity-handoff.md).
The completed multi-window design and acceptance record is in
[`doc/hudhook-multiwindow-compositor-handoff.md`](../../doc/hudhook-multiwindow-compositor-handoff.md).

Click-to-front order and caption-drag placement are payload-local because the
existing IPC schema has no persistent z-order or payload-to-producer bounds
field. The rendered and hit-test rect moves immediately, but the hidden Electron
`BrowserWindow` retains its producer-owned bounds. A reconnect or later producer
registration/bounds event can therefore restore that placement. Hide/show changes
the host registration list through the existing close/re-register lifecycle and
consequently affects later initialization too. CPU scene/router publication is
atomic, but a newly published alpha frame can precede its corresponding GPU upload
by one `Present`, creating a narrow visual-versus-hit-test timing window.

The next shared compositor work is arbitrary-DPI/device-scale reconciliation and
safe texture retirement. D3D12 and a production project-owned injector follow.
A hudhook fork is justified only if testing reproduces a required graphics-hook
change that cannot live in this project or be contributed upstream.
