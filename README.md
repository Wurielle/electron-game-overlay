# DirectX hook and game overlay solution for any desktop GUI like Electron, Qt, CEF and WPF⚡

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/4fe290657a91448caecaa5583c84b9d1)](https://www.codacy.com/gh/hiitiger/goverlay/dashboard?utm_source=github.com&utm_medium=referral&utm_content=hiitiger/goverlay&utm_campaign=Badge_Grade)

[![Build status](https://ci.appveyor.com/api/projects/status/sgi7go37f72f52a5?svg=true)](https://ci.appveyor.com/project/hiitiger/goverlay)

## hudhook + ImGui migration POC

The maintained-runtime migration is documented in the
[hudhook + ImGui POC](poc/hudhook-imgui-overlay/README.md). Its current verified
scope is deliberately narrower than the legacy feature list below: controlled
Windows x64/D3D11 and D3D12, real-client-owned hudhook injection, simultaneous
overlapping Electron windows with deterministic back-to-front ordering and
click-to-front behavior, and regular Win32 mouse, wheel, keyboard, system-key,
and character input with focus and pointer capture.
The completed multi-window design and acceptance record is in the
[hudhook multi-window compositor handoff](doc/hudhook-multiwindow-compositor-handoff.md).
With `HUDHOOK_ELECTRON_WINDOW` unset, the payload composes every announced
window; setting it opts into an exact-name filter.
Electron frames and input now use an authenticated loopback transport built on
Node core networking; the active client/SDK path does not load the legacy native
Node add-on or shared-memory renderer. X1/X2 and raw input are blocked but not
forwarded during interception. Target-display/client-origin ownership, physical
mixed-monitor acceptance, safe texture retirement, broader input APIs, and a
production injector remain post-POC work.

## game overlay solution 
* DirectX hook, draw in game
* support any GUI framework, use the power of web/Electron/WPF/Qt to inject any app to overlay in your game
* easy window management
* input intercept in game

## screenshot

![demo](https://raw.githubusercontent.com/hiitiger/goverlay/master/screenshot/gelectron3.gif)

## Run the maintained POC

Install the JavaScript dependencies with `npm install`, then use one of the
named launchers in the [test-case catalog](poc/hudhook-imgui-overlay/scripts/test-cases/README.md).
For example:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-client.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-real-client.ps1
```

The [POC README](poc/hudhook-imgui-overlay/README.md) contains the Visual Studio,
Rust, CMake, and controlled-target prerequisites plus the complete acceptance
matrix.

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
