# Optional preloaded add-ons: controlled DirectX acceptance

The two human-facing launchers use only copied repository DirectX demos:

```powershell
./libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-client-sdk-preloaded-addons.ps1 -SkipBuild
./libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk-preloaded-addons.ps1 -SkipBuild
```

The SDK distributions and demo executables must already be built. Omitting
`-SkipBuild` rebuilds the chosen demo, not the SDK distributions. Optional
`-SdkDistA` and `-SdkDistB` select separately built, sealed distributions. By
default both apps use the current distribution; the report explicitly records
whether the native build IDs differ. An older build without dormant preload
support cannot establish offline preload compatibility. It belongs in the
separate dynamic late-join compatibility suite.

The internal runner has two distinct cells per backend:

1. **`self-load`** registers both apps through the pure Node installer API and
   assembles a test-owned host snapshot with the same internal snapshot builder
   as SDK staging. The copied demo reads its explicit test marker and self-loads
   an external runtime before creating a device. Real ReShade scans its external
   `AddonPath`. Eight successful Presents and OS snapshots must show both exact
   registered DLLs, zero private participants/windows/ranks/frame workers/TCP
   workers, and neither application running. The first scanner-loaded module is
   identified from ReShade's load log; the other app starts first, so the original
   dispatcher's supplying application remains offline. This is a scanner and
   dormant-activation proof, not a production injection claim.
2. **`production-injection`** starts the copied demo behind its pre-device
   barrier, then starts one real Electron app. Its genuine public SDK launcher
   stages the registered snapshot and injects the first host. The strict initial
   native result must retain `injected-runtime` provenance. OS hashes and the
   private participant record must identify the scanned selected implementation,
   while the other registered DLL remains dormant until its app starts. This
   cell proves production injected-host `AddonPath` wiring separately.

Before releasing the device barrier, the controller requires the injector's
native return, its captured exact `--pid` and `--expected-creation-time-100ns`
arguments, the retained authoritative OS process identity, and full mapped host
and selected add-on file hashes. The same proof is checked after graphics starts.
A legacy PID-only native selection line is not treated as a creation-time
witness; the separate watcher helper retains its stronger V2 selection contract.

Both cells require unchanged mapped bases and no extra DLL on each initial
activation, one ReShade host, distinct authenticated private routes, colliding
local window IDs, interleaved surfaces, transparent hit testing, independent
typing, three native cursor shapes, both wheel axes, caption dragging and shared
OR interception. A crashed peer must release its surfaces and input while the
survivor continues. Restarting the crashed app must use one fresh staged engine
after its original preloaded module has consumed a route. Unregistering that app
must omit it from a future snapshot while preserving the current snapshot and
mapped modules. Final cleanup must leave no windows, ranks, private TCP worker,
focus or capture. Retained mapped native code/frame workers are recorded.

Evidence is retained under `build/pl/r-<id>`; compact paths keep the native
snapshot's longest projected payload path below 240 characters. `report.json`
and each cell's `result.json` distinguish success, failure and cleanup errors.
Resource snapshots include OS module paths/bases, registry state and named
workers. Hashes attest the corresponding files, not remote-memory bytes or the
historical number of load attempts. The demo's first-Present acknowledgment is
bound to its PID and creation FILETIME and explicitly represents successful API
returns, not independent display timing.

Unexpected target exit records include the signed exit code, its hexadecimal
Windows representation and exact process creation identity. Cleanup separately
records whether the controller requested `WM_CLOSE` or forced termination. The
opt-in demo diagnostics preserve initial graphics HRESULTs and ordinary graphics
failure messages, so a normal failed device-creation return can be distinguished
from an exception. Restart coverage proves a fresh engine after a consumed route;
it does not claim simultaneous same-application contention or a direct oracle for
the native error-85 fallback. Requested-disabled-add-on rejection belongs to the
separate native loader contract tests.

Input is Windows `SendInput`, including ordinary virtual-key down/up pairs. This
does not replace or claim a physical-key gate. The D3D12 pre-device barrier avoids
the separate generic late-D3D12 queue-adoption limitation. No installed user game
is discovered, opened or modified by this family.

The separate mixed-version case uses a registered current build as the sole
dormant dispatcher and the retained **unregistered generation-16 SDK** as a
dynamic participant. It uses the current SDK's owned host and exact reserved
owned-runtime marker. It does not claim compatibility with an arbitrary foreign
stock host whose only mapped modules are dormant:

```powershell
./libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-client-sdk-unregistered-addon-compatibility.ps1 -SkipBuild
./libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk-unregistered-addon-compatibility.ps1 -SkipBuild
```

Its default old SDK is the independently npm-installed `consumer-b` under
`build/installed-cooperative-pair-gen11-gen16-async-20261101-final`. The producer
resolves `electron-game-overlay` through that consumer's package scope and records
the installed public-entrypoint proof. It verifies the exact generation-16
native engine and private route while the registered current app remains
offline, then activates the current preloaded engine without another DLL.
Interleaved surfaces, transparent input, separate keyboard focus and shared
interception cross the implementation versions. Finally, the registered
dispatcher's supplying app crashes; the older app must preserve its authenticated
route, rendering and input. This case never registers or preloads generation 16,
and makes no claim that the old build supports dormant activation.
