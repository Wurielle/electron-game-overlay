# electron-game-overlay

This is the public Electron SDK. It uses the backend-neutral
`electron-overlay-transport` engine and stages the Windows
`electron-game-overlay-runtime`; consumers do not load a native Node add-on.

## Building

Run `nx build electron-game-overlay` to build the library.

## ReShade runtime and attachment

`nx build electron-game-overlay` builds its native Nx dependencies, compiles the
TypeScript SDK, and stages the
patched Windows x64 ReShade runtime, injector, build stamp, Electron add-on, and
configuration under `dist/runtime/win32-x64/reshade`. Consumers call
`parseReShadeLaunchConfig()`, create `ReShadeOverlayLauncher`, then arm an
executable process name or path fragment with `launcher.attach(session,
target)`. Each request stages a writable isolated run directory. Immutable
artifacts are hard-linked when the source and run root share a filesystem, with
copying as a portable fallback; `ReShade64.dll`,
`electron_game_overlay.addon64`, and mutable `ReShade.ini` always receive
private file records. The SDK
waits for transport discovery, executes the injector without a shell, and
requires one strict structured injector result, then resolves only after an add-on with that
PID and the expected executable basename authenticates back to the session.
ReShade selects the target graphics API; callers do not select D3D11 or D3D12.
The staged add-on is `electron_game_overlay.addon64`.
Pass `--reshade-overlay` exactly once to the Electron main process to opt in to
the bundled runtime configuration.

```ts
const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const config = parseReShadeLaunchConfig(process.argv);
const launcher = config ? new ReShadeOverlayLauncher(config) : null;

session.start();
const result = await launcher?.attach(session, { processName: 'game.exe' });
console.log(result?.runtimeMode, result?.hostRuntimePath);
```

The exported `ReShadeRuntimeMode` is either `injected-runtime` or
`existing-runtime`. `ReShadeLaunchResult.runtimeMode` identifies which path
succeeded; compatible reuse also returns `hostRuntimePath`. In injected mode,
`reshadeLogPath` points into the staged run. In existing mode it is inferred as
`ReShade.log` beside the host module, but a host configured with ReShade's
`[INSTALL] BasePath` may write its authoritative log elsewhere.

For launchers that need to prearm before they know an executable basename, use
a path target. The native injector snapshots and ignores processes that already
exist, emits a flushed armed marker, then selects the first newly created
process whose normalized full path contains the fragment. `attach()` returns
that process's basename, full `selectedPath`, and authenticated PID:

```ts
await launcher?.attach(session, {
  pathContains: '\\steamapps\\',
  excludedProcessNames: ['UnityCrashHandler64.exe'],
});
```

`excludedProcessNames` is optional and prevents known non-rendering helpers from
consuming a one-shot arm. Path matching and exclusions are case-insensitive;
each exclusion must be a valid executable basename.

Process watchers can target the exact process they just observed. Supplying a
PID invokes the pinned injector as `inject.exe game.exe --pid 1234`, verifies
both the PID and executable basename, and uses that PID for injector stdout,
transport connection, reauthentication, and terminal-exit correlation:

```ts
await launcher?.attach(session, {
  processName: detectedProcess.name,
  pid: detectedProcess.pid,
});
```

An `expectedTargetPid` supplied by startup configuration is snapshotted into
the same exact-PID target before any asynchronous staging, so it also reaches
the injector as `--pid` rather than remaining a name-only post-check.
`attach()` reserves its launcher synchronously while session readiness is
pending; a concurrent low-level `launch()` cannot bypass target authorization.

For exact-PID `attach()`, the SDK publishes a unique authenticated discovery
record inside that launcher's isolated ReShade run directory before spawning
the injector. Before that credential, it publishes the persistent
`electron-overlay-transport-v1.targeted` route-intent marker beside the record.
The record is bound to the expected PID, and the loopback host rejects a
token/PID mismatch before sending any Electron window state. The injected
runtime prefers this run-local route and pins the selected path for subsequent
reconnect attempts.

