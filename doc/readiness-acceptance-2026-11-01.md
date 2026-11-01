# Readiness follow-up acceptance — 2026-11-01

**The four readiness follow-ups are addressed within the recorded Windows
acceptance scope.** Exact generation 16 is built and sealed. All 32 script
cases, all four original real-game lanes and all four independently installed
gen11/gen16 game cells pass. Earlier failures remain retained, and the explicit
limits below remain: the historical D3D11 GPU hang is unattributed, stock copied
buffered input and generic late D3D12 attachment are unsupported, and large-scale
capacity has not been measured.

The [portable record](evidence/readiness-2026-11-01.json) retains exact
candidate identities, test boundaries and artifact hashes. Historical dated
records have not been rewritten.

## Built generation-16 candidate

The SDK contains 148 sealed payloads totalling 20,262,743 bytes. Package label
`0.1.0-rc.7` is informational; these hashes and exports identify the candidate.

| Identity | Value |
| --- | --- |
| Native generation / add-on build ID | 16 / `E8FE3783F29E4FB297D8B006D0087725` |
| SDK seal SHA-256 | `8cc9cc84091ddbcc5c03bd5ef136c02ae4f1fdfeb02a6151f85322bdde691b50` |
| JavaScript graph SHA-256 | `a401e62322b9fc5c3feaa53962121a7a8ee9fdeaf0b607535d00bc70054f8b32` |
| x64 add-on SHA-256 | `a259f9125f3e509bf64827a8f72b5ba8aa4091765e2ab16e404ebc659a43d122` |
| x86 add-on SHA-256 | `fcab046c07b573a030753f73cc678c56da5507cd142b804b76d2eab935b95684` |
| Canonical owned INI | 209 bytes / `a4beeb5c9f49abf6c170c82c256b0ac6d901b517a702165166f405454edd47fb` |

Both architectures retain cooperative ABI 1 and target transport 1–1.
Pinned normalized injector source SHA-256 is
`f286cdc1b9d138e4429a50c3e82749292b39f51b42592bfd9b738c889a6fa074`.
The JSON record retains the exact six runtime/add-on/injector PE hashes.
Its seal reference is an immutable copy retained in the independent consumer,
rather than the mutable workspace distribution.
The [post-acceptance public verification](../build/readiness-gen16-post-acceptance-seal.json)
passed at 21:07:50 UTC: all 148 sealed payloads still matched this exact seal
after all native and GUI runs, without executing native code or writing package
files.

