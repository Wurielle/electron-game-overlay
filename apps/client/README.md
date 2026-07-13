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

The normal development command starts prearming one native SDK injector for the
next new process whose normalized executable path contains `/steamapps/`
(case-insensitive). Start the demo first, let its session/injector come up, then
launch a game normally through Steam. The native watcher selects it directly,
reports its exact PID/path, and the client rearms a fresh watcher after the
authenticated target connects. The WMI child remains active for demo status and
process-deletion evidence, but it does not initiate injection. The UI shows
watcher and target status and disables manual injection controls while automatic
mode is active.

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

The status watcher runs in a forked Node child because its WMI/COM event sink is
not compatible with Electron main's existing COM initialization. Its detection
usually arrives about a second after process creation, but that delay is no
longer part of injection: the SDK stages a native `--path-contains` watcher
before any game starts. That watcher snapshots and ignores already-running
processes, polls for a new matching executable, and performs the existing
ReShade load immediately inside the watcher process. It is still observing an
ordinary unsuspended launch rather than owning `CREATE_SUSPENDED`, so this does
not claim deterministic support for every arbitrarily fast target.

Unity's `UnityCrashHandler*.exe` helpers are excluded from the demo arm. They
live beside Unity games under `steamapps` but do not own the game's graphics
swap chain; selecting one would consume the one-shot arm before the real game
executable appears.

Sequential Gun Frog launch, close, and relaunch passed this path with one
Electron client. The current `STEAM_GAME_AUTO_ATTACH_ARMING` line is still a
request marker rather than a native-ready acknowledgement, and overlapping or
multi-process launches can fall into the one-shot rearm interval. Those are
tracked hardening items rather than claims made by this demo.

The separate `npm run dev:gun-frog` process-name gate remains the exact
two-window acceptance scene. Controlled launchers and clients started without
`--steam-auto-attach` retain the manual executable/PID controls. The controlled
`--start-overlay-session` and Gun Frog acceptance paths do not enable the
presentation dock.

The public SDK path used by normal development is:

```ts
await launcher.attach(session, { pathContains: '\\steamapps\\' });
```

It resolves with the selected PID, process basename, and full executable path
only after the injector reports success and that same process authenticates to
the overlay transport.

The demo uses the public SDK's optional exact-PID target. A process watcher can
supply `{ processName, pid }` immediately after it observes the new process. The
PID must be a positive uint32, the process must already exist, and the injector
verifies that the opened process image has the requested basename before any
remote mutation. This path is intended to run before the target creates its
graphics device and swap chain; manually finding and entering a PID after a
game is already rendering is not a supported late-attachment workflow.
`--reshade-runtime-dir=<absolute-path>` remains a strict development/test
override; invalid or incomplete runtime assets fail instead of falling back.

The status moves from `idle` to `attaching` and then to `connected` only after
the SDK has correlated the injector-selected PID with its authenticated
transport. Automatic mode keeps a separate native watcher armed for the next
new Steam process, so closing and relaunching a game does not require restarting
Electron. In manual mode, terminal target exit returns the launcher to `idle`
and re-enables **Arm, then launch**. A transient transport loss clears the
effective input acknowledgement while retaining the connected PID identity
until it reauthenticates or the OS confirms exit.

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
cooperating host, not post-render injection, arbitrary fast-start targets, or
compatibility with other games. In a separate controlled probe, injection three
seconds after D3D11/D3D12 rendering began loaded `ReShade64.dll` but did not
adopt the existing device or swap chain, initialize the runtime/add-on, or render
the Electron scene. That route is unsupported. PID reuse and stronger process
creation identity, arbitrary watcher latency, and package publishing remain
deferred; the repository-built client and SDK are the current local test path.