Revoking the authorization removes the credential record but deliberately
retains the route-intent marker. A payload that initializes late therefore
fails closed instead of attaching through the global fallback after its
target-specific credential has expired. The marker is removed when the staged
run directory itself is cleaned up. Under normal operation, distinct exact-PID
runs no longer collide through the shared well-known rendezvous metadata. This
is not a hostile same-user security boundary: another process running with the
user's file access can inspect or replace discovery files. The legacy
well-known discovery record remains as a compatibility fallback only when
neither a run-local record nor its route-intent marker exists, including the
lower-level `launch()` API and controlled test producers.

Target authorization leases belong to their `OverlaySession`. Closing the
session revokes active leases, and an authorization that finishes after close
is immediately released instead of escaping from a closed session.

Latency-sensitive watchers may stage the next isolated run bundle before process
detection. `prepare()` performs no injection, concurrent calls coalesce, and
the next `attach()` or `launch()` consumes that prepared directory:

```ts
await launcher?.prepare();
await launcher?.attach(session, {
  processName: detectedProcess.name,
  pid: detectedProcess.pid,
});
```

Disposing an unconsumed prepared launcher removes its directory, including when
preparation is still in flight. Every isolated run also receives an immutable
SDK ownership marker. Only a definite-safe failure or an OS-confirmed target
disconnect adds the matching reclaimable marker. Asynchronous sweeps after
staging and retirement remove reclaimable evidence older than seven days or
outside the newest 64 reclaimable runs. Prepared, active, indeterminate,
unmarked, malformed, and legacy pre-marker directories are preserved, and
cleanup failures do not block staging or injection.

If an application-level process watcher can observe termination before the
transport disconnect event, call `launcher.confirmTargetExited(pid)` before
disposing that launcher. It applies only to the matching connected PID or an
attaching exact-PID target and makes the terminal lifecycle proof available to
retention.

`pid` is optional for backward compatibility and must be a positive uint32
integer when supplied. The PID is part of the target identity, so requests for
two same-name processes with different PIDs are distinct. A startup
`--reshade-expected-target-pid` remains supported; if both sources are present,
they must match or the SDK rejects the request before staging or spawning an
injector.

`attach()` is reusable. Its public state is `idle`, `attaching`, `connected`, or
`blocked`. A socket close first emits `game.process.transport-lost`; that is not
proof that the target exited, so the injection latch remains active while a
same-PID payload can reauthenticate. The transport polls process liveness and
emits `game.process.disconnected` only after the OS confirms that PID is gone.
That terminal event returns the launcher to `idle`, so the same launcher and
session can attach the restarted executable with a new isolated run
directory. Client-originated lifecycle events are rejected by the authenticated
transport.

Failures known to occur before the injector process spawns return to `idle`.
The exact-PID injector also emits a stable no-injection proof when it fails
before creating a remote thread; that proven outcome returns to `idle` even
though the injector child itself spawned.
Once an injector may have run, an unprovable outcome is deliberately
`blocked` until the launcher is disposed; retrying could otherwise perform a
second target mutation, inject another runtime, or repeat an existing-runtime
add-on load against a live target. An OS-confirmed exit of the selected PID is
the other safe re-arm boundary when that PID authenticated and is observable by
the transport.

Launcher failures expose a typed, structured diagnostic instead of requiring
applications to parse human-readable injector output:

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

`ReShadeOperationError`, `ReShadeDiagnostic`, `ReShadeDiagnosticStage`,
`ReShadeDiagnosticCode`, and `ReShadeRetrySafety` are public SDK contracts.
`error.diagnostic` is a frozen, structured-clone-safe schema-versioned record;
the error also exposes its `code`, `stage`, and `retrySafety` directly.
Use `isReShadeOperationError()` for narrowing. A `definite-safe` failure is
known not to have loaded a runtime or add-on payload whose duplication would
make retry unsafe, and returns the launcher to `idle`. It does not promise that
no bounded remote coordination occurred. `indeterminate` retains the existing
fail-closed `blocked` behavior. When a run was staged, the diagnostic may
include the run directory and injector stdout, stderr, and ReShade log paths.

Running sessions expose a separate immutable diagnostic event for asynchronous
transport observations:

```ts
session.on('diagnostic', (diagnostic) => {
  console.log(
    diagnostic.source,
    diagnostic.severity,
    diagnostic.code,
    diagnostic.pid,
  );
});
```

`OverlayDiagnostic` is bounded, schema-versioned, and structured-clone-safe.
Its context accepts at most eight primitive values. Transport diagnostics never
include discovery credentials, raw packets, executable paths, stacks, or
arbitrary remote error text. Authenticated injected runtimes can additionally
report fixed `runtime-*` milestones and scene, frame-upload, or input failures.
Those packets contain only an allowlisted code and optional EGO status; the
Node transport supplies the authenticated PID and owns the public severity and
message. Each code is limited to eight observations per minute, with runtime
limits isolated per connected target. This event does not replace
`ReShadeOperationError`: attachment errors retain their retry-safety and
evidence contract, while session diagnostics describe activity after the
overlay transport starts. Failures before the runtime can connect still appear
only in its local `ReShade.log`.

Exact-PID injection performs a bounded module preflight before allocating or
writing target memory. A loaded module becomes a ReShade candidate only when
its PE export table contains exact `ReShadeVersion`. Reuse then requires private
`ElectronGameOverlayReShadeHostAbi` value 1 and an `OPEN`
`ElectronGameOverlayReShadeAddonGate`:

- `target-runtime-incompatible` means those private capabilities are absent or
  have the wrong ABI;
- `target-runtime-reuse-too-late` means compatible registration is already
  active or closed;
- `target-runtime-reuse-raced` means the gate changed before the injector could
  claim it;
- `target-module-inspection-failed` means module or PE inspection could not
  complete safely;
- `existing-runtime-addon-load-failed` means the compatible gate was claimed
  but the staged add-on did not load.

The first four are `definite-safe` because no ReShade or add-on payload was
loaded, and return the launcher to `idle`. In the reuse-race case the bounded
remote loader has already been created, but its gate CAS loses before it changes
the environment or calls `LoadLibrary`. The add-on-load failure is reported at
`runtime-initialization`, is `indeterminate`, and keeps the launcher blocked.
`target-runtime-conflict` remains accepted for older injector protocol
compatibility but is not emitted by the current native injector.

The preflight deliberately does not reject a process because a module has a
familiar filename or because `dxgi.dll`, `dinput8.dll`, `ReShade.ini`, or other
proxy-like files exist beside the executable. Those are not reliable proof of
what code is loaded. The supported path avoids loading a second runtime only
for this project's compatible pre-initialization host. Stock or differently
patched ReShade, another proxy runtime, and clean runtime disable/unload remain
unsupported.

The lower-level `launch()` / `acceptTargetConnection()` pair has no session
event source and is intentionally one-shot. It stays latched after proof (or an
expired proof window) rather than risking a second injector against a live
target. Applications that need restart/reinjection must use `attach()`.

For name-only or path selection, arm the launcher before starting the target
process. A process watcher may instead call `attach()` with the exact PID
immediately after process creation, but that reactive route must still beat
graphics initialization. Attachment after a game is already rendering is not
supported. The accepted real-game production-client proof uses
`{ processName: 'Gun Frog.exe' }`. The Steam demo uses a hybrid coordinator: one
broad path launcher is prearmed for `\\steamapps\\` with zero executable
exclusions, while the continuous process observer still gives every detected
Steam-path executable its own exact-PID launcher. A native per-PID claim
serializes overlap before target mutation. If the path launcher wins, the
coordinator adopts that target and disposes the exact-PID loser; if an exact
launcher wins, the path attempt yields safely. The broad watcher is rearmed
after safe completion, confirmed target exit, or a definite-safe failure.
Native claim loss is coordination, not runtime incompatibility; an
indeterminate add-on-load outcome does not auto-rearm that lane. The runtime
directory can be overridden explicitly for development tests; otherwise it
resolves relative to the built SDK. The legacy `findWindows()` and
`session.attachToProcess()` methods still throw.

