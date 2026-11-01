# Isolated first-import process bootstrap proof

This source-only experiment tests a deterministic startup mechanism for a new
owned process. It is separate from production SDK packaging and the unbarriered
Steam folder watcher. It does not load ReShade, render an EGO scene, attach to an
existing process, modify a game executable, or establish game acceptance.

The launcher uses official Microsoft Detours `DetourCreateProcessWithDllExW`
to insert the small proof DLL as the first **in-memory** import of the controlled
host. The host remains suspended while its retained process handle, image path,
PID and exact creation FILETIME are checked. Only that newly created process is
resumed. Its original on-disk import table and executable stay unchanged.
The process-creation callback forwards exactly one call for that controlled
target and rejects any later Detours helper fallback. A failed direct import
rewrite therefore fails the proof instead of starting an unbound `rundll32`
helper with an unbounded wait. Both tested build variants use matching
launcher/bootstrap/target architectures.

The bootstrap DLL follows the official Detours sample's transaction pattern:
the ordinal-1 `DetourFinishHelperProcess` export, helper-process detection,
`DetourRestoreAfterWith`, and a detour of the statically imported
`D3D12CreateDevice`. The bootstrap never calls `LoadLibrary` or initializes a
ReShade runtime from `DllMain`. The hook observes one actual device call and
passes its arguments/result through to the real function.

The controlled host statically imports a different original DLL. Its
`DLL_PROCESS_ATTACH` records entry/return only. An EXE CRT global constructor
then calls that DLL's one-shot exported graphics initializer, after DLL loader
initialization has finished and before `wmain`. This initializer creates the
actual D3D12 device and DIRECT queue. A sized, one-shot getter transfers their
COM references to the host. The host verifies the queue's exact device identity,
rejects a software adapter, and requires 60 real successful presentations with
GPU fences using those same objects.

An earlier x64 stress attempt tried to create D3D12 graphics directly in the
original DLL's `DllMain`. Its bootstrap ordering/hook ran, but device creation
returned `DXGI_ERROR_UNSUPPORTED` (`0x887A0004`) and no frames were presented.
That [recorded attempt remains failed](evidence-dll-main-stress-2026-11-01.json).
Microsoft documents DXGI factory errors from `DllMain` and recommends avoiding
Direct3D/DXGI calls there. Requiring successful device creation in that context
was an invalid fixture expectation. The corrected pre-main proof does not
accept that failed HRESULT, retry it later in the same process, or claim
successful graphics creation from a DLL loader callback. See
[DXGI's loader-callback restrictions](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/d3d10-graphics-programming-guide-dxgi#dxgi-responses-from-dllmain).

The trace must show bootstrap readiness before the original DLL attach callback,
its completed return before the EXE CRT initializer, the intercepted device call
inside that pre-main graphics initializer, then `wmain` entry and 60 completed
presents. Every trace/report carries the same PID and exact
creation FILETIME string. `validate-evidence.cjs` checks the bounded event order,
initial loader thread, monotonic QPC values, exact device-call count, successful
HRESULTs, presentation count, and the explicit limits of the proof.

The native launcher atomically places its owned child in a private
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job through the process-start job attribute.
The job is unnamed and affects only this copied controlled host. The native
wait is bounded to 30 seconds; the PowerShell helper wait is bounded to 45
seconds. Closing/crashing the launcher closes the sole job handle and prevents
an abandoned suspended or deadlocked controlled child. No other process is
selected, suspended, terminated, or added to that job.

## Official dependency and licensing

No Detours source/header/library was found in the initial repository, worktree,
or development caches. The initial setup fetched only the official repository:

```powershell
git clone --depth 1 --branch v4.0.1 --single-branch `
  https://github.com/microsoft/Detours.git `
  build/early-process-bootstrap-deps/Detours-v4.0.1
git -C build/early-process-bootstrap-deps/Detours-v4.0.1 rev-parse HEAD
```

The expected release commit is
`e4bfd6b03e50de46b47abfbd1e46b384f0c5f833`.
`detours-source-lock.json` pins every source/header compiled by this fixture and
the complete upstream MIT license. CMake and the launcher script verify those
identities after CRLF-to-LF text normalization. Unknown/modified sources fail
before compilation. No upstream code is copied into this source directory or
edited; the standalone static library is compiled directly from that verified
checkout. Each run retains the complete unchanged `LICENSE.md` as
`LICENSE.Detours.md` next to its binaries.

Primary sources: [first-import creation API](https://github.com/microsoft/Detours/wiki/DetourCreateProcessWithDllEx),
[official simple sample](https://github.com/microsoft/Detours/blob/e4bfd6b03e50de46b47abfbd1e46b384f0c5f833/samples/simple/simple.cpp),
[upstream license](https://github.com/microsoft/Detours/blob/e4bfd6b03e50de46b47abfbd1e46b384f0c5f833/LICENSE.md),
[startup job-list attribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
and [kill-on-close job behavior](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).

## Build and run

The dedicated launcher stages only fixed owned proof artifacts into a fresh
`build/early-process-bootstrap/runs/run-<guid>` directory. It records original
and copied binary hashes, source hashes, the pinned dependency identity, native
reports, and validation. It never downloads dependencies automatically or
changes global environment/registry state. Windows 10+ startup job attributes,
MSVC, CMake, Node, PowerShell 7.2+, and hardware D3D12 are required.

```powershell
& libs/electron-game-overlay-runtime/scripts/test-cases/early-process-bootstrap.ps1 `
  -Architecture x64
```

Use `-Architecture Win32` for the separate 32-bit proof.
`-DetoursSourceDirectory` may select another checkout only if every locked
source/license identity matches. `-SkipBuild` uses already compiled isolated
artifacts, still verifies the dependency and staged binary identities, and
does not alter production runtime artifacts. Both variants launch a visible
owned test window briefly; the launcher itself has no visible console window.

Pure evidence tests require no desktop/native execution:

```powershell
node --test libs/electron-game-overlay-runtime/tests/early-process-bootstrap/validate-evidence.test.cjs
```

## Acceptance boundary

The earlier DLL-main stress source compiled and ran on x64, with the failed
result retained above. The corrected x64 pre-main proof subsequently compiled
and [passed an actual run](evidence-pre-main-x64-2026-11-01.json): 14 ordered trace
events, one intercepted successful device creation before `wmain`, exact
device/queue identity, and 60 successful fenced hardware presents on a GTX 1080.
The job was bound, one process was created, and no helper fallback or timeout
occurred. This result loads no ReShade and establishes no overlay behavior.
The Win32 variant remains separate acceptance. Its evidence validator has 35
passing tests, including rejection
of the earlier stress scope, unsupported initialization phases, helper fallback,
missing/false owned-job binding, mismatched
process instances, reordered/missing/duplicate events, failed calls, altered
frame counts, cross-thread initialization, and unsupported capability claims.
That validates the oracle, not the startup mechanism.

A successful actual run would establish first-import ordering before original
DLL attach and interception of supported pre-main graphics creation for this
controlled target/architecture only. It would still leave owned
ReShade startup integration, exact host/claim/configuration handling, original
foreign-install preservation, all overlay features, real-game acceptance, and
generic Steam discovery/relaunch unproven. See the broader
[late attachment design](../../../../doc/late-graphics-attachment.md).
