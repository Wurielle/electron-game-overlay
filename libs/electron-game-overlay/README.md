# Electron Game Overlay SDK

Render Electron HTML/CSS interfaces inside Windows Direct3D games. Use this
package from Electron's **main process**. Electron renders offscreen windows in
your application. Each application/version owns an authenticated private
transport and native overlay engine inside the target. Compatible engines share
one ReShade host and a small cooperative protocol for window order, focus,
capture and interception. Normal SDK startup does not run a broker service or
select one application's engine for everyone else.

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
a build artifact, **not a public npm release**. Use an artifact built from the
matching cooperative-implementation source revision; older rc.7 artifacts can
contain the historical broker implementation. In your own application directory:

```powershell
npm install --save-exact electron@39.8.10 "C:\downloads\electron-game-overlay-0.1.0-rc.7.tgz"
```

The tarball includes compiled JavaScript/declarations and the packaged Windows
native assets and its sealed JavaScript dependency. Consumers do not need Nx,
the source workspace, TypeScript, or a native compiler. A first install still needs npm/Electron downloads or a
populated cache. Keep the complete installed package; do not copy individual
runtime files or replace build stamps/manifests.

The normal Electron range is `>=39.1.0 <40`; the exact experimental runtime
`46.0.0-alpha.2` is also admitted after controlled Windows native acceptance.
For native keyboard focus, exact-path prearming, watcher deadlines, public process
observation, and compatibility limits, read the
[rc.2 attachment guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc2-attachment-and-focus.md).
Use `new ElectronGameOverlay()` with the cooperative candidate. The retained
`allowPrereleaseBroker` option does not affect this default implementation.

## Run the minimal consumer

