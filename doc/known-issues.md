## known game compatible issues

Since we need to inject a dll into an existing game process, it will definitely has some compatible issues.

known issues:

### Current ReShade migration support envelope

The active native-host experiment uses ReShade 6.7.3 full add-on support, but its
visible D3D11/D3D12 input-gate runs and Gun Frog acceptance are still pending.
The existing Electron SDK/client continues to use the retained hudhook path until
that gate passes and the host migration is implemented.

For this project, **Steam-like** describes the behavior required inside an
explicitly supported target: passive mode leaves game input unchanged; intercept
mode keeps the Electron/ImGui overlay fully interactive, releases game cursor
confinement/recentering, prevents the game from observing the same mouse and
keyboard activity, and restores normal input on release, focus loss, transport
failure, or shutdown. It does not claim Steam's code signing, launcher ownership,
anti-cheat relationships, compatibility database, or universal game coverage.

The initial candidate envelope is Windows x64 with controlled D3D11 and D3D12
hosts, followed by permitted offline/single-player applications. These cases are
not supported by the current POC:

-   competitive, anti-cheat-protected, protected, or otherwise restricted
    processes; no stealth or anti-cheat bypass work is in scope;
-   target/runtime integrity-level mismatch or an elevated target launched from
    a lower-integrity client;
-   x86 targets and VR runtimes (`reshade_overlay` is not invoked for VR);
-   Vulkan, OpenGL, D3D9, unusual/exclusive presentation paths, multiple swap
    chains, and multiple simultaneous targets until each has an explicit test;
-   coexistence with an existing ReShade installation or another proxy DLL until
    conflict detection and a supported installation strategy are implemented;
-   physical/VM mixed-monitor target ownership, target-client origin mapping,
    safe texture retirement, or broader gamepad/DirectInput/XInput/GameInput
    handling until their recorded acceptance work is complete.

Unsupported or untested must produce a clear diagnostic rather than silently
claiming compatibility. Maintain a matrix per target with architecture,
integrity level, graphics API, presentation mode, runtime load result, overlay
input result, game-input suppression result, and required workaround.

#### Overlay runtime issues to fix

-   [ ] Intercept mode shows a non-configurable background when no overlay windows are visible.
    -   Source / likely cause: the injected native overlay runtime (`libs/native-game-overlay/prebuilt/n_overlay.dll` and `libs/native-game-overlay/prebuilt/n_overlay.x64.dll`) appears to clear or draw the overlay layer with an internal default color while input interception is active. The current JS/node message API only exposes `command.input.intercept` in `libs/node-game-overlay/src/message/gmessage.hpp`; there is no background color or clear-color field in `OverlayInit`, `InputInterceptCommand`, or the Electron SDK API.
    -   Possible solution: add a configurable clear/background color to the native overlay protocol, expose it through `node-game-overlay`, then surface it in `electron-game-overlay` as a typed session/overlay option. If the intended default is transparent, change the native renderer clear path to use a transparent clear color when no overlay windows are present.
-   [x] Reassert Chromium page focus before forwarding input to an offscreen overlay.
    -   Root cause: Electron 16's offscreen `WebContents.focus()` path is a no-op and its OSR view reports itself unfocused. Calling it before `webContents.sendInputEvent(...)` did not focus Chromium's render widget.
    -   Resolution: `OverlaySession` now calls `BrowserWindow.focusOnWebView()` immediately before every forwarded packet. This is the Electron 16 OSR-specific page-focus path and does not activate the hidden native window or take foreground ownership from the game.
-   [ ] Overlay compatibility is not universal across all games.
    -   Legacy source / likely cause: the original native protocol only reports graphics hook details for `d3d9` and `dxgi` in `libs/node-game-overlay/src/message/gmessage.hpp`. That covers D3D9 and DXGI-backed DirectX versions, but does not prove support for every graphics API or presentation path a game can use, such as Vulkan, OpenGL, D3D12-specific paths, unusual swap-chain modes, exclusive fullscreen behavior, multiple swap chains, protected/anti-cheat processes, elevated integrity processes, or game-specific render timing. Steam Overlay can appear universal because Steam owns the launcher/runtime integration, has broad backend support, and can carry a large compatibility database and per-game handling over time.
    -   Current direction: let ReShade own the maintained graphics/input host rather than expanding private hudhook detours. Expose runtime and hook status through the SDK, fail clearly for unsupported or partially hooked targets, and add backends/presentation modes only with explicit acceptance evidence. Keep the compatibility matrix described above.

#### Origin overlay and Steam overlay

It can work together with Steam overlay, but unfortunately did not work with Origin overlay.

The coexistence statement and game list below describe the legacy overlay runtime
and are not compatibility claims for the pending ReShade-host migration.

#### Games that I played and tested

Some of the games can use multiple versions of graphics API, make sure set graphics api to one of dx9, dx10, dx11

-   [x] League of Legends
-   [x] Dota 2
-   [x] CS:GO
-   [x] Team Fortress 2
-   [x] Life Is Strange
-   [x] Ori
-   [x] GTA 5
-   [x] Fallout 4
-   [x] Rise Of The Tomb Raider
-   [x] Guts and Glory
-   [x] PlayerUnknown's Battlegrounds
-   [x] Life is Strange Before the Storm
-   [x] Child of Light
-   [x] Borderlands 2
-   [x] Cuphead
-   [x] Witcher 3
-   [x] WORLD OF FINAL FANTASY®
-   [x] Left 4 Dead 2
-   [x] Tom Clancy's The Division
-   [x] Tom Clancy's Rainbow Six Siege
-   [x] Half-Life 2

#### games that have issues for now

-   [ ] Battlefield 1
-   [ ] Star Wars battlefront 2
