# Electron game overlay Windows runtime

This production Windows x64 package uses the ReShade 6.7.3 full add-on runtime
as the native process-entry, graphics-hook, swap-chain, input, logging, and
Dear ImGui layer. It builds the injector, controlled hosts, and
`electron_game_overlay.addon64`. The historical hudhook payload is not part of
the production SDK build or staged runtime.

The original baseline proved two things inside the target render path:

- an always-visible Dear ImGui diagnostics panel can be rendered while the main ReShade menu is closed;
- a generated RGBA bitmap can be uploaded through ReShade's graphics-agnostic resource API and drawn with `ImGui::Image`.

The current implementation adds controlled D3D11 and D3D12 input-gate hosts and
connects the real multi-window Electron scene on both backends. ReShade's public
`effect_runtime::block_input_next_frame()` remains the sole game-side blocking
authority. A narrow pinned full-add-on observer copies input only after ReShade
has decided to suppress it, allowing the project router to deliver the exact
legacy Win32 records to Electron without a second suppression hook. An
independent host oracle counts window messages, raw input, polling-visible
left-button state, Windows pointer messages, cursor movement, and cursor
confinement. A second narrow patch closes ReShade's `WM_POINTER` gap for
mouse-in-pointer applications. It restricts the new classification to `PT_MOUSE`
and updates ReShade's managed mouse state for native ImGui. The add-on snapshots
pointer metadata at the callback and, only after global sequence ordering on the
single consumer, turns primary move/left-click records into the same Electron
legacy route.

Exact-PID SDK attachment uses a run-local rendezvous boundary. The injected
transport prefers `ELECTRON_GAME_OVERLAY_RUN_DIRECTORY`; newly injected runtime
mode also sets ReShade's base-path override to that run, while compatible
existing-runtime mode deliberately leaves the host's configuration and log base
path unchanged. Each consumed staged run receives a unique producer token bound
to its expected PID before injection. The producer writes
`electron-overlay-transport-v1.targeted` first, then the adjacent discovery
record. The injected client treats that marker as persistent route intent: a
missing, invalid, or revoked local credential fails closed instead of falling
back to the global producer.

The launcher retains the authorization while the target remains live. A
confirmed terminal exit, launcher disposal, or session shutdown removes the
credential record but leaves the marker for a payload that may initialize late;
removing the staged run directory removes both. Rust unit coverage exercises legacy
fallback before route intent, fail-closed marker and invalid-local selection,
and reconnect selection after local credential deletion. End-to-end scoped
socket-loss acceptance remains follow-up coverage. This is not a hostile
same-user security boundary because peer processes with the user's file access
can inspect or replace discovery files.

The controlled hosts are intentionally plain and owned by this repository. Use
them before trying any external application.

## Safety boundary

Use this only with the included hosts or an offline/single-player application you
are allowed to modify. ReShade's unsigned full add-on build is intentionally not
anti-cheat allowlisted. Do not load this runtime in competitive or
anti-cheat-protected software, and do not use it to bypass anti-cheat controls.
Steam-like refers to the overlay's interaction behavior within the supported
target envelope; it does not claim Steam's signing, launcher ownership,
anti-cheat relationships, or per-game compatibility database.

New builds and test evidence are written under
`build/electron-game-overlay-runtime`. Every dated
`build/reshade-imgui-overlay/...` path below is historical acceptance evidence
created before this runtime was promoted from `poc` and renamed. Those paths are
preserved as records, not as current build instructions.

## Build

Requirements:

- Windows 10 or newer;
- Visual Studio 2022 with the Desktop development with C++ workload;
- CMake 3.24 or newer;
- Git;
- an internet connection for the first configure, which fetches the pinned ReShade and ImGui headers.

From a Visual Studio Developer PowerShell opened at the repository root:

```powershell
npx nx build electron-game-overlay-runtime
```

That target builds the transport dependency, pinned ReShade runtime/injector,
production add-on, and ABI smoke. To configure only the native controlled-host
tree directly:

```powershell
Push-Location libs/electron-game-overlay-runtime
cmake --preset vs2022-x64
cmake --build --preset relwithdebinfo
Pop-Location
```

