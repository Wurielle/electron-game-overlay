# Alternative solution: ImGui native compositor

> Historical design exploration with a current outcome summary. References to
> the Node add-on, named shared mappings, or its Win32 IPC host describe the
> superseded prototype baseline. The finished focused POC uses an authenticated
> Node/Rust loopback transport with direct BGRA frame packets.

> **Current host decision, July 13, 2026:** ReShade 6.7.3 full add-on support is
> the selected production-host experiment for process entry, graphics hooks,
> swap-chain/resource lifecycle, the managed Dear ImGui context, logging, native
> input collection, and game-side input blocking. The controlled D3D11/D3D12
> input gates and real Electron scenes passed visible acceptance. A first Gun
> Frog run exposed Unity 6's additional `WM_POINTER` mouse projection; the same
> split was reproduced and closed for `PT_MOUSE` by a pinned pointer patch on
> both controlled backends. Native ImGui and the ordered Electron route passed
> the regression, followed by a passing Gun Frog rerun. A strengthened proof
> then aligned Electron controls over Continue, New Game, Settings, and Quit;
> all four stayed in Electron while the game remained on its menu, and the same
> Quit position closed the game only after release. The production client and
> public SDK now pass that exact Gun Frog boundary through the ReShade launcher
> on the process-name, arm-before-launch path. The same production path also
> passed two fresh controlled D3D12 multi-window/lifecycle cycles. Late
> injection, arbitrary fast-start targets, and other games remain unverified.
> The hudhook implementation remains the verified Electron compositor and routing
> reference, not the selected injected host.

## Idea

Use Dear ImGui inside the injected native overlay runtime as the compositor for overlay content.

The Electron side would still render offscreen windows into bitmap frames. The native runtime would receive those frames, upload them to graphics textures, and use ImGui to draw those textures into the game's render frame.

This would make ImGui responsible for the native in-game overlay composition layer, not for the application UI itself.

## Prototype status

The first proof of concept is implemented in [`poc/reshade-imgui-overlay`](../poc/reshade-imgui-overlay/README.md).

The follow-up experiment in [`hudhook-imgui-overlay-poc.md`](hudhook-imgui-overlay-poc.md) proves the same native path with released hudhook 0.9.1 and no ReShade runtime. It composes an ordered scene of overlapping Electron windows from controlled producers and the real built client through the repository's Electron SDK and project-owned authenticated loopback transport. The D3D11/D3D12 payloads render transparent content at native bounds, survive per-window move/close/re-register lifecycle changes, alpha-hit-test from front to back, and forward controlled Win32 input to the hit or focused Electron window. That controlled slice initially needed no hudhook fork; the later real-game input investigation and local patch are recorded in the input handoff.

The completed baseline uses the ReShade 6.7.3 full add-on runtime as the alternative native hook/runtime layer. ReShade, rather than ImGui, owns process entry, graphics API hooks, swap-chain lifecycle, input infrastructure, logging, and renderer integration. The add-on uses ReShade's managed Dear ImGui context to draw an always-visible diagnostics panel and a generated RGBA texture uploaded through ReShade's graphics-agnostic resource API.

This choice keeps the first experiment focused on the compositor seam instead of implementing another custom `Present` hook. A controlled D3D11 test host is included so the proof can be exercised without injecting into third-party software. ReShade's full add-on build is not anti-cheat allowlisted, so this experiment is limited to the test host and offline/single-player applications the operator is explicitly allowed to modify.

What this milestone proves:

- an independent, maintained hook/runtime can enter the target render path;
- Dear ImGui can render while the ReShade configuration overlay is closed;
- a CPU-generated RGBA frame can become a GPU resource and be drawn with `ImGui::Image`;
- the runtime survives D3D11 swap-chain resize handling owned by ReShade;
- native initialization and texture failures are visible in `ReShade.log`.
- controlled D3D11 and D3D12 interception keeps native ImGui interactive while an independent game-side message/raw/polling oracle remains frozen;
- both controlled backends preserve blocking and ImGui interaction through resize, then restore cursor confinement and game-side input on release.

The July 12 acceptance exercised ImGui button, text, drag, and wheel controls on
both backends, including the later mouse-in-pointer regression. The subsequent
D3D11/D3D12 Electron add-on reuses the extracted transport/scene/router core and
a local passive ReShade API-19 observer. Blocked legacy Win32 and `PT_MOUSE`
pointer records are copied into a bounded queue and routed exactly after global
sequence ordering rather than sampled at `Present`; two overlapping OSR windows
passed click-to-front, text focus/input, and caption dragging while the game
oracle remained frozen.
Copied raw records, target-display/client-origin ownership, mixed-monitor
acceptance, multiple-swapchain ownership, and safe GPU texture retirement
remain open.

## Original model (historical)

