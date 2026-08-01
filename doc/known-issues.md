## Known compatibility issues

Since we need to inject a dll into an existing game process, it will definitely has some compatible issues.

known issues:

### Current ReShade migration support envelope

The bundled production Windows runtime uses the project's pinned ReShade 6.7.3
full add-on host. On July 12, 2026, its controlled D3D11 and D3D12 input gates
passed: overlay controls remained interactive, game-side message/raw/polling
counters stayed frozen,
cursor confinement was released while intercepting, resize preserved the gate,
and release restored normal input. The D3D11 and D3D12 ReShade compositors now
also render the real ordered multi-window Electron scene and route exact mouse
and keyboard records through the shared Electron transport engine; click-to-front, typing,
and caption dragging passed without new game-side oracle activity. The oracle
now enables Windows mouse-in-pointer and requires `WM_POINTER` update/down/up
counters to stay frozen too. Gun Frog passed its initial corrected gate on July
12 and an exact four-button menu/release gate on July 13, 2026. The production
Electron client and public SDK now use the ReShade launcher for the accepted
process-name, arm-before-launch Gun Frog path. The same production path also
passed two fresh controlled D3D12 lifecycle/multi-window cycles and a separate
same-Electron-client restart/reinjection cycle. The public SDK additionally
accepts an optional exact PID, and the Electron demo exposes the same field, for
a watcher that injects immediately after the process exists and before graphics
device/swap-chain creation. Historical `CREATE_SUSPENDED` D3D11/D3D12 gates
passed that ordering on July 13, 2026. The current controlled launchers start
normally, finish loader work, and pause the cooperating host near entry before
window/device setup; both passed again through the production client/SDK on
July 30. The normal client later passed LORT's Unreal launcher/renderer chain,
but arbitrary external-watcher timing remains unverified.

Clean targets use the repository's pinned, patched ReShade 6.7.3 host. Every
detected target-local x64 ReShade identity instead suppresses fallback
project-runtime injection and is attempted with the uniquely named Electron
add-on. There is no product-version or runtime-hash allowlist: compatibility is
  established only when `ReShadeRegisterAddon` accepts public API 18 and the host
  returns the exact Dear ImGui function table. The bounded startup grace is
  inspection-only: a mapped host that still does not load the current add-on is
  reported as host-incompatible, while a host that disappears during the wait
  reports `target-official-addon-wait-expired`. Neither case can fall back to
  project-runtime injection.

Target-effective paths and `DisabledAddons` are resolved from the exact target
process and configuration, and a user disable is honored. The existing
runtime/proxy, INI, presets, effects, and foreign add-ons are never rewritten.
Only the native manager may mutate the reserved Electron add-on, marker,
journal, and verified temporary/backup files. Its runtime hash is exact
request/TOCTOU/transaction provenance, not a compatibility identity; the
marker's ReShade hash is installation provenance and is ignored for
compatibility. Installing or updating the project-owned add-on requires a
restart, and mapped-add-on maintenance waits for confirmed target exit. A
runtime upgrade or hash change does not automatically remove the managed
add-on. Applicable global Vulkan/OpenXR ReShade layers are preserved and block
fallback injection. Controlled fixtures plus one July 31, 2026 Gun Frog run
cover the narrow stock-host/foreign-API-18-add-on/enabled-effect combination.
This is not a broad real-game, arbitrary effect/add-on, or proxy-chain
coexistence claim.

The normal `npm run dev` Steam-path flow first gained real Gun Frog acceptance
through a one-shot native path watcher, then temporarily moved to exact-PID-only
attempts so launcher/child process chains could not be consumed by one early
selection. A later Gun Frog run proved that spawning an exact injector only
after the creation event can still miss a fast primary swap chain. The current
hybrid keeps one broad native path watcher prearmed for `\\steamapps\\` with zero
executable exclusions, while the continuous observer still starts one
independent exact-PID SDK injection for every detected `.exe` under
`steamapps`. WMI starts only if that continuous observer fails.

