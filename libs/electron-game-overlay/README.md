# electron-game-overlay

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build electron-game-overlay` to build the library.

## Coordinate contract

The public Electron-facing API uses device-independent pixels (DIP):
`BrowserWindow` bounds, caption dimensions, drag borders, and resize constraints
are all supplied in Electron coordinates. `OverlaySession` converts the complete
rectangle (`x`, `y`, `width`, and `height`) and all related metadata to physical
pixels before sending them through `node-game-overlay`. Electron 16 offscreen
paint bitmaps are physical-pixel buffers, so the wire rectangle and bitmap use
the same coordinate space.

Input takes the reverse path. The injected compositor reports overlay-local
physical pixels in `game.input`; the SDK divides signed `x` and `y` coordinates
back to DIP before calling `webContents.sendInputEvent()`.

The current implementation samples the Electron display scale nearest `(0, 0)`
once when the session starts and caches it. This supports the controlled uniform
device-scale proof, but it is not yet a per-monitor-DPI-v2 contract: moving a
window between differently scaled monitors or changing DPI at runtime requires a
future per-window scale update. Electron 42 offscreen-rendering behavior also
needs separate validation before upgrading from the repository's Electron 16
baseline.
