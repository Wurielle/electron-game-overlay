# electron-game-overlay

This package publishes offscreen Electron `BrowserWindow` scenes inside Windows
games and routes intercepted game input back to those windows.

Start with the [project guide](../../README.md):

- [how the overlay works](../../README.md#how-it-works);
- [application setup](../../README.md#application-setup);
- [target attachment](../../README.md#attach-to-a-target);
- [windows, input, telemetry, failures, and lifecycle](../../README.md#create-overlay-windows);
- [the API map and canonical declaration sources](../../README.md#api-map);
- [limitations and safety](../../README.md#limitations-and-safety).

Small runnable applications live under [`demos`](../../demos).

Build this package from the workspace root:

```powershell
npx nx build electron-game-overlay
```

Run its unit and integration tests with:

```powershell
npx nx run electron-game-overlay:test
```

The build writes JavaScript and declarations to `dist` and stages the Windows
runtime under `dist/runtime/win32-x64/reshade`. See the repository
[`LICENSE`](../../LICENSE) for licensing terms.
