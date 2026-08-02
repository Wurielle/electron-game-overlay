# Electron game overlay Windows runtime

This production Windows package builds x64 and x86 ReShade 6.7.3 full add-on
runtimes as the native process-entry, graphics-hook, swap-chain, input, logging,
and Dear ImGui layer. It builds architecture-specific injectors, controlled hosts,
`.addon64`/`.addon32` payloads, and native ReShade add-on managers. The x64
manager provides ownership-safe changes to a verified official installation;
the x86 official-installation path remains fail-closed. The historical hudhook
payload is not part of the production SDK build or staged runtime.

The original baseline proved two things inside the target render path:

- an always-visible Dear ImGui diagnostics panel can be rendered while the main ReShade menu is closed;
- a generated RGBA bitmap can be uploaded through ReShade's graphics-agnostic resource API and drawn with `ImGui::Image`.

The current implementation adds controlled D3D9, D3D10, D3D11, and D3D12
input-gate hosts and connects the real multi-window Electron scene through the
production SDK on all four backends. ReShade's public
`effect_runtime::block_input_next_frame()` remains the sole game-side blocking
authority. A narrow pinned full-add-on observer copies input only after ReShade
has decided to suppress it, allowing the project router to deliver the exact
legacy Win32 records to Electron without a second suppression hook. The pinned
runtime also copies blocked foreground raw mouse and keyboard records from both
queued `WM_INPUT` and direct `GetRawInputBuffer()` consumption. Only an exact
successful `RIDEV_NOLEGACY` registration makes that device-class stream
authoritative; otherwise the legacy window-message route remains authoritative
and the raw copy is ignored to avoid duplicate Electron events. On late
injection, the runtime seeds that authority from an exact
`GetRegisteredRawInputDevices()` snapshot before input routing begins, then
refreshes the snapshot transactionally around later registration calls.

An independent host oracle counts window messages, raw input, polling-visible
left-button state, Windows pointer messages, cursor movement, and cursor
confinement. A second narrow patch closes ReShade's `WM_POINTER` gap for
mouse-in-pointer applications. It restricts the new classification to `PT_MOUSE`
and updates ReShade's managed mouse state for native ImGui. The add-on snapshots
pointer metadata at the callback and, only after global sequence ordering on the
single consumer, turns primary move/left-click records into the same Electron
legacy route. When the same target has an authoritative `RIDEV_NOLEGACY` raw
mouse registration, that raw stream owns the physical action and the promoted
mouse-pointer copy is discarded rather than delivered twice.

`GetRawInputBuffer()` records contain no target HWND. The pinned runtime routes
them only when its current authoritative snapshot resolves exactly one
successful `RIDEV_NOLEGACY` registration for that device class on the calling
thread and foreground window root, selects a blocking render input under that
same root, and retains the same even registration generation through
consumption. An exact HWND registration uses that HWND. A
`hwndTarget = nullptr` registration follows only the calling GUI thread's exact
focused HWND when that HWND belongs to the current process/thread and its root
is foreground. Mouse records additionally require an exact client-space cursor
route. Snapshot failure or update-in-progress state, missing or multiple
candidates, a stale generation, or an invalid mouse route fails open: the
record is left unchanged for the game instead of being swallowed or sent to
the wrong Electron window.

Exact-PID SDK attachment uses a run-local rendezvous boundary. The injected
transport prefers `ELECTRON_GAME_OVERLAY_RUN_DIRECTORY`; newly injected runtime
mode also sets ReShade's base-path override to that run, while compatible
existing-runtime and official-host modes deliberately leave the host's
configuration and log base path unchanged. Each consumed staged run receives a
unique producer token bound to its expected PID before injection. The producer
writes
`electron-overlay-transport-v1.targeted` first, then the adjacent discovery
record. The injected client treats that marker as persistent route intent: a
missing, invalid, or revoked local credential fails closed instead of falling
back to the global producer.

An official add-on cannot inherit the isolated run-directory environment. For
that mode, the SDK publishes the same PID-bound credential at a deterministic
exact-PID temporary path, and authorizes a path-selected result only after the
injector proves the selected process.

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
- Rust via rustup with the `x86_64-pc-windows-msvc` and
  `i686-pc-windows-msvc` targets;
