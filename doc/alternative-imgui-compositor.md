# Alternative solution: ImGui native compositor

## Idea

Use Dear ImGui inside the injected native overlay runtime as the compositor for overlay content.

The Electron side would still render offscreen windows into bitmap frames. The native runtime would receive those frames, upload them to graphics textures, and use ImGui to draw those textures into the game's render frame.

This would make ImGui responsible for the native in-game overlay composition layer, not for the application UI itself.

## Prototype status

The first proof of concept is implemented in [`poc/reshade-imgui-overlay`](../poc/reshade-imgui-overlay/README.md).

The next approved experiment is specified in [`hudhook-imgui-overlay-poc.md`](hudhook-imgui-overlay-poc.md). It repeats the native proof of life with the released hudhook crate, no ReShade runtime, D3D11 first, and D3D12 second. The experiment will use hudhook unchanged unless testing exposes a concrete reason to contribute an upstream fix or maintain a narrow fork.

The completed baseline uses the ReShade 6.7.3 full add-on runtime as the alternative native hook/runtime layer. ReShade, rather than ImGui, owns process entry, graphics API hooks, swap-chain lifecycle, input infrastructure, logging, and renderer integration. The add-on uses ReShade's managed Dear ImGui context to draw an always-visible diagnostics panel and a generated RGBA texture uploaded through ReShade's graphics-agnostic resource API.

This choice keeps the first experiment focused on the compositor seam instead of implementing another custom `Present` hook. A controlled D3D11 test host is included so the proof can be exercised without injecting into third-party software. ReShade's full add-on build is not anti-cheat allowlisted, so this experiment is limited to the test host and offline/single-player applications the operator is explicitly allowed to modify.

What this milestone proves:

-   an independent, maintained hook/runtime can enter the target render path;
-   Dear ImGui can render while the ReShade configuration overlay is closed;
-   a CPU-generated RGBA frame can become a GPU resource and be drawn with `ImGui::Image`;
-   the runtime survives D3D11 swap-chain resize handling owned by ReShade;
-   native initialization and texture failures are visible in `ReShade.log`.

It does not yet connect Electron frames or forward input. Before adding that integration, the hudhook POC will verify that the project can inject and draw the same class of ImGui content without owning custom graphics hooks or shipping ReShade.

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
8. Repeat it with hudhook's D3D12 backend and a controlled D3D12 host.
9. Observe hudhook/ReShade coexistence in the controlled host.
10. Decide whether upstream hudhook is sufficient or a narrow fork is justified.
11. Replace the generated bitmap with a versioned shared-memory frame.
12. Connect that frame source to an Electron offscreen window, then add input forwarding.

Steps 1 through 6 are covered by the current POC. The hudhook steps now test the same "it just appears" experience through independent late injection before changing the existing Electron SDK or frame protocol.

## Risks and limitations

-   ImGui does not solve injection compatibility by itself.
-   ImGui does not make Electron input automatic.
-   Every graphics API still needs explicit texture upload and resource lifetime handling.
-   D3D12/Vulkan descriptor/resource management can become complex.
-   Large Electron windows updated every frame may be expensive if uploads are naive.
-   Some games may still fail due to anti-cheat, privilege, swap-chain, fullscreen, or hook timing issues.
-   ImGui is immediate-mode; Electron windows should be represented as stable native overlay state, then drawn each frame.

## Current result and next experiment

The native proof-of-life milestone is complete:

-   the official ReShade full add-on runtime enters the controlled D3D11 host;
-   ReShade invokes the add-on through API version 18 and owns resize/unload handling;
-   the add-on draws an always-visible ImGui diagnostics panel;
-   a generated RGBA bitmap is uploaded as a GPU resource and drawn with `ImGui::Image`;
-   `ReShade.log` distinguishes add-on loading, texture creation, first-frame rendering, resize, and clean unload.

The next experiment is defined in [`hudhook-imgui-overlay-poc.md`](hudhook-imgui-overlay-poc.md) and should stay intentionally small:

1. Pin and consume the released hudhook crate unchanged.
2. Inject a backend-specific D3D11 payload into a clean copy of the controlled host.
3. Draw an always-visible ImGui diagnostics panel and generated texture.
4. Verify resize and clean exit behavior, then add eject/reinjection as a hardening check.
5. Smoke-test the unchanged payload in one allowed offline D3D11 game or application.
6. Repeat the proof with D3D12 and a controlled D3D12 host.
7. Only after the isolated baseline passes, observe coexistence with ReShade in the controlled host.

The next success criterion is an upstream-hudhook-owned ImGui panel and generated texture rendering reliably in the D3D11 host without any ReShade runtime. Electron frame transport remains the following milestone.

## Research checklist for search agent

The initial ReShade baseline is complete, while the production-runtime decision remains open pending the hudhook POC. Keep this checklist for that decision, shared-memory transport, input forwarding, and backend compatibility work.

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
-   [ ] Search Electron offscreen rendering input forwarding with `webContents.sendInputEvent`.
-   [ ] Search Electron offscreen focus issues with keyboard input and DOM `activeElement`.
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

### Phase 2: independent hudhook proof (next)

-   [ ] Inject an upstream hudhook D3D11 payload into the clean controlled host.
-   [ ] Render the diagnostics panel and generated texture without ReShade.
-   [ ] Verify resize and clean exit behavior; follow with eject/reinjection hardening.
-   [ ] Repeat with hudhook's D3D12 backend and a controlled D3D12 host.
-   [ ] Decide whether upstream usage is sufficient before considering a fork.

### Phase 3: texture-backed overlay window

-   [x] Upload a generated CPU bitmap into a GPU texture in the ReShade baseline.
-   [x] Draw the texture with ImGui in the ReShade baseline.
-   [ ] Repeat both operations through hudhook before building the Electron transport.
-   [ ] Add a native `OverlayTextureWindow` state model.
-   [ ] Support position, size, visibility, and z-order.

### Phase 4: Electron frame transport

-   Define a versioned, stride-aware shared-memory frame protocol.
-   Publish into a double buffer and never wait on the render thread.
-   Upload Electron frames into the native texture window only when the sequence changes.
-   Add dropped-frame and upload diagnostics.

### Phase 5: input forwarding

-   Add hit testing against ImGui-composited Electron windows.
-   Forward mouse, wheel, keyboard, focus, and blur events to Electron.
-   Keep native ImGui debug panels separate from Electron windows.

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

The immediate milestone is to render an ImGui panel and generated texture through upstream hudhook in the controlled D3D11 host without ReShade. If D3D11 and D3D12 behave cleanly, keep hudhook upstream and proceed to one Electron offscreen window with working pointer input.
