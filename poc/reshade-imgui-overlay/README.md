# ReShade + ImGui compositor proof of concept

This active Windows x64 proof uses the ReShade 6.7.3 full add-on runtime as the native process-entry, graphics-hook, swap-chain, input, logging, and ImGui layer. It does not use the binary-only overlay runtime already shipped in this repository or the hudhook payload.

The original baseline proved two things inside the target render path:

- an always-visible Dear ImGui diagnostics panel can be rendered while the main ReShade menu is closed;
- a generated RGBA bitmap can be uploaded through ReShade's graphics-agnostic resource API and drawn with `ImGui::Image`.

The current slice adds controlled D3D11 and D3D12 input-gate hosts. ReShade's
public `effect_runtime::block_input_next_frame()` owns game-side blocking, while
an independent host oracle counts window messages, raw input, polling-visible
left-button state, cursor movement, and cursor confinement. The code and staging
launchers are implemented; the visible acceptance runs described below are
pending and must not be reported as passed yet.

The controlled hosts are intentionally plain and owned by this repository. Use
them before trying any external application.

## Safety boundary

Use this only with the included hosts or an offline/single-player application you
are allowed to modify. ReShade's unsigned full add-on build is intentionally not
anti-cheat allowlisted. Do not load this POC in competitive or
anti-cheat-protected software, and do not use it to bypass anti-cheat controls.
Steam-like refers to the overlay's interaction behavior within the supported
target envelope; it does not claim Steam's signing, launcher ownership,
anti-cheat relationships, or per-game compatibility database.

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

ReShade's API headers are BSD-3-Clause/MIT dual-licensed and Dear ImGui is MIT-licensed. Preserve their notices if compiled POC binaries are redistributed. The helper builds the pinned ReShade runtime only into the ignored local build directory; do not commit or redistribute that runtime.

To build the pinned ReShade full-add-on runtime explicitly:

```powershell
.\poc\reshade-imgui-overlay\scripts\build-runtime.ps1
```

The input-gate launchers always validate the cached binary against a local build
stamp, pinned clean source, full-add-on configuration, and SHA-256 hash. A
missing or invalid cache is rebuilt before staging.

## Run the controlled input gates

Each human-facing backend has its own launcher:

```powershell
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d11-native-input-gate.ps1
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-native-input-gate.ps1
```

The launchers build the host and add-on, build or reuse the pinned local ReShade
runtime, and create an isolated directory under
`build/reshade-imgui-overlay/input-gate-d3d11` or
`input-gate-d3d12`. D3D11 stages the runtime as `d3d11.dll`; D3D12 stages it as
`dxgi.dll`. Both stage `ReShade.ini` with `[INPUT] InputProcessing=2`, the add-on,
and the `reshade-input-gate.enabled` marker that enables the controlled host
oracle. The parameterized `scripts/run-input-gate.ps1` runner remains available
for automation and supports `-NoLaunch`.

Visible acceptance is currently pending. For each backend:

1. In pass-through mode, move, click, wheel, and press keys. The `game input`
   counters in the host title should advance and `clip=on` should describe the
   host's deliberately hostile cursor confinement.
2. Press **Ctrl+I** once. The add-on should report `Input: RESHADE-OWNED`; this
   label is requested state, not by itself proof that the gate passed. The
   activating chord is detected at `Present`, so exclude that chord from the
   steady-state counter sample; production uses the Electron-owned global
   shortcut and sends desired state to the add-on instead.
3. Move over the ImGui panel and click `CLICK RE SHADE INPUT PROBE`. The probe
   count must increase, the visible pointer must remain usable, the host's
   message/raw/polling counters must stop advancing, and the title must report
   `clip=off`.
4. Type into `Keyboard probe`, drag `Drag probe`, wheel over the panel, and move
   the cursor while interception stays active. The overlay controls/counters must
   react while none becomes new game-side oracle activity.
5. Resize the host while interception is active. The panel must remain
   `RESHADE-OWNED`, input must remain blocked, and the controls must still work.
6. Press **Ctrl+I** again. Pass-through counters and host cursor confinement must
   resume. Press **Escape** to close the host normally.

A backend fails acceptance if the overlay cannot be operated, if any game-side
counter reacts to intercepted input, if cursor confinement remains active, or if
release/shutdown does not restore normal input.

The texture baseline is part of both isolated input gates: the panel identifies
the graphics API and displays the generated teal checkerboard below the input
controls. If the panel does not appear, inspect `ReShade.log` in that backend's
staged input-gate directory.

## What this does not prove yet

- Electron frame transport or shared-memory compatibility;
- per-window state, z-order, clipping, or dirty-frame updates;
- completed visible D3D11/D3D12 input-gate acceptance;
- mouse/keyboard forwarding back to Electron;
- an attach-by-PID flow independent of ReShade installation;
- anti-cheat compatibility;
- VR rendering (`reshade_overlay` is not called for VR runtimes).

After the native input gates pass, the next step is to connect the existing
authenticated Electron loopback transport, Rust wire/frame/input router, ordered
multi-window scene, and TypeScript input translation behind the ReShade add-on
boundary. Those components are retained from the hudhook POC; ReShade replaces
the injected host, graphics lifecycle, ImGui ownership, and game-side input
blocking rather than the Electron SDK contract.
