# D3D11 and D3D12 test-case launchers

Each PowerShell file in this directory is one complete test case with no required
parameters. Run a launcher from the repository root; it resolves the shared
runner relative to its own location, builds what it needs, stays attached, and
cleans up the controlled processes when the case finishes.

List the available cases:

```powershell
Get-ChildItem .\poc\hudhook-imgui-overlay\scripts\test-cases\*.ps1
```

Launch one, for example:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-manual.ps1
```

No separate `client:dev` process is needed. Run only one case at a time, and
close Izabela Next or any other active overlay producer before starting. This
POC publishes one well-known discovery document for the authenticated loopback
session, so concurrent producers would replace each other's rendezvous metadata.

| Launcher                             | Kind                  | What it proves                                                                              | How it finishes                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| `dx11-hook-only.ps1`                 | Manual                | hudhook injection, ImGui rendering, generated texture, and resize handling without Electron | Press Escape in the host        |
| `dx11-electron-diagnostic.ps1`       | Manual                | Synthetic Electron OSR frame transport, upload, and composition                             | Press Escape in the host        |
| `dx11-real-client.ps1`               | Manual                | SDK-owned runtime/attach lifecycle and `ExampleMainOverlay` composition                     | Press Escape in the host        |
| `dx11-window-lifecycle.ps1`          | Automated then manual | Bounds, close, clear, re-registration, and resumed composition                              | Press Escape after verification |
| `dx11-input-automated.ps1`           | Automated             | Single-window focus, click, typing, wheel, interception, release, and cleanup               | Closes itself                   |
| `dx11-input-manual.ps1`              | Manual                | Hands-on single-window mouse, keyboard, wheel, and focus behavior                           | Use the host title-bar X        |
| `dx11-multiwindow-automated-100.ps1` | Automated             | Multi-window composition, routing, capture, z-order, caption dragging, and cleanup at 100%  | Closes itself                   |
| `dx11-multiwindow-automated-125.ps1` | Automated             | Primary uniform-DPI acceptance proof at 125%                                                | Closes itself                   |
| `dx11-multiwindow-automated-150.ps1` | Automated             | The same deterministic coordinate contract at 150%                                          | Closes itself                   |
| `dx11-multiwindow-automated-200.ps1` | Automated             | The same deterministic coordinate contract at 200%                                          | Closes itself                   |
| `dx11-multiwindow-manual.ps1`        | Manual                | Hands-on two-window input, focus, z-order, controls, capture, and caption dragging          | Use the host title-bar X        |
| `d3d12-hook-only.ps1`                | Manual                | D3D12 hudhook injection, ImGui rendering, generated texture, and resize survival            | Press Escape in the host        |
| `d3d12-electron-diagnostic.ps1`      | Manual                | D3D12 Electron OSR frame transport, repeated upload, and composition                        | Press Escape in the host        |
| `d3d12-real-client.ps1`              | Manual                | SDK-owned D3D12 runtime/attach lifecycle and `ExampleMainOverlay` composition                | Press Escape in the host        |
| `d3d12-window-lifecycle.ps1`         | Automated then manual | D3D12 bounds, close, clear, re-registration, and resumed composition                        | Press Escape after verification |
| `d3d12-input-automated.ps1`          | Automated             | D3D12 focus, click, typing, wheel, interception, release, and cleanup                       | Closes itself                   |
| `d3d12-input-manual.ps1`             | Manual                | Hands-on D3D12 single-window input                                                          | Use the host title-bar X        |
| `d3d12-multiwindow-automated-100.ps1` | Automated            | D3D12 composition, routing, capture, z-order, caption dragging, and cleanup                 | Closes itself                   |
| `d3d12-multiwindow-manual.ps1`       | Manual                | Hands-on D3D12 two-window compositor                                                        | Use the host title-bar X        |

The two real-client launchers start the controlled target first and pass the
backend, target process name, and exact expected PID to the real Electron client.
They intentionally do not pass `--hudhook-runtime-dir`. The client calls the
SDK, which invokes the injector and selected payload from
`libs/electron-game-overlay/dist/runtime/win32-x64`; the runner verifies the
exact four-file SDK build output, configured/start/return markers, exact-PID
connection, and the payload's receipt/upload/composition log beside the DLL.
Injector return alone is not treated as proof that the payload loaded. Every
other Electron launcher retains the external PowerShell-owned injector flow.

Hudhook remains gated by the client's explicit main-process startup configuration.
Once enabled, the controlled auto-target or the existing renderer Attach action
may issue the single validated request. The expected PID correlates the payload
connection after controlled process-name selection; exact-PID selection remains
production-launcher hardening.

The multi-window launchers temporarily clear `HUDHOOK_ELECTRON_WINDOW` so a
stale single-window filter cannot invalidate the case, then restore its original
value before returning.

The controlled D3D11 host establishes Per-Monitor-V2 awareness before HWND
creation, computes its initial outer bounds with `AdjustWindowRectExForDpi`, and
handles `WM_DPICHANGED`. The four numbered multi-window launchers still force one
uniform Electron scale each; they are regression cases, not real mixed-monitor
tests. The current validation machine exposes only one 100% virtual display.
Target-HWND/client-origin ownership, backing BrowserWindow placement, per-target
geometry routing, and a manual differently scaled hardware/VM run remain
post-POC hardening rather than blockers for the D3D11/D3D12 proof.

## Advanced and automated use

The launchers intentionally accept no arguments. CI and scripted matrices can
continue to call the parameterized implementation directly:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx12.ps1 -ClientInput -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx12.ps1 -ClientMultiWindow -Wait
```

The raw runner remains the source of truth; the files here only bind one named
case to one fixed argument set.
