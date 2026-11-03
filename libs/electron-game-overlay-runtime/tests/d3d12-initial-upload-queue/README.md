# Initial D3D12 texture upload queue regression

This console fixture uses an owned ReShade DLL and its public API 18 device and
queue callbacks. It creates one real D3D12 device and two exact graphics queues.
It creates no window or swap chain and performs no injection or game mutation.

The previous initial-upload path passed pixel data to `device::create_resource`.
The pinned ReShade implementation selects its last-used per-thread immediate
queue for that device. The selected queue need not be the effect runtime's queue.
In a multi-queue application this can record work into another queue without its
owner's lock, or wait for work whose prerequisite signal the current thread has
not submitted yet. The separate existing texture-update path already selects
the runtime queue before its device upload.

The production initial-upload helper instead creates a mapped upload buffer,
copies it through the exact runtime command list, transitions the texture from
`COPY_DEST` to shader-resource usage, and waits on that same queue before freeing
the staging buffer. It uses the supported `copy_buffer_to_texture` capability;
D3D12 does not advertise the public command-list texture-update capability.
D3D9, D3D10 and D3D11 retain their original create-with-data path.

The fixture runs two fresh processes:

- The positive process primes ReShade's device-level selector with queue B and
  blocks B on a fixture-owned fence. The compiled production helper must upload
  through A and pass actual GPU readback while B remains blocked. All RGBA bytes
  in a 67 by 3 texture must match. Its padded CPU source stride is 280 bytes; its
  D3D12 transfer pitch is 512 bytes.
- The negative control uses the previous device-level initial-data call. It must
  depend on B and remain blocked until the three-second watchdog releases B.
  Readback must still match afterward. This distinguishes the original defect
  from a setup failure or an upload that never happened.

The fixture proves exact device/queue association through public D3D12 private
data markers, not private proxy layouts. Its report retains PID, creation
FILETIME, executable path, adapter, compiled helper SHA256, fence observations,
timing and pixel equality. The launcher verifies the copied runtime hash and
current helper hash. A software adapter is accepted only with explicit `-Warp`.

Run from the repository root after the normal SDK build:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-initial-upload-queue.ps1
& ./libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-initial-upload-queue.ps1 -Architecture Win32
```

`-RuntimePath` selects another explicitly supplied owned runtime. `-SkipBuild`
requires a fixture compiled with the current helper; the report hash prevents a
stale fixture from passing. Evidence is retained under
`build/d3d12-initial-upload-queue`.

Actual hardware runs on 2026-11-01 passed on x64 and Win32 using the NVIDIA
GeForce GTX 1080. The exact-queue helper completed with all pixels correct while
B remained blocked (3 ms on x64, 4 ms on Win32). The legacy negative controls
depended on the watchdog release (3012 ms and 3009 ms respectively). These times
distinguish the queue dependency in this tiny controlled transfer; they are not
a throughput or application-performance claim. Portable source/evidence hashes
and exact observations are retained in `evidence-2026-11-01.json`.

This is a controlled queue/resource regression, not game, overlay rendering,
input, multi-app or performance acceptance. It does not explain or claim to fix
the earlier Gun Frog D3D11 device-hang observation. Those boundaries require
their separate real-game tests and first-device-loss evidence.
