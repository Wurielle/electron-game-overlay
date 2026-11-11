# Bounded rendering failure probes

These probes investigate two native boundaries using the unchanged generation-36
ReShade DLL from the runtime distribution. They do not inject into applications,
change production code, load the EGO feature engine, or establish actual Notepad,
Blender, game, or physical-key acceptance. All configuration is isolated under
an owner-marked directory in `build/overlay-compatibility/rendering-failure-probes`.
The DLL is loaded from its existing path, not copied or patched.

Each probe has its own launcher. Supply `-Architecture x64` or `x86`:

```powershell
libs/electron-game-overlay-runtime/scripts/test-cases/d2d-factory8-compatibility.ps1
libs/electron-game-overlay-runtime/scripts/test-cases/on-demand-input-progress.ps1
```

The runner builds with MSVC and Windows SDK headers, hides the child console,
bounds each execution to 20 seconds, and saves stdout, stderr, exact DLL/fixture
hashes and structured results. The input probe uses the locally pinned patched
ReShade headers. This is developer diagnostic tooling, not a new end-user
software requirement.

## Direct2D factory 8

Eight fresh processes compare factory 7 and factory 8 with clean devices,
production-wrapped devices, explicitly unwrapped devices and unwrapped WARP.
Each creates a D2D device/context, imports the first offscreen composition
back buffer, clears it green through D2D, and checks a CPU pixel readback.
There is no HWND or Present. Device/context creation alone is insufficient:
the observed failure occurs later at `CreateBitmapFromDxgiSurface`.

On 2026-11-11, both architectures produced:

| Device path | Factory 7 | Factory 8 |
| --- | --- | --- |
| Clean hardware | Green readback | Green readback |
| Production wrapped hardware | Green readback | Bitmap import returns `0x88990003` |
| Production host, original device passed to D2D | Green readback | Green readback |
| WARP under production host | Green readback | Green readback |

The pinned D2D implementation unwraps devices for factory methods 1 through 7,
but omits factory 8. This fixture demonstrates the compatibility consequence
without changing that implementation. It does not establish that the reported
Notepad failure used factory 8; that requires a matching application stack.
The runner retains the host-8 failure as diagnostic evidence, while requiring
the clean, original-device and older-factory controls to succeed. Unsupported
factory 8 is recorded explicitly rather than reported as a successful test.

## On-demand input progress

A hidden, never-focused owned HWND receives posted key messages. An ordinary
test add-on uses the actual production `input_message` and `reshade_overlay`
callbacks and `block_input_next_frame`. Its deliberately small queue/drain seam
represents the render-driven boundary; it is not the EGO transport, cooperative
registry, or feature implementation. The application requests redraw only when
its window procedure receives a key or an explicit test redraw message.

Both architectures reproduced the same sequence:

1. Unblocked input reaches the application and requests redraw.
2. Blocking suppresses target input while the input callback observes it.
3. With no Present, two observations remain undelivered at frame 7; changing the
   requested blocking state does not yet release native suppression.
4. An explicit redraw advances to frame 9, delivers both observations, and
   releases suppression. The next key again reaches the application.

This proves a native dependency on rendering progress, not a Blender deadlock.
It uses synthetic posted messages, no system keyboard injection, no focus
changes and no visible window. The coordinating actual-app run must distinguish
stopped rendering from continued rendering with failed routing or blocked
threads. No watchdog, forced presentation, input bypass, or app exception is
introduced by these probes.

## Local factory 8 correction

`patches/reshade-d2d-factory8.patch` adds the factory 8 overload to the same
device-unwrapping helper used for factories 1–7. It is currently an unintegrated
prototype: the production CMake patch stack, source pins, runtime generation,
distribution, injector and SDK manifests are unchanged.

`node build-d2d-prototype.cjs x64` (or `x86`) builds all host translation units in
an isolated directory, reusing only the existing dependency libraries. It does
not reuse potentially stale host object files. The builder records the patch,
source, dependency-library and output hashes. The exact correction is exercised
with:

```powershell
node run-probe.cjs d2d_factory8 x64 C:/absolute/path/to/prototype/ReShade64.dll
```

Prototype results have a separate output directory, preserving the baseline
reports. Both architectures passed all eight D2D cases after the correction,
including the previously failing factory 8 bitmap import and green readback.
The existing `d3d11-resource-identity/run-gate.cjs` also passed its four controls
on each architecture with the prototype (hardware, video-support and WARP).
These are 16 D2D and eight resource-identity cases, not actual Notepad acceptance.

## Full EGO transport extension and repaint helper

`on-demand-ego-transport.ps1` builds a command-controlled owned host and uses the
existing offscreen Electron scene producer plus the unchanged EGO add-on. The
default private desktop is never switched onto the display. On this machine
Windows refused foreground activation there, so the full input test stopped
before claiming acceptance. The restricted process sandbox also prevented
Electron's renderer from starting; the renderer started outside that sandbox.

`-VisibleFixture` explicitly enables a window on the current desktop for the
session coordinating foreground tests. This mode has not yet been executed.
It must have exclusive foreground-test access. The intended checks require
authenticated transport, actual overlay pixel readbacks, delayed delivery into
the Electron DOM, and interception release after rendering resumes.

`repaint-exact-target.ps1` is a separate test-only helper. It requires a fresh
PID, exact creation time, HWND and owning thread ID. It retains a query/sync
process handle, validates the live process/window, and calls
`InvalidateRect(hwnd, nullptr, FALSE)` exactly once. It does not inject, force
Present, move focus, or install a persistent repaint mechanism. A successful
return means the repaint request was accepted, not that the target rendered.
Never reuse values from an exited process or retired surface.