The two lanes may select the same PID, so a native per-PID claim serializes them
before target mutation. A path winner is adopted by the coordinator and its
exact-PID loser is disposed; an exact-PID winner makes the path attempt yield
safely. The broad watcher is rearmed after safe completion, target exit, or a
definite-safe failure; an indeterminate target mutation leaves that lane
blocked.
Observation starts before four isolated exact-PID launchers are prepared
concurrently. Detected targets wait in order for prepared slots, successful
consumption starts an immediate refill, and preparation failures retry with
bounded backoff. Each active attempt owns its staged run, private add-on,
credentials, and evidence. `runtimeMode` records whether it loaded the staged
runtime or reused a compatible host.

That initial success still missed a Windows PID-reuse defect. The watcher kept
its startup baseline as bare numeric PIDs, so a later process that reused any
baseline PID was incorrectly treated as the old process forever. A real
same-client rerun reproduced the reported intermittent no-overlay launch: Gun
Frog matched `\\steamapps\\`, but the armed injector never selected it and
ReShade was absent from the process. The watcher baseline now retains a handle
to each exact startup process object instead. A July 13 final verification kept
one Electron client alive while Gun Frog PID 19052 was launched, closed, and
relaunched as PID 22644. Both runs selected the game, loaded the D3D11
runtime/add-on, published target telemetry/FPS, and rendered the dock. On the
second run Ctrl+I opened the
intercept menu and clicking `Open status window` rendered that Electron surface
inside Gun Frog while input was captured; closing the game left another watcher
armed for the next launch.

The hybrid coordinator passed a new same-client acceptance on July 29, 2026.
One Electron process stayed alive across Gun Frog PIDs 20856 and 13068; both
targets visibly rendered the D3D11 overlay at 60 FPS. Ctrl+I received positive
and negative interception acknowledgements, clicking `Open status window` was
captured without changing the game menu, and the normal Quit click closed the
game after interception was released. The path watcher was available for the
next launch after each selection/exit. After observer-readiness and path-first
ordering hardening, one client repeated visible 60 FPS attachment, exact-PID
attempts, normal exit, and rearm for PIDs 11856 and 16892 with no leftovers.

On July 13, 2026, the inject-all flow attempted both LORT's root
`LortGame.exe` bootstrap and its
`BW\Binaries\Win64\LortGame-Win64-Shipping.exe` renderer. The bootstrap did not
initialize a graphics runtime or add-on; the Shipping process independently
initialized D3D12, loaded the API-19 Electron add-on, authenticated, published
live FPS, toggled interception, and accepted an overlay button click. This
closes executable selection for overlapping and multi-process launches. It does
not close timing: native notification and exact-PID injector spawn still happen
after process creation, so a sufficiently fast renderer can create its swap
chain before injection. The first native implementation scanned the full
process table every 5 ms and was retired after a PEAK thermal report. Its
replacement samples a compact PID array, queries paths only until they resolve,
and retains stable identities without polling process handles. Temporarily
inaccessible paths retry with bounded backoff instead of being abandoned. It
passed the tightened idle resource gate at 1.5% of one CPU core in a focused
run and 1.0% in the consolidated gate. A short July 28 PEAK rerun with the
bounded observer injected before D3D12 loaded, rendered the dock, captured
Ctrl+I, and accepted the status-window click. The observer measured 0.6% of one
core before launch and rounded to 0% in the in-game sample. PEAK's own reported
rate reached 374-396 FPS during its splash before settling near 94 FPS on the
menu. No readable temperature sensor was available, so this closes functional
PEAK acceptance for the bounded observer but is not a thermal soak.

New runs use `build/electron-game-overlay-runtime`. All dated
`build/reshade-imgui-overlay/...` paths in this document are historical
pre-promotion evidence and are intentionally retained only as records.