The current overlay pipeline is roughly:

1. Electron creates offscreen `BrowserWindow` instances.
2. Electron captures frame buffers from those windows.
3. The Electron SDK sends frame buffers, window bounds, visibility, and input state through `node-game-overlay`.
4. The injected native runtime receives those messages.
5. The native runtime draws those overlay frames into the target game's render output.
6. Native input events are forwarded back to Electron.

The hard parts are native rendering, graphics API compatibility, input routing, diagnostics, and keeping the frame protocol stable.

## Proposed model

The proposed ImGui compositor pipeline would be:

1. Electron still owns the actual overlay UI.
2. Electron still renders offscreen windows into bitmap frames.
3. The node/native bridge still sends frame buffers and window state to the injected runtime.
4. The injected runtime uploads each Electron frame into a graphics texture.
5. Dear ImGui draws each texture as an image inside an ImGui-managed overlay layer.
6. Native input is mapped to overlay-window coordinates and forwarded back to Electron.

Example native rendering shape:

```cpp
ImGui::SetNextWindowPos(ImVec2(window.x, window.y));
ImGui::SetNextWindowSize(ImVec2(window.width, window.height));

ImGuiWindowFlags flags =
    ImGuiWindowFlags_NoDecoration |
    ImGuiWindowFlags_NoMove |
    ImGuiWindowFlags_NoResize |
    ImGuiWindowFlags_NoSavedSettings |
    ImGuiWindowFlags_NoBackground;

ImGui::Begin(window.id.c_str(), nullptr, flags);
ImGui::Image(window.textureId, ImVec2(window.width, window.height));
ImGui::End();
```

The actual texture type behind `ImTextureID` depends on the active graphics backend.

## What ImGui would replace

ImGui could replace or simplify the native overlay compositor:

- z-order and per-window draw ordering,
- clipping,
- debug overlay rendering,
- simple diagnostics UI,
- native cursor/input debug visualization,
- texture placement in the game frame.

It would not replace:

- Electron offscreen rendering,
- the Electron SDK,
- frame buffer transport,
- native injection,
- graphics API hooks,
- input forwarding to Electron,
- per-game compatibility work.

## Communication requirements

The protocol between host and injected runtime would still need messages for:

- session attach/detach,
- input intercept on/off,
- window add/remove,
- window show/hide,
- window bounds,
- window z-order,
- frame buffer upload,
- frame format,
- cursor position,
- mouse button events,
- wheel events,
- keyboard events,
- focus/blur events,
- diagnostics.

The native runtime should treat Electron frames as textures owned by overlay windows.

Possible window state shape:

```ts
type NativeOverlayWindowState = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  zIndex: number;
  interactive: boolean;
  frameFormat: 'bgra' | 'rgba';
};
```

Possible frame message shape:

```ts
type NativeOverlayFrame = {
  windowId: string;
  width: number;
  height: number;
  stride: number;
  format: 'bgra' | 'rgba';
  buffer: ArrayBuffer;
};
```

## Input model

For Electron-backed windows, ImGui should mostly act as a hit-test and composition layer.

Input flow:

1. Native runtime receives raw game/window input.
2. Runtime determines whether input interception is enabled.
3. Runtime hit-tests visible overlay windows by z-order.
4. Runtime maps screen coordinates into the target overlay window.
5. Runtime forwards translated input to Electron.
6. Electron page handles the input normally.
7. Electron emits a new frame if UI changed.

ImGui can also consume input for native-only debug panels. For Electron windows, input should usually be forwarded, not handled by ImGui widgets.

Important distinction:

- Native debug UI: real ImGui widgets.
- Electron overlay windows: ImGui-drawn images with manual input forwarding.

## Graphics backend implications

An independently owned runtime needs a texture upload path for each supported graphics backend:

- D3D11: upload bitmap into `ID3D11Texture2D`, bind as shader resource view, pass SRV as ImGui texture ID.
- D3D12: upload through an upload heap into a texture resource, manage SRV descriptors, pass GPU descriptor handle as ImGui texture ID.
- Vulkan: upload into `VkImage`, create image view and sampler, register descriptor set for ImGui texture ID.
- OpenGL: upload into `GLuint` texture, pass texture handle as ImGui texture ID.

ImGui gives us renderer backends, but it does not remove the need to integrate correctly with each hooked graphics API.

The ReShade POC delegates those backend-specific resource and descriptor details to ReShade's add-on API. That is useful for validating the compositor model quickly, but it also means the first POC depends on the ReShade runtime rather than owning the complete native stack.

## Why this may be worth trying

- Dear ImGui already has mature renderer backends for D3D11, D3D12, Vulkan, and OpenGL.
- It is widely used for injected in-game tools and debug overlays.
- It gives us a known native UI layer for diagnostics.
- It may simplify multi-window composition.
- It gives us a practical way to inspect the native runtime from inside the game.
- It may make the native layer easier to reason about than a fully custom compositor.

