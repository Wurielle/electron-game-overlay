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

## Read target state and follow its surface

After the injected swap chain starts rendering, the session exposes retained,
immutable target telemetry:

```ts
session.on('targetSurfaceChanged', (surface) => {
  console.log(surface.pid, surface.hwnd, surface.graphicsApi);
  console.log(surface.renderSize, surface.clientScreenBounds, surface.dpi);
});

session.on('targetSurfaceRemoved', ({ pid, surfaceId }) => {
  console.log('surface ended', pid, surfaceId);
});

session.on('fps', ({ pid, fps }) => {
  console.log('injected render FPS', pid, fps);
});

const liveSurfaces = session.targets.list();
const surface = session.targets.get(targetPid, surfaceId);
```

The runtime reports physical render/client/window geometry, DPI, monitor and
work-area bounds, target state, and the selected graphics API. The SDK adds the
authenticated PID and computes `dpi.scaleFactor`. FPS comes from the injected
render context rather than Chromium paints.

Use target-follow mode for an Electron surface that must cover the game:

```ts
window.followTarget({ area: 'render' });

// Pin a specific retained surface, or use client-area dimensions instead.
window.followTarget({ pid: targetPid, surfaceId, area: 'client' });

window.stopFollowingTarget();
```

With no selectors, the newest live surface is used. The hidden backing window
is moved to the target monitor in Electron DIP, while the injected compositor
receives game-local physical bounds starting at `(0, 0)`. Resizes and display,
DPI, or fullscreen changes are reapplied automatically. The previous raster
stays active until Electron paints the matching new size. Stopping follow mode
restores the window's pre-follow content bounds.

## Arm and attach the target

The normal launcher reads the bundled runtime from the built SDK:

```ts
const config = parseReShadeLaunchConfig(process.argv);
if (!config) {
  throw new Error('ReShade overlay startup was not enabled');
}

const launcher = new ReShadeOverlayLauncher(config);
const result = await launcher.attach(session, { processName: 'game.exe' });
console.log(result.runtimeMode, result.hostRuntimePath);
```

Pass `--reshade-overlay` exactly once to the Electron main process to opt in and
make `parseReShadeLaunchConfig()` return the bundled configuration. The optional
`--reshade-runtime-dir=<absolute-path>` override is for controlled development
and tests; an invalid or incomplete directory fails instead of silently falling
back.

For name-only selection, arm before the target starts. ReShade chooses D3D11 or
D3D12 after it enters the target; there is no graphics-backend option in the
application API.

Every successful injector run must produce one strict structured result.
`runtimeMode` is `injected-runtime` when the staged ReShade DLL was loaded, or
`existing-runtime` when a compatible host was reused; the latter also supplies
`hostRuntimePath`. `reshadeLogPath` points into the staged run in injected mode.
For an existing host it is inferred beside the host module, so a ReShade
`[INSTALL] BasePath` override can place the authoritative log elsewhere.

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
general late-attachment API. A compatible existing runtime must additionally
still expose its private ABI-1 add-on gate in the `OPEN` state.

`attach()` moves through `idle`, `attaching`, `connected`, and, for an
unprovable injector outcome, `blocked`. A transport close is not treated as
proof that the target exited. Once Windows confirms the selected PID is gone,
the launcher returns to `idle` and the same session can attach a restarted
target. A `blocked` launcher must be disposed before retrying so a live target
cannot accidentally receive a second target mutation or payload load.

## Handle typed attachment diagnostics

Launcher failures can be narrowed without parsing console output:

```ts
import {
  isReShadeOperationError,
  type ReShadeDiagnostic,
} from 'electron-game-overlay';

try {
  await launcher.attach(session, {
    processName: detectedProcess.name,
    pid: detectedProcess.pid,
  });
} catch (error) {
  if (!isReShadeOperationError(error)) {
    throw error;
  }

  console.error(error.code, error.stage, error.retrySafety);
  const diagnostic: ReShadeDiagnostic = error.diagnostic;
  console.error(diagnostic.message, diagnostic.evidence);
}
```

The public diagnostic surface consists of `ReShadeDiagnostic`,
`ReShadeDiagnosticStage`, `ReShadeDiagnosticCode`, `ReShadeRetrySafety`,
`ReShadeOperationError`, and `isReShadeOperationError()`.
`error.diagnostic` is frozen, schema-versioned, and structured-clone-safe.
`definite-safe` means no runtime or add-on payload was loaded whose duplication
would make retry unsafe, so the launcher can return to `idle`; it does not
promise zero remote coordination. An `indeterminate` failure keeps it
`blocked`. Staged-run failures can include paths to the injector stdout/stderr
and `ReShade.log` evidence.

For an exact PID, the injector inspects loaded modules before remote allocation
or thread creation. Exact `ReShadeVersion` identifies a candidate, but reuse
requires this project's private host ABI 1 and an `OPEN` add-on gate.
`target-runtime-incompatible`, `target-runtime-reuse-too-late`,
`target-runtime-reuse-raced`, and `target-module-inspection-failed` are
`definite-safe` because they load no runtime/add-on payload. The reuse-race
result can follow bounded remote loader creation, but its gate CAS loses before
environment mutation or `LoadLibrary`. `existing-runtime-addon-load-failed`
means gate acquisition began a payload load; it is an `indeterminate`
`runtime-initialization` failure and keeps the launcher blocked. The older
`target-runtime-conflict` code remains parseable for protocol compatibility.

Filenames and on-disk proxy-like files are not used as proof. This supports only
the project's compatible pre-initialization runtime; stock/differently patched
ReShade, other proxies, arbitrary modded-game coexistence, and clean
disable/unload remain future work.

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
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-shared-runtime.ps1
```

New evidence is written below `build/electron-game-overlay-runtime`. Dated
`build/reshade-imgui-overlay/...` paths elsewhere in the documentation are
historical evidence created before the production package was renamed.
The current process-start launchers use ordinary process startup plus a
test-only pre-device marker. The shared-runtime variants load a compatible
target-local proxy first and prove staged-add-on-only reuse without modifying
that proxy or its configuration; they do not establish stock ReShade or
arbitrary modded-game compatibility.

Use the unsigned full add-on runtime only with the included controlled hosts or
an offline/single-player target you are allowed to modify. Anti-cheat bypasses,
competitive protected targets, arbitrary post-render injection, and universal
game compatibility are outside the supported boundary.
