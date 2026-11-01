# Installed gen11/gen16-async Gun Frog acceptance — 2026-11-01

All four startup-order and first-app-exit cells passed with two independently
npm-installed development SDKs: the retained generation 11 baseline and the
exact generation 16 async package below. Each cell used two genuine Electron
producers and an actual x64 D3D11 Gun Frog process. This acceptance applies to
those installed bytes, including the candidate's canonical 209-byte INI and
first-host result classification patch.

The [portable audit](evidence/installed-gen11-gen16-async-2026-11-01.json)
retains repository-relative paths, observations, byte counts and SHA-256 values
for **456 critical files**. It includes the installed inventories, archives,
lockfiles, producer records, module snapshots, copied native logs and six
controller/packaging source files. Its UTF-8/LF SHA-256 is
`1b07bbc8089cfeda05641a5d6aa37d0832e3430d606f5ce55cfda30d037f53c5`.
The original build artifacts were not rewritten for this audit. Earlier
generation 14 successes and generation 15 failures remain separate evidence.

The [npm pair report](../build/installed-cooperative-pair-gen11-gen16-async-20261101-final/report.json)
has SHA-256
`1ae29b92fcd54ad145fe434a3d8144491e84d0fc16d5982a7f9f1acfeb1593f5`.
The [entrypoint preflight](../build/installed-cooperative-pair-gen11-gen16-async-20261101-final/game-entrypoint-preflight-20261101-204235-7014548.json)
binds that report to both installed consumers. The
[game report](../build/cooperative-two-app-game-20261101-204235-13b581c3/report.json)
has SHA-256
`9dc88d9f533d8a7ff6600048d2f5afe34de583a9c3e64123a2ca1688ba21da9d`.

| Member | Installed development version | Native generation / build ID | Sealed payloads |
| --- | --- | --- | --- |
| A | `0.1.0-development.baseline.gen11.cdc6e80` | 11 / `E16461475E524DBA83398B19CDD95EBB` | 145 |
| B | `0.1.0-development.candidate.gen16.e8fe3783.async` | 16 / `E8FE3783F29E4FB297D8B006D0087725` | 148 |

Both archives were packed and installed offline with package scripts disabled;
all four recorded npm commands exited successfully. The independent
[seal verification](../build/installed-cooperative-pair-gen11-gen16-async-20261101-final/independent-seal-verification.json)
binds the pair report and verifies **293 source/stage/installed payloads** byte
for byte, 28 native asset bindings and 16 PE architecture headers. Both normal
public package verifications passed. Only `packageVersion` changed in the
copied distribution seals; every listed implementation payload remained
byte-identical. The npm wrapper metadata transform is recorded in the retained
provenance.

Each of the eight per-case SDK records proves the public load boundary
`createRequire(consumer/package.json)('electron-game-overlay')`, its separate
consumer and package root, installed version, entrypoint and seal. The loader
requires the installed package and checks the resolved entrypoint; there is no
workspace fallback. Preflight, case reports and producer records agree.

| Identity | A: gen11 | B: gen16-async |
| --- | --- | --- |
| Installed SDK seal SHA-256 | `da2738656c93390d992a01b0cc9fc8d013154ce400c89c85b2f3f426f654b2d6` | `31dc67d055c7b2933f6b9b021b75bf0dedc4474078231358a8551930edf08ce1` |
| JavaScript graph SHA-256 | `8abcbc25191c3371b4efcda26233d4dc68361e103e77066d30e23751a68877e4` | `a401e62322b9fc5c3feaa53962121a7a8ee9fdeaf0b607535d00bc70054f8b32` |
| x64 add-on SHA-256 | `f807e8e16e3997463a1ca99c29d44e7f8806d07cfdf8878be7a15e5b982d862e` | `a259f9125f3e509bf64827a8f72b5ba8aa4091765e2ab16e404ebc659a43d122` |
| x64 packaged ReShade SHA-256 | `5851d903abfacd7deba7de4aac580c0ea648ad6f2ae5e6de85bcff1ad990769a` | `c403a8b113485eec6cc3b2c0b384c3f9b17fe2b76aad0385f5dd2ac61cc1be66` |

The root `index.js` stub has the same hash in both packages; their complete
JavaScript graphs and native implementations differ. Version labels and
revision-like suffixes are metadata, not proof of immutable source commits or
released-package provenance. The seals, graph hashes, exported build IDs and
native hashes identify this milestone.