- CMake 3.24 or newer;
- Git;
- an internet connection for the first configure, which fetches the pinned ReShade and ImGui headers.

Install both Rust targets before building:

```powershell
rustup target add --toolchain stable x86_64-pc-windows-msvc i686-pc-windows-msvc
```

From a Visual Studio Developer PowerShell opened at the repository root:

```powershell
npx nx build electron-game-overlay-runtime
```

That target builds the transport dependency, pinned ReShade runtime/injector,
production add-on, native target-local ReShade add-on manager, and ABI smoke.
Each architecture distribution contains a schema-2
`electron_game_overlay_runtime.build.json` that binds its artifacts to their
source and content hashes. Composite SDK staging retains the x64 manifest under
that name and the x86 manifest as
`electron_game_overlay_runtime32.build.json`; the shared `ReShade.ini` must
match both manifests. To configure only the native controlled-host tree
directly:

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
downloads both into the ignored build directory, then applies an ordered stack of
production patches to the pinned ReShade revision:

- `reshade-input-observer.patch` advances the local full-add-on ABI to API 19
  and exposes a passive copied-input event after ReShade decides to block. It
  copies queued `WM_INPUT`, tracks successful raw-input registrations, and
  normalizes unambiguous `GetRawInputBuffer()` records;
- `reshade-raw-input-normalization.patch` migrates an exact older ignored
  fetched-source cache to the current observer implementation. Clean pinned
  source receives the same behavior directly from the observer patch;
- `reshade-raw-input-registration-reconciliation.patch` seeds raw-input
  registration authority from the target process before the first routed input
  and replaces incremental hook bookkeeping with serialized authoritative
  snapshots. Exact-HWND and NULL focus-following registrations are supported;
  transient query failures retry at most once per second, while unavailable,
  malformed, changing, or ambiguous snapshot state fails open;
- `reshade-raw-input-focus-following-root.patch` preserves exact device-class
  provenance and constrains NULL focus-following input to a rendered window
  under its focused foreground root. Explicit helper-HWND registrations retain
  the established process-wide render fallback;
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
- `reshade-injector-name-watcher-ready.patch` flushes a stable readiness marker
  after the name-only injector enters its watcher branch. The SDK converts this
  handshake into `injector-watcher-ready`; exact-PID attachment never emits it.
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
- `reshade-injector-existing-installation-preflight.patch` detects a
  target-local official installation before target mutation and reports the
  exact target executable, effective ReShade base path, add-on directory, and
  project-add-on disable state from that process.
- `reshade-injector-official-addon-host.patch` routes any detected target-local
  x64 ReShade identity to the uniquely named public API-18 add-on and validates
  the mapped add-on ABI and build identity without a version/hash allowlist.
- `reshade-injector-global-layer-preflight.patch` discovers applicable
  registered Vulkan and OpenXR ReShade layers and makes project-runtime
  injection fail closed without changing those installations.
- `reshade-shared-runtime-hardening.patch` closes the registration gate before
  add-on dispatch begins, uses a bounded x64 loader thunk, and makes gate races
  fail closed without spinning a CPU core.
- `reshade-suppress-splash.patch` suppresses ReShade's branded startup window
  because the embedding application owns startup UI. It leaves the full GUI
  pipeline, add-on callbacks, version metadata, `UNOFFICIAL` build identity,
  and the non-branded spinner for later explicit effect reloads intact.

The same Electron add-on has two negotiated hosts. On any detected target-local
x64 ReShade identity it must register through public API 18 and obtain the exact
Dear ImGui function table; it enables the private input observer only in this
repository's patched host. Do not replace the staged `ReShade64.dll` with a
stock build; the bundled project runtime remains the pinned ReShade 6.7.3 build,
while public-host compatibility is selected by capabilities rather than product
version or file hash. An official host can route and suppress foreground raw
input delivered through queued `WM_INPUT`, using the exact target's current
`RIDEV_NOLEGACY` registration as authority. The current public-host add-on does
not install the pinned runtime's `GetRawInputBuffer()` detour, so games that
consume raw input only through that buffered API require the bundled patched
runtime for complete interception.

