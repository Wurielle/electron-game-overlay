# Installed gen11/gen14-session Gun Frog acceptance — 2026-11-01

The retained run passed all four startup-order and first-app-exit cells with two
independently npm-installed development SDKs: gen11 and the exact gen14-session
package identified below. Each cell used two genuine Electron producers and an
actual x64 Gun Frog process. This milestone applies to those packaged bytes;
pending stage-marker and late integration source changes are outside its scope.

The [portable audit](evidence/installed-gen11-gen14-session-2026-11-01.json)
contains repository-relative paths, observations and SHA-256 values for **448
critical retained files**, including installed payloads, archives, lockfiles,
producer records, module snapshots and copied native logs. Its UTF-8/LF SHA-256 is
`03a013b799a03e736a8268060e91cae486a5400a9c036d3064a882157839dae9`.
The underlying build artifacts retain their original contents and absolute
paths; they were not rewritten to produce this audit.

The frozen [npm pair report](../build/installed-cooperative-pair-gen11-gen14-session-20261101-final/report.json)
has SHA-256
`6dda156c9fdaeae111e005aae697d8d2917b0c6a6e4089020fb551319bbae8ae`.
The [entrypoint preflight](../build/installed-cooperative-pair-gen11-gen14-session-20261101-final/game-entrypoint-preflight-20261101-175228-0025432.json)
binds that report to both installed consumers. The
[game report](../build/cooperative-two-app-game-20261101-175228-c80a03bb/report.json)
has SHA-256
`61263db2a6dd03241b37057139fee94907d358bb26090c97716961d2d08c7143`.

| Member | Installed development version | Native generation / build ID | Sealed payloads |
| --- | --- | --- | --- |
| A | `0.1.0-development.baseline.gen11.cdc6e80` | 11 / `E16461475E524DBA83398B19CDD95EBB` | 145 |
| B | `0.1.0-development.candidate.gen14.session.412d57be` | 14 / `412D57BEA49440738CC4C3903038F2E7` | 148 |

Both separate archives were packed and installed offline with package scripts
disabled; all four recorded npm commands exited successfully. The installed
inventories and bundled `tslib` bytes match their retained source seals. Each
producer's per-case SDK record proves the public load boundary
`createRequire(consumer/package.json)('electron-game-overlay')`, its own consumer
and package root, installed version, entrypoint and seal. The preflight, four
case reports and eight producer SDK records agree on these identities.

| Identity | A: gen11 | B: gen14-session |
| --- | --- | --- |
| Installed SDK seal SHA-256 | `da2738656c93390d992a01b0cc9fc8d013154ce400c89c85b2f3f426f654b2d6` | `6bc43834add7c1d7facff6145965faed55d58b7bf37ec90ba823c6a1b197b52a` |
| JavaScript graph SHA-256 | `8abcbc25191c3371b4efcda26233d4dc68361e103e77066d30e23751a68877e4` | `c0d9d9d8a84549b4e4d43227ce63fd5a7007a0d38fe90c20d8771a6dc6091c26` |
| x64 add-on SHA-256 | `f807e8e16e3997463a1ca99c29d44e7f8806d07cfdf8878be7a15e5b982d862e` | `a5e15a093f4c04287b2220b0850717625261e26eb92c4875f8c68732ac76be8b` |
| x64 packaged ReShade SHA-256 | `5851d903abfacd7deba7de4aac580c0ea648ad6f2ae5e6de85bcff1ad990769a` | `d3b18c80eab3dc255a2de2fdaeb01926b4695feb5a9dd564a6ec136fe2e94cca` |

The root `index.js` hash is the same in both packages; the complete JavaScript
graphs and native implementations differ. Version labels and revision-like
suffixes are metadata, not proof of immutable source-commit or released-package
provenance. The observed seals, graph hashes, exported build IDs and native
hashes identify this milestone.

| Cell | Producer PIDs A / B | Original → relaunched game PID | Survivor | Result |
| --- | --- | --- | --- | --- |
| A first / graceful exit | 31224 / 46828 | 45220 → 30896 | B | [PASS](../build/cooperative-two-app-game-20261101-175228-c80a03bb/a-first-graceful/result.json) |
| A first / crash | 28940 / 5156 | 37048 → 36868 | B | [PASS](../build/cooperative-two-app-game-20261101-175228-c80a03bb/a-first-crash/result.json) |
| B first / graceful exit | 46272 / 48156 | 46032 → 26392 | A | [PASS](../build/cooperative-two-app-game-20261101-175228-c80a03bb/b-first-graceful/result.json) |
| B first / crash | 46692 / 23032 | 38268 → 32756 | A | [PASS](../build/cooperative-two-app-game-20261101-175228-c80a03bb/b-first-crash/result.json) |

All four case files exactly match the cases embedded in the game report. Each
records 18 successful checks, `status: "passed"`, and no error or cleanup error.
The controller completed its owned cleanup without recording a failure; this
retrospective audit did not inspect live processes.

Every cell records distinct private ports and token fingerprints, with producer
PIDs matching their respective applications. Both local main-window IDs are
`1`; the first producer also owns local window `2`. The first app prearms its
native watcher before the game exists, so its initial publication's `targetPid`
is null. Authentication events and controller checks bind both apps to the
owned game. Retained PID/creation-time identities distinguish the original game
from the fresh relaunch.

All private discovery records use version 1. Both runtime packages declare
target transport range 1–1 and cooperative add-on protocol 1.

The recorded controls cover interleaved composited surfaces, transparent alpha
cutouts, individual-window raising, exact `alpha` and `bravo` text with released
keys, Windows text/hand/resize cursors, caption dragging and placement after peer
publication. Extra-window records retain both wheel axes with 120-unit deltas,
scroll positions `{x:120,y:120}`, and an outside-window pointer-up coordinate.
The interception matrix passes `(first,late) = (T,T), (T,F), (F,T), (F,F)`, with
effective interception `T,T,T,F`, then enables both before the first app exits.

The twelve native-evidence records have `status: "validated"`. Each observed
snapshot has exactly one ReShade module. Initial and survivor snapshots contain
the exact gen11 and gen14 add-ons. The initial host remains the first app's host
after that app exits or crashes. Both add-on DLLs deliberately remain mapped in
that original game: `retiredBuildStillMapped` is true. Successful surface
retirement, survivor rendering and exact `survivor` typing establish the live
participant behavior; this record does not claim the retired DLL was unloaded.

After normal game closure, the same surviving producer rearms and attaches a
new PID/creation-time instance. Each relaunch snapshot has one ReShade and only
the survivor's exact add-on. Exact `relaunch` text and all key releases pass;
the captured final survivor has no held keys, attachment attempt `2`, and
requested/effective interception false. All 16 copied native logs pass the
controller's input/router/queue fault-pattern scan. Producer stderr contains
`getBitmap()` deprecation warnings.

The embedded `finalStates` are captured before cleanup. Standalone state files
can subsequently record target-disconnected events and the exit command. The
retired producer's last snapshot is stale after its exit and does not describe
a live interception request. Exact `survivor` typing remains a controller
assertion; the final surviving DOM was later overwritten with `relaunch`.

Input in this run is **Windows SendInput**, not human physical-key evidence.
The game lane is a clean-host x64 run; x86 hashes establish packaged-payload
integrity, not x86 game acceptance. Module snapshots plus module-file hashes
establish observed module identities, not remote-memory bytes or historical
injection counts. This record does not certify pending source changes, the full
feature/backend matrix, independently released-package compatibility, or
native fault containment between modules in the game process.