Copy [`examples/basic-overlay`](https://github.com/Wurielle/electron-game-overlay/tree/feat/sdk-release-candidate/examples/basic-overlay)
from the matching candidate source checkout into a directory outside that checkout.
Its README gives local-tarball installation and verification instructions.

```powershell
npm install --save-exact "C:\downloads\electron-game-overlay-0.1.0-rc.7.tgz"
npm start -- --smoke
```

Smoke mode opens and verifies a real Electron page and constructs an unstarted
SDK session. It performs **no native attachment** and is not a
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
`electron-game-overlay` (Electron main), `electron-game-overlay/packaging` (Node
build configuration). `electron-game-overlay/broker` retains historical broker
installer operations; normal cooperative apps do not use its registration or
start a broker.

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

## Independent applications and the shared host

Applications can ship different compatible SDK/native engine versions without
coordinated upgrades. Each owns its frames, scene/GPU resources and input
implementation. App-local window IDs can overlap, windows from different apps
can interleave in global order, and input/focus returns only to the owning app.
Interception is the OR of participating requests; another app's exit or crash
removes its own state while survivors keep working.

ReShade itself is a common dependency. The first eligible initialization
supplies the host when none exists; later apps load their own engines into that
host. They do not replace it because their preferred ReShade version is newer.
The baseline callback module remains mapped until target exit, including after
its supplying app stops. Shared coordination uses versioned, fixed-layout POD
and owned callback/handle boundaries. Native modules still share the game's
address space; this is not native crash containment.

The injector validates the exact target image and creation identity and retains
possibly consumed host ownership until authoritative process exit. A timeout,
lost connection or app shutdown is not permission to inject a second ReShade.
Use exact PID/path attachment when your process watcher knows that identity.

For clean targets, project runtime files are staged outside the game directory.
An existing supported x64 official ReShade installation is preserved: its
runtime, INI, presets, effects and foreign add-ons are not replaced. Only the
native transaction helper may maintain reserved EGO add-on files; installation
or update can require a game restart. An incompatible installation fails closed.

## Required input capabilities

An application can require specific copied-input routes before a target receives
its scene or interception request:

```ts
const overlay = new ElectronGameOverlay({
  requiredInputCapabilities: ['copied-raw-input-buffer'],
});
const session = overlay.createSession();
session.on('targetInputCapabilitiesRejected', ({ pid, inputCapabilities }) => {
  console.error('Required input route unavailable', pid, inputCapabilities);
});
session.on('targetConnected', ({ pid }) => {
  console.log(session.targets.inputCapabilities(pid));
});
```

Requirements accept `copied-wm-input` and `copied-raw-input-buffer` and are copied
and frozen when the owner is constructed. The read API returns an immutable
`{ copiedWmInput, copiedRawInputBuffer }` snapshot with `supported`, `unsupported`
or `unknown` values, or `null` before a credential-verified observation.
`targetConnected` also exposes optional capabilities and input-capability data.
Missing optional capability metadata means `unknown`; with no requirements,
legacy targets remain accepted.

Unknown or unsupported required features reject only this application's route
before authentication, frames or interception are sent. The typed rejection event
accompanies diagnostic `target-input-capability-unsupported`; a matching attachment
rejects with that `ReShadeOperationError` code and `indeterminate` retry safety.
Retain possibly consumed host ownership and do not retry the live PID.

Stock official ReShade supports the copied `WM_INPUT` route but does not support
copied `GetRawInputBuffer` delivery. The bundled patched host advertises buffered
support only after its private observer ABI is verified. These capabilities cover
those copied-input routes, not every possible input pump. Optional wire tokens
are `input-capabilities-v1`, `copied-wm-input-v1` and
`copied-raw-input-buffer-v1`; they add no mandatory handshake or version equality.


## Managed attachment and packaging

rc.5 adds direct createReShadeLaunchConfig(), OverlayTargetWatcher and the
Node-only electron-game-overlay/packaging helpers. Applications keep their policy,
UI and DOM focus; the controller owns future observation and launcher lifetimes.
See the [rc.5 API and migration guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc5-managed-attachment.md)
and [minimal managed consumer](https://github.com/Wurielle/electron-game-overlay/tree/feat/sdk-release-candidate/examples/managed-overlay).
Early selectors must be fully authorized before creation. A best-effort JS
predicate cannot guarantee early injection. Keep complete sealed assets on the
physical filesystem using the SDK afterPack helper and ASAR unpack pattern.
Keep the SDK external in your main-process bundle and retain the complete sealed
`dist`, including both native architectures and its nested dependency. Normal
cooperative packaging needs no standalone broker executable or catalog
registration, and no separate Node.js runtime for the overlay SDK.

Current process-policy behavior and fast-start limitations: [rc.6 guide](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc6-process-policy.md).

The basename-glob update fix and discovery readiness contract are documented in [rc.7](https://github.com/Wurielle/electron-game-overlay/blob/feat/sdk-release-candidate/doc/sdk-rc7-discovery-policy.md).


## Public helper reference

The [complete SDK API guide](https://github.com/Wurielle/electron-game-overlay/blob/dev/doc/sdk-api.md)
documents every public entry point, options, results, events, cleanup and public
types. Current application helpers include:

| Task | Public helper |
| --- | --- |
| Configure directly | `createReShadeLaunchConfig()`; use `parseReShadeLaunchConfig()` only for real CLI flags |
| Manage changing target policy | `OverlayTargetWatcher` with `earlyPolicy`, `earlyTargets` or `acceptBestEffort` |
| Validate/evaluate native rules | `createOverlayProcessPolicy()`, `overlayProcessPolicyAllows()` |
| Observe without injection | `observeOverlayProcesses()` |
| Package with electron-builder | `/packaging`: `createOverlayAfterPack()`, `packageOverlayForElectronBuilder()`, `verifyOverlayPackage()` |
| Preload installed app add-ons | `/preload`: `registerOverlayAddonInstallation()`, `unregisterOverlayAddonInstallation()`; opt in through `createReShadeLaunchConfig({ addonPreload: { applicationId } })` |
| Historical broker installer registration | `/broker`: `registerOverlayBrokerInstallation()`, `unregisterOverlayBrokerInstallation()`; unused by cooperative startup |

A resolved watcher update applies current authorization; `discovery-blocked`
reports unavailable future discovery without cancelling an allowed active target.

Optional [installed add-on preloading](../../doc/addon-preloading.md) lets a new
owned ReShade host load registered applications' dormant add-ons through an
external folder. Each app activates its own private engine when it connects.
Registration and removal affect future host snapshots; existing ReShade
installations retain their own configuration.
Wait for `ready`/`armed` before a future launch. These events do not guarantee
pre-graphics injection. The [managed example](https://github.com/Wurielle/electron-game-overlay/tree/dev/examples/managed-overlay)
shows normal ownership and packaging; private deep imports are not required.
