# Cooperative add-on acceptance map

Inventory and recorded Windows evidence updated on 2026-11-01 for the
per-application add-on implementation. Results below identify the artifacts
actually tested; unrecorded matrix cells are additional release coverage. The
user permits a clean rewrite without an old-package migration layer, while
requiring preservation of overlay features and all real-game E2E behavior.

## Available targets and artifacts

Read-only checks found these installed targets:

| Target | Observed executable | Existing acceptance boundary |
| --- | --- | --- |
| Gun Frog | `C:\Program Files (x86)\Steam\steamapps\common\Gun Frog\Gun Frog.exe` | Five dedicated real-game launchers; Unity/D3D11 input, rendering, focus and stock-ReShade coexistence |
| LORT bootstrap | `C:\Program Files (x86)\Steam\steamapps\common\LORT\LortGame.exe` | Documented manual Steam auto-attach process-chain exercise |
| LORT renderer | `C:\Program Files (x86)\Steam\steamapps\common\LORT\BW\Binaries\Win64\LortGame-Win64-Shipping.exe` | Documented D3D12 render/input/FPS exercise |
| Portal | Installed Steam `Portal` directory | User-confirmed x86 D3D9 smoke in known issues, not a complete automated gate |
| PEAK | Installed Steam `PEAK` directory | Documented short D3D12 functional/resource rerun, not a thermal soak |

Gun Frog uses Steam app ID `3173130` and URI
`steam://rungameid/3173130`. No matching Gun Frog/LORT process was running during
this inventory. Each actual run must repeat the launcher's preflight; this
observation is not continuing permission to terminate another process.

At initial inventory this worktree had no `node_modules`, SDK `dist`, or
production native output. The original checkout at
`C:\Users\Wuriko\Desktop\dev\electron-game-overlay` has Electron, source/header
caches, production binaries and an official ReShade cache. Those old binaries
are useful baseline inputs, not evidence that the new implementation passes.
Candidate native and JavaScript artifacts must be built from this worktree and
their mapped identities recorded.

## Dedicated real-game launchers

The five pre-existing real-game human-facing launchers are under
`libs/electron-game-overlay-runtime/scripts/test-cases`.

| Launcher | Required/optional parameters | Required proof and completion evidence |
| --- | --- | --- |
| `gun-frog-electron-scene.ps1` | Optional `-NoLaunch` only stages; `-SkipBuild` reuses built candidate artifacts | Injector succeeds; native transport/router initialize; Electron producer and aligned four-button layout become ready; first two-window transported scene renders. Then waits for normal game exit. Visual/input exercise is manual; readiness alone is not the SDK four-click PASS. |
| `gun-frog-client-sdk.ps1` | Optional `-SkipBuild`, `-InteractionTimeoutSeconds` (60–900, default 600) | Real SDK/client authenticates the exact game PID/path and renders. Click each Electron Continue/New Game/Settings/Quit once while game remains on its menu; Ctrl+I releases input; the same underlying Quit position closes the game. Exact-once click/ACK markers, ordering, and no native router/input/queue fault. `result.txt` contains `GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`. |
| `gun-frog-explicit-keyboard-focus.ps1` | Mandatory `-GameExecutable`; optional `-ElectronExecutable`, `-PhysicalKeyboard`, `-PhysicalFirstKeys` | No-click first show and hide/reopen typing; released key state and zero pointer-downs; blur/interception-off drop input; re-enable types; foreign foreground rejects input; fresh presentation and resumed typing after foreground restore. Default uses Windows SendInput. `build/explicit-focus-*/report.json` must say passed. |
| `gun-frog-physical-first-key.ps1` | Mandatory `-GameExecutable`; optional `-ElectronExecutable` | Same focus case, with human physical lowercase `a` on initial show and `b` after reopen. Later gates use SendInput. A synthetic key run is not a physical-first-key pass. |
| `gun-frog-client-sdk-official-reshade-coexistence.ps1` | Optional `-OfficialRuntimePath`, `-SkipBuild`, `-InteractionTimeoutSeconds` (default 600) | Stock host, original API-18 FPS Limiter and enabled witness effect coexist with EGO. Exact target/module/add-on/build-ID/path assertions; exactly one official runtime; four overlay clicks while target stays alive, input release, then real Quit. Protected seed hashes/attributes/timestamps remain unchanged; reserved EGO mutations use the native manager; all test-owned seeds are restored before final JSON/PASS. |