The build pins:

- ReShade `v6.7.3` and its add-on API headers;
- Dear ImGui `v1.92.5-docking`, the exact ABI version expected by that ReShade release.

No ReShade or ImGui source is checked into version control. The first configure
downloads both into the ignored build directory, then applies fourteen production
patches to the pinned ReShade revision:

- `reshade-input-observer.patch` advances the local full-add-on ABI to API 19
  and exposes a passive copied-input event after ReShade decides to block;
- `reshade-injector-base-path.patch` keeps injected configuration, add-ons, and
  logs in the isolated injector stage and removes the startup delay that missed
  early Unity swap-chain creation;
- `reshade-pointer-input-block.patch` classifies client `PT_MOUSE`
  `WM_POINTER` messages as blockable input and updates ReShade's managed cursor,
  five-button, and vertical-wheel state before suppression. Touch, pen,
  non-client pointer activation, and title-bar handling remain outside the seam.
- `reshade-injector-exact-pid.patch` adds strict `--pid <uint32>` targeting,
  verifies the opened process image basename before remote mutation, and emits a
  stable safe-retry marker when no remote injection thread was created.
- `reshade-injector-path-watcher.patch` adds a one-shot prelaunch watcher for
  normalized, case-insensitive executable-path fragments. It ignores processes
  already present when armed and accepts repeatable executable-basename
  exclusions for helper processes before selecting a target.
- `reshade-injector-path-watcher-process-identity.patch` keys that startup
  baseline by PID plus a retained process handle. Exited process objects are
  removed promptly, so Windows PID reuse cannot make a newly launched game look
  like an old process that should be ignored. The watcher polls every 50 ms and
  does not reopen every baseline process on each pass.
- `reshade-injector-persistent-path-observer.patch` adds a parent-scoped,
  non-injecting observer that reports every executable path match through a
  strict UTF-8 creation/deletion protocol while remaining armed. It samples one
  compact PID array every 5 ms with `EnumProcesses` and queries executable paths
  only until each process is resolved. This
  replaced the original full Toolhelp snapshot and all-process handle scan,
  which consumed about 25% of one CPU core in a local idle measurement.
- `reshade-injector-resilient-path-observer.patch` retains a lightweight handle
  for every queryable process identity without polling those handles, preventing
  PID reuse between enumeration passes. Temporarily inaccessible paths remain
  unresolved and retry with bounded backoff until the exact process exits.
- `reshade-injector-conflict-preflight.patch` inspects bounded remote PE export
  tables before any target allocation, write, or remote thread. A loaded module
  exporting exact `ReShadeVersion` is identified using the same identity as
  ReShade's duplicate-instance guard; proxy filenames and unloaded files beside
  the game are not guessed. Failures emit a versioned one-line
  `ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC` JSON record and retain the legacy
  no-injection marker.
- `reshade-injector-per-pid-claim.patch` lets overlapping prearmed-path and
  exact-PID launchers coordinate through one native target claim before either
  mutates the process.
- `reshade-shared-runtime-host.patch` gives this repository's runtime a private
  host ABI and a short pre-initialization registration gate. The injector can
  reuse that exact compatible runtime and load only the staged Electron add-on;
  unknown, incompatible, or already-active ReShade instances fail closed.
- `reshade-injector-export-read-bounds.patch` bounds remote export-name reads to
  the requested symbol length while inspecting a candidate runtime.
- `reshade-shared-runtime-hardening.patch` closes the registration gate before
  add-on dispatch begins, uses a bounded x64 loader thunk, and makes gate races
  fail closed without spinning a CPU core.
- `reshade-suppress-splash.patch` suppresses ReShade's branded startup window
  because the embedding application owns startup UI. It leaves the full GUI
  pipeline, add-on callbacks, version metadata, `UNOFFICIAL` build identity,
  and the non-branded spinner for later explicit effect reloads intact.

Use the runtime built by this repository with the Electron add-on; the stock
API-18 ReShade 6.7.3 runtime is ABI-incompatible.

ReShade's API headers are BSD-3-Clause/MIT dual-licensed and Dear ImGui is
MIT-licensed. Preserve their notices if compiled binaries are redistributed.
The helper builds the pinned ReShade runtime and x64 injector only into the
ignored local build directory; it does not run the injector. Do not commit or
redistribute those binaries.

