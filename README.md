# DirectX hook and game overlay solution for any desktop GUI like Electron, Qt, CEF and WPF⚡

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/4fe290657a91448caecaa5583c84b9d1)](https://www.codacy.com/gh/hiitiger/goverlay/dashboard?utm_source=github.com&utm_medium=referral&utm_content=hiitiger/goverlay&utm_campaign=Badge_Grade)

[![Build status](https://ci.appveyor.com/api/projects/status/sgi7go37f72f52a5?svg=true)](https://ci.appveyor.com/project/hiitiger/goverlay)

## ReShade + ImGui host migration

The active native-host direction is the
[ReShade + ImGui POC](poc/reshade-imgui-overlay/README.md). ReShade 6.7.3 full
add-on support is being evaluated as the maintained process-entry, graphics,
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
the same four-control gate against Gun Frog on July 13; the active client host
switch is complete for that accepted process-name, arm-before-launch path.

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

The controlled D3D11/D3D12, standalone Gun Frog, and real client/SDK Gun Frog
portions of that gate are complete. The unsigned ReShade full add-on runtime is
limited to controlled or permitted
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
.\poc\reshade-imgui-overlay\scripts\test-cases\gun-frog-electron-scene.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\gun-frog-client-sdk.ps1
```

The preferred Gun Frog gate is `gun-frog-client-sdk.ps1`: it builds and launches
the real client, arms the SDK ReShade launcher for `Gun Frog.exe` before Steam
starts the game, and validates the four Electron menu clicks plus the Ctrl+I
release acknowledgement. For a hands-on dev run, use `npm run dev:gun-frog`,
wait for the injector to arm, then launch Gun Frog yourself. This is not evidence
for late injection or arbitrary games. The
[ReShade POC README](poc/reshade-imgui-overlay/README.md) contains the complete
safety boundary, prerequisites, evidence markers, and retained limitations.

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
and lets ReShade select the graphics API; application code no longer chooses a
D3D11/D3D12 payload. Retained hudhook artifacts and launchers remain historical
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
