# hudhook multi-window compositor handoff

> Status: complete for the controlled Windows x64/D3D11 compositor and the
> bounded uniform Electron device-scale proof at 1.25, with a per-window
> desired/active runtime-scale transition foundation. The deterministic and
> manual proofs pass through the existing Electron SDK, Node add-on IPC, shared
> mappings, upstream hudhook 0.9.1, and Dear ImGui renderer without loading the
> legacy injected renderer.

## Run the proofs

From a regular PowerShell at the repository root:

```powershell
Remove-Item Env:HUDHOOK_ELECTRON_WINDOW -ErrorAction SilentlyContinue
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindowManual -Wait
```

Neither mode needs a separate `client:dev` process. Both are attached runs and
clean only their per-run Electron process tree and controlled host.
Run only one controlled runner at a time; concurrent modes contend for the
native add-on's fixed IPC host name.

## Completed contract

The milestone keeps the public Electron SDK unchanged. `window.bounds` has a
backward-compatible optional geometry extension for runtime scale changes; the
existing registration stream remains the stacking contract:

| Event | Ordered scene behavior |
| --- | --- |
| `overlay.init` | Preserve the announced array as back-to-front order. |
| `window` | Remove any duplicate ID, then append the registration on top. |
| `window.bounds` | Update that ID in place without changing order. |
| `window.framebuffer` | Copy and publish that window's mapping/frame. |
| `window.close` | Remove only that ID and preserve all peers. |
| First down that acquires capture | Focus before input; publish a generated click-to-front intent for the hit window. If that hit is already topmost, this first down still advances the generation so an older queued raise cannot overtake it. Additional button-downs remain with the capture owner and do not create another intent. |
| First left down in the SDK caption | Focus/capture/raise as above, but consume the caption gesture and move the payload-local scene/router rect instead of forwarding DOM pointer packets. |

`HUDHOOK_ELECTRON_WINDOW` is now only an optional exact-name filter. If it is
unset or empty, every announced window participates; an unmatched explicit
filter has no fallback.

The coordinate boundary remains explicit across the compatible geometry
extension:

| Boundary | Coordinate space |
| --- | --- |
| Public `BrowserWindow` bounds, SDK caption/drag border, resize constraints | Electron DIP |
| SDK wire rectangle and metadata | Physical game/swap-chain pixels |
| Electron 16 OSR bitmap | Physical pixels |
| Hudhook composition, alpha hit testing, caption dragging | Physical game-client pixels |
| Returned `game.input` | Overlay-local physical pixels, divided back to signed DIP by the SDK |

The SDK reads `BrowserWindow.getContentBounds()`, not outer bounds, so its
rectangle tracks the content surface that produces OSR bitmaps even when a
producer has non-client chrome. It scales all four content-rectangle components
and all dependent metadata. Each routed `game.input` packet carries the window's
active `scaleFactorMicros`; the SDK uses that per-packet tag so queued input
cannot be reinterpreted after a scale transition. Legacy untagged packets remain
supported by falling back to the receiving window's current active scale.
Hudhook already receives ImGui `display_size` in native swap-chain pixels, so the
payload normalizes `display_framebuffer_scale` to `(1, 1)` and avoids applying
the device factor twice.

Scale state is independent per producer window. Electron move/resize and global
display events refresh its desired display, request an OSR repaint when the scale
changes, and leave published geometry and returned input on the active scale. A
paint within one pixel per dimension of the desired nominal floor-scaled size
commits the new scale and full `window.bounds` geometry; an old-size paint remains
accepted at the old scale and an unrelated/invalid size is suppressed. The
accepted bitmap dimensions become the authoritative rect width/height and, for a
fixed window, min/max constraints. Rect, caption, drag border, and constraints
update in place without reordering the window.

If one bitmap falls within both active and desired tolerances, the SDK cannot
classify a queued callback by size. It rejects that callback, waits for renderer
`devicePixelRatio` and viewport acknowledgement, then requests
`capturePage({ x: 0, y: 0, width: desiredDipWidth, height: desiredDipHeight })`.
Only the causally subsequent capture is armed to commit, using its returned
bitmap size as authoritative geometry; acknowledgement/capture failures retry
without publishing the ambiguous callback.

On a committed raster transition, `window.bounds` carries
`rasterChanged: true` before the new frame. The Rust bridge clears the window's
latest compositable raster and alpha pixels, omitting it from the scene until the
following framebuffer arrives. That prevents stale pixels from being drawn or
alpha-tested with new metadata; it does not remove the old GPU texture from
hudhook's cache.

Native shared mappings are strict and transactional. Initial registration and
growth validate dimensions and checked byte sizes, allocate before committing or
broadcasting state, and retain the last working registration/mapping if
allocation fails. Frame writes require an exact source length and verify
dimensions, overflow, declared limits, and actual mapping capacity before the
copy. If either frame dimension exceeds the existing capacity, the Node host
commits a correctly sized replacement together with the new geometry and mapping
name.

## State and rendering design

