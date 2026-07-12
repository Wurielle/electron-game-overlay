# Local hudhook patch

This directory starts from the published `hudhook` 0.9.1 crate. It is kept as a
path patch so the input proof is deterministic while the changes are prepared
for an upstream contribution or a pinned upstream revision.

The local delta is limited to Win32 input ownership and guarded teardown
groundwork for those hooks:

- `src/sync_input.rs` owns `WM_INPUT` data synchronously and exposes a
  thread-safe WndProc observer that never aliases the mutable render loop. The
  observer receives its pipeline target HWND before the replacement WndProc is
  installed, allowing process-wide input records without an HWND to route their
  first packet;
- `src/renderer/pipeline.rs` invokes that observer before queueing or forwarding,
  fixes the WndProc installation-state race, carries copied raw data to Present,
  and uses message-appropriate handled results including `DefWindowProcW` cleanup
  for foreground `WM_INPUT`;
- `src/renderer/input.rs` consumes the owned raw packet instead of dereferencing
  `HRAWINPUT` after the receiving WndProc returned;
- `src/lib.rs` adds the source-compatible optional observer factory to
  `ImguiRenderLoop`, installs optional process-input hooks from the same shared
  phase state, and disables/drains/cleans hooks before MinHook releases their
  trampolines;
- `src/process_input.rs` masks mouse-button state from `GetAsyncKeyState`,
  `GetKeyState`, and `GetKeyboardState`, returns an off-client game-visible
  `GetCursorPos` result while interception owns input, and neutralizes buffered
  raw-mouse records after copying them to the overlay. The buffered behavior is
  adapted from ReShade's maintained BSD-licensed Win32 input implementation.
  Hudhook's own raw copier uses the saved cursor trampoline so game-facing
  suppression cannot corrupt overlay coordinates. Atomic counters make each
  adapter observable from the render thread;
- the backend hook files and pipeline now propagate cleanup failure. A WndProc
  that cannot be restored leaves the DLL pinned instead of unloading code that
  is still reachable.

The POC does not expose runtime ejection through its SDK and tests teardown by
exiting the target process. A callback suspended before the Rust detour guard,
partial hook construction, and same-process retry still require lifecycle
hardening before `hudhook::eject()` can be treated as a supported path.

Graphics rendering behavior, injection, texture handling, and MinHook itself
remain the upstream 0.9.1 implementation. The local lifecycle change should be
upstreamed independently of the project-specific process-input policy.
