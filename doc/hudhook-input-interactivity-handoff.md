# Hudhook input and interactivity handoff

> **Host decision update, July 13, 2026:** This remains the verified Electron
> transport, compositor, routing, and controlled-input acceptance record, but
> hudhook is no longer the selected production host. The final Gun Frog run
> restored Electron and native ImGui interaction, yet Unity continued to receive
> mouse hover/click activity while interception was active. `GetCursorPos` was
> masked throughout the intercepted intervals, while `GetRawInputBuffer` call
> counters did not advance in those intervals; widening guessed project-owned
> detours would therefore recreate an open-ended game-input compatibility layer.
> The active experiment moves process entry, graphics/ImGui lifecycle, and
> game-side blocking to ReShade. The controlled D3D11/D3D12 visible gates and
> real multi-window Electron scenes passed. The first ReShade Gun Frog run then
> exposed Unity 6's separate mouse-in-pointer projection: Electron received the
> blocked legacy click while `WM_POINTER` still activated the underlying Unity
> control. A pinned ReShade patch and controlled pointer oracle now suppress the
> `PT_MOUSE` stream, keep native ImGui interactive, and translate primary
> move/left-click records on the ordered Electron consumer on D3D11/D3D12.
> The real Gun Frog rerun subsequently passed the same input boundary: an
> Electron click directly above Unity's `Continue` control stayed in Electron,
> with text, z-order, and caption dragging working too. Releasing through the
> manual Electron control was acknowledged, and the next Continue click entered
> gameplay, proving pass-through restoration. A July 13 strengthened run then
> aligned Electron buttons over Continue, New Game, Settings, and Quit: all four
> reached only Electron while Gun Frog remained on its menu and alive; after the
> complete release acknowledgement, the same underlying Quit position closed
> the game. The production client and SDK subsequently passed that exact Gun
> Frog boundary through the ReShade launcher on the process-name,
> arm-before-launch path. The production path also passed two isolated
> controlled D3D12 multi-window/lifecycle cycles. Raw-input normalization,
> graceful disable/unload, late injection, arbitrary fast-start targets, and
> other games remain hardening; the ReShade POC README is authoritative.
> The authenticated Node/Rust transport, wire/frame
> validation, ordered scene/router, Electron input translation and
> `focusOnWebView()` behavior, multi-window/z-order/capture rules, and DPI/raster
> contracts are intended to be reused behind the new host boundary.

> Completed July 10, 2026 on `feat/overlay-pocs`. The deterministic `-ClientInput`
> proof passed click/focus, text, vertical wheel, intercepted Escape, release, and
> released Escape, followed by passing `-ClientWindow` and `-Client` regressions.
> This document is retained as the design and acceptance record.

The implemented milestone makes the selected Electron window interactive while
preserving passive rendering by default and the existing public SDK. Ordered
multi-window composition and routing were completed in the July 11 successor
milestone; see
[the multi-window compositor handoff](hudhook-multiwindow-compositor-handoff.md).
A bounded uniform 1.25 device-scale proof and per-producer-window desired/active
scale transition foundation were subsequently added. Controlled D3D12 parity and
SDK-owned backend/injection-request orchestration is now complete too.
A follow-on source migration replaced the native add-on/shared-memory path with
the project-owned authenticated Node/Rust loopback transport and removed the old
packages from the active client/SDK npm dependency and root build paths. Archived
Nx project definitions remain explicitly selectable as legacy reference. The
replacement was revalidated on July 11 with the D3D11/D3D12 input, lifecycle,
multi-window, and real-client launchers listed below. Target-game display/client-origin ownership, real
mixed-monitor acceptance, and texture retirement remain post-POC hardening.

The normal Windows x64 `electron-game-overlay` build now stages the ReShade
launcher, runtime, project add-on, configuration, and build manifest under
`libs/electron-game-overlay/dist/runtime/win32-x64/reshade`. The public
`ReShadeOverlayLauncher` owns per-run isolation, process-name pre-launch arming,
transport readiness, and authenticated target connection proof; ReShade selects
the graphics API without a manual client backend setting. The real client
imports those public SDK APIs and contains no separate launcher or native
staging implementation.

