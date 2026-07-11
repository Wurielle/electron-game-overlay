# hudhook + ImGui overlay proof of concept

> Current status plus historical acceptance record. Sections that describe the
> Node add-on, named mappings, or mutexes document the superseded baseline. The
> active implementation uses the public Electron SDK over an authenticated
> Node/Rust loopback transport with direct BGRA frame packets; see the
> [POC README](../poc/hudhook-imgui-overlay/README.md) for current launchers.

## Status

The controlled D3D11 and D3D12 milestones and the focused real-client transport migration are implemented in [`poc/hudhook-imgui-overlay`](../poc/hudhook-imgui-overlay/README.md). The initial D3D11 hook, Electron, and input proofs were verified on July 10, 2026; the ordered multi-window, controlled D3D12 parity, and replacement transport were verified on July 11, 2026.

Verified results:

-   the Windows x64 MSVC release payload and injector build from the locked Cargo workspace;
-   the clean controlled host contains no ReShade runtime, proxy, configuration, or add-on;
-   injection by exact window title reaches hudhook's D3D11 hooks;
-   the generated 128 x 128 RGBA texture uploads successfully;
-   the first ImGui frame renders at 1280 x 720;
-   a programmatic resize updates the ImGui display size to 884 x 561 without hanging the host;
-   the controlled host establishes Per-Monitor-V2 awareness before HWND creation, verifies the effective context, derives its initial outer size from the requested client size with `AdjustWindowRectExForDpi`, and applies the `WM_DPICHANGED` suggested rectangle;
-   the controlled host remains responsive and accepts a normal window close;
-   the diagnostic producer and repository's real built Electron client publish offscreen windows through the public `electron-game-overlay` session and authenticated Node/Rust loopback transport;
-   the real-client runner requires `ExampleMainOverlay` evidence while the default unfiltered bridge composes every announced client window in registration order;
-   the hudhook payload authenticates to the project-owned loopback endpoint, receives direct BGRA frames on a worker thread, converts Electron's premultiplied pixels to straight RGBA, atomically publishes an ordered scene/router snapshot, uploads per-window textures through hudhook, and composes them at native bounds;
-   a transparent window moves from `(64, 72)` to `(176, 128)`, disappears after the SDK's `window.close`, and resumes after the same `BrowserWindow` re-registers and publishes a replacement frame;
-   `OverlaySession.input.intercept()` drives hudhook's guarded Win32 input filter; while it blocks the controlled host, the payload front-to-back hit-tests and forwards left/right/middle mouse, vertical/horizontal wheel, keyboard, system-key, character, and focus packets to the hit/focused Electron window, and project-owned router state maintains a per-window multi-button capture owner;
-   the deterministic `-ClientInput` runner proves click/focus, typed text, vertical wheel, intercepted Escape, release acknowledgement, released Escape, and clean process exit;
-   router, bridge, and native-translator tests cover outside-bounds capture/release, outside-overlay swallowing, right/middle buttons, horizontal wheel, extended characters, synthetic cancellation/cleanup releases, guarded filter transitions, at-most-once input retry classification, and adjacent mouse-move coalescing;
-   `-ClientMultiWindow -DeviceScaleFactor 1.25 -Wait` proves two overlapping windows, registration order, a complete DIP-to-physical frame/metadata contract, physical-to-DIP input, caption dragging, an exposed BACK click-to-front transition without producer lifecycle traffic, topmost-only input, focused keyboard routing, out-of-bounds capture, re-registration, isolated hide/show, release, normal exit, and exact cleanup;
-   producer windows use content rather than outer bounds, independently track desired and active display scale, keep old-scale input coherent while a transition is pending, and commit full rect/caption/border/constraint metadata only with a matching OSR paint;
-   ambiguous scale transitions use renderer DPR/viewport acknowledgement plus a cropped `capturePage()` barrier, while per-packet scale tags keep already queued input on its routing-time scale and preserve an active-scale fallback for legacy packets;
-   raster-changing `window.bounds` updates suppress the stale compositable raster without changing stack order, while the framed transport validates dimensions and exact BGRA byte counts before accepting a replacement frame;
-   `-ClientMultiWindowManual -Wait` exposes the overlapping pages and their hide/show/raise controls for hands-on testing;
-   the integrated diagnostic, `-Client`, `-ClientWindow`, `-ClientInput`, and multi-window runners require the exact host PID's receipt, upload, composition, and applicable lifecycle/input markers and safely clean up their Electron process trees in attached runs.

