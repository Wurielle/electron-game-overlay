# Historical hudhook D3D11 and D3D12 test-case launchers

These cases are retained POC regressions. They do not participate in the normal
SDK build or stage a production runtime. Current ReShade/SDK acceptance cases
live under `libs/electron-game-overlay-runtime/scripts/test-cases`.

Every historical case keeps a zero-argument PowerShell file in this directory so
it remains discoverable. Runnable controlled-host launchers resolve the shared
runner relative to their location, build what they need, stay attached, and
clean up their controlled processes. The three client-bound launchers named
below are archived records: they deliberately exit immediately with current
ReShade migration guidance.

List the available cases:

```powershell
Get-ChildItem .\poc\hudhook-imgui-overlay\scripts\test-cases\*.ps1
```

Launch one, for example:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-manual.ps1
```

No separate `client:dev` process is needed for a runnable controlled-host case.
Run only one such case at a time, and
close Izabela Next or any other active overlay producer before starting. This
POC publishes one well-known discovery document for the authenticated loopback
session, so concurrent producers would replace each other's rendezvous metadata.

| Launcher                             | Kind                  | What it proves                                                                              | How it finishes                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| `dx11-hook-only.ps1`                 | Manual                | hudhook injection, ImGui rendering, generated texture, and resize handling without Electron | Press Escape in the host        |
| `dx11-electron-diagnostic.ps1`       | Manual                | Synthetic Electron OSR frame transport, upload, and composition                             | Press Escape in the host        |
| `dx11-real-client.ps1`               | Archived              | Recorded client/POC runtime lifecycle and `ExampleMainOverlay` composition                   | Exits with D3D11 migration guidance |
| `dx11-real-game-input-manual.ps1`    | Archived              | Recorded real-game ImGui/Electron and game-suppression investigation                        | Exits with manual ReShade guidance |
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
| `d3d12-real-client.ps1`              | Archived              | Recorded client/POC D3D12 lifecycle and `ExampleMainOverlay` composition                    | Exits with D3D12 migration guidance |
| `d3d12-window-lifecycle.ps1`         | Automated then manual | D3D12 bounds, close, clear, re-registration, and resumed composition                        | Press Escape after verification |
| `d3d12-input-automated.ps1`          | Automated             | D3D12 focus, click, typing, wheel, interception, release, and cleanup                       | Closes itself                   |
| `d3d12-input-manual.ps1`             | Manual                | Hands-on D3D12 single-window input                                                          | Use the host title-bar X        |
| `d3d12-multiwindow-automated-100.ps1` | Automated            | D3D12 composition, routing, capture, z-order, caption dragging, and cleanup                 | Closes itself                   |
| `d3d12-multiwindow-manual.ps1`       | Manual                | Hands-on D3D12 two-window compositor                                                        | Use the host title-bar X        |

`dx11-real-game-input-manual.ps1` records the former non-controlled game case.
It is not runnable now that the production client no longer contains the
hudhook launcher. When the case was active, its two independent acceptance gates
required native ImGui/Electron pointer receipt and zero game hover/click/movement
underneath. Gun Frog failed the second gate, which is why production input
ownership moved to ReShade. Run `npm run dev`, arm the permitted target by name
or exact PID, and use **Ctrl+I** for current hands-on real-game testing.

The `dx11-real-client.ps1` and `d3d12-real-client.ps1` files document the former
controlled client/POC integration. They are not runnable and intentionally fail
before building or launching anything. Hudhook is no longer bundled under
`libs/electron-game-overlay/dist/runtime/win32-x64`; current application testing
must use the production ReShade launchers named in each archived file.

Hudhook flags and launcher behavior described by these cases are historical POC
interfaces, not supported production-client configuration. The production SDK
uses ReShade name-only or exact-PID targeting.

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

The raw runner remains the source of truth for runnable controlled-host cases;
their launcher files bind one named case to one fixed argument set. The three
archived files contain only their retirement reason and replacement command.
