# Target following and telemetry

This example attaches to one exact process and then sizes an Electron overlay
window from live render-target metadata. It also listens for surface changes,
surface removal, FPS samples, diagnostics, and overlay focus events.

```powershell
npm run demo:target-follow -- --target-process="Game.exe" --target-pid=1234 --target-path="C:\Games\Game.exe"
```

`--target-process` and `--target-pid` are required; `--target-path` is optional.
This command is an API-shape/reference path unless the target is cooperating
and still held before graphics initialization. A real application prepares the
launcher while Electron is already running and supplies these values directly
from its process watcher.

The renderer offers both follow modes supported by the SDK:

- `render` follows the graphics surface dimensions. This is normally the right
  choice for a fullscreen overlay.
- `client` follows the Win32 client rectangle. This is useful when UI should
  align with a windowed game's client area.

`OverlayTargetSurface` snapshots include target-local `clientBounds`, physical
screen-space client/window/monitor rectangles, graphics API, DPI, focus,
minimization, visibility, and fullscreen state. The SDK performs the conversion
required by Electron when it follows a target; application code does not need
to resize the `BrowserWindow` itself.