The IPC worker owns an ordered registry. Each entry retains native ID, name,
physical bounds, transparency, mapping, and latest immutable frame. It publishes one
reference-counted `ElectronScene` containing the currently framed windows in
back-to-front order.

Scene and input-router mutations share the bridge's ordering lock. Lifecycle,
bounds, frame-alpha, and stack changes update the router and publish the matching
immutable scene as one CPU-side transition. The render loop never reads mutable
mapping state.

Metadata-only or invalid-bounds registrations stay in the ordered bridge registry
but are absent from both the rendered scene and input router. A window becomes
compositable and routable together once it has both a retained frame and valid
bounds, whether the frame or bounds event completes that pair. A new `overlay.init`
also releases old capture and focus even when native IDs are reused.

The renderer maintains texture state per native window ID. Each scene frame is
uploaded only when its sequence changes, while metadata/order-only revisions are
composed without a redundant upload. ImGui draws the scene forward on the
background draw list; the diagnostics panel remains separate.

## Input and ordering design

Pointer hit testing walks the input registry front-to-back. Transparent windows
sample their latest RGBA alpha, allowing an alpha-zero pixel to fall through to a
lower Electron window. Missing or invalid alpha data deliberately falls back to
rectangle hit testing.

When a pointer down changes the focused Electron window, it queues
`game.window.focused` before `game.input`; repeated clicks on that focused window
need only the input packet. Keyboard, system-key, and character messages go only
to the focused live window. A project-owned capture owner retains mouse moves and
matching releases outside its bounds; unrelated window bounds/order/lifecycle
changes do not steal capture. Closing the capture or focus owner emits cleanup
before removing it.

Click-to-front does not add a protocol packet. WndProc routing creates a
monotonic intent generation and posts the requested ID to the bridge thread. The
worker rejects stale generations, applies the raise to its ordered registry, and
publishes matching scene/router state. Explicit producer controls use the existing
hide/show lifecycle: close removes a window and re-registration appends it on top.

Caption dragging uses the existing physical `window.caption` margins published by
the SDK. After normal z-order and alpha hit testing selects a window, a first
left-button down inside that caption starts a payload-owned drag. The down, moves,
and matching up are not sent through `game.input`, so dragging a caption is
different from a DOM pointer gesture that merely exercises capture. Every move
derives the physical origin from the current game-client pointer minus the original local
anchor, avoiding cumulative drift. The bridge accepts only the latest
registration/drag generation and atomically republishes matching render and
hit-test bounds; close, reconnect, producer bounds for that window, focus loss,
or capture cancellation invalidates stale work.

This movement is intentionally interactive and payload-local, matching the useful
part of the legacy renderer without extending `node-game-overlay`. Motion is
posted to and coalesced by the bridge; each applied position atomically republishes
the matching render and hit-test bounds. The hidden Electron `BrowserWindow`
retains its producer-owned bounds. Reconnect, close/re-register, or a later
producer `setBounds()` can therefore restore that placement; durable
payload-to-producer bounds synchronization would require a new wire event.

## Deterministic acceptance

`-ClientMultiWindow -DeviceScaleFactor 1.25 -Wait` creates two real overlapping
Electron pages. Public producer bounds are DIP:

- green BACK: 640 x 360 `ExampleMainOverlay` at `(64, 72)`, registered first;
- blue FRONT: 320 x 220 `ExamplePopupOverlay` at `(200, 136)`, registered
  second.

The SDK sends corresponding physical rectangles `(80, 90, 800 x 450)` and
`(250, 170, 400 x 275)`, matching the Electron 16 OSR surfaces.

The producer must report the exact scale evidence:

```text
HUDHOOK_CLIENT_MULTIWINDOW_DEVICE_SCALE requestedScale=1.25 displayScale=1.25 backDpr=1.25 frontDpr=1.25 backFrame=800x450 frontFrame=400x275
```

Their text targets sit below both declared captions and share an overlap point.
The runner requires both per-window frame uploads and an
`Electron overlay scene composed` marker with
`order=ExampleMainOverlay>ExamplePopupOverlay` before sending input. It then
proves:

1. the initial overlap click focuses and reaches FRONT only;
2. typed text goes only to the focused FRONT field;
3. FRONT owns an out-of-bounds DOM pointer gesture and BACK receives no pointer
   event during capture; this phase does not move either window;
4. clicking BACK's exposed opaque client surface below its caption produces the payload's
   `raised to top after input` evidence, recomposes FRONT>BACK without any
   producer raise/close/re-register marker, then routes the next overlap click
   only to BACK before any producer lifecycle command;
5. BACK close/re-register preserves FRONT>BACK, then FRONT close/re-register
   restores BACK>FRONT; focused keyboard input remains BACK-only before that
   restore, and the final overlap click is FRONT-only afterward;
6. hiding FRONT leaves a one-window BACK scene, while showing FRONT restores both
   with FRONT on top;