No hudhook fork was required. The allowed-application smoke tests remain separate compatibility work. ReShade coexistence is not a gate for this path; the earlier concern was about avoiding a proxy-name/runtime collision, which runtime hudhook injection already avoids.

The controlled POC still uses hudhook's upstream injector. Its implementation does not validate a zero return from remote `LoadLibraryW` and copies a fixed `MAX_PATH` byte count from a shorter source buffer. The controlled runner therefore requires fresh texture-upload and first-frame log evidence. A production launcher should correct that small injection seam in project code or upstream; it does not require a fork of hudhook's graphics-hook/rendering stack.

The first implementation should consume the released `hudhook` crate unchanged. Pin the exact release and commit `Cargo.lock` so the experiment remains reproducible. A maintained project fork is a fallback only if the proof exposes a concrete upstream limitation that cannot reasonably be handled in project code or contributed upstream.

The verified target is Windows x64 with separate D3D11 and D3D12 payloads. D3D9 remains available in hudhook as a possible compatibility fallback, but it is not required to answer this proof-of-concept question.

## Question this POC answers

Can a small, independently injected DLL use upstream hudhook to enter a D3D11 or D3D12 application's render path and draw a stable Dear ImGui overlay without installing or loading ReShade?

The minimum useful answer is deliberately narrow:

-   inject a project-owned DLL into a controlled graphics host;
-   let unmodified hudhook own the graphics hooks and ImGui backend lifecycle;
-   draw an always-visible ImGui diagnostics panel;
-   upload and draw one generated RGBA texture;
-   replace it with an ordered scene of Electron offscreen surfaces and native window state carried by the project-owned loopback transport;
-   survive window and swap-chain resize;
-   report enough diagnostics to distinguish injection, hook, initialization, and rendering failures;
-   let the target close cleanly.

The D3D11 and controlled D3D12 seams and an interactive ordered multi-window Electron compositor are now proven, including uniformly forced scale regressions and the bounded producer-window/runtime transition foundation. Production-wide game compatibility, target-display/client-origin ownership, real mixed-monitor acceptance, resize-safe texture retirement, broader input APIs, and a production injector remain later work.

## Decision

