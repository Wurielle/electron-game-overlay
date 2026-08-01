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
`electron_game_overlay.addon64`,
`electron_game_overlay_reshade_manager.exe`,
`electron_game_overlay_runtime.build.json`, and `ReShade.ini`.

The native toolchain requires Rust, CMake, Git, and Visual Studio 2022 with the
Desktop development with C++ workload. For clean targets, the runtime and add-on
are a pinned, patched ReShade 6.7.3 pair; do not replace the staged
`ReShade64.dll` with a stock build. The separate existing-installation path can
host the same add-on on any detected target-local x64 ReShade identity that can
register public API 18 and provide the exact Dear ImGui function table.

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

An `ElectronGameOverlay` instance supports one live session. A second
`createSession()` call throws until the current session closes. After
`session.close()`, the same overlay can create and start a new session;
`overlay.dispose()` closes whichever session is active and permanently disposes
that overlay instance.

Each overlay owns its callbacks and transport state. Because injected runtimes
discover the default endpoint through one process-wide record, only one
transport may be started on that endpoint at a time. A competing start fails
explicitly and may retry after the current session stops.

Use `session.windows.attach(existingBrowserWindow, options)` when the
application already owns the producer. `show()`, `hide()`, `setBounds()`, and
`destroy()` update the injected scene. Public bounds, caption dimensions, drag
borders, and constraints are Electron device-independent pixels. Electron
enforces producer-window constraints locally; the SDK converts content bounds
and caption hit regions to the physical-pixel wire and composition space.

Window creation and attachment do not focus the offscreen web view on
`ready-to-show` by default. Set `focusOnReady: true` in either options object to
opt in. Returned target input still focuses the selected web view immediately
before dispatch.

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

Each target process advertises at most one stable primary surface. The first
valid presenting swap chain owns target telemetry, FPS sampling, input, and
Electron composition until its final destruction; resize does not transfer
ownership. Destruction removes that surface identity before a remaining valid
presenter can publish its replacement. This is accepted for distinct HWNDs that
share one D3D11 device/context or one D3D12 device/direct queue. Same-HWND input
ownership, distinct D3D12 queues, and broader layouts remain deferred.

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
`existing-runtime` when a compatible private host was reused, or
`official-addon` when the verified add-on was loaded by the detected
target-local public host. Existing and public-host results supply
`hostRuntimePath`; public-host mode also supplies `addonModulePath`.
`reshadeLogPath` points into the staged run in injected mode. Private
existing-host mode infers it beside the host module. A target-local installation
prepared from disk resolves its effective base path from the target process and
configuration.

A process watcher may provide the exact process it just observed:

```ts
await launcher.attach(session, {
  processName: detectedProcess.name,
  pid: detectedProcess.pid,
  executablePath: detectedProcess.filepath,
});
```

The PID must be a positive uint32. `executablePath` must be an absolute path
from the same trusted process observation and have a basename matching
`processName`. The injector verifies the opened process identity before remote
mutation. Call this immediately after process creation and before
graphics-device and swap-chain initialization. The runtime does not currently
adopt an already-rendering device or swap chain, so this is not a general
late-attachment API. A compatible private runtime must additionally still
expose its ABI-1 add-on gate in the `OPEN` state.

### Existing target-local ReShade

For every detected target-local x64 ReShade identity, the launcher uses the
trusted target path and native preflight evidence to resolve the target's
effective base path, add-on directory, and `DisabledAddons` state. It does not
borrow environment expansion from Electron. Detection suppresses fallback
project-runtime injection; there is no product-version or runtime-hash
allowlist. The uniquely named `electron_game_overlay.addon64` is compatible
  only if `ReShadeRegisterAddon` accepts public API 18 and the host returns the
  exact Dear ImGui function table. An explicit user disable remains authoritative.
  A current add-on that remains unloaded after one bounded startup grace reports
  `existing-reshade-addon-host-incompatible` rather than starting another restart
  loop or injecting the bundled host.

This path never replaces or rewrites the existing runtime/proxy, INI, presets,
effects, or foreign add-ons. Capability-incompatible hosts and applicable global
Vulkan/OpenXR ReShade layers are preserved and fail closed instead of triggering
project-runtime injection. Clean targets continue to use the bundled, patched
ReShade 6.7.3 host.

The staged native `electron_game_overlay_reshade_manager.exe` is the only code
allowed to change the project-owned add-on, ownership marker, transaction
journal, and verified temporary/backup files in the resolved add-on directory.
The manager verifies and holds the exact runtime named by the request for TOCTOU
protection and crash-recoverable transactions; this runtime hash is provenance,
not compatibility. The marker's ReShade hash is also provenance and is ignored
for compatibility. Installation and update require a restart. If the add-on is
already mapped, the launcher waits for confirmed target exit before retrying
maintenance rather than replacing a live module. A ReShade upgrade or other
runtime-identity change does not automatically remove the managed add-on. The
public path has controlled-host evidence plus one accepted Gun Frog
stock-host/foreign-add-on/effect combination, not broad real-game coexistence
acceptance.

`attach()` moves through `idle`, `attaching`, `connected`, and, for an
unprovable injector outcome, `blocked`. A transport close is not treated as
proof that the target exited. Once Windows confirms the selected PID is gone,
the launcher returns to `idle` and the same session can attach a restarted
target. A `blocked` launcher must be disposed before retrying so a live target
cannot accidentally receive a second target mutation or payload load.

## Observe launcher lifecycle and handle typed attachment diagnostics

Use `ReShadeOverlayLauncher.onEvent()` for lifecycle progress:

