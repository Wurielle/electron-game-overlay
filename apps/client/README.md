# Electron game overlay client

## SDK demo client

From the repository root, run:

```powershell
npm run build
```

On Windows x64 this first builds the `electron-game-overlay` SDK and stages its
pinned patched x64/x86 ReShade runtimes, injectors, add-ons, native target-local
ReShade managers, configuration, and build stamps, then builds
this demo client. The relevant output is:

```text
apps/client/dist/main/main.js
apps/client/dist/process-watcher/index.cjs
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/inject.exe
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/inject32.exe
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade64.dll
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade32.dll
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade64.build.json
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade32.build.json
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay.addon64
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay.addon32
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay_reshade_manager.exe
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay_reshade_manager32.exe
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay_runtime.build.json
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay_runtime32.build.json
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade.ini
```

The native sources live in the Nx projects `electron-overlay-transport` and
`electron-game-overlay-runtime`. This application contains no native host code;
it exists to exercise the public SDK.

The native build requires Rust, CMake, Git, and Visual Studio 2022 C++ Build
Tools. The SDK uses the locked Rust transport engine and a pinned locally
patched ReShade 6.7.3 runtime when it must inject its own host. When any
target-local x64 ReShade identity is detected, the same staged add-on is
attempted there instead. The public-host route has no version/hash allowlist:
the add-on must register through public API 18 and obtain its exact Dear ImGui
function table. The existing installation is always preserved, and clean
targets continue to use the project-patched injected host.

Install Rust through rustup with both transport targets before building:

```powershell
rustup target add --toolchain stable x86_64-pc-windows-msvc i686-pc-windows-msvc
```

The normal client uses the SDK's ReShade launcher. ReShade selects the graphics
API inside the target, so there is no graphics-backend client option:

```powershell
npm run dev
```

The normal development command starts a hybrid Steam auto-attach coordinator.
Start the demo first, let its session and watcher come up, then launch a game
normally through Steam. One broad native path watcher is already armed for
`\\steamapps\\` before the game starts, providing the earliest practical
injection lane with zero executable exclusions. In parallel, every detected
executable whose normalized path contains `/steamapps/` (case-insensitive)
receives its own exact-PID SDK injection attempt. Attempts run independently and
concurrently: launchers, render processes, helpers, and redistributables are not
classified or excluded. A process that initializes the overlay authenticates
normally; one that does not initialize graphics cannot consume or prevent later
attempts. The UI shows watcher and per-PID target status and disables manual
injection controls while automatic mode is active.

Inside the game, the normal demo initially registers one compact control dock.
It remains visible with the **Ctrl+I** shortcut, target/watcher state, effective
input state, injected graphics API/render resolution, and real render-process
FPS. Press **Ctrl+I** to request interception and expand the dock into a
clickable launcher for four representative Electron surfaces:

- a target-following input playground that fills the reported render surface;
- a compact FPS/input diagnostic strip;
- independent transparent popup windows;
- a singleton video surface.

Launcher buttons remain disabled until the injected runtime acknowledges that
input interception is effective, so test windows cannot be launched before
overlay input ownership is confirmed. Press **Ctrl+I** again, or use **Release
input**, to collapse the menu and return input to the game. The presentation
dock is enabled by
`--demo-presentation`, which `npm run dev` supplies automatically.

The demo also retains the latest typed `session.on("diagnostic")` observation.
Warnings and errors replace the dock hint until another diagnostic arrives or a
new target authenticates. Every observation is labeled and logged with its
source, severity, code, and authoritative PID when one exists. The SDK
canonicalizes and bounds the records; the current loopback transport supplies
fixed redacted messages and never includes discovery tokens, raw packets,
executable paths, stacks, or arbitrary remote error text.

