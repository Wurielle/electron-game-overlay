# Process-instance binding native contract

`reshade-injector-process-instance-binding.patch` is terminal over the existing
pinned ReShade patch stack. It adds only optional exact-PID binding:

```
image --pid PID [--expected-creation-time-100ns POSITIVE_CANONICAL_UINT64] [--wait-for-official-addon MS]
```

The original unbound exact-PID, wait, name/path watcher and observer forms remain
available. The binding parser rejects duplicate, missing, trailing and malformed
values before opening a process; binding without exact PID does not enter a
watcher. Decimal strings are parsed by checked integer arithmetic, never float.

The guard queries `GetProcessTimes` on the existing retained `remote_process`
handle, after actual image/path/name validation and before architecture/module
inspection, PID claims, ACL updates or remote VM/thread operations. It adds no
rights or reopen. Query errors are captured immediately; zero creation time (or
an unsuccessful API returning zero last-error) is `ERROR_INVALID_DATA` (13).
Mismatches use `ERROR_REVISION_MISMATCH` (1306). Both emit the existing schema-1
`target-preflight` envelope with actual image, PID, `injectionStarted:false`, and
`windowsErrorCode`; their codes are `target-process-instance-query-failed` and
`target-process-instance-mismatch`. Diagnostic-write failure is 29.

The native build stamp is schema 28 and includes the terminal patch digest plus
`injectorProcessInstanceBinding:1`. The private package stamp is schema 4 and
emits that capability only after pinned patch, architecture and artifact-hash
checks. Each architecture is built/sealed independently; SDK validation must
require both. This is not a broker-wire or schema-1 claim change. No mapped
runtime source, add-on build ID or runtime generation changes.

`tests/process-instance-binding-unit.py` compiles the actual expanded production
parser/comparison helpers and actual guard with a controlled WinAPI boundary.
It accepts a caller-selected **compiler**, not a shipping DLL selector. Its
`nativeExecuted:false` result is portable seam evidence, not a Windows injector
build, real OS-handle identity proof, medium-token proof or native acceptance.
The source-order assertions complement, not replace, genuine x64/x86 Windows
owned-fixture acceptance. No automatic claim release follows from any rejection.
