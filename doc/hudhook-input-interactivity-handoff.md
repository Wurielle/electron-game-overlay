# Hudhook input and interactivity handoff

> Completed July 10, 2026 on `feat/overlay-pocs`. The deterministic `-ClientInput`
> proof passed click/focus, text, vertical wheel, intercepted Escape, release, and
> released Escape, followed by passing `-ClientWindow` and `-Client` regressions.
> This document is retained as the design and acceptance record.

The implemented milestone makes the selected Electron window interactive while
preserving passive rendering by default and the existing public SDK. Ordered
multi-window composition and routing were completed in the July 11 successor
milestone; see
[the multi-window compositor handoff](hudhook-multiwindow-compositor-handoff.md).
A bounded uniform 1.25 device-scale proof was subsequently added. Real
per-monitor/mixed-DPI handling, texture retirement, and D3D12 remain follow-up
work.

## Reproduce the completed proof

```powershell
git fetch origin
git switch feat/overlay-pocs
git pull --ff-only
```

Run the deterministic input regression first:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
```

Then rerun the lifecycle and real-client compositor regressions:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientWindow -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Client -Wait
```

All commands must be run from a regular PowerShell at the repository root. See
[the POC README](../poc/hudhook-imgui-overlay/README.md) for prerequisites and
safety boundaries.

## Proven baseline

The branch currently proves all of the following on Windows x64/D3D11:

- upstream hudhook 0.9.1 injects the project-owned payload without ReShade;
- the real built Electron client can opt into its existing overlay session with
  `--start-overlay-session`;
- the injected bridge connects to the existing `node-game-overlay` IPC host and
  shared mappings without loading the legacy native renderer;
- `HUDHOOK_ELECTRON_WINDOW` is now an optional exact-name filter; when it is
  unset, every announced window participates in the ordered compositor;
- premultiplied BGRA is converted to straight RGBA off the render thread;
- ImGui composes per-window textures borderlessly at signed native bounds;
- bounds changes reuse existing textures instead of reuploading unchanged pixels;
- per-window close clears that surface and re-registration resumes it;
- the lifecycle producer waits for the injected target's `game.process` event before
  starting move/close/re-register timers;
- attached runners validate exact-PID markers and clean only their controlled process
  trees.

Primary implementation files:

- [frame/IPC bridge](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/electron_frame.rs);
- [hudhook render loop](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/lib.rs);
- [real-client/lifecycle runner](../poc/hudhook-imgui-overlay/scripts/run-electron-dx11.ps1);
- [controlled lifecycle producer](../poc/hudhook-imgui-overlay/electron-client-window-demo/main.cjs);
- [client opt-in startup](../apps/client/src/main/electron/app-entry.ts).

## Implemented return path to Electron

The implementation reuses the existing Electron side:

1. `OverlaySession.input.intercept()` and `.release()` send
   `command.input.intercept` through the Node add-on.
2. The game-side client is expected to return `game.input.intercept`, `game.input`,
   and `game.window.focused` packets.
3. `OverlaySession` receives `game.input`, calls the add-on's
   `translateInputEvent()`, divides the returned local physical `x`/`y` by its
   cached display scale factor, and calls
   `BrowserWindow.webContents.sendInputEvent()` with signed DIP coordinates.
4. `game.window.focused` already drives Electron webview focus.

Relevant existing code:

- [OverlaySession input API and forwarding](../libs/electron-game-overlay/src/lib/overlay-session.ts);
- [native packet schemas](../libs/node-game-overlay/src/message/gmessage.hpp);
- [Node command serialization and input translation](../libs/node-game-overlay/src/overlay.h).

The hudhook payload now completes the game-side producer: it handles
`command.input.intercept`, publishes interception/focus acknowledgements, and sends
translated input packets back to the Node host from its IPC worker.

## Implemented milestone

`ExampleMainOverlay` is interactive while it remains the only
selected/composited window. Passive rendering remains the default, the public SDK
is unchanged, and no hudhook fork was needed; hudhook 0.9.1 exposes the required
`ImguiRenderLoop::after_wnd_proc()` and `message_filter()` seams.

