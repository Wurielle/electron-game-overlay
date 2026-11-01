# Isolated owned-host D3D11 discovery prototype

This proposal is not included by production sources or packaging. The first
x64 hardware run discovered the raw swap chain without pointer handoff and
passed strict desktop pixels, synthetic input, resize and sampled state
restoration. It failed final retirement: its notifier had not fired before the
caller released its device/context. A subsequent A/B used the same corrected
caller and current add-on for both runtime variants. V1 again recorded zero
retirements; V2 with transient native render-target views recorded one retirement
before device/context release and passed the full controlled case. Both variants
completed the pixel/input/resize checks with zero sampled state mismatches.
This establishes the need for the V2 view-lifetime seam in the measured
implementation, not a universal DXGI lifetime guarantee.
The [actual evidence](actual-evidence-2026-11-01.json) binds the A/B to exact
runtime/add-on/caller hashes and retains the original failed V1 run separately
from the immutable first [build evidence](build-evidence-2026-11-01.json).
These controlled runs do not establish automatic process attachment or
production readiness.
All executions require separate coordination with the desktop test owner.

## Integration boundary

`prototype.patch` contains the complete isolated ReShade change: these two core
files, the cached-HWND backend hunk and the conditional include. It passes
`git apply --check` against the exact private source snapshot used to author it.
It is separate from the production ReShade patch stack and generation pins.
Apply it only in a separately staged owned source tree. `integration.patch` is
the smaller cache/include-only form for inspecting those integration changes;
do not apply both.

Copy `owned_late_d3d11_prototype.hpp` and its adjacent `.inl` into an isolated
owned ReShade `source/ego_owned_late_d3d11` directory. Define
`RESHADE_OWNED_LATE_D3D11_PROTOTYPE` only for that prototype build and include the
header as `ego_owned_late_d3d11/owned_late_d3d11_prototype.hpp` exactly once from
`source/addon.cpp`, within its existing add-on/API
export build guard. The `.inl` is included by the header, so no additional
translation unit/project source is needed. Do not include it in a native EGO
participant or an existing official ReShade installation.

Required prerequisite patch, included above: cache `DXGI_SWAP_CHAIN_DESC::OutputWindow` while
constructing `d3d11::swapchain_impl`, then have `get_hwnd()` return that cache.
Do not duplicate that hunk or dereference the original chain during notifier teardown. The cached value
does not require refreshing on ResizeBuffers: OutputWindow is immutable for this
swapchain. This source deliberately does not propose an official-host patch.

The caller must have already safely registered the first generic cooperative
adapter. This prototype does not load add-ons or register ReShade callbacks and
does not attempt to make a late callback-vector mutation safe. Call its export
outside DllMain, on a thread that can create/destroy the scratch window/device.
No initialization call carries a game graphics pointer.

For an explicitly coordinated MSVC prototype build, `prototype.props` can be
imported through `/p:ForceImportBeforeCppTargets=<absolute prototype.props>` when
building the separately staged `ReShade.vcxproj`. That import appends the opt-in
macro without replacing the project's normal definitions. No normal build or
packaging script imports it.

The adjacent standalone CMake project builds `generic_host.cpp`, whose caller
includes this header with `RESHADE_OWNED_LATE_D3D11_ABI_ONLY`. It passes only the
configuration request, then relies on native Present/resize/final-release hooks.
It never calls public manual create/update/destroy or passes its device/context/
swapchain to the initializer. Its report separately requires one adoption,
resize, retirement and retirement before releasing its own device/context.
The source-only `scripts/test-cases/late-d3d11-generic-overlay-proof.ps1` launcher
uses that caller with the private SDK scene and strict foreground pixel/input
controller. It still does not prove automatic process observation/injection.

On x64 the exported names below are undecorated. On Win32, the header supplies
linker aliases for the two WINAPI exports (both have a single pointer argument):

```text
ReShadeInitializeOwnedLateD3D11V1=_ReShadeInitializeOwnedLateD3D11V1@4
ReShadeQueryOwnedLateD3D11V1=_ReShadeQueryOwnedLateD3D11V1@4
```

## Explicit opt-in and POD ABI

`ReShadeInitializeOwnedLateD3D11V1` returns a Win32 error code and accepts only the
fixed-layout, size/versioned `ego_owned_late_d3d11_initialize_v1`:

```cpp
uint32_t struct_size;       // exactly sizeof(request)
uint32_t abi_version;       // 1
wchar_t owned_config_path[32768]; // absolute, NUL-terminated; no graphics pointers
```

