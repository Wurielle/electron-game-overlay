# Todo

## ReShade host migration

Further expansion of project-owned hudhook input detours is frozen. Gun Frog
proved that the overlay could receive routed input while Unity still observed
mouse hover/click state through a path outside the bounded User32/raw-buffer
adapter. ReShade is now the selected production-host experiment because it owns
the broader game-input and graphics-runtime compatibility layer.

### POC finish line

-   [x] Pass the visible ReShade-owned input gate on the controlled D3D11 host.
    -   Prove overlay mouse/keyboard interaction, zero game-side message/raw/polling reactions while active, cursor confinement release, pass-through restoration, and clean shutdown.
-   [x] Pass the same visible gate on the controlled D3D12 host.
    -   Both controlled gates passed on July 12, 2026, including button, text, drag, wheel, active-intercept resize, post-resize click, and release restoration. ReShade's managed ImGui state is sampled once per `Present`; exact fast-edge delivery remains the project-owned Electron queue's responsibility.
-   [ ] Pass the gate against Gun Frog before migrating the SDK/client runtime.
    -   Intercepted hover/click must operate the native ImGui probe without reaching the Unity UI; release must restore normal game behavior.
-   [x] Extract the backend-neutral Rust transport/compositor core from the hudhook renderer.
    -   `poc/electron-overlay-core` now owns `electron_wire.rs`, `electron_frame.rs`, `electron_input.rs`, the authenticated Node loopback transport, ordered scene/router semantics, and premultiplied-BGRA conversion. It builds as both an `rlib` and a Windows static library; the retained hudhook POC consumes the same crate instead of duplicate modules.
-   [x] Finish the narrow, versioned C ABI and ReShade-linked smoke target for that core.
    -   Immutable scene/name/RGBA pointers are leased by explicit snapshots, every fallible Rust export contains panics and returns fixed status codes, and the native layout/link/lifecycle smoke passes. The proven native-only D3D11/D3D12 gate targets remain independent of Cargo.
-   [ ] Port multi-window ReShade texture composition and Electron input return.
    -   Preserve registration order, click-to-front, alpha hit testing, caption drag, pointer capture, focus-before-input, per-packet scale tags, and desired/active raster transitions.
    -   D3D11 now connects the real authenticated Electron producer, enumerates the ordered multi-window snapshot, uploads both live OSR textures through ReShade, renders the transported scene, and acknowledges ReShade-owned interception. Exact Electron input return is the remaining half of this item.
    -   Add one passive full-add-on input-observer event before ReShade nulls blocked window messages, plus the equivalent pre-neutralization event for `GetRawInputBuffer`. ReShade remains the only suppression authority; the event copies data into the project queue and cannot consume or unblock input.
-   [ ] Replace the SDK's hudhook launcher/runtime selection with the ReShade host boundary, then run the existing real-client input, lifecycle, multi-window, and D3D11/D3D12 acceptance matrix.
    -   Keep the public session/window/input surface and Electron-owned Ctrl+I toggle stable.

### Post-POC compatibility and hardening

-   [ ] Add supported-runtime installation, existing ReShade/proxy conflict detection, typed diagnostics, and clean disable/unload behavior.
-   [ ] Add target-HWND display/client-origin ownership, real mixed-monitor acceptance, safe texture retirement, and multiple-target routing.
-   [ ] Expand the compatibility matrix only from observed evidence: Vulkan/OpenGL, exclusive/fullscreen variants, gamepads, DirectInput/XInput/GameInput, and other backend-specific paths.
-   [ ] Keep competitive and anti-cheat-protected targets, anti-cheat bypasses, and VR outside the unsigned full-add-on POC.

## Retained hudhook follow-ups (historical/deferred)

These items document the completed hudhook experiment and possible upstream work;
they are not the active production-host roadmap.

-   [x] Replace hudhook 0.9.1's deferred `WM_INPUT` handle use with a synchronous owned-input seam.
    -   The local path patch copies raw mouse/keyboard packets while the receiving WndProc is active, performs foreground `DefWindowProcW` cleanup, and exposes a thread-safe synchronous observer.
    -   The project observer owns intercepted mouse/raw propagation and fans one normalized pointer queue to ImGui and Electron. Upstream this narrow patch or replace it with a pinned revision after contribution.
