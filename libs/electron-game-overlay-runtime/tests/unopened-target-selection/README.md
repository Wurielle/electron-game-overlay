# Owned process-access refusal fixture

`owned_access_refusal_owner.exe` launches only its sibling
`owned_access_refused_target.exe`. Copy those two verified binaries together into
the consumer's allowed owned-fixture folder. Start the owner with **no arguments**,
redirected stdin/stdout, and `windowsHide: true`; arm the consumer watcher first.
Authorize only the child and the owned graphics executable in the test policy,
or explicitly deny `**/owned_access_refusal_owner.exe` in that test policy. The
owner itself is an ordinary executable and must remain outside attachment policy.
This is fixture authorization, not a production executable-name heuristic.
The target's DACL is supplied to `CreateProcessW`, before the process is visible
to a watcher. There is no post-creation DACL timing window. The fixture changes
only its newly created process object, and never changes a system setting or
another process's permissions.

The DACL allows the current user `PROCESS_QUERY_LIMITED_INFORMATION`,
`SYNCHRONIZE` and `READ_CONTROL`, and denies `PROCESS_CREATE_THREAD`,
`PROCESS_VM_READ`, `PROCESS_VM_WRITE`, `PROCESS_VM_OPERATION` and
`PROCESS_DUP_HANDLE`. Before reporting ready, the owner verifies the real image
path and creation time through a newly opened limited-access handle, and checks
that the injector's requested access fails with Windows error 5.

The first stdout line is JSON:

```json
{"kind":"EGO_OWNED_ACCESS_REFUSAL_V1","ready":true,"pid":1234,"creationTime100ns":"134387260000843361","executablePath":"C:\\owned\\owned_access_refused_target.exe","ownerPid":5678,"readOnlyIdentityVerified":true,"fullAccessWindowsError":5}
```

Keep the owner alive while checking the SDK's scoped `injector-failed` event and
the successor's `armed` event. A generation-25 injector emits
`EGO_TARGET_SELECTED_V2` for this exact instance before the open refusal. It does
not emit the legacy full-handle selection or attempt injection. The refused
live instance must not be retried. Another owned graphics target can now be
started under the same consumer watcher; graphics acceptance belongs to the
consumer test.

Write `exit\n` to the owner's stdin, then await owner exit code 0 and its second
JSON line, containing `exited: true`, the same PID/path/creation time,
`retainedHandle: true`, and `requested: true`. The owner terminates and waits
through the original `CreateProcessW` handle; it never reopens a PID for cleanup.
EOF also requests cleanup (`requested: false`). A private kill-on-close job owns
only this child and prevents an orphan if the owner exits unexpectedly. Treat a
missing final line as incomplete evidence and use the consumer's authoritative
process observer for exit confirmation. Do not delete uncertain SDK stages from
the consumer.

Build/read-only regression:

```powershell
./libs/electron-game-overlay-runtime/scripts/test-cases/unopened-target-selection-console.ps1 -Architecture x64
./libs/electron-game-overlay-runtime/scripts/test-cases/owned-target-access-refusal.ps1 -Architecture x64
```

Both accept `x86`. The first compiles the complete pinned production entrypoint
with a controlled `OpenProcess` seam for live refusal and an owned fast-exit race.
The second runs the actual built injector against the real DACL fixture, proving
native V2 ordering and retained-handle cleanup without injection or graphics.
The separate `owned-target-access-refusal-negative-control.ps1` accepts
`-RuntimeDirectory` pointing to a retained generation-24 x64 injector and manifest,
and reproduces the missing V2 selection. Candidate fixture hashes are recorded in
the companion `owned-refusal-fixture/fixture-manifest.json`.
