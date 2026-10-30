# Electron Game Overlay SDK

Render Electron HTML/CSS interfaces inside Windows Direct3D games. Use this
package from Electron's **main process**. Electron renders offscreen windows in
your application; a per-user broker shares one target runtime across independent
applications and routes each application's frames and input separately.

## Candidate installation

The distribution candidate is `electron-game-overlay-0.1.0-rc.1.tgz`, supplied as
a build artifact, **not a public npm release**. In your own application directory:

```powershell
npm install --save-exact electron@39.8.10 "C:\downloads\electron-game-overlay-0.1.0-rc.1.tgz"
```

The tarball includes compiled JavaScript/declarations and the packaged Windows
runtime/broker assets. Consumers do not need Nx, the source workspace, TypeScript,
or a native compiler. A first install still needs npm/Electron downloads or a
populated cache. Keep the complete installed package; do not copy individual
runtime files or replace build stamps/manifests.

## Run the minimal consumer

Copy [`examples/basic-overlay`](https://github.com/Wurielle/electron-game-overlay/tree/feat/sdk-release-candidate/examples/basic-overlay)
from the matching candidate source checkout into a directory outside that checkout.
Its README gives local-tarball installation and verification instructions.

```powershell
npm install --save-exact "C:\downloads\electron-game-overlay-0.1.0-rc.1.tgz"
npm start -- --smoke
```

Smoke mode opens and verifies a real Electron page and constructs an unstarted
SDK session. It performs **no broker startup or native attachment** and is not a
game-rendering test. On Windows, keep your supported game closed and run:

```powershell
npm start -- --target-process=game.exe --reshade-overlay
```

Wait for `Injector watcher ready`, then launch the game. The example passes
`{ processName: 'game.exe' }` to `ReShadeOverlayLauncher.attach`; this name watcher
observes newly created targets, not existing game processes. The native runtime
must attach before graphics initialization. `--reshade-overlay` is an explicit,
existing opt-in consumed by `parseReShadeLaunchConfig(process.argv)`; configuration
parsing validates bundled runtime paths/manifests and does not itself attach.

The consumer owns `ElectronGameOverlay`, its session and launcher. Start the
session, create windows through `session.windows.create`, then attach. On quit or
failure dispose the launcher, close the session and dispose the owner. See the
[full API guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/README.md#application-setup)
for window, input, targeting and lifecycle contracts. Public entry points are
`electron-game-overlay` and `electron-game-overlay/broker`; ordinary overlay apps
do not need to create a broker themselves.

## Supported boundary

- Windows 10+ x64 host; x64 and x86 game targets.
- Electron `>=39.1.0 <40`; example pinned to `39.8.10`.
- Direct3D 9/10/11/12, not OpenGL, Vulkan or VR.
- Anti-cheat and elevated targets are unsupported. Do not elevate the consumer,
  disable antivirus, or create security exceptions to make attachment work.
- Candidate installation, type checking and noninjecting smoke do not establish
  Windows native/game acceptance. Review the matching build's verification record.

License: GPL-3.0-only; see the included `LICENSE`.