## Native injection guidance

Dear ImGui is not the injection system. It only renders UI once our code is already running inside the target process and has access to the game's render path.

The native overlay runtime still needs a process-entry strategy, graphics hook strategy, input strategy, IPC strategy, and diagnostics strategy.

### Process entry options

- Proxy / wrapper DLL:
  - Place a DLL next to the game executable with a name the game naturally loads, such as `dinput8.dll`, `dxgi.dll`, `d3d11.dll`, or another known dependency.
  - The proxy DLL loads the real system DLL and forwards exports while also initializing the overlay runtime.
  - This gets the overlay loaded early, often before graphics device and swap-chain creation.
  - This is the style used by many modding and overlay projects, including REFramework's common non-VR install flow with `dinput8.dll`.
- Late runtime injection:
  - Inject a DLL into an already-running process by PID or selected window.
  - This is more flexible for third-party apps, but can miss early graphics initialization and may need to recover by discovering already-created devices/swap chains.
  - This is closer to the current attach-to-process model.
- Global hook / launcher integration:
  - Use a launcher or global Windows hook to inject into matching processes.
  - This can feel more automatic, but it is more invasive and has higher security/compatibility risk.
- Backend-specific loader:
  - Use graphics/runtime-specific extension points where available, such as Vulkan layers or OpenXR layers.
  - This can be cleaner for specific ecosystems, but does not cover every graphics API with one implementation.

The completed ReShade POC uses a scoped proxy runtime for early process entry. The next hudhook POC deliberately uses late injection so it does not claim a local proxy filename that may already belong to a user's ReShade installation. Keep the launcher/injector path as the preferred product direction unless testing demonstrates a target that requires earlier process entry.

### Graphics hook targets

Start with one graphics backend instead of trying to support every game immediately.

- D3D11:
  - Hook `IDXGISwapChain::Present`.
  - Hook `IDXGISwapChain::ResizeBuffers`.
  - Initialize ImGui with the D3D11 and Win32 backends.
  - This is the recommended first backend because texture upload and ImGui integration are comparatively simple.
- D3D12:
  - Hook swap-chain present.
  - Track command queue / command list / descriptor heap state.
  - Initialize ImGui with the D3D12 backend.
  - Harder than D3D11 because resource barriers, descriptor heaps, frame resources, and synchronization matter more.
- Vulkan:
  - Prefer a Vulkan layer if possible.
  - Otherwise hook instance/device/swap-chain creation and `vkQueuePresentKHR`.
  - Requires explicit image layout, command buffer, descriptor, and synchronization management.
- OpenGL:
  - Hook `wglSwapBuffers` on Windows.
  - Upload Electron frames as GL textures and pass texture IDs to ImGui.

### Input interception

The overlay needs two different input modes:

- Game mode:
  - Input goes to the game.
  - Overlay may render passive windows.
- Intercept mode:
  - Overlay captures mouse/keyboard/gamepad input.
  - Input is hit-tested against overlay windows.
  - Electron-backed windows receive translated input events.
  - The game should not receive consumed input.

Implementation options to research and test:

- Win32 window procedure hooks,
- raw input,
- low-level keyboard/mouse hooks,
- DirectInput/XInput/GameInput hooks,
- ImGui Win32 backend input handling for native debug panels.

Electron windows should not rely on ImGui widgets for input. For Electron-backed windows, ImGui should mostly provide hit testing and visual placement, then the runtime should forward translated input to Electron.

### Example projects to study

- OptiScaler:
  - Native runtime with ImGui overlay code for DirectX and Vulkan paths.
  - Useful reference for integrating an ImGui menu into an existing native render/runtime pipeline.
- ReShade:
  - Generic native post-processing injector/runtime.
  - Useful reference for broad graphics API hooking, runtime GUI, input handling, and effect/runtime lifecycle.
- Special K:
  - Native injection and graphics/runtime modification framework.
  - Useful reference for proxy DLL loading, global injection, late injection, compatibility handling, and diagnostics.
- REFramework:
  - Native modding framework for RE Engine games, commonly loaded through a local proxy DLL.
  - Useful reference for why scoped, early-loaded native overlays can feel reliable.
- hudhook:
  - Dear ImGui overlay framework.
  - Useful reference for backend-specific ImGui overlay implementation, especially D3D11/D3D12/OpenGL.
- HydraHook:
  - DirectX API hooking/rendering framework with ImGui examples.
  - Useful reference for DirectX hook structure and sample overlays.

### Recommended prototype path