The controlled production client/SDK D3D12 gate is available through:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
```

It passed twice on July 13, 2026, using two isolated client-data and ReShade run
directories. Both real Electron windows accepted focus, text, and caption-drag
interaction while the target stayed foreground and its input oracle stayed
frozen. Release restored legacy, raw, and primary mouse-pointer input plus cursor
confinement; released Escape closed each target normally. The runner emitted
`D3D12_REAL_CLIENT_SDK_GATE_PASS`. Historical pre-promotion evidence is retained
under `build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`; current
runs use `build/electron-game-overlay-runtime`.

The restart/reinjection gate is available through:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
```

It passed on July 13, 2026 with Electron PID 17756 across controlled target PIDs
19764 and 17940. Each frontend Inject action selected a distinct target PID and
runtime directory; each target exit returned the SDK and frontend to `idle`,
and the second D3D12 scene passed both-window input, interception, and release.
The runner emitted `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`; historical
pre-promotion evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`.
Current runs use `build/electron-game-overlay-runtime`.

The controlled host cooperates with the prearmed launcher before its deliberately
fast graphics initialization. This proves SDK-owned launch and ReShade's D3D12
selection for that host, not arbitrary fast-start target timing. Each client is
force-cleaned after target exit in the original gate; the reinjection gate keeps
one client/session alive while replacing the target. Graceful injected-runtime
disable/unload while a target remains alive is separate lifecycle hardening.

The real production client/SDK gate passed against Gun Frog on July 13, 2026
through
`libs/electron-game-overlay-runtime/scripts/test-cases/gun-frog-client-sdk.ps1`.
The four aligned Electron controls stayed isolated from Unity while interception
was acknowledged; Ctrl+I produced the negative acknowledgement and the same
underlying Quit position then closed the game.

The normal hybrid Steam flow passed a same-client Gun Frog launch/relaunch on
July 29, 2026. Electron stayed alive while PIDs 20856 and 13068 each rendered
the visible D3D11 overlay at 60 FPS. Ctrl+I received both positive and negative
interception acknowledgements, an overlay `Open status window` click left the
game menu unchanged, and the released normal Quit click closed the game. A
post-hardening rerun repeated visible 60 FPS attachment, exact-PID attempts,
normal exit, and rearm for PIDs 11856 and 16892 with no leftovers.

## Target telemetry and target-follow windows

The injected runtime publishes an immutable target-surface snapshot after the
swap chain is ready and whenever its geometry or state changes. The snapshot
includes the authoritative process and surface IDs, target HWND, graphics API,
render size, client and outer-window screen bounds, DPI, monitor/work-area
bounds, focus, visibility, minimized state, and a fullscreen-like flag.

```ts
session.on('targetSurfaceChanged', (surface) => {
  console.log(
    surface.pid,
    surface.graphicsApi,
    surface.renderSize.width,
    surface.renderSize.height,
  );
});

session.on('fps', ({ pid, fps }) => {
  console.log(`target ${pid}: ${fps.toFixed(1)} FPS`);
});

const surfaces = session.targets.list();
const exact = session.targets.get(surfaces[0].pid, surfaces[0].surfaceId);
```

`fps` is sampled inside the injected render process; it is not an Electron
paint-rate counter. Surface state survives a transient transport loss so a
same-PID runtime can reauthenticate, and is cleared only by an authoritative
surface removal or OS-confirmed process disconnect.

An Electron window can follow the newest matching live target:

```ts
const window = session.windows.create({
  id: 'fullscreen-overlay',
  transparent: true,
  file: '/absolute/path/to/overlay.html',
});

window.followTarget({ area: 'render' });
window.show();

