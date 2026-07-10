# hudhook + ImGui overlay proof of concept

## Status

Approved as the next native overlay experiment.

The first implementation should consume the released `hudhook` crate unchanged. Pin the exact release and commit `Cargo.lock` so the experiment remains reproducible. A maintained project fork is a fallback only if the proof exposes a concrete upstream limitation that cannot reasonably be handled in project code or contributed upstream.

The initial target is Windows x64 with D3D11. D3D12 is the second milestone. D3D9 remains available in hudhook as a possible compatibility fallback, but it is not required to answer the first proof-of-concept question.

## Question this POC answers

Can a small, independently injected DLL use upstream hudhook to enter a D3D11 or D3D12 application's render path and draw a stable Dear ImGui overlay without installing or loading ReShade?

The minimum useful answer is deliberately narrow:

-   inject a project-owned DLL into a controlled graphics host;
-   let unmodified hudhook own the graphics hooks and ImGui backend lifecycle;
-   draw an always-visible ImGui diagnostics panel;
-   upload and draw one generated RGBA texture;
-   survive window and swap-chain resize;
-   report enough diagnostics to distinguish injection, hook, initialization, and rendering failures;
-   let the target close cleanly.

Electron frame transport and production-wide game compatibility come after this seam is proven.

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

Our overlay panel, injector command line, logging, generated test texture, and later IPC integration all belong in project code. None of those require modifying hudhook.

Using two backend-specific DLLs is acceptable for the POC. Automatic graphics API discovery and one universal payload are production concerns and should not force a fork before the basic hook/render path is tested.

## Scope

### Included

-   Windows 10 or newer;
-   x64 injector, payload, and target;
-   D3D11 first;
-   D3D12 immediately after D3D11 succeeds;
-   late injection by exact process name or window title;
-   one native ImGui diagnostics window;
-   one generated checkerboard or test-card texture;
-   resize and clean target-exit tests;
-   a controlled coexistence test with user-installed ReShade after the isolated baseline passes.

### Not included yet

-   Electron offscreen frame transport;
-   shared-memory IPC;
-   forwarding input to Electron;
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

### Milestone 3: coexistence observation

Only after the clean baseline succeeds, use the controlled host to observe behavior when ReShade is already loaded and hudhook is injected afterward.

This is a compatibility experiment, not an anti-cheat test. Record:

-   whether payload initialization and hook tracing show that the DLL loaded and hooks installed;
-   whether both overlays render;
-   resize behavior;
-   shutdown and unload order;
-   logs from both runtimes;
-   whether the result is repeatable.

Do not change either upstream project merely to force this test to pass. A reproducible collision should first be documented and used to decide whether an upstream fix, a small fork, or an alternate coexistence path is appropriate.

The minimum safe result is either:

-   both overlays render, resize, and shut down repeatably; or
-   hudhook detects or encounters the conflict and fails/disables without crashing or hanging the target and without modifying the user's ReShade installation.

A crash, hang, corrupted render state, or unsafe unload blocks adoption until it is understood and resolved.

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

The controlled host proves the architecture deterministically. At least one allowed offline D3D11 game/application smoke test is required before adopting hudhook for the D3D11 product path. Apply the same rule to D3D12 when a suitable test target is available.

## Fork policy

Stay on the released upstream crate when project code can provide the missing behavior.

Consider a fork only after reproducing one of these blockers:

-   a required swap-chain, device, texture, input, or unload lifecycle is not exposed;
-   a supported target crashes or cannot initialize because of hudhook internals;
-   D3D12 command-queue or resize handling blocks the applications in scope;
-   coexistence requires a hook-chain change that cannot be implemented outside hudhook;
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
-   Pin dependencies and retain notices required by hudhook, Dear ImGui, and MinHook's MIT licenses.
-   Do not bundle or install ReShade as part of this POC.

## Decision after the POC

-   If the controlled hosts and allowed application smoke tests pass using released hudhook, and ReShade coexistence is safe, keep upstream hudhook as a pinned dependency and proceed to Electron frame transport.
-   If a small defect is found, prefer an upstream issue or contribution while keeping the POC on the nearest usable release.
-   If a required internal change cannot be accepted upstream in time, create a narrow project fork backed by the reproduced test.
-   If basic hooking, resize, or unload behavior is unreliable even in the controlled hosts, stop before integrating Electron and reassess the hook runtime.

The immediate next success criterion is simple: inject the D3D11 payload into the clean controlled host and see a hudhook-owned ImGui panel and generated texture render reliably without ReShade.