Candidate ReShade manifests use schema 30 and retain the owned-host patch
`51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE`
and first-host result patch
`B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554`.
Its canonical INI is 209 bytes with SHA-256
`a4beeb5c9f49abf6c170c82c256b0ac6d901b517a702165166f405454edd47fb`.
Both native package families retain cooperative ABI 1 and target transport
range 1–1; all private discovery records use version 1.

| Cell | Producer PIDs A / B | Original → relaunched game PID | Survivor | Result |
| --- | --- | --- | --- | --- |
| A first / graceful exit | 45376 / 22128 | 27988 → 43452 | B | [PASS](../build/cooperative-two-app-game-20261101-204235-13b581c3/a-first-graceful/result.json) |
| A first / forced producer termination | 49076 / 7264 | 23240 → 47756 | B | [PASS](../build/cooperative-two-app-game-20261101-204235-13b581c3/a-first-crash/result.json) |
| B first / graceful exit | 46484 / 50964 | 46392 → 50916 | A | [PASS](../build/cooperative-two-app-game-20261101-204235-13b581c3/b-first-graceful/result.json) |
| B first / forced producer termination | 11488 / 50988 | 26368 → 3056 | A | [PASS](../build/cooperative-two-app-game-20261101-204235-13b581c3/b-first-crash/result.json) |

All four result files exactly match the embedded game-report cases. Each has
18 unique successful checks, no error and no cleanup error: **72 named checks**
in total. The crash-mode cells use forced Electron-process termination and
wait for exit. They do not inject an unhandled native fault. The controller
completed its owned cleanup; this retrospective audit did not inspect live
processes.

Each cell has distinct private ports, token fingerprints and producer PIDs.
Both apps use local main-window ID `1`; the first app also owns local window
`2`. The initial watcher is prearmed before the game exists, so its initial
discovery record can have a null target PID. Authentication events and
PID/creation-time identities bind the actual target and its fresh relaunch.

The recorded controls cover interleaved red/blue/green surfaces, transparent
cutouts, independently raised windows, exact `alpha` and `bravo` text with all
key releases, Windows text/hand/resize cursors, caption dragging and placement
preserved after peer publication. Extra-window records retain both wheel axes
with 120-unit deltas, scroll position `{x:120,y:120}`, and an outside-window
pointer release. Each cell passes all four interception combinations and then
enables both apps: requested pairs `(T,T), (T,F), (F,T), (F,F), (T,T)` produce
effective values `T,T,T,F,T`. All observed surfaces report DPI 96, scale 1 and
window DPR 1; this run does not establish fractional or multiple-DPI behavior.

All twelve native-evidence records match their OS module snapshots. Every
snapshot has exactly one ReShade module. Original-game and survivor snapshots
contain the exact generation 11 and 16 add-ons. The host remains the first
app's exact runtime path/hash after that app exits or is killed. Both add-on
DLLs deliberately remain mapped in the original game
(`retiredBuildStillMapped: true`). Scene retirement, survivor rendering and
exact `survivor` typing establish live participant behavior; no DLL-unload
claim is made.

After normal game closure, the same surviving producer rearms for a new
PID/creation-time instance. Each fresh snapshot has one host from the surviving
package and only that package's add-on. Survivor rendering, exact `relaunch`
typing and key releases pass. Final survivor records have attachment attempt
`2`, no held keys, and requested/effective interception false. The 20 distinct
mapped-module files were rehashed. All 16 copied native logs pass the
controller's input/router/queue fault scan, and all eight raw producer states
contain no error events. Producer stderr contains `getBitmap()` deprecation
warnings.

The embedded `finalStates` precede cleanup. Standalone state files can later
record target-disconnected events and the exit command. A retired producer's
last state is stale after exit. Exact `survivor` typing remains a controller
assertion; the surviving DOM was subsequently overwritten with `relaunch`.
The [display wrapper](../build/readiness-gen16-installed-pair.display.json)
records display-on observations and successful release/closure of its temporary
display request; no persistent display-setting change is claimed.

Input here is **Windows SendInput**, not human physical-key evidence. This is
an x64 Gun Frog lane; x86 hashes establish package integrity, not x86 game
acceptance. Module snapshots and module-file hashes identify observed modules,
not remote-memory bytes or every historical injection/initialization attempt.
This record does not certify later source changes, independently released
packages, the full feature/backend or original-game/manual-key matrix, or
native fault containment between modules sharing the game process.
