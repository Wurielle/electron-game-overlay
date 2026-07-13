# DirectX hook and game overlay solution for any desktop GUI like Electron, Qt, CEF and WPF⚡

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/4fe290657a91448caecaa5583c84b9d1)](https://www.codacy.com/gh/hiitiger/goverlay/dashboard?utm_source=github.com&utm_medium=referral&utm_content=hiitiger/goverlay&utm_campaign=Badge_Grade)

[![Build status](https://ci.appveyor.com/api/projects/status/sgi7go37f72f52a5?svg=true)](https://ci.appveyor.com/project/hiitiger/goverlay)

## ReShade + ImGui host migration

The active native host is the
[ReShade + ImGui POC](poc/reshade-imgui-overlay/README.md). ReShade 6.7.3 full
add-on support is the selected POC process-entry, graphics,
swap-chain, ImGui, and game-input layer. On July 12, 2026, the controlled D3D11
and D3D12 input gates passed hands-on acceptance: native ImGui remained
interactive, the independent game-side message/raw/polling counters stayed
frozen throughout interception, resize preserved blocking, and release restored
normal counters and cursor confinement. The real Electron scene subsequently
passed the same gate on both backends. On July 13, Gun Frog passed an exact
four-control menu proof: Electron alone received clicks aligned over Continue,
New Game, Settings, and Quit while the game stayed on its menu and remained
alive; after Electron acknowledged release, the same Quit position closed the
game normally. The built production client and SDK ReShade launcher then passed
the same four-control gate against Gun Frog on July 13. That production path
also passed two fresh controlled D3D12 client/host cycles with both Electron
windows, interception, text, caption dragging, release, normal target exit, and
isolated relaunch. A separate gate then kept one Electron client alive across
two target exits, re-armed through the frontend, and passed the same D3D12
scene/input boundary with a fresh injector-selected PID and isolated runtime on
each cycle. The active client host switch and focused POC finish line are
complete for those bounded, arm-before-launch paths.

The public SDK now also accepts an optional exact PID through
`attach(session, { processName, pid })`, and the Electron demo exposes the same
optional PID beside the executable basename. This path is for a process watcher
that calls the SDK immediately after the process exists and before the target
creates its graphics device and swap chain. Dedicated deterministic D3D11 and
D3D12 launchers hold the target at `CREATE_SUSPENDED`, inject through the real
frontend, and resume only after exact-PID injection finishes. Both gates passed
on July 13, 2026. D3D11 selected PID 7428 and reached the frontend click 72.393
ms after process creation; D3D12 selected PID 21508 and reached it in 84.061 ms.
In each run the injector received the exact-PID arguments and ReShade loaded
before `ResumeThread`; transport, graphics-API detection, the two-window scene,
and input passed after resume. Both targets exited with code 0, the frontend
returned to `idle`, and no test process remained. This deterministic ordering
does not establish an arbitrary unsuspended watcher-latency budget.

The change in direction follows real-client testing against Gun Frog. The
hudhook path successfully proved Electron OSR transport, ordered multi-window
composition, focus, capture, and input return, but the game still observed mouse
hover/click state while interception was requested. Expanding project-owned
User32/raw-input detours into another game-input compatibility framework is no
longer the production direction. The
[hudhook + ImGui POC](poc/hudhook-imgui-overlay/README.md) and its
[multi-window handoff](doc/hudhook-multiwindow-compositor-handoff.md) remain the
verified compositor/transport acceptance record and reusable implementation
source.

The first Steam-like input acceptance gate is intentionally behavioral:

- pass-through mode leaves normal game input unchanged;
- intercept mode gives the visible overlay hover, click, drag, wheel, keyboard,
  text, focus, and pointer-capture behavior;
- the game does not observe the same mouse or keyboard activity through window
  messages, raw input, or polling while interception is active;
- game cursor confinement/recentering no longer prevents overlay interaction;
- release, focus loss, transport failure, or shutdown restores safe game input.

The controlled D3D11/D3D12, controlled production-client D3D12, standalone Gun
Frog, and real client/SDK Gun Frog portions of that gate are complete. The
unsigned ReShade full add-on runtime is limited to controlled or permitted
offline/single-player targets. Competitive and anti-cheat-protected software,
anti-cheat bypasses, and VR are outside this POC.

The backend-neutral Electron transport, ordered scene, and input router now live
in `poc/electron-overlay-core` and are shared by the retained hudhook renderer
and a versioned C ABI. A separate ReShade compositor target links that core
without changing the proven native input gates. Its first D3D11 live-producer
run grew into accepted D3D11 and D3D12 scenes that render both overlapping
Electron OSR windows and route exact blocked legacy and primary mouse-pointer
input through the shared core. The pinned ReShade patches closed the additional
Unity mouse-in-pointer path exposed by Gun Frog while leaving ReShade as the
only game-side suppression authority.

ReShade's managed ImGui input state is sampled once per `Present`. That is
appropriate for native ImGui controls. Electron input instead uses the
project-owned ordered observer queue, so its accepted route does not depend on
the `Present` sample.

## Run the active ReShade POC

Install the JavaScript dependencies with `npm install`, use a Visual Studio
Developer PowerShell, and launch one named test case:

```powershell
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d11-electron-scene.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-electron-scene.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d11-client-sdk-process-start-injection.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk-process-start-injection.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\gun-frog-electron-scene.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\gun-frog-client-sdk.ps1
```

The deterministic production integration gate is `d3d12-client-sdk.ps1`: it
drives the real client and public SDK through two isolated controlled D3D12
cycles and emits `D3D12_REAL_CLIENT_SDK_GATE_PASS`. The preferred real-game gate
is `gun-frog-client-sdk.ps1`: it arms the SDK ReShade launcher for `Gun Frog.exe`
before Steam starts the game and validates the four Electron menu clicks plus
the Ctrl+I release acknowledgement. Use
`d3d12-client-sdk-reinjection.ps1` for the restart case: it keeps one Electron
client alive, closes and reopens the controlled target, and injects both times
through the frontend. For a hands-on dev run, use
`npm run dev:gun-frog`, wait for the injector to arm, then launch Gun Frog
yourself. Neither gate is evidence for late injection or arbitrary games. The
[ReShade POC README](poc/reshade-imgui-overlay/README.md) contains the complete
safety boundary, prerequisites, evidence markers, and retained limitations.

The exact-PID process-start launchers above cover a different ordering: the
process already exists, but its primary thread has not been resumed and graphics
initialization has not begun. Accepted evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623`
and `build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642`.
A separate controlled probe that waited three seconds after D3D11/D3D12
rendering had started did load `ReShade64.dll`, but it did not adopt the existing
device or swap chain and never initialized the runtime, add-on, or Electron
scene. Post-render injection is therefore unsupported rather than implied by the
new PID option.

## game overlay solution

- DirectX hook, draw in game
- support any GUI framework, use the power of web/Electron/WPF/Qt to inject any app to overlay in your game
- easy window management
- input intercept in game

## screenshot

![demo](https://raw.githubusercontent.com/hiitiger/goverlay/master/screenshot/gelectron3.gif)

## Run the retained hudhook POC

Install the JavaScript dependencies with `npm install`, then use one of the
named launchers in the [test-case catalog](poc/hudhook-imgui-overlay/scripts/test-cases/README.md).
For example:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-client.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-real-client.ps1
```

The [hudhook POC README](poc/hudhook-imgui-overlay/README.md) contains the Visual Studio,
Rust, CMake, and controlled-target prerequisites plus the complete acceptance
matrix.

`npm run build` builds `electron-game-overlay`, stages the pinned patched
ReShade runtime, injector, add-on, configuration, and build stamp under
`libs/electron-game-overlay/dist/runtime/win32-x64/reshade`, then builds the demo
client against that SDK. The active launcher takes an executable process name
and an optional exact PID, and lets ReShade select the graphics API; application
code no longer chooses a D3D11/D3D12 payload. PID reuse/process-creation identity
beyond PID plus basename, arbitrary watcher latency, and package publishing are
deferred hardening. Retained hudhook artifacts and launchers remain historical
test support, not the normal client path.

The original `libs/node-game-overlay` and `libs/native-game-overlay` trees remain
as legacy source reference, but they are no longer dependencies of the active
client build or runtime.

## use in your own project

1. checkout [document](https://github.com/hiitiger/gelectron/blob/master/doc/doc.md) about how to use it in your own project

## feature

- [x] electron offscreen window overlay in game
- [x] dx12 api support
- [x] dx11 api support
- [x] dx10 api support
- [x] dx9 api support
- [ ] OpenGL api support
- [ ] native draw overlay
- [ ] hardware acc osr bitmap transport
- [x] multi windows support
- [x] window z-index and focus
- [x] in game sync drag and resize
- [ ] in game defered drag and resize
- [x] window draw policy
- [x] input intercepting by manually control
- [x] custom shaped window (alpha test for mouse handling)
- [x] input intercepting by auto mouse check
- [x] brwoser window state manage
- [x] better hotkey
- [x] session reconnect

## support

contact me if had issues with specific features or in-game performance.

contact me for other GUI frameworks support or need any special feature.

## note

Many games block dll injection, please sign dll files with your certificate.

## products using goverlay

- FACEIT: https://www.faceit.com/, competitive gaming platform
- Guilded: https://www.guilded.gg/, game chat
- OP.GG: https://www.op.gg/, game statistic platform
- senpai.gg: https://senpai.gg/, game statistic and assistant
- Medal.tv: https://medal.tv/, game recording software
- GG Recorder: https://game-recorder.com/, game recording software