The retained acceptance criteria are:

1. Intercept off is fail-open: the game receives input and the overlay is passive.
2. `session.input.intercept()` reaches the payload and enables effective interception.
3. A pointer down inside the selected rect focuses the Electron window before the
   click packet is sent.
4. Mouse move/down/up and vertical wheel reach the page with overlay-local
   coordinates.
5. Key down/up and `WM_CHAR` reach the focused Electron window, including text input.
6. Pointer capture survives drags outside the overlay until the matching button up.
7. Input outside the selected window is swallowed while global interception is active,
   matching the existing public API.
8. Release, selected-window close, or target focus loss clears focus/capture and
   restores safe game input.
9. A controlled runner proves click, text, wheel, blocked Escape, released Escape,
   Electron markers, payload markers, and clean process exit.

The `-ClientInput` end-to-end run proves left-click/focus ordering, typed text,
vertical wheel, intercepted and released Escape behavior, interception
acknowledgements, and normal host exit. Router and bridge unit tests cover
outside-bounds pointer capture/release, outside-overlay swallowing, right/middle
buttons, horizontal-wheel conversion, system keys, `WM_SYSCHAR`/`WM_UNICHAR`,
move coalescing, synthetic releases on cancellation/lifecycle cleanup, guarded
filter transitions, and transport retry classification. Those cases are unit or
native-translator coverage, not claims about the Electron DOM end-to-end run.

## Implemented design

### 1. Bidirectional bridge

`electron_frame.rs` was extended without sending synchronous cross-process messages
from the render/present thread:

- deserialize `command.input.intercept { intercept }`;
- store requested/desired/effective interception in shared atomic state;
- add an outbound queue owned by `ElectronFrameBridge`;
- wake the existing IPC worker with a private `WM_APP` message;
- drain and serialize outbound packets on that worker;
- generalize the current `send_game_process()` packer instead of adding a second
  packet format;
- coalesce only adjacent mouse moves and preserve FIFO barriers for every other
  queued packet;
- use bounded transport sends, retry only idempotent focus/intercept controls, and
  never retry non-idempotent `game.input` after an ambiguous failure.

The existing envelope is:

```text
i32 direction = 0
i32 client_id = 0
i32 host_port = 0
i32 message_id = 100
length-prefixed UTF-8 message type
length-prefixed UTF-8 JSON
```

Send it to the current host with a two-second `SendMessageTimeoutW` for
`WM_COPYDATA`, using the injected process ID as `dwData`. A failed idempotent
control retries after 250 ms; input is at-most-once, and explicit rejection is not
retried.

Outbound JSON shapes:

```json
{"type":"game.input.intercept","intercepting":true}
{"type":"game.window.focused","focusWindowId":1}
{"type":"game.input","windowId":1,"msg":512,"wparam":0,"lparam":0}
```

A small `electron_input.rs` module owns hit testing, project-owned focus/capture
state, message classification, and pure unit tests; `electron_frame.rs` remains
responsible for transport and selected-window publication.

### 2. Win32 routing through hudhook

The render loop implements `after_wnd_proc()` and `message_filter()`:

- use interior mutable/shared input-router state because the callbacks receive
  `&self`;
- forward left/right/middle mouse, vertical/horizontal wheel, keyboard, system-key,
  `WM_CHAR`, `WM_SYSCHAR`, and valid `WM_UNICHAR` messages;
- use filtered arming and disarming phases for complete queue drains before
  enabling Electron routing or publishing pass-through, so boundary input cannot
  reach both destinations;
- emit each acknowledgement only after the matching terminal filter phase is
  published; input that races a transition may be dropped but is never
  double-delivered;
- clear effective interception when no selected Electron window exists, while
  retaining the requested state so re-registration can restore it;
- keep the diagnostics ImGui window noninteractive;
- replace the fixed `Input: pass-through` diagnostics line with requested/effective
  intercept, focus, and capture state.