## July 12 ReShade controlled-gate update

The replacement host passed its repository-owned D3D11 and D3D12 gates. During
each intercepted interval, the independent host's window-message, raw-input,
polling, and cursor counters remained exactly frozen while ReShade logged native
ImGui click, text, drag, and wheel updates. Resizing from 1280 x 720 to
1920 x 1009 preserved blocking and post-resize clicking; release restored the
host's cursor confinement and counter activity.

The real Electron scene now passes on both backends too. A later oracle revision
calls `EnableMouseInPointer(TRUE)` and counts `WM_POINTERUPDATE/DOWN/UP`. Before
the compatibility patch, Electron received the click while these game counters
advanced to `1/1/1`, reproducing the Gun Frog split. After the patch, native
ImGui again accepted button, text, drag, and vertical wheel, and Electron logged
ordered down/focus/drag/up/click packets. Every legacy/raw/polled/pointer counter
remained frozen on D3D11 and D3D12, then resumed on release. Pointer ID, type,
target, and Ctrl/Shift state are captured synchronously, but down/up state is
interpreted only after the single consumer sorts the global observer sequence.
The July 12 Gun Frog rerun then passed the same route and the inverse release
check, closing the standalone real-game gate. The production client/SDK gate
subsequently passed on July 13 through the ReShade launcher, followed by two
passing controlled D3D12 production-client cycles.

## July 13 exact Gun Frog menu acceptance

The dedicated wrapper placed four Electron buttons exactly over Gun Frog's
Continue, New Game, Settings, and Quit controls. Each click emitted its unique
`HUDHOOK_CLIENT_MULTIWINDOW_INPUT ... event=gun-frog-click name=<continue|new-game|settings|quit>`
record while interception remained enabled; Unity stayed on the menu and its
process remained alive through all four. Clicking the Electron release control
then emitted `HUDHOOK_CLIENT_MULTIWINDOW_RELEASE_REQUESTED`,
`HUDHOOK_CLIENT_MULTIWINDOW_INTERCEPT_DISABLED`, and
`HUDHOOK_CLIENT_MULTIWINDOW_LIFECYCLE_COMPLETE`. A final click at the same Quit
position reached the underlying game and closed the Gun Frog process, proving
the inverse pass-through boundary on the destructive menu action rather than
only a navigation action.

## July 13 real client/SDK Gun Frog acceptance

`poc/reshade-imgui-overlay/scripts/test-cases/gun-frog-client-sdk.ps1` built the
production client and SDK ReShade launcher, armed by process name before Gun
Frog launched, and attached to PID 11104. The client received a positive
interception acknowledgement, then the exact aligned Electron Continue, New
Game, Settings, and Quit controls were clicked once each while Gun Frog stayed
alive on its menu. Ctrl+I produced the negative acknowledgement, after which the
same Quit position closed the game. The runner emitted
`GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`.

Evidence is retained under
`build/reshade-imgui-overlay/client-Gun-Frog-20260713-005018` and
`%TEMP%/electron-game-overlay/reshade-runs/Gun-Frog.exe-yE20tq`; the persisted
client-run `result.txt` contains the same pass marker. This acceptance
is limited to the verified process-name, arm-before-launch path; it does not
establish late injection or compatibility with other games.

## July 13 controlled D3D12 production client/SDK acceptance

`poc/reshade-imgui-overlay/scripts/test-cases/d3d12-client-sdk.ps1` drove the
built production client and public SDK through two isolated attempts against
target PIDs 17248 and 13528. Both transported Electron windows accepted focus
and text; the main caption moved, and its field remained clickable at the moved
coordinates. The controlled target stayed foreground and its complete input
oracle remained byte-identical throughout interception. Release restored legacy
down/up, raw input, primary `PT_MOUSE` pointer input, and cursor confinement;
released Escape closed each target normally.