1. Build a ReShade x64 add-on and a controlled D3D11 test host.
2. Install the official ReShade full add-on runtime beside that host.
3. Let ReShade own process entry, `Present`/resize hooks, and the ImGui frame lifecycle.
4. Draw a hardcoded, always-visible native diagnostics panel.
5. Upload a generated RGBA bitmap through ReShade's resource API.
6. Render that bitmap using `ImGui::Image` and verify resize behavior and logging.
7. Repeat the proof with an upstream hudhook D3D11 payload and late injector, without ReShade.
8. Initially reuse the existing Node add-on IPC/shared mapping to render one transparent Electron window from a controlled producer and the real built client, then replace it at the focused finish line.
9. Decide whether upstream hudhook is sufficient or a narrow fork is justified.
10. Make the selected Electron window interactive through the existing input/intercept protocol.
11. Generalize to multiple-window/z-order state with per-window routing and texture state.
12. Prove the DIP-to-physical contract at uniformly forced Electron scales, add matching-paint per-window runtime transitions, then define target-display/client-origin ownership and run real mixed-monitor acceptance.
13. Repeat the graphics, Electron input, and multi-window proof with hudhook's D3D12 backend and a controlled D3D12 host; defer resize-safe texture retirement to post-POC hardening.

Steps 1 through 11 and the bounded producer-window portion of step 12 are complete for controlled D3D11, including transparent physical-bounds composition, ordered multi-window lifecycle, click-to-front routing, focused keyboard input, caption dragging, per-window pointer capture, content-surface rather than outer-window bounds, desired/active display state, and matching-paint scale commits. Accepted bitmaps are authoritative within a one-pixel floor-scaling tolerance; ambiguous transitions wait for renderer DPR/viewport acknowledgement and use a cropped `capturePage()` as the causal commit frame. Per-packet scale tags protect queued input while retaining an active-scale fallback. The window/session/input API remains intact; `window.bounds` gained compatible optional full-geometry and `rasterChanged` fields so the compositor can suppress stale pixels until the matching frame. The final transport uses checked length-delimited BGRA packets and reconnect snapshots. Legacy generic process discovery/injection methods now fail explicitly because the application owns hudhook payload launch and backend selection.

## Risks and limitations

- ImGui does not solve injection compatibility by itself.
- ImGui does not make Electron input automatic.
- the SDK can stage per-producer-window runtime scale changes and the controlled target is PMv2-aware, but the current machine exposes one 100% virtual display; forced 1/1.25/1.5/2 runs therefore do not prove target-HWND/client-origin ownership, backing-window placement, multi-target geometry, real physical/VM mixed-monitor behavior, or Electron 42 OSR;
- Every graphics API still needs explicit texture upload and resource lifetime handling.
- hudhook 0.9.1 exposes texture load/replace but no removal operation, so resize-safe retirement of superseded texture IDs remains open;
- scene/router publication is atomic on the CPU, but new alpha data can precede its GPU texture upload by one `Present`;
- click-to-front order is payload-local: reconnect restores registration order because the existing protocol has no persistent z-order field;
- D3D12/Vulkan descriptor/resource management can become complex.
- Large Electron windows updated every frame may be expensive if uploads are naive.
- Some games may still fail due to anti-cheat, privilege, swap-chain, fullscreen, or hook timing issues.
- ImGui is immediate-mode; Electron windows should be represented as stable native overlay state, then drawn each frame.

## Current result and next experiment

The native proof-of-life, generic Electron transport, selected-window input, and
multi-window compositor milestones are complete:

- the repository-built, pinned ReShade full-add-on runtime enters the controlled D3D11 host; stock API-18 binaries are not compatible with the local API-19 observer add-ons;
- ReShade invokes the baseline add-on through its pinned headers; the local passive input-observer extension advances the full-add-on ABI to API version 19 and owns resize/unload handling;
- the add-on draws an always-visible ImGui diagnostics panel;
- a generated RGBA bitmap is uploaded as a GPU resource and drawn with `ImGui::Image`;
- `ReShade.log` distinguishes add-on loading, texture creation, first-frame rendering, resize, and clean unload.
- ReShade's controlled D3D11 and D3D12 input gates passed button, text, drag, wheel, active-intercept resize, post-resize click, release, and independent game-side suppression checks on July 12, 2026;
- the D3D11 and D3D12 ReShade Electron add-on renders two ordered live OSR windows and routes exact legacy click, focus, text, and caption-drag input through the shared core while ReShade remains the sole suppression authority;
- a mouse-in-pointer oracle reproduced Gun Frog's second-input-path failure; the pinned runtime now blocks `PT_MOUSE` client `WM_POINTER`, updates native ImGui state, and translates primary move/left-click once on Electron's ordered consumer, with every legacy/raw/polling/pointer counter frozen on both backends;
- the Gun Frog rerun clicked an Electron control directly above Unity's `Continue` button without activating the game, then passed text, front/back raising, and caption dragging; the strengthened four-button run delivered unique Continue/New Game/Settings/Quit markers only to Electron while the game stayed alive on its menu, then emitted the full release lifecycle and let the same underlying Quit position close the game;
- the built production client and public SDK ReShade launcher passed the same exact Gun Frog gate on PID 11104: positive interception acknowledgement, one click on each aligned Electron control while the menu stayed alive, Ctrl+I negative acknowledgement, and the identical Quit position closing the game; the dedicated runner emitted `GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`;
- the production client/public SDK also passed two isolated controlled D3D12 cycles on PIDs 17248 and 13528: both Electron windows accepted input, caption drag remained interactive at the moved coordinates, the foreground game oracle froze while intercepted, release restored legacy/raw/primary-pointer input and confinement, released Escape closed each target, and a clean fresh relaunch completed; the runner emitted `D3D12_REAL_CLIENT_SDK_GATE_PASS`;
- upstream hudhook 0.9.1 independently hooks the controlled D3D11 host and owns the ImGui lifecycle;
- the public Electron SDK publishes a 640 x 360 offscreen window from both a focused lifecycle producer and the real built client through the authenticated loopback transport;
- a worker in the hudhook payload consumes direct BGRA frame packets, converts premultiplied BGRA to straight RGBA, and atomically publishes one immutable back-to-front scene with matching router state;
- hudhook maintains a per-window texture cache and ImGui draws each transparent Electron page borderlessly at its advertised position and size;
- registration order is back-to-front, duplicate registration is remove-then-append, transparent pixels fall through during hit testing, and click intents raise the hit window locally;
- `window.bounds` moves one surface, `window.close` removes only that surface, and re-registering the same `BrowserWindow` appends its replacement mapping on top without disturbing peers;
- the project-owned router handles requested/effective interception, per-window focus, focused keyboard routing, a multi-button capture owner, front-to-back hit testing, and regular Win32 input packets without changing the public Electron SDK;
- `-ClientInput` proves left-click/focus ordering, text, vertical wheel, intercepted and released Escape, acknowledgements, and normal host exit; lower-level tests cover horizontal wheel, outside-bounds capture/release, outside swallowing, right/middle buttons, extended characters, synthetic cleanup releases, guarded filter transitions, at-most-once input retry classification, and move coalescing;
- `-ClientMultiWindow -DeviceScaleFactor 1.25 -Wait` proves two-window composition, the full DIP-to-physical metadata/frame and physical-to-DIP input contract, caption movement, an exposed BACK click-to-front transition without producer lifecycle traffic, topmost-only input, keyboard focus, out-of-bounds capture, re-registration, hide/show isolation, release, normal exit, and cleanup;
- `-ClientMultiWindowManual -Wait` exposes the same overlapping BACK/FRONT pages and their hide/show/raise controls for hands-on testing;
- the diagnostic, `-Client`, `-ClientWindow`, `-ClientInput`, and multi-window runners verify producer readiness and exact-PID receipt, upload, composition, and applicable lifecycle/input markers;
- the attached runner path verifies normal host exit and cleans only its controlled Electron process tree;
- token-authenticated ephemeral-port discovery replaces the fixed native IPC-host collision guard.

The implemented hudhook path is defined in [`hudhook-imgui-overlay-poc.md`](hudhook-imgui-overlay-poc.md):

1. Pin and consume the released hudhook crate unchanged.
2. Inject a backend-specific D3D11 payload into a clean copy of the controlled host.
3. Draw an always-visible ImGui diagnostics panel and generated texture.
4. Verify resize and clean exit behavior, then add eject/reinjection as a hardening check.
5. Connect generic transparent Electron windows through the current SDK/add-on frame path and verify native bounds plus move/close/re-register lifecycle.
6. Make the hit/focused window interactive through mouse/keyboard interception (complete for regular Win32 messages).
7. Compose and route an ordered multi-window scene (complete); separately smoke-test the unchanged payload in one allowed offline D3D11 game or application.
8. Add a backend-specific D3D12 payload and controlled D3D12 host, then repeat the Electron composition, input, and multi-window proof without expanding the acceptance scope. **Complete.**
9. Integrate the proven hudhook path into the real client workflow and replace the old injection/transport dependencies needed to finish the POC. **Complete.**
10. After the POC is complete, harden target-HWND display/client-origin ownership, backing-window/per-target geometry, real mixed-scale hardware/VM behavior, and deferred GPU texture retirement.

