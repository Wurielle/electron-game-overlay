# Host-assisted late D3D11 adoption prototype

This isolated Windows fixture tests the public manual-runtime API against an
already-created raw D3D11 swapchain. It is not activated by production packaging
or the SDK. It does not establish automatic process discovery, generic swapchain
discovery, D3D9/10/12 support, actual overlay pixels, or real-game acceptance.

The host completes at least 60 successful native `Present(1, 0)` calls before it
loads either supplied DLL. It then loads the owned ReShade host and private EGO
add-on from an external staging directory, calls
`ElectronGameOverlayInitializeMember(nullptr)`, and passes its existing device,
immediate context, and raw swapchain to `ReShadeCreateEffectRuntime`. Each later
frame calls `ReShadeUpdateAndPresentEffectRuntime` before native `Present`.

The host retains the native COM objects for the entire manual-runtime lifetime.
At the scheduled resize it destroys the manual runtime, unbinds/releases its RTV,
calls `ResizeBuffers`, recreates its RTV, and creates a fresh manual runtime. It
requires at least 60 successful post-resize presentations and destroys the final
manual runtime before releasing native graphics objects. It handles ordinary
window resizing by the same lifetime sequence. Modules stay mapped until process
exit; there is no retry by loading another ReShade host.

Use a unique fixture process with no other injector/watcher targeting it. A
self-module check rejects an already mapped ReShade before the direct host load;
this fixture does not exercise the production injector's frozen ownership claim.

## Build

Use an isolated build directory and the exact headers matching the owned ReShade
DLL being tested. Configure `-A Win32` instead of `-A x64` for the x86 variant.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/late-d3d11-adoption `
  -B build/late-d3d11-adoption/x64 -A x64 `
  -DRESHADE_INCLUDE_DIR=C:/absolute/path/to/exact/reshade-src/include
cmake --build build/late-d3d11-adoption/x64 --config Release
```

The fixture has no dependency on the production add-on target and does not copy
or rebuild production artifacts.

Both launchers remove inherited ReShade disable flags and stale EGO routes only
from their child environment. They then explicitly set that child's
`RESHADE_BASE_PATH_OVERRIDE` to the verified owned stage containing `ReShade.ini`.
A non-proxy ReShade DLL otherwise resolves its base to the host executable's
directory. The console-only `child-environment-test.ps1` checks the actual child
environment with native `GetEnvironmentVariable`, including absent disable flags
and an unchanged parent environment.

The dedicated launcher can build only this standalone host and stage the exact
supplied runtime/add-on copies in a unique owned run directory:

```powershell
& libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d11-adoption.ps1 `
  -RuntimePath C:/absolute/path/to/owned/ReShade64.dll `
  -AddonPath C:/absolute/path/to/owned/electron_game_overlay.addon64 `
  -Architecture x64 -LifetimeMs 20000
```

`-ReshadeIncludeDirectory` overrides the canonical build-tree headers. This
launcher is API-only: it starts no scene producer, so the private add-on may stay
dormant. Its `build/late-d3d11-adoption/run-<guid>/evidence.json` records original
and staged hashes, standalone host/source/header hashes, exit status, and the
manual API report. It launches a visible GUI, uses only its child's environment
dictionary to remove inherited ReShade disable/base and EGO variables, and only
terminates the exact child it started if the bounded run fails. The separate
overlay pixel/input proof must supply an authenticated producer and retain its
own stronger acceptance assertions.

## Run

Create a unique owned stage outside the host executable's directory. Copy the
matching-architecture owned ReShade and private add-on into that stage. Supply
the private transport credentials expected by the add-on in its own module
parent. A separate authenticated producer must supply any overlay scene/input
acceptance; this host does not generate synthetic overlay success evidence.

```powershell
& build/late-d3d11-adoption/x64/Release/late_d3d11_adoption_host.exe `
  --stage-directory C:/absolute/owned/stage `
  --reshade C:/absolute/owned/stage/ReShade64.dll `
  --addon C:/absolute/owned/stage/electron_game_overlay.addon64 `
  --config C:/absolute/owned/stage/manual-runtime.ini `
  --report C:/absolute/owned/stage/late-adoption-report.json `
  --frames-before-load 60 --resize-after-frames 120 --lifetime-ms 20000
```

All arguments accept either `--key value` or `--key=value`. Every path must be
absolute and resolve inside the supplied existing stage. The fixture writes
only its report/temporary report and the supplied manual-runtime configuration;
ReShade/add-on diagnostics may also write in that owned stage. It does not set,
clear, or restore process/global environment variables and does not install files
into a game directory. The runner must provide a clean per-child environment if
it wants ReShade's graphics/input/logging hooks enabled.

`--frames-before-load` has a minimum of 60. `--resize-after-frames` counts successful
post-adoption native presentations. `--lifetime-ms` starts after the first manual
runtime initializes; the raw startup phase has a separate 60-second bound. The
run fails if the chosen lifetime cannot complete resize plus 60 post-resize
presentations. A user closing the window early also produces failure.

## Evidence and state restoration

The JSON report is refreshed during the run and finalized before exit. It records
the PID/window handle, DLL/init results, actual presentation counts before/after
loading and resizing, manual runtime create/destroy counts, sampled D3D11 state
checks, and cleanup ordering. `passed` means only this host-assisted API lifecycle
completed. The report explicitly retains `automaticDiscoveryProven: false` and
`renderedOverlayPixelsProven: false`.

The pinned ReShade `runtime::on_present` calls `capture_state` before rendering
and `apply_state` afterward. Its D3D11 state block restores the application's
pipeline state. The fixture does not add a host-side state-restoration wrapper,
which would hide a failure. Instead, it binds recognizable RTV, viewport,
scissor, primitive topology, rasterizer, blend, and depth/stencil state before
each manual render call and verifies those sampled states immediately afterward.
This is useful evidence, not exhaustive validation of every D3D11 pipeline slot.

Hardware device creation is attempted first; a WARP fallback is recorded rather
than silently relabeled as hardware acceptance. The [dated evidence](evidence-2026-11-01.json)
records the x64 manual API lifecycle pass and separate strict white-pixel scene
failure. The failed scene sample remains a blocker; the lifecycle pass is not
overlay-rendering or automatic-attachment acceptance.

## Private scene pixel and input proof

The separate `scripts/test-cases/late-d3d11-overlay-proof.ps1` launcher accepts
the same explicit runtime/add-on paths and architecture, plus an optional
`-SdkDist` and `-SkipBuild`. It starts `scene-producer.cjs` under Electron, using
the supplied SDK to publish a route only beside this stage's private add-on.
The producer never injects or starts a launcher. `scene-state.json` records
authentication, OSR paints, native focus/interception and DOM input. Its command
file accepts increasing positive sequences and `focus`, `intercept`, `release`,
`clear` or `exit` actions.

The controller samples the red scene in the foreground target before and after
resize, sends Windows `SendInput` keys/pointer to the actual target, verifies DOM
delivery and native input suppression, then verifies released input reaches the
host. This is synthetic foreground input, not physical-key evidence. A successful
run still reports `automaticDiscoveryProven: false`: the host supplies its exact
raw graphics pointers to the public API. These proofs must precede a separate
generic native Present-discovery implementation and unbarriered watcher gate.

`-GpuReadback` requests the existing native add-on's bounded three-pixel
diagnostic when that supplied build supports it. The producer separately records
its exact SDK bitmap representation, source sample bytes and bounded PNGs.
Neither diagnostic changes the strict target desktop-pixel assertion.