The new `gun-frog-client-sdk-cooperative-two-app.ps1` launcher adds four cells:
both app startup orders, each with graceful and abrupt first-app exit. It accepts
`-SdkDistA`, `-SdkDistB`, `-StartupOrder a-first|b-first|both`,
`-FirstAppExit graceful|crash|both`, optional informational source revisions,
and `-RequireDifferentImplementations`. Default candidate paths are this
worktree's SDK `dist`; same bytes are explicitly reported as same implementation,
not mixed released-version evidence. The generation-8/generation-11 run recorded
below passes all four cells with different JavaScript and native implementation
bytes; independently released-package compatibility is not claimed.

Its controller owns the game process independently of both Electron apps. The
first app uses the exact-path native prearm needed for real-game graphics
timing; the late app uses an exact PID after the first scene renders. Both
authenticated native hellos must identify the retained game's exact PID,
executable and creation FILETIME. Distinct app-private ports and token hashes
are recorded without publishing raw credentials. Actual target pixels prove
red/blue/green interleaving and alpha cutouts; Windows input proves isolated
typing, raising, capture, both wheel axes, cursors, caption dragging and retained
placement during peer focus/publication. The OR interception matrix, focused
owner disappearance, survivor interaction and a new game launch with the same
surviving app are required. Module-file/export evidence requires exactly one
ReShade plus two SDK-matching native modules while both apps participate, and
exactly one EGO module in the fresh survivor-only game. Retired peer code may
remain mapped in the original game; the test instead requires its windows to
disappear. Runtime input/router/queue errors invalidate the pass.

```powershell
& './libs/electron-game-overlay-runtime/scripts/test-cases/gun-frog-client-sdk-cooperative-two-app.ps1' `
    -SdkDistA 'C:/candidate-a/dist' -SdkDistB 'C:/candidate-b/dist' `
    -RequireDifferentImplementations
```

Example commands, after building the candidate from the repository root:

```powershell
$gameExecutable = 'C:/Program Files (x86)/Steam/steamapps/common/Gun Frog/Gun Frog.exe'
$casesDirectory = './libs/electron-game-overlay-runtime/scripts/test-cases'

& "$casesDirectory/gun-frog-client-sdk.ps1" -SkipBuild
& "$casesDirectory/gun-frog-explicit-keyboard-focus.ps1" -GameExecutable $gameExecutable
& "$casesDirectory/gun-frog-physical-first-key.ps1" -GameExecutable $gameExecutable
& "$casesDirectory/gun-frog-electron-scene.ps1"
& "$casesDirectory/gun-frog-client-sdk-official-reshade-coexistence.ps1" `
    -OfficialRuntimePath 'C:/path/to/official/ReShade64.dll' -SkipBuild