Every ReShade-enabled demo invocation also writes a compatibility evidence run
under Electron's application log directory in `compatibility-runs`. Startup
prints `ELECTRON_GAME_OVERLAY_COMPATIBILITY_RUN_STARTED` with the absolute
`.events.jsonl` and `.summary.json` paths. The JSONL file is updated while the
client runs; orderly client shutdown appends `run.finished` and finalizes the
summary. Set `ELECTRON_GAME_OVERLAY_COMPATIBILITY_RUNS_DIR` to an absolute
directory to override the location.
At the next startup, completed evidence is retained for at most 14 days, 32
runs, and 100 MiB. Active, interrupted, malformed, and unfamiliar files are
preserved rather than guessed safe to delete.

Evidence is split into independent per-PID lifetimes and records watcher,
attachment, authenticated transport, graphics API/surface, FPS, diagnostic,
input acknowledgement, release, and relaunch observations. It stores
executable basenames and session-local surface/attempt references rather than
raw input, typed text, credentials, full paths, HWNDs, monitor identifiers, or
arbitrary error messages. The summary deliberately reports an inconclusive
automated verdict: visible rendering, click blocking, drag/typing behavior, and
the game's reaction still require a controlled oracle or a human test.

The dock reads `session.targets.list()` and the typed FPS event. The main test
window calls `followTarget({ area: 'render' })`, so target resize, display/DPI,
and fullscreen changes resize its hidden Electron backing surface while the
in-game compositor keeps local `(0, 0)` coordinates. Controlled acceptance
modes keep their fixed proof geometry and do not enable this presentation-only
layout.

The status watcher runs in a forked Node child. That child starts the runtime's
parent-scoped continuous native observer for fast creation and deletion events,
with the slower WMI/COM monitor started only if the native observer fails. The
native observer takes one compact PID snapshot every 5 ms and queries executable
paths only for new PIDs; it no longer walks a full Toolhelp snapshot and every
process handle on every pass.

The continuous observer starts first, followed by the broad prearmed path
launcher and then four concurrently prepared exact-PID launchers with isolated
runtime/config/log directories. Creation events that arrive during preparation
wait in order for prepared slots; detected targets never trigger reactive
runtime staging in this default pool mode. Each successful consumption starts
replacement preparation immediately. A failed preparation emits
`STEAM_GAME_RUNTIME_PREPARE_FAILED` and retries with bounded backoff while
queued targets remain recorded. Every artifact is a private per-run copy. The
SDK validates the x64 and x86 schema-2 package manifests against the packaged
payload before staging, then repeats validation against the isolated snapshot
before starting an injector. Disposing unused prepared launchers removes their
directories. The SDK marks every isolated run as owned, but marks it reclaimable
only after a definite-safe failure or an OS-confirmed target disconnect.
Best-effort asynchronous sweeps after staging and retirement remove reclaimable
runs older than seven days or outside the newest 64 reclaimable runs. Prepared,
active, indeterminate, unmarked, malformed, and legacy pre-marker directories
remain untouched.

The prearmed and exact-PID lanes may select the same process. A native per-PID
claim serializes that overlap before target mutation. When the path lane wins,
the coordinator adopts its selected target and disposes the exact-PID loser;
when the exact lane wins, the path attempt yields without injecting. After a
failed attach, the broad watcher is rearmed only when native claim coordination
proves another lane won or the failure is definitely safe because no runtime or
add-on payload loaded. An indeterminate attempt remains blocked instead of being
retried blindly; when its diagnostic identifies a PID, only that PID's
confirmed exit releases the lane. An unknown-PID indeterminate result remains
blocked for the client lifetime. Duplicate native/WMI creation events for a
live PID are ignored, and process deletion releases that PID so a later reused
PID can be attempted again. Neither lane has an executable-name filter or
helper exclusion. This is still ordinary unsuspended user-mode observation and
cannot provide a universal pre-entry timing guarantee.

An initial PEAK run caught its Unity 6 D3D12 initialization and rendered the
interactive Electron menu, but it used the retired full-system 5 ms observer; a
later thermal report exposed that observer's unacceptable sustained polling.
On July 28, 2026, a short rerun with the bounded observer injected PEAK PID
11920 before `d3d12.dll` loaded, initialized the transport, rendered the dock,
captured Ctrl+I, and accepted the `Open status window` click. The observer used
0.6% of one CPU core before launch and rounded to 0% during the in-game sample,
versus roughly 25-34% for the retired scanner. No readable temperature sensor
was available, so this is a functional/resource acceptance run rather than a
thermal soak. PEAK itself rendered its splash at roughly 374-396 FPS before
settling near 94 FPS on the menu; the demo and observer do not impose that game
frame rate.