The runner force-cleaned each isolated Electron process tree, required no
host/client/injector leftovers, and relaunched with a distinct ReShade run
directory. It emitted `D3D12_REAL_CLIENT_SDK_GATE_PASS`; evidence is retained
under `build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`. The
controlled host's test-only injection-wait marker gives the prearmed injector
time to hook before deliberately fast D3D12 initialization. This is not evidence
for arbitrary fast-start games, late attachment, or graceful client
disable/unload.

ReShade's managed ImGui state samples button and key state once per `Present`.
The accepted human-duration controls are therefore not evidence about edges that
begin and end entirely between presentations. Exact fast-edge delivery remains
the responsibility of the project-owned Electron input queue retained from this
hudhook work.

## July 12 real-client validation update

Testing against Gun Frog (Unity 6000.0.58f1, D3D11) exposed two gaps that the
controlled Win32 host does not cover:

- the SDK queued input for the correct OSR window, but called
  `WebContents.focus()`, which is a no-op in Electron 16's offscreen view. The
  SDK now calls `BrowserWindow.focusOnWebView()` immediately before every
  `sendInputEvent()` packet. That focuses Chromium's render widget without
  activating a native window or taking foreground ownership from the game;
- hudhook's WndProc filter stops the game's camera movement, but Unity UI can
  still observe hover/button state through cursor, polling, raw-input, or native
  Input System paths outside that WndProc.

The demo client now registers **Ctrl+I** through Electron's `globalShortcut`,
does not register that chord in the payload, pushes
shortcut-driven state changes to the visible renderer, and displays/logs a DOM
input receipt marker in `ExampleMainOverlay`.

The injected payload also renders a standalone lower-left native ImGui input
probe above the Electron textures. Its button reports hover/active state, click
count, numeric ImGui mouse position, `want_capture_mouse`, effective
interception, and software-cursor state. It consumes hudhook/ImGui input directly
and therefore gives real-game testing a binary comparison against the Electron
return path before any composition architecture is replaced.

A bounded process-input adapter is now installed with the payload. It calls
the original User32 APIs, then masks mouse virtual keys from
`GetAsyncKeyState`, `GetKeyState`, and `GetKeyboardState`, and returns an
off-client point from game-facing `GetCursorPos` calls during arming, enabled,
and disarming phases. Hudhook's own raw copier calls the saved cursor trampoline
so those game-facing values never contaminate overlay coordinates.

The first Gun Frog rerun then proved correct DOM hover coordinates but zero
mouse-button packets for both Electron and native ImGui. UnityPlayer imports
`GetRawInputBuffer`, whose buffered records can bypass the hooked render HWND.
The adapter now copies those original mouse records into the shared owned queue,
then applies ReShade's maintained neutralization pattern to the game-facing
records. Hudhook binds the swap-chain HWND to the owned source before installing
its replacement WndProc, and activation seeds the route from the unfiltered
client cursor, so a buffered-only first click no longer depends on an earlier
window message. Absolute buffered packets resample that cursor. A physical
high-bit snapshot repairs a missing held-button down/up edge; the racy
`GetAsyncKeyState` low-bit hint is deliberately not synthesized because it can
duplicate the corresponding buffered raw pair. Per-API counters now include the
raw-buffer path. This remains narrower than general Unity Input System or
DirectInput support.

The local path patch also improves hudhook 0.9.1 teardown ordering: ejection is
scheduled outside the active Present callback, MinHook entry points are
disabled, guarded callbacks drain, and WndProc/backend cleanup is fallible. A
cleanup failure leaves the module loaded. Runtime unload is not part of the POC
acceptance contract, however: a callback suspended before its Rust entry guard
still requires lower-level quiescence. The client never calls `eject()` and the
supported POC teardown remains target-process exit; transactional construction,
same-process retry, and fully proven runtime unload are tracked separately.