Raw-input normalization is internal to the runtime/add-on boundary. It reuses
the existing normalized Win32 `game.input` route and does not change the
local add-on API 19, private host ABI 1, published transport C ABI, transport
wire schema, or public Node SDK API.

ReShade's API headers are BSD-3-Clause/MIT dual-licensed and Dear ImGui is
MIT-licensed. Preserve their notices if compiled binaries are redistributed.
The helper builds the pinned ReShade runtime and matching injector only into
the ignored local build directory; it does not run the injector. Both x64 and
x86 payloads are supported. Do not commit or redistribute those binaries.

To build the pinned ReShade full-add-on runtime explicitly:

```powershell
.\libs\electron-game-overlay-runtime\scripts\build-reshade-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\build-reshade-runtime.ps1 -Architecture x86
```

The launchers validate the cache against a schema-27 build stamp, every
production-patch SHA-256 hash, the pinned commit, exact normalized contents of
all nine patched source files, the full-add-on configuration, and the
runtime/injector SHA-256 hashes. CMake performs the same commit, nine-path, and
normalized-content check
independently for every fetched source tree before generating native targets.
Extra edits inside an expected fetched-source file invalidate the build.

## Run the controlled input gates

Each human-facing backend has its own launcher:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-x86-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-x86-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-x86-exact-injection-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-x86-exact-injection-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-x86-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-x86-client-sdk.ps1
```

The launchers build the host and add-on, build or reuse the pinned local ReShade
runtime, and create an isolated directory under
`build/electron-game-overlay-runtime/input-gate-d3d9`, `input-gate-d3d10`,
`input-gate-d3d11`, or `input-gate-d3d12`. D3D9, D3D10, and D3D11 stage the
runtime as `d3d9.dll`, `d3d10.dll`, and `d3d11.dll`; D3D12 stages it as
`dxgi.dll`. All four stage `ReShade.ini` with `[INPUT] InputProcessing=2`, the add-on,
and the `reshade-input-gate.enabled` marker that enables the controlled host
oracle. The parameterized `scripts/run-input-gate.ps1` runner remains available
for automation and supports `-Architecture x64|x86` and `-NoLaunch`. The x86
launchers use `ReShade32.dll`, `.addon32`, and controlled PE32 hosts; the x64
launchers retain their existing artifact names and directories.

The x86 exact-injection launchers keep the target executable separate from the
runtime payload, invoke the Win32 injector against an exact PID, validate all
native files as PE32/I386, and require the first add-on ImGui frame. The x86
client/SDK launchers additionally exercise the production Electron client and
the SDK's validated x64-to-x86 injector handoff.

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

### Accepted x64 legacy-API results: August 1, 2026

The D3D9 and D3D10 proxy-loaded hosts rendered the native ImGui/texture probe,
survived a live post-render resize, recreated their effect-runtime-owned test
textures, produced no Reset/ResizeBuffers failure, and exited normally. The
production client/SDK gate then passed twice on each backend with exact hook and
target-surface API evidence, two transported Electron windows, input
interception/release, caption drag, text input, post-scene resize, distinct
isolated runtime directories, and no leftover target/client/injector process.
The result markers are `D3D9_REAL_CLIENT_SDK_GATE_PASS` and
`D3D10_REAL_CLIENT_SDK_GATE_PASS`.

These are Windows x64 real-client results. The package now also contains a
Win32 injector, `ReShade32.dll`, `.addon32`, the i686 Rust transport, and SDK
architecture handoff. Portal's real PE32 `hl2.exe` has a user-confirmed D3D9
smoke test. That observation does not claim the controlled reset, relaunch, and
cleanup matrix described below.

### Accepted controlled x86 results: August 1, 2026

Both D3D9 and D3D10 exact-PID gates validated I386 host, injector, runtime, and
add-on artifacts, returned the requested PID/path in `injected-runtime` mode,
rendered the first ImGui frame, and shut down cleanly. The production
Electron/client SDK gate then passed two fresh cycles per backend. Each cycle
preserved the x64 architecture diagnostic plus x86 injector result, rendered
two transported Electron windows, froze the host input oracle throughout
overlay interaction, released input, resized the legacy graphics surface, and
left no client, host, or injector process behind. The result markers are
`D3D9_X86_REAL_CLIENT_SDK_GATE_PASS` and
`D3D10_X86_REAL_CLIENT_SDK_GATE_PASS`.

A compatible already-loaded project ReShade runtime can be reused on x86 after
the Win32 injector loads and validates `electron_game_overlay.addon32`. An
official ReShade host or an inactive target-local installation still remains
fail-closed until the x86 coexistence/manager path has its own acceptance gates.

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
input-state metadata, the fixed runtime-diagnostic record, bounded outbound
drain argument/status handling, and create/acquire/release/drain/destroy
linkage. Runtime diagnostics use a dedicated bounded queue of 32 records and
carry no free-form text, paths, handles, or producer-supplied PID. The add-on
reports transport, swap-chain, and first-scene milestones plus guarded
scene/frame/upload/input failures. It never publishes from `DllMain` or the
input producer callback; input observations are emitted only by the ordered
render-thread consumer. Failure codes have a native 7.5-second per-code
cooldown before the additional Node-side rate limit.

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

The generated `electron_game_overlay.addon64` has completed controlled D3D9,
D3D10, D3D11, and D3D12 live-producer runs: it connected the existing authenticated Node
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

## Run the production client/SDK D3D9, D3D10, and D3D12 gates

Use the dedicated controlled production-client wrapper:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
```