The separate `npm run dev:gun-frog` process-name gate remains the exact
two-window acceptance scene. Controlled launchers and clients started without
`--steam-auto-attach` retain the manual executable/PID controls. The controlled
`--start-overlay-session` and Gun Frog acceptance paths do not enable the
presentation dock.

The normal demo combines these public SDK paths:

```ts
await prearmedLauncher.attach(session, {
  pathContains: '\\steamapps\\',
});

await exactLauncher.attach(session, {
  processName: detectedProcess.processName,
  pid: detectedProcess.pid,
  executablePath: detectedProcess.filepath,
});
```

An attachment resolves only after the injector reports success and that same
PID authenticates to the overlay transport. The broad prearmed launcher is the
early-injection lane; it does not replace the distinct exact-PID launcher
created for every detected Steam-path executable. The native per-PID claim makes
their overlap deterministic and non-mutating for the losing attempt.

The demo uses the public SDK's optional exact-PID target. Its process watcher
supplies `{ processName, pid, executablePath }` immediately after it observes
the new process. The canonical path comes from the same observation and lets
the SDK prepare a detected target-local ReShade installation without guessing.
The PID must be a positive uint32, the process must already exist, and the
injector verifies that the opened process image has the requested basename
before any remote mutation. This path is intended to run before the target
creates its graphics device and swap chain; manually finding and entering a PID
after a game is already rendering is not a supported late-attachment workflow.
`--reshade-runtime-dir=<absolute-path>` remains a strict development/test
override; invalid or incomplete runtime assets fail instead of falling back.

The injector emits one strict `ELECTRON_GAME_OVERLAY_INJECTOR_RESULT` record.
The SDK accepts `runtimeMode: 'injected-runtime'`, where it loaded the staged
runtime and add-on; `runtimeMode: 'existing-runtime'`, where it reused a
compatible private runtime already loaded in the exact target PID; or
`runtimeMode: 'official-addon'`, where the verified add-on is hosted by an
official full-add-on ReShade runtime. Existing private-runtime reuse is
intentionally narrow: the project-built runtime must expose host ABI 1, and the
exact-PID attempt must register the staged private add-on before that
host closes its pre-initialization gate. A racing or incompatible private host
fails closed instead of attempting unsafe late registration.

Before allocating or writing target memory, the injector also scans bounded x64
PE candidates for an exact, non-forwarded `ReShadeVersion` export. Any detected
inactive or incompatible ReShade installation suppresses project-runtime
injection. Every detected target-local x64 identity is attempted through the
existing-installation path; neither product version nor runtime hash is an
allowlist. The SDK resolves ReShade's effective base path, add-on directory, and
`DisabledAddons` state from that exact target process and its configuration, and
honors a user-disabled Electron add-on instead of re-enabling it. Public-host
compatibility is decided only after the add-on loads: `ReShadeRegisterAddon`
must accept public API 18 and the host must return the exact Dear ImGui function
  table. If the current add-on is present but has not loaded yet, the SDK gives
  ReShade one bounded, inspection-only startup grace. A host that remains
  mapped without loading it reports
  `existing-reshade-addon-host-incompatible`; if the host disappears during
  the wait, the result is `target-official-addon-wait-expired`. Neither path
  injects the project runtime or requests another restart.

