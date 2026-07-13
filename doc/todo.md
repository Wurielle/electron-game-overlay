# Todo

## ReShade host migration

Further expansion of project-owned hudhook input detours is frozen. A ReShade
Gun Frog run proved that Electron could receive a blocked legacy click while
Unity 6 still consumed the same physical action through Windows' second
`WM_POINTER` mouse projection. The repository oracle reproduced that exact
split, and the pinned ReShade runtime now suppresses `PT_MOUSE` client
`WM_POINTER` input while updating native ImGui state. The add-on translates its
primary-pointer stream once for Electron after global queue ordering. D3D11 and
D3D12 controlled acceptance now freeze legacy, raw, polling, cursor, and pointer
counters together. The July 12 Gun Frog rerun passed the same boundary, and the
July 13 exact four-button menu proof confirmed it across Continue, New Game,
Settings, and Quit plus the inverse released Quit action. The SDK/client host
migration then passed the same Gun Frog gate through the built production client
and SDK ReShade launcher on July 13. The same production path subsequently
passed two isolated controlled D3D12 cycles with both Electron windows,
interception/release, caption dragging, normal target exit, cleanup, and fresh
relaunch. The restart lifecycle subsequently passed with one Electron client
and overlay session across two new target PIDs, using the real frontend Inject
action and distinct isolated ReShade runs.

### POC finish line

- [x] Pass the visible ReShade-owned input gate on the controlled D3D11 host.
  - Prove overlay mouse/keyboard interaction, zero game-side message/raw/polling reactions while active, cursor confinement release, pass-through restoration, and clean shutdown.
- [x] Pass the same visible gate on the controlled D3D12 host.
  - Both controlled gates passed on July 12, 2026, including button, text, drag, wheel, active-intercept resize, post-resize click, and release restoration. ReShade's managed ImGui state is sampled once per `Present`; exact fast-edge delivery remains the project-owned Electron queue's responsibility.
- [x] Pass the gate against Gun Frog before migrating the SDK/client runtime.
  - The first ReShade run rendered and operated both Electron windows, but a click on Electron also activated Unity's underlying `Continue` control. The controlled pointer oracle identified and closed the `WM_POINTER` gap.
  - The July 12 rerun clicked the Electron BACK button directly over `Continue`; Electron logged the complete down/drag/up/click sequence and the game stayed on its menu. Both windows accepted focus/text, raising either window and caption dragging worked. Clicking the manual `Release input` control produced the disable acknowledgement, after which the same game control immediately entered gameplay. Normal close succeeded, and no game-directory log, input-order fault, or router reset appeared.
  - The July 13 strengthened acceptance aligned four Electron buttons exactly over Continue, New Game, Settings, and Quit. Each emitted a unique `HUDHOOK_CLIENT_MULTIWINDOW_INPUT ... event=gun-frog-click name=<...>` marker while Gun Frog remained on the menu and alive. Manual release emitted `RELEASE_REQUESTED`, `INTERCEPT_DISABLED`, and `LIFECYCLE_COMPLETE`; clicking the same underlying Quit position afterward closed Gun Frog.
- [x] Extract the backend-neutral Rust transport/compositor core from the hudhook renderer.
  - `poc/electron-overlay-core` now owns `electron_wire.rs`, `electron_frame.rs`, `electron_input.rs`, the authenticated Node loopback transport, ordered scene/router semantics, and premultiplied-BGRA conversion. It builds as both an `rlib` and a Windows static library; the retained hudhook POC consumes the same crate instead of duplicate modules.
- [x] Finish the narrow, versioned C ABI and ReShade-linked smoke target for that core.
  - Immutable scene/name/RGBA pointers are leased by explicit snapshots, every fallible Rust export contains panics and returns fixed status codes, and the native layout/link/lifecycle smoke passes. The proven native-only D3D11/D3D12 gate targets remain independent of Cargo.
- [x] Port multi-window ReShade texture composition and exact legacy Electron input return on D3D11.
  - Preserve registration order, click-to-front, alpha hit testing, caption drag, pointer capture, focus-before-input, per-packet scale tags, and desired/active raster transitions.
  - D3D11 connects the real authenticated Electron producer, uploads both overlapping OSR windows, renders the ordered scene, and acknowledges ReShade-owned interception.
  - The pinned API-19 full-add-on observer copies input only after ReShade decides to block it. A bounded lock-free queue delivers exact legacy Win32 records to the shared Electron router. When Windows mouse-in-pointer is active, the add-on captures pointer ID/type/target/modifiers at the callback, sorts the global observer sequence, and only then converts the blocked primary mouse stream into that same single legacy route. Controlled click-to-front, text focus/input, and caption dragging passed while every game-side legacy/raw/polling/pointer oracle counter stayed frozen.
  - Copied `WM_INPUT` and `GetRawInputBuffer` records are retained and counted; normalizing those raw records is deferred below rather than blocking the POC.