```ts
const unsubscribe = launcher.onEvent((event) => {
  console.log('ReShade lifecycle', event.type);

  if (event.type === 'injector-failed') {
    console.error(event.diagnostic.code, event.diagnostic.message);
  }
});
```

The stream contains immutable `runtime-staged`,
`target-rendezvous-authorized`, `injector-started`, `injector-returned`,
`injector-failed`, `target-connected`, and `target-disconnected` events.
Listener failures are isolated from launcher state and results, and the returned
function unsubscribes the listener. The SDK does not write or export direct
launcher lifecycle console markers. Applications, demos, and test runners own
any stable marker text they choose to format from these events.

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

For existing target-local installations,
`existing-reshade-addon-maintenance-deferred` means the launcher has queued an
ownership-checked install or update behind confirmed target exit. Keep that
launcher alive and call `confirmTargetExited(pid)` only after the OS proves the
exact PID is gone. `existing-reshade-addon-restart-required` means this attempt
installed or updated the disk state after the current process started; no
maintenance is queued, so start a new target process. An already-current add-on
that was not loaded is host-incompatible and also queues no work. Conflict and
preparation-failure diagnostics schedule no automatic change.

Asynchronous session observations use a separate typed event:

```ts
session.on('diagnostic', (diagnostic) => {
  console.log(diagnostic.source, diagnostic.severity, diagnostic.code);
});
```

`OverlayDiagnostic` is immutable and structured-clone-safe. Its optional PID is
authoritative and its context is limited to eight primitive values. The current
loopback transport uses fixed redacted messages and excludes credentials, raw
packets, executable paths, stacks, and arbitrary remote error text. Each
transport diagnostic code is limited to eight observations per minute.
Authenticated injected-runtime records use the same public event and report a
fixed `runtime-*` code plus, when applicable, one defined EGO error status. The
Node boundary attaches the authenticated target PID and owns the severity and
message; runtime limits are isolated per target. Runtime-ready, swap-chain,
first-scene, scene-query, frame-validation/upload, input-reset, and
input-routing observations are covered. Failures before authenticated IPC is
available remain in the target's local `ReShade.log`. These observations
complement rather than replace the terminal `ReShadeOperationError` attachment
contract.

The Electron producer adds six code-owned observations:
`producer-window-registered`, `producer-window-publication-failed`,
`producer-frame-publication-started`, `producer-frame-rejected`,
`producer-frame-publication-failed`, and
`producer-input-forwarding-failed`. Their context contains only validated
window IDs, fixed operation/stage or raster-rejection values, bounded frame
dimensions, and an allowlisted OS error code. Window and frame records omit PID
because a session can publish to multiple targets. Input failures require the
authenticated target PID and permit window ID `0` for focus reset.

Producer records wait in a bounded 32-entry asynchronous delivery queue and
repeat at most once every 7.5 seconds for the same PID (when present), code,
window, and fixed operation/stage/rejection reason. Rate state retires with the
target or final window removal. This prevents listener re-entry during a
partially completed window lifecycle. Window metadata is encoded before retained
transport state is changed, and geometry/raster state commits only after backend
publication succeeds. Translation, focus/blur, and Chromium input-dispatch
exceptions are reported locally and contained instead of being misclassified as
a bad target packet and disconnecting the runtime.

Authenticated `game.input` now has a fail-closed transport schema before SDK
forwarding. The wire record must contain only `type`, a positive uint32
`windowId`, a routable producer Win32 `msg`, uint32 `wparam`/`lparam`, and an
optional positive uint32 `scaleFactorMicros`; PID comes only from the
authenticated socket. Window registration rejects zero IDs and scales before
they can enter the native route. An invalid record closes that target connection
with the fixed `invalid-game-input` classification and cannot mutate translator
state or reach Electron.

This slice does not diagnose renderer acknowledgement or `capturePage()`
failures during ambiguous-raster recovery or redesign the transport into a
globally bounded control/backpressure queue. Existing effect/add-on
combinations, proxy chains, and broad modded-game coexistence beyond the
controlled public-host fixtures also remain outside the supported compatibility
envelope.

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

Filenames and on-disk proxy-like files alone are not used as proof. The SDK
supports the project's compatible pre-initialization runtime and attempts its
current API-18 add-on in any detected target-local x64 ReShade host. Public-host
compatibility is negotiated by registration and the exact ImGui table, not
version or hash. Capability-incompatible hosts, other proxy chains, arbitrary
modded-game coexistence, and clean in-process runtime/add-on unload remain
fail-closed or future work.

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
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-multi-swapchain.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-multi-swapchain.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\existing-reshade-installation-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\global-reshade-layer-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\reshade-addon-manager.ps1
```

New evidence is written below `build/electron-game-overlay-runtime`. Dated
`build/reshade-imgui-overlay/...` paths elsewhere in the documentation are
historical evidence created before the production package was renamed.
The current process-start launchers use ordinary process startup plus a
test-only pre-device marker. The shared-runtime variants load a compatible
target-local proxy first and prove staged-add-on-only reuse without modifying
that proxy or its configuration. The target-local installation launchers prove
preservation and the controlled API-18 capability boundary. The dedicated Gun
Frog launcher establishes one stock public-host/foreign-add-on/effect
combination; none establishes arbitrary modded-game compatibility.

Use the unsigned full add-on runtime only with the included controlled hosts or
an offline/single-player target you are allowed to modify. Anti-cheat bypasses,
competitive protected targets, arbitrary post-render injection, and universal
game compatibility are outside the supported boundary.
