# Cooperative add-on acceptance map

Inventory taken on 2026-11-01 for the per-application add-on implementation.
This document records runnable cases and evidence boundaries, not passing
results for that implementation. The user permits a clean rewrite without an
old-package migration layer, while requiring preservation of overlay features
and all real-game E2E behavior.

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

All five existing real-game human-facing launchers are under
`libs/electron-game-overlay-runtime/scripts/test-cases`.

| Launcher | Required/optional parameters | Required proof and completion evidence |
| --- | --- | --- |
| `gun-frog-electron-scene.ps1` | Optional `-NoLaunch` only stages | Injector succeeds; native transport/router initialize; Electron producer and aligned four-button layout become ready; first two-window transported scene renders. Then waits for normal game exit. Visual/input exercise is manual; readiness alone is not the SDK four-click PASS. |
| `gun-frog-client-sdk.ps1` | Optional `-SkipBuild`, `-InteractionTimeoutSeconds` (60–900, default 600) | Real SDK/client authenticates the exact game PID/path and renders. Click each Electron Continue/New Game/Settings/Quit once while game remains on its menu; Ctrl+I releases input; the same underlying Quit position closes the game. Exact-once click/ACK markers, ordering, and no native router/input/queue fault. `result.txt` contains `GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`. |
| `gun-frog-explicit-keyboard-focus.ps1` | Mandatory `-GameExecutable`; optional `-ElectronExecutable`, `-PhysicalKeyboard`, `-PhysicalFirstKeys` | No-click first show and hide/reopen typing; released key state and zero pointer-downs; blur/interception-off drop input; re-enable types; foreign foreground rejects input; fresh presentation and resumed typing after foreground restore. Default uses Windows SendInput. `build/explicit-focus-*/report.json` must say passed. |
| `gun-frog-physical-first-key.ps1` | Mandatory `-GameExecutable`; optional `-ElectronExecutable` | Same focus case, with human physical lowercase `a` on initial show and `b` after reopen. Later gates use SendInput. A synthetic key run is not a physical-first-key pass. |
| `gun-frog-client-sdk-official-reshade-coexistence.ps1` | Optional `-OfficialRuntimePath`, `-SkipBuild`, `-InteractionTimeoutSeconds` (default 600) | Stock host, original API-18 FPS Limiter and enabled witness effect coexist with EGO. Exact target/module/add-on/build-ID/path assertions; exactly one official runtime; four overlay clicks while target stays alive, input release, then real Quit. Protected seed hashes/attributes/timestamps remain unchanged; reserved EGO mutations use the native manager; all test-owned seeds are restored before final JSON/PASS. |

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
electron-scene launcher always rebuilds/stages and has an unbounded
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

1. The real-game explicit-focus path deliberately skips member B. Its
   `-GameExecutable` branch does not prove two-app native isolation or survivor
   continuity. Add a real-game cooperative two-app case covering distinct native
   modules, app-local IPC and state, interleaved cross-app window ordering,
   focus/capture/cursor, late joining, member exit/crash and one ReShade runtime.
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

## Controlled gates still required for feature preservation

Real-game cases do not exercise every accepted native behavior. Retain and run
the human-facing controlled launchers appropriate to changes:

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