-   [ ] Move legacy/raw keyboard and text onto the same owned event queue as pointer input.
    -   Pointer delivery is synchronous, while hudhook currently drains copied keyboard messages before `before_render`; a click and following key within one presentation interval can therefore be reordered.
    -   Raw-keyboard-only text requires explicit Unicode generation; keep the existing legacy key/character path until that is implemented and tested.
-   [x] Add a guarded custom-input-hook teardown phase and bounded process mouse adapter.
    -   Ejection now runs outside an active detour, disables every MinHook entry point, drains guarded callbacks, performs fallible WndProc/backend cleanup, and only then calls `MH_Uninitialize()`. Cleanup failure keeps the module pinned.
    -   The payload masks mouse buttons from `GetAsyncKeyState`, `GetKeyState`, and `GetKeyboardState`, returns a game-only off-client `GetCursorPos`, and neutralizes `GetRawInputBuffer` mouse records after copying them into the owned overlay queue. The pipeline binds its target HWND and seeds the real client cursor before buffered-only input can arrive. High-bit physical state repairs missing held-button edges; the racy low-bit press hint is ignored so it cannot duplicate a buffered click pair.
    -   The raw-buffer behavior follows ReShade's maintained BSD-licensed Win32 implementation. Per-API call/masked counters are reported from the render thread; if Gun Frog still reacts while `raw_buffer_calls` remains zero, stop expanding this adapter and move the backend to ReShade instead of guessing more APIs.
-   [ ] Harden runtime ejection and same-process hook retry before exposing either as a supported SDK feature.
    -   The current client never calls hudhook's `eject()`; closing the target process is the supported POC teardown.
    -   A thread redirected into a detour but suspended before the Rust guard can outlive the current drain barrier. Keep runtime unload out of the public SDK until entry accounting is established at the detour boundary or the DLL is deliberately pinned after deactivation.
    -   Make partial DX9/DX11/DX12 hook construction transactional, replace the process-input `OnceLock` bundle with resettable lifecycle state, and make non-owner MinHook removal retry-safe.
-   [ ] Prove or reject the bounded polling adapter against Gun Frog and a second real title.
    -   Keep DirectInput, other Unity Input System device APIs, XInput, and GameInput as distinct compatibility adapters; do not mark them covered by the User32/raw-buffer proof.
    -   If either title requires one of those broader paths, record the counter evidence and evaluate a ReShade add-on host rather than growing an open-ended local hook matrix.
-   [ ] Add SDK-owned graphics-backend auto-detection for target attachment.
    -   Desired behavior: applications use `backend: "auto"` by default instead of selecting D3D11 or D3D12 for each game/client launch.
    -   Resolve the backend after selecting the target process, using loaded graphics modules and bounded startup observation rather than client-specific game lists.
    -   If D3D11 and D3D12 are both present or detection remains inconclusive, return a typed diagnostic and allow an explicit backend override.
    -   Keep detection and payload selection in `electron-game-overlay`; the demo client should only display the selected backend or ambiguity.
    -   Do not inject both backend payloads as a fallback, because duplicate payload connections/hooks would make session ownership ambiguous.

## API modernization