To build the pinned ReShade full-add-on runtime explicitly:

```powershell
.\libs\electron-game-overlay-runtime\scripts\build-reshade-runtime.ps1
```

The launchers validate the cache against a schema-17 build stamp, the fourteen
production-patch SHA-256 hashes, the pinned commit, exact normalized contents of
all nine patched source files, the full-add-on configuration, and the
runtime/injector SHA-256 hashes. CMake performs the same commit, nine-path, and
normalized-content check
independently for every fetched source tree before generating native targets.
Extra edits inside an expected fetched-source file invalidate the build.

## Run the controlled input gates

Each human-facing backend has its own launcher:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-native-input-gate.ps1
```

The launchers build the host and add-on, build or reuse the pinned local ReShade
runtime, and create an isolated directory under
`build/electron-game-overlay-runtime/input-gate-d3d11` or
`input-gate-d3d12`. D3D11 stages the runtime as `d3d11.dll`; D3D12 stages it as
`dxgi.dll`. Both stage `ReShade.ini` with `[INPUT] InputProcessing=2`, the add-on,
and the `reshade-input-gate.enabled` marker that enables the controlled host
oracle. The parameterized `scripts/run-input-gate.ps1` runner remains available
for automation and supports `-NoLaunch`.

To reproduce visible acceptance for either backend:

1. In pass-through mode, move, click, wheel, and press keys. The `game input`
   counters, including `ptr=update/down/up`, in the host title should advance and `clip=on` should describe the
   host's deliberately hostile cursor confinement.
2. Press **Ctrl+I** once. The add-on should report `Input: RESHADE-OWNED`; this
   label is requested state, not by itself proof that the gate passed. The
   activating chord is detected at `Present`, so exclude that chord from the
   steady-state counter sample; production uses the Electron-owned global
   shortcut and sends desired state to the add-on instead.
3. Move over the ImGui panel and click `CLICK RE SHADE INPUT PROBE`. The probe
   count must increase, the visible pointer must remain usable, the host's
   message/raw/polling/pointer counters must stop advancing, and the title must
   report `clip=off`.
4. Type into `Keyboard probe`, drag `Drag probe`, wheel over the panel, and move
   the cursor while interception stays active. The overlay controls/counters must
   react while none becomes new game-side oracle activity.
5. Resize the host while interception is active. The panel must remain
   `RESHADE-OWNED`, input must remain blocked, and the controls must still work.
6. Press **Ctrl+I** again. Pass-through counters and host cursor confinement must
   resume. Press **Escape** to close the host normally.

A backend fails acceptance if the overlay cannot be operated, if any game-side
counter reacts to intercepted input, if cursor confinement remains active, or if
release/shutdown does not restore normal input.

### Accepted results: July 12, 2026

Both controlled backends passed. The values below are the game-side oracle
baselines captured after activation; each remained exactly frozen while the
ReShade log recorded an ImGui button click, keyboard text edit, drag update, and
wheel update:

- D3D11: `move=5`, `down=0`, `up=0`, `wheel=0`, `key=2`, `raw=4`,
  `poll-left=0`, `cursor-change=0`, `clip=off`.
- D3D12: `move=15`, `down=2`, `up=2`, `wheel=1`, `key=3`, `raw=15`,
  `poll-left=2`, `cursor-change=2`, `clip=off`.

For both backends, resizing from 1280 x 720 to 1920 x 1009 preserved
interception and a post-resize ImGui click succeeded. Releasing interception
restored the hostile host's cursor confinement and its game-side counters
resumed.

The later mouse-in-pointer regression repeated both the native ImGui gate and the
real Electron scene on both backends. Native button, text, drag, and vertical
wheel controls remained interactive. Electron logged ordered
down/focus/drag/up/click packets while every game-side counter remained frozen,
including `raw`, `poll-left`, and `ptr`. Releasing interception resumed all
legacy/raw/pointer/polling/cursor counters and cursor confinement. This is the
controlled proof for the Unity-style second mouse projection.

ReShade's managed ImGui context samples button and key state once per `Present`.
Human-duration clicks, typing, dragging, and wheel input passed this controlled
gate. An exact input edge that begins and ends entirely between two presentations
is a different delivery contract: preserving those fast edges for Electron is
the responsibility of the project-owned queued input path retained from the
hudhook POC, not the managed ImGui sample alone.

The texture baseline is part of both isolated input gates: the panel identifies
the graphics API and displays the generated teal checkerboard below the input
controls. If the panel does not appear, inspect `ReShade.log` in that backend's
staged input-gate directory.

## Production Electron compositor

The backend-neutral transport, ordered scene, and input router live in the
sibling `../electron-overlay-transport` Nx package. The production build links
its versioned C ABI into the Electron ReShade add-on, while the native input-gate
add-on remains independent of Cargo:

```powershell
Push-Location libs/electron-game-overlay-runtime
cmake --preset vs2022-x64-production
cmake --build --preset relwithdebinfo-production
ctest --preset electron-overlay-transport
Pop-Location
```

The ABI smoke validates layout, version rejection, immutable scene ownership,
input-state metadata, the fixed runtime-diagnostic record, and
create/acquire/release/destroy linkage. Runtime diagnostics use a dedicated
bounded queue of 32 records and carry no free-form text, paths, handles, or
producer-supplied PID. The add-on reports transport, swap-chain, and first-scene
milestones plus guarded scene/frame/upload/input failures. It never publishes
from `DllMain` or the input producer callback; input observations are emitted
only by the ordered render-thread consumer. Failure codes have a native
7.5-second per-code cooldown before the additional Node-side rate limit.

Before authenticated IPC exists, the Rust bridge atomically preserves its last
fixed startup state in
`.electron-game-overlay-runtime-startup.json` inside the isolated SDK run
directory. The bounded record contains only schema version, fixed source, target
PID, and an allowlisted code covering bridge creation, discovery validation,
target binding, loopback setup, worker startup, or pre-authentication
disconnect. The SDK validates that exact schema and PID when connection proof
times out; it never parses or forwards free-form `ReShade.log` lines. Failures
that occur before the add-on reaches the transport bridge, including add-on
registration or graphics-hook initialization, still require the local
`ReShade.log`.

The generated `electron_game_overlay.addon64` has completed controlled D3D11
and D3D12 live-producer runs: it connected the existing authenticated Node
transport, uploaded two overlapping real Electron OSR windows, rendered the
transported scene, and returned the interception acknowledgement. ReShade-owned exact
legacy mouse/keyboard records, plus the primary `PT_MOUSE` `WM_POINTER` stream
normalized on the ordered single consumer, then drove click-to-front, text
focus/input, and caption dragging while every host mouse, keyboard, raw, pointer,
polling, cursor, and confinement counter remained frozen.

Run each human-facing case with its dedicated script:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-electron-scene.ps1
```