It builds the real client, public SDK runtime, add-on, injector, and controlled
host. For each of two attempts it starts a fresh client with isolated user
data, arms the SDK launcher by executable basename, starts the host, and verifies
the exact connected PID and path. The runner requires the selected API's exact
ReShade hook marker and target-surface telemetry, the
transported two-window scene, and a positive interception acknowledgement before
driving the status and main text fields. It also sends intercepted Escape, drags
the main caption, clicks the field at its moved coordinates, and requires the
target to remain foreground with its complete title oracle byte-identical.

After the negative interception acknowledgement, a released click must advance
the host's legacy down/up, raw-input, and primary `PT_MOUSE` pointer counters and
restore cursor confinement. Released Escape must then close the host normally.
The runner force-cleans only that attempt's isolated Electron process tree,
requires no host/client/injector leftovers, relaunches with a distinct ReShade
run directory, and emits the selected backend's
`D3D9_REAL_CLIENT_SDK_GATE_PASS`, `D3D10_REAL_CLIENT_SDK_GATE_PASS`, or
`D3D12_REAL_CLIENT_SDK_GATE_PASS` marker only after both cycles pass. D3D9 and
D3D10 additionally force a post-scene resize and reject Reset/ResizeBuffers
failures.

The gate passed on July 13, 2026 against target PIDs 17248 and 13528. Evidence is
preserved under
`build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`; its root
`result.txt` contains `D3D12_REAL_CLIENT_SDK_GATE_PASS`, while the two attempt
directories retain client logs, exact ReShade run-directory records, and
per-attempt pass markers.

The copied host has a test-only `reshade-injection-wait.enabled` marker. It gives
the prearmed injector a bounded opportunity to load ReShade and install its
graphics hooks before the deliberately fast controlled host creates its device. This
proves the production client/public SDK path and ReShade's backend selection for a
cooperating target; it does not prove late injection or arbitrary fast-start
game timing. Client cleanup in this gate is forced teardown followed by a
fresh launch, not producer-session deactivation or clean runtime/add-on unload.

## Run the production client/SDK raw-input gates

Use the dedicated human-facing launcher for each backend:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-raw-input.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-raw-input.ps1
```

Each launcher runs two isolated one-attempt production client/SDK cases. The
first host registers raw mouse and keyboard with `RIDEV_NOLEGACY` and consumes
them through queued `WM_INPUT`; the second consumes the same authoritative
device classes through `GetRawInputBuffer()`. The runner drives both transported
Electron windows, requires normalized click, keyboard, text, and wheel behavior
while the complete game-side oracle remains frozen, then releases interception
and proves raw input resumes. The buffered case additionally requires the
host's buffer-batch counter to advance after release with no buffer error.

The wrappers run `wm-input` followed by `raw-buffer`, reuse the first build for
the second case, and print `D3D11_RAW_INPUT_CLIENT_SDK_GATE_PASS` or
`D3D12_RAW_INPUT_CLIENT_SDK_GATE_PASS` only after both pass. `-SkipBuild` is
available when the current client and native artifacts have already been built.
These gates exercise the bundled pinned runtime; the official ReShade path has
the `WM_INPUT` capability only and is not evidence for `GetRawInputBuffer()`
consumers.

## Run the raw-registration-before-injection gates

Use the dedicated launcher for each backend:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-raw-registration-before-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-raw-registration-before-injection.ps1
```

