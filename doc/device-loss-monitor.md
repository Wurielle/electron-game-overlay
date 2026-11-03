# First-device-loss capture tooling

The opt-in monitor is diagnostic tooling. It does not change rendering,
interception, injection, operating-system settings or WPR policy. Use PowerShell
7 and the dedicated launchers:

```powershell
pwsh -NoProfile -File ./libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-client-sdk-device-loss-monitor.ps1 -SkipBuild
pwsh -NoProfile -File ./libs/electron-game-overlay-runtime/scripts/test-cases/gun-frog-client-sdk-device-loss-monitor.ps1 -SkipBuild
pwsh -NoProfile -File ./libs/electron-game-overlay-runtime/scripts/test-cases/device-loss-monitor-synthetic-self-test.ps1
```

The controller requires a nonce-bound arm acknowledgement before its first
scripted input or human interaction READY message. It binds the monitor to the
retained target's exact PID, executable and creation FILETIME, plus explicitly
owned run logs. The child retains its own OS handle and revalidates that same
handle before dumping. It never discovers a dump target by name, injects,
suspends or terminates a target. The controller joins capture before producer,
injector or target cleanup changes the failure state.

The first observed fault in the owned logs can trigger capture: explicit
device-loss text, `DXGI_ERROR_DEVICE_REMOVED/HUNG/RESET`, their failure HRESULTs,
or an identity-bound `EGO_DEVICE_HEALTH` marker. A new `nvlddmkm` event triggers
only with explicit matching target PID in EventData; System.Execution PID and
unscoped driver events are context, not target attribution. Event monitoring
starts after an arm-time record baseline. Missing event access/continuity is
reported, not replaced with historical events.

Capture uses `MiniDumpWriteDump` with thread/module information, data segments
and indirectly referenced memory; full-memory dumping is disabled. Requests
use a 15-second writer budget and 256 MiB byte ceiling, callback cancellation,
a 17-second outer writer deadline and a 22-second controller join deadline.
Incomplete/API-failed/timed-out dumps retain an explicit unavailable status and
partial name. Up to eight owned logs receive timestamped snapshots of at most
16 MiB each. The monitor may terminate only its own writer process on timeout;
the failed target stays available until the controller's cleanup policy runs.

Each fresh directory retains `request.json`, `armed.json`, `report.json`,
monitor stdout/stderr, and, when triggered, first-fault metadata, dump/hash and
owned log snapshots. `captured` means a diagnostic artifact was produced;
`no-device-loss-observed` or normal target exit does not prove dump capture.
None of these statuses diagnoses a GPU or driver root cause.

Recorded evidence on 2026-11-01 is summarized in the portable
[evidence record](device-loss-monitor-evidence.json):

| Case | Result and boundary |
| --- | --- |
| [Two controlled D3D11 SDK cycles](../build/electron-game-overlay-runtime/client-sdk-d3d11-legacy-20261101-172747/result.txt) | Both passed. The two monitors armed with matching nonce/PID/path/FILETIME and active event subscriptions, then reported `target-exited-without-observed-device-loss`, with empty stderr and no fault/dump. This exercises actual native helper loading, child arming and normal exit handling. |
| [Synthetic console self-test](../build/device-loss-monitor/synthetic-self-test-20261101-175819-d8587a9e/self-test-report.json) | PASS using only its own hidden sleeping PowerShell child, PID 40688. Wrong PID/creation markers were ignored. The explicitly synthetic marker was detected in 47.5568 ms; dump writing began in 55.6284 ms and took 541.8064 ms. The complete 22,147,563-byte file had an MDMP signature. The exact child stayed alive through verification and exited only during owned cleanup. No GPU work or genuine device loss occurred. |

The synthetic run exercises normal `MiniDumpWriteDump`/callback interop and
produces a complete dump inside the configured bounds. Forced cancellation or
exhausted-disk paths have not been exercised by that pass. The earlier
`synthetic-self-test-20261101-175702-870ab963` attempt produced a complete dump
but failed its harness timing assertion: parsing JSON-decoded DateTime objects
through local-culture strings lost subsecond precision. Its failed report is
retained. Direct typed conversion and a JSON-roundtrip regression corrected
that harness issue; thresholds were unchanged. Three pure behavior/source-parse
tests pass separately from these actual console/desktop runs.
