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
resolves only after the injected add-on authenticates back to the session.
ReShade selects the target graphics API; callers do not select D3D11 or D3D12.

```ts
const overlay = new ElectronGameOverlay();
const session = overlay.createSession();
const config = parseReShadeLaunchConfig(process.argv);
const launcher = config ? new ReShadeOverlayLauncher(config) : null;

session.start();
await launcher?.attach(session, { processName: 'game.exe' });
```

Arm the launcher before starting the target process. The accepted production
client proof uses `{ processName: 'Gun Frog.exe' }`; late attachment to an
already running game and other games are not yet compatibility claims. The
runtime directory can be overridden explicitly for development tests;
otherwise it resolves relative to the built SDK. The legacy `findWindows()` and
`session.attachToProcess()` methods still throw.

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
