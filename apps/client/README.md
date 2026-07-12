# gelectron

## SDK demo client

From the repository root, run:

```powershell
npm run build
```

On Windows x64 this first builds the `electron-game-overlay` SDK and its
release-mode hudhook injector plus both backend payloads, then builds this demo
client. The relevant output is:

```text
apps/client/dist/main/main.js
libs/electron-game-overlay/dist/runtime/win32-x64/hudhook_overlay_injector.exe
libs/electron-game-overlay/dist/runtime/win32-x64/hudhook_imgui_overlay_dx11.dll
libs/electron-game-overlay/dist/runtime/win32-x64/hudhook_imgui_overlay_dx12.dll
libs/electron-game-overlay/dist/runtime/win32-x64/THIRD_PARTY_NOTICES.md
```

The native build requires Rust 1.85 or newer and Visual Studio 2022 C++ Build
Tools. It uses the locked Cargo workspace and does not build either controlled
test host.

Hudhook remains opt-in and backend selection remains explicit. The client calls
the SDK's public launcher, which resolves the SDK-owned runtime without a
directory argument:

```powershell
.\node_modules\electron\dist\electron.exe . `
  --hudhook-overlay `
  --hudhook-backend=d3d11
```

Use `d3d12` for the D3D12 payload. `--hudhook-runtime-dir=<absolute-path>`
remains a strict development/test override; an invalid override fails instead
of falling back to the bundled files.

The client contains no injector, native payload, or target-correlation
implementation of its own; it is only an SDK acceptance/demo application.
`npm run dev` builds the SDK before starting Vite; restart the dev command after
changing SDK source so the external compiled dependency is rebuilt.
