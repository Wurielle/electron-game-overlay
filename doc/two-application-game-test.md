# Two-application game test

This is a manual Windows acceptance procedure, not a claim that CI has tested
real-game rendering, input isolation or application-exit continuity.

## Builds and prerequisites

Run **Broker compatibility** manually with **build-demo** and
**build-two-app-demo** enabled. Download both portable ZIPs and extract them to
separate writable folders:

- `ElectronGameOverlayDemo-win32-x64.zip`: the current SDK revision.
- `ElectronGameOverlayDemo-baseline-win32-x64.zip`: the independently compiled
  SDK from `2d1cd28b7f51460a6a5f58b20fd9e8df219bea48`.

Read each folder's `SDK-REVISION.json`. These are different compiled source
revisions, not differently numbered releases: both currently identify as
package version `0.0.1`. CI checks that their native-provider JavaScript hashes
actually differ, and smoke-tests each complete SDK package separately. The
previous SDK comes from pinned artifact `12780691390`; this optional comparison
build fails explicitly if that retained artifact has expired or disappeared.
Ordinary **build-demo** does not depend on that artifact.

Use a permitted, unprotected game such as Gun Frog. Keep the game and both apps
non-elevated. Review the [antivirus warning](known-issues.md#antivirus-detection-of-injection-helpers)
if Defender blocks a helper; an allowance for one build need not cover another.
Do not disable protection or broadly exclude temporary folders.

## Exercise the shared exact-PID path

When testing a replacement build that changes the coordinator, first close the
previous test game and both test apps. If no other EGO clients or owned targets
remain, the standalone broker exits after its 30-second idle period. Allow it
to retire before starting the new comparison: an already-running compatible
broker deliberately stays authoritative and is not hot-upgraded by a new app.
Do not terminate an unrelated broker or clear claims/caches to force an update.

1. Close Gun Frog and, for this controlled comparison, other executables under
   Steam game folders. The historical SDK's observer still reports pre-existing
   matching processes; it is intentionally not patched to resemble the new SDK.
2. Run **Start Broker Test.cmd** in the current folder and wait for its watcher
   to be ready **before starting the baseline app**. In this test mode, readiness
   waits for the actual broker session and at least one prepared native runtime,
   then requires the process observer's READY event. First-time cache preparation
   can take longer than 15 seconds; the current SDK allows 75 seconds total for
   broker startup. Do not use **Start Demo.cmd** for this test: its default
   prearmed path-based lane is exclusive, not the shared exact-PID lane.
3. Run **Start Broker Test.cmd** in the baseline folder and wait for its watcher
   to be ready too, then launch Gun Frog once through Steam. Both apps must detect
   the same new PID. Do not manually inject again into an indeterminate or
   already-owned target.
4. Move both control overlays away from their initial positions. Open a **Main
   window** from each app, move the test windows apart and type distinct text in
   their input fields; only the intended app's content should change. Click
   between existing test windows, then drag each test window. Neither control
   overlay may jump back, and test windows must not flash or snap back. Repeat
   after opening another window. Toggle interception off and on after moving
   each control panel: its visible size may change, but its position and all
   peer/test-window positions must stay unchanged. Use per-app input controls
   rather than the shared global `Ctrl+I` shortcut, whose registration can
   collide between apps.
5. Quit the first app through its tray menu. Its windows should disappear while
   the second app remains rendered and interactive, without another injection.
6. Keep the second app open, exit and relaunch Gun Frog, and verify a fresh game
   PID attaches normally. Then quit the remaining app.
7. Repeat with the baseline app started first. In a separate pass, terminate
   only the first test app's Electron process instead of quitting gracefully;
   verify the surviving app still works. Do not terminate the game or broker as
   a substitute for terminating that app.

For an unambiguous **broker-starter exit** check, establish that no EGO broker
was already running before starting the first app. A pre-existing broker makes
that pass a joining/member-exit test, not proof of which app bootstrapped the
coordinator. Stop a leftover test broker only after all test apps and games
have exited and only if it is not serving another application. Never delete
claims, caches, rendezvous files or game files to force a new owner.

## Observe broker recovery without changing ownership

The portable packages include **Start Broker Recovery Diagnostic.cmd**. This is
an observation tool, not a broker restart or termination command. Run it from
one extracted folder after both test apps are ready and attached to the same
live game. Leave the game and both apps running. It requests up to 180 samples
at a two-second cadence and saves its own JSON report under
`logs/broker-recovery`. Press `Ctrl+C` to request an early stop. Cancellation
abandons a pending asynchronous capture and saves an interrupted report; it
cannot forcibly preempt synchronous OS/native calls or setup/report filesystem
I/O. The scheduled observation deadline is not an absolute process wall-clock
limit, and abandoned reads finish their own cleanup when the underlying I/O
settles.

To restrict claim reads to the exact game PID shown by the apps, run the
launcher from a command prompt with `--target-pid <PID>`. Without this option,
it reads a bounded selection of existing recovery-claim files; a truncated
selection is explicitly marked. It does not start an absent broker, authorize
a target, inject, repair a claim, register a version, or modify cache/catalog
or game files. Do not clear any of those files to obtain a different result.

The tool correlates a frozen-v1 welcome with independently opened Windows pipe
handles. It checks the OS-reported server PID, process creation time, image
path and same-user token identity before and after the welcome. The report
retains the PID, exact creation-time string and expected executable basename,
not the raw executable path, account SID, session credential or claim token.
An unavailable, mismatched or unexpected image remains unverified; never
substitute a PID guessed from Task Manager or the protocol welcome alone.
Expected basename and same-user identity are not publisher authentication.

Claim observations include phase and fingerprints of the pinned route and
lease. Broker PID plus creation time identifies an observed process instance;
a PID alone does not. Changed endpoint credentials can be normal recovery and
must not be confused with permission to replace the pinned route. Missing,
unreadable, invalid or legacy evidence may leave continuity unknown. Unchanged
fingerprints do **not** independently count native injections or prove that
rendering/input recovered.

Each hello briefly creates a broker client and can postpone idle retirement.
Stop the diagnostic before checking the broker's normal 30-second idle exit.
Frozen v1 cannot enumerate other consuming applications: this report never
establishes exclusive use or permission to terminate a process. **Collect and
review the baseline first; do not terminate a broker as part of this step.** A
later controlled crash test requires a fresh, positively identified test
broker and confirmation that no unrelated application depends on it.

Keep the report with both apps' compatibility evidence. For a subsequent
separately agreed crash test, record whether the same game PID stayed alive,
both apps reconnected, both scenes returned, and input still reached only its
owner. Native-dragged positions can reset during reconstruction; their
persistence across reconnects is a documented feature gap, not a guarantee of
this diagnostic. Local OS/pipe checks and CI fixtures do not substitute for
that physical game acceptance.

## Evidence and limitations

The broker-test launcher uses a separate `profile` and `logs` directory inside
each extracted folder, configured before application startup. Unless an
explicit compatibility-log environment override is set, the structured logs
are under `logs/compatibility-runs`. Keep each app's matching `.events.jsonl`
and `.summary.json`, its `SDK-REVISION.json`, launch order, and a screenshot or
short recording of both overlays and the survivor after the first app exits.
State whether the broker was already running and whether the game exit was
intentional; a socket reset alone does not prove authoritative process exit.

The older revision retains its 15-second total broker-startup budget and its
two-second PowerShell process-image lookup. A reverse-order cold startup may
therefore fail in the historical SDK before a valid distribution has finished
copying. The current demo's readiness gate does not rewrite that older SDK.
These are historical limitations, not evidence that the newer startup allowance
or read-only native query failed. Report them separately rather than silently
warming or modifying the baseline.

Packaging/import/profile-setup checks, sealed payload validation, and controlled
old/new protocol tests do not establish successful real-game coexistence,
independent input, single native ownership or survivor continuity. Those gates
remain pending until observed on Windows with the two real application
processes. Do not interpret one visible overlay as proof that both apps joined.
