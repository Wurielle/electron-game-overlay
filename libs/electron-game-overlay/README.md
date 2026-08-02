# electron-game-overlay

This folder contains the public Electron/TypeScript SDK. It publishes offscreen
`BrowserWindow` scenes to authenticated injected targets and stages the x64/x86
Windows runtime used by `ReShadeOverlayLauncher`.

The authoritative project guide is the [root README](../../README.md). It
contains:

- [requirements and build instructions](../../README.md#requirements-and-build);
- a [complete minimal application](../../README.md#minimal-application);
- the [standalone examples](../../README.md#readable-examples);
- attachment, input, telemetry, lifecycle, and ReShade coexistence guidance;
- the [complete public API reference](../../README.md#public-api-reference);
- compatibility, safety, and testing boundaries.

Build this package from the workspace root:

```powershell
npx nx build electron-game-overlay
```

Run its unit and integration tests with:

```powershell
npx nx run electron-game-overlay:test
```

The build writes JavaScript and declarations to `dist` and stages the composite
Windows runtime under `dist/runtime/win32-x64/reshade`. Consumers do not load a
native Node add-on.

This package is private and not currently published to npm. See the repository
[`LICENSE`](../../LICENSE) for licensing terms.