Each launcher builds and stages the pinned runtime, add-on, controlled host, and
headless Electron producer. Drag either striped caption and click/type into the
transported fields. Interception is requested automatically; close the host
with its title-bar X when finished. Manual multi-window scenes also expose a
`Release input` button on the BACK window for the inverse pass-through check;
after using it, restart the case to intercept again. Producer evidence is written beside
`ReShade.log` under a timestamped
`build/electron-game-overlay-runtime/electron-scene-d3d11-*` or
`electron-scene-d3d12-*` directory, so a staging-only run cannot erase accepted
evidence. The parameterized `scripts/run-electron-scene.ps1` remains available
for automation and supports `-NoLaunch`.

## Run the production client/SDK D3D12 gate

Use the dedicated controlled production-client wrapper:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
```

It builds the real client, public SDK runtime, add-on, injector, and controlled
D3D12 host. For each of two attempts it starts a fresh client with isolated user
data, arms the SDK launcher by executable basename, starts the host, and verifies
the exact connected PID and path. The runner requires a D3D12 command queue, the
transported two-window scene, and a positive interception acknowledgement before
driving the status and main text fields. It also sends intercepted Escape, drags
the main caption, clicks the field at its moved coordinates, and requires the
target to remain foreground with its complete title oracle byte-identical.

After the negative interception acknowledgement, a released click must advance
the host's legacy down/up, raw-input, and primary `PT_MOUSE` pointer counters and
restore cursor confinement. Released Escape must then close the host normally.
The runner force-cleans only that attempt's isolated Electron process tree,
requires no host/client/injector leftovers, relaunches with a distinct ReShade
run directory, and emits `D3D12_REAL_CLIENT_SDK_GATE_PASS` only after both cycles
pass.

The gate passed on July 13, 2026 against target PIDs 17248 and 13528. Evidence is
preserved under
`build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`; its root
`result.txt` contains `D3D12_REAL_CLIENT_SDK_GATE_PASS`, while the two attempt
directories retain client logs, exact ReShade run-directory records, and
per-attempt pass markers.

The copied host has a test-only `reshade-injection-wait.enabled` marker. It gives
the prearmed injector a bounded opportunity to load ReShade and install its
graphics hooks before this deliberately fast controlled host creates D3D12. This
proves the production client/public SDK path and ReShade's D3D12 selection for a
cooperating target; it does not prove late injection or arbitrary fast-start
D3D12 game timing. Client cleanup in this gate is forced teardown followed by a
fresh launch, not graceful runtime disable/unload.

## Run the same-client restart/reinjection gate

Use the dedicated frontend-driven wrapper:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
```

