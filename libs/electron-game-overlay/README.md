# electron-game-overlay

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build electron-game-overlay` to build the library.

## Coordinate contract

The public Electron-facing API uses device-independent pixels (DIP): window
bounds, caption dimensions, drag borders, and resize constraints are supplied in
Electron coordinates. For registration and runtime reconciliation,
`OverlaySession` reads `BrowserWindow.getContentBounds()`, not the outer window
bounds. That makes the geometry describe the content surface that produces OSR
paints, including when a framed or attached producer has non-client chrome. The
session converts the complete content rectangle (`x`, `y`, `width`, and
`height`) and all related metadata to physical pixels before sending them
through `node-game-overlay`. Electron 16 offscreen paint bitmaps are
physical-pixel buffers, so the wire rectangle and bitmap use the same coordinate
space.

Input takes the reverse path. The injected compositor reports overlay-local
physical pixels in `game.input` and tags each packet with the window scale that
was active when the packet was routed. The SDK uses that optional
`scaleFactorMicros` tag to convert signed `x` and `y` coordinates back to DIP,
so an already queued packet cannot be reinterpreted after a scale commit. A
packet from a legacy payload has no tag and falls back to the receiving window's
current active scale before `webContents.sendInputEvent()`.

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
hudhook clears that window's latest compositable raster so old pixels are not
drawn with new metadata, then republishes it when the matching framebuffer
arrives. This suppresses stale display without retiring the cached GPU texture,
which remains separate work.

The Node host treats initial and replacement frame mappings transactionally. It
validates positive dimensions and checked byte sizes, allocates a replacement
before committing geometry or broadcasting its name, and leaves the last
working registration/mapping intact if allocation fails. Frame writes also
require an exact buffer length and verify dimension, overflow, and actual mapping
capacity before copying. A mapping grows when either new frame dimension exceeds
its capacity; hudhook updates the existing registration without changing stack
order.

`BrowserWindow` bounds remain game-client-local DIP, not desktop-global screen
coordinates. Display matching currently follows the hidden producer window's
backing placement. The SDK still does not own the target game HWND's display or
physical client origin, and the native host broadcasts one geometry to every
connected target. Therefore this is a bounded producer-window/runtime transition
foundation, not a completed mixed-monitor target contract. Target-HWND display
ownership, backing-window placement, per-target routing, physical/VM mixed-scale
acceptance, and Electron 42 OSR behavior remain follow-up work.
