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

The normal development command enables this client's demo-only Steam process
watcher. Launch a game normally through Steam; when a newly created process has
a normalized executable path containing `/steamapps/` (case-insensitive), the
client gives that exact PID its own SDK launcher. Multiple matching processes
can be tracked concurrently while sharing the same overlay session. The UI
shows watcher and target status and disables manual injection controls while
automatic mode is active.

The watcher runs in a forked Node child because its WMI/COM event sink is not
compatible with Electron main's existing COM initialization. Detection usually
arrives about a second after process creation. Processes whose executable paths
cannot be read, including some elevated targets, are ignored, and an
unsuspended target can still initialize graphics before injection. This is a
demo convenience rather than a new SDK responsibility or a guarantee of
general late attachment.

The accepted Gun Frog flow remains the separate `npm run dev:gun-frog`
process-name arm-before-launch mode. Controlled launchers and clients started
without `--steam-auto-attach` retain the manual executable/PID controls.

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
transport. When that exact target exits, the client returns to `idle`, clears
the stale effective-interception acknowledgement, and enables **Arm, then
launch** for the restarted process. The Electron client does not need to be
restarted. A transient transport loss clears the effective acknowledgement but
keeps Inject disabled until the same PID reconnects or the OS confirms that the
target exited. If an injector may have run but its result cannot be proven, the
client displays the error and remains latched; restart the client before
retrying rather than risk injecting a live target twice.

The client contains no injector or native payload. Its Steam watcher and
per-process coordinator are demo-only orchestration around the public SDK.

Press **Ctrl+I** to toggle input interception even while the target game owns
foreground focus. Electron owns this accelerator as a global shortcut; it is
not also registered as a payload hotkey, so one keypress produces one toggle.
The frontend button reflects changes made through either path.

`ExampleMainOverlay` automatically pins a visible text field at `(24, 112)` and
shows its latest DOM event in the lower-right diagnostic strip. The status
overlay has a smaller equivalent strip. These controls are demo diagnostics:
they make hover, click, focus, typing, and wheel receipt unambiguous during a
real-game run.

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