This gate keeps one production Electron client and overlay session alive. It
enters the target basename and clicks the real frontend Inject control, starts a
controlled D3D12 target, and verifies its selected PID, two-window scene, normal
exit, authoritative OS-confirmed disconnect marker, SDK/frontend `idle` state,
and enabled Inject control. It then repeats attachment through the frontend with
a new target and adds the full input interception/release proof before closing
that target. The two cycles must use distinct target PIDs and isolated ReShade
run directories.

The gate passed on July 13, 2026 with Electron PID 17756 and target PIDs 19764
then 17940. Both frontend actions disabled Inject synchronously; both exits
returned to `idle`; the second scene accepted main/status input and preserved
the game-side interception oracle. Evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`, whose
`result.txt` contains `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`.

## Run the exact-PID process-start gates

Use the dedicated production-client wrappers for the near-process-creation
ordering:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-process-start-injection.ps1
```

The public SDK accepts `attach(session, { processName, pid })`, and the Electron
demo exposes the optional PID beside the process basename. Each current gate
starts its controlled target normally, captures that exact PID after normal
loader work, and blocks the cooperating host near entry at a test marker before
window and graphics-device setup. It enters the PID and basename in the real
frontend, proves that injection completed, then removes the marker and runs the
full scene/input/release checks. This models a normal process that has started
but has not created its graphics device; it does not manufacture a universal
latency budget for an external watcher or arbitrary game startup.

Both current gates passed on July 30, 2026:

- D3D11 evidence is under
  `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-084815`.
- D3D12 evidence is under
  `build/electron-game-overlay-runtime/client-sdk-d3d12-process-start-20260730-084831`.

The fixed pre-authentication startup-record extension re-ran both gates later
that day. D3D11 and D3D12 each preserved a matching target PID with final code
`network-worker-started`; evidence is under
`client-sdk-d3d11-process-start-20260730-131543` and
`client-sdk-d3d12-process-start-20260730-125958` in the same build root. The
different compatible-host environment handoff passed the same requirement under
`client-sdk-d3d11-shared-runtime-20260730-130358` and
`client-sdk-d3d12-shared-runtime-20260730-130412`.

The strict authenticated-input extension re-ran the injected-runtime gates.
Both accepted their production tagged `game.input` stream, forwarded intercepted
Escape to Electron while the host remained alive, and completed with no
`target-packet-rejected` diagnostic. Evidence is under
`client-sdk-d3d11-process-start-20260730-134210` and
`client-sdk-d3d12-process-start-20260730-134224`.

Each `result.txt` contains its
`D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS` or
`D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS` marker. The earlier
July 13 `CREATE_SUSPENDED` runs remain historical ordering evidence under the
old `build/reshade-imgui-overlay` paths; they are no longer the behavior of
these launchers.

