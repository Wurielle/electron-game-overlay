# electron-game-overlay

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build electron-game-overlay` to build the library.

## ReShade runtime and attachment

`nx build electron-game-overlay` compiles the TypeScript SDK and stages the
patched Windows x64 ReShade runtime, injector, build stamp, Electron add-on, and
configuration under `dist/runtime/win32-x64/reshade`. Consumers call
`parseReShadeLaunchConfig()`, create `ReShadeOverlayLauncher`, then arm an
executable process name with `launcher.attach(session, target)`. Each request
copies the immutable SDK assets into a writable isolated run directory. The SDK
waits for transport discovery, executes the injector without a shell, and
parses the injector-selected PID, then resolves only after an add-on with that
PID and the expected executable basename authenticates back to the session.
ReShade selects the target graphics API; callers do not select D3D11 or D3D12.

```ts
const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const config = parseReShadeLaunchConfig(process.argv);
const launcher = config ? new ReShadeOverlayLauncher(config) : null;

session.start();
await launcher?.attach(session, { processName: 'game.exe' });
```

`attach()` is reusable. Its public state is `idle`, `attaching`, `connected`, or
`blocked`. A socket close first emits `game.process.transport-lost`; that is not
proof that the target exited, so the injection latch remains active while a
same-PID payload can reauthenticate. The transport polls process liveness and
emits `game.process.disconnected` only after the OS confirms that PID is gone.
That terminal event returns the launcher to `idle`, so the same launcher and
session can attach the restarted executable with a new isolated runtime
directory. Client-originated lifecycle events are rejected by the authenticated
transport.

Failures known to occur before the injector process spawns return to `idle`.
Once an injector may have run, an unprovable outcome is deliberately
`blocked` until the launcher is disposed; retrying could otherwise inject a
second runtime into a live target. An OS-confirmed exit of the selected PID is
the other safe re-arm boundary when that PID authenticated and is observable by
the transport.

The lower-level `launch()` / `acceptTargetConnection()` pair has no session
event source and is intentionally one-shot. It stays latched after proof (or an
expired proof window) rather than risking a second injector against a live
target. Applications that need restart/reinjection must use `attach()`.

Arm the launcher before starting the target process. The accepted real-game
production-client proof uses `{ processName: 'Gun Frog.exe' }`; late attachment
to an already running game and other games are not yet compatibility claims. The
runtime directory can be overridden explicitly for development tests; otherwise
it resolves relative to the built SDK. The legacy `findWindows()` and
`session.attachToProcess()` methods still throw.

The controlled production client/SDK D3D12 gate is available through:

```powershell
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk.ps1
```

It passed twice on July 13, 2026, using two isolated client-data and ReShade run
directories. Both real Electron windows accepted focus, text, and caption-drag
interaction while the target stayed foreground and its input oracle stayed
frozen. Release restored legacy, raw, and primary mouse-pointer input plus cursor
confinement; released Escape closed each target normally. The runner emitted
`D3D12_REAL_CLIENT_SDK_GATE_PASS`; evidence is retained under
`build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`.

The restart/reinjection gate is available through:

```powershell
.\poc\reshade-imgui-overlay\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
```

It passed on July 13, 2026 with Electron PID 17756 across controlled target PIDs
19764 and 17940. Each frontend Inject action selected a distinct target PID and
runtime directory; each target exit returned the SDK and frontend to `idle`,
and the second D3D12 scene passed both-window input, interception, and release.
The runner emitted `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`; evidence is
under
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`.

The controlled host cooperates with the prearmed launcher before its deliberately
fast graphics initialization. This proves SDK-owned launch and ReShade's D3D12
selection for that host, not arbitrary fast-start target timing. Each client is
force-cleaned after target exit in the original gate; the reinjection gate keeps
one client/session alive while replacing the target. Graceful injected-runtime
disable/unload while a target remains alive is separate lifecycle hardening.

The real production client/SDK gate passed against Gun Frog on July 13, 2026
through `poc/reshade-imgui-overlay/scripts/test-cases/gun-frog-client-sdk.ps1`.
The four aligned Electron controls stayed isolated from Unity while interception
was acknowledged; Ctrl+I produced the negative acknowledgement and the same
underlying Quit position then closed the game.

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

`BrowserWindow` bounds remain game-client-local DIP, not desktop-global screen
coordinates. Display matching currently follows the hidden producer window's
backing placement. The SDK still does not own the target game HWND's display or
physical client origin. The focused POC publishes one producer scene through one
authenticated producer/target rendezvous; multiple simultaneous targets and
per-target geometry are not implemented. Therefore this is a bounded
producer-window/runtime transition foundation, not a completed mixed-monitor target contract. Target-HWND display
ownership, backing-window placement, multiple simultaneous target routing,
physical/VM mixed-scale acceptance, and Electron 42 OSR behavior remain
follow-up work. The completed POC transport intentionally supports one active
producer/target rendezvous at a time.
