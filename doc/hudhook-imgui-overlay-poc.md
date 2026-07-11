# hudhook + ImGui overlay proof of concept

## Status

The controlled D3D11 milestone is implemented in [`poc/hudhook-imgui-overlay`](../poc/hudhook-imgui-overlay/README.md) and was verified on July 10, 2026.

Verified results:

-   the Windows x64 MSVC release payload and injector build from the locked Cargo workspace;
-   the clean controlled host contains no ReShade runtime, proxy, configuration, or add-on;
-   injection by exact window title reaches hudhook's D3D11 hooks;
-   the generated 128 x 128 RGBA texture uploads successfully;
-   the first ImGui frame renders at 1280 x 720;
-   a programmatic resize updates the ImGui display size to 884 x 561 without hanging the host;
-   the controlled host remains responsive and accepts a normal window close;
-   the diagnostic producer and the repository's real built Electron client both publish a 640 x 360 offscreen window through the public `electron-game-overlay` session and existing `node-game-overlay` shared mapping;
-   the real-client runner selects `ExampleMainOverlay` rather than accepting a fallback or status window;
-   the hudhook payload connects to the existing Node IPC host, copies the frame on a worker thread, converts Electron's premultiplied BGRA pixels to straight RGBA, uploads it through hudhook, and composes it at the native window bounds;
-   a transparent window moves from `(64, 72)` to `(176, 128)`, disappears after the SDK's `window.close`, and resumes after the same `BrowserWindow` re-registers with a new mapping;
-   `OverlaySession.input.intercept()` drives hudhook's guarded Win32 input filter; while it blocks the controlled host, the payload hit-tests and forwards left/right/middle mouse, vertical/horizontal wheel, keyboard, system-key, character, and focus packets to the selected Electron window, and project-owned router state maintains multi-button pointer capture;
-   the deterministic `-ClientInput` runner proves click/focus, typed text, vertical wheel, intercepted Escape, release acknowledgement, released Escape, and clean process exit;
-   router, bridge, and native-translator tests cover outside-bounds capture/release, outside-overlay swallowing, right/middle buttons, horizontal wheel, extended characters, synthetic cancellation/cleanup releases, guarded filter transitions, at-most-once input retry classification, and adjacent mouse-move coalescing;
-   the integrated diagnostic, `-Client`, `-ClientWindow`, and `-ClientInput` runners require the exact host PID's receipt, upload, composition, and applicable lifecycle/input markers and safely clean up their Electron process trees in attached runs.

No hudhook fork was required. The allowed D3D11 application smoke test and D3D12 milestone remain open. ReShade coexistence is not a gate for this path; the earlier concern was about avoiding a proxy-name/runtime collision, which runtime hudhook injection already avoids.

The controlled POC still uses hudhook's upstream injector. Its implementation does not validate a zero return from remote `LoadLibraryW` and copies a fixed `MAX_PATH` byte count from a shorter source buffer. The controlled runner therefore requires fresh texture-upload and first-frame log evidence. A production launcher should correct that small injection seam in project code or upstream; it does not require a fork of hudhook's graphics-hook/rendering stack.

The first implementation should consume the released `hudhook` crate unchanged. Pin the exact release and commit `Cargo.lock` so the experiment remains reproducible. A maintained project fork is a fallback only if the proof exposes a concrete upstream limitation that cannot reasonably be handled in project code or contributed upstream.

The initial target is Windows x64 with D3D11. D3D12 remains the second graphics-backend milestone and now follows the shared compositor work listed below. D3D9 remains available in hudhook as a possible compatibility fallback, but it is not required to answer the first proof-of-concept question.

## Question this POC answers

Can a small, independently injected DLL use upstream hudhook to enter a D3D11 or D3D12 application's render path and draw a stable Dear ImGui overlay without installing or loading ReShade?

The minimum useful answer is deliberately narrow:

-   inject a project-owned DLL into a controlled graphics host;
-   let unmodified hudhook own the graphics hooks and ImGui backend lifecycle;
-   draw an always-visible ImGui diagnostics panel;
-   upload and draw one generated RGBA texture;
-   replace it with one selected Electron offscreen surface and its native window state carried by the current Node/shared-memory flow;
-   survive window and swap-chain resize;
-   report enough diagnostics to distinguish injection, hook, initialization, and rendering failures;
-   let the target close cleanly.

The D3D11 seam and an interactive generic one-window Electron compositor are now proven. Production-wide game compatibility, multi-window/z-order composition, arbitrary-DPI coordinate mapping, resize-safe texture retirement, broader input APIs, and D3D12 remain later work.

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
-   D3D11 first;
-   D3D12 after the shared one-window compositor is ready to generalize;
-   late injection by exact process name or window title;
-   one native ImGui diagnostics window;
-   one generated checkerboard or test-card texture;
-   one selected 640 x 360 Electron offscreen window from either a controlled producer or the real built client;
-   transparent premultiplied-BGRA conversion and native-bounds composition;
-   one-window move, close, and re-register lifecycle handling;
-   one-window Win32 left/right/middle mouse, vertical/horizontal-wheel, keyboard,
    system-key, character, focus, and global interception behavior, plus
    project-owned multi-button pointer-capture state;
