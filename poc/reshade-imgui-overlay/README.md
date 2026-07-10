# ReShade + ImGui compositor proof of concept

This standalone Windows x64 proof uses the ReShade 6.7.3 full add-on runtime as the native process-entry, graphics-hook, swap-chain, input, logging, and ImGui layer. It does not use the binary-only overlay runtime already shipped in this repository.

The add-on proves two things inside the target render path:

- an always-visible Dear ImGui diagnostics panel can be rendered while the main ReShade menu is closed;
- a generated RGBA bitmap can be uploaded through ReShade's graphics-agnostic resource API and drawn with `ImGui::Image`.

The included D3D11 host is intentionally plain and owned by this repository. Use it before trying any external application.

## Safety boundary

Use this only with the included host or an offline/single-player application you are allowed to modify. ReShade's full add-on build is intentionally not anti-cheat allowlisted. Do not load this POC in competitive or anti-cheat-protected software.

## Build

Requirements:

- Windows 10 or newer;
- Visual Studio 2022 with the Desktop development with C++ workload;
- CMake 3.24 or newer;
- Git;
- an internet connection for the first configure, which fetches the pinned ReShade and ImGui headers.

From a Visual Studio Developer PowerShell opened at the repository root:

```powershell
Push-Location poc/reshade-imgui-overlay
cmake --preset vs2022-x64
cmake --build --preset relwithdebinfo
Pop-Location
```

The build pins:

- ReShade `v6.7.3` and its add-on API headers;
- Dear ImGui `v1.92.5-docking`, the exact ABI version expected by that ReShade release.

No ReShade or ImGui source is checked into version control. The first configure downloads both into the ignored build directory.

ReShade's API headers are BSD-3-Clause/MIT dual-licensed and Dear ImGui is MIT-licensed. Preserve their notices if compiled POC binaries are redistributed. Do not commit or redistribute the downloaded ReShade setup/runtime; link users to the official download instead.

## Run against the controlled D3D11 host

1. Download the official **ReShade 6.7.3 with full add-on support** installer from [reshade.me](https://reshade.me/).
2. In that installer, select `build/reshade-imgui-overlay/RelWithDebInfo/d3d11_overlay_test_host.exe`.
3. Select the DirectX 10/11/12 renderer when prompted. Installing an effect package is optional for this proof.
4. Confirm these files sit next to the test host:
   - the ReShade proxy DLL installed by the official setup tool;
   - `alternative_imgui_overlay_poc.addon64` (the build copies it automatically).
5. Start `d3d11_overlay_test_host.exe`.
6. On the first ReShade launch, press Home and complete its short tutorial once. The POC panel is positioned below ReShade's own first-run banner.

Expected result: the animated dark background has a panel near its upper-left corner. The panel identifies the active graphics API, counts rendered frames, and displays a teal checkerboard texture. Resize the host window to exercise ReShade's swap-chain lifecycle. Press Escape to close it.

If the panel does not appear, inspect `ReShade.log` beside the executable. It should report loading `Alternative ImGui Compositor POC`, creating the GPU texture, and rendering the first ImGui frame.

If you skipped effect-package installation, a warning about a missing `reshade-shaders` search path is expected and does not affect this add-on.

## What this does not prove yet

- Electron frame transport or shared-memory compatibility;
- per-window state, z-order, clipping, or dirty-frame updates;
- mouse/keyboard forwarding back to Electron;
- an attach-by-PID flow independent of ReShade installation;
- anti-cheat compatibility;
- VR rendering (`reshade_overlay` is not called for VR runtimes).

The next useful step is to replace the generated texture with a versioned shared-memory BGRA frame and update it only when the producer publishes a new sequence number.
