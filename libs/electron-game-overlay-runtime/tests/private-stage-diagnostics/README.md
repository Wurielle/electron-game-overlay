# Private-stage failure diagnostics

The console gate includes the exact pinned production injector source, renames
its injection entrypoint and never calls it. Real owned file/directory sharing
conflicts verify the new failure record, original error preservation and the
existing restrictive read guards. It does not prove actual high-stage acceptance
or reproduce the consumer's particular transient conflict.

Run `scripts/test-cases/private-elevated-stage-diagnostics.ps1` with `-Architecture
x64` or `x86`. The runner reuses fixed build/data/log paths, loads no graphics
runtime, requests no elevation and deletes only its own data file.

The optional `EGO_PRIVATE_ELEVATED_STAGE_DIAGNOSTIC_V1` record identifies a fixed
artifact name, operation, injector PID and original Windows error. No user paths,
tokens or private data are emitted. Existing authorization records and refusal
codes retain their meanings. Nothing retries, unlocks, relabels or accepts a file
that the original validator refused.
