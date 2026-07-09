# Todo

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