| Completed generation-16 check | Result and boundary |
| --- | --- |
| [Normal Nx client/dependency build](../build/readiness-gen16-full-build.log) | PASS, 1 min 57 s; both native architectures, staged/sealed SDK and client. |
| [Authoritative post-harness Node 26 SDK suite](../build/sdk-unit-gen16-node26-final-postharness.log) | 1,045 tests: 1,035 passed, zero failed, ten expected skips in 63.24 s. The earlier 1,044-test run remains separately retained; only harness/source tests changed, with the sealed SDK/native bytes unchanged. SDK and client no-emit typechecks passed. These checks are separate from game acceptance. |
| [Native console acceptance](../build/native-gen16-final/evidence.json) | Four ABI/registry CTests, two classic loader suites and two owned-late loader suites passed; 16 named owned cases across x64/x86. Actual first-host output has four fields and private joins nine, with zero success records after failed bootstrap. The six production PE hashes remained unchanged during acceptance. Console/inert DLLs prove no rendering or game input. |
| [Delayed-UI-thread recovery](../build/readiness-gen16-busy-20261101-204104/report.json) | Both actual x64/Win32 graphics cases passed: exact pixels, recovered input, same-HWND paused-primary behavior, unchanged canonical INI and zero generated INIs after retirement. The measured UI-thread holds were 2,828 ms and 2,860 ms. Self-loading controlled fixtures do not prove automatic process attachment or physical keys. |
| [Independent gen11/gen16 package preparation](../build/installed-cooperative-pair-gen11-gen16-async-20261101-final/report.json) | Four offline pack/install commands passed with scripts disabled; 293 sealed payloads, 28 native bindings and 16 PE headers were verified. This preparation executes no native implementation and does not itself prove the game matrix. |
| [Installed gen11/gen16 actual Gun Frog matrix](../build/cooperative-two-app-game-20261101-204235-13b581c3/report.json) | All four startup-order × graceful/crash cells passed 18 checks each: 72 checks total. Both own engines/private routes, one ReShade, interleaved rendering/input, survivor operation and survivor-only fresh-game relaunch passed. This is actual x64 game acceptance with Windows SendInput, separate from independently released-package compatibility. |
| [Gun Frog full SDK](../build/electron-game-overlay-runtime/client-Gun-Frog-20261101-214505/result.txt) | PASS for the four overlay buttons, interception release and normal real Quit. Its [identity-bound monitor](../build/device-loss-monitor/gun-frog-20261101-214504-1b5b579b/e771074238d845a3b7858db9aae579e1/report.json) armed and reported target exit without observed device loss. No historical GPU-fault root cause is claimed. |
| [Gun Frog stock ReShade coexistence](../build/electron-game-overlay-runtime/client-Gun-Frog-official-reshade-coexistence-20261101-214632-fd129786/result.json) | PASS with exact generation-16 add-on identity, one stock runtime, API-18 FPS Limiter and an enabled compiled witness effect. Four captured clicks, release and real Quit passed; protected bytes/attributes/timestamps were identical and the controller confirmed the original clean game directory was restored. |
| [Gun Frog automatic no-click focus](../build/explicit-focus-20261101-214955/report.json) | Seven checks passed with zero pointer-downs, using Windows SendInput. |
| [Gun Frog low-level Electron scene](../build/electron-game-overlay-runtime/injected-Gun-Frog-20261101-215350/electron-producer.stdout.log) | PASS for all four overlay clicks, explicit Release Input, disabled acknowledgement, lifecycle completion and normal native Quit. The [initial OS/module identity](../build/electron-game-overlay-runtime/injected-Gun-Frog-20261101-215350/initial-native-identity.json) binds exact PID 50808/creation FILETIME to one generation-16 ReShade and one exact add-on. The [first-host result](../build/electron-game-overlay-runtime/injected-Gun-Frog-20261101-215350/injector-result.json) retains its four-field shape. Snapshot identities do not claim a historical injection count. |
| [Final owned late-D3D11 matrix](../build/readiness-gen16-late-20261101-205021/report.json) | All eight standalone/resize/final-destroy/paused-primary × x64/Win32 cases passed using exact final candidate PEs. Every case retained exact pixels, unchanged canonical INI and zero generated INIs; all six same-HWND cases passed input promotion. These self-loading fixtures are distinct from automatic process discovery and real-game acceptance. |
| [Final control matrix](../build/readiness-gen16-control-20261101-205505/report.json) | All ten cases passed: unbarriered folder discovery/relaunch, best-effort observation, D3D11/12 multi-swapchain, session deactivation and surface drain, plus two-app surface lifetime and two apps/one target. Exact native-module and input oracles were retained. |
| [Final input/scaling matrix](../build/readiness-gen16-input-20261101-205823/report.json) | All six WM_INPUT, buffered pointer, attached 125%, created 150% and owned/stock capability cases passed. |
| [Final backend matrix](../build/readiness-gen16-backend-20261101-205959/report.json) | All four D3D9/D3D10 × x64/x86 pointer/feature cases passed. These are actual controlled graphics targets, separate from the game lanes. |
| [Final resource recovery](../build/cooperative-resource-soak/r-9a447278524a431b/evidence.json) | Eight cycles passed: four fresh Electron processes and four public-session recreations over 68.498 s between checkpoints. The survivor retained its route/TCP and fresh FPS each cycle; retired windows/ranks cleared. Final state retained nine native modules/slots/frame workers as designed, with zero TCP, windows, ranks, focus, capture and interception requests. Private bytes rose from 78,036,992 to 106,860,544 and handles from 938 to 1,000; these are diagnostic measurements, not flat-resource claims. |

The [final resource audit](../libs/electron-game-overlay-runtime/tests/cooperative-resource-soak/sdk-evidence-gen16-2026-11-01.json)
retains 83 artifact identities, both independent artifact checks, the four-field
first-host result plus OS/module proof, and all nine canonical 209-byte INIs.
The five owned producer children exited normally with no cleanup error. This
is the final generation-16 run, separate from the older gen15/207-byte record.

The 32 script cases are control 10 + owned late 8 + busy recovery 2 + input/scale
6 + backend 4 + real-game focus 1 + resource 1. The resource case contains eight
cycles. The count already includes the original focus game lane; the three
other original game lanes were manually exercised, and the four installed
mixed-game cells are separate. SDK unit and native console counts are also
separate.

## Four follow-ups