The first injected Gun Frog run is a recorded failed gate, not acceptance:
Electron received and rendered a full click while the same physical click also
activated Unity's underlying `Continue` control. Gun Frog uses Unity 6 with
`Unity.InputSystem.ForUI`, and `UnityPlayer.dll` enables mouse-in-pointer. The
controlled hosts reproduced the split: ReShade froze legacy/raw/polled input but
allowed `WM_POINTERUPDATE/DOWN/UP`. A pinned compatibility patch now suppresses
that `PT_MOUSE` client-pointer projection and updates ReShade's managed mouse
state. The add-on captures pointer metadata without mutating route state, then
converts primary move/left-click records into one Electron legacy stream only
after global sequence ordering on the single consumer. Native ImGui and Electron
both passed this regression on controlled D3D11 and D3D12. The subsequent Gun
Frog rerun clicked Electron directly above Unity's `Continue` control; Electron
received the complete click while the game stayed on its menu. Text, z-order
changes, and caption drag also passed. The manual release control produced the
disable acknowledgement; the next click on Continue entered gameplay, proving
normal pass-through restoration. Normal shutdown then closed the real-game
input gate.

The July 13 strengthened acceptance placed Electron controls exactly over Gun
Frog's Continue, New Game, Settings, and Quit buttons. All four emitted distinct
`HUDHOOK_CLIENT_MULTIWINDOW_INPUT ... event=gun-frog-click name=<...>` records
while Unity remained on the menu and the process stayed alive. Manual release
then emitted `RELEASE_REQUESTED`, `INTERCEPT_DISABLED`, and
`LIFECYCLE_COMPLETE`; a click at the same underlying Quit position closed Gun
Frog only after interception was disabled. This is the current exact real-game
menu acceptance boundary.

The production client/SDK gate passed the same boundary through
`libs/electron-game-overlay-runtime/scripts/test-cases/gun-frog-client-sdk.ps1`.
The
built client armed for `Gun Frog.exe` before launch, received a positive input
interception acknowledgement for PID 11104, and clicked the aligned Continue,
New Game, Settings, and Quit Electron controls once each while Gun Frog stayed
alive on its menu. Ctrl+I produced the negative acknowledgement, then the same
Quit position closed the game. The runner emitted
`GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`; evidence is retained under
the historical pre-promotion path
`build/reshade-imgui-overlay/client-Gun-Frog-20260713-005018` and
`%TEMP%/electron-game-overlay/reshade-runs/Gun-Frog.exe-yE20tq`. The persisted
client-run `result.txt` contains the same pass marker.

The controlled production client/SDK D3D12 gate passed twice through
`libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk.ps1`
against PIDs
17248 and 13528. Both Electron windows accepted text and focus, the main caption
moved and remained clickable at its new coordinates, the target stayed
foreground, and its complete input title remained byte-identical during
interception. After release, legacy down/up, raw input, and primary `PT_MOUSE`
pointer counters advanced, cursor confinement returned, and released Escape
closed each target normally. The runner force-cleaned the isolated Electron tree
between attempts, used two distinct ReShade run directories, left no test
processes, and emitted `D3D12_REAL_CLIENT_SDK_GATE_PASS`. Evidence is retained
under the historical pre-promotion path
`build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`. Current runs use
`build/electron-game-overlay-runtime`.

That controlled host uses a test-only injection-wait marker before its unusually
fast D3D12 initialization. It validates the prearmed SDK launcher and automatic
ReShade D3D12 selection for a cooperating target, not general injection timing.
Forced client cleanup plus a fresh launch is accepted here. That is distinct
from supported producer-session deactivation; clean in-process runtime/add-on
unload remains open.