- [x] Pass the same real Electron scene and exact legacy-input acceptance on D3D12.
  - D3D12 rendered both ordered Electron windows and passed exact click/focus/text and caption-drag routing while every host oracle counter remained frozen.
- [x] Replace the active client's hudhook launcher/runtime selection with the ReShade host boundary and pass the real client/SDK Gun Frog input gate.
  - The production client now arms by executable process name before launch, lets ReShade select the graphics API, and keeps the public session/window/input surface plus Electron-owned Ctrl+I toggle stable.
  - `gun-frog-client-sdk.ps1` passed against PID 11104: all four aligned Electron controls stayed inside the overlay, Ctrl+I produced the negative acknowledgement, the identical released Quit position closed the game, and the runner persisted `GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS` in the client-run `result.txt`.
- [x] Pass the controlled production-client lifecycle, multi-window, and D3D12 gate twice with a fresh relaunch.
  - `d3d12-client-sdk.ps1` passed against PIDs 17248 and 13528 with distinct isolated ReShade runs. Both Electron windows accepted input, the foreground target oracle froze during interception, caption drag was verified behaviorally, release restored legacy/raw/primary-pointer input and confinement, released Escape closed each host, and no test process remained. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630` contains `D3D12_REAL_CLIENT_SDK_GATE_PASS`.
- [x] Re-arm the SDK and frontend after an exact target disconnect without restarting Electron.
  - `d3d12-client-sdk-reinjection.ps1` kept Electron PID 17756 alive across target PIDs 19764 and 17940. The SDK pinned each injector-selected PID, rejected forged lifecycle events, kept its injection latch across transient transport loss, returned to `idle` only after the OS confirmed the selected target had exited, staged distinct runs, and passed the second D3D12 scene/input/interception cycle. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105` contains `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`.