Only the staged native
`electron_game_overlay_reshade_manager.exe` may install, update, or remove the
uniquely named add-on and its project-owned marker, transaction journal, and
verified temporary/backup files. It never replaces a ReShade proxy, INI, preset,
effect, or foreign add-on. The current runtime hash holds the exact inspected
file across the manager request and crash-recoverable transaction, closing
TOCTOU races; it does not establish compatibility. The ReShade hash stored in
the ownership marker is provenance and is ignored when compatibility is
decided. A first install or update reports that the game must be restarted. If
Windows is holding the mapped add-on open, the launcher waits for OS-confirmed
target exit before retrying that maintenance; the following launch can then load
the current generation. Changing or upgrading ReShade does not automatically
remove the managed add-on. Applicable global Vulkan/OpenXR ReShade layers remain
preservation-only blockers and do not trigger fallback injection.

The client retains an exact-PID launcher after
`existing-reshade-addon-maintenance-deferred` because that diagnostic means an
ownership-checked install or update is queued for confirmed target exit.
`existing-reshade-addon-restart-required` means this attempt installed or
updated the disk state after the current process started, so only a new game
  process is needed; it does not queue maintenance. An already-current add-on
  that remains unloaded after the bounded startup grace is host-incompatible
  and also queues no work.
`existing-reshade-addon-conflict` and
`existing-reshade-addon-preparation-failed` likewise schedule no automatic
change.

The status moves from `attaching` to `connected` only after the SDK has
correlated the requested exact PID with its authenticated transport. A failed or
non-rendering process remains isolated from every other process attempt. If its
runtime authenticates later, the shared session promotes that existing PID to
connected without reinjecting it. Closing and relaunching a game does not
require restarting Electron. In manual mode, terminal target exit returns the
launcher to `idle` and re-enables **Arm, then launch**. A transient transport
loss clears the effective input acknowledgement while retaining the connected
PID identity until it reauthenticates or the OS confirms exit.

On July 29, 2026, the normal hybrid flow kept one Electron client alive across
Gun Frog PIDs 20856 and 13068. Both launches visibly rendered the D3D11 overlay
at 60 FPS. Ctrl+I produced positive and negative interception
acknowledgements; clicking `Open status window` was captured by the overlay
without changing the game menu, and the same position reached the game's normal
Quit action only after release. Each game closed normally while Electron stayed
alive for the next launch. After the final observer-readiness and path-first
ordering hardening, one client repeated visible 60 FPS attachment, exact-PID
attempts, normal exit, and rearm for PIDs 11856 and 16892 with no leftovers.

The client contains no injector or native payload. Its Steam watcher and
per-process coordinator are demo-only orchestration around the public SDK.

Press **Ctrl+I** to toggle input interception even while the target game owns
foreground focus. Electron owns this accelerator as a global shortcut; it is
not also registered as a payload hotkey, so one keypress produces one toggle.
The frontend button reflects changes made through either path.

When opened from the presentation menu, `ExampleMainOverlay` pins a visible
text field at `(24, 112)` and shows its latest DOM event in the lower-right
diagnostic strip. The compact status overlay has a smaller equivalent strip.
These controls make hover, click, focus, typing, and wheel receipt unambiguous
during a real-game run.

The dedicated controlled D3D12 integration gate builds and drives this real
client through the public SDK:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
```

It exercises both Electron windows, keeps the controlled target in the
foreground, freezes the game-side oracle during interception, drags and then
re-clicks the moved main window, releases input, proves legacy/raw/primary
pointer input and cursor confinement resume, and closes the target with released
Escape. It force-cleans only the isolated client process tree and repeats the
entire run with fresh client data and a distinct ReShade directory. The two-cycle
gate passed on July 13, 2026 with `D3D12_REAL_CLIENT_SDK_GATE_PASS`. Its
historical pre-promotion evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`; current runs use
`build/electron-game-overlay-runtime`.

The dedicated same-client restart gate is:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
```

It drives the frontend Inject control twice while keeping one Electron process
and overlay session alive. On July 13, 2026 Electron PID 17756 passed against
target PIDs 19764 and 17940 with distinct staged runtime directories. Each
OS-confirmed exit returned the client to `idle`; both D3D12 windows, input
interception/release, and no-leftover-process checks passed. Its marker is
`D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`; evidence is under
the historical path
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`.
Current runs use `build/electron-game-overlay-runtime`.

