# Genuine SDK/native resource soak

The human-facing launcher is
`scripts/test-cases/client-sdk-cooperative-resource-soak.ps1`. The separate
`cooperative-resource-soak.ps1` launcher runs the controlled registry fixture;
these establish different evidence boundaries.

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/client-sdk-cooperative-resource-soak.ps1 `
    -TargetExecutable C:/absolute/workspace/build/path/controlled-graphics-host.exe `
    -TargetArguments @('--controlled-host-option') `
    -SdkDist C:/absolute/sdk-package/dist `
    -Cycles 8
```

Supply an already built x64 controlled graphics host beneath this workspace's
`build` directory. It must support the existing test-only startup barrier and
keep rendering until terminated by its owner. The
gate refuses an already running matching source executable, copies the target
to a unique owned directory/name, and retains the exact child process handle.
It does not build artifacts or launch a game. All producer children and the
graphics target belong to this run. Cleanup uses retained process objects;
it never kills processes by name.

Before target launch, the gate writes startup/injection-wait markers only in
the owned copied target directory. It waits for successful full-runtime injector
proof and exact selected PID/image/creation identity before deleting those exact
nonce-checked marker files. Authentication and rendering are required after the
barrier is released. No generic unbarriered best-effort startup is treated as
deterministic acceptance.

The exact-PID injector emits a V1 selected-PID line. Its creation evidence comes
from the SDK's native-manager-derived `--expected-creation-time-100ns` binding,
which the injector enforces before mutation. The producer requires that bound
invocation, the single selected-PID line and validated result image/PID to agree;
the controller then compares creation to its retained target handle. A V2
future-target identity record is validated directly when present.

`ElectronExecutable` and `SdkDist` default to the workspace Electron executable
and sealed SDK dist. `Cycles` is bounded to 1–64 and defaults to 8. Run from a
64-bit PowerShell process. The SDK producer, native module evidence collector
and registry observer currently support the x64 lane only.

The survivor remains in one Electron process/session/private stage. Every churn
cycle uses a fresh stage. Odd cycles start a fresh Electron process; even cycles
recreate its public SDK session in the same Electron process. After each churn
session closes, the gate requires exactly zero windows/ranks/interception for
its participant and removal of its TCP peer/worker. A dormant participant and
its pinned module/frame worker intentionally remain until target exit. The
exact cumulative expected counts are one survivor plus one fresh native stage
per cycle; they are not compared against a loose memory threshold.

At active and dormant checkpoints, the read-only observer validates target PID
and creation FILETIME, copies the current registry under its existing mutex,
and records exact module paths, participant callback owners, windows/ranks and
named frame/TCP thread IDs. The gate requires the survivor private credential
fingerprint, stage path, TCP tuple and worker IDs to remain unchanged, with fresh
FPS telemetry and its registered painted window. Independent file checks bind
every observed EGO module path/hash/size/ABI/build ID and the sole ReShade host
to the supplied SDK. Dormant ownership cannot retain focus/capture, and final
closure requires zero exact-target established TCP endpoints. Unknown registry
layouts, missing observations and changed
module identities fail closed. No production debug ABI is added.

Private bytes and total handle counts are retained as diagnostics. This gate
does not establish pixel correctness, physical input, GPU resource reclamation,
long-duration reliability, released-package compatibility or 500-app capacity.
The controlled fixture separately exercises exact participant exhaustion.

The eight-cycle x64 D3D11 run on 2026-11-01 passed with generation 14, add-on
build `412D57BEA49440738CC4C3903038F2E7`, and the fresh-session SDK fix. Its
[portable evidence](../tests/cooperative-resource-soak/sdk-evidence-2026-11-01.json)
contains the native/JavaScript hashes, all checkpoint counts, artifact hashes
and failure history. Independent review checked all eight active and dormant
snapshots, survivor states and mapped-module evidence. Four churn Electron
processes each ran two sessions, giving four process starts and four session
recreations. Each cycle added one private staged engine, reaching nine engines,
participant slots and retained frame workers, with one recorded ReShade host.

Every active checkpoint had two TCP workers, windows and ranks; every churn
close returned those counts to one. The survivor kept its process, stage,
private route, frame/TCP worker IDs and advancing FPS observations. Final app
closure left zero TCP workers/connections, windows, ranks, focus, capture and
interception requests, while nine pinned engines/frame workers remained before
target termination. The recorded checkpoint interval was 52.918 seconds.
Private bytes grew from 77,320,192 to 105,410,560 and total handles from 933 to
1,001; these diagnostics are retained and do not establish flat resource use.

The earlier generation-13 attempt exposed a native leak: session deactivation
removed pixels but retained its registration rank. Commit `fed59e6` now clears
authoritative registrations on epoch transitions while preserving active
raster gaps and survivor order/focus/capture. Its generation-14 rerun passed
that dormant checkpoint, then exposed an SDK bug: a new session reused the old
private namespace and its consumed claim rejected the new staged route.
Commit `82faedb` gives each new public session a fresh private backend while
preserving old claims. The final run exercised both fixes. The portable record
distinguishes their native/JavaScript hashes and failed-run evidence; neither
failure was resolved by weakening the acceptance checks.

Owned run/target names use short GUID-derived identifiers. Before launch, the
gate projects the longest packaged/runtime control filename through cycle 1,024
and rejects any staged path over 240 Windows characters. A directory collision
fails instead of reusing an existing run.

All evidence remains under `build/cooperative-resource-soak/r-*`, including
producer commands/states/events, resource checkpoints, native-file evidence,
stdout/stderr and `evidence.json`. The isolated tests execute only pure controller
functions, inert file parsing and controlled SDK objects; they are separate
from the recorded executing SDK/native run:

```powershell
node --test apps/client/tests/cooperative-resource-soak-fixture.test.cjs `
    apps/client/tests/cooperative-resource-soak-evidence.test.cjs `
    apps/client/tests/cooperative-resource-snapshot.test.cjs `
    apps/client/tests/cooperative-resource-soak-gate.test.cjs
```