The native ImGui failure under interception then isolated a lower seam defect:
hudhook 0.9.1 queued the opaque `HRAWINPUT` and called `GetRawInputData` only at a
later `Present`, after the receiving WndProc had returned. It also returned one
for every filtered message and skipped the required foreground `WM_INPUT`
`DefWindowProcW` cleanup. The POC now path-patches a narrow local 0.9.1 fork that
copies raw mouse/keyboard data synchronously and exposes a thread-safe WndProc
observer. The project observer owns mouse/raw propagation during terminal
interception, queues normalized pointer events once, and fans the same ordered
batch to ImGui and Electron during `before_render`. Arming/disarming consume but
do not route pointer events; focus loss and release synthesize button-up cleanup.
Legacy/raw keyboard packets remain on hudhook's copied-input queue for this slice.

## Reproduce the completed controlled proof

```powershell
git fetch origin
git switch feat/overlay-pocs
git pull --ff-only
```

Run the deterministic input regression first:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-automated.ps1
```

Then rerun the lifecycle and real-client compositor regressions:

```powershell
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-window-lifecycle.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-client.ps1
```

All commands must be run from a regular PowerShell at the repository root. See
[the POC README](../poc/hudhook-imgui-overlay/README.md) for prerequisites and
safety boundaries.

## Proven baseline

The current tree proves all of the following on controlled Windows x64 targets:

- upstream hudhook 0.9.1 injects the project-owned payload without ReShade;
- the real built Electron client can opt into its existing overlay session with
  `--start-overlay-session`;
- the real client's main process can additionally opt into one backend-specific
  hudhook request while the project-owned loopback transport is active;
- the injected bridge connects to an ephemeral IPv4 loopback port, authenticates
  with a fresh session token, and receives raw BGRA frames without loading the
  legacy native renderer or Node native add-on;
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

- [frame/transport bridge](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/electron_frame.rs);
- [Node loopback transport](../libs/electron-game-overlay/src/lib/hudhook-transport.ts);
- [project-owned input translation](../libs/electron-game-overlay/src/lib/input-translation.ts);
- [hudhook render loop](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/lib.rs);
- [real-client/lifecycle runner](../poc/hudhook-imgui-overlay/scripts/run-electron-dx11.ps1);
- [controlled lifecycle producer](../poc/hudhook-imgui-overlay/electron-client-window-demo/main.cjs);
- [client opt-in startup](../apps/client/src/main/electron/app-entry.ts).

## Implemented return path to Electron

The implementation reuses the existing Electron side:

1. `OverlaySession.input.intercept()` and `.release()` send
   `command.input.intercept` through the project-owned Node transport.
2. The game-side client is expected to return `game.input.intercept`, `game.input`,
   and `game.window.focused` packets.
3. `OverlaySession` receives `game.input`, calls the pure TypeScript
   `translateInputEvent()`, divides the returned local physical `x`/`y` by the
   packet's optional `scaleFactorMicros`, and calls
   `BrowserWindow.focusOnWebView()` followed by
   `BrowserWindow.webContents.sendInputEvent()` with signed DIP coordinates. It
   never calls `BrowserWindow.focus()` for this path, so the game retains native
   foreground ownership.
   New payload packets carry the scale active when they were routed, preventing
   queued input from being reinterpreted after a later scale commit; an untagged
   legacy packet falls back to that window's current active factor.
4. `game.window.focused` already drives Electron webview focus.

Relevant existing code:

- [OverlaySession input API and forwarding](../libs/electron-game-overlay/src/lib/overlay-session.ts);
- [Node packet framing, authentication, and session state](../libs/electron-game-overlay/src/lib/hudhook-transport.ts);
- [TypeScript Win32-to-Electron translation](../libs/electron-game-overlay/src/lib/input-translation.ts);
- [Rust packet framing and validation](../poc/hudhook-imgui-overlay/crates/overlay-ui/src/electron_wire.rs).

The hudhook payload now completes the game-side producer: it handles
`command.input.intercept`, publishes interception/focus acknowledgements, and sends
Win32 input packets back to the Node host from its loopback worker.

## Implemented milestone

`ExampleMainOverlay` is interactive while it remains the only
selected/composited window. Passive rendering remains the default, the existing
window/input SDK surface remains compatible. The original controlled proof used
hudhook's public `after_wnd_proc()` and `message_filter()` seams; real-game input
now additionally uses the narrow local synchronous-WndProc patch described above.

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
TypeScript-translator coverage, not claims about the Electron DOM end-to-end run.

## Implemented design

### 1. Bidirectional bridge

`HudhookLoopbackTransport` starts a Node TCP server on `127.0.0.1` with an
ephemeral port. It atomically publishes a versioned discovery document under the
user's temporary directory containing the producer PID, port, and a fresh
256-bit token. The Rust payload reads that document, connects only to IPv4
loopback, and sends the token, protocol version, target PID, and executable path
in its first `game.process` packet. Node rejects malformed, wrong-version, or
wrong-token first packets before publishing a snapshot.

The discovery PID identifies the producer that owns the rendezvous document; it
is not the target selector. The SDK launcher correlates the
authenticated hello's target PID against its expected PID at the application
event layer. One well-known discovery document and one active producer are an
intentional POC constraint; per-target rendezvous belongs to production-launcher
hardening.

Both directions use one incremental framing contract:

```text
u32 little-endian body bytes
u8 packet kind: 1 = JSON, 2 = raw frame