This is not post-render attachment. A separate probe waited three seconds after
the controlled D3D11 and D3D12 targets began rendering. The injector returned
success and `ReShade64.dll` loaded, but the pinned runtime did not redirect the
active graphics API, adopt the existing device or swap chain, load the add-on,
or render the Electron scene. That route is unsupported. Probe evidence is under
`build/reshade-imgui-overlay/late-injection-probe-20260713-114753`.

## Run the compatible shared-runtime gates

Use the shared-runtime variants to model a game that already loads this
project's compatible ReShade build as a target-local DXGI proxy:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-shared-runtime.ps1
```

The fixture starts normally with a target-local `dxgi.dll` and `ReShade.ini`,
waits for private host ABI 1 with its add-on gate still open, and holds device
creation behind the same test marker. The production client and public SDK then
load only the privately staged `electron_game_overlay.addon64` into that host.
The gate proves that no second ReShade runtime is loaded, no add-on is copied
beside the game, the target proxy and configuration hashes remain unchanged,
and the normal two-window scene, interception, release, and cleanup contract
still passes.

Both gates passed on July 30, 2026. Evidence is under
`build/electron-game-overlay-runtime/client-sdk-d3d11-shared-runtime-20260730-084016`
and
`build/electron-game-overlay-runtime/client-sdk-d3d12-shared-runtime-20260730-084003`.
This is deliberately narrower than general modded-game support: stock or
differently patched ReShade, a compatible host whose gate has already closed,
unknown proxy DLLs, and arbitrary real-game startup timing still fail closed or
remain unsupported.

For existing-runtime results, the SDK currently infers `reshadeLogPath` as
`ReShade.log` beside the loaded host module. ReShade `[INSTALL] BasePath` can
redirect the authoritative host log elsewhere; resolving that configured path
is retained as compatibility hardening.

## Run the real client/SDK Gun Frog gate

Use the dedicated production-client acceptance wrapper:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk.ps1
```

It builds the real client and SDK, starts the SDK-owned ReShade launcher for the
`Gun Frog.exe` process name, waits until the injector is armed, and only then
launches the Steam game. The runner requires a positive interception
acknowledgement and the rendered real-client scene before interaction. Click the
aligned Electron Continue, New Game, Settings, and Quit controls once each, keep
Gun Frog alive on its menu, press Ctrl+I to release, and click the identical Quit
position again. The final click must close Gun Frog and the runner must emit
`GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`.

For a hands-on equivalent, run `npm run dev:gun-frog`, wait for the ReShade
injector to arm, and then launch Gun Frog yourself. Both paths are explicitly
process-name, arm-before-launch tests; they do not prove late injection.

This real client/SDK gate passed on July 13, 2026 against PID 11104. All four
unique Electron click markers occurred between the positive and negative input
acknowledgements; Gun Frog stayed alive on its menu until Ctrl+I released input,
then the same Quit coordinate closed it. Evidence is preserved under
`build/reshade-imgui-overlay/client-Gun-Frog-20260713-005018` and
`%TEMP%/electron-game-overlay/reshade-runs/Gun-Frog.exe-yE20tq`. The persisted
client-run `result.txt` contains `GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`.

## Run the Gun Frog acceptance gate

