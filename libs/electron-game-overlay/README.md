# Electron Game Overlay SDK

Render Electron HTML/CSS interfaces inside Windows Direct3D games. Use this
package from Electron's **main process**. Electron renders offscreen windows in
your application; a per-user broker shares one target runtime across independent
applications and routes each application's frames and input separately.

Mouse wheels and common Chromium cursor shapes are routed automatically while
interception is active. rc.3 fixes pointer-wheel delivery and adds negotiated
cursor propagation; see the [wheel/cursor validation and limits](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc3-wheel-and-cursor.md).
Custom bitmap cursors currently fall back to the system arrow.

rc.4 separates Electron offscreen raster scale from display DPI, including
Electron 46 default and explicit offscreen scales. Genuine bitmap dimensions
and input coordinates retain strict validation; see the
[fractional-scaling contract and validation](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc4-fractional-scaling.md).

## Candidate installation

The distribution candidate is `electron-game-overlay-0.1.0-rc.7.tgz`, supplied as
a build artifact, **not a public npm release**. In your own application directory:

```powershell
npm install --save-exact electron@39.8.10 "C:\downloads\electron-game-overlay-0.1.0-rc.7.tgz"
```

The tarball includes compiled JavaScript/declarations and the packaged Windows
runtime/broker assets. Consumers do not need Nx, the source workspace, TypeScript,
or a native compiler. A first install still needs npm/Electron downloads or a
populated cache. Keep the complete installed package; do not copy individual
runtime files or replace build stamps/manifests.

The normal Electron range is `>=39.1.0 <40`; the exact experimental runtime
`46.0.0-alpha.2` is also admitted after controlled Windows native acceptance.
For native keyboard focus, exact-path prearming, watcher deadlines, public process
observation, and compatibility limits, read the
[rc.2 attachment guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc2-attachment-and-focus.md).
Use `new ElectronGameOverlay({ allowPrereleaseBroker: true })` with this candidate.

## Run the minimal consumer

Copy [`examples/basic-overlay`](https://github.com/Wurielle/electron-game-overlay/tree/feat/sdk-release-candidate/examples/basic-overlay)
from the matching candidate source checkout into a directory outside that checkout.
Its README gives local-tarball installation and verification instructions.

```powershell
npm install --save-exact "C:\downloads\electron-game-overlay-0.1.0-rc.7.tgz"
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
- Electron `>=39.1.0 <40`; example pinned to `39.8.10`. The exact
  `46.0.0-alpha.2` prerelease is also accepted and tested; this does not imply
  support for other Electron 46 versions.
- Direct3D 9/10/11/12, not OpenGL, Vulkan or VR.
- Anti-cheat and elevated targets are unsupported. Do not elevate the consumer,
  disable antivirus, or create security exceptions to make attachment work.
- Candidate installation, type checking and noninjecting smoke do not establish
  Windows native/game acceptance. Review the matching build's verification record.

License: GPL-3.0-only; see the included `LICENSE`.


## Managed attachment and packaging

rc.5 adds direct createReShadeLaunchConfig(), OverlayTargetWatcher and the
Node-only electron-game-overlay/packaging helpers. Applications keep their policy,
UI and DOM focus; the controller owns future observation and launcher lifetimes.
See the [rc.5 API and migration guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc5-managed-attachment.md)
and [minimal managed consumer](https://github.com/Wurielle/electron-game-overlay/tree/feat/sdk-release-candidate/examples/managed-overlay).
Early selectors must be fully authorized before creation. A best-effort JS
predicate cannot guarantee early injection. Keep complete sealed assets on the
physical filesystem using the SDK afterPack helper and ASAR unpack pattern.

Current process-policy behavior and fast-start limitations: [rc.6 guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc6-process-policy.md).

The basename-glob update fix and discovery readiness contract are documented in [rc.7](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc7-discovery-policy.md).
