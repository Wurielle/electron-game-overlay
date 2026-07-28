# Electron game overlay client

## SDK demo client

From the repository root, run:

```powershell
npm run build
```

On Windows x64 this first builds the `electron-game-overlay` SDK and stages its
pinned patched ReShade runtime, injector, add-on, configuration, and build stamp,
then builds this demo client. The relevant output is:

```text
apps/client/dist/main/main.js
apps/client/dist/process-watcher/index.cjs
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/inject.exe
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade64.dll
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade64.build.json
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay.addon64
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade.ini
```

The native sources live in the Nx projects `electron-overlay-transport` and
`electron-game-overlay-runtime`. This application contains no native host code;
it exists to exercise the public SDK.

The native build requires Rust, CMake, Git, and Visual Studio 2022 C++ Build
Tools. The SDK uses the locked Rust transport engine and the pinned locally patched ReShade
revision; a stock ReShade 6.7.3 runtime is not ABI-compatible with the add-on.

The normal client uses the SDK's ReShade launcher. ReShade selects the graphics
API inside the target, so there is no D3D11/D3D12 client option:

```powershell
npm run dev
```

The normal development command starts a process-creation watcher. Start the demo
first, let its session and watcher come up, then launch a game normally through
Steam. Every detected executable whose normalized path contains `/steamapps/`
(case-insensitive) receives its own exact-PID SDK injection attempt. Attempts run
independently and concurrently: launchers, render processes, helpers, and
redistributables are not classified or excluded. A process that initializes the
overlay authenticates normally; one that does not initialize graphics cannot
consume or prevent later attempts. The UI shows watcher and per-PID target status
and disables manual injection controls while automatic mode is active.

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

The dock reads `session.targets.list()` and the typed FPS event. The main test
window calls `followTarget({ area: 'render' })`, so target resize, display/DPI,
and fullscreen changes resize its hidden Electron backing surface while the
in-game compositor keeps local `(0, 0)` coordinates. Controlled acceptance
modes keep their fixed proof geometry and do not enable this presentation-only
layout.

The status watcher runs in a forked Node child. That child prearms the runtime's
parent-scoped native path observer for fast creation and deletion events, with
the slower WMI/COM monitor started only if the native observer fails. The
native path takes one compact PID snapshot every 5 ms and queries executable
paths only for new PIDs; it no longer walks a full Toolhelp snapshot and every
process handle on every pass.

The watcher starts before the demo concurrently prepares four separate SDK
launchers and their isolated runtime/config/log directories. Creation events
that arrive during preparation wait in order for prepared slots; detected
targets never trigger reactive runtime staging in this default pool mode. Each
successful consumption starts replacement preparation immediately. A failed
preparation emits `STEAM_GAME_RUNTIME_PREPARE_FAILED` and retries with bounded
backoff while queued targets remain recorded. Non-mutating artifacts are
hard-linked into the directory when the filesystem permits, with portable
copying as fallback. `ReShade64.dll` and `ReShade.ini` remain private copies
because the injector adjusts the DLL ACL and ReShade may update its
configuration. Disposing unused prepared launchers removes their directories.
Duplicate native/WMI creation events for a live PID are ignored, and process
deletion releases that PID so a later reused PID can be attempted again. The
watcher deliberately has no executable-name filter. This is still an ordinary
unsuspended user-mode observer and cannot provide a universal pre-entry timing
guarantee.

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

The public SDK path used for each process detected by normal development is:

```ts
await launcher.attach(session, {
  processName: detectedProcess.processName,
  pid: detectedProcess.pid,
});
```

It resolves only after the injector reports success and that same PID
authenticates to the overlay transport. Automatic mode creates a distinct
launcher for every detected Steam-path executable rather than sharing a
one-shot path target.

The demo uses the public SDK's optional exact-PID target. A process watcher can
supply `{ processName, pid }` immediately after it observes the new process. The
PID must be a positive uint32, the process must already exist, and the injector
verifies that the opened process image has the requested basename before any
remote mutation. This path is intended to run before the target creates its
graphics device and swap chain; manually finding and entering a PID after a
game is already rendering is not a supported late-attachment workflow.
`--reshade-runtime-dir=<absolute-path>` remains a strict development/test
override; invalid or incomplete runtime assets fail instead of falling back.

The status moves from `attaching` to `connected` only after the SDK has
correlated the requested exact PID with its authenticated transport. A failed or
non-rendering process remains isolated from every other process attempt. If its
runtime authenticates later, the shared session promotes that existing PID to
connected without reinjecting it. Closing and relaunching a game does not
require restarting Electron. In manual mode, terminal target exit returns the
launcher to `idle` and re-enables **Arm, then launch**. A transient transport
loss clears the effective input acknowledgement while retaining the connected
PID identity until it reauthenticates or the OS confirms exit.

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

They create the target with Windows `CREATE_SUSPENDED`, enter its basename and
exact PID in the real Electron frontend, click **Inject / arm**, and resume the
primary thread only after injection completes. This deterministically tests the
required process-exists-before-injection and injection-before-graphics ordering.

Both gates passed on July 13, 2026:

- D3D11 targeted PID 7428. The process-create-to-frontend-click interval was
  72.393 ms, and the runner emitted
  `D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`. Historical
  pre-promotion evidence is under
  `build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623`.
- D3D12 targeted PID 21508. The process-create-to-frontend-click interval was
  84.061 ms, and the runner emitted
  `D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`. Historical
  pre-promotion evidence is under
  `build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642`.

Both runs proved the exact injector arguments and that ReShade loaded before
`ResumeThread`. After resume, transport connection, graphics-API detection, the
two-window scene, and input acceptance passed. Each target exited with code 0,
the frontend returned to `idle`, and no target, client, or injector process was
left behind. This does not prove how much delay an unsuspended external watcher
can tolerate.

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