Use [hudhook 0.9.1](https://github.com/veeenu/hudhook/tree/0.9.1) as released for the first attempt.

This is intentionally different from the completed [ReShade POC](../poc/reshade-imgui-overlay/README.md):

| Concern | ReShade baseline | hudhook POC |
| --- | --- | --- |
| Process entry | ReShade proxy DLL | Project injector using hudhook's injector API |
| Graphics hooks | ReShade runtime | Upstream hudhook |
| ImGui lifecycle | ReShade-managed context | Upstream hudhook render loop |
| Texture upload | ReShade resource API | hudhook `RenderContext` |
| Runtime installation | ReShade files beside the host | One project DLL injected at runtime |
| Initial backends | D3D11 baseline | D3D11, then D3D12 |

The ReShade add-on, build instructions, and controlled D3D11 executable remain in the repository as a known-good reference. The hudhook isolation test must not load ReShade.

## Why no fork is needed yet

The public hudhook API already provides the pieces required by this experiment:

-   process lookup and DLL injection;
-   D3D11 and D3D12 hook implementations;
-   an `ImguiRenderLoop` application seam;
-   a `RenderContext` texture API;
-   Win32 input integration for native ImGui widgets;
-   hook shutdown and DLL ejection support.

Our overlay panel, injector command line, logging, generated test texture, and IPC integration all belong in project code. None of those required modifying hudhook.

Using two backend-specific DLLs is acceptable for the POC. Automatic graphics API discovery and one universal payload are production concerns and should not force a fork before the basic hook/render path is tested.

## Scope

### Included

-   Windows 10 or newer;
-   x64 injector, payload, and target;
-   backend-specific D3D11 and D3D12 payloads;
-   late injection by exact process name or window title;
-   one native ImGui diagnostics window;
-   one generated checkerboard or test-card texture;
-   one or more Electron offscreen windows from a controlled producer or the real built client;
-   transparent premultiplied-BGRA conversion and ordered native-bounds composition;
-   per-window move, close, re-register, append-top, and click-to-front lifecycle handling;
-   front-to-back alpha hit testing, focused-keyboard routing, regular Win32
    left/right/middle mouse, vertical/horizontal-wheel, system-key, character,
    focus, and global interception behavior, plus a project-owned per-window
    multi-button pointer-capture owner;
-   atomic immutable scene/router publication and a GPU texture cache keyed by window ID;
-   authenticated loopback interoperability between the Node SDK and Rust payload, with direct framed BGRA delivery;
-   resize and clean target-exit tests;
-   latest-frame CPU copy/conversion away from the render thread.
-   independent desired/active display scale per producer window with matching-paint transition commit;
-   compatible full-geometry `window.bounds` updates without scene reordering and dimension/length-checked frame replacement;
-   PMv2-aware controlled D3D11 and D3D12 hosts with `WM_DPICHANGED` handling.

### Not included yet

-   target-game HWND display ownership, physical client-origin mapping, backing `BrowserWindow` placement, and per-target geometry routing;
-   real mixed-scale physical/VM acceptance; the current validation machine exposes only one 100% virtual display, so forced 1/1.25/1.5/2 runs remain uniform regressions;
-   safe old-texture retirement; hudhook 0.9.1 has no texture-removal operation;
-   raw-input translation, DirectInput, XInput, GameInput, gamepads, and faithful
    X1/X2 delivery through Electron 16;
-   automatic D3D11/D3D12 selection in one DLL;
-   x86 payloads;
-   D3D10, Vulkan, or OpenGL;
-   anti-cheat bypass or protected-process support;
-   proxy DLL installation beside a game;
-   a claim that every game or every third-party overlay combination is supported;
-   PID selection or a replacement for hudhook's injector implementation.

The existing IPC schema has no persistent z-order field, so click-to-front state
is local to the injected payload and reconnect restores `overlay.init`
registration order. CPU scene/router publication is atomic, but a new alpha frame
can precede its matching GPU upload by one `Present`.

## Planned artifacts

Implementation should live under `poc/hudhook-imgui-overlay/` and produce:

-   `hudhook_imgui_overlay_dx11.dll`;
-   `hudhook_imgui_overlay_dx12.dll` in the D3D12 milestone;
-   `hudhook_overlay_injector.exe`;
-   a clean test-host directory containing only the controlled host and hudhook artifacts;
-   a log containing injector and payload lifecycle events;
-   a README with exact build, run, resize, eject, and troubleshooting instructions.

The POC may use a Cargo workspace with one shared overlay crate and small backend-specific `cdylib` entry points. Backend-specific entry points keep upstream hudhook usage straightforward and make test results unambiguous.

## Controlled test host

Reuse the existing D3D11 host from `poc/reshade-imgui-overlay` so both experiments exercise the same target. Preserve the ReShade POC and its executable.

Build it from a Visual Studio Developer PowerShell at the repository root:

```powershell
Push-Location poc/reshade-imgui-overlay
cmake --preset vs2022-x64
cmake --build --preset relwithdebinfo
Pop-Location
```

For the hudhook isolation test, copy only `d3d11_overlay_test_host.exe` into a clean directory such as `build/hudhook-imgui-overlay/test-host/`. Do not launch the copy beside a ReShade proxy DLL, `ReShade.ini`, or `.addon64` file.

The controlled host has the window title `Controlled D3D11 overlay test host`. Resize its window to exercise swap-chain lifecycle handling and press Escape to close it.

The project-owned D3D12 host mirrors that boundary with a BGRA8 flip-discard swap chain, deterministic animated background, hardware/WARP selection, fenced per-buffer command allocators, and GPU-idle `ResizeBuffers`.

## Proposed implementation

### Payload

Implement a small `ImguiRenderLoop` that owns only POC state:

-   backend label;
-   rendered frame counter;
-   overlay visibility state;
-   generated texture handle;
-   last observed display dimensions.

The always-visible panel should show at least:

-   `hudhook + ImGui POC`;
-   D3D11 or D3D12;
-   current frame count;
-   current ImGui display dimensions;
-   whether the generated texture loaded.

Create the generated texture through hudhook's public `RenderContext` API. Drawing both widgets and an image tests the two capabilities needed by the later Electron compositor without introducing IPC yet.

### Injector

Wrap hudhook's existing process injection support in a small executable. The intended operator interface is:

```text
hudhook_overlay_injector.exe \
  --process d3d11_overlay_test_host.exe \
  --backend d3d11
```

An exact `--title` selector may also be exposed because hudhook supports process lookup by window title.

The injector should:

1. resolve the selected backend DLL to an absolute path;
2. select the target by exact executable name or exact window title using hudhook's public API;
3. print the selector and DLL path;
4. report whether hudhook's injection call completed or return the full Windows error;
5. explain that a payload log or rendered first frame is the proof that the DLL actually loaded;
6. return a non-zero exit code on failure.

No graphics-hook or injection implementation should be copied out of hudhook for this milestone. hudhook 0.9.1 selects the first exact process-name match and does not expose PID selection; robust ambiguity handling can be added later without changing the hook/render conclusion.

### Diagnostics

The injector and payload should make these states distinguishable:

-   target not found;
-   hudhook's injection call completed or returned an error;
-   payload initialization began, proving that the DLL loaded;
-   hook installation and renderer messages captured from hudhook's tracing output;
-   first frame rendered;
-   texture creation succeeded or failed;
-   display dimensions changed after a resize;
-   target shutdown reached payload detach handling where observable.

Use a POC-specific tracing/logging configuration. Do not write `ReShade.log` or reuse ReShade configuration names. Internal hook and renderer failures that are not exposed to `ImguiRenderLoop` should be preserved through hudhook's tracing output rather than duplicated as panel state.

## Milestones

### Milestone 1: D3D11 isolated proof

1. Pin the released hudhook dependency and generate a locked Cargo build.
2. Build the x64 injector and D3D11 payload.
3. Copy the existing D3D11 host into a clean run directory.
4. Launch the host normally, then inject the payload by exact process name or window title.
5. Render the diagnostics panel and generated texture.
6. Resize the host repeatedly.
7. Close the target normally.

This milestone is the fast architectural answer. Explicit ejection, reinjection, multiple consecutive cycles, polished selector handling, and persistent monitoring are follow-up reliability checks rather than blockers for the first visible frame.

### Milestone 1b: allowed D3D11 application smoke test

After the controlled host passes, inject the same unchanged artifact into at least one offline D3D11 game or application the operator is allowed to modify. The panel and texture must render, the target must remain usable, and the target must close normally before concluding that hudhook is a viable D3D11 foundation.

### Milestone 2: D3D12 isolated proof

1. Add a controlled D3D12 host.
2. Build a D3D12 payload using upstream hudhook unchanged.
3. Render the same panel and generated texture.
4. Repeat the D3D11 render, resize, and clean-exit checks.
5. Record any command-queue, swap-chain, descriptor, or synchronization failure separately from shared POC code.
6. When practical, repeat the smoke test against one allowed offline D3D12 application before declaring the D3D12 path viable.

D3D11 success is still useful if a particular D3D12 target exposes an upstream bug. A reproducible D3D12 blocker becomes evidence for an upstream contribution or fork; it does not justify speculative changes before testing.

This milestone is complete in the controlled host. The generated texture and
first ImGui frame pass, an injected resize remains alive, and the existing
single-window input plus full two-window deterministic proofs pass unchanged
through the D3D12 payload, including repeated Electron texture replacement.

### Milestone 3: generic one Electron window (historical baseline)

1. Start a 640 x 360 offscreen `BrowserWindow` through the public `ElectronGameOverlay` session API, then repeat with `ExampleMainOverlay` from the real built client.
2. Register it with the existing Node add-on and forward complete `paint` frames through `sendFrameBuffer`.
3. Connect the hudhook payload to the add-on's existing Win32 IPC host without loading the legacy native renderer.
4. Select one window by metadata and retain its native ID, bounds, transparency, and current mapping through `overlay.init`, `window`, `window.bounds`, and `window.close`.
5. Copy its named mapping under the existing mutex, release the mutex, and convert premultiplied BGRA to straight RGBA on the IPC worker.
6. Publish only the latest owned surface to the render loop, upload it when its sequence changes, and draw it borderlessly at its native bounds.
7. Verify move, clear-on-close, re-register with a new mapping, and resumed composition through stable PID-specific log markers.
8. Provide diagnostic, real-client, and deterministic lifecycle runner modes; gate lifecycle timing on the injected target's `game.process` connection event, require exact producer markers, and clean up safely.

This milestone was completed on the original add-on/mapping baseline. The focused finish later replaced that transport with the authenticated loopback protocol described at the top of this document; profiling can still determine whether a future shared ring or versioned double buffer is worthwhile.

### Milestone 4: interactive selected Electron window

1. Reuse `OverlaySession.input.intercept()` and `.release()` without changing the public SDK.
2. Track requested/effective interception, selected-window focus, and multi-button pointer capture in project-owned Rust state.
3. Route regular Win32 left/right/middle mouse, vertical/horizontal wheel, keyboard, system-key, `WM_CHAR`, `WM_SYSCHAR`, and valid `WM_UNICHAR` messages through hudhook's public WndProc callbacks.
4. Queue return packets to the IPC worker, coalescing only adjacent mouse moves and preserving focus-before-click ordering.
5. Guard hudhook's `InputAll` transitions with filtered arming/disarming drains; acknowledge only after the matching terminal filter is published, so boundary input can drop but cannot reach both destinations.
6. Prove the behavior with `-ClientInput`, then rerun the lifecycle and real-client compositor regressions.

This milestone is complete for the selected Win32 window at the controlled 1:1 device scale. Raw-input translation, DirectInput, XInput, GameInput, gamepads, and faithful X1/X2 delivery through Electron 16 remain compatibility work.

### Milestone 5: ordered multi-window compositor and routing

1. Treat the existing registration stream as back-to-front: preserve
   `overlay.init`, deduplicate and append `window`, update bounds in place, and
   remove only the closed ID.
2. Retain per-window metadata, mapping, latest frame, and alpha; publish one
   immutable ordered scene and matching input registry atomically.
3. Maintain GPU upload state per window ID and draw the scene in forward order.
4. Hit-test in reverse order with transparent-pixel fallthrough, route keyboard
   to the focused live window, and keep pointer moves/releases with the capture
   owner outside its bounds.
5. Serialize click-to-front intents with a generation before applying the same
   raise to scene and router state, without adding a wire message or SDK method.
6. Prove the result with:

   ```powershell
   Remove-Item Env:HUDHOOK_ELECTRON_WINDOW -ErrorAction SilentlyContinue
   .\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
   .\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindowManual -Wait
   ```

This milestone is complete. The deterministic proof also scales public DIP
bounds, caption/border metadata, constraints, and Electron 16 OSR surfaces into
physical game pixels, then converts signed local input back to DIP. Hudhook's
ImGui framebuffer scale is normalized to 1 because its display size is already
the native swap-chain size. Registration/hide/show remains the only persistent
ordering input available from the existing host; click raises are payload-local
and reconnect resets to registration order.

The successor runtime-scale foundation stores desired and active display state
per producer window, using `BrowserWindow.getContentBounds()` rather than outer
bounds to describe the OSR surface. Moves, resizes, and display events stage a
transition; the old frame remains active until a matching OSR paint commits the
full physical geometry. Paint sizes accept the nominal floor-scaled dimensions
within one pixel per axis, and the accepted bitmap size becomes authoritative for
the physical rect and fixed constraints. If one bitmap fits both active and
desired tolerances, the SDK rejects that callback, waits for renderer DPR and
viewport acknowledgement, then commits only a causally later `capturePage()`
cropped to the desired DIP content rect. Routed input carries the active scale on
each packet, with an active-state fallback for legacy untagged packets. The
commit's `rasterChanged` marker removes stale pixels from the compositable scene
until the matching framebuffer arrives; it is not GPU texture retirement. Native
mapping creation/growth allocates before committing state and validates
dimensions, overflow, source length, and capacity before a frame copy.

The controlled host is PMv2-aware, but the available single 100% virtual display
cannot exercise a true monitor crossing. Because public bounds remain
game-client-local, target-HWND/client-origin ownership, backing placement, and
multi-target geometry still precede a real mixed-monitor claim. Forced
1/1.25/1.5/2 runs are uniform-scale regressions, not mixed-monitor proof.

## Acceptance criteria

The D3D11 milestone passes when all of the following are true:

-   the clean host directory contains no ReShade runtime or proxy;
-   hudhook's injection call completes and the payload produces its initialization evidence;
-   an always-visible ImGui panel appears without opening another overlay menu;
-   its frame counter advances continuously;
-   the generated texture is visible;
-   the overlay remains present after repeated resizes;
-   the host exits normally;
-   the run produces useful, consistent tracing/log output.

The D3D12 milestone uses the same criteria against the controlled D3D12 host.

The Electron milestone passes when the producer validates a 640 x 360 x 4 paint buffer, the real-client run proves `ExampleMainOverlay` participates in the default all-window scene, premultiplied transparent pixels render correctly at the advertised bounds, move/close/re-register changes are reflected in composition, and the exact-PID logs prove receipt, upload, clear, reselect, and resume before attached cleanup.

The input milestone's end-to-end acceptance passes when the selected window receives left-click/focus, text, and vertical wheel input with local coordinates; intercepted Escape reaches Electron but not the host; release produces an Electron acknowledgement after the separate disabled-at-render-boundary marker; and released Escape closes the host normally. Horizontal wheel, pointer capture outside the selected bounds, outside-overlay swallowing, right/middle buttons, extended characters, synthetic cleanup releases, guarded filter transitions, retry classification, and move coalescing are verified below the DOM end-to-end boundary.

The multi-window milestone passes when two overlapping real Electron pages upload
and compose in BACK>FRONT registration order; only the topmost opaque target gets
the overlap click; focus precedes mouse down and keyboard follows the focused
window; FRONT owns an out-of-bounds drag without BACK leakage; clicking the exposed
BACK panel raises it locally and makes the next overlap click BACK-only before any
producer command; subsequent BACK and FRONT re-registrations preserve or restore
the expected order and focused keyboard routing;
hiding FRONT leaves BACK alive and showing it restores both; release follows the
disabled filter boundary; released Escape closes the host; and exact controlled
processes are cleaned. Pure Rust tests cover arbitrary ordered registries,
deduplication, exact filtering, alpha fallthrough, scene metadata, click-intent
emission, reconnect cleanup, and capture cleanup.

The controlled host proves the architecture deterministically. At least one allowed offline D3D11 game/application smoke test is required before adopting hudhook for the D3D11 product path. Apply the same rule to D3D12 when a suitable test target is available.

## Fork policy

Stay on the released upstream crate when project code can provide the missing behavior.

Consider a fork only after reproducing one of these blockers:

-   a required swap-chain, device, texture, input, or unload lifecycle is not exposed;
-   a supported target crashes or cannot initialize because of hudhook internals;
-   D3D12 command-queue or resize handling blocks the applications in scope;
-   required diagnostics or recovery cannot be added through public APIs;
-   the eventual single-payload backend dispatcher cannot be contributed upstream or composed around the library.

Before forking:

1. reduce the failure to the controlled host where possible;
2. check the current upstream release, issues, and pull requests;
3. report or contribute the fix upstream;
4. fork only if the project must ship before an upstream release or intentionally needs different behavior.

If a fork becomes necessary, keep it narrow, preserve upstream history, document every patch, and continue tracking upstream releases.

## Build and run target

Planned prerequisites:

-   Windows 10 or newer;
-   Rust 1.85 or newer with the `x86_64-pc-windows-msvc` target;
-   Visual Studio 2022 C++ Build Tools and a Windows SDK;
-   a Visual Studio Developer PowerShell.

The eventual POC README should provide a flow similar to:

```powershell
Push-Location poc/hudhook-imgui-overlay
cargo build --locked --release --target x86_64-pc-windows-msvc
Pop-Location

& .\build\hudhook-imgui-overlay\test-host\d3d11_overlay_test_host.exe
& .\build\hudhook-imgui-overlay\hudhook_overlay_injector.exe `
  --process d3d11_overlay_test_host.exe `
  --backend d3d11
```

These commands describe the desired operator experience; the implementation README must replace them with the exact paths produced by the final Cargo workspace.

## Safety and distribution

-   Use the controlled hosts or offline/single-player software the operator is allowed to modify.
-   Do not inject into competitive or anti-cheat-protected software.
-   Match target bitness and privilege level; detailed preflight validation can follow the first POC.
-   Keep the initial experiment x64-only.
-   Pin dependencies and retain notices required by hudhook and Dear ImGui's MIT licenses, imgui-rs's MIT OR Apache-2.0 license, and MinHook/HDE's 2-Clause BSD licenses.
-   Do not bundle or install ReShade as part of this POC.

## Decision after the POC

-   Keep upstream hudhook as a pinned dependency while controlled and allowed application tests pass; the ordered multi-window Electron transport already composes around its public API.
-   If a small defect is found, prefer an upstream issue or contribution while keeping the POC on the nearest usable release.
-   If a required internal change cannot be accepted upstream in time, create a narrow project fork backed by the reproduced test.
-   If basic hooking, resize, or unload behavior is unreliable even in the controlled hosts, stop before integrating Electron and reassess the hook runtime.

The focused POC is complete: the controlled D3D11/D3D12 graphics paths, real-client integration, project-owned Electron transport, regular Win32 input, ordered multi-window composition, uniform-scale regressions, and producer-window/runtime transition foundation are implemented and revalidated. Acceptance records are in [`hudhook-input-interactivity-handoff.md`](hudhook-input-interactivity-handoff.md) and [`hudhook-multiwindow-compositor-handoff.md`](hudhook-multiwindow-compositor-handoff.md). Target-display/client-origin ownership, backing-window/per-target geometry, real mixed-scale hardware/VM acceptance, safe texture retirement, broader D3D12 compatibility coverage, a production injector, and related DPI edge cases remain explicit post-POC hardening. Allowed offline application smoke tests remain separate compatibility evidence.