// Optional selectors:
window.followTarget({ pid: targetPid, surfaceId, area: 'client' });
window.stopFollowingTarget();
```

`render` sizes the OSR raster to the reported render surface; `client` uses the
physical game-client dimensions. The SDK places the hidden backing
`BrowserWindow` on the target display in Electron DIP while publishing
compositor-local physical bounds beginning at `(0, 0)`. Target moves, resizes,
DPI/display changes, fullscreen transitions, and attempted manual producer
moves/resizes reapply the layout. A new size becomes active only after a
matching OSR paint arrives, so old pixels are never labeled with new target
dimensions. `stopFollowingTarget()` restores the content bounds the window had
before follow mode started.

## Coordinate contract

The public Electron-facing API uses device-independent pixels (DIP): window
bounds, caption dimensions, drag borders, and resize constraints are supplied in
Electron coordinates. For registration and runtime reconciliation,
`OverlaySession` reads `BrowserWindow.getContentBounds()`, not the outer window
bounds. That makes the geometry describe the content surface that produces OSR
paints, including when a framed or attached producer has non-client chrome. The
session converts the complete content rectangle (`x`, `y`, `width`, and
`height`) and all related metadata to physical pixels before sending them
through the SDK's authenticated loopback transport. Electron 16 offscreen paint
bitmaps are physical-pixel buffers, so the wire rectangle and bitmap use the
same coordinate space. The transport is implemented with Node's maintained core
networking APIs and does not load a native Node add-on.

Input takes the reverse path. The injected compositor reports overlay-local
physical pixels in `game.input` and tags each packet with the window scale that
was active when the packet was routed. The SDK uses that optional
`scaleFactorMicros` tag to convert signed `x` and `y` coordinates back to DIP,
so an already queued packet cannot be reinterpreted after a scale commit. A
packet from a legacy payload has no tag and falls back to the receiving window's
current active scale before `webContents.sendInputEvent()`.

Immediately before each returned input packet, the session calls
`BrowserWindow.focusOnWebView()`. Electron 16's `WebContents.focus()` does not
focus an offscreen render widget; `focusOnWebView()` supplies Chromium page
focus without activating the hidden native window or taking foreground focus
from the game.

Each registered window now tracks a desired display/scale separately from the
active scale used by its published frame and input. Window move/resize events and
Electron display add/remove/metrics events update the desired state and request
an OSR repaint. A paint matches a raster when each dimension is within one pixel
of the nominal floor-scaled size; Electron 16 can otherwise report, for example,
`400 x 251` for `320 x 200` content at 1.25. The accepted bitmap dimensions—not
the nominal dimensions—become the authoritative physical rectangle and, for a
fixed-size window, its constraints. An old-size paint remains valid at the
active scale, and a bitmap matching neither scale is suppressed. This prevents
bounds, frame, and returned input from changing coordinate systems at different
times.

If one bitmap falls within both the active and desired size tolerances, size
alone cannot identify the producer scale. The session rejects that ambiguous
paint, waits for the renderer to acknowledge the desired
`devicePixelRatio`/viewport, then requests `capturePage()` cropped to the desired
content rectangle. The causally subsequent capture's actual dimensions commit
the desired raster; a failed acknowledgement or capture is retried without
publishing the ambiguous callback.

The compatible `window.bounds` update now carries the complete physical
geometry: rectangle, resize constraints, caption margins/height, and drag-border
width. A raster-changing commit sends `rasterChanged: true` before its frame;
the native compositor clears that window's latest compositable raster so old pixels are not
drawn with new metadata, then republishes it when the matching framebuffer
arrives. This suppresses stale display without retiring the cached GPU texture,
which remains separate work.

Frames use a length-delimited binary BGRA packet rather than JSON/base64 or a
named shared mapping. The Node transport validates dimensions and exact byte
counts, retains one latest frame per registered window for reconnect, and
coalesces an unsent frame for the same window when TCP backpressure is active.
Control packets remain ordered. A `rasterChanged` bounds update discards the
cached old-size pixels until the matching frame arrives, and reconnect replays a
canonical ordered metadata snapshot followed by each retained frame.

Ordinary `setBounds()` placement remains Electron DIP and is converted to
game-local physical composition coordinates. A followed window is different:
the SDK owns its hidden desktop placement from the target HWND/client telemetry
and publishes a local `(0, 0)` surface. The retained target model is keyed by
PID and surface ID. One loopback listener accepts multiple independently
authenticated exact-PID targets, while the application session intentionally
publishes the same overlay scene to each connected target. Independent
simultaneous `OverlaySession` instances in one Electron process, multiple swap
chains, real physical/VM mixed-scale acceptance, unusual exclusive-fullscreen
paths, and Electron 42 OSR behavior remain follow-up work rather than current
compatibility claims.
