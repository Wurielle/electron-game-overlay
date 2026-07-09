## known game compatible issues

Since we need to inject a dll into an existing game process, it will definitely has some compatible issues.

known issues:

#### Overlay runtime issues to fix

-   [ ] Intercept mode shows a non-configurable background when no overlay windows are visible.
    -   Source / likely cause: the injected native overlay runtime (`libs/native-game-overlay/prebuilt/n_overlay.dll` and `libs/native-game-overlay/prebuilt/n_overlay.x64.dll`) appears to clear or draw the overlay layer with an internal default color while input interception is active. The current JS/node message API only exposes `command.input.intercept` in `libs/node-game-overlay/src/message/gmessage.hpp`; there is no background color or clear-color field in `OverlayInit`, `InputInterceptCommand`, or the Electron SDK API.
    -   Possible solution: add a configurable clear/background color to the native overlay protocol, expose it through `node-game-overlay`, then surface it in `electron-game-overlay` as a typed session/overlay option. If the intended default is transparent, change the native renderer clear path to use a transparent clear color when no overlay windows are present.
-   [ ] Overlay page inputs may not receive forwarded keyboard input when focus is driven only by `window.onfocus` / `window.onblur`.
    -   Source / likely cause: game input is forwarded to Electron with `webContents.sendInputEvent(...)` from `libs/electron-game-overlay/src/lib/overlay-session.ts`, and Electron expects the containing `BrowserWindow` to be focused for synthetic input to work. The SDK calls `focusOnWebView()` when the native runtime emits `game.window.focused`, but that does not always guarantee that the page's DOM focus state or `document.activeElement` is initialized, especially for offscreen Electron windows that have not been interacted with since app startup.
    -   Possible solution: avoid relying on page-level `window.onfocus` / `window.onblur` alone to focus inputs. Add an explicit overlay-window focus event in the SDK/app layer and forward it to the overlay renderer page, where the page can call `input.focus()` directly. For example windows, focus the intended input from a real pointer/click event or from a dedicated IPC focus message.
-   [ ] Overlay compatibility is not universal across all games.
    -   Source / likely cause: the current native protocol only reports graphics hook details for `d3d9` and `dxgi` in `libs/node-game-overlay/src/message/gmessage.hpp`. That covers D3D9 and DXGI-backed DirectX versions, but does not prove support for every graphics API or presentation path a game can use, such as Vulkan, OpenGL, D3D12-specific paths, unusual swap-chain modes, exclusive fullscreen behavior, multiple swap chains, protected/anti-cheat processes, elevated integrity processes, or game-specific render timing. Steam Overlay can appear universal because Steam owns the launcher/runtime integration, has broad backend support, and can carry a large compatibility database and per-game handling over time.
    -   Possible solution: expose graphics hook status in the SDK so unsupported or partially hooked games are visible to users, then expand the native runtime by backend and presentation mode: D3D12, Vulkan, OpenGL, flip-model swap chains, multiple swap chains, exclusive/borderless fullscreen cases, and explicit diagnostics for anti-cheat/elevation/bitness failures. Keep a compatibility matrix with API, presentation mode, hook result, and required workaround per game.

#### Origin overlay and Steam overlay

It can work together with Steam overlay, but unfortunately did not work with Origin overlay.

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