| Follow-up | Implemented behavior and established evidence | Explicit boundary |
| --- | --- | --- |
| Rendering and device loss | D3D12 initial texture uploads use the exact runtime queue. The actual two-queue regression passed on x64/x86 while the foreign queue stayed blocked. Visual tests require an observed-ON display and bounded temporary request. All generation-16 game/backend/input/resource cases pass; the SDK monitor observed normal target exit without device loss. | The historical Gun Frog D3D11 GPU hang remains unattributed; neither the D3D12 fix, display controls nor synthetic dump establishes its cause or resolution. |
| Automatic attachment and relaunch | Generation 16 passes unbarriered folder discovery/relaunch, all eight owned late cases, delayed-UI-thread recovery on both architectures, all four original game lanes, all installed-game cells including fresh survivor-only relaunch, and final input/backend regressions. | Generic late D3D12 queue recovery and a production deterministic launch API remain unimplemented/unaccepted. |
| Stock input capability limits | Immutable requirements and host-derived capabilities reject missing buffered input before outbound initialization/frame/interception traffic. Final generation-16 owned/stock cases passed, including an unchanged permissive peer TCP/credential identity and seven unchanged foreign entries. | Accepted within this controlled scope. Stock ReShade copied `GetRawInputBuffer` remains unsupported; typed rejection does not supply that feature. |
| Independent installation and resource recovery | Every app retains its own SDK/native engine and private transport. Fresh sessions use fresh routes; inactive epochs retire windows/ranks. Exact gen16 eight-cycle recovery passed. Independently installed gen11/gen16 packages pass all four actual game cells, with a 456-file portable audit. | Development snapshots are not independently released versions. Eight cycles do not establish 500-app capacity; intentionally pinned code/state remains until game exit. |

## Hook-timeout regression and recovery

The [installed gen11/first-gen15 game attempt](../build/cooperative-two-app-game-20261101-201049-368b2092/report.json)
remains **failed**. A-first/graceful passed all 18 checks. A-first/crash retained
a working survivor in its original game and completed 16 checks, then the fresh
survivor-only game, PID 44036, failed input routing. The two B-first cells were
not accepted.

The native failure was a two-second cross-thread window-subclass
`SendMessageTimeoutW` returning timeout 1460 and permanently leaving the
new HWND unready. The
[old-gen15 negative control](../build/late-d3d11-same-hwnd/proof-ui-busy-hook-recovery-x64-02b84a1547d342d19589a14c3a5abe50/evidence.json)
reproduced this with a requested 2,800 ms UI-thread hold and the exact retained
gen15 PE bytes. Its [native log](../build/late-d3d11-same-hwnd/proof-ui-busy-hook-recovery-x64-02b84a1547d342d19589a14c3a5abe50/stage/ReShade.log)
records error 1460 and inactive interception. The original status stays failed
and recovery false; expected regression reproduction is not a product pass.

Generation 16 posts setup to the owning thread, retains pending/ready state,
reports a five-second deadline, and can accept a late acknowledgement. Cookie
and window-property checks bind setup to the HWND incarnation; a shared callback
gate protects older participating members. ABI and wire layouts are unchanged.

The actual [x64 positive](../build/late-d3d11-same-hwnd/proof-ui-busy-hook-recovery-x64-7b03bbb1e71248ea8dcb9f68bc193ee0/evidence.json)
and [Win32 positive](../build/late-d3d11-same-hwnd/proof-ui-busy-hook-recovery-Win32-b6c6af20384d4d65a9fcaef77179f8ea/evidence.json)
both set recovery, production owned ABI, input-promotion and rendered-pixel proof
true, with exact generation-16 PE identities. Both stage templates stayed at the
canonical hash and left zero generated INIs. The
[paired portable audit](../libs/electron-game-overlay-runtime/tests/late-d3d11-same-hwnd/evidence-ui-busy-2026-11-01.json)
retains the actual keyboard, pointer, cursor, registration and retirement
oracles. Intercepted held keys reached the DOM while native legacy/raw and all
three polled-down counters stayed zero; release restored native input. Fresh
registration kept one authenticated TCP connection, and cursor/clip returned to
baseline. After producer exit, stale producer ACK snapshots are not treated as
live state: native restoration and window/rank/focus withdrawal are checked.
The later installed-game matrix separately proves actual fresh-game recovery.

The final [owned capability run](../build/electron-game-overlay-runtime/client-sdk-input-capabilities-owned-20261101-205848-3869adf2/report.json)
reports copied WM_INPUT and buffered input supported, exact red pixels, unchanged
intercepted game counters and released raw-buffer count three with zero errors.
The [stock run](../build/electron-game-overlay-runtime/client-sdk-input-capabilities-stock-20261101-205858-b5f384f7/report.json)
reports copied WM_INPUT supported and copied buffered input unsupported. Its
strict app received the typed rejection after two hellos, with zero outbound
bytes/packets/frames/true commands or actual socket writes, and no authentication,
rendering or true ACK. The permissive peer retained its TCP and transport
identity, accepted fresh input and retained exact blue pixels. All seven
protected foreign records were identical through cleanup.

## Independently installed final-candidate pair

| Member | Development package version | Generation / sealed payloads | JavaScript graph SHA-256 |
| --- | --- | --- | --- |
| A | `0.1.0-development.baseline.gen11.cdc6e80` | 11 / 145 | `8abcbc25191c3371b4efcda26233d4dc68361e103e77066d30e23751a68877e4` |
| B | `0.1.0-development.candidate.gen16.e8fe3783.async` | 16 / 148 | `a401e62322b9fc5c3feaa53962121a7a8ee9fdeaf0b607535d00bc70054f8b32` |