hudhook's actual WndProc reads the filter asynchronously from pipeline state.
`message_filter()` samples the next phase, `before_render()` commits/logs the value
hudhook just stored, and the runner waits for both that boundary and the later
routing acknowledgement. The guarded arming drain is what makes separate WndProc
and render threads safe without a hudhook fork. The runner also asserts that each
payload boundary marker precedes its acknowledgement log.

### 3. Coordinate contract

Electron's public geometry is expressed in device-independent pixels (DIP),
while the existing native boundary is physical pixels:

- `BrowserWindow` bounds, SDK caption height, drag border, and resize constraints
  are DIP;
- `OverlaySession` scales every rectangle component (`x`, `y`, `width`, and
  `height`) plus constraints, caption margins/height, and drag-border width before
  publishing metadata;
- `ElectronFrame.rect`, SDK wire metadata, Electron 16 OSR bitmap dimensions,
  game-client mouse coordinates, and the swap-chain/ImGui `display_size` are
  physical pixels;
- placement coordinates round with their sign preserved, while nonnegative
  extents use a deterministic floor;
- returned overlay-local physical input divides by the cached factor and rounds
  back to signed DIP before Electron receives it.

Hudhook derives ImGui `display_size` from the native swap-chain buffer. The
payload therefore normalizes `display_framebuffer_scale` to `(1, 1)` so the D3D
viewport does not apply DPI a second time.

- regular mouse `lParam` coordinates are game-client physical coordinates;
- hit-test against the selected physical rect and subtract `rect.x`/`rect.y`;
- pack signed overlay-local physical 16-bit coordinates back into `lParam`;
- wheel messages contain screen coordinates, so call `ScreenToClient()` first;
- preserve `wParam` button/modifier and wheel-delta bits;
- route keyboard/character messages only to the focused selected window.

