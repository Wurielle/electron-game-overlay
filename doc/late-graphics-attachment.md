# Late graphics attachment: owned D3D11 support and D3D12 limits

The owned runtime now supports late D3D11 swap-chain discovery and adoption.
Generation 16, build `E8FE3783F29E4FB297D8B006D0087725`, passed eight actual
x64/Win32 standalone and same-HWND resize/final-destroy/paused-primary cases,
plus delayed-UI-thread recovery on both architectures. All four original Gun
Frog lanes and the independently installed gen11/gen16 startup-order ×
graceful/crash matrix passed, including survivor-only fresh-game relaunch.
The [readiness record](readiness-acceptance-2026-11-01.md) retains exact hashes
and separates each case from the complete final control/input/backend/resource
acceptance and its explicit limits.

The implementation is a pinned, owned-only patch on upstream ReShade, with a
guarded bootstrap, exact stage marker and native swap-chain discovery. It
deduplicates automatically created runtimes and handles resize, retirement and
same-HWND input ownership. It does not require the application to supply native
graphics pointers or place files in a clean game's directory. It never enables
late adoption by changing a foreign ReShade installation.

The unbarriered folder-watcher/relaunch case passed on generations 15 and 16;
the [final control report](../build/readiness-gen16-control-20261101-205505/report.json)
retains the current pass. Polling or ETW alone still cannot
make an independently launched game's graphics initialization wait. A passing
pre-device test barrier must not be substituted for this unbarriered case.
Generic late D3D12 attachment remains unavailable: authoritative presentation
queue provenance has not been recovered through a documented general API.

The [cooperative contract](cooperative-addons.md) still applies: retain one
possibly consumed ReShade initialization claim for the exact live process,
never inject a second host after a timeout, and never patch a foreign ReShade
installation to enable late attachment.

## Public ReShade manual runtime API

The pinned ReShade header exposes creation, update/present, and destruction of
manual effect runtimes. The caller supplies its existing native device,
command queue/context, and swap chain; D3D12 requires an
`ID3D12CommandQueue`, whereas D3D11 uses an immediate device context. The caller
also owns the native objects' lifetime and the reset/destruction sequence.
These calls must not be used to update or destroy automatically created
runtimes. See the [pinned public header](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/include/reshade.hpp).

The initial isolated [D3D11 fixture](../libs/electron-game-overlay-runtime/tests/late-d3d11-adoption/README.md)
completed an x64 hardware API lifecycle run after 60 native presents:
599 manual render/state checks, zero sampled state mismatches, and successful
destroy/recreate around resize. Its first authenticated SDK scene attempt
failed a strict desktop sample. Later observed-ON controls passed exact pixels,
input and resize using retained generation-12 native bytes; the
[display evidence](rendering-display-power-evidence.md) preserves the causal
limits. Those controls do not diagnose every earlier white sample or the
historical D3D11 GPU hang.

The manual fixture receives exact graphics pointers and remains isolated
research evidence. The separately integrated owned-runtime path discovers
native D3D11 swap chains itself and has the generation-16 lifecycle/input
acceptance described above. Neither self-loading fixture should be labeled
automatic process attachment; the watcher and real-game cases establish their
own boundaries.

## D3D12 queue provenance