The earlier standalone-producer Gun Frog gate remains available separately:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-electron-scene.ps1
```

It builds and stages the pinned runtime, the repository-patched ReShade x64
injector from that same revision, the add-on, configuration, and Electron
producer in a timestamped ignored directory. It arms
the injector before launching the Steam app, waits for the exact two-window scene
and interception acknowledgement, and preserves all logs. It never copies a
proxy into the game directory and fails if a new game-directory `ReShade.log`
appears. The script does not accept Steam account/session prompts; make that
choice yourself and keep Gun Frog focused. Once ready:

1. Confirm the four colored Electron buttons exactly cover Gun Frog's Continue,
   New Game, Settings, and Quit controls.
2. Click each Electron button once while interception is enabled. The game must
   remain on the menu and alive through all four clicks. The producer log must
   contain one unique `HUDHOOK_CLIENT_MULTIWINDOW_INPUT` record with
   `event=gun-frog-click` and
   `name=<continue|new-game|settings|quit>` for each.
3. Click the Electron `Release input` control and confirm
   `HUDHOOK_CLIENT_MULTIWINDOW_RELEASE_REQUESTED`,
   `HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_DISABLED`, and
   `HUDHOOK_CLIENT_MULTIWINDOW_LIFECYCLE_COMPLETE` in the producer log.
4. Click the same underlying Quit position again. With interception released,
   that click must reach Gun Frog and close its process.

Use `-NoLaunch` to stage only.

This gate passed on July 12, 2026. The first run had failed because clicking
Electron also activated Unity's underlying `Continue` control. After the
`PT_MOUSE` compatibility patch, the accepted rerun clicked an Electron BACK
button directly over that same game control: Electron logged its full
down/drag/up/click route while Gun Frog remained on the menu. Both transported
windows accepted focus and text, front/back raising worked, caption dragging
moved one window, and the two-window scene stayed rendered. A manual Electron
`Release input` control received the complete intercepted click, ReShade
acknowledged `INTERCEPT_DISABLED`, and the next physical click activated Gun
Frog's Continue control and entered gameplay, proving pass-through restoration.
Normal close then shut the game down. No target-directory `ReShade.log`, input
ordering fault, or router reset was produced.

The strengthened four-control acceptance passed on July 13, 2026. The Electron
buttons exactly covered Continue, New Game, Settings, and Quit; every click
emitted its unique `gun-frog-click` name while Gun Frog stayed on the menu and
its process remained alive. Manual release emitted `RELEASE_REQUESTED`,
`INTERCEPT_DISABLED`, and `LIFECYCLE_COMPLETE`. Clicking the same underlying
Quit position after release then closed Gun Frog, completing the inverse
pass-through proof. The real production client/SDK gate above subsequently
closed the host-switch milestone for this accepted target path.

## What this does not prove yet

- normalized delivery of copied `WM_INPUT`/`GetRawInputBuffer` records to
  Electron (the bounded queue retains and counts them, but legacy Win32 delivery
  is accepted on D3D11 and D3D12 today);
- secondary/X-button, double-click, and wheel translation from `WM_POINTER` (the
  accepted Electron route covers primary mouse move/left click and preserves
  captured Ctrl/Shift state); touch and pen remain unconverted and fail open to
  the target;
- multiple-swap-chain/render-queue ownership and safe texture retirement;
- graceful client disable/unload, post-render injection or existing-device/
  swap-chain adoption, arbitrary stock/differently patched ReShade and proxy
  coexistence, deterministic pre-entry injection, additional games, or broader
  graphics/presentation compatibility;
- end-to-end process identity beyond exact PID plus verified executable
  basename for exact-PID requests and fallback-WMI lifecycle correlation; the
  prearmed path-watcher baseline itself now retains handles for exact process
  objects;
- anti-cheat compatibility;
- VR rendering (`reshade_overlay` is not called for VR runtimes).

The promoted runtime includes the production client/SDK Gun Frog gate, the
two-cycle fresh-client D3D12 gate, and same-client target
restart/reinjection. An initial PEAK D3D12 fast-start run rendered the overlay,
but the observer used in that run was retired after a thermal report exposed
its excessive full-system polling. A short July 28, 2026 rerun with the bounded
PID observer injected before D3D12 loaded, rendered the Electron dock, captured
Ctrl+I, and accepted the status-window click. The observer measured 0.6% of one
CPU core before launch and rounded to 0% during the in-game sample. A readable
temperature sensor was unavailable, so that run establishes functional and
process-resource acceptance rather than a thermal soak.
Exact-PID near-process-creation support is implemented and has dedicated
normal-start/pre-device D3D11/D3D12 gates with passing acceptance. Raw normalization,
graceful disable/unload, post-render attachment, arbitrary watcher latency,
end-to-end process-creation correlation beyond the native watcher baseline,
other games and APIs, and multiple-swap-chain hardening stay outside the
accepted boundary. Package publishing is deferred
while repository-local SDK/client testing continues. ReShade replaces the
injected host, graphics lifecycle, ImGui ownership, and game-side input blocking
rather than the Electron SDK contract.