The original `-ClientInput` proof remains at forced 100% scale. Use the successor
multi-window proof for the uniform non-1.0 contract:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
```

The 1.25 run proves a uniformly forced Electron scale, including two-window
composition, routing, and caption dragging. It is not real per-monitor-DPI-v2 or
mixed-monitor evidence. The current Electron 16 session caches the display factor
nearest `(0, 0)` at startup; runtime scale changes, physical/VM DPI behavior, and
Electron 42 OSR semantics remain separate validation work.

This slice also fixes and hardens native translation:

- decode mouse coordinates as signed 16-bit values in
  `libs/node-game-overlay/src/overlay.h`; captured drags may be negative;
- rename the emitted Electron field `canScroll ` to `canScroll`.
- emit horizontal wheel as a correctly signed Electron `deltaX`;
- translate `WM_SYSCHAR` and valid UTF-32 `WM_UNICHAR` while rejecting dead,
  reserved, invalid, and otherwise unsupported messages;
- reject X1/X2 instead of allowing Electron 16 to misinterpret them as left clicks.

Horizontal-wheel routing and translation are unit/self-tested, not DOM-tested.
Faithful X1/X2 delivery remains open because Electron 16 `sendInputEvent` supports
only left/middle/right; hudhook's blanket filter intentionally swallows X buttons
while interception is active.

### 4. Deterministic input runner

The controlled lifecycle producer and runner include a `-ClientInput` mode:

1. Wait for `game.process` as the lifecycle mode already does.
2. Request `session.input.intercept()`.
3. Wait for both the enabled render-boundary marker and enabled routing
   acknowledgement.
4. Instrument the real page's first text input and wheel/click handlers with stable
   stdout markers; print its DOM target rect instead of hard-coding coordinates.
5. Activate the controlled host and use Win32 `SendInput` to click the text field,
   type a known value, and send a vertical wheel event.
6. Send Escape while intercepted and prove the host remains alive.
7. Release interception, wait for both the disabled acknowledgement and disabled
   render-boundary marker, send Escape
   again, and prove the host exits normally.

Suggested exact markers:

```text
Electron input intercept enabled
Electron overlay focused for input
Electron mouse input forwarded
Electron keyboard input forwarded
Electron input intercept disabled
HUDHOOK_CLIENT_INPUT_TARGET x=<x> y=<y> width=<w> height=<h>
HUDHOOK_CLIENT_INPUT_VALUE value=<expected>
HUDHOOK_CLIENT_INPUT_LIFECYCLE_COMPLETE
```

The real page already contains two buttons and a text input. The popup button also
resizes the main overlay by 20 pixels and is a useful single-click integration test.
Do not stress-click it until texture retirement is implemented.

## Unit coverage

The router tests and native translation self-test cover:

- inclusive/exclusive hit-test edges and signed coordinates;
- game-client to overlay-local mapping;
- wheel screen-to-client conversion seams;
- horizontal-wheel routing and native `deltaX` translation;
- focus packet before first mouse-down packet;
- pointer capture through an out-of-bounds move/release;
- matching synthetic button-up packets for `WM_CANCELMODE`, `WM_CAPTURECHANGED`,
  release, close, focus loss, and re-registration;
- keyboard and character gating by focus;
- `WM_SYSCHAR`/valid `WM_UNICHAR` translation and safe rejection of unsupported
  native messages including X1/X2;
- close, target focus loss, intercept release, and re-registration cleanup;
- outbound packet encoding and move coalescing;
- guarded arming/disarming transitions, acknowledgement ordering, and
  idempotent-control versus at-most-once-input retry policy;
- fail-open behavior when no selected window exists.

The completed verification sequence is:

```powershell
npx nx run client:typecheck
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientMultiWindow -DeviceScaleFactor 1.25 -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientWindow -Wait
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Client -Wait
```

Also run workspace Rust tests, `cargo fmt --check`, and Clippy with warnings denied
through the Windows MSVC developer shell.

## Known limitations and traps

- The first input slice covers Win32 messages only. Raw-input-only games,
  DirectInput, XInput, GameInput, and gamepads remain compatibility work.
- While intercept is active, block `WM_INPUT` to protect the game even though raw
  input is not yet translated.
- X1/X2 are intentionally swallowed during interception because Electron 16's
  public input API cannot represent them without turning them into false left clicks.
- hudhook's public filter is blanket rather than per-message. Selective click-through
  may require a different WndProc strategy or an upstream change.
- hudhook applies callbacks and filter changes only from `Present`; if presentation
  stops immediately after focus loss, fail-open publication waits until it resumes.
- the first software-capture implementation preserves drags outside the Electron rectangle
  while messages still reach the target HWND; cross-HWND capture needs a separate
  Win32 capture strategy.
- High-frequency mouse movement must not build an unbounded IPC queue.
- DOM text focus depends on sending focus before mouse down and preserving FIFO order.
- `command.cursor` is still ignored; cursor-shape feedback is a follow-up.
- Repeated bitmap dimension changes allocate new hudhook texture IDs and currently
  retain the old GPU resources for the renderer lifetime.
- A failed texture upload is retried only when Electron publishes a newer frame.
- The runner's `Start-Process -ArgumentList` path is not robust to repository paths
  containing spaces.
- The native add-on still exposes one fixed IPC host name, so only one producer may
  run at a time.
- The bounded 1.25 proof uses one forced uniform Electron scale. The session
  caches Electron 16's display factor nearest the primary origin and does not yet
  update scale per window or after a runtime DPI transition; real mixed-monitor,
  PMv2, physical/VM DPI, and Electron 42 OSR behavior remain unproven.
- Anti-cheat-protected targets remain outside this controlled POC.

## Scope discipline

The first input slice deliberately did not redesign the Electron SDK, shared-memory
format, multi-window compositor, or graphics backend. It reuses the existing packet
protocol and keeps upstream hudhook pinned. A hudhook fork remains justified only if
a controlled test demonstrates a missing hook capability that cannot live in project
code or be contributed upstream.