The [pair report](../build/installed-cooperative-pair-gen11-gen16-async-20261101-final/report.json)
retains separate archives, consumers, lockfiles, installed seals and native
identities. Metadata-only development labels do not alter sealed implementation
payloads. These are independently installed development snapshots, not
independently released SDK versions. Their
[actual game matrix](../build/cooperative-two-app-game-20261101-204235-13b581c3/report.json)
passes all four cells. The [standalone audit](installed-gen11-gen16-async-acceptance-2026-11-01.md)
retains 456 critical file identities and preserves the failed gen15 attempt as
a separate record.

## Previous-generation support and failed attempts

Generation-15 results remain useful supporting evidence, with their native
identity and configuration boundary preserved in the JSON record:

- Ten distinct control cases passed across
  [initial](../build/readiness-gen15-control-20261101-193941/report.json),
  [resumed](../build/readiness-gen15-control-20261101-194547/report.json) and
  [final case](../build/readiness-gen15-control-20261101-195527/report.json)
  reports. The first two reports stay failed: their stale success parsers were
  corrected before strict reruns passed.
- [Six input/scaling cases](../build/readiness-gen15-input-20261101-194143/report.json)
  and [four D3D9/D3D10 architecture cases](../build/readiness-gen15-backend-20261101-195013/report.json)
  passed.
- Eight owned late cases passed across the
  [initial run](../build/readiness-gen15-late-20261101-195307/report.json) and
  [resume](../build/readiness-gen15-late-20261101-195747/report.json), using the
  first-sealed gen15 PEs with the canonical 209-byte source template. The SDK
  seal itself still held the earlier 207-byte template. The initial paused-case
  producer exit remains a failed attempt; an opt-in fixture keepalive correction
  passed on resume.
- [Gun Frog no-click focus](../build/explicit-focus-20261101-210748/report.json)
  passed seven checks with zero pointer-downs using Windows SendInput.
- [Eight resource cycles](../build/cooperative-resource-soak/r-1ee771525b5c4a23/evidence.json)
  passed with four fresh Electron processes and four public-session recreations
  over 75.442 seconds between checkpoints. Its
  [83-artifact audit](../libs/electron-game-overlay-runtime/tests/cooperative-resource-soak/sdk-evidence-gen15-2026-11-01.json)
  binds first-gen15 PEs, the original nine-field CLI result and retained
  207-byte INIs. Final state retained nine native modules/slots/frame workers,
  with zero TCP, windows, ranks, focus, capture and interception requests.
  Private bytes rose from 78,544,896 to 107,769,856 and handles from 984 to 1,051;
  these diagnostics are not flat-resource claims.

The earlier staged-INI byte failure remains recorded. Canonicalizing only the
owned source template resolved the stock serializer's final blank separator,
and final-destroy then passed on both architectures. Milestones `74f27cb` and
`72ebae1` record the late host/configuration work and injector CLI provenance
correction. The previous security-blocked rebuild, user review and missing file
are historical; the normal generation-16 build subsequently succeeded without a
security bypass or settings change.

## Acceptance scope and retained limits

No required case remains pending in this recorded matrix. Milestone `2eba041`
records the asynchronous input fix and its exact generation-16 pins and paired
busy-thread evidence. The user waived the physical-key rerun. SendInput results
are never relabeled as physical input.

All eight temporary display-master records completed with successful clear and
close; the last request was released at 21:04:20 UTC. The controller confirmed
no owned Gun Frog process remained. No persistent power/security setting was
changed. The JSON record binds the cleanup records by hash.

One ReShade host and the game address space remain shared. Per-application
feature/transport isolation does not provide native fault containment. Existing
foreign ReShade runtime/configuration/presets/effects/add-ons must remain
unchanged.

Native participant modules and lifetime state intentionally remain mapped until
authoritative game exit. The ABI has 512 lifetime participant slots, 8,192 window
slots and 512 surface slots. An eight-cycle resource run is not a 500-app or
500-version capacity/performance measurement.

The [display evidence](rendering-display-power-evidence.md) establishes a
passing observed-ON control using retained gen12 native bytes, not the cause of
every older white sample. The earlier OFF observation was later than its failed
sample; an older decoded white sample lacked raw COLORREF validity; complete
historical SDK/controller equality was not retained. The
[first-loss monitor](device-loss-monitor.md) and
[D3D12 exact-queue regression](../libs/electron-game-overlay-runtime/tests/d3d12-initial-upload-queue/evidence-2026-11-01.json)
do not diagnose or retrospectively close the earlier D3D11 GPU hang.