The same-client gate passed through
`libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk-reinjection.ps1`.
Electron PID 17756 attached to target PIDs 19764 and 17940 in sequence. The
launcher correlated each authenticated transport with the injector-selected
PID. Socket close emitted a transient transport-loss event and retained the
injection latch; only OS-confirmed process exit emitted the terminal disconnect
that returned the SDK and frontend to `idle`. Client-originated lifecycle
messages are reserved and rejected. Outcomes after the injector may have
spawned remain `blocked` until launcher disposal when no target PID exit can be
proven. The runner emitted `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`;
evidence is retained under
the historical pre-promotion path
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`.

The historical July 13 exact-PID process-start gates passed through the real
frontend and public SDK. D3D11 targeted PID 7428, reached the frontend click
72.393 ms after process creation, and emitted
`D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623`.
D3D12 targeted PID 21508 at 84.061 ms and emitted
`D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642`.
Both proved the exact injector arguments and ReShade loading before
`ResumeThread`. Transport, API selection, two Electron windows, and input passed
after resume; both targets exited 0, both frontends returned to `idle`, and no
test process remained.

The current launchers no longer create a suspended process. They let the normal
loader finish and pause the cooperating host near entry with a test-only marker
before window/device setup. D3D11 and D3D12 passed that path on July 30, 2026;
evidence is under
`build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-084815`
and
`build/electron-game-overlay-runtime/client-sdk-d3d12-process-start-20260730-084831`.

Exact PID narrows selection but does not make post-render injection work. In a
controlled probe, the injector ran three seconds after D3D11 and D3D12 targets
were already rendering. It returned success and `ReShade64.dll` was present in
each process, but there were no graphics-API redirect, runtime-initialization,
add-on-load, or first-scene markers. The pinned runtime did not adopt the
existing device or swap chain, so this route is unsupported. Evidence is under
`build/reshade-imgui-overlay/late-injection-probe-20260713-114753`.

The native path watcher's ignore-baseline now retains exact process handles,
closing the sequential relaunch defect above. Exact-PID requests and the demo's
native lifecycle correlation still identify targets by PID plus verified
executable basename; a creation token is not yet carried end to end. Delayed
fallback WMI events across PID reuse therefore remain a lifecycle-hardening item. The suspended
gates also establish ordering, not an arbitrary safe delay for a normal running
process. Package publishing is intentionally deferred while the repository-built
client and SDK remain under local acceptance testing.

The accepted Gun Frog shutdown emitted a non-fatal ReShade warning about an
inconsistent `ID3D11Device3` reference count. The short PEAK rerun likewise
reported inconsistent D3D12 command-queue/device reference counts during normal
shutdown. Neither run crashed or invalidated its input proof. Treat these
warnings as recorded resource-retirement/unload hardening rather than
input-gate failures.

The runtime now publishes target HWND, render/client/window geometry, DPI,
monitor bounds, graphics API, state, and real injected FPS to the SDK. The
SDK's `followTarget()` layout uses that physical geometry and has simulated
cross-display/scale coverage. Real mixed-scale hardware or VM acceptance is
still outstanding. The public `fullscreen` value is a geometry-derived signal
that the client covers its monitor, not proof of DXGI exclusive-fullscreen
state. Within one target process, only the stable primary swap chain advertises
a surface and FPS stream; final primary destruction removes that identity before
a remaining valid presenter can publish its replacement.

For this project, **Steam-like** describes the behavior required inside an
explicitly supported target: passive mode leaves game input unchanged; intercept
mode keeps the Electron/ImGui overlay fully interactive, releases game cursor
confinement/recentering, prevents the game from observing the same mouse and
keyboard activity, and restores normal input on release, focus loss, transport
failure, or shutdown. It does not claim Steam's code signing, launcher ownership,
anti-cheat relationships, compatibility database, or universal game coverage.

The initial candidate envelope is Windows x64 with controlled D3D11 and D3D12
hosts, followed by permitted offline/single-player applications. These cases are
not supported by the current production runtime:

- competitive, anti-cheat-protected, protected, or otherwise restricted
  processes; no stealth or anti-cheat bypass work is in scope;
- target/runtime integrity-level mismatch or an elevated target launched from
  a lower-integrity client;
- x86 targets and VR runtimes (`reshade_overlay` is not invoked for VR);
- Vulkan, OpenGL, D3D9, unusual/exclusive presentation paths, same-HWND
  multi-swap-chain input ownership, distinct D3D12 direct queues, broader
  multi-swap-chain layouts, and simultaneous rendered targets beyond the
  completed same-listener credential-isolation and fail-closed route-selection
  tests until each has explicit graphics acceptance;
- public ReShade hosts that cannot register add-on API 18 or return the exact
  Dear ImGui function table, arbitrary coexistence with another proxy DLL, and
  real-game combinations of existing effects/foreign add-ons; the narrow paths
  described below do not imply general modded-game support;
- real physical/VM mixed-scale target-follow acceptance, texture retirement
  outside the accepted shared-device/queue multi-swap-chain boundary, or broader
  gamepad/DirectInput/XInput/GameInput handling until their recorded acceptance
  work is complete.

The narrow shared-runtime foundation requires this project's private host ABI 1
and an add-on gate that is still `OPEN`. Controlled target-local `dxgi.dll`
fixtures passed the complete production client/SDK scene, input, release, and
cleanup gates on D3D11 and D3D12 on July 30, 2026. The SDK loaded only its
privately staged add-on, did not load a second runtime, and left the existing
proxy and configuration hashes unchanged. A host whose gate has already closed
cannot accept late add-on registration safely. In existing mode the SDK's
`reshadeLogPath` is inferred beside the host module; ReShade
`[INSTALL] BasePath` can make that candidate non-authoritative.

The separate public-host path does not require the private host gate. It
attempts every detected target-local x64 ReShade identity and requires public
API 18, the exact Dear ImGui function table, and the current mapped Electron
add-on ABI/build identity. Preparation uses the target process's effective
base/add-on paths and enablement state. Only the staged
`electron_game_overlay_reshade_manager.exe` can change the reserved Electron
add-on, ownership marker, transaction journal, and verified temporary/backup
names. It never changes ReShade-owned or foreign files. Runtime hashes are used
to verify and hold the exact file across requests and transactions; they do not
allow or reject a host, and the marker's ReShade hash is ignored for
compatibility. Install/update is restart-only; if the add-on is mapped, the SDK
defers the manager retry until OS-confirmed target exit. Runtime-identity changes
do not queue removal. Only
`existing-reshade-addon-maintenance-deferred` identifies queued install/update
work; restart-required, conflict, host-incompatible, and preparation-failure
results queue nothing. Controlled preflight, transaction, and D3D11 host gates
cover this behavior. The narrow Gun Frog coexistence gate adds one real-game
combination, not broad real-game coexistence.

Before exact-PID injection mutates the target, it performs bounded loaded-module
inspection. Exact `ReShadeVersion` identifies a candidate. Missing/wrong private
ABI reports `target-runtime-incompatible`; an active/closed gate reports
`target-runtime-reuse-too-late`; a claim race reports
`target-runtime-reuse-raced`; and unsafe module inspection reports
`target-module-inspection-failed`. These include a stable no-payload-load proof
and are `definite-safe`. The reuse-race result can follow bounded remote loader
creation, but its CAS loses before environment mutation or `LoadLibrary`.
`existing-runtime-addon-load-failed` occurs after the gate was claimed, is
`indeterminate`, and keeps the launcher blocked. The SDK continues to parse
legacy `target-runtime-conflict` records, but the current native injector does
not emit that generic outcome.

Module basenames and files beside the game executable are deliberately not
conflict evidence. A file named `dxgi.dll`, `dinput8.dll`, `ReShade.ini`, or
similarly does not prove which code is loaded and therefore is not an automatic
block condition. This avoids executable-specific filename heuristics while
leaving arbitrary runtime/proxy coexistence explicitly unsupported. Supported
paths either reuse the compatible private host or attempt the API-18 add-on in
the detected target-local x64 ReShade host; capability-incompatible public
hosts fail closed, and neither path tries to load two ReShade runtimes into one
process.

Unsupported or untested must produce a clear diagnostic rather than silently
claiming compatibility. Maintain a matrix per target with architecture,
integrity level, graphics API, presentation mode, runtime load result, overlay
input result, game-input suppression result, and required workaround.

ReShade's managed ImGui context samples button and key state once per `Present`.
The Electron path does not rely on that sample: a pinned passive full-add-on
observer copies already-blocked records into the project-owned bounded queue.
Exact legacy window-message delivery and ordered primary `PT_MOUSE`
`WM_POINTER` move/left-click translation are accepted on D3D11 and D3D12.
Captured Ctrl/Shift state is preserved. Copied `WM_INPUT` and
`GetRawInputBuffer` records are currently retained/countable but are not yet
normalized into Electron events. Touch/pen, secondary/X pointer buttons,
double-click semantics, pointer wheel, concurrent input pumps, same-HWND
swap-chain ownership, distinct D3D12 queues, and raw-only input/text therefore
remain explicit runtime hardening. Same-HWND support specifically needs a pinned
ReShade input-handler owner-promotion/clear patch; the public add-on API cannot
safely perform that transfer during teardown.

Target FPS is process-scoped and sampled only from the stable primary swap chain.
The accepted bounded policy uses the first valid presenter, preserves ownership
through resize, and promotes a remaining presenter only after final primary
destruction. Production client/SDK gates pass this for distinct HWNDs sharing one
D3D11 device/context or one D3D12 device/direct queue, including primary-only
composition, input blocking/interaction on both owners, replacement surface/FPS
telemetry, and no process disconnect. Evidence is under
`client-sdk-d3d11-multi-swapchain-20260801-103555` and
`client-sdk-d3d12-multi-swapchain-20260801-103532` below the runtime build root.

On final swap-chain destruction, the last transport reference waits up to 250 ms
for the explicit surface-removal revision and all earlier packets to be written
to the current socket before destroying the bridge. D3D11 and D3D12 controlled
gates prove that the public SDK clears its target surface while the target
process, HWND, Electron producer, and attachment remain alive. A drain timeout
or disconnect is reported without making graphics teardown unbounded.

#### Overlay runtime issues to fix

- [x] Reassert Chromium page focus before forwarding input to an offscreen overlay.
  - Root cause: Electron 16's offscreen `WebContents.focus()` path is a no-op and its OSR view reports itself unfocused. Calling it before `webContents.sendInputEvent(...)` did not focus Chromium's render widget.
  - Resolution: `OverlaySession` now calls `BrowserWindow.focusOnWebView()` immediately before every forwarded packet. This is the Electron 16 OSR-specific page-focus path and does not activate the hidden native window or take foreground ownership from the game.
- [ ] Overlay compatibility is not universal across all games.
  - Source / likely cause: the production ReShade runtime proves controlled
    D3D11 and D3D12, but that does not establish every graphics API,
    presentation path, or launch timing a game can use, such as Vulkan, OpenGL,
    unusual swap-chain modes, exclusive fullscreen behavior, deferred same-HWND
    or distinct-queue multi-swap-chain layouts, protected/anti-cheat processes,
    elevated integrity processes, or arbitrary fast-start D3D12 games. Steam
    Overlay can appear universal because
    Steam owns the launcher/runtime integration, has broad backend support, and
    can carry a large compatibility database and per-game handling over time.
  - Current direction: let ReShade own the maintained graphics/input host rather than expanding private hudhook detours. Expose runtime and hook status through the SDK, fail clearly for unsupported or partially hooked targets, and add backends/presentation modes only with explicit acceptance evidence. Keep the compatibility matrix described above.

#### Origin overlay and Steam overlay

It can work together with Steam overlay, but unfortunately did not work with Origin overlay.

The coexistence statement and game list below describe the legacy overlay runtime
and are not compatibility claims for the active ReShade client host.

#### Games that I played and tested

Some of the games can use multiple versions of graphics API, make sure set graphics api to one of dx9, dx10, dx11

- [x] League of Legends
- [x] Dota 2
- [x] CS:GO
- [x] Team Fortress 2
- [x] Life Is Strange
- [x] Ori
- [x] GTA 5
- [x] Fallout 4
- [x] Rise Of The Tomb Raider
- [x] Guts and Glory
- [x] PlayerUnknown's Battlegrounds
- [x] Life is Strange Before the Storm
- [x] Child of Light
- [x] Borderlands 2
- [x] Cuphead
- [x] Witcher 3
- [x] WORLD OF FINAL FANTASY®
- [x] Left 4 Dead 2
- [x] Tom Clancy's The Division
- [x] Tom Clancy's Rainbow Six Siege
- [x] Half-Life 2

#### games that have issues for now

- [ ] Battlefield 1
- [ ] Star Wars battlefront 2