These gates run the same `wm-input` and `raw-buffer` acceptance as the normal
raw-input launchers, but reverse the startup order. The controlled host first
asserts that ReShade is absent, creates its primary HWND, registers raw mouse
and keyboard with `RIDEV_NOLEGACY`, and publishes a deterministic ready title.
Only then does the runner start the production Electron client and injector.
The host holds graphics initialization until `ReShade64.dll` arrives, proving
that the runtime must recover a registration it could not observe through its
`RegisterRawInputDevices` hook. The wrapper emits
`D3D11_RAW_REGISTRATION_BEFORE_INJECTION_CLIENT_SDK_GATE_PASS` or
`D3D12_RAW_REGISTRATION_BEFORE_INJECTION_CLIENT_SDK_GATE_PASS` only after both
raw consumption modes complete the full interception and release proof.

The true pre-injection cases passed on August 1, 2026. Evidence is under
`build/electron-game-overlay-runtime/client-sdk-d3d11-wm-input-registration-before-injection-20260801-153441`,
`client-sdk-d3d11-raw-buffer-registration-before-injection-20260801-153450`,
`client-sdk-d3d12-wm-input-registration-before-injection-20260801-153502`, and
`client-sdk-d3d12-raw-buffer-registration-before-injection-20260801-153512`.
The ordinary post-injection registration path was rerun after the focused-root
hardening under `client-sdk-d3d11-wm-input-20260801-162614`,
`client-sdk-d3d11-raw-buffer-20260801-162623`,
`client-sdk-d3d12-wm-input-20260801-162632`, and
`client-sdk-d3d12-raw-buffer-20260801-162641`.

## Run the NULL focus-following raw-registration gates

Use the dedicated launcher for each backend:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-null-target-raw-registration.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-null-target-raw-registration.ps1
```

Each launcher runs queued and buffered raw input after the host registers mouse
and keyboard before injection with `hwndTarget = NULL`. Acceptance requires the
ready title to report `target=null-focus hwndTarget=NULL`, the stable oracle to
report `target=null-focus raw-register=ok`, full Electron interaction while the
game oracle remains frozen, and restored raw counters after release.

The four private-runtime cases passed on August 1, 2026 under
`client-sdk-d3d11-wm-input-registration-before-injection-null-target-20260801-162427`,
`client-sdk-d3d11-raw-buffer-registration-before-injection-null-target-20260801-162509`,
`client-sdk-d3d12-wm-input-registration-before-injection-null-target-20260801-162547`,
and
`client-sdk-d3d12-raw-buffer-registration-before-injection-null-target-20260801-162557`.
They prove one primary HWND that remains focused and foreground, with
registration, delivery, and rendering on the same GUI thread. Background
rejection, focus transfer/reacquisition, another GUI thread, and multiple or
sibling HWND ambiguity remain separate hardening cases.

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

## Run producer-session, final-surface, multi-swap-chain, and independent-app lifecycle gates

Use the dedicated human-facing launchers:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-session-deactivation.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-session-deactivation.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-target-surface-drain.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-target-surface-drain.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-multi-swapchain.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-multi-swapchain.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-d3d12-client-sdk-two-app-two-target.ps1
```

The D3D11 and D3D12 gates close the public SDK session while the Electron
producer and controlled target remain alive. On the next ReShade overlay
callback, the monotonic epoch transition releases interception, clears the old
scene, and retires the active process-primary textures in each accepted target.
ReShade and the Electron add-on remain mapped and dormant. This is session
deactivation, not unload. July 31, 2026 evidence is under
`build/electron-game-overlay-runtime/client-sdk-d3d11-session-deactivation-20260731-000557`
and
`build/electron-game-overlay-runtime/client-sdk-d3d12-session-deactivation-20260731-000709`.