The exact-PID process-start gates are available separately for both controlled
backends:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-process-start-injection.ps1
```

The current gates start the controlled target normally, let normal loader work
finish, then block the cooperating host near entry at a test-only startup
marker before window and graphics-device setup. The real Electron frontend
enters the target basename and exact PID, clicks **Inject / arm**, then the
runner removes the marker. This proves the process-exists-before-injection and
injection-before-device ordering without pretending that the production watcher
owns a suspended process.

Both current gates passed on July 30, 2026:

- D3D11 emitted
  `D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; evidence is under
  `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-084815`.
- D3D12 emitted
  `D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; evidence is under
  `build/electron-game-overlay-runtime/client-sdk-d3d12-process-start-20260730-084831`.

Both runs proved exact injector arguments, transport connection, graphics-API
detection, the two-window scene, input acceptance/release, clean target exit,
and no leftover target, client, or injector process. They do not prove real
external-watcher latency or arbitrary-game timing.

For historical context only, the July 13 pre-promotion gates used
`CREATE_SUSPENDED` and proved injection before `ResumeThread`: D3D11 PID 7428
passed in
`build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623`,
and D3D12 PID 21508 passed in
`build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642`.
Those records are not the current process-start test contract.

Compatible existing-runtime reuse has its own controlled launchers:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-shared-runtime.ps1
```

Each fixture stages the compatible project runtime as a target-local
`dxgi.dll`, starts the host normally, waits for that proxy to initialize while
the host is still held by the test-only pre-device marker, and asks the SDK to
inject only its private staged add-on. The gate verifies
`runtimeMode: 'existing-runtime'`, the reported host runtime path, exact add-on
loading, unchanged target-local proxy/config files, and the full render,
input-interception, release, and game-oracle flow. D3D11 and D3D12 passed on
July 30, 2026 under
`build/electron-game-overlay-runtime/client-sdk-d3d11-shared-runtime-20260730-084016`
and
`build/electron-game-overlay-runtime/client-sdk-d3d12-shared-runtime-20260730-084003`.

Those two fixtures prove private-host reuse only with the repository-built
ABI-1 host while its registration gate is still open. Official-host mode has
separate controlled launchers:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-existing-reshade-installation.ps1 -OfficialRuntimePath C:\path\to\official\dxgi.dll
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-official-reshade-addon.ps1 -OfficialRuntimePath C:\path\to\official\dxgi.dll
```

The first proves that an inactive installation blocks project-runtime injection
without changing target files. The second preloads a caller-supplied
target-local x64 ReShade fixture and the production API-18 add-on, then requires
`runtimeMode: 'official-addon'`, exact-PID static discovery, rendering, input
isolation/release, normal exit, and byte-identical official files. These gates
exercise capability negotiation rather than a version/hash allowlist. They do
not establish coexistence in real games, compatibility with every public host,
other proxy chains, arbitrary add-on/effect combinations, anti-cheat systems,
or real-game startup timing.

For the accepted real-game proof, close Gun Frog first and run:

```powershell
npm run dev:gun-frog
```

This arms `Gun Frog.exe`, starts the real overlay session, and exposes four
Electron controls aligned over Continue, New Game, Settings, and Quit. Launch
Gun Frog after the injector is armed, click each Electron control once, press
Ctrl+I to release, and click the same Quit position again. The dedicated
repository acceptance wrapper automates build/startup and validates the logs:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk.ps1
```

That real-game client/SDK gate passed on July 13, 2026. The controlled D3D12
result above proves the prearmed SDK path and backend selection for the
cooperating host. The bounded observer also passed the short PEAK D3D12
render/input run described above; that does not prove universal pre-entry timing
or broad game compatibility. In a separate controlled probe, injection three
seconds after D3D11/D3D12 rendering began loaded `ReShade64.dll` but did not
adopt the existing device or swap chain, initialize the runtime/add-on, or
render the Electron scene. That route is unsupported. PID reuse and stronger
process creation identity, arbitrary watcher latency, and package publishing
remain deferred; the repository-built client and SDK are the current local test
path.