-   [ ] Modernize `node-game-overlay` to expose a higher-level API that matches the `electron-game-overlay` SDK shape.
    -   Current issue: `libs/node-game-overlay` exposes the native addon as a flat, low-level function surface through `index.d.ts`: `start()`, `stop()`, `sendCommand(...)`, `addWindow(...)`, `closeWindow(...)`, `sendFrameBuffer(...)`, and `setEventCallback(...)`. This mirrors the native transport but is awkward for application code and easy to misuse.
    -   Desired direction: create a typed JS/TS wrapper around the native addon with concepts similar to `ElectronGameOverlay`, `OverlaySession`, `input.intercept()`, `input.release()`, `attachToProcess(...)`, and window handles with `show()`, `hide()`, `destroy()`, `setBounds(...)`, and `sendFrame(...)`.
    -   Possible API sketch:
        -   `const overlay = new GameOverlay()`
        -   `const session = overlay.createSession()`
        -   `session.attachToProcess({ title })` and later `session.attachToProcess({ pid })`
        -   `session.input.intercept()` / `session.input.release()`
        -   `const window = session.windows.add({ id, name, nativeHandle, bounds, ... })`
        -   `window.show()` / `window.hide()` / `window.destroy()` / `window.setBounds(...)`
        -   `window.sendFrame(buffer, width, height)`
        -   `session.on("graphicsWindow", handler)`, `session.on("fps", handler)`, `session.on("input", handler)`, etc.
    -   Keep low-level native calls available internally, but avoid requiring app code to manually build command payloads like `{ command: "input.intercept", intercept }`.
    -   Align naming and event types with `libs/electron-game-overlay/src/lib/overlay-session.ts` where practical, so the Electron SDK can become a thin adapter over the node SDK instead of owning generic overlay/session behavior itself.
    -   Migration note: keep backwards-compatible exports temporarily or expose them under an explicit `native`/`unsafe` namespace while the higher-level API becomes the default.

## Native ownership and packaging

-   [ ] Bring the native overlay submodules/prebuilt runtime into a package owned by this repo.
    -   Current issue: important runtime behavior lives in native binaries copied from `libs/native-game-overlay/prebuilt`, including behavior we need to change such as the default background/clear color shown when input interception is active and no overlay windows are visible. As long as that code is only consumed as prebuilt runtime files, the JS/SDK packages cannot fully control or fix those behaviors.
    -   Desired direction: package the native runtime sources and build outputs as part of this Nx workspace, with explicit ownership over `n_overlay.dll`, `n_overlay.x64.dll`, `injector_helper.exe`, and `injector_helper.x64.exe`.
    -   Possible package shape:
        -   keep `native-game-overlay` as the native runtime package,
        -   build or stage both x86/x64 runtime artifacts through Nx targets,
        -   make `node-game-overlay` depend on those targets instead of manually copying opaque binaries,
        -   expose versioned native runtime assets as package outputs.
    -   Why this matters: it lets us add native/runtime options, such as configurable transparent/default background color, hook diagnostics, graphics API support, presentation-mode fixes, and compatibility patches without waiting on external submodule/prebuilt updates.
    -   Migration note: preserve the current prebuilt copy flow until source builds are reliable, then replace the prebuilt artifacts with workspace-built outputs.

## Diagnostics and logging

-   [ ] Improve error logging and diagnostics across every overlay layer.
    -   Current issue: failures can happen in multiple places: Electron SDK code, `node-game-overlay`, native addon loading, injector helper launch, DLL injection, IPC connection, graphics API hook setup, frame upload, input forwarding, and per-game rendering. Today those failures are hard to distinguish, which makes agent-driven debugging and user support slow.
    -   Desired direction: make every layer report structured diagnostics with enough context to identify where the failure occurred and what the next action should be.
    -   Suggested logging layers:
        -   `electron-game-overlay`: typed events such as `session.on("diagnostic", ...)`, attach results, window registration state, frame send failures, focus/input forwarding failures.
        -   `node-game-overlay`: native addon load path, runtime asset paths, missing DLL/helper files, inject result details, process/window selection details, IPC client connect/disconnect events.
        -   injector helper: helper startup, target window/process, target bitness, DLL path, injection method, Windows error codes from failed API calls.
        -   injected DLL/runtime: graphics backend detected, hook targets attempted, hook success/failure, swap chain/window creation, present path used, frame composition errors, input intercept state.
    -   DLL logging options: write to `OutputDebugString` for DebugView/Visual Studio, write rotating log files under a configurable temp/app-data directory, or send diagnostic IPC messages back to the host when the IPC link is available. Before IPC is connected, the DLL should still log locally so early injection/hook failures are not lost.
    -   Possible API shape: `new GameOverlay({ logger, logLevel, diagnostics: true })`, `session.on("diagnostic", event => ...)`, and a stable diagnostic event schema with `layer`, `code`, `severity`, `message`, `context`, and optional `windowsErrorCode`.
    -   Agent workflow goal: when a user reports "nothing appears", logs should show whether the failure is asset copy, injection launch, DLL load, IPC connect, graphics hook, window registration, frame upload, or game compatibility.
