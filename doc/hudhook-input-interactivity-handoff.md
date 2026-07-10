# Hudhook input and interactivity handoff

This document is the continuation point for the next computer. The current branch is
`feat/overlay-pocs`. The next priority is input and interactivity for the one selected
Electron window. Multi-window/z-order, arbitrary DPI, texture retirement, and D3D12
come after the first interactive window works.

## Resume the branch

```powershell
git fetch origin
git switch feat/overlay-pocs
git pull --ff-only
```

Run the real-client proof first:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -Client -Wait
```

Run the deterministic lifecycle regression separately:

```powershell
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientWindow -Wait
```

Both commands must be run from a regular PowerShell at the repository root. See
[the POC README](../poc/hudhook-imgui-overlay/README.md) for prerequisites and
safety boundaries.

## Proven baseline

The branch currently proves all of the following on Windows x64/D3D11:

- upstream hudhook 0.9.1 injects the project-owned payload without ReShade;
- the real built Electron client can opt into its existing overlay session with
  `--start-overlay-session`;
- the injected bridge connects to the existing `node-game-overlay` IPC host and
  shared mappings without loading the legacy native renderer;
- one window is selected by `HUDHOOK_ELECTRON_WINDOW`, then
  `ExampleMainOverlay`, then announcement order;
- premultiplied BGRA is converted to straight RGBA off the render thread;
- ImGui composes the texture borderlessly at signed native bounds;
- bounds changes reuse the existing texture instead of reuploading unchanged pixels;
- close clears composition and re-registration resumes it;
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

## Existing return path to Electron

Most of the Electron side already exists and should be reused:

1. `OverlaySession.input.intercept()` and `.release()` send
   `command.input.intercept` through the Node add-on.
2. The game-side client is expected to return `game.input.intercept`, `game.input`,
   and `game.window.focused` packets.
3. `OverlaySession` receives `game.input`, calls the add-on's
   `translateInputEvent()`, applies the display scale factor, and calls
   `BrowserWindow.webContents.sendInputEvent()`.
4. `game.window.focused` already drives Electron webview focus.

Relevant existing code:

- [OverlaySession input API and forwarding](../libs/electron-game-overlay/src/lib/overlay-session.ts);
- [native packet schemas](../libs/node-game-overlay/src/message/gmessage.hpp);
- [Node command serialization and input translation](../libs/node-game-overlay/src/overlay.h).

The missing part is the game-side producer: the hudhook payload currently handles
window/frame messages but ignores `command.input.intercept` and sends no input
packets back to the Node host.

## Next milestone

Make `ExampleMainOverlay` interactive while it remains the only selected/composited
window. Keep passive rendering as the default and preserve the current public SDK.
A hudhook fork is not expected: hudhook 0.9.1 publicly exposes
`ImguiRenderLoop::after_wnd_proc()` and `message_filter()`.

Acceptance criteria:

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

## Recommended implementation

### 1. Make the bridge bidirectional

Extend `electron_frame.rs` without sending synchronous cross-process messages from
the render/present thread:

- deserialize `command.input.intercept { intercept }`;
- store requested/effective interception in shared atomic state;
- add an outbound queue owned by `ElectronFrameBridge`;
- wake the existing IPC worker with a private `WM_APP` message;
- drain and serialize outbound packets on that worker;
- generalize the current `send_game_process()` packer instead of adding a second
  packet format;
- coalesce mouse-move events, but never drop buttons, key/character events, focus,
  releases, or intercept acknowledgements.

The existing envelope is:

```text
i32 direction = 0
i32 client_id = 0
i32 host_port = 0
i32 message_id = 100
length-prefixed UTF-8 message type
length-prefixed UTF-8 JSON
```

Send it to the current host with `WM_COPYDATA`, using the injected process ID as
`dwData`, exactly like `game.process`.

Outbound JSON shapes:

```json
{"type":"game.input.intercept","intercepting":true}
{"type":"game.window.focused","focusWindowId":1}
{"type":"game.input","windowId":1,"msg":512,"wparam":0,"lparam":0}
```

A small `electron_input.rs` module is preferable for hit testing, focus/capture state,
message classification, and pure unit tests; keep `electron_frame.rs` responsible for
transport and selected-window publication.

### 2. Route Win32 input through hudhook

Implement `after_wnd_proc()` and `message_filter()` in the render loop:

- use interior mutable/shared input-router state because the callbacks receive
  `&self`;
- forward regular mouse, keyboard, system-key, and `WM_CHAR` messages;
- return `MessageFilter::InputAll` only while effective interception is enabled;
- clear effective interception when no selected Electron window exists, while
  retaining the requested state so re-registration can restore it;
- keep the diagnostics ImGui window noninteractive;
- replace the fixed `Input: pass-through` diagnostics line with requested/effective
  intercept, focus, and capture state.

hudhook's actual WndProc reads the filter asynchronously from pipeline state, so a
filter change becomes effective on a render-frame boundary. That is acceptable for
the global intercept toggle but must be considered in tests.

### 3. Preserve the coordinate contract

`ElectronFrame.rect` is expressed in game-client physical pixels.

- regular mouse `lParam` coordinates are game-client coordinates;
- hit-test against the selected rect and subtract `rect.x`/`rect.y`;
- pack signed overlay-local 16-bit coordinates back into `lParam`;
- wheel messages contain screen coordinates, so call `ScreenToClient()` first;
- preserve `wParam` button/modifier and wheel-delta bits;
- route keyboard/character messages only to the focused selected window;
- keep the first proof at the runner's forced 100% device scale.

Fix two existing translation defects when starting this slice:

- decode mouse coordinates as signed 16-bit values in
  `libs/node-game-overlay/src/overlay.h`; captured drags may be negative;
- rename the emitted Electron field `canScroll ` to `canScroll`.

Horizontal wheel and X buttons may follow the first vertical-wheel proof.

### 4. Add a deterministic input runner

Extend the controlled lifecycle producer and runner with a `-ClientInput` mode:

1. Wait for `game.process` as the lifecycle mode already does.
2. Request `session.input.intercept()`.
3. Instrument the real page's first text input and wheel/click handlers with stable
   stdout markers; print its DOM target rect instead of hard-coding coordinates.
4. Activate the controlled host and use Win32 `SendInput` to click the text field,
   type a known value, and send a vertical wheel event.
5. Send Escape while intercepted and prove the host remains alive.
6. Release interception, wait for the acknowledgement/frame boundary, send Escape
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

## Unit tests

Keep the router logic platform-light enough to test:

- inclusive/exclusive hit-test edges and signed coordinates;
- game-client to overlay-local mapping;
- wheel screen-to-client conversion seams;
- focus packet before first mouse-down packet;
- pointer capture through an out-of-bounds move/release;
- keyboard and character gating by focus;
- close, target focus loss, intercept release, and re-registration cleanup;
- outbound packet encoding and move coalescing;
- fail-open behavior when no selected window exists.

Then rerun:

```powershell
npx nx run client:typecheck
.\poc\hudhook-imgui-overlay\scripts\run-electron-dx11.ps1 -ClientInput -Wait
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
- hudhook's public filter is blanket rather than per-message. Selective click-through
  may require a different WndProc strategy or an upstream change.
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
- Anti-cheat-protected targets remain outside this controlled POC.

## Scope discipline

Do not redesign the Electron SDK, shared-memory format, multi-window compositor, or
graphics backend during the first input slice. Reuse the existing packet protocol and
keep upstream hudhook pinned. Consider a hudhook fork only if the controlled
one-window acceptance test demonstrates a missing hook capability that cannot live in
project code or be contributed upstream.
