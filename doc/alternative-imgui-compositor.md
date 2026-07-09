# Alternative solution: ImGui native compositor

## Idea

Use Dear ImGui inside the injected native overlay runtime as the compositor for overlay content.

The Electron side would still render offscreen windows into bitmap frames. The native runtime would receive those frames, upload them to graphics textures, and use ImGui to draw those textures into the game's render frame.

This would make ImGui responsible for the native in-game overlay composition layer, not for the application UI itself.

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

Each supported graphics backend needs a texture upload path:

-   D3D11: upload bitmap into `ID3D11Texture2D`, bind as shader resource view, pass SRV as ImGui texture ID.
-   D3D12: upload through an upload heap into a texture resource, manage SRV descriptors, pass GPU descriptor handle as ImGui texture ID.
-   Vulkan: upload into `VkImage`, create image view and sampler, register descriptor set for ImGui texture ID.
-   OpenGL: upload into `GLuint` texture, pass texture handle as ImGui texture ID.

ImGui gives us renderer backends, but it does not remove the need to integrate correctly with each hooked graphics API.

## Why this may be worth trying

-   Dear ImGui already has mature renderer backends for D3D11, D3D12, Vulkan, and OpenGL.
-   It is widely used for injected in-game tools and debug overlays.
-   It gives us a known native UI layer for diagnostics.
-   It may simplify multi-window composition.
-   It gives us a practical way to inspect the native runtime from inside the game.
-   It may make the native layer easier to reason about than a fully custom compositor.

## Risks and limitations

-   ImGui does not solve injection compatibility by itself.
-   ImGui does not make Electron input automatic.
-   Every graphics API still needs explicit texture upload and resource lifetime handling.
-   D3D12/Vulkan descriptor/resource management can become complex.
-   Large Electron windows updated every frame may be expensive if uploads are naive.
-   Some games may still fail due to anti-cheat, privilege, swap-chain, fullscreen, or hook timing issues.
-   ImGui is immediate-mode; Electron windows should be represented as stable native overlay state, then drawn each frame.

## First experiment

The first experiment should be intentionally small:

1. Pick one backend first, preferably D3D11.
2. Inject into the existing test window or a known D3D11 sample.
3. Initialize Dear ImGui in the hooked render path.
4. Draw a native ImGui debug panel to prove the render path works.
5. Upload one static bitmap into a D3D11 texture.
6. Draw that bitmap with `ImGui::Image`.
7. Replace the static bitmap with an Electron offscreen frame.
8. Add simple mouse coordinate forwarding to Electron.
9. Add keyboard forwarding.
10. Add show/hide and intercept toggles.

Success criteria:

-   A native ImGui debug panel appears in the game.
-   An Electron-rendered bitmap appears as an ImGui image.
-   Button clicks in the Electron page work through forwarded input.
-   Show/hide and intercept behavior are observable.
-   Logs identify whether failure happened at injection, hook, ImGui init, texture upload, frame transport, or input forwarding.

## Research checklist for search agent

Before implementing this approach, pass this checklist to a search/research agent and collect links, examples, caveats, and known failure modes.

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

## Possible implementation phases

### Phase 1: native proof of life

-   Add ImGui to the native runtime build.
-   Initialize ImGui in one backend.
-   Render a hardcoded diagnostics panel.
-   Log backend name, swap-chain/window handle, and render status.

### Phase 2: texture-backed overlay window

-   Add a native `OverlayTextureWindow` concept.
-   Upload a static CPU bitmap into a GPU texture.
-   Draw the texture with ImGui.
-   Support position, size, visibility, and z-order.

### Phase 3: Electron frame transport

-   Reuse the existing frame buffer protocol.
-   Upload Electron frames into the native texture window.
-   Track dirty frames so texture upload only happens when the Electron frame changes.
-   Add frame upload diagnostics.

### Phase 4: input forwarding

-   Add hit testing against ImGui-composited Electron windows.
-   Forward mouse, wheel, keyboard, focus, and blur events to Electron.
-   Keep native ImGui debug panels separate from Electron windows.

### Phase 5: backend expansion

-   Repeat the texture upload and ImGui init path for D3D12.
-   Then evaluate Vulkan/OpenGL.
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
-   Should D3D11 be the first backend, or should the existing native runtime's strongest backend be used first?
-   How should native diagnostics be surfaced before IPC is connected?
-   How much of the current native compositor can be replaced incrementally?

## Recommendation

Try this as a native runtime experiment, not as a rewrite of the Electron SDK.

The best first milestone is: render one Electron offscreen window as an ImGui image in one known graphics backend with working mouse input. If that works cleanly, the approach is worth expanding.
