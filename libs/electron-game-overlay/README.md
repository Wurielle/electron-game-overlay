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

The local generation-28 candidate retains an elevated consumer's token and
administrator preference. Its [private elevated lane](../../doc/elevated-consumers.md)
requires the same target user/session and a target no higher than its caller;
it does not scan shared registered add-ons in an elevated attachment. The
optional whole-consumer replacement API is separate and is never called by
overlay preparation.

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
- Anti-cheat remains unsupported. Elevated consumers use the bounded
  [same-user private lane](../../doc/elevated-consumers.md); they retain their
  administrator feature and saved preference.
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


## Runtime session storage

Ordinary runtime staging keeps a verified, read-only snapshot per payload content hash in
`<runsRootDirectory>.payloads-v2`. Packaged files are copied into that store once;
session host DLLs, tools and manifests are hard links to the snapshot. Source
package files are never hard linked. Every reuse checks ownership, canonical
paths, file hashes and both architecture manifests. Corrupt entries fail closed
and are never repaired over a possibly mapped image. A filesystem without hard
link support fails explicitly instead of reverting to full copies per launch.

Each attachment still needs private credentials, policy, configuration and logs.
Its add-on images also require private file identities: Windows coalesces two
hard-linked DLL paths into one module and shares their globals. The SDK therefore
copies those images and releases the verified private copies after the native
initial module-inspection refusal or an authoritative target-exit observation.
A socket disconnect or app restart cannot prove the images are unmapped. An exit
that arrives after disconnect still completes retirement while the launcher is
retained. Diagnostics remain available under the existing retention policy.
Policy cancellation preserves the selected stage/PID association before disposal
resets transport state, so a later matching authoritative exit still releases
the private images. Cancellation alone preserves them. Retirement marker writes
are serialized per run when cancellation and exit arrive back-to-back.

Proven retirement now removes all thirteen payload files from the run, including
ordinary hard-link entries. Only bounded diagnostics and ownership evidence
remain: 64 KiB per stdout/stderr/ReShade log, a 256-byte startup record, at most
16 diagnostic folders, seven days and 4 MiB. Unknown entries prevent whole-run
pruning. Live or indeterminate runs never expire through this policy.

Verified cache versions are collected when no stage aliases or preparation
leases remain. At most two unused verified versions are retained, in addition
to every referenced version. Collection quarantines and rechecks its candidate;
both interrupted collection and preparation/collection races are recoverable.
High stages preserve generation 28's private, single-link native verification
and bypass the redundant medium snapshot. Their transient copies are removed
after the same positive retirement proof.

`inspectReShadeRuntimeStorage` is read-only. Explicit
`pruneReShadeRuntimeStorage` can recover an old run only from an exact recorded
process incarnation and authoritative OS exit evidence, or existing positive
unmapping proof. A producer's exit proves an unattempted preparation unused;
it does not prove an attempted target exited. Unidentifiable legacy folders,
weak retirement markers and failed/denied queries remain preserved.
See [runtime storage](../../doc/runtime-storage.md) for the maintenance APIs,
legacy limitations, exact retention policy and offline allocation measurements.

The storage-only gate is
`libs/electron-game-overlay-runtime/scripts/test-cases/runtime-payload-storage.ps1`.
It uses retained real payload sizes without executing them, includes a separate
Node filesystem restart and checks that 32 retired preparations retain at most
16 diagnostic folders with no payload files. Allocation counts `stat.blocks *
512` once per file identity and excludes filesystem metadata. This gate does not
establish game/graphics or actual-high acceptance. SDK tests separately cover
A-B-A lifecycles, cancellation, late exact exit, corruption and version rollover.

An unused native V2 policy watcher can also retire its private images after its
complete checked output drain proves that no target was selected. A kill request
alone is insufficient. That bounded retirement finishes synchronously during
shutdown so an immediate Electron quit does not strand another pair of copies.

## Target failure isolation and recovery

