# hudhook + ImGui D3D11 proof of concept

This standalone Windows x64 proof uses upstream [hudhook 0.9.1](https://github.com/veeenu/hudhook/tree/0.9.1) unchanged to inject a project-owned DLL, hook a D3D11 swap chain, and render Dear ImGui.

It deliberately does not install or load ReShade. The completed ReShade POC remains beside it as a separate reference implementation.

The payload renders:

- an always-visible diagnostics panel with frame and display information;
- one selected Electron offscreen window received through the repository's existing
  `electron-game-overlay` / `node-game-overlay` flow;
- a generated RGBA checkerboard while no selected Electron window is available.

The compositor selects one window by preferring `HUDHOOK_ELECTRON_WINDOW`, then
`ExampleMainOverlay`, then the first announced window. It draws that window at
its signed native bounds, honors transparency, and follows bounds, close, and
re-registration events. Premultiplied BGRA frames are converted to straight RGBA
on the IPC worker; hudhook's render thread only uploads the latest owned snapshot.
The injected payload does not load the legacy native renderer.

## Safety boundary

Use this only with the included controlled host or offline/single-player software you are allowed to modify. Do not inject it into competitive or anti-cheat-protected software.

The injector, payload, and target must have the same architecture and integrity level. This first proof is x64-only.

## Requirements

- Windows 10 or newer;
- Visual Studio 2022 C++ Build Tools and a Windows SDK;
- CMake 3.24 or newer;
- Git, used by the controlled host's CMake dependency fetch;
- Rust 1.85 or newer with the `x86_64-pc-windows-msvc` target;
- an internet connection for the first Cargo build.

The Cargo workspace pins hudhook to exactly `0.9.1` and commits `Cargo.lock` for reproducibility.

## Build

From a regular PowerShell opened at the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\build-dx11.ps1
```

The script locates the build tools, enters the Visual Studio developer environment, builds the existing controlled D3D11 host, builds the Rust injector and payload, recreates the ignored run directory, and stages only these files in `build/hudhook-imgui-overlay/run/dx11`:

- `d3d11_overlay_test_host.exe`;
- `hudhook_imgui_overlay_dx11.dll`;
- `hudhook_overlay_injector.exe`;
- `THIRD_PARTY_NOTICES.md`.

The clean run directory intentionally contains no ReShade proxy, configuration, or add-on files.

## Run the real client integration (recommended)

From a regular PowerShell at the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Client -Wait
```

`-Client` builds the repository's real Electron application, launches it with the
opt-in `--start-overlay-session` flag, waits for its existing overlay session to
register `ExampleMainOverlay`, starts the controlled D3D11 host, injects the
hudhook payload, and requires fresh receipt, upload, selection, and composition
evidence in the host's PID-specific log.

Expected result: the real transparent `ExampleMainOverlay` is drawn inside the
controlled host at its native Electron bounds, with the diagnostics kept separate
in the top-right corner. Press Escape in the host when finished. With `-Wait`, the
runner stops only the Electron process tree it launched and returns the host exit
code.

Useful proof markers are:

- `HUDHOOK_CLIENT_OVERLAY_SESSION_READY` in `electron-client.stdout.log`;
- `Electron overlay metadata selected`;
- `window_name=ExampleMainOverlay`;
- `Electron frame received from node-game-overlay`;
- `Electron frame uploaded to GPU`;
- `Electron overlay composed at native bounds`.

Set `HUDHOOK_ELECTRON_WINDOW` before launching the runner to select an exact
announced window name. Without it, the payload prefers `ExampleMainOverlay` and
then falls back to the first announced window.

## Run the lifecycle regression demo

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientWindow -Wait
```

This focused producer loads the client's actual `ExampleMainOverlay` HTML through
the public overlay SDK. It creates a transparent 640 x 360 window at `(64, 72)`
and waits for the injected payload's `game.process` connection event before
starting its timers. It then moves to `(176, 128)`, closes, and re-registers.
The runner requires bounds, close, clear, reselection, and resume proof before
the verification deadline.

The corresponding payload markers are:

- `Electron overlay bounds updated`;
- `Electron overlay window closed`;
- `Electron overlay composition cleared`;
- `Electron overlay metadata reselected`;
- `Electron overlay composition resumed`.

## Run the minimal diagnostic producer

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Wait
```

This original synthetic frame producer remains useful for a quick SDK/IPC/upload
smoke test. Its readiness marker is `HUDHOOK_ELECTRON_DEMO_READY` in
`electron-demo.stdout.log`.

## Runner lifetime

Running an Electron mode without `-Wait` returns after verification and leaves the
controlled host and only that mode's Electron process tree alive for inspection.
Close them before the next run. Only one Electron overlay host should run at a time
because the current native add-on uses a fixed IPC host name.

## Run the hook-only fallback

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-dx11.ps1
```

This starts only the controlled host and payload. With no Electron producer, the
panel shows the generated teal checkerboard. The runner waits for the current
process's payload log to prove texture upload and first-frame rendering; it fails
instead of trusting the injector's return code alone. Resize the window to
exercise hudhook's swap-chain handling. Press Escape in the host to close it.

The payload creates a PID-suffixed log beside the injected DLL:

```text
build/hudhook-imgui-overlay/run/dx11/hudhook_imgui_overlay_dx11-<pid>.log
```

Useful markers include:

- `hudhook overlay initialization worker started`;
- `generated RGBA texture uploaded`;
- `first ImGui frame rendered`;
- `ImGui display size changed`.

Set `HUDHOOK_POC_LOG` in the host's environment to override the default `info,hudhook=debug` tracing filter. Avoid `hudhook=trace` for long sessions because the D3D11 hook traces every presentation.

If the payload directory is not writable during a manual test, logging falls back to `%TEMP%\electron-game-overlay`.

## Manual injection

The injector accepts one exact target selector and an explicit backend:

```powershell
Push-Location .\build\hudhook-imgui-overlay\run\dx11
.\hudhook_overlay_injector.exe `
  --process game.exe `
  --backend d3d11
Pop-Location
```

or:

```powershell
Push-Location .\build\hudhook-imgui-overlay\run\dx11
.\hudhook_overlay_injector.exe `
  --title "Exact window title" `
  --backend d3d11 `
  --dll .\hudhook_imgui_overlay_dx11.dll
Pop-Location
```

hudhook 0.9.1 selects the first exact process-name match. Prefer `--title` when more than one matching process may exist.

The message `Injection request completed` means hudhook's remote-thread injection call returned without a Windows API error. The visible panel and payload log are the actual evidence that the DLL loaded and rendered.

### Injector limitation

The upstream hudhook 0.9.1 injector is sufficient for this controlled POC, but it is not the intended production launcher. It does not reject a zero return from remote `LoadLibraryW`, and its fixed `MAX_PATH` copy reads beyond the source path buffer. The controlled runner compensates for the first issue by requiring fresh payload evidence, but the production launcher should use a small project-owned injector—or an upstream hudhook fix—that sizes the remote buffer from the actual path and validates every Windows API result.

This does not require forking or modifying hudhook's graphics hooks, renderer lifecycle, or ImGui integration.

## Current scope

This milestone now covers:

- D3D11 injection and Dear ImGui rendering through upstream hudhook 0.9.1;
- the real built Electron client's existing overlay-session startup path;
- one selected Electron window over the existing Node/shared-memory IPC;
- signed native bounds, transparency, and premultiplied-BGRA correction;
- immediate bounds metadata updates without redundant texture uploads;
- close, clear, re-register, and resume lifecycle handling;
- texture replacement when the Electron frame dimensions change;
- diagnostics, resize handling, proof logging, and normal target exit.

Remaining work is:

- input forwarding and focus/capture policy;
- simultaneous composition of multiple Electron windows and explicit z-order;
- DPI and device-scale-factor reconciliation beyond the controlled 1:1 setup;
- safe deferred retirement of superseded GPU textures;
- D3D12 and eventual one-payload backend auto-detection;
- a production-quality project-owned injector;
- x86 targets and any anti-cheat compatibility work.

The next milestone is input/interactivity for the selected window; follow
[`doc/hudhook-input-interactivity-handoff.md`](../../doc/hudhook-input-interactivity-handoff.md).
Multiple-window/z-order behavior follows, while D3D12 remains the next graphics
backend milestone. A hudhook fork is only justified if testing reproduces a
required graphics-hook change that cannot live in this project or be contributed
upstream.
