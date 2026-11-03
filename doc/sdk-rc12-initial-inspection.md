# RC.12 transient initial inspection recovery

Consumer acceptance on 2026-11-03 passed 16/16 native cases across 20
authenticated target lifecycles. The original unshortened, no-barrier fast-folder
case passed three fresh rounds with rearming and separate negative controls,
followed by the complete standard matrix. No Windows 299 failure or inspection
phase record appeared in those samples; direct recovery proof remains the
separate native SDK probes. See the
[consumer acceptance record](evidence/sdk-rc12-consumer-acceptance.json).

The accepted RC.11 work was committed and pushed as
`b89eeb6bf3efb94185e5041be582ac11df6342f6` before this investigation resumed,
as requested on 2026-11-03. RC.11's original long-profile and standard native
matrix acceptance remains recorded separately.

## Retained failure and reproduced mechanisms

The separate RC.11 fast-folder case failed for PID 3208 about 22 ms after target
creation. Its native diagnostic reports `target-module-inspection-failed`,
Windows error 299 and `injectionStarted: false`, followed by
`ReShade injection not started.` No structured native success or ReShade log
exists. This native proof corrects the consumer observer's
`nativeInjectionExecuted: true` classification for that run. Earlier RC.9 D3D9
and D3D12 cases retained the same pre-payload error with their graphics startup
barriers enabled, so the failure predates the long-path corrections.

Those historical logs do not identify the exact failing Windows API. The old
injector has two relevant read-only gates: a single-shot initial host/claim
inspection and a later ReShade preflight allowing four short inspection
attempts. Either can emit the same diagnostic.

An isolated native probe reproduces both mechanisms using the exact RC.11
inspection source and retained read-only handles to fresh owned console
children. New x86 processes can initially fail module enumeration with 299 and
later become readable. On x64, controlled child-local inert DLL load/free
windows also produce actual `ReadProcessMemory` 299 failures while the parent
reads module exports. The children eventually become stably inspectable.
These controls do not inject or load ReShade, run graphics, or touch user games.

Microsoft documents that module enumeration can fail when the target module
list is uninitialized or changes during enumeration, and that process-memory
reads require the whole requested range to be accessible.
See [EnumProcessModules](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocessmodules)
and [ReadProcessMemory](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory).
The probes establish these failure mechanisms; they do not recover the missing
API-level detail from the original consumer run.

## Correction and ownership boundaries

Both initial read-only gates allow bounded retries for the existing transient
inspection-error family. They retain the same selected process handle and
creation/image binding under the existing injection mutex. No default delay is
added to a successful first scan. The retry window is 250 ms with an attempt
bound, and explicit official add-on waits retain their existing overall
deadline. Exact process exit interrupts the wait. Persistent, malformed or
nontransient inspection failures still fail closed before payload loading.
Empty module lists cannot prove that no host exists.

Positive ownership evidence survives retries. A claim already observed pinned
continues to force member-only routing; an observed ReShade/cooperative host
cannot disappear from a partial scan and then authorize fresh-host injection.
Fresh complete reads supply readiness values. Partial outputs are cleared,
and the initial host-presence fact crosses into the later preflight gate.

Separate `EGO_INITIAL_MODULE_INSPECTION_V1` stdout telemetry records the gate,
phase, attempts, elapsed time and first/last error. Existing injector result and
strict diagnostic JSON shapes are unchanged. Retrying a read before payload
loading does not retry an indeterminate injection or release possibly consumed
ownership. Existing foreign ReShade files and configuration remain protected.

Only injector implementation changes. The generation-21 host source,
generation-20 long-path correction, EGO add-on implementation/build ID
`CCE20935ADD44EF6A5A7973014B2E07F`, cooperative ABI and public SDK arguments
remain unchanged. Generation 22 requires the new injector patch provenance
alongside all retained predecessor pins. Earlier generation source-cache and
package meanings remain valid.

The new frozen patch SHA-256 is
`5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7`;
the final normalized injector source SHA-256 is
`58ED5A9C5F0B0806D7D4AE65D060271AD8D62676A62332F0BE6FEAD88B6D8BFA`.

## Validation boundary

The [evidence record](evidence/sdk-rc12-initial-inspection.json) distinguishes
deterministic native retry controls, actual early-process/module-churn probes,
complete SDK/package checks and any subsequent consumer acceptance. All 54
deterministic cases and 20,982 assertions pass on each architecture. Actual
probes pass 38 observation cases and five recovery controls on each architecture:
steady reads, suspended/resumed startup, persistent suspension, authoritative
exit and child-local DLL churn. Startup and churn recover from actual 299 to
success; persistent unreadability stops at 250 ms, and the helper reports 1067
on authoritative exit. No trapped VM write, remote-thread or handle-transfer
operation occurs, and all owned children exit. Deliberate termination of one
owned child per architecture tests the exit boundary.

The unchanged x64 baseline records 586 actual 299 observations: 17 enumeration
failures and 569 remote-read failures. The x86 baseline records 514, including
all 32 normal-start first inspections. The x64 baseline's normal-start sample
did not reproduce first-call API 299; its controlled suspension and churn did.
Candidate x64 also observes 34 successful enumerations with zero returned bytes,
which it correctly rejects as unknown instead of authorizing a clear result.
Raw API errors remain distinct from normalized incomplete-list errors in the
reports.

Both normal native builds and console ABI checks pass. The full SDK suite passes
1,358 of 1,368 tests with zero failures and ten expected skips, at concurrency
four. This includes 226 retained source-cache cases and 16 new generation-22
cases. All three independent patch-reversal guards remain enabled. The complete
SDK contains 154 sealed payloads; installed-package hashes and source provenance
are recorded separately under `artifacts/rc12-initial-inspection`.

Native probe processes and files belong only to this SDK workspace. The consumer
performed its separately authorized local install and retest in its own chat.
Its complete, unmodified package matches SHA-256
`10ecef4b7a46a870ea8cf5c1160321bf449712c5a93808e11a2a214051e708af`.
All 217 consumer checks and strict helper types passed. Three fresh fast-folder
rounds passed 6/6 positive/negative cases, then the standard graphics matrix
passed 10/10, including x64/x86, fractional scaling and exact-path rearming.
Loaded module paths ranged from 292 to 322 characters. Existing typing, glyph,
cursor, scroll and input-release checks remained enabled; no delay, barrier,
path-shortening workaround or SDK patch was added.

The consumer corrected its report flag to `nativeInjectionConfirmed`, setting
it only after authenticated surface readiness. The retained consumer samples
contain no phase telemetry and demonstrate no actual 299-to-success transition.
They establish passing fresh native cases; the deterministic and real-process
SDK probes establish the recovery behavior. Previous failures remain retained.
Cleanup records zero owned native processes and free UI/backend ports.

These acceptance notes were added after packaging. All 752 implementation files
still match the packaged source snapshot. The original tarball, source artifacts
and pending-at-build evidence remain unchanged; later consumer acceptance is
recorded separately, including a sidecar in the release directory.

This work changes no security setting and uses no user game. The archived paused
investigation remains preserved; its stale patch is not restored over the
accepted implementation.