The controlled D3D11 and D3D12 graphics paths, real-client integration, project-owned Electron transport, regular Win32 input, multi-window/z-order, uniform-scale, and producer-window/runtime transition criteria are complete. The implementation, runner modes, and diagnostics are in [`poc/hudhook-imgui-overlay`](../poc/hudhook-imgui-overlay/README.md), with acceptance records in [`hudhook-input-interactivity-handoff.md`](hudhook-input-interactivity-handoff.md) and [`hudhook-multiwindow-compositor-handoff.md`](hudhook-multiwindow-compositor-handoff.md). ReShade coexistence was not an adoption gate for that completed hudhook-controlled milestone; the current host decision above supersedes its runtime selection after real-game input validation. Target-display ownership, mixed-monitor acceptance, texture retirement, a production injector, and other geometry/DPI edge cases remain recorded post-POC hardening rather than blockers.

## Research checklist for search agent

The ReShade baseline and superseded upstream-hudhook runtime decision are
complete for controlled D3D11/D3D12, including the bounded production-client
D3D12 gate. Keep this checklist for allowed-application compatibility, transport
evolution, input forwarding, DPI behavior, and backend expansion.

### Dear ImGui as injected game overlay

- [ ] Search for projects that use Dear ImGui in injected game overlays.
- [ ] Search for Dear ImGui overlays that hook D3D11 `Present`.
- [ ] Search for Dear ImGui overlays that hook D3D12 `Present` / `ExecuteCommandLists`.
- [ ] Search for Dear ImGui overlays that hook Vulkan `vkQueuePresentKHR`.
- [ ] Search for Dear ImGui overlays that support OpenGL swap/present hooks.
- [ ] Search for how OptiScaler initializes and renders its ImGui overlay.
- [ ] Search for how Special K renders its overlay and handles graphics backends.
- [ ] Search for how ReShade renders its overlay and handles input.
- [ ] Search for common ImGui overlay issues with fullscreen, borderless fullscreen, HDR, multi-monitor, and DPI scaling.

### Electron offscreen rendering to native texture

- [ ] Search Electron offscreen rendering `paint` event pixel format and alpha behavior.
- [ ] Search Electron `nativeImage.toBitmap()` / `image.toBitmap()` BGRA/RGBA memory layout.
- [ ] Search Electron offscreen rendering frame rate, dirty rectangles, and `beginFrameSubscription`.
- [ ] Search Electron transparent offscreen window limitations on Windows.
- [x] Validate Electron offscreen input forwarding with `webContents.sendInputEvent`.
- [x] Validate Electron offscreen focus and DOM text input in the controlled runner.
- [ ] Search examples of embedding Electron/Chromium offscreen frames into native D3D/OpenGL/Vulkan textures.

### Texture upload and resource lifetime

- [ ] Search D3D11 dynamic texture upload patterns for CPU BGRA frames.
- [ ] Search D3D11 `UpdateSubresource` vs mapped dynamic textures for per-frame UI uploads.
- [ ] Search D3D12 upload heap to texture copy patterns for UI textures.
- [ ] Search D3D12 descriptor heap management for ImGui textures.
- [ ] Search Vulkan staging buffer to image upload patterns for UI textures.
- [ ] Search ImGui `ImTextureID` usage for D3D11, D3D12, Vulkan, and OpenGL backends.
- [ ] Search texture lifetime rules when rendering ImGui inside another application's swap chain.
- [ ] Search synchronization requirements for updating textures from another thread while rendering.

### Hooking and backend compatibility

- [ ] Search robust D3D11 swap-chain hook strategies.
- [ ] Search robust D3D12 swap-chain and command queue hook strategies.
- [ ] Search DXGI flip-model swap chain overlay issues.
- [ ] Search exclusive fullscreen vs borderless fullscreen overlay behavior.
- [ ] Search Vulkan layer vs injected hook approaches for overlays.
- [ ] Search OpenGL `wglSwapBuffers` overlay hook approaches.
- [ ] Search anti-cheat and overlay injection compatibility constraints.
- [ ] Search process integrity/elevation/bitness issues for DLL injection.
- [ ] Search how overlays handle games with multiple windows or multiple swap chains.

### Input forwarding and interception

- [ ] Search how injected overlays capture mouse/keyboard input on Windows.
- [ ] Search raw input vs window message hooks vs low-level hooks for overlays.
- [ ] Search ImGui Win32 backend input handling inside injected overlays.
- [ ] Search how game overlays prevent the game from receiving input while overlay is open.
- [ ] Search coordinate mapping for overlays with DPI scaling, fullscreen scaling, and letterboxing.
- [ ] Search focus handling for offscreen browser UIs receiving forwarded input.
- [ ] Search gamepad input forwarding or blocking for overlays.

### IPC and frame transport

- [ ] Search shared memory transport for high-frequency image frames between Node/Electron and native DLL.
- [ ] Search named pipe latency and throughput for frame buffers on Windows.
- [ ] Search memory-mapped file ring buffers for BGRA frames.
- [ ] Search synchronization primitives for host-to-DLL frame delivery.
- [ ] Search strategies for dropping stale UI frames instead of blocking render.
- [ ] Search binary protocol design for native overlay window/frame messages.
- [ ] Search crash-safe cleanup of shared memory and named pipe resources.