7. dragging FRONT's striped caption handle from local `(200, 75)` physical
   (`(160, 60)` DIP) by `(+120, +90)` physical pixels—the scaled equivalent of
   `(+96, +72)` DIP—moves the payload-local physical origin from `(250, 170)` to
   `(370, 260)`; the caption gesture emits no Electron
   pointer input, producer lifecycle, or host `window.bounds` traffic,
   FIFO-drained page hover barriers cover delayed outbound delivery, and a
   producer bounds query remains `(200, 136)` DIP;
8. clicking the visibly moved text field reaches FRONT with its original local
   DIP coordinates after the physical-input round trip, while the vacated caption
   point reaches BACK;
9. interception release is acknowledged after the disabled render boundary;
10. released Escape closes the controlled host and is not forwarded to Electron;
11. exact controlled Electron and host processes are absent after cleanup.

The terminal success line is:

```text
Verified deterministic two-window composition, caption movement, routing, capture, z-order, lifecycle, and release.
```

This acceptance is deliberately bounded: a command-line switch forces one
uniform Electron scale factor. It does not exercise real per-monitor-DPI-v2,
mixed-scale monitors, or a runtime DPI transition. The SDK now contains the
desired/active transition state and the controlled host is explicitly PMv2-aware
with DPI-aware initial client sizing and `WM_DPICHANGED` suggested-rect handling.
The validation machine nevertheless exposes only one 100% virtual display;
forced 1/1.25/1.5/2 runs are uniform regressions, not physical/VM mixed-monitor
evidence. Target-HWND/client-origin ownership, backing BrowserWindow placement,
multi-target geometry routing, and Electron 42 OSR semantics still need
independent evidence.

Pure Rust tests cover arbitrary ordered registries, last-duplicate position,
exact filtering, bounds without reorder, immutable scene metadata, alpha
fallthrough, topmost routing, focus-before-input, keyboard focus, capture-owner
cleanup, caption boundaries, absolute anchor-based movement, stale-generation
rejection, cancellation, and click-to-front intent emission. The previous
`-ClientInput -Wait` deterministic one-window regression also remains passing.

## Manual acceptance

`-ClientMultiWindowManual -Wait` stops after composition and guarded interception
are ready. FRONT is blue and initially overlaps green BACK. The operator can:

- click and type in either text field;
- drag the striped `:: DRAG BACK ::` or `:: DRAG FRONT ::` caption handle to
  move that composited window;
- press in a text field and drag outside the window as a separate capture-owner
  inspection that does not move the window;
- click an exposed part of BACK and confirm the diagnostics Stack flips to put
  BACK on top;
- use FRONT's `Raise BACK` / `Hide FRONT` controls and BACK's `Raise FRONT` /
  `Show FRONT` controls;
- move focus away and back to observe interception suspension/resumption.

Escape and Alt+F4 are intercepted while the host is focused. Close the controlled
host with its title-bar X when finished; the runner then verifies and cleans its
exact process tree.

## Known limitations

- The 1.25 proof forces one uniform Electron device scale. Per-window
  desired/active runtime reconciliation and the PMv2 controlled target are now
  implemented, but the available machine has only one 100% virtual display.
  Target-owned display/client-origin mapping, backing-window placement,
  multi-target geometry, fullscreen scaling, letterboxing, physical/VM
  mixed-monitor behavior, and Electron 42 OSR remain unproven.
- Hudhook's public filter is blanket `InputAll`; outside-overlay input remains
  swallowed while interception is active, and project-owned capture currently
  assumes messages continue reaching the same target HWND.
- Raw input, DirectInput, XInput, GameInput, gamepads, and faithful X1/X2 delivery
  through Electron 16 remain out of scope.
- Hudhook 0.9.1 exposes texture load/replace but no texture-removal operation.
  The per-window cache therefore cannot safely retire every superseded texture ID
  yet, especially across size changes.
- CPU scene/router publication is atomic, but a newly published alpha frame can
  precede its corresponding GPU upload by one `Present`, briefly making hit-test
  alpha newer than the visible texture.
- Click-to-front and caption-drag placement are payload-local. The existing IPC
  schema has no persistent z-order or payload-to-producer bounds field, so
  reconnect restores `overlay.init` registration order and producer placement.
- The proof is Windows x64/D3D11 only, uses the controlled upstream injector, and
  permits only one Electron producer because the Node add-on host name is fixed.

## Next work

1. Define target-HWND display ownership and physical game-client origin, place
   backing BrowserWindows accordingly, and route geometry per target.
2. Run the PMv2 host and producer transition manually across real or VM
   differently scaled displays.
3. Add safe deferred texture retirement despite the current hudhook texture API.
4. Repeat the controlled proof with hudhook's D3D12 backend.
5. Replace the controlled injector with a production-quality project-owned
   launcher that validates remote `LoadLibraryW` and exact buffer sizing.

Primary implementation files are:

- [frame/scene IPC bridge](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/electron_frame.rs);
- [ordered input router](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/electron_input.rs);
- [per-window renderer](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/lib.rs);
- [controlled Electron producer](../poc/hudhook-imgui-overlay/electron-client-window-demo/main.cjs);
- [automated/manual runner](../poc/hudhook-imgui-overlay/scripts/run-electron-dx11.ps1).
