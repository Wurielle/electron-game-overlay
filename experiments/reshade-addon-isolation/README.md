# Public ReShade add-on isolation probe

This is a research fixture, separate from the SDK, broker, production add-on and
injector. It builds a hidden controlled D3D11 host and two minimal independently
compiled add-ons with distinct exported names. It uses an unchanged, caller-supplied
official ReShade 6.7.3 x64 full-add-on DLL and public API-18 headers. It does not
fetch, build, patch or install ReShade, and does not attach to another process.

Run from the repository root with CMake and Visual Studio 2022 C++ tools installed:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/reshade-addon-isolation.ps1 `
    -OfficialRuntimePath C:/path/to/official/ReShade64.dll `
    -ReShadeIncludeDirectory C:/path/to/stock/reshade/include
```

Use headers from upstream commit `4a50d1eddace85734871d91792ff214f13f66c01`.
EGO's production build headers are patched API-19 and intentionally fail this
probe's compile-time check. The supplied runtime and headers are trusted inputs;
the probe records their hashes rather than certifying the supplier. For this run,
the DLL was independently checked against the `ReShade64.dll` entry embedded in
the cached official `ReShade_Setup_6.7.3_Addon.exe`; see the evidence file.

All generated files are under `build/reshade-addon-isolation`. Each invocation
creates fresh stages for both startup orders, copies the supplied DLL twice,
and creates only its own INI and fixture files there. Source and staged DLL hashes
must remain equal before and after the run. No existing installation is changed.

The official runtime loads as a normal startup `d3d11.dll` proxy. The host loads
the startup add-on before device creation and the late add-on after the first
eight Presents, initializing each through its public `AddonInit` entry point on
the only rendering thread. Both DLL references belong to this controlled host. Both
receive subsequent `reshade_present` callbacks. The late add-on receives no replay
of `init_swapchain`. A third, separately mapped module exporting the first add-on's
name must fail registration; a second copy of the ReShade DLL must fail loading.
The script checks the corresponding ReShade diagnostics, not only Win32 error
codes. The startup add-on is then unloaded between Presents, and the surviving
add-on must continue receiving callbacks with exactly one ReShade runtime mapped.

The successful Windows run is recorded in
[evidence-2026-11-01.json](evidence-2026-11-01.json). This establishes public
add-on callback coexistence, duplicate identity rejection, missing late lifecycle
replay, and controlled peer unload. It does **not** establish EGO scene rendering,
input/focus isolation, native fault containment, concurrent arbitrary unload,
mixed SDK package compatibility, or a replacement for the production broker.