### Diagnostics and debugging

- [ ] Search native DLL logging before IPC connection is available.
- [ ] Search `OutputDebugString` tooling and limitations for injected DLLs.
- [ ] Search rotating file logging from injected DLLs under Windows temp/app-data.
- [ ] Search forwarding native diagnostics from injected runtime to Electron.
- [ ] Search graphics hook diagnostics patterns: backend detected, hook installed, present called, frame drawn.
- [ ] Search ImGui debug overlay patterns for runtime diagnostics.

### Licensing and packaging

- [ ] Search Dear ImGui license requirements for redistribution.
- [ ] Search ImGui backend source packaging expectations.
- [ ] Search native package layout for shipping x86/x64 DLLs and helper EXEs in npm packages.
- [ ] Search Nx packaging patterns for native runtime assets.
- [ ] Search Windows code signing requirements or recommendations for injected DLL/helper binaries.

### Expected research output

The search agent should produce:

- links to representative open-source implementations,
- notes on which graphics APIs each implementation supports,
- texture upload examples per backend,
- input interception examples,
- known compatibility problems,
- logging/debugging strategies for injected DLLs,
- licensing/redistribution notes,
- a recommendation for the first backend to prototype.

## Implementation phases

### Phase 1: native proof of life (complete)

- Use ReShade 6.7.3 full add-on support as the alternative hook/runtime.
- Render a hardcoded diagnostics panel in the controlled D3D11 host.
- Log add-on load, GPU resource creation, first ImGui frame, resize, and unload.

### Phase 2: independent hudhook proof

- [x] Inject an upstream hudhook D3D11 payload into the clean controlled host.
- [x] Render the diagnostics panel and generated texture without ReShade.
- [x] Verify resize and clean exit behavior; eject/reinjection remains a hardening check.
- [ ] Smoke-test the unchanged payload in one allowed D3D11 game/application.
- [x] Repeat with hudhook's D3D12 backend and a controlled D3D12 host, including Electron input and multi-window parity.
- [x] Decide that upstream usage is sufficient unless a concrete graphics-hook blocker appears.

### Phase 3: texture-backed overlay window

- [x] Upload a generated CPU bitmap into a GPU texture in the ReShade baseline.
- [x] Draw the texture with ImGui in the ReShade baseline.
- [x] Repeat both operations through hudhook before building the Electron transport.
- [x] Add a selected-window state carrying native ID, bounds, visibility lifecycle, mapping, and latest frame.
- [x] Generalize the completed interactive one-window state to multiple windows with explicit back-to-front order.

### Phase 4: Electron frame transport

- [x] Reuse the current SDK/add-on mapping for one generic transparent Electron window, including the real built client.
- [x] Copy under the existing named mutex and convert premultiplied BGRA to straight RGBA on an IPC worker.
- [x] Publish a latest-surface snapshot and upload only when its sequence changes.
- [x] Compose at native bounds and handle move, close, and re-register with a replacement mapping.
- [x] Add receipt, upload, composition, clear, and resume diagnostics to the exact target PID's log.
- [x] Add atomic multiple-window scene/router state, click-to-front ordering, and per-window texture caching.
- [x] Prove uniform forced 1.25 DIP-to-physical metadata/frame mapping and signed physical-to-DIP input.
- [x] Add content-bounds producer tracking, desired/active display state, renderer-acknowledged cropped-capture barriers, bitmap-authoritative rounding tolerance, per-packet input scale tags with legacy fallback, stale-raster suppression, transactional checked buffer growth, and a PMv2 controlled host.
- [ ] Define target-HWND display/client-origin ownership and backing-window/per-target routing, then pass manual mixed-scale hardware/VM acceptance.
- [ ] Add resize-safe texture retirement.
- [ ] Decide from profiling whether to evolve the current transport into a versioned, stride-aware double buffer.

### Phase 5: regular Win32-message input forwarding and ordered window routing

The implementation and deterministic acceptance record are in [`hudhook-input-interactivity-handoff.md`](hudhook-input-interactivity-handoff.md).

- [x] Add hit testing for the selected ImGui-composited Electron window.
- [x] Forward left/right/middle mouse, vertical/horizontal wheel, keyboard,
      system-key, character, focus, and blur events to Electron. The DOM proof covers
      left click and vertical wheel; horizontal wheel is lower-level translation coverage.
- [x] Toggle global interception through the existing `OverlaySession.input` API.
- [x] Keep native ImGui debug panels separate from Electron windows.
- [x] Add a controlled `-ClientInput` regression mode.
- [x] Add deterministic and manual multi-window modes covering topmost input,
      focus, keyboard routing, pointer capture, ordering, and isolated lifecycle.

