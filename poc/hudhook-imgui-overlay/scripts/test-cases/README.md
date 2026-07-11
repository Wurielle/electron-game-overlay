# DX11 test-case launchers

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
close Izabela Next or any other process using the fixed node-game-overlay IPC
host before starting.

| Launcher                             | Kind                  | What it proves                                                                              | How it finishes                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| `dx11-hook-only.ps1`                 | Manual                | hudhook injection, ImGui rendering, generated texture, and resize handling without Electron | Press Escape in the host        |
| `dx11-electron-diagnostic.ps1`       | Manual                | Synthetic Electron OSR frame transport, upload, and composition                             | Press Escape in the host        |
| `dx11-real-client.ps1`               | Manual                | The real `ExampleMainOverlay` integration through the public SDK                            | Press Escape in the host        |
| `dx11-window-lifecycle.ps1`          | Automated then manual | Bounds, close, clear, re-registration, and resumed composition                              | Press Escape after verification |
| `dx11-input-automated.ps1`           | Automated             | Single-window focus, click, typing, wheel, interception, release, and cleanup               | Closes itself                   |
| `dx11-input-manual.ps1`              | Manual                | Hands-on single-window mouse, keyboard, wheel, and focus behavior                           | Use the host title-bar X        |
| `dx11-multiwindow-automated-100.ps1` | Automated             | Multi-window composition, routing, capture, z-order, caption dragging, and cleanup at 100%  | Closes itself                   |
| `dx11-multiwindow-automated-125.ps1` | Automated             | Primary uniform-DPI acceptance proof at 125%                                                | Closes itself                   |
| `dx11-multiwindow-automated-150.ps1` | Automated             | The same deterministic coordinate contract at 150%                                          | Closes itself                   |
| `dx11-multiwindow-automated-200.ps1` | Automated             | The same deterministic coordinate contract at 200%                                          | Closes itself                   |
| `dx11-multiwindow-manual.ps1`        | Manual                | Hands-on two-window input, focus, z-order, controls, capture, and caption dragging          | Use the host title-bar X        |

The multi-window launchers temporarily clear `HUDHOOK_ELECTRON_WINDOW` so a
stale single-window filter cannot invalidate the case, then restore its original
value before returning.

## Advanced and automated use

The launchers intentionally accept no arguments. CI and scripted matrices can
continue to call the parameterized implementation directly:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
```

The raw runner remains the source of truth; the files here only bind one named
case to one fixed argument set.
