# RC.11 long-path activation readiness

Consumer acceptance on 2026-11-03: the original unshortened D3D11 positive and
separate negative control passed, followed by all ten standard native matrix
cases. The complete, unmodified RC.11 package is accepted for that scope. The
[consumer acceptance record](evidence/sdk-rc11-consumer-acceptance.json) preserves
the exact package and report hashes, the consumer harness correction and the
separate retained fast-start Windows 299 diagnostic.

The consumer's complete, unchanged RC.10 SDK successfully loaded and registered
the 293-character extended registered add-on path in the original long profile.
The fresh owned host then failed activation with owned late D3D11 error `0x15`
(`ERROR_NOT_READY`), retaining runtime ownership. No authenticated target,
graphics surface or structured native success arrived. The controlled graphics
startup barrier remained held. Fresh short-profile positive and separate
negative controls passed with the same app, SDK and native hashes.

This is a separate failure after the loader correction in
[RC.10](sdk-rc10-preload-long-path.md). Session and current discovery readiness,
or the DLL's registration log alone, do not establish overlay activation.

## Native failure and correction

The owned host checked callback readiness by taking a Toolhelp module snapshot.
An isolated Windows console probe extracts and executes the exact production
readiness functions with an inert data-export DLL. Its explicitly
`longPathAware=false` children demonstrate that `Module32FirstW` fails with
`ERROR_MORE_DATA` (234) after a DLL at a long path is mapped. The existing check
therefore returns false despite a valid module, ABI and callback-ready word.
The same exact selector succeeds at the 233-character short control and rejects
that control when the adapter-ready word is zero. At 259/260/289/293/320
characters, direct exported-word checks, handle enumeration and address-based
loader references still succeed while Toolhelp fails.

The correction uses `K32EnumProcessModules` to enumerate module handles without
materializing fixed-size module paths. It grows its buffer within a fixed
65536-module bound and eight attempts, rejects incomplete or malformed lists,
then retains each candidate's loader reference before checking its ABI and
actual callback-ready word. An explicitly present adapter-ready word still
takes precedence over the older cooperative-ready fallback. No readiness claim,
retry, ownership release or second ReShade injection is added.

Only the bundled owned ReShade host implementation changes. The EGO add-on
implementation, build ID `CCE20935ADD44EF6A5A7973014B2E07F` and cooperative ABI
remain unchanged. Generation 21 binds the new host patch in both architecture
stamps and the sealed SDK implementation, alongside the required generation-20
injector patch. Historical generation-19/20 source and package meanings remain
valid. Cache migration reverses the exact new host tail before the injector
tail under the existing lock, preserving recognized intermediate states and
rejecting unknown edits.

The new frozen patch SHA-256 is
`BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6`.
Its final normalized host source SHA-256 is
`36753053450815B934A6117B1C072A2100AA86032DF30D937F9A127CA0F7A5F0`.
The injector source remains `91D82243D81D2CDC082DA1AF9BFF55A13315BF59F1FE5F9ACA1DFAE8442C8A10`.
All native tools were rebuilt, so their recorded binary hashes remain the
authority even when their implementation source did not change.

## Validation and handoff boundary

The [evidence record](evidence/sdk-rc11-preload-activation.json) separates exact
native selector and policy controls, SDK/package tests and actual consumer
acceptance. The new console fixture loads inert test modules only; it does not
load ReShade, launch a graphics target, execute the production injector or alter
another process. Source-cache fixtures are synthetic Git/CMake tests.

The complete SDK suite passes 1,316 of 1,326 tests with zero failures and ten
expected skips, at concurrency four. It includes 212 retained generation-19/20
cache controls and 14 new generation-21 cases. Both native builds and console
ABI smoke tests pass. The exact readiness fixture passes 61 candidate controls
on x64 and 61 on x86, including false readiness, invalid ABI, legacy fallback
and bounded enumeration failure/growth. The separate 54-control baseline
preserves the original failure. The complete sealed SDK contains 154 payloads;
installed-package acceptance and hashes are recorded in the release directory.

## Consumer graphics acceptance

The consumer installed the exact RC.11 tarball with SHA-256
`ddc09fe1b2851469ad057601374320d299fe6cac915731e1859f7db27c5efca6`.
Its 217 overlay/package/app checks, strict helper types and Electron 46
noninjecting focus smoke passed. The production integration and paths remained
unchanged, both public SDK imports remained external, and the same native
registration ID was retained.

The first RC.11 attempt exposed a consumer test-harness defect after actual
structured injector success: its Toolhelp module inspector could not enumerate
the long loaded path, so it kept the graphics barrier held. The consumer changed
that test inspector to bounded `K32EnumProcessModulesEx` and growing
`K32GetModuleFileNameExW` buffers. It retained readiness/input assertions and
added successful inspection plus a loaded-path length greater than 260 to every
default-profile target lifecycle. The initial failure remains separate evidence;
no SDK patch or production path workaround was added.

After that correction, the original long-profile positive and separate fresh
native-focus negative passed 2/2. The standard matrix passed 10/10: D3D9/10/11/12
x64, D3D9/10 x86, D3D11 at 125%/150%, exact-path two-launch rearming and the
native-focus negative control. Eleven target lifecycles had successful module
inspection, with loaded module paths from 292 to 310 characters. First-show and
reopen OS typing without a click, glyph pixels, text/hand cursors, scrolling,
input release, policy retention/revocation and the in-app Defender-dialog Cancel
path passed. Input uses Windows `SendInput`; this does not claim a physical-key
gate. Cleanup records zero owned native processes and free UI/backend ports.

An additional no-barrier fast-folder run retained a Windows 299 failure. It is
outside the accepted standard matrix and remains a separate paused diagnostic.
Its observer reports `nativeInjectionExecuted: true`; this acceptance record
does not infer an injection boundary from that flag or erase the failure.
After the accepted RC.11 work was committed and pushed, the user authorized
resuming that separate investigation. Its native no-payload proof and candidate
correction are documented in the [RC.12 record](sdk-rc12-initial-inspection.md).

The local candidate is based on commit
`f51777621927ff090d0281ad069b720ed553d589` plus its exact uncommitted source
snapshot. Complete package and source hashes are recorded separately under
`artifacts/rc11-preload-activation` to avoid a self-referential source manifest.
No earlier candidate artifact is rewritten.

These acceptance notes were added after packaging. The original source archive,
tarball and pending-at-build SDK evidence remain unchanged; 742 implementation
files were verified against that source snapshot. A separate acceptance sidecar
is available in the release directory. SDK work and this recording did not
modify Izabela or execute its tests; the consumer ran the authorized install and
retest in its own chat. All work remains local, uncommitted and unpushed.
Existing targets retain their mapped host; updating this SDK does not replace
it. No foreign ReShade installation or security setting is changed. The Windows
299 follow-up remains separate from this exact package's accepted matrix.