### Phase 6: backend expansion

- Keep D3D11 and D3D12 as the primary supported paths.
- Add hudhook's D3D9 backend if a legacy compatibility fallback is needed.
- Evaluate OpenGL or Vulkan only if product scope later requires them.
- Keep a compatibility matrix per backend and game.

## API impact

The public Electron SDK does not need to expose ImGui directly.

The SDK can keep the higher-level model:

```ts
const overlay = new ElectronGameOverlay();
const session = overlay.createSession();

// The application launches the selected native host for the target/runtime.
session.start();

const window = session.windows.addElectronWindow(browserWindow, {
  x: 100,
  y: 100,
  width: 640,
  height: 360,
});

await session.input.intercept();
window.show();
```

The native implementation behind that window/session/input API uses ImGui
internally. The active ReShade implementation keeps the public
session/window/input surface and replaces the hudhook launcher and runtime
assets. Generic `findWindows()` and `attachToProcess()` are retained only for
source compatibility and currently throw explicitly. The accepted target
boundary is process-name arming before launch; late injection and broader game
compatibility remain future work.

## Open questions

Resolved: the production client does not select D3D11 or D3D12. It arms one
target process name and ReShade selects the target graphics API.

- Should ImGui be only a compositor, or should it also provide first-class native debug/settings panels?
- Should Electron window textures be updated every frame or only when Electron emits a dirty frame?
- Should frame buffers be compressed, shared memory backed, or sent as raw buffers at first?
- How should native diagnostics be surfaced before IPC is connected?
- How much of the current native compositor can be replaced incrementally?

## Current recommendation

Try this as a native runtime experiment, not as a rewrite of the Electron SDK.

Use ReShade as the process-entry, graphics, swap-chain, ImGui, logging, and
game-side input host. Connect the existing Electron implementation behind a thin
ReShade add-on boundary rather than recreating its proven transport and window
semantics. A likely implementation is a small C++ add-on calling an extracted
Rust static library through a narrow C ABI.

Treat ReShade as a maintained base, not a claim that its stock input classifier
is universal. Unity 6 demonstrated a concrete missing `WM_POINTER` path. The
current pinned patch is narrow, independently oracularized, and a candidate for
upstreaming; controller APIs and other projections remain explicit compatibility
adapters rather than guessed detours.

Reuse these exact hudhook-POC results:

- the public `ElectronGameOverlay`, session, window, and input contract;
- Electron OSR production, `focusOnWebView()`, TypeScript input translation,
  per-packet scale tags, and desired/active raster transitions;
- `libs/electron-game-overlay/src/lib/hudhook-transport.ts`, which is an
  authenticated backend-neutral Node loopback transport despite its name;
- `electron_wire.rs`, `electron_frame.rs`, and `electron_input.rs`, extracted
  from the hudhook crate into host-neutral Rust code;
- checked BGRA framing, premultiplied-alpha conversion, reconnect snapshots,
  frame coalescing, and atomic ordered scene/router publication;
- multi-window registration order, click-to-front, alpha hit testing, caption
  dragging, focus-before-input, multi-button pointer capture, and cleanup;
- the controlled hosts, Electron producers, Ctrl+I ownership, diagnostics, and
  existing input/lifecycle/multi-window acceptance cases.

Replace or retire these hudhook-specific pieces:

- the hudhook injector, backend-specific payload launch, SDK backend selection,
  and runtime packaging;
- hudhook's D3D11/D3D12 render loops, `Present`-phase input filter, texture
  cache/resource wrapper, and ImGui-context ownership;
- the local synchronous-WndProc hudhook patch, project-owned User32 polling,
  cursor and buffered-raw-input detours, and their MinHook teardown/ejection
  lifecycle;
- further per-game input-API detours intended to compensate for gaps in that
  private blocking layer.

The first adoption gate remains behavioral: pass-through must be fail-open;
interception must leave the overlay fully interactive, release game cursor
confinement/recentering, and prevent the game from observing the same input;
release/focus loss/transport failure/shutdown must restore normal game input.
That behavior is now proven on the controlled D3D11 and D3D12 hosts and Gun Frog;
the production SDK/client ReShade path passes the same Gun Frog gate and two
fresh controlled D3D12 lifecycle/multi-window cycles when armed by process name
before launch. Target-HWND/client-origin ownership, mixed monitors, multiple
targets, texture retirement, broader game/API coverage, late injection,
arbitrary fast-start target timing, graceful disable/unload, and installer/proxy
conflicts remain post-POC hardening. Competitive or anti-cheat-protected targets, anti-cheat
bypass work, and VR remain outside the unsigned full-add-on POC.