The presentation queue is an input to swap-chain creation. Microsoft states
that presentation runs on that queue. `ResizeBuffers1` can subsequently provide
different queues for individual back buffers, rotating the queue together with
the buffer. A device pointer or one observed graphics queue is insufficient to
recover this association. See [D3D12 swap chains](https://learn.microsoft.com/en-us/windows/win32/direct3d12/swap-chains)
and [per-buffer presentation queues](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/nf-dxgi1_4-idxgiswapchain3-resizebuffers1).

`IDXGIDeviceSubObject::GetDevice` documents retrieval of interfaces published by
the device. It does not promise the original presentation queue.
[Microsoft reference](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgidevicesubobject-getdevice).

Microsoft documents an `ID3D12SwapChainAssistant` resource/queue getter, but no
acquisition path from an ordinary existing DXGI swap chain or back buffer was
found. Its compatibility API instead accepts an assistant supplied by its
caller; Microsoft's translation layer constructs such an assistant itself.
Those sources establish a supplied association object, not a portable reverse
lookup. See the [assistant interface](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nn-d3d12-id3d12swapchainassistant),
[compatibility header](https://github.com/microsoft/DirectX-Headers/blob/main/include/directx/d3d12compatibility.h),
and [translation-layer implementation](https://github.com/microsoft/D3D12TranslationLayer/blob/master/src/Resource.cpp).

The controlled x64 GTX 1080 probe on 2026-11-01 completed 60 D3D12 presents, then
recorded the following actual COM results. It loaded no ReShade and installed no
hooks. A [portable dated record](../libs/electron-game-overlay-runtime/tests/late-d3d12-queue-query/evidence-2026-11-01.json)
retains the results and artifact identities; the full report is in
`build/late-d3d12-queue-query/runs/run-2b76dfe1c5914f8d97712b7fea52d8c7/report.json`.

| Query | Result |
| --- | --- |
| Swap chain `QueryInterface(ID3D12SwapChainAssistant)` | `E_NOINTERFACE` (`0x80004002`) |
| Current back buffer `QueryInterface(ID3D12SwapChainAssistant)` | `E_NOINTERFACE` (`0x80004002`) |
| Swap chain `GetDevice(ID3D12CommandQueue)` | `E_NOINTERFACE` (`0x80004002`) |
| Swap chain `GetDevice(ID3D12Device)` | `S_OK`; exact known device identity |

These results describe this machine and runtime. They are not proof that every
Windows implementation rejects the interfaces, nor an acquisition guarantee
for an implementation that happens to accept one.

Creating a new queue does not solve synchronization by itself. D3D12 requires
explicit fence ordering for dependent work across queues. A resource barrier
declares state transitions and associated cache/layout synchronization; it does
not discover unknown queues or wait for their work. Watching the last queue to
execute, or only the last writer of a back buffer, can miss another queue's
concurrent reads. Such a heuristic does not establish a safe general overlay
write. See [command-list and queue synchronization](https://learn.microsoft.com/en-us/windows/win32/direct3d12/executing-and-synchronizing-command-lists)
and [resource barriers](https://learn.microsoft.com/en-us/windows/win32/direct3d12/using-resource-barriers-to-synchronize-resource-states-in-direct3d-12).

The defensible current conclusion is that no documented general D3D12 queue
recovery path has been found. Automatic late adoption must stay unavailable
until it has authoritative queue provenance and synchronization, rather than
guessing. Capturing a future successful creation/`ResizeBuffers1` call can
provide authoritative arguments for that event, but does not reconstruct the
missing earlier association.

## Deterministic launch design

A separate SDK-owned launch path can arrange hooks before a newly launched
target initializes graphics, instead of racing a watcher. The production launch
API is not implemented or accepted; the isolated proofs below cover narrower
startup and overlay boundaries.

Microsoft Detours documents `DetourCreateProcessWithDllEx` as creating the
process suspended, inserting a DLL as its first in-memory import, then resuming
the loader. It supports architecture-matched helpers and restores the in-memory
import table through `DetourRestoreAfterWith`; it does not require rewriting
the game executable on disk. See [the first-import API](https://github.com/microsoft/Detours/wiki/DetourCreateProcessWithDllEx)
and [helper requirements](https://github.com/microsoft/Detours/wiki/OverviewHelpers).

An implementation needs an audited, architecture-matched first-import
bootstrap/owned-host arrangement that actually installs the graphics hooks
before original game initialization. Merely starting a worker from `DllMain`
is insufficient.

The current owned x64 and x86 ReShade PE files already export ordinal 1 as
`D2D1CreateFactory`. Detours' ordinary import insertion resolves that export but
does not call it. The isolated actual-ReShade experiment prepends two imports in
order: the exact owned ReShade DLL, then a minimal EGO restoration DLL. ReShade
uses its existing loader entry point; the second DLL calls the official
`DetourRestoreAfterWith` to restore the original in-memory PE headers. No
ReShade modification, custom `LoadLibrary` call in an EGO loader callback, or
EGO feature implementation in the restoration core is required by this design.
The ordinary ReShade add-on scan can then load the first app's EGO engine at
graphics initialization. See [the import construction](https://github.com/microsoft/Detours/blob/e4bfd6b03e50de46b47abfbd1e46b384f0c5f833/src/uimports.cpp)
and [restoration API](https://github.com/microsoft/Detours/wiki/DetourRestoreAfterWith).

This two-import experiment must disable Detours' helper-process fallback: that
path would invoke ordinal 1 using the helper signature, which is invalid for a
ReShade factory export. It must also validate the actual ordinal/export and
exact staged bytes before use. PE import names are narrow strings; silently
passing UTF-8 is not a general Unicode-path solution. The isolated experiment
uses strict Windows ANSI-code-page round-trip validation and rejects an
unrepresentable path. Production still needs a complete Unicode staging plan.

`CREATE_SUSPENDED` plus an ordinary remote `LoadLibrary` is a weaker claim.
Windows serializes remote-thread execution with process DLL initialization, so
an original DLL initializer can run before the injected thread. It must not be
advertised as universally pre-graphics without stronger proof. See
[process-creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
and [remote-thread initialization ordering](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createremotethread).

The launch API would retain the exact process/thread handles, PID and creation
time; prepare the route and target-derived configuration through the existing
native ownership/transaction boundary; resolve a pre-existing foreign host
without changing it; and resume only through its owned initialization sequence.
Any possibly consumed initialization remains claimed until authoritative target
exit. Launcher failure needs a concrete bounded result, not another host load.

The isolated [first-import proof](../libs/electron-game-overlay-runtime/tests/early-process-bootstrap/README.md)
now separates the original DLL attach callback from supported graphics creation
in an EXE CRT initializer before `wmain`. Its initial attempt at successful
D3D12 creation directly inside `DllMain` failed with `DXGI_ERROR_UNSUPPORTED`;
that failed stress evidence is retained. Microsoft documents DXGI factory
errors from `DllMain` and recommends avoiding Direct3D/DXGI calls there.
The corrected proof must not be described as successful graphics creation in a
DLL loader callback. See [DXGI restrictions](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/d3d10-graphics-programming-guide-dxgi#dxgi-responses-from-dllmain).
The corrected x64 controlled proof has passed with 14 ordered events, one
successful intercepted pre-main device creation, exact device/queue identity,
and 60 successful fenced hardware presents. It did not load ReShade, so it is
not acceptance of the two-import ReShade design or of any overlay feature.

A separate [actual owned-ReShade D3D12 proof](../libs/electron-game-overlay-runtime/tests/early-reshade-bootstrap/README.md)
has now passed separately on x64 and Win32. Its outer controller verified exact
red desktop pixels, DOM keyboard/pointer delivery, native interception/release, a real 800x600 to
960x640 resize, and one authenticated private connection throughout. The
native lifecycle recorded 16 ordered events, one ReShade, restoration before
successful pre-main graphics creation, 164 presents (104 after resize) in each
run, and graceful cleanup. The packaged ReShade and engine bytes were unchanged. This
used a fresh workspace-owned fixture, not a real game or foreign installation,
and does not activate a production launch API or complete generic late/Steam
attachment. The native-only validator intentionally makes no pixel/input claim;
those assertions come from the outer controller.

The next production step is a native launch operation that creates the exact
target suspended, records its authoritative identity, applies existing
foreign-install and configuration preflight, and reserves the same durable
target-side initialization ownership
used by other attachment paths before changing imports. Later apps keep their
own engines and transports and join that one host. There is no feature election
or update logic in the minimal restoration DLL.

The controlled proof's kill-on-close job is a cleanup mechanism, not a complete
production lifetime policy. A production launcher must hand off after durable
target ownership and runtime readiness, removing the startup termination policy
so that its app's later crash cannot terminate the game or surviving apps. Both
pre-handoff failure cleanup and post-handoff app-crash survival need acceptance.

Required acceptance includes hooks preceding original DLL attach and supported
pre-main graphics initialization, x64/x86, all supported graphics backends, per-child environment
isolation, a second application's late join, preserved existing installations,
relaunch, all overlay input/rendering features, and real-game runs. A launcher
that delegates creation to Steam or another parent may not control the actual
game's initial thread; that case still needs late adoption or an explicit
launcher integration. This launch design does not complete the generic Steam
folder-watch attachment requirement.