```

Run one case at a time, closing the previous test normally. `-SkipBuild` only
skips a build; it does not establish that staged artifacts are current. The
electron-scene launcher builds by default, always stages, and has an unbounded
`Wait-Process` after readiness, so it requires an operator to finish the visual
exercise and close the game.

## Existing real-game procedures without dedicated launchers

- The normal validation client's Steam auto-attach path must survive two Gun
  Frog launches without restarting Electron. Check compact dock, Ctrl+I
  expanded controls, status-window opening, positive/negative interception ACKs,
  normal game Quit after release, authoritative target exit, and readiness for
  the next target. Historical behavior is documented in
  [known issues](known-issues.md) and [the existing work log](todo.md).
- LORT must attempt both its root bootstrap and Shipping renderer independently.
  No helper/executable plausibility exclusions may be introduced. The bootstrap
  may have no graphics runtime; it must not consume or block the renderer's
  attachment. The renderer must show the overlay, report FPS, accept Ctrl+I and
  a status-window click, then close normally.
- [The two-application game procedure](two-application-game-test.md) supplies
  useful behavior checks: colliding local IDs, separate text, cross-app focus,
  per-window raising/dragging, stable moved control panels, independent
  interception controls, member graceful exit/crash, survivor interaction and
  target relaunch in both startup orders. Its historical package/broker-specific
  migration requirements are not requirements for the new unreleased design.
  The replacement must record each candidate app/engine identity rather than
  reuse the old baseline's passing label.
- Portal x86 D3D9 and PEAK D3D12 are existing manual smoke evidence. They need
  dedicated launchers if expanded into human-facing production test cases.
  Neither historical run is a substitute for the controlled full feature matrix.

## Important gaps and baseline fixture issues

1. The pre-existing real-game explicit-focus path deliberately skips member B. Its
   `-GameExecutable` branch does not prove two-app native isolation or survivor
   continuity. The dedicated cooperative two-app game case above now supplies
   that evidence, separately from the single-app no-click focus case.
2. `run-native-pointer-gate.ps1` accepts `-GameExecutable`, but no dedicated real
   game pointer launcher exists. It assumes the controlled host's window title
   changes after released wheel input. Gun Frog does not provide that oracle;
   simply passing its path is not an established Gun Frog wheel/cursor gate.
3. The official Gun Frog coexistence runner formerly hard-coded runtime
   generation 2. It now reads the native build source's unique literal runtime
   generation, transport range and exact add-on build ID, and requires both
   package/client manifests to match. Equally stale distributions do not pass
   merely by agreeing with each other. Missing, malformed or ambiguous source
   contracts fail closed. The existing exact staged hashes and substantive
   coexistence assertions remain. The isolated manifest-guard regression covers
   13 current/future/stale/malformed cases without launching a game.
4. Physical-first-key requires actual human input. Computer-use or SendInput can
   exercise other interactions but cannot be relabeled as physical-key evidence.
5. The stock-host path historically lacks copied `GetRawInputBuffer` input and
   same-HWND input-handler promotion. A new implementation cannot count stock
   ReShade callback coexistence as proof that those feature cases remain intact.

## Recorded Windows acceptance

These artifacts were reviewed on 2026-11-01. Paths are local retained evidence,
not distributable release packages. The interactive root runner owned each
target; the review did not launch extra games or reuse unrelated processes.

| Actual case | Artifact | Observed result and boundary |
| --- | --- | --- |
| Gun Frog, different generation-8/11 implementations | [Final four-cell report](../build/cooperative-two-app-game-20261101-141822-6dc6e68b/report.json) | All `a-first`/`b-first` × graceful/crash cells passed. Exact PID/creation identity, distinct private routes, two own-stage engines and one ReShade; actual pixels and Windows SendInput for interleaving, alpha hit testing, raising, isolated text, capture, three cursor types, both wheel axes, caption drag, retained placement, interception OR and focused-peer removal. Survivor typing and a fresh game with the same surviving Electron process passed in every cell; the fresh game contained exactly one EGO engine. |
| D3D11 controlled two-app surface lifetime, generation 11 | [Final strict report](../build/electron-game-overlay-runtime/client-sdk-two-app-surface-lifecycle-20261101-141927-46d48419/report.json) | B joined after a secondary swapchain existed but had zero Presents. Destroying the primary preserved both original authenticated TCP tuples, with one authentication and no transport loss, while both apps rendered and accepted fresh clicked input on the secondary. Final destruction removed both surfaces and emitted focus `0` in **85 ms**. Recreated windows retained their local IDs; an actual `z` changed neither value nor DOM keydown count, with direct OS foreground guards before/after. Explicit focus resumed typing; B reached `bpes` after A exited without another connection change. All four strict pixel checks passed. This is a same-build controlled-host result, separate from the mixed game run. |
| Gun Frog automatic explicit focus, generation 11 | [Current focus report](../build/explicit-focus-20261101-152003/report.json) | PASS with Windows SendInput, zero pointer-downs and released keys through first show, reopen, blur/release and foreign-foreground gates. Physical-first-key and other original-game reruns are recorded independently; this row does not relabel the generation-9 results below. |
| Long-idle future controlled target, generation 11 | [130-second idle focus report](../build/explicit-focus-20261101-160217/report.json) | PASS after the armed observer waited 130 seconds before exact target PID 40356 was created. First show, reopen, blur/release rejection, foreign-foreground rejection and restored typing passed with Windows SendInput, final value `bgi`, no held keys and zero pointer-downs. This is controlled-host future-target evidence, not physical-key input. |
| Gun Frog full SDK interaction, generation 11 | [Current SDK PASS marker](../build/electron-game-overlay-runtime/client-Gun-Frog-20261101-152422/result.txt) | All four overlay clicks exactly once, disabled acknowledgement after Ctrl+I, and normal real Quit after release. |
| Gun Frog stock ReShade coexistence, generation 11 | [Current coexistence result](../build/electron-game-overlay-runtime/client-Gun-Frog-official-reshade-coexistence-20261101-152525-0e247577/result.json) | Exact build `E16461475E524DBA83398B19CDD95EBB`, one official runtime, API-18 FPS Limiter and enabled witness effect; strict click/release acknowledgements and real Quit passed. Protected files remained byte/attribute/timestamp identical and the original clean game directory was restored. |
| Gun Frog low-level Electron scene, generation 11 | [Current producer log](../build/electron-game-overlay-runtime/injected-Gun-Frog-20261101-152643/electron-producer.stdout.log) | All four exact overlay clicks, manual release with interception-disabled acknowledgement, lifecycle completion and normal released real Quit. This is the interactive low-level lane, not a structured SDK or physical-key result. |
| D3D12 multi-swapchain, generation 11 | [Controlled PASS marker](../build/electron-game-overlay-runtime/client-sdk-d3d12-multi-swapchain-20261101-151952/result.txt) | PASS for shared device/queue lifetime, primary release and secondary promotion, fresh surface/FPS, intercepted input and normal released exit. |
| Raw registration, explicit session close and final surface drain, generation 10 | [Eight-launcher results](../build/cooperative-gen10-controlled-results.json) | All eight rows passed: D3D11/12 before-injection explicit-HWND registration and NULL focus-following registration, each with WM_INPUT and buffered raw modes; D3D11/12 session deactivation; D3D11/12 final-surface drain. These are generation-10 results, not silent generation-11 reruns. |
| Raw input, session close, scale and managed observer reruns, generation 11 | [Current controlled results](../build/cooperative-gen11-controlled-results.json) | Seven rows passed: D3D11 after-injection WM_INPUT and buffered raw input, D3D11/12 session deactivation, both scale cases below, and managed early/best-effort lifecycles. The eighth row, the fast managed-folder case, failed its fresh relaunch and is described below; this batch is not an all-pass result. |
| Current scale cases, generation 11 | [125% attached](../build/native-pointer-20261101-152826/report.json), [150% SDK-created](../build/native-pointer-20261101-152831/report.json) | Eleven strict feature checks passed in each case. Actual rasters were 750×600 at DPR 1.25 and 900×720 at DPR 1.5. The attached case again requested OSR 1.5 but observed 1.25; independent display/raster mismatch is not established. |
| Managed observer lifecycles, generation 11 | [Early](../build/managed-targets-20261101-152836/report.json), [best effort](../build/managed-targets-20261101-152838/report.json) | Each passed two fresh target lifetimes with exact path/authenticated scene/creation identity, baseline exclusion, authoritative exit/rearm and watcher cancellation. These controlled observer cases do not guarantee attachment before arbitrary unbarriered graphics startup. |
| Raw wheel/cursor paths, generation 11 | [WM_INPUT pointer report](../build/native-pointer-20261101-155925/report.json), [buffered pointer report](../build/native-pointer-20261101-155955/report.json) | Both passed all eleven strict pixel/no-click/cursor/wheel/reopen/release checks. Only diagnostic point/rectangle metadata was extended before these runs; acceptance colors/input checks and mapped native SHA-256 `f807e8e16e3997463a1ca99c29d44e7f8806d07cfdf8878be7a15e5b982d862e` were unchanged. These passes do not assign the earlier white-pixel failure's cause. |
| D3D9/D3D10 backend and architecture matrix, generation 11 | [D3D9 x64](../build/electron-game-overlay-runtime/client-sdk-d3d9-legacy-20261101-153047/result.txt), [D3D9 x86](../build/electron-game-overlay-runtime/client-sdk-d3d9-x86-legacy-20261101-153108/result.txt), [D3D10 x64](../build/electron-game-overlay-runtime/client-sdk-d3d10-legacy-20261101-153128/result.txt), [D3D10 x86](../build/electron-game-overlay-runtime/client-sdk-d3d10-x86-legacy-20261101-153148/result.txt) | Each backend/architecture case passed two fresh SDK/input/release/normal-exit cycles. These are four native cells, not one duplicated pass label. |
| Two apps, D3D11 and D3D12 targets, generation 11 | [Two-target summary](../build/electron-game-overlay-runtime/client-sdk-two-app-two-target-20261101-155345/summary.json) | PASS with distinct exact target processes, private stage routes/ports/credentials, independent scenes and unique text. Cross-target connections/input deliveries and peer scene mutation were zero; exiting A's target did not disconnect B. The cross-target message oracle explicitly excludes global `GetAsyncKeyState`, cursor position and confinement observations. |
| Two concurrent apps, one controlled D3D11 target, generation 11 | [Same-target summary](../build/electron-game-overlay-runtime/client-sdk-two-app-one-target-20261101-160059/summary.json) | PASS with both requests recorded before graphics startup, App B supplying the one full ReShade host, two exact own-stage engines and colliding local window IDs 2/3. All four interception-OR states, isolated typing and unchanged intercepted game-input counters passed. App A was force-killed; B retained its exact private credential/route and accepted survivor input, then released real game input. |
| Existing inactive ReShade installation rejection, generation 11 | [Rejection summary](../build/electron-game-overlay-runtime/client-sdk-d3d11-existing-reshade-installation-20261101-155531/summary.json) | PASS: exact target preflight rejected before injection, no project runtime/add-on was mapped, existing installation manifests remained unchanged and the target exited normally. This is separate from accepting an active stock host or applying reserved-file upgrade maintenance. |
| Existing ReShade changed-hash coexistence, generation 11 | [Upgrade summary](../build/electron-game-overlay-runtime/client-sdk-d3d11-existing-reshade-upgrade-20261101-160757-55ccd51b/summary.json) | PASS for a modeled still-loadable runtime upgrade: a benign PE overlay byte changed an owned fixture copy's runtime hash before launch. All phases retained exact PID 30312 and creation FILETIME; captured native proof and mapped modules identified one existing runtime, the preserved installed adapter and this app's private generation-11 participant. Completion and authentication were independently required after graphics startup release. Protected seed hashes, attributes and timestamps were identical through normal exit; the source runtime was preserved. No maintenance transaction journal was created, so this does not claim a reserved-file replacement transaction or compatibility with every ReShade release. |
| Native watcher quiescence, generation 11 injectors | [Quiescence report](../build/rc7-native-policy-quiescence.json) | PASS for SDK/native x64 and native x86 owned watcher cancellation, authoritative child exit and draining unused output. No target was created and no injection executed. |
| Cooperative registry protocol, current sources | [Registry report](../build/cooperative-registry-evidence.json) | x64/x86 passed the same-process registry protocol fixture. Its report expressly excludes injection, graphics and game acceptance. |
| Packaged injector/claim loader, generation 11 | [Packaged loader summary](../build/cooperative-addon-loader/gen11-packaged-summary.json) | Both architectures passed owned console/inert-DLL fixtures for simultaneous first starts, independent member images, durable claims through injector exit/creator crash, stale-build/process-instance rejection and target-exit release. These are not real ReShade, rendering or input results. |
| Attached BrowserWindow at 125% display scale, generation 10 | [Strict pointer report](../build/native-pointer-20261101-151136/report.json) | Eleven feature checks passed: actual native red/blue pixels, no-click keys/reopen, three Windows cursors, cursor transitions, both wheel axes, reverse/partial/nested/outer scrolling and released game input. Actual paint and retained published frame were both 750×600 with stride 3000 and equal hash; actual transport rect was 25,75,750,600. Electron 39.8.10 reported DPR 1.25 and raster scale 1.25 despite requested OSR 1.5; this does not prove a 125%/150% raster mismatch. |
| Gun Frog with stock ReShade, foreign add-on and effect, generation 9 | [Coexistence result](../build/electron-game-overlay-runtime/client-Gun-Frog-official-reshade-coexistence-20261101-141430-9d69da8c/result.json) | PASS: one stock runtime, original API-18 FPS Limiter, enabled witness effect, installed cooperative adapter and exact private participant. All four overlay clicks occurred while the game remained alive; release followed by the real Quit closed it. Protected bytes, attributes and timestamps remained identical and owned seeds were restored. |
| Gun Frog low-level Electron scene, generation 9 | [Producer log](../build/electron-game-overlay-runtime/injected-Gun-Frog-20261101-143731/electron-producer.stdout.log) | All four aligned overlay click markers, manual release request, interception-disabled acknowledgement and lifecycle completion were recorded; the owned game exited normally. This interactive log is separate from the structured SDK four-click gate or physical-key evidence. |
| Gun Frog full SDK interaction, generation 9 | [PASS marker](../build/electron-game-overlay-runtime/client-Gun-Frog-20261101-144859/result.txt) | Four overlay buttons clicked exactly once while the game remained alive, Ctrl+I produced the disabled acknowledgement, and released real Quit closed the game normally. This unchanged-byte rerun passed after the earlier device-hang attempt described below. |
| Gun Frog automatic explicit focus, generation 9 | [Focus report](../build/explicit-focus-20261101-144422/report.json) | PASS with Windows SendInput, zero pointer-downs and released keys; first show/reopen, blur/release rejection, foreground rejection and restored typing passed. The staged add-on export/hash matched build `3309FB779CFC4E39BA7681AA4A7F8A6B`. This single-app case does not stand in for two-app isolation. |
| Gun Frog physical first-show/reopen keys, generation 9 | [Physical-first-key report](../build/explicit-focus-20261101-144442/report.json) | PASS with zero pointer-downs. The human operator physically pressed the first-show `a` and reopened `b` and confirmed completion; later gates used Windows SendInput. The staged native build/hash matched the same generation-9 candidate. |

The mixed game used two unreleased development SDK snapshots, both labeled
`0.1.0-rc.7`. Its provenance declares source revisions
`7b6e5208d40d1f401a399bda43cf8eab36746951` and
`cdc6e80f0aa0cede23e4ba7272b9f8afa3e795ed` as informational caller claims.
The observed implementation identities, rather than those labels, establish
that the binaries differ:

| Member | Native generation/build ID | Native SHA-256 | JavaScript graph SHA-256 |
| --- | --- | --- | --- |
| A, retained snapshot | 8 / `A8E9DA12477741B9979D9B1B51994EF3` | `c304b044525b8ff0e9ae11bf3bb20f1c0ba8a2e4fe4add032ccd80b2e640a4f1` | `c7a8bf87c7ebdbe5bd3a0e8ba2005c1217160fbf44adbfa258c7827fddd1e855` |
| B, current candidate | 11 / `E16461475E524DBA83398B19CDD95EBB` | `f807e8e16e3997463a1ca99c29d44e7f8806d07cfdf8878be7a15e5b982d862e` | `8abcbc25191c3371b4efcda26233d4dc68361e103e77066d30e23751a68877e4` |

Both startup orders passed with the first app's packaged ReShade host:
`783bedb3d441e4ab985317e393cbaabb4e46a8cf02ce5bcca4df681bc94da657`
for A-first, and
`5851d903abfacd7deba7de4aac580c0ea648ad6f2ae5e6de85bcff1ad990769a`
for B-first. The later app still mapped its own engine. Module evidence checks
current mapped paths and file/export identities; it is not a historical
injection-count measurement or native fault-containment proof.

The surface gate is available independently as
`d3d11-client-sdk-two-app-surface-lifecycle.ps1 -SkipBuild`. Its D3D11 host
options are opt-in; existing host behavior is unchanged. Promotion input is
proved after fresh clicks. The keyboard-only no-implicit-focus check applies
after true final destruction and recreation, not to click-free focus continuity
across primary-to-secondary promotion.

The original five Gun Frog launchers have generation-9 results with their
distinct interaction/input-source boundaries above. Four have passed on
generation 11: automatic focus, full SDK, low-level scene and stock-host
coexistence. The generation-11 physical-mode
[attempt at 152054](../build/explicit-focus-20261101-152054/report.json) reached
rendering/native focus with zero pointer-downs but timed out without receiving
the first human `a`. It is not a physical-key pass. The user subsequently
explicitly waived the final physical-keyboard rerun. Final status for that case
is **waived by user**, not passed or simulated; the confirmed generation-9 human
result remains separately labeled. The four other original cases have current
generation-11 passes above. Earlier
[generation-8/9 mixed acceptance](../build/cooperative-two-app-game-20261101-134225-24c148e1/report.json)
also passed all four cells. A prior full
SDK attempt, `client-Gun-Frog-20261101-144539`, failed with a graphics-device
hang. Its dump and contemporaneous NVIDIA display-driver events were retained;
the cause remains unassigned. The later `144859` pass used unchanged SDK/native
bytes and does not explain the earlier failure. Earlier generation-8 initial
pixel timeouts have likewise not been attributed. Harness failures from Windows
state-file sharing, ambiguous Node lookup and hash letter case were corrected
without relaxing feature checks; those unsuccessful attempts are not passes.

The generation-10 fast managed-folder case
[native-pointer-20261101-151225](../build/native-pointer-20261101-151225/report.json)
failed before authenticated/rendering startup, with a 10000 ms connection timeout
and no native startup record. The generation-11
[fast-folder rerun at 152840](../build/native-pointer-20261101-152840/report.json)
passed seventeen initial rendering/input/policy checks, including no artificial
startup barrier and redundant-rule removal preserving immediate typing. Its
new target PID 7800 was selected/injected but did not produce D3D constructor
hooks or authenticate; the case timed out on fresh relaunch. Final revocation
and the complete fast lifecycle therefore are not passes.

These failures remain within the fast-start limitation documented before the
rewrite at base `90d5bb4` in the
[RC6 process-policy evidence](sdk-rc6-process-policy.md): one
unbarriered lifecycle passed while another selected and loaded the intended
incarnation without authentication. That prior contract explicitly did not
accept reliable fast-start attachment. The inherited limit remains recorded;
the current failures' exact cause is not established. It is not claimed fixed,
and no test oracle was relaxed to accept it. Neither
timeout makes reinjection of that possibly consumed live PID safe.
Earlier native-pointer white-pixel
failures likewise remain separate from later strict pixel passes; the passes
alone do not assign their cause.

The coordinated normal generation-11 build completed both native architectures,
SDK sealing and client output. The source test run reports 164 Rust tests on
each of x64/x86 and 526 SDK/packaging tests. These counts establish their test
scopes, not additional desktop/game results.

## Acceptance status and additional release coverage

The implementation is accepted within the recorded scope: four original
real-game cases passed on generation 11, the final physical-key rerun was
explicitly waived by the user, and the mixed-implementation, isolation,
surface-lifetime and selected broad feature cases above passed. This does not
claim every launcher/backend combination, independently published-version
compatibility or the 500-participant design goal.

The following catalog is additional unrun release coverage, not unfinished
core rewrite work. Older passes retain their actual generation labels:

- Additional raw registration/backend cases where needed; generation-10
  before-injection/NULL and generation-11 D3D11 after-injection results remain
  labeled above. Generation-11 raw wheel/cursor-specific cases are now recorded
  separately above.
- Additional fractional display/raster combinations, especially an actually
  observed independent raster/display mismatch. The observed 125% attached and
  150% SDK-created cases are recorded above.
- Final-drain reruns where needed; generation-10 passes, generation-11 explicit
  session close and generation-11 D3D12 promotion are recorded separately above.
- Folder/basename policy revocation as applicable.
  Managed early/best-effort baseline/rearm/cancel passes do not remove the
  inherited fast-start boundary or complete the failed fast lifecycle; native
  watcher quiescence has its separate noninjecting pass above.
- Reserved add-on mutation/rollback transaction variants and additional
  preflight cases. Existing-installation rejection, stock game coexistence and
  changed-runtime-hash acceptance have separate passes and do not replace every
  maintenance transaction case.
- Remaining unrecorded backend/input-mode combinations. The long-idle future
  target, four
  D3D9/10 architecture cells and controlled same-target/two-target cases are
  recorded above; older-generation results are not silently relabeled as
  current.

Run desktop gates sequentially in fresh PowerShell processes. Raw pair wrappers
already execute both WM_INPUT and buffered modes; DPI/pointer wrappers use
existing candidate artifacts and do not accept `-SkipBuild`. Estimated healthy
durations are roughly 15–25 seconds per raw pair and 5–25 seconds per other
controlled case; these are scheduling estimates, not newly measured capacity
or deadline claims.

## Controlled launcher catalog for future release coverage

Real-game cases do not exercise every accepted native behavior. Keep these
human-facing controlled launchers available and select them for future changes:

| Behavior | Existing launcher families |
| --- | --- |
| D3D9/D3D10/D3D11/D3D12 rendering, input suppression/release, resize and cleanup | `*-client-sdk.ps1`, `*-native-input-gate.ps1`; x86 D3D9/D3D10 variants |
| Exact-process startup and identity, independent process attachments | `*-client-sdk-process-start-injection.ps1`, `*-x86-exact-injection-gate.ps1` |
| Per-app isolation and app exit; two targets | `d3d11-client-sdk-two-app-one-target.ps1`, `d3d11-d3d12-client-sdk-two-app-two-target.ps1` |
| Raw WM_INPUT and buffered input, registration before injection, NULL focus-following registrations | `*-client-sdk-raw-input.ps1`, `*-client-sdk-raw-registration-before-injection.ps1`, `*-client-sdk-null-target-raw-registration.ps1`, raw wheel/cursor cases |
| Wheel axes, partial/reverse deltas, nested scrolling, real Windows cursors and release | `*-wheel-cursor.ps1`, `d3d11-x64-wheel-cursor-wm-input.ps1`, `d3d11-x64-wheel-cursor-raw-buffer.ps1` |
| Fractional raster/DPI scale, attached surfaces | `d3d11-x64-wheel-cursor-dpi125*.ps1`, `d3d11-x64-wheel-cursor-dpi150.ps1` |
| No-click focus, reopen, blur and long-idle future target | `d3d11-explicit-keyboard-focus.ps1`, `d3d11-idle-future-target-focus.ps1` |
| Session deactivation, primary-surface replacement/drain, target relaunch | `*-client-sdk-session-deactivation.ps1`, `*-client-sdk-multi-swapchain.ps1`, `*-client-sdk-target-surface-drain.ps1`, `d3d12-client-sdk-reinjection.ps1` |
| Two private engines across never-presented secondary promotion and final recreation | `d3d11-client-sdk-two-app-surface-lifecycle.ps1`; recorded generation-11 pass above |
| Managed policy, basenames/folders, cancellation and lifecycle | `d3d11-x64-managed-*.ps1`, `native-policy-watcher-quiescence.ps1` |
| Existing host/install safety and reserved add-on transactions | `d3d11-client-sdk-existing-reshade-*.ps1`, `d3d11-client-sdk-official-reshade-addon.ps1`, `d3d11-official-reshade-addon-preflight.ps1`, `reshade-addon-manager.ps1`, installation/global-layer preflights |

These are separate from simulated SDK/transport unit tests. A full build or
simulated load pass is not native game acceptance.

## File/process ownership and recording

Ordinary injected-host cases stage native files/configuration/logs outside the
game directory. The existing stock-ReShade coexistence gate intentionally
creates an owned `dxgi.dll`, bootstrap `ReShade.ini` and uniquely named test tree
inside a previously clean real game directory. It refuses foreign collisions,
uses no-replace creation, verifies exact paths/reparse points/hashes and removes
only unchanged owned seeds in `finally`. That case needs scoped filesystem
escalation under the present workspace permissions. It tests preservation of an
existing installation; it does not prove a universal no-game-directory-files
runtime implementation.

Before each interactive run, ensure the desktop can remain quiet. Do not
terminate an existing game/client/injector to make a preflight pass. Retain each
owned process object and exact process identity for cleanup, and preserve
possibly consumed attachment ownership until authoritative game exit. Do not
erase shared claims, cache/catalog entries or rendezvous files to force a new
runtime. Existing foreign ReShade files must never be replaced by test setup.

For every result retain source commit, engine/add-on identities and hashes,
runtime hash, exact target PID/creation identity, startup order, both apps' logs,
native logs, structured PASS report, and scene/input observations. State which
inputs were physical, synthetic or computer-use. The final release claim must
separate actual game runs, controlled native hosts, independently compiled
engine combinations and simulated protocol tests.
