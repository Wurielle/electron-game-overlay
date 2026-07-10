# hudhook + ImGui D3D11 proof of concept

This standalone Windows x64 proof uses upstream [hudhook 0.9.1](https://github.com/veeenu/hudhook/tree/0.9.1) unchanged to inject a project-owned DLL, hook a D3D11 swap chain, and render Dear ImGui.

It deliberately does not install or load ReShade. The completed ReShade POC remains beside it as a separate reference implementation.

The payload renders:

- an always-visible diagnostics panel;
- a continuously increasing frame counter;
- the current ImGui display dimensions;
- one real Electron offscreen window received through the repository's existing
  `electron-game-overlay` / `node-game-overlay` flow;
- a generated RGBA checkerboard while the Electron producer is unavailable.

The integrated proof deliberately keeps the Electron window opaque and fixed at
640 x 360. It reuses the add-on's current Win32 IPC, named mutex, and shared
mapping; the injected payload does not load the legacy native renderer.

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

## Run the Electron frame demo

From a regular PowerShell at the repository root:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Wait
```

The runner builds and stages the POC, starts the hidden Electron frame producer,
waits until its first complete 640 x 360 frame has passed through the public SDK,
starts the controlled D3D11 host, injects the hudhook payload, and verifies both
shared-memory receipt and GPU upload in the host's PID-specific log.

Expected result: the controlled host displays an ImGui diagnostics panel
containing the animated `Electron frame inside the game` page. Press Escape in
the host when finished. With `-Wait`, the runner then stops only the Electron
processes it launched and returns the host's exit code.

Running the command without `-Wait` returns after verification and deliberately
leaves both demo processes alive for visual inspection. Close them before the
next run. Only one Electron overlay host should run at a time because the current
native add-on uses a fixed IPC host name.

Useful integrated proof markers are:

- `HUDHOOK_ELECTRON_DEMO_READY` in `electron-demo.stdout.log`;
- `Electron frame bridge connected to Node host`;
- `Electron frame received from node-game-overlay`;
- `Electron frame uploaded to GPU`.

The Electron producer lives in `electron-demo/` and uses
`ElectronGameOverlay -> OverlaySession -> session.windows.create()`. The frame
copy and BGRA-to-RGBA conversion happen on the payload's IPC worker; hudhook's
render thread only uploads the latest owned RGBA snapshot.

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

This milestone covers D3D11 injection, ImGui rendering, the existing
Electron/Node shared-memory frame path, texture upload, resizing, diagnostics,
and normal target exit. It does not yet cover:

- D3D12;
- more than one Electron window;
- transparent Electron frames and premultiplied-alpha correction;
- Electron window resize and texture retirement;
- input forwarding to Electron;
- one-payload backend auto-detection;
- x86 targets;
- anti-cheat compatibility.

The next compositor milestone is input and multi-window lifecycle work; D3D12
remains the next graphics-backend milestone. A hudhook fork is only justified if
testing reproduces a required graphics-hook change that cannot live in this
project or be contributed upstream.
