# SDK usage guide

`electron-game-overlay` publishes Electron offscreen `BrowserWindow` surfaces to
an injected ReShade + Dear ImGui runtime. The SDK owns the producer session,
window lifecycle, frame transport, returned input, target attachment, and safe
restart state. Consumers do not call a native Node add-on or copy DLLs by hand.

## Build the repository package

From the repository root:

```powershell
npm install
npx nx build electron-game-overlay
```

The build compiles the TypeScript SDK and its native dependencies, then stages
the Windows x64 runtime under
`libs/electron-game-overlay/dist/runtime/win32-x64/reshade`. The staged set
includes `inject.exe`, `ReShade64.dll`, `ReShade64.build.json`,
`electron_game_overlay.addon64`, and `ReShade.ini`.

The native toolchain requires Rust, CMake, Git, and Visual Studio 2022 with the
Desktop development with C++ workload. The runtime and add-on are a pinned,
patched pair; do not replace `ReShade64.dll` with a stock ReShade build.

## Create a session and overlay window

Create the session from Electron's main process. The SDK forces created windows
into offscreen rendering mode and sends their paint frames automatically.

```ts
import {
  ElectronGameOverlay,
  ReShadeOverlayLauncher,
  parseReShadeLaunchConfig,
} from 'electron-game-overlay';

const overlay = new ElectronGameOverlay();
const session = overlay.createSession();

session.start();

const window = session.windows.create({
  id: 'main-overlay',
  name: 'Main overlay',
  bounds: { x: 40, y: 40, width: 640, height: 360 },
  captionHeight: 32,
  dragBorder: 6,
  transparent: true,
  file: '/absolute/path/to/overlay.html',
  browserWindow: {
    frame: false,
    transparent: true,
    webPreferences: {
      contextIsolation: true,
    },
  },
});

window.show();
```

Use `session.windows.attach(existingBrowserWindow, options)` when the
application already owns the producer. `show()`, `hide()`, `setBounds()`, and
`destroy()` update the injected scene. Public bounds, caption dimensions, drag
borders, and constraints are Electron device-independent pixels; the SDK
converts them to the physical-pixel wire and composition space.

## Arm and attach the target

The normal launcher reads the bundled runtime from the built SDK:

```ts
const config = parseReShadeLaunchConfig(process.argv);
if (!config) {
  throw new Error('ReShade overlay startup was not enabled');
}

const launcher = new ReShadeOverlayLauncher(config);
await launcher.attach(session, { processName: 'game.exe' });
```

Pass `--reshade-overlay` exactly once to the Electron main process to opt in and
make `parseReShadeLaunchConfig()` return the bundled configuration. The optional
`--reshade-runtime-dir=<absolute-path>` override is for controlled development
and tests; an invalid or incomplete directory fails instead of silently falling
back.

For name-only selection, arm before the target starts. ReShade chooses D3D11 or
D3D12 after it enters the target; there is no graphics-backend option in the
application API.

A process watcher may provide the exact process it just observed:

```ts
await launcher.attach(session, {
  processName: detectedProcess.name,
  pid: detectedProcess.pid,
});
```

The PID must be a positive uint32. The injector verifies the executable
basename before remote mutation. Call this immediately after process creation
and before graphics-device and swap-chain initialization. The runtime does not
currently adopt an already-rendering device or swap chain, so this is not a
general late-attachment API.

`attach()` moves through `idle`, `attaching`, `connected`, and, for an
unprovable injector outcome, `blocked`. A transport close is not treated as
proof that the target exited. Once Windows confirms the selected PID is gone,
the launcher returns to `idle` and the same session can attach a restarted
target. A `blocked` launcher must be disposed before retrying so a live target
cannot accidentally receive a second runtime.

## Input and lifecycle

Request and release interception through the session:

```ts
session.input.intercept();
session.input.release();
```

The request is asynchronous at the native boundary. Applications should reflect
the runtime's effective acknowledgement before treating the overlay as owning
input. The demo client uses Electron's `globalShortcut` for **Ctrl+I**, so the
toggle remains available while the game owns foreground focus.

Before each returned packet, the SDK focuses Chromium's offscreen render widget
without activating the hidden producer window. It translates the injected
runtime's physical coordinates back to Electron DIP using the scale factor that
was active when the packet was routed.

Clean up all three owners:

```ts
launcher.dispose();
session.close();
overlay.dispose();
```

Closing a target process remains the supported injected-runtime teardown. Safe
disable and unload while a target stays alive are deferred hardening.

## Test the integration

Use the dedicated launchers under
`libs/electron-game-overlay-runtime/scripts/test-cases`. For example:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-process-start-injection.ps1
```

New evidence is written below `build/electron-game-overlay-runtime`. Dated
`build/reshade-imgui-overlay/...` paths elsewhere in the documentation are
historical evidence created before the production package was renamed.

Use the unsigned full add-on runtime only with the included controlled hosts or
an offline/single-player target you are allowed to modify. Anti-cheat bypasses,
competitive protected targets, arbitrary post-render injection, and universal
game compatibility are outside the supported boundary.