The target-surface gates destroy the controlled host's final swap chain and
graphics device while keeping its process and HWND alive. They require the
public SDK surface to become null within two seconds without accepting process
disconnect as success, and also prove that Electron and the attachment remain
live. The runtime itself uses a bounded 250 ms socket write-completion barrier
before destroying the final transport; this is not an application-level
acknowledgement, and timeout or disconnect does not stall graphics teardown.
August 1, 2026 evidence is under
`build/electron-game-overlay-runtime/client-sdk-d3d11-target-surface-drain-20260801-080719`
(89.992 ms to SDK null) and
`build/electron-game-overlay-runtime/client-sdk-d3d12-target-surface-drain-20260801-080808`
(846.302 ms to SDK null). Both also assert that native teardown emitted no
final-drain failure warning.

The multi-swap-chain gates create two distinct HWND swap chains in one exact-PID
target. D3D11 shares one device/context; D3D12 shares one device/direct queue.
The first valid presenter stays process primary through resize. Only it advertises
target-surface/FPS telemetry, owns input, and composes the Electron scene. The
gate then destroys that swap chain while keeping both HWNDs, the shared graphics
objects, process, producer, and attachment alive. It requires the surviving
presenter to publish a different surface identity, sustained FPS, and a second
exclusive compositor; intercepted Electron input must work while the game oracle
remains frozen on both owners. Released input must then reach the promoted HWND.
August 1, 2026 evidence is under
`build/electron-game-overlay-runtime/client-sdk-d3d11-multi-swapchain-20260801-103555`
(37.782 ms failover) and
`build/electron-game-overlay-runtime/client-sdk-d3d12-multi-swapchain-20260801-103532`
(51.518 ms failover). Both recorded FPS events `1 -> 4 -> 6` and interception
acknowledgements `true -> false -> true -> false` without a target disconnect.
Same-HWND input ownership, distinct D3D12 direct queues, and broader layouts are
not claimed by these gates.

The two-app gate runs two independent Electron processes against separate
exact-PID D3D11 and D3D12 targets. It proves distinct run directories,
rendezvous paths, ports, and credentials; isolated scene and input state; and
that stopping one app/target does not disturb the other. July 31, 2026 evidence
is under
`build/electron-game-overlay-runtime/client-sdk-two-app-two-target-20260731-000719`.
Concurrent independent applications targeting the same PID remain unsupported.

## Existing target-local ReShade coexistence

Clean targets continue through the repository's patched injected host. For an
exact-PID target that already has ReShade, preflight resolves installation paths
and enablement from the exact target process and its configuration. Every
detected target-local x64 ReShade identity suppresses fallback project-runtime
injection and is attempted with the uniquely named
`electron_game_overlay.addon64`. There is no version/hash allowlist.
`DisabledAddons` is authoritative: if the user disabled this add-on, the
launcher leaves that decision intact and refuses attachment. Compatibility is
established only after the add-on loads: `ReShadeRegisterAddon` must accept
public API 18 and `ReShadeGetImGuiFunctionTable` must return the exact Dear ImGui
table requested by the add-on. A current add-on that has not loaded yet receives
one bounded, inspection-only startup grace. A host that remains mapped without
loading it reports `existing-reshade-addon-host-incompatible`; one that
disappears during the wait reports `target-official-addon-wait-expired`.
Neither result permits a repeated restart or fallback injection.

No coexistence path replaces or rewrites the existing ReShade runtime/proxy,
INI, presets, effects, or foreign add-ons. A public host that cannot complete
the required registration/table negotiation is preserved and fails closed.
Applicable configured global Vulkan/OpenXR ReShade layers are also preserved
and block fallback project-runtime injection; they are not public-host
integration paths.

