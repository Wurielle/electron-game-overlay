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

That real client/SDK gate passed on July 13, 2026. It does not establish late
injection or compatibility with other games.