Its size is 65544 bytes on both Windows architectures. The config must be a new
`ego-late-d3d11-*.ini` directly under canonical `g_reshade_base_path`. Existing
files are rejected with CREATE_NEW. The exact base directory must also contain
a regular, non-reparse `ego-owned-late-d3d11-prototype.marker` whose exact ASCII
contents are `EGO_OWNED_LATE_D3D11_PROTOTYPE_V1` followed by one LF, with no BOM.
The integration runner is responsible for making that base an owned external
stage and creating the marker there. Never create it in a game directory.

The first chain uses the supplied config. Further chains use new adjacent
`<stem>-chain-<n>.ini` files, also reserved with CREATE_NEW. ReShade's runtime
destructor saves configuration, so a foreign/global/game INI is never accepted.

`ReShadeQueryOwnedLateD3D11V1` accepts a caller-owned size/versioned 104-byte
`ego_owned_late_d3d11_stats_v1`. It reports activation state, last errors and
individual counters. It does not return callbacks, handles, graphics pointers,
STL objects or allocator ownership. Stats are diagnostic snapshots, not
acceptance evidence. Status 2 means hooks activated; it does not mean an overlay
was authenticated, rendered or accepted. Status 3 leaves any installed hook
passive for the rest of target lifetime; initialization is not retried.

## Discovery and forwarding

Initialization pins its own module before installing any hook. It creates one
unshown owned scratch window and a hardware D3D11 device/swapchain, bypassing
ReShade's automatic wrapping with `g_in_dxgi_runtime`. It resolves the already
loaded system D3D11 module and original creation trampoline. A scratch chain
without IDXGISwapChain3 or four distinct method addresses is rejected.

The existing ReShade hook manager installs native implementation hooks for
Present, Present1, ResizeBuffers and ResizeBuffers1. No game pointer is supplied
or scanned. The hook-manager installation is queued; all four and queued
activation must succeed before adoption is enabled. A partial failure is not
uninstalled: its wrappers forward through hook-manager trampolines, stay
inactive, and remain backed by the pinned module. No shutdown/unhook export is
provided.

Hooks skip test presents, existing `g_in_dxgi_runtime`, recursive prototype calls
and the exact owned ReShade DXGISwapChain private-data marker. Thus an automatic
proxy's original Present is forwarded instead of manually rendered again.
The normal application-to-stock-proxy path therefore keeps using its existing
automatic runtime once. An escaped raw-chain call that bypasses that proxy is
also skipped when its marker is present; this prototype does not redirect it
through a borrowed proxy pointer. Such redirection needs synchronized proxy
lifetime acquisition to avoid racing final proxy Release. Raw escape behavior
is explicitly unsupported pending that work.
Native arguments and return values are preserved, including ResizeBuffers1
arrays. D3D12/10 chains fail the exact D3D11 GetDevice requirement and are not
adopted. There are no queue heuristics.

## Runtime and native lifetime

Each raw canonical IUnknown identity gets one registry record and one manual
runtime creation attempt after successful notifier registration. Registration
requires actual raw-chain QI(ID3DDestructionNotifier) and a successful callback
registration. The notifier COM reference is immediately released; retaining it
would pin the chain. The callback cookie owns only same-module implementation
state. Registration failures erase the temporary record and are counted; a
later Present may recheck that capability. No Release count is inspected.

Device/context references are retained, but the raw chain is not retained.
Single-threaded D3D11 devices are rejected. Manual operations conservatively
share a recursive late-runtime operation mutex in these immutable experiments.
The source comment attributing this to process-global ImGui state is incorrect:
the pinned `deps/imgui_config.hpp` maps `GImGui` to a thread-local pointer, and
runtime operations select their own context. That premise does not justify a
new host-wide GUI mutex.
Enter/Leave is used only if the context already has
ID3D11Multithread protection enabled; its protection mode is never changed. The
application must already serialize immediate-context work with Present/resize,
or have enabled that protection. The per-chain lock alone does not synchronize
different chains sharing an unprotected context or application graphics calls.
The order for create, update, reset/reinit and destruction is retained native
context acquisition/Enter, then the late-runtime mutex, then the per-chain state
lock. Context references are copied under a brief state lock that is released
before Enter. No context mode is changed and no context/operation lock is held
over native ResizeBuffers. This mutex serializes only these late runtimes;
per-runtime lifetime and shared native-context synchronization still require
their own concurrency coverage.
Rendering uses public ReShadeCreateEffectRuntime and
ReShadeUpdateAndPresentEffectRuntime. The existing ReShade state block performs
normal render-state capture/restore; this adapter adds no blanket ClearState or
state restoration that could conceal a runtime defect.