- [x] Pass exact-PID near-process-creation injection through the production client and public SDK on controlled D3D11 and D3D12.
  - The SDK accepts optional `{ processName, pid }` targets and the Electron demo exposes the optional PID. The intended watcher calls immediately after the process exists and before graphics-device/swap-chain creation.
  - `d3d11-client-sdk-process-start-injection.ps1` passed against PID 7428 with a 72.393 ms process-create-to-frontend-click interval. Exact injector arguments and pre-`ResumeThread` ReShade loading were proven; transport, D3D11, two windows, and input passed after resume. The target exited 0, the frontend returned to `idle`, and no test process remained. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623` contains `D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`.
  - `d3d12-client-sdk-process-start-injection.ps1` passed the same boundary against PID 21508 with an 84.061 ms interval. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642` contains `D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; D3D12, two windows, input, exit 0, frontend `idle`, and no-leftover checks passed.

### Post-POC compatibility and hardening

- [ ] Add supported-runtime installation, existing ReShade/proxy conflict detection, typed diagnostics, and clean disable/unload behavior.
- [ ] Investigate the non-fatal ReShade `ID3D11Device3` reference-count warning emitted during the accepted Gun Frog shutdown as part of resource retirement/unload hardening.
- [ ] Harden exact target identity beyond PID plus verified executable basename, including process creation time or an equivalent nonce, so a stale watcher event cannot attach after PID reuse.
- [ ] Measure permitted unsuspended watcher latency per supported target. The current contract requires injection immediately after process creation and before graphics-device/swap-chain creation; the deterministic suspended gates do not establish an arbitrary latency budget.
- [ ] Treat post-render attachment as unsupported unless existing-device/swap-chain adoption is implemented and proven. A controlled probe at plus three seconds loaded `ReShade64.dll` into already-rendering D3D11/D3D12 targets but produced no runtime, add-on, API-hook, or Electron-scene initialization.
- [ ] Defer package publishing and installer work until repository-local SDK/client testing closes the remaining acceptance and hardening items.
- [ ] Expand real-client compatibility through additional permitted games; do not infer other-game support from the accepted Gun Frog path or controlled hosts.
- [ ] Add target-HWND display/client-origin ownership, real mixed-monitor acceptance, safe texture retirement, and multiple-target routing.
- [ ] Normalize copied `WM_INPUT` and `GetRawInputBuffer` mouse/keyboard records into the Electron router, including buffered-record target ownership and raw-only text policy.
- [ ] Extend the accepted `WM_POINTER` translation beyond primary mouse move/left click to secondary/X buttons, double-click semantics, pointer wheel, and explicit touch/pen policy, with duplicate-projection tests.
- [ ] Harden observer ordering/recovery and per-swap-chain resource/input ownership for concurrent input pumps or multiple swap chains.
- [ ] Expand the compatibility matrix only from observed evidence: Vulkan/OpenGL, exclusive/fullscreen variants, gamepads, DirectInput/XInput/GameInput, and other backend-specific paths.
- [ ] Keep competitive and anti-cheat-protected targets, anti-cheat bypasses, and VR outside the unsigned full-add-on POC.

## Retained hudhook follow-ups (historical/deferred)

These items document the completed hudhook experiment and possible upstream work;
they are not the active production-host roadmap.

- [x] Replace hudhook 0.9.1's deferred `WM_INPUT` handle use with a synchronous owned-input seam.
  - The local path patch copies raw mouse/keyboard packets while the receiving WndProc is active, performs foreground `DefWindowProcW` cleanup, and exposes a thread-safe synchronous observer.
  - The project observer owns intercepted mouse/raw propagation and fans one normalized pointer queue to ImGui and Electron. Upstream this narrow patch or replace it with a pinned revision after contribution.
- [ ] Move legacy/raw keyboard and text onto the same owned event queue as pointer input.
  - Pointer delivery is synchronous, while hudhook currently drains copied keyboard messages before `before_render`; a click and following key within one presentation interval can therefore be reordered.
  - Raw-keyboard-only text requires explicit Unicode generation; keep the existing legacy key/character path until that is implemented and tested.
- [x] Add a guarded custom-input-hook teardown phase and bounded process mouse adapter.
  - Ejection now runs outside an active detour, disables every MinHook entry point, drains guarded callbacks, performs fallible WndProc/backend cleanup, and only then calls `MH_Uninitialize()`. Cleanup failure keeps the module pinned.
  - The payload masks mouse buttons from `GetAsyncKeyState`, `GetKeyState`, and `GetKeyboardState`, returns a game-only off-client `GetCursorPos`, and neutralizes `GetRawInputBuffer` mouse records after copying them into the owned overlay queue. The pipeline binds its target HWND and seeds the real client cursor before buffered-only input can arrive. High-bit physical state repairs missing held-button edges; the racy low-bit press hint is ignored so it cannot duplicate a buffered click pair.
  - The raw-buffer behavior follows ReShade's maintained BSD-licensed Win32 implementation. Per-API call/masked counters are reported from the render thread; if Gun Frog still reacts while `raw_buffer_calls` remains zero, stop expanding this adapter and move the backend to ReShade instead of guessing more APIs.
- [ ] Harden runtime ejection and same-process hook retry before exposing either as a supported SDK feature.
  - The current client never calls hudhook's `eject()`; closing the target process is the supported POC teardown.
  - A thread redirected into a detour but suspended before the Rust guard can outlive the current drain barrier. Keep runtime unload out of the public SDK until entry accounting is established at the detour boundary or the DLL is deliberately pinned after deactivation.
  - Make partial DX9/DX11/DX12 hook construction transactional, replace the process-input `OnceLock` bundle with resettable lifecycle state, and make non-owner MinHook removal retry-safe.
- [ ] Prove or reject the bounded polling adapter against Gun Frog and a second real title.
  - Keep DirectInput, other Unity Input System device APIs, XInput, and GameInput as distinct compatibility adapters; do not mark them covered by the User32/raw-buffer proof.
  - If either title requires one of those broader paths, record the counter evidence and evaluate a ReShade add-on host rather than growing an open-ended local hook matrix.
- [x] Remove manual graphics-backend selection from the active client path.
  - The selected ReShade host identifies the target graphics API; applications arm one process name and no longer choose a D3D11 or D3D12 payload. The former hudhook auto-detection task is retained only as historical context and will not be implemented in the inactive path.

## API modernization

- [ ] Modernize `node-game-overlay` to expose a higher-level API that matches the `electron-game-overlay` SDK shape.
  - Current issue: `libs/node-game-overlay` exposes the native addon as a flat, low-level function surface through `index.d.ts`: `start()`, `stop()`, `sendCommand(...)`, `addWindow(...)`, `closeWindow(...)`, `sendFrameBuffer(...)`, and `setEventCallback(...)`. This mirrors the native transport but is awkward for application code and easy to misuse.
  - Desired direction: create a typed JS/TS wrapper around the native addon with concepts similar to `ElectronGameOverlay`, `OverlaySession`, `input.intercept()`, `input.release()`, `attachToProcess(...)`, and window handles with `show()`, `hide()`, `destroy()`, `setBounds(...)`, and `sendFrame(...)`.
  - Possible API sketch:
    - `const overlay = new GameOverlay()`
    - `const session = overlay.createSession()`
    - `session.attachToProcess({ title })` and later `session.attachToProcess({ pid })`
    - `session.input.intercept()` / `session.input.release()`
    - `const window = session.windows.add({ id, name, nativeHandle, bounds, ... })`
    - `window.show()` / `window.hide()` / `window.destroy()` / `window.setBounds(...)`
    - `window.sendFrame(buffer, width, height)`
    - `session.on("graphicsWindow", handler)`, `session.on("fps", handler)`, `session.on("input", handler)`, etc.
  - Keep low-level native calls available internally, but avoid requiring app code to manually build command payloads like `{ command: "input.intercept", intercept }`.
  - Align naming and event types with `libs/electron-game-overlay/src/lib/overlay-session.ts` where practical, so the Electron SDK can become a thin adapter over the node SDK instead of owning generic overlay/session behavior itself.
  - Migration note: keep backwards-compatible exports temporarily or expose them under an explicit `native`/`unsafe` namespace while the higher-level API becomes the default.

## Native ownership and packaging

- [ ] Bring the native overlay submodules/prebuilt runtime into a package owned by this repo.
  - Current issue: important runtime behavior lives in native binaries copied from `libs/native-game-overlay/prebuilt`, including behavior we need to change such as the default background/clear color shown when input interception is active and no overlay windows are visible. As long as that code is only consumed as prebuilt runtime files, the JS/SDK packages cannot fully control or fix those behaviors.
  - Desired direction: package the native runtime sources and build outputs as part of this Nx workspace, with explicit ownership over `n_overlay.dll`, `n_overlay.x64.dll`, `injector_helper.exe`, and `injector_helper.x64.exe`.
  - Possible package shape:
    - keep `native-game-overlay` as the native runtime package,
    - build or stage both x86/x64 runtime artifacts through Nx targets,
    - make `node-game-overlay` depend on those targets instead of manually copying opaque binaries,
    - expose versioned native runtime assets as package outputs.
  - Why this matters: it lets us add native/runtime options, such as configurable transparent/default background color, hook diagnostics, graphics API support, presentation-mode fixes, and compatibility patches without waiting on external submodule/prebuilt updates.
  - Migration note: preserve the current prebuilt copy flow until source builds are reliable, then replace the prebuilt artifacts with workspace-built outputs.

## Diagnostics and logging

- [ ] Improve error logging and diagnostics across every overlay layer.
  - Current issue: failures can happen in multiple places: Electron SDK code, `node-game-overlay`, native addon loading, injector helper launch, DLL injection, IPC connection, graphics API hook setup, frame upload, input forwarding, and per-game rendering. Today those failures are hard to distinguish, which makes agent-driven debugging and user support slow.
  - Desired direction: make every layer report structured diagnostics with enough context to identify where the failure occurred and what the next action should be.
  - Suggested logging layers:
    - `electron-game-overlay`: typed events such as `session.on("diagnostic", ...)`, attach results, window registration state, frame send failures, focus/input forwarding failures.
    - `node-game-overlay`: native addon load path, runtime asset paths, missing DLL/helper files, inject result details, process/window selection details, IPC client connect/disconnect events.
    - injector helper: helper startup, target window/process, target bitness, DLL path, injection method, Windows error codes from failed API calls.
    - injected DLL/runtime: graphics backend detected, hook targets attempted, hook success/failure, swap chain/window creation, present path used, frame composition errors, input intercept state.
  - DLL logging options: write to `OutputDebugString` for DebugView/Visual Studio, write rotating log files under a configurable temp/app-data directory, or send diagnostic IPC messages back to the host when the IPC link is available. Before IPC is connected, the DLL should still log locally so early injection/hook failures are not lost.
  - Possible API shape: `new GameOverlay({ logger, logLevel, diagnostics: true })`, `session.on("diagnostic", event => ...)`, and a stable diagnostic event schema with `layer`, `code`, `severity`, `message`, `context`, and optional `windowsErrorCode`.
  - Agent workflow goal: when a user reports "nothing appears", logs should show whether the failure is asset copy, injection launch, DLL load, IPC connect, graphics hook, window registration, frame upload, or game compatibility.
