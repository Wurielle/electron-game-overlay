# Alternative solution: ImGui native compositor

## Idea

Use Dear ImGui inside the injected native overlay runtime as the compositor for overlay content.

The Electron side would still render offscreen windows into bitmap frames. The native runtime would receive those frames, upload them to graphics textures, and use ImGui to draw those textures into the game's render frame.

This would make ImGui responsible for the native in-game overlay composition layer, not for the application UI itself.

## Prototype status

The first proof of concept is implemented in [`poc/reshade-imgui-overlay`](../poc/reshade-imgui-overlay/README.md).

The follow-up experiment in [`hudhook-imgui-overlay-poc.md`](hudhook-imgui-overlay-poc.md) now proves the same native path with released hudhook 0.9.1 and no ReShade runtime. It composes one generic Electron window from both a controlled producer and the real built client through the repository's existing Electron SDK, Node add-on IPC, mutex, and shared-memory mapping. The D3D11 payload renders transparent content at native bounds, survives move/close/re-register lifecycle changes, and forwards controlled Win32 input back to the selected Electron window. No hudhook fork was needed.

The completed baseline uses the ReShade 6.7.3 full add-on runtime as the alternative native hook/runtime layer. ReShade, rather than ImGui, owns process entry, graphics API hooks, swap-chain lifecycle, input infrastructure, logging, and renderer integration. The add-on uses ReShade's managed Dear ImGui context to draw an always-visible diagnostics panel and a generated RGBA texture uploaded through ReShade's graphics-agnostic resource API.

This choice keeps the first experiment focused on the compositor seam instead of implementing another custom `Present` hook. A controlled D3D11 test host is included so the proof can be exercised without injecting into third-party software. ReShade's full add-on build is not anti-cheat allowlisted, so this experiment is limited to the test host and offline/single-player applications the operator is explicitly allowed to modify.

What this milestone proves:

-   an independent, maintained hook/runtime can enter the target render path;
-   Dear ImGui can render while the ReShade configuration overlay is closed;
-   a CPU-generated RGBA frame can become a GPU resource and be drawn with `ImGui::Image`;
-   the runtime survives D3D11 swap-chain resize handling owned by ReShade;
-   native initialization and texture failures are visible in `ReShade.log`.

The ReShade baseline itself does not connect Electron frames or forward input. The hudhook POC closes both gaps for one selected 640 x 360 window, including premultiplied-alpha correction, visibility lifecycle, focus, project-owned pointer-capture state, and Win32 input interception. Multiple-window ordering and broader input APIs remain open.

## Current model

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

-   z-order and per-window draw ordering,
-   clipping,
-   debug overlay rendering,
-   simple diagnostics UI,
-   native cursor/input debug visualization,
-   texture placement in the game frame.

It would not replace:

-   Electron offscreen rendering,
-   the Electron SDK,
-   frame buffer transport,
-   native injection,
-   graphics API hooks,
-   input forwarding to Electron,
-   per-game compatibility work.

## Communication requirements

The protocol between host and injected runtime would still need messages for:

-   session attach/detach,
-   input intercept on/off,
-   window add/remove,
-   window show/hide,
-   window bounds,
-   window z-order,
-   frame buffer upload,
-   frame format,
-   cursor position,
-   mouse button events,
-   wheel events,
-   keyboard events,
-   focus/blur events,
-   diagnostics.

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
  frameFormat: "bgra" | "rgba";
};
```

Possible frame message shape:

```ts
type NativeOverlayFrame = {
  windowId: string;
  width: number;
  height: number;
  stride: number;
  format: "bgra" | "rgba";
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

-   Native debug UI: real ImGui widgets.
-   Electron overlay windows: ImGui-drawn images with manual input forwarding.

## Graphics backend implications

An independently owned runtime needs a texture upload path for each supported graphics backend:

-   D3D11: upload bitmap into `ID3D11Texture2D`, bind as shader resource view, pass SRV as ImGui texture ID.
-   D3D12: upload through an upload heap into a texture resource, manage SRV descriptors, pass GPU descriptor handle as ImGui texture ID.
-   Vulkan: upload into `VkImage`, create image view and sampler, register descriptor set for ImGui texture ID.
-   OpenGL: upload into `GLuint` texture, pass texture handle as ImGui texture ID.

ImGui gives us renderer backends, but it does not remove the need to integrate correctly with each hooked graphics API.

The ReShade POC delegates those backend-specific resource and descriptor details to ReShade's add-on API. That is useful for validating the compositor model quickly, but it also means the first POC depends on the ReShade runtime rather than owning the complete native stack.

## Why this may be worth trying

-   Dear ImGui already has mature renderer backends for D3D11, D3D12, Vulkan, and OpenGL.
-   It is widely used for injected in-game tools and debug overlays.
-   It gives us a known native UI layer for diagnostics.
-   It may simplify multi-window composition.
-   It gives us a practical way to inspect the native runtime from inside the game.
-   It may make the native layer easier to reason about than a fully custom compositor.

## Native injection guidance

Dear ImGui is not the injection system. It only renders UI once our code is already running inside the target process and has access to the game's render path.

The native overlay runtime still needs a process-entry strategy, graphics hook strategy, input strategy, IPC strategy, and diagnostics strategy.

### Process entry options

-   Proxy / wrapper DLL:
    -   Place a DLL next to the game executable with a name the game naturally loads, such as `dinput8.dll`, `dxgi.dll`, `d3d11.dll`, or another known dependency.
    -   The proxy DLL loads the real system DLL and forwards exports while also initializing the overlay runtime.
    -   This gets the overlay loaded early, often before graphics device and swap-chain creation.
    -   This is the style used by many modding and overlay projects, including REFramework's common non-VR install flow with `dinput8.dll`.
-   Late runtime injection:
    -   Inject a DLL into an already-running process by PID or selected window.
    -   This is more flexible for third-party apps, but can miss early graphics initialization and may need to recover by discovering already-created devices/swap chains.
    -   This is closer to the current attach-to-process model.
-   Global hook / launcher integration:
    -   Use a launcher or global Windows hook to inject into matching processes.
    -   This can feel more automatic, but it is more invasive and has higher security/compatibility risk.
-   Backend-specific loader:
    -   Use graphics/runtime-specific extension points where available, such as Vulkan layers or OpenXR layers.
    -   This can be cleaner for specific ecosystems, but does not cover every graphics API with one implementation.

The completed ReShade POC uses a scoped proxy runtime for early process entry. The next hudhook POC deliberately uses late injection so it does not claim a local proxy filename that may already belong to a user's ReShade installation. Keep the launcher/injector path as the preferred product direction unless testing demonstrates a target that requires earlier process entry.

### Graphics hook targets

Start with one graphics backend instead of trying to support every game immediately.

-   D3D11:
    -   Hook `IDXGISwapChain::Present`.
    -   Hook `IDXGISwapChain::ResizeBuffers`.
    -   Initialize ImGui with the D3D11 and Win32 backends.
    -   This is the recommended first backend because texture upload and ImGui integration are comparatively simple.
-   D3D12:
    -   Hook swap-chain present.
    -   Track command queue / command list / descriptor heap state.
    -   Initialize ImGui with the D3D12 backend.
    -   Harder than D3D11 because resource barriers, descriptor heaps, frame resources, and synchronization matter more.
-   Vulkan:
    -   Prefer a Vulkan layer if possible.
    -   Otherwise hook instance/device/swap-chain creation and `vkQueuePresentKHR`.
    -   Requires explicit image layout, command buffer, descriptor, and synchronization management.
-   OpenGL:
    -   Hook `wglSwapBuffers` on Windows.
    -   Upload Electron frames as GL textures and pass texture IDs to ImGui.

### Input interception

The overlay needs two different input modes:

-   Game mode:
    -   Input goes to the game.
    -   Overlay may render passive windows.
-   Intercept mode:
    -   Overlay captures mouse/keyboard/gamepad input.
    -   Input is hit-tested against overlay windows.
    -   Electron-backed windows receive translated input events.
    -   The game should not receive consumed input.

Implementation options to research and test:

-   Win32 window procedure hooks,
-   raw input,
-   low-level keyboard/mouse hooks,
-   DirectInput/XInput/GameInput hooks,
-   ImGui Win32 backend input handling for native debug panels.

Electron windows should not rely on ImGui widgets for input. For Electron-backed windows, ImGui should mostly provide hit testing and visual placement, then the runtime should forward translated input to Electron.

### Example projects to study

-   OptiScaler:
    -   Native runtime with ImGui overlay code for DirectX and Vulkan paths.
    -   Useful reference for integrating an ImGui menu into an existing native render/runtime pipeline.
-   ReShade:
    -   Generic native post-processing injector/runtime.
    -   Useful reference for broad graphics API hooking, runtime GUI, input handling, and effect/runtime lifecycle.
-   Special K:
    -   Native injection and graphics/runtime modification framework.
    -   Useful reference for proxy DLL loading, global injection, late injection, compatibility handling, and diagnostics.
-   REFramework:
    -   Native modding framework for RE Engine games, commonly loaded through a local proxy DLL.
    -   Useful reference for why scoped, early-loaded native overlays can feel reliable.
-   hudhook:
    -   Dear ImGui overlay framework.
    -   Useful reference for backend-specific ImGui overlay implementation, especially D3D11/D3D12/OpenGL.
-   HydraHook:
    -   DirectX API hooking/rendering framework with ImGui examples.
    -   Useful reference for DirectX hook structure and sample overlays.

### Recommended prototype path

1. Build a ReShade x64 add-on and a controlled D3D11 test host.
2. Install the official ReShade full add-on runtime beside that host.
3. Let ReShade own process entry, `Present`/resize hooks, and the ImGui frame lifecycle.
4. Draw a hardcoded, always-visible native diagnostics panel.
5. Upload a generated RGBA bitmap through ReShade's resource API.
6. Render that bitmap using `ImGui::Image` and verify resize behavior and logging.
7. Repeat the proof with an upstream hudhook D3D11 payload and late injector, without ReShade.
8. Reuse the existing Node add-on IPC/shared mapping to render one transparent Electron window from a controlled producer and the real built client.
9. Decide whether upstream hudhook is sufficient or a narrow fork is justified.
10. Make the selected Electron window interactive through the existing input/intercept protocol.
11. Generalize to multiple-window/z-order state, arbitrary-DPI handling, and resize-safe texture retirement.
12. After those compositor seams are stable, repeat the graphics proof with hudhook's D3D12 backend and a controlled D3D12 host.

Steps 1 through 10 are complete for controlled D3D11, including transparent native-bounds composition, one-window lifecycle, and selected-window Win32 input. The Electron proof intentionally keeps the existing SDK and frame protocol unchanged; a versioned double buffer remains an optimization option rather than a prerequisite for the first rendered window.

## Risks and limitations

-   ImGui does not solve injection compatibility by itself.
-   ImGui does not make Electron input automatic.
-   the POC selects one Electron window; it does not yet compose multiple windows or define z-order;
-   controlled runs force a 100% device scale, so arbitrary-DPI and mixed-monitor coordinates remain unproven;
-   Every graphics API still needs explicit texture upload and resource lifetime handling.
-   same-size updates replace the active texture, but resize-safe retirement of old texture IDs remains open;
-   D3D12/Vulkan descriptor/resource management can become complex.
-   Large Electron windows updated every frame may be expensive if uploads are naive.
-   Some games may still fail due to anti-cheat, privilege, swap-chain, fullscreen, or hook timing issues.
-   ImGui is immediate-mode; Electron windows should be represented as stable native overlay state, then drawn each frame.

## Current result and next experiment

The native proof-of-life, generic one-window Electron, and selected-window input
milestones are complete:

-   the official ReShade full add-on runtime enters the controlled D3D11 host;
-   ReShade invokes the add-on through API version 18 and owns resize/unload handling;
-   the add-on draws an always-visible ImGui diagnostics panel;
-   a generated RGBA bitmap is uploaded as a GPU resource and drawn with `ImGui::Image`;
-   `ReShade.log` distinguishes add-on loading, texture creation, first-frame rendering, resize, and clean unload.
-   upstream hudhook 0.9.1 independently hooks the controlled D3D11 host and owns the ImGui lifecycle;
-   the public Electron SDK publishes a 640 x 360 offscreen window from both a focused lifecycle producer and the real built client through the existing Node add-on;
-   a worker in the hudhook payload consumes that existing mapping, retains the selected window's ID and native bounds, converts premultiplied BGRA to straight RGBA, and publishes the latest owned surface;
-   hudhook uploads the frame and ImGui draws the transparent Electron page borderlessly at its advertised position and size;
-   `window.bounds` moves composition without a new UI model, `window.close` clears it, and re-registering the same `BrowserWindow` selects its replacement mapping and resumes drawing;
-   the project-owned router handles requested/effective interception, focus, multi-button pointer-capture state, hit testing, and regular Win32 input packets without changing the public Electron SDK;
-   `-ClientInput` proves left-click/focus ordering, text, vertical wheel, intercepted and released Escape, acknowledgements, and normal host exit; lower-level tests cover horizontal wheel, outside-bounds capture/release, outside swallowing, right/middle buttons, extended characters, synthetic cleanup releases, guarded filter transitions, at-most-once input retry classification, and move coalescing;
-   the diagnostic, `-Client`, `-ClientWindow`, and `-ClientInput` runners verify producer readiness and exact-PID receipt, upload, composition, and applicable lifecycle/input markers;
-   the attached runner path verifies normal host exit and cleans only its controlled Electron process tree;
-   the fixed native IPC-host guard prevents a test from accidentally connecting to another running overlay client.

The implemented hudhook path is defined in [`hudhook-imgui-overlay-poc.md`](hudhook-imgui-overlay-poc.md):

1. Pin and consume the released hudhook crate unchanged.
2. Inject a backend-specific D3D11 payload into a clean copy of the controlled host.
3. Draw an always-visible ImGui diagnostics panel and generated texture.
4. Verify resize and clean exit behavior, then add eject/reinjection as a hardening check.
5. Connect one generic transparent Electron window through the current SDK/add-on frame path and verify native bounds plus move/close/re-register lifecycle.
6. Make the selected window interactive through mouse/keyboard interception (complete for regular Win32 messages).
7. Add multiple-window/z-order state, DPI handling, and texture retirement; separately smoke-test the unchanged payload in one allowed offline D3D11 game or application.
8. Repeat the graphics proof with D3D12 and a controlled D3D12 host after the shared compositor state is ready.

The controlled D3D11, generic one-window Electron, and selected-window input criteria are complete. The implementation, runner modes, and diagnostics are in [`poc/hudhook-imgui-overlay`](../poc/hudhook-imgui-overlay/README.md), with the input design and acceptance record in [`hudhook-input-interactivity-handoff.md`](hudhook-input-interactivity-handoff.md). ReShade coexistence is not an adoption gate. Multiple windows/z-order, arbitrary-DPI coordinates, resize-safe texture retirement, and D3D12 follow.

## Research checklist for search agent

The initial ReShade baseline and upstream-hudhook runtime decision are complete for controlled D3D11. Keep this checklist for allowed-application compatibility, shared-memory evolution, input forwarding, DPI behavior, and backend expansion.

### Dear ImGui as injected game overlay

-   [ ] Search for projects that use Dear ImGui in injected game overlays.
-   [ ] Search for Dear ImGui overlays that hook D3D11 `Present`.
-   [ ] Search for Dear ImGui overlays that hook D3D12 `Present` / `ExecuteCommandLists`.
-   [ ] Search for Dear ImGui overlays that hook Vulkan `vkQueuePresentKHR`.
-   [ ] Search for Dear ImGui overlays that support OpenGL swap/present hooks.
-   [ ] Search for how OptiScaler initializes and renders its ImGui overlay.
-   [ ] Search for how Special K renders its overlay and handles graphics backends.
-   [ ] Search for how ReShade renders its overlay and handles input.
-   [ ] Search for common ImGui overlay issues with fullscreen, borderless fullscreen, HDR, multi-monitor, and DPI scaling.

### Electron offscreen rendering to native texture

-   [ ] Search Electron offscreen rendering `paint` event pixel format and alpha behavior.
-   [ ] Search Electron `nativeImage.toBitmap()` / `image.toBitmap()` BGRA/RGBA memory layout.
-   [ ] Search Electron offscreen rendering frame rate, dirty rectangles, and `beginFrameSubscription`.
-   [ ] Search Electron transparent offscreen window limitations on Windows.
-   [x] Validate Electron offscreen input forwarding with `webContents.sendInputEvent`.
-   [x] Validate Electron offscreen focus and DOM text input in the controlled runner.
-   [ ] Search examples of embedding Electron/Chromium offscreen frames into native D3D/OpenGL/Vulkan textures.

### Texture upload and resource lifetime

-   [ ] Search D3D11 dynamic texture upload patterns for CPU BGRA frames.
-   [ ] Search D3D11 `UpdateSubresource` vs mapped dynamic textures for per-frame UI uploads.
-   [ ] Search D3D12 upload heap to texture copy patterns for UI textures.
-   [ ] Search D3D12 descriptor heap management for ImGui textures.
-   [ ] Search Vulkan staging buffer to image upload patterns for UI textures.
-   [ ] Search ImGui `ImTextureID` usage for D3D11, D3D12, Vulkan, and OpenGL backends.
-   [ ] Search texture lifetime rules when rendering ImGui inside another application's swap chain.
-   [ ] Search synchronization requirements for updating textures from another thread while rendering.

### Hooking and backend compatibility

-   [ ] Search robust D3D11 swap-chain hook strategies.
-   [ ] Search robust D3D12 swap-chain and command queue hook strategies.
-   [ ] Search DXGI flip-model swap chain overlay issues.
-   [ ] Search exclusive fullscreen vs borderless fullscreen overlay behavior.
-   [ ] Search Vulkan layer vs injected hook approaches for overlays.
-   [ ] Search OpenGL `wglSwapBuffers` overlay hook approaches.
-   [ ] Search anti-cheat and overlay injection compatibility constraints.
-   [ ] Search process integrity/elevation/bitness issues for DLL injection.
-   [ ] Search how overlays handle games with multiple windows or multiple swap chains.

### Input forwarding and interception

-   [ ] Search how injected overlays capture mouse/keyboard input on Windows.
-   [ ] Search raw input vs window message hooks vs low-level hooks for overlays.
-   [ ] Search ImGui Win32 backend input handling inside injected overlays.
-   [ ] Search how game overlays prevent the game from receiving input while overlay is open.
-   [ ] Search coordinate mapping for overlays with DPI scaling, fullscreen scaling, and letterboxing.
-   [ ] Search focus handling for offscreen browser UIs receiving forwarded input.
-   [ ] Search gamepad input forwarding or blocking for overlays.

### IPC and frame transport

-   [ ] Search shared memory transport for high-frequency image frames between Node/Electron and native DLL.
-   [ ] Search named pipe latency and throughput for frame buffers on Windows.
-   [ ] Search memory-mapped file ring buffers for BGRA frames.
-   [ ] Search synchronization primitives for host-to-DLL frame delivery.
-   [ ] Search strategies for dropping stale UI frames instead of blocking render.
-   [ ] Search binary protocol design for native overlay window/frame messages.
-   [ ] Search crash-safe cleanup of shared memory and named pipe resources.

### Diagnostics and debugging

-   [ ] Search native DLL logging before IPC connection is available.
-   [ ] Search `OutputDebugString` tooling and limitations for injected DLLs.
-   [ ] Search rotating file logging from injected DLLs under Windows temp/app-data.
-   [ ] Search forwarding native diagnostics from injected runtime to Electron.
-   [ ] Search graphics hook diagnostics patterns: backend detected, hook installed, present called, frame drawn.
-   [ ] Search ImGui debug overlay patterns for runtime diagnostics.

### Licensing and packaging

-   [ ] Search Dear ImGui license requirements for redistribution.
-   [ ] Search ImGui backend source packaging expectations.
-   [ ] Search native package layout for shipping x86/x64 DLLs and helper EXEs in npm packages.
-   [ ] Search Nx packaging patterns for native runtime assets.
-   [ ] Search Windows code signing requirements or recommendations for injected DLL/helper binaries.

### Expected research output

The search agent should produce:

-   links to representative open-source implementations,
-   notes on which graphics APIs each implementation supports,
-   texture upload examples per backend,
-   input interception examples,
-   known compatibility problems,
-   logging/debugging strategies for injected DLLs,
-   licensing/redistribution notes,
-   a recommendation for the first backend to prototype.

## Implementation phases

### Phase 1: native proof of life (complete)

-   Use ReShade 6.7.3 full add-on support as the alternative hook/runtime.
-   Render a hardcoded diagnostics panel in the controlled D3D11 host.
-   Log add-on load, GPU resource creation, first ImGui frame, resize, and unload.

### Phase 2: independent hudhook proof

-   [x] Inject an upstream hudhook D3D11 payload into the clean controlled host.
-   [x] Render the diagnostics panel and generated texture without ReShade.
-   [x] Verify resize and clean exit behavior; eject/reinjection remains a hardening check.
-   [ ] Smoke-test the unchanged payload in one allowed D3D11 game/application.
-   [ ] Repeat with hudhook's D3D12 backend and a controlled D3D12 host.
-   [x] Decide that upstream usage is sufficient unless a concrete graphics-hook blocker appears.

### Phase 3: texture-backed overlay window

-   [x] Upload a generated CPU bitmap into a GPU texture in the ReShade baseline.
-   [x] Draw the texture with ImGui in the ReShade baseline.
-   [x] Repeat both operations through hudhook before building the Electron transport.
-   [x] Add a selected-window state carrying native ID, bounds, visibility lifecycle, mapping, and latest frame.
-   [ ] Generalize the completed interactive one-window state to multiple windows with explicit z-order.

### Phase 4: Electron frame transport

-   [x] Reuse the current SDK/add-on mapping for one generic transparent Electron window, including the real built client.
-   [x] Copy under the existing named mutex and convert premultiplied BGRA to straight RGBA on an IPC worker.
-   [x] Publish a latest-surface snapshot and upload only when its sequence changes.
-   [x] Compose at native bounds and handle move, close, and re-register with a replacement mapping.
-   [x] Add receipt, upload, composition, clear, and resume diagnostics to the exact target PID's log.
-   [ ] Add multiple-window/z-order state and arbitrary-DPI coordinate mapping.
-   [ ] Add resize-safe texture retirement.
-   [ ] Decide from profiling whether to evolve the current transport into a versioned, stride-aware double buffer.

### Phase 5: regular Win32-message input forwarding for one selected window

The implementation and deterministic acceptance record are in [`hudhook-input-interactivity-handoff.md`](hudhook-input-interactivity-handoff.md).

-   [x] Add hit testing for the selected ImGui-composited Electron window.
-   [x] Forward left/right/middle mouse, vertical/horizontal wheel, keyboard,
    system-key, character, focus, and blur events to Electron. The DOM proof covers
    left click and vertical wheel; horizontal wheel is lower-level translation coverage.
-   [x] Toggle global interception through the existing `OverlaySession.input` API.
-   [x] Keep native ImGui debug panels separate from Electron windows.
-   [x] Add a controlled `-ClientInput` regression mode.

### Phase 6: backend expansion

-   Keep D3D11 and D3D12 as the primary supported paths.
-   Add hudhook's D3D9 backend if a legacy compatibility fallback is needed.
-   Evaluate OpenGL or Vulkan only if product scope later requires them.
-   Keep a compatibility matrix per backend and game.

## API impact

The public Electron SDK does not need to expose ImGui directly.

The SDK can keep the higher-level model:

```ts
const overlay = new ElectronGameOverlay();
const session = overlay.createSession();

await session.attachToProcess({ title: "Game" });

const window = session.windows.addElectronWindow(browserWindow, {
  x: 100,
  y: 100,
  width: 640,
  height: 360,
});

await session.input.intercept();
window.show();
```

The native implementation behind that API could use ImGui internally.

## Open questions

-   Should ImGui be only a compositor, or should it also provide first-class native debug/settings panels?
-   Should Electron window textures be updated every frame or only when Electron emits a dirty frame?
-   Should frame buffers be compressed, shared memory backed, or sent as raw buffers at first?
-   Should the production payload select D3D11/D3D12 automatically or should the launcher select a backend-specific payload?
-   How should native diagnostics be surfaced before IPC is connected?
-   How much of the current native compositor can be replaced incrementally?

## Recommendation

Try this as a native runtime experiment, not as a rewrite of the Electron SDK.

Keep the Electron SDK and upstream hudhook boundary proven by this experiment. Generalize the completed interactive window to multiple windows and z-order, remove the controlled 100% DPI assumption, and retire resized textures safely. Once that shared compositor state is stable, add the D3D12 payload and controlled host without redesigning the Electron transport first.