Resize resets resources on the same internal runtime object before the native
call and reinitializes afterward on success or the stock recoverable
DXGI_ERROR_INVALID_CALL case. The D3D11 multithread lock is not held over native
ResizeBuffers. The old HWND/input/runtime identity is retained rather than
destroying and recreating a whole manual runtime for each resize.

The public manual API omits swapchain lifecycle events. This adapter emits
init_swapchain once after successful public creation and before the first
update. Initial public creation has already emitted init_effect_runtime, so
that first order differs from a stock proxy. Resize follows stock order:
runtime on_reset, destroy_swapchain(true), native resize, init_swapchain(true)
and fullscreen state, then runtime on_init. Final notification calls on_reset,
destroy_swapchain(false), then public DestroyEffectRuntime (whose second reset
is a no-op) before the wrapper is deleted. That final event is required for EGO
surface/transport drain and surviving-surface promotion, not merely texture
retirement. A separate persistent final-removal obligation survives every
resize-only destroy. Final notification consumes it exactly once even when a
failed native resize left the resize environment inactive.

A public creation failure on a verified <=16-by-16 placeholder is a distinct
waiting-for-surface state. A later successful resize retries manual creation
with the same owned config and notifier record. It is not treated as quarantine
or permission to initialize a second host. Other creation failures remain
rejected. Reset state also survives a native resize failure, so a later valid
resize can recover without repeating an already completed resource reset.

The destruction callback first marks the record dead, then tears down only its
runtime and retained device/context objects. It never QIs, releases or calls a
method on the destructing chain. This relies on the cached HWND patch and on the
audited **owned staged EGO callbacks** never dereferencing the runtime's native
chain during destruction. It is not safe as a generic foreign-add-on promise.
The notifier's exact support on the target DXGI implementation and the absence
of a runtime/backbuffer reference cycle must be measured by the fixture.
Exceptions quarantine the record/resources until target exit; teardown is not
retried after a partial failure. These errors remain visible in stats.

## Unproven limitations and required gates

- Compilation/linking and actual runs cover only the isolated x64 Release
  builds. The same-caller/add-on A/B completed: V1 failed final retirement with
  zero callbacks; V2 passed with one retirement before device/context release.
  The controlled result does not cover other DXGI implementations or repeated
  chain replacement. No production runtime generation/build ID was changed.
- Scratch method-address coverage is implementation dependent; other adapters,
  driver layers, custom interfaces and interposers need separate measurements.
  Installing arbitrary additional targets with the same hook replacement is
  not supported by the current hook-manager API.
- Microsoft does not explicitly guarantee IDXGISwapChain notifier support on
  every implementation. Unsupported chains are forwarded without adoption.
- Final native destruction passed for the single measured V2 raw chain.
  Notification ordering beyond that case, retained COM objects, callback lock
  ordering and repeated chain replacement need further controlled tests. An
  adoption counter is not evidence that retirement worked.
- Runtime on_init recalculates primary input ownership. Keeping a runtime object
  through resize alone does not fix same-HWND multi-swapchain primary loss or
  promotion after final destruction. Parent-owned input coordination work and
  dedicated input gates are required before broader acceptance.
- The manual API does not synthesize stock device/queue events. This adapter
  supplies swapchain events, but first public creation still emits the effect
  event earlier than the swapchain event. The initial generic adapter must
  tolerate that order and lazy device initialization. Full event/feature parity
  remains to be verified.
- Present1 dirty rectangles and partial presentation need feature coverage. The
  prototype preserves the supplied parameters, matching the pinned stock proxy;
  no additional host policy is justified by a source difference here alone.
- Multiple render/presentation threads, nested foreign callbacks, device loss,
  HDR/color-space changes, state restoration during initialization and every
  feature/pixel/input behavior remain explicit acceptance work.
- The public manual runtime path does not take an add-on-manager reference.
  Production needs completion-safe first add-on initialization before hook
  activation and a retained manager reference preventing callback teardown.
  The existing interlocked reference count alone does not serialize the full
  first initialization body. This is separate from ImGui's thread-local state.

Further acceptance must extend the measured raw-discovery/pixel/input path with
automatic/raw deduplication, failed resize, same-HWND ownership, transient
QI/releases, concurrent lifetime behavior and bounded resources across repeated
chain replacement. Do not relabel the host-assisted API proof, this source
artifact or the single-chain A/B as those broader results.