-   compatibility with the existing Node add-on IPC, named mutex, and shared mapping;
-   resize and clean target-exit tests;
-   latest-frame CPU copy/conversion away from the render thread.

### Not included yet

-   multiple Electron windows, z-order, or coordinated visibility state;
-   arbitrary-DPI and mixed-monitor coordinate mapping beyond the controlled 100% scale;
-   Electron window resize and old-texture retirement;
-   raw-input translation, DirectInput, XInput, GameInput, gamepads, and faithful
    X1/X2 delivery through Electron 16;
-   automatic D3D11/D3D12 selection in one DLL;
-   x86 payloads;
-   D3D10, Vulkan, or OpenGL;
-   anti-cheat bypass or protected-process support;
-   proxy DLL installation beside a game;
-   a claim that every game or every third-party overlay combination is supported;
-   PID selection or a replacement for hudhook's injector implementation.

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

A similarly small project-owned D3D12 host should be added for the second milestone. It should display a deterministic animated background, support resizing, and avoid unrelated engine behavior so hook failures remain easy to diagnose.

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

### Milestone 3: generic one Electron window

1. Start a 640 x 360 offscreen `BrowserWindow` through the public `ElectronGameOverlay` session API, then repeat with `ExampleMainOverlay` from the real built client.
2. Register it with the existing Node add-on and forward complete `paint` frames through `sendFrameBuffer`.
3. Connect the hudhook payload to the add-on's existing Win32 IPC host without loading the legacy native renderer.
4. Select one window by metadata and retain its native ID, bounds, transparency, and current mapping through `overlay.init`, `window`, `window.bounds`, and `window.close`.
5. Copy its named mapping under the existing mutex, release the mutex, and convert premultiplied BGRA to straight RGBA on the IPC worker.
6. Publish only the latest owned surface to the render loop, upload it when its sequence changes, and draw it borderlessly at its native bounds.
7. Verify move, clear-on-close, re-register with a new mapping, and resumed composition through stable PID-specific log markers.
8. Provide diagnostic, real-client, and deterministic lifecycle runner modes; gate lifecycle timing on the injected target's `game.process` connection event, require exact producer markers, and clean up safely.

This milestone is complete. It intentionally does not redesign the current frame protocol; a versioned/double-buffered transport can follow if profiling or multi-window work shows that the existing mutex/mapping is insufficient.

### Milestone 4: interactive selected Electron window

1. Reuse `OverlaySession.input.intercept()` and `.release()` without changing the public SDK.
2. Track requested/effective interception, selected-window focus, and multi-button pointer capture in project-owned Rust state.
3. Route regular Win32 left/right/middle mouse, vertical/horizontal wheel, keyboard, system-key, `WM_CHAR`, `WM_SYSCHAR`, and valid `WM_UNICHAR` messages through hudhook's public WndProc callbacks.
4. Queue return packets to the IPC worker, coalescing only adjacent mouse moves and preserving focus-before-click ordering.
5. Guard hudhook's `InputAll` transitions with filtered arming/disarming drains; acknowledge only after the matching terminal filter is published, so boundary input can drop but cannot reach both destinations.
6. Prove the behavior with `-ClientInput`, then rerun the lifecycle and real-client compositor regressions.

This milestone is complete for the selected Win32 window at the controlled 1:1 device scale. Raw-input translation, DirectInput, XInput, GameInput, gamepads, and faithful X1/X2 delivery through Electron 16 remain compatibility work.

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

The Electron milestone passes when the producer validates a 640 x 360 x 4 paint buffer, the real-client run selects `ExampleMainOverlay`, premultiplied transparent pixels render correctly at the advertised bounds, move/close/re-register changes are reflected in composition, and the exact-PID logs prove receipt, upload, clear, reselect, and resume before attached cleanup.

The input milestone's end-to-end acceptance passes when the selected window receives left-click/focus, text, and vertical wheel input with local coordinates; intercepted Escape reaches Electron but not the host; release produces an Electron acknowledgement after the separate disabled-at-render-boundary marker; and released Escape closes the host normally. Horizontal wheel, pointer capture outside the selected bounds, outside-overlay swallowing, right/middle buttons, extended characters, synthetic cleanup releases, guarded filter transitions, retry classification, and move coalescing are verified below the DOM end-to-end boundary.

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

-   Keep upstream hudhook as a pinned dependency while controlled and allowed application tests pass; the generic one-window Electron transport already composes around its public API.
-   If a small defect is found, prefer an upstream issue or contribution while keeping the POC on the nearest usable release.
-   If a required internal change cannot be accepted upstream in time, create a narrow project fork backed by the reproduced test.
-   If basic hooking, resize, or unload behavior is unreliable even in the controlled hosts, stop before integrating Electron and reassess the hook runtime.

The controlled D3D11, generic one-window Electron compositor, and selected-window input criteria are complete; the input design and acceptance record is in [`hudhook-input-interactivity-handoff.md`](hudhook-input-interactivity-handoff.md). Next add multi-window state/z-order, arbitrary-DPI coordinate handling, and resize-safe texture retirement. After those compositor seams are stable, repeat the controlled graphics proof with D3D12; an allowed offline D3D11 application smoke test remains separate compatibility evidence.