JSON body: UTF-8 object
frame body: u32 windowId, u32 width, u32 height, width * height * 4 BGRA bytes
```

JSON bodies are capped at 1 MiB and frame bodies at 256 MiB. Both implementations
validate packet sizes and frame dimensions before dispatch. Node sends a canonical
window/control snapshot and each latest frame after authentication, allowing a
fresh connection to recover current state.

`electron_frame.rs` still sends no synchronous cross-process traffic from the
render/present callbacks. A private `WM_APP` wake serializes state mutations, while
a nonblocking network worker uses bounded Rust channels (256 outbound commands and
8 inbound packets). The Node sender preserves controls as FIFO barriers and
replaces only adjacent, still-unsent frames for the same window. On disconnect the
payload clears its scene and outbound input, publishes fail-open interception, and
retries discovery after 500 ms. Idempotent focus/intercept controls may retry after
250 ms; non-idempotent `game.input` is never replayed after an ambiguous failure.

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

The render loop combines the synchronous owned-pointer observer with
`after_wnd_proc()` and `message_filter()`:

- use interior mutable/shared input-router state because the callbacks receive
  `&self`;
- synchronously normalize left/right/middle/X mouse, raw mouse motion/buttons,
  and vertical/horizontal wheel into one pointer queue for ImGui and Electron;
- leave legacy/raw keyboard, system-key, `WM_CHAR`, `WM_SYSCHAR`, and valid
  `WM_UNICHAR` on hudhook's copied-input queue;
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

hudhook's actual WndProc still reads the published keyboard/raw fallback filter
asynchronously from pipeline state, while the project observer makes the mouse
propagation decision synchronously.
`message_filter()` samples the next phase, `before_render()` commits/logs the value
hudhook just stored, and the runner waits for both that boundary and the later
routing acknowledgement. The guarded arming drain keeps routing disabled while
the synchronous observer already blocks boundary pointer traffic. The runner also
asserts that each payload boundary marker precedes its acknowledgement log.

### 3. Coordinate contract

Electron's public geometry is expressed in device-independent pixels (DIP),
while the existing native boundary is physical pixels:

- public `BrowserWindow` bounds, SDK caption height, drag border, and resize
  constraints are DIP; registration and reconciliation use
  `BrowserWindow.getContentBounds()` rather than outer bounds so metadata matches
  the surface that emits OSR paints;
- `OverlaySession` scales every rectangle component (`x`, `y`, `width`, and
  `height`) plus constraints, caption margins/height, and drag-border width before
  publishing metadata;
- `ElectronFrame.rect`, SDK wire metadata, Electron 16 OSR bitmap dimensions,
  game-client mouse coordinates, and the swap-chain/ImGui `display_size` are
  physical pixels;
- placement coordinates round with their sign preserved, while nonnegative
  extents use a deterministic floor;
- every window keeps a desired display scale and an active scale associated with
  its accepted OSR frame;
- a scale transition commits only when a paint is within one pixel per dimension
  of its nominal floor-scaled size; accepted bitmap dimensions become the
  authoritative rect and fixed-window constraints, while old-size paints remain
  on the active raster and unmatched/invalid paints are suppressed;
- if one bitmap fits both active and desired tolerances, the SDK rejects the
  ambiguous callback, waits for renderer DPR/viewport acknowledgement, and
  commits only a causally subsequent `capturePage()` cropped to the desired DIP
  content rectangle, using the capture's returned bitmap dimensions;
- returned overlay-local physical input carries the routing-time scale tag and
  rounds back to signed DIP with it before Electron receives it; legacy input
  without a tag uses the window's current active factor.

`window.bounds` now carries the complete physical geometry during a transition:
rect, resize constraints, caption margins/height, and drag-border width. The
host updates the existing registration without reordering it. A committed
raster change sets `rasterChanged: true`, causing the Rust bridge to clear the
latest compositable raster until the next framebuffer instead of pairing old
pixels with new geometry. The old GPU texture is not retired by this mechanism.

Frames now travel directly as raw BGRA packet bodies rather than through named
shared mappings. The Node encoder requires positive unsigned dimensions, checks
`width * height * 4` as a safe integer, requires the exact source-buffer length,
and enforces the frame-body cap. The Rust decoder independently checks the header,
overflow, body length, dimensions, and exact pixel byte count before publishing a
frame. A `rasterChanged` control remains a barrier that drops stale unsent frames
for that window before the new geometry is delivered.

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
mixed-monitor evidence. The controlled host now establishes PMv2 before HWND
creation, computes its initial outer rect with `AdjustWindowRectExForDpi`, and
applies the `WM_DPICHANGED` suggested rectangle; the SDK can stage a
producer-window runtime scale change. The current validation machine has only one
100% virtual display, so the forced 1/1.25/1.5/2 regressions do not exercise a
real monitor transition. Target-HWND/client-origin ownership, backing-window
placement, multi-target routing, physical/VM mixed-scale behavior, and Electron
42 OSR semantics remain separate validation work.

Input translation is now project-owned TypeScript rather than native add-on code:

- decode mouse coordinates as signed 16-bit values; captured drags may be negative;
- rename the emitted Electron field `canScroll ` to `canScroll`;
- emit horizontal wheel as a correctly signed Electron `deltaX`;
- translate `WM_SYSCHAR` and valid UTF-32 `WM_UNICHAR` while rejecting dead,
  reserved, invalid, and otherwise unsupported messages;
- reject X1/X2 instead of allowing Electron 16 to misinterpret them as left clicks.

Horizontal-wheel routing and translation are unit/self-tested, not DOM-tested.
Faithful X1/X2 delivery remains open because Electron 16 `sendInputEvent` supports
only left/middle/right; the owned pointer handler intentionally swallows X buttons
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

The Rust router tests and TypeScript translation tests cover:

- inclusive/exclusive hit-test edges and signed coordinates;
- game-client to overlay-local mapping;
- wheel screen-to-client conversion seams;
- horizontal-wheel routing and TypeScript `deltaX` translation;
- focus packet before first mouse-down packet;
- pointer capture through an out-of-bounds move/release;
- matching synthetic button-up packets for `WM_CANCELMODE`, `WM_CAPTURECHANGED`,
  release, close, focus loss, and re-registration;
- keyboard and character gating by focus;
- `WM_SYSCHAR`/valid `WM_UNICHAR` translation and safe rejection of unsupported
  native messages including X1/X2;
- close, target focus loss, intercept release, and re-registration cleanup;
- outbound packet encoding and move coalescing;
- authenticated loopback snapshot ordering, authentication rejection, raw frame
  framing, fragmented decoding, size caps, and control/frame backpressure barriers;
- guarded arming/disarming transitions, acknowledgement ordering, and
  idempotent-control versus at-most-once-input retry policy;
- fail-open behavior when no selected window exists.

The replacement verification sequence is:

```powershell
npx nx run electron-game-overlay:test
npx nx run client:test
npx nx run client:typecheck
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-input-automated.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-multiwindow-automated-125.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-window-lifecycle.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\dx11-real-client.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-input-automated.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-multiwindow-automated-100.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-window-lifecycle.ps1
.\poc\hudhook-imgui-overlay\scripts\test-cases\d3d12-real-client.ps1
```

Also run workspace Rust tests, `cargo fmt --check`, and Clippy with warnings denied
through the Windows MSVC developer shell.

## Known limitations and traps

- Synchronous raw mouse packets, a virtual relative cursor, User32 polling, and
  ReShade-aligned buffered raw-mouse neutralization are covered by implementation
  and automated tests.
  The retained hudhook path never passed its Gun Frog manual gate; the selected
  ReShade host now has. Raw-keyboard-only text generation, DirectInput, XInput,
  GameInput, and gamepads remain compatibility work.
- WndProc filtering alone does not guarantee game-UI suppression. If Gun Frog
  still reacts while `raw_buffer_calls` stays zero, or while raw records are
  masked, stop adding guessed detours and evaluate a ReShade add-on host.
- Raw mouse is copied and translated synchronously. Raw keyboard is copied safely
  and fed to ImGui, but Electron still depends on the legacy key/character stream.
- X1/X2 are intentionally swallowed during interception because Electron 16's
  public input API cannot represent them without turning them into false left clicks.
- The local synchronous observer supplies per-message WndProc ownership. Move it
  to a pinned upstream revision after contribution rather than growing a permanent
  graphics fork.
- Runtime DLL ejection and same-process hook retry are not supported POC paths.
  The client never invokes `hudhook::eject()`; target-process exit is the tested
  teardown until detour-entry quiescence and transactional hook construction are
  completed.
- hudhook applies callbacks and filter changes only from `Present`; if presentation
  stops immediately after focus loss, fail-open publication waits until it resumes.
- the first software-capture implementation preserves drags outside the Electron rectangle
  while messages still reach the target HWND; cross-HWND capture needs a separate
  Win32 capture strategy.
- Rust network handoff is bounded, and adjacent same-window Node frames coalesce,
  but the Node sender does not yet impose a global queued-byte cap or application
  frame acknowledgement. Pathological alternating multi-window/control traffic is
  therefore still transport-hardening work.
- DOM text focus depends on sending focus before mouse down and preserving FIFO order.
- `command.cursor` is still ignored; cursor-shape feedback is a follow-up.
- Repeated bitmap dimension changes allocate new hudhook texture IDs and currently
  retain the old GPU resources for the renderer lifetime.
- A failed texture upload is retried only when Electron publishes a newer frame.
- The runner's `Start-Process -ArgumentList` path is not robust to repository paths
  containing spaces.
- The POC exposes one well-known discovery document, so only one producer session
  may run at a time. The random token prevents accidental/stale clients from joining
  that session, but same-user discovery-file access and per-target rendezvous remain
  production threat-model and launcher work.
- The forced scale proofs are uniform. Per-window desired/active transitions and
  a PMv2-aware controlled HWND are implemented, but this machine exposes only a
  single 100% virtual display. Real target-display ownership, game-client origin
  mapping, backing-window monitor placement, multi-target geometry, physical/VM
  mixed-scale behavior, and Electron 42 OSR remain unproven.
- Anti-cheat-protected targets remain outside this controlled POC.

## Scope discipline

The original input slice deliberately did not redesign the Electron SDK,
multi-window compositor, or graphics backend. The follow-on migration replaced its
transport and input translator while preserving the public SDK event shapes and
keeping hudhook pinned at 0.9.1. Real-game validation demonstrated a missing
synchronous input capability plus unsafe custom-hook teardown ordering, so the
current path patch carries those reusable seams and the bounded process-input adapter.
Graphics rendering behavior and render backends remain upstream; the intended
endpoint is upstream contributions or a pinned revision, not an expanding
permanent fork.
