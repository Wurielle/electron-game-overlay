# gelectron

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
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/inject.exe
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade64.dll
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade64.build.json
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_reshade_overlay_poc.addon64
libs/electron-game-overlay/dist/runtime/win32-x64/reshade/ReShade.ini
```

The native build requires Rust, CMake, Git, and Visual Studio 2022 C++ Build
Tools. The SDK uses the locked Rust core and the pinned locally patched ReShade
revision; a stock ReShade 6.7.3 runtime is not ABI-compatible with the add-on.

The normal client uses the SDK's ReShade launcher. ReShade selects the graphics
API inside the target, so there is no D3D11/D3D12 client option:

```powershell
npm run dev
```

Enter an executable basename such as `game.exe`, click **Arm, then launch**, and
only then launch the game. The accepted Gun Frog path is process-name
arm-before-launch; late injection into an already running game is not claimed.
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

The client contains no injector, native payload, or target-correlation
implementation of its own; it is only an SDK acceptance/demo application.

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
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk.ps1
```

It exercises both Electron windows, keeps the controlled target in the
foreground, freezes the game-side oracle during interception, drags and then
re-clicks the moved main window, releases input, proves legacy/raw/primary
pointer input and cursor confinement resume, and closes the target with released
Escape. It force-cleans only the isolated client process tree and repeats the
entire run with fresh client data and a distinct ReShade directory. The two-cycle
gate passed on July 13, 2026 with `D3D12_REAL_CLIENT_SDK_GATE_PASS`; evidence is
under `build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`.

The dedicated same-client restart gate is:

```powershell
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
```

It drives the frontend Inject control twice while keeping one Electron process
and overlay session alive. On July 13, 2026 Electron PID 17756 passed against
target PIDs 19764 and 17940 with distinct staged runtime directories. Each
OS-confirmed exit returned the client to `idle`; both D3D12 windows, input
interception/release, and no-leftover-process checks passed. Its marker is
`D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`; evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`.

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
.\poc\reshade-imgui-overlay\scripts\test-cases\gun-frog-client-sdk.ps1
```

That real-game client/SDK gate passed on July 13, 2026. The controlled D3D12
result above proves the prearmed SDK path and backend selection for the
cooperating host, not late injection, arbitrary fast-start targets, or
compatibility with other games.
