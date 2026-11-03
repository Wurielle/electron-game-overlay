# Controlled D3D12 queue-query probe

This standalone Windows fixture measures public COM query capabilities on an owned
D3D12 swapchain. It does not load ReShade, install hooks, scan memory, use private
interfaces, infer a queue, or call `InsertImplicitSync`.

The host creates a known D3D12 device, a known DIRECT queue, and a raw DXGI
swapchain supplied with that queue. It clears, presents, and GPU-fence-completes
60 frames before querying anything. Every counted Present must return `S_OK`;
occluded/status presentations and an early window close do not count as success.
WARP is an explicit optional mode; hardware selection does not silently fall back.

It records exact HRESULTs for:

- Raw swapchain `QueryInterface(ID3D12SwapChainAssistant)`.
- Raw swapchain `GetDevice(ID3D12CommandQueue)`.
- Current backbuffer `QueryInterface(ID3D12SwapChainAssistant)`.
- Normal swapchain `GetDevice(ID3D12Device)`.

For each successfully queried assistant it calls only `GetSwapChainObject`
(requesting `IUnknown`, then `IDXGISwapChain`) and
`GetCurrentResourceAndCommandQueue`. It compares returned canonical `IUnknown`
identities against the known swapchain, current backbuffer and queue, and checks
the queue type and its device identity. The report includes the current buffer
index before and after queries and the loaded graphics-module paths.

These results describe only the exact run. `E_NOINTERFACE` is a valid completed
capability measurement, not a failed graphics test. A successful query alone does
not establish that its result matches ground truth. This is not overlay, input,
late-injection, real-game, or all-backend acceptance evidence.

The [dated x64 hardware result](evidence-2026-11-01.json) completed 60 presents
on the GTX 1080. Both assistant queries and the command-queue `GetDevice` query
returned `E_NOINTERFACE`; the ordinary device query succeeded and matched the
known device identity. This records that tested runtime, without claiming that
all Windows implementations behave the same way.

## Build without running

From the repository root, in PowerShell:

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/late-d3d12-queue-query -B build/late-d3d12-queue-query/compile-x64 -G 'Visual Studio 17 2022' -A x64
cmake --build build/late-d3d12-queue-query/compile-x64 --config Release --target late_d3d12_queue_query_host
```

`-A Win32` and a separate `compile-Win32` directory build the x86 fixture.
No production CMake target or mapped implementation is changed.

## Run on the desktop

The dedicated launcher is
`libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d12-queue-query.ps1`.
It creates a unique stage under `build/late-d3d12-queue-query/runs`, copies only the
probe executable there, and produces `report.json`, `stdout.log`, and
`stderr.log`. The fixture creates its own visible window and exits after querying.
Do not point it at an existing game directory or copy game/ReShade files into the
stage. The host requires an absolute, previously nonexistent report path beside
its executable and uses `CREATE_NEW` so it never overwrites an existing report.

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d12-queue-query.ps1
# Optional independently measured software implementation:
& ./libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d12-queue-query.ps1 -Warp
```

Building does not execute the host. GUI execution must be coordinated with other
desktop acceptance work. No execution results are included merely by building.