Target errors carry their `target` or `selector`; consumers that stop their
backend for an unscoped `error` must preserve this distinction. Preparing the
successor of a selected native policy watcher can block future discovery without
cancelling the selected attachment. Duplicate creation notifications for the same
PID, creation time and executable are idempotent. Delayed exits and native results
for an older instance cannot retire a newer instance or stop the whole watcher.

An indeterminate injector or runtime-initialization failure retains that exact
live instance without retry. Its authoritative exit releases its reservation and
verified private images, including when the launcher is blocked or the exit
arrives inside the V2 selection callback before the legacy PID line. Tests cover
both failure-before-exit and exit-before-late-result ordering, PID reuse, an
independent successful target while an uncertain target remains live, and
successor preparation failures during startup.

Owned D3D11 recovery launchers:

- `libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-mixed-watcher-recovery.ps1`
  includes immediate virtual-key acceptance after focus/interception acknowledgement.
- `libs/electron-game-overlay-runtime/scripts/test-cases/d3d11-mixed-watcher-protocol-recovery.ps1`
  checks authenticated attachment and first transported scene without input or
  pixel acceptance.

These use the current SDK with the unmodified native generation-23 release
`v1.0.0-nightly.1`, an owned D3D11 target A and an inert owned target B. First place
the release archive `electron-game-overlay-1.0.0-nightly.1.tgz` in
`build/mixed-watcher-recovery/` and extract its
`package/dist/runtime/win32-x64/reshade` subtree under that directory's
`published/` cache. The launcher checks archive SHA-256
`437526E5DA73130E995AABC2E9C890DAB0CAA6F110016CD409483765DFF12871`
and SDK configuration verifies the extracted manifests and payload hashes.

The 2026-11-09 protocol capture passed A → suspended B (preflight 299) → new A →
console B (indeterminate runtime-initialization timeout) → new A in one app and
watcher, then A in a fresh app using the same writable roots. Every B exited
through its owner's retained process handle before the next sequential A. The
capture retained one verified payload build and zero private add-on images after
both app shutdowns; its local report is
`build/mixed-watcher-recovery/20261109-183630-1e82caa6.report.json`.
The visual gate stopped before target startup because the display reported off,
so neither first-key nor pixel acceptance was established. These controlled
results do not diagnose another machine's failure after app restart: in-memory
watcher state cannot persist across a fresh app process. No user game was run.

The subsequent generation-25 candidate addresses a separate broad-policy lane
exhaustion. A generation-24 native watcher could match a short-lived or
access-refused process and terminate before emitting its V2 identity. Without
that identity the SDK could not safely exclude the refused instance and arm a
successor. Generation 25 emits V2 selection from the retained read-only handle
before the full-access open. Full-handle path and creation-time validation still
precede every mutation; V2 is selection evidence, not injection success. A live
refused instance stays reserved without retry while a successor discovers other
authorized targets. A legacy/unidentified terminal failure now also emits
`discovery-blocked`, rather than silently leaving discovery unavailable.

Owned headless gates reproduce the missing V2 with the original generation-24
injector and validate generation 25 against a process DACL that permits limited
identity queries but refuses injection access. Separate compiled production
entrypoint cases cover live denial and exit before the full open on x64 and x86.
SDK mixed regressions include this unrelated refused target alongside an
indeterminate B and a fresh successful A, including out-of-order exits. See the
[fixture protocol](../electron-game-overlay-runtime/tests/unopened-target-selection/README.md)
and the `owned-target-access-refusal.ps1` and
`unopened-target-selection-console.ps1` launchers under runtime `scripts/test-cases`.

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
owned ReShade host scan a stable shared folder, normally
`%LOCALAPPDATA%\ReShade\Addons`. Apps register their dormant add-ons once and
activate their own private engines when they connect. Other libraries can place
ordinary ReShade add-ons in that same folder. Use `addonDirectory` in installer
and launcher options to select another location. Registration and removal affect
future host scans; existing ReShade
installations retain their own configuration.
Wait for `ready`/`armed` before a future launch. These events do not guarantee
pre-graphics injection. The [managed example](https://github.com/Wurielle/electron-game-overlay/tree/dev/examples/managed-overlay)
shows normal ownership and packaging; private deep imports are not required.
