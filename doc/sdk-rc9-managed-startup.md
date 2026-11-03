# RC.9 managed watcher startup

RC.8 is not accepted for Izabela's native graphics matrix. Its installed SDK
passed packaging and noninjecting consumer checks, but a valid policy update
during initial `OverlayTargetWatcher` preparation could fail the controller
before any target was launched or injected. The focused consumer report retained
`Early target policy cancelled before readiness`, followed by
`Target watcher is stopped` when the update continued. A successful session
transport did not establish managed discovery readiness.

## SDK change

Initial startup and later policy changes now use the same serialized discovery
pipeline. The initial `ready` promise follows revisions received during startup.
Retiring an obsolete slot or best-effort spare interrupts that revision's wait;
it does not fail the controller or publish readiness for obsolete discovery.
The controller rechecks the current revision after asynchronous work and
reentrant event callbacks. It also waits for successors added during preparation.

Genuine current preparation failures still reject initial readiness. Disposal
interrupts pending work. An uncertain native watcher remains reserved and emits
`discovery-blocked` without claiming ready or cancelling otherwise authorized
active targets. No public API argument, protocol, native add-on, injector or
ReShade binary changed. The native generation remains 19 and add-on build ID
remains `CCE20935ADD44EF6A5A7973014B2E07F`.

Ten focused regressions cover replacement during preparation, rapid revisions,
checked native quiescence, `armed` callback reentrancy, cancellation, genuine
failure, obsolete spare preparation, disposal, pre-observer replacement, and
preservation/recovery of an already connected authorized target. The first eight
failed deterministically against RC.8. All 32 focused watcher tests pass on the
fix. These are SDK state-machine tests, not native graphics acceptance.

The [SDK evidence](evidence/sdk-rc9-managed-startup.json) records the complete
SDK run: 1,250 tests, 1,240 passed, zero failed and ten expected skips. The
repository client's CJS suite passed 254 of 258 tests with four skips, and its
no-emit typecheck passed. Both final suites used concurrency four. Earlier local
runs retain one missing native-query fixture setting and one existing legacy
child-start deadline under default-concurrency load; final runs kept assertions
and passed with their required settings.

The actual read-only native discovery fixture also passes: it replaces a held
initial preparation, reaches current native readiness, then safely drains and
replaces an unselected policy watcher. All three owned helpers closed. The
unchanged RC.8 control reproduces the exact cancellation error, and its sole
observer closes. Both fixtures create no target and execute no injection; their
session/authorization seam is simulated. This is pre-injection discovery proof,
not graphics, focus or game acceptance.

## Separate D3D10 observation

The consumer's D3D10 run reported `armed, ready, armed, ready` but selected no
target. Its target startup-barrier marker was written at 19:54:10.8790618 UTC;
the replacement watcher's baseline was 19:54:11.2477741 UTC. The test writes that
marker immediately before spawning the target and waited for any historical
`armed` event. This strongly indicates a launch during replacement, not a
graphics-specific failure. The exact historical target creation FILETIME was
not retained, so this timing remains an inference.

The existing replacement contract permits this gap. After initial readiness has
settled, later updates require current discovery readiness; an old `armed` event
is insufficient. An update can also settle with `discovery-blocked`, so its
resolution alone is not proof of readiness. No consumer delay, retry, policy
special case or retroactive target admission was added. An old creation cutoff
must not be applied to an expanded policy: that could authorize a process which
already existed before a newly added allow rule. The D3D10 graphics case remains
unaccepted pending a consumer-controlled retest.

## Handoff boundary

SDK-local unit, packaging and read-only native-watcher checks do not establish
Izabela graphics, scaling, rearming or negative-focus acceptance. Wait for the
user's explicit go before installing or testing a replacement RC in Izabela.
Do not alter Izabela's files, running development app, games or Defender settings.
The initial DX12 status-click timeout and historical unattributed D3D11 GPU hang
remain known issues. No new desktop or user-game test was run for this fix.