Only `electron_game_overlay_reshade_manager.exe` may change the reserved
`electron_game_overlay.addon64`, ownership marker, transaction journal, and its
verified temporary/backup names. The manager holds and verifies the exact
runtime file named by the request while it performs a crash-recoverable
transaction; it does not discover installations or edit ReShade configuration.
The request hash is exact TOCTOU and transaction provenance, not a compatibility
allowlist. The ownership marker's `reshadeModuleSha256` is installation
provenance and is ignored for compatibility. Installing or updating the add-on
requires a restart. A mapped add-on is never replaced in the running target: the
SDK defers install/update maintenance until the exact target's exit is
confirmed, then a later launch may load the current generation. A ReShade
upgrade or runtime-hash change does not automatically remove the managed
add-on. Foreign, partial, or tampered reserved-name collisions are preserved and
receive no automatic maintenance.

At the SDK boundary,
`existing-reshade-addon-maintenance-deferred` means an install or update is
queued behind exact-target exit proof.
`existing-reshade-addon-restart-required` means this attempt installed or
updated the on-disk add-on after the current process started, so a new process is
needed and no maintenance is queued. If the already-current add-on remains
unloaded after the bounded startup grace, the result is host-incompatible
instead. Conflict and preparation-failure diagnostics also schedule no automatic
change.

The controlled launchers for this boundary are:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\existing-reshade-installation-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\global-reshade-layer-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\reshade-addon-manager.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-official-reshade-addon-preflight.ps1 -OfficialRuntimePath C:\path\to\official\dxgi.dll
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-existing-reshade-installation.ps1 -OfficialRuntimePath C:\path\to\official\dxgi.dll
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-existing-reshade-upgrade.ps1 -OfficialRuntimePath C:\path\to\official\dxgi.dll
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-official-reshade-addon.ps1 -OfficialRuntimePath C:\path\to\official\dxgi.dll
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk-official-reshade-coexistence.ps1
```

These gates verify identification, fail-closed preservation, transaction
behavior, and official-host rendering/input. The Gun Frog case additionally
seeds a stock full-add-on host, a pristine API-18 foreign add-on, and a benign
enabled effect into one reversible test-owned installation, then runs the real
Steam auto-attacher and four-button input proof. It still does not establish
another proxy chain or every public host that may lack the required API/table
capabilities.

That Gun Frog gate passed on July 31, 2026. Stock ReShade loaded the pristine
API-18 FPS Limiter add-on, the Electron add-on, and the enabled
`EGOCoexistenceWitness` effect together. All four Electron buttons remained
isolated from the game menu; after Ctrl+I released interception, the same Quit
position closed the game. Cleanup then proved byte/attribute/timestamp identity
for the seeded installation and restored the original clean game directory.
Evidence is under
`build/electron-game-overlay-runtime/client-Gun-Frog-official-reshade-coexistence-20260731-002038-058ec1a0`.
Arbitrary effect sets and proxy chains remain deferred.

The upgrade launcher also composes the production Steam process watcher,
auto-attacher, SDK launcher, and packaged native manager. It seeds a managed
add-on and marker against the supplied runtime, then appends a benign PE overlay
byte to change only the runtime identity. The gate requires
`runtimeMode: 'official-addon'`, connection only after startup-barrier release,
normal exit, no deferred maintenance or removal, and retention of the managed
add-on and marker. Except for the intentionally removed startup barrier, the
complete ReShade installation must retain byte, attribute, and timestamp
identity.

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
This is deliberately narrower than general modded-game support: a compatible
private host whose gate has already closed, a public host that cannot register
API 18 or provide the exact ImGui table, unknown proxy chains, and arbitrary
real-game startup timing still fail closed or remain unsupported.

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
- same-HWND multi-swap-chain input ownership, distinct D3D12 direct queues, and
  broader swap-chain layouts beyond the accepted shared-device/queue boundary;
- clean in-process runtime/add-on unload, post-render injection or existing-device/
  swap-chain adoption, arbitrary proxy chains, real-game coexistence with
  arbitrary effect/add-on combinations, deterministic pre-entry injection,
  additional games, or broader graphics/presentation compatibility;
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
clean in-process unload, post-render attachment, arbitrary watcher latency,
end-to-end process-creation correlation beyond the native watcher baseline,
other games and APIs, and same-HWND/distinct-queue/broader-layout
multi-swap-chain hardening stay outside the accepted boundary. Package publishing is deferred
while repository-local SDK/client testing continues. ReShade replaces the
injected host, graphics lifecycle, ImGui ownership, and game-side input blocking
rather than the Electron SDK contract.
