# SDK API guide

This guide describes the public SDK through **0.1.0-rc.7**. It is intended for
application authors; the [release notes](#validation-and-release-notes) retain
version-specific implementation and acceptance evidence.

The host is Windows x64 with Electron `>=39.1.0 <40` or the exact tested
`46.0.0-alpha.2` prerelease. Game targets can be x64 or x86 using Direct3D
9/10/11/12. Other Electron 40+ versions, OpenGL, Vulkan, VR, anti-cheat and elevated
targets are not supported. The rc.7 tarball is a complete local candidate, not a
public npm release.

## Entry points and tool selection

| Import | Environment | Exports |
| --- | --- | --- |
| `electron-game-overlay` | Electron main process | Owner/session/window classes, launch configuration and attachment, managed target watcher, native process observer, process-policy helpers, errors and public types |
| `electron-game-overlay/packaging` | Node build configuration; no Electron runtime import | `createOverlayAfterPack`, `packageOverlayForElectronBuilder`, `verifyOverlayPackage` and their types |
| `electron-game-overlay/preload` | Node installer/setup code; no Electron runtime import | `registerOverlayAddonInstallation`, `unregisterOverlayAddonInstallation`, `defaultOverlayAddonStorageRoot` and their types |
| `electron-game-overlay/broker` | Node installer/setup code; no Electron runtime import | Optional `registerOverlayBrokerInstallation`, `unregisterOverlayBrokerInstallation`, `OverlayBrokerInstallationOptions` |

| Task | Tool |
| --- | --- |
| Validate native assets without synthetic CLI flags | `createReShadeLaunchConfig(options?)` |
| Parse a real opt-in command line | `parseReShadeLaunchConfig(argv, options?)` |
| Own windows, input and one producer session | `ElectronGameOverlay`, `OverlaySession`, `ElectronOverlayWindow` |
| Manage future targets and changing allow/deny rules | `OverlayTargetWatcher` |
| Validate/freeze a serializable native policy | `createOverlayProcessPolicy(policy)` |
| Evaluate that policy in application code | `overlayProcessPolicyAllows(policy, executablePath)` |
| Observe process creation/exit without injecting | `observeOverlayProcesses(options)` |
| Attach one manually discovered exact PID or native future selector | `ReShadeOverlayLauncher` |
| Resolve the SDK runtime or default writable run root | `defaultReShadeRuntimeDirectory()`, `defaultReShadeRunsRootDirectory()` |
| Recognize a structured attachment error | `ReShadeOperationError`, `isReShadeOperationError(error)` |
| Preserve the complete sealed SDK in electron-builder output | Packaging entry point |
| Make an installed broker discoverable before its app starts | Optional broker entry point |

Cursor mapping, raster validation, policy serialization, admission gates and
`quiesceUnselectedPolicyWatcher()` are SDK internals. Do not deep-import `dist/lib`
or call methods marked `@internal`; ordinary applications use the three entry
points above. The [public exports](../libs/electron-game-overlay/src/lib/sdk.ts)
and shipped `.d.ts` files are the exact signature reference.

## Managed application example

Install the complete candidate as a production dependency. Call
`app.disableHardwareAcceleration()` before Electron becomes ready. This example
uses application-chosen folder authorization; it starts no game itself.

```ts
// main.ts
import { app } from 'electron';
import path from 'node:path';
import {
  ElectronGameOverlay,
  OverlayTargetWatcher,
  createOverlayProcessPolicy,
  createReShadeLaunchConfig,
} from 'electron-game-overlay';

app.disableHardwareAcceleration();
const owner = new ElectronGameOverlay({ allowPrereleaseBroker: true });
const session = owner.createSession();
let targets: OverlayTargetWatcher | undefined;
let sessionStarted = false;

app.on('before-quit', () => {
  targets?.dispose();
  if (sessionStarted) session.input.release();
  session.close();
  owner.dispose();
});

void app.whenReady().then(async () => {
  const config = createReShadeLaunchConfig({
    runsRootDirectory: path.join(app.getPath('userData'), 'overlay-runs'),
  });
  session.start();
  sessionStarted = true;
  await session.whenReady();

  const panel = session.windows.create({
    id: 'chat',
    bounds: { x: 24, y: 48, width: 480, height: 280 },
    browserWindow: {
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  });
  await panel.browserWindow.loadURL(
    'data:text/html,' + encodeURIComponent('<input id="message" placeholder="Message">'),
  );
  await panel.browserWindow.webContents.executeJavaScript(
    "document.querySelector('#message').focus()",
  );
  panel.show();
  panel.focus();
  session.input.intercept();

  targets = new OverlayTargetWatcher(session, {
    config,
    earlyPolicy: createOverlayProcessPolicy({ allow: ['C:/Games/**'], deny: [] }),
    onEvent(event) {
      if (event.type === 'armed') console.log('Future watcher armed');
      if (event.type === 'connected') console.log('Authenticated PID', event.target.pid);
      if (event.type === 'discovery-blocked') {
        console.error('Future discovery unavailable:', event.error.message);
        // Keep any still-authorized live overlay and its input request.
      }
      if (event.type === 'error') console.error(event.error);
    },
  });
  await targets.ready;
  console.log('Initial discovery ready; the user may now launch the game.');
}).catch((error: unknown) => {
  console.error(error);
  app.quit();
});
```

`show()` publishes the offscreen surface; it does not display a desktop window.
`focus()` chooses the overlay window receiving routed keyboard input. Choosing a
DOM input is a separate application action, as demonstrated above. Interception
and focus do not authorize a target or make an unfocused game foreground.

The [managed example](../examples/managed-overlay) includes a noninjecting smoke,
exact-path targeting, explicit folder/deny CLI options and electron-builder setup.
The [basic example](../examples/basic-overlay) retains manual launcher usage.

## Configuration and lower-level attachment

`createReShadeLaunchConfig(options?)` synchronously validates both packaged native
architectures, their hashes, exact add-on identity and declared capabilities. It
starts no watcher, broker or injection. Options are:

| Option | Meaning |
| --- | --- |
| `bundledRuntimeDirectory` | Absolute directory of the complete staged native bundle; defaults to the SDK's physical runtime location, including ASAR-unpacked discovery |
| `runsRootDirectory` | Absolute writable parent for SDK-owned isolated launch directories; defaults to `defaultReShadeRunsRootDirectory()` |

`defaultReShadeRuntimeDirectory()` and `defaultReShadeRunsRootDirectory()` return
locations, not proof of an installed/healthy runtime. Use the config validator
before attaching. Never reconstruct manifests or set capability fields manually.

`parseReShadeLaunchConfig(process.argv, options?)` is for actual CLI applications.
It returns `undefined` unless `--reshade-overlay` was supplied and otherwise uses
the same validator. Do not invent CLI arguments for programmatic configuration.
The recognized CLI options are `--reshade-overlay`,
`--reshade-runtime-dir=<absolute-path>`, `--reshade-auto-target-process=<name.exe>`
and `--reshade-expected-target-pid=<positive-uint32>`. The PID hint requires the
auto-target process hint. Parsing creates configuration, not an attachment;
the application still chooses its target and calls the launcher/controller.

`new ReShadeOverlayLauncher(config)` owns one target lifetime:

| Member | Contract |
| --- | --- |
| `prepare(): Promise<void>` | Stage isolated assets before discovery; concurrent calls share the work; preparation alone does not inject |
| `attach(session, target)` | Resolve a `ReShadeAttachResult` after target authentication, or reject with attachment evidence |
| `onEvent(handler)` | Subscribe to immutable launcher events; returns an unsubscribe function |
| `state`, `hasRequestedInjection`, `runDirectory`, `config` | Read lifecycle state, whether the lifecycle is non-idle, last staged directory and validated configuration |
| `confirmTargetExited(pid)` | Accept authoritative OS exit evidence supplied by a low-level integrator; never call it because of timeout, cancellation or socket loss |
| `dispose()` | Stop owned work and release producer authorization; does not prove target exit or unload game DLLs |

`ReShadeTarget` accepts the following forms:

| Selector | Use and limits |
| --- | --- |
| `{processName, pid, executablePath}` | Exact process attachment; uses the shared multi-application broker route; newly observed processes can still initialize graphics too quickly |
| `{processName, executablePath?}` | Future-only native name/exact-path watcher; await `injector-watcher-ready` before launch; exclusive early lane |
| `{pathContains, processPolicy?, excludedProcessNames?}` | Future-only native path watcher; `pathContains` is a case-insensitive substring containing a separator, not a glob; optional native policy filters before mutation |

`target-selected` carries native PID, full image and decimal-string creation time.
`injector-watcher-ready` can include the native policy baseline. These are not
attachment/render success. `injector-returned` proves the injector result;
`attach()` additionally waits for authentication. Rendering is observed through
session diagnostics/surfaces. Use [the launcher event union](../libs/electron-game-overlay/src/lib/reshade-launcher.ts)
for the complete lifecycle, rendezvous, maintenance and failure events.

Existing official ReShade installations are preserved. The project-owned native
transaction helper may manage only the reserved EGO add-on and its verified
transaction files; a restart or incompatible-host diagnostic can require user
action. See [existing ReShade behavior](../README.md#existing-reshade-installations).

## Managed target watcher

`new OverlayTargetWatcher(session, options?)` owns process observation, native
watchers and launchers around an existing session. Start the session separately;
use one controller per session and avoid mixing unmanaged global authorization
with its admission policy.

| Constructor option | Meaning |
| --- | --- |
| `config` | Validated native configuration; otherwise created from SDK defaults |
| `earlyPolicy` | Native full-path allow/deny policy; evaluated before injection |
| `earlyTargets` | Explicit authorized name/exact-path or path selectors; no implicit executable-name expansion |
| `acceptBestEffort(identity)` | Optional synchronous application decision for other newly observed processes; uses exact-PID attachment after creation and can miss graphics startup |
| `onEvent(event)` | Lifecycle observer; callback exceptions do not alter controller state |
| `signal` | AbortSignal stopping this controller's work |

`OverlayTargetPolicy` contains `earlyPolicy`, `earlyTargets` and
`acceptBestEffort`. `update(policy)` replaces the complete policy, so omitting a
previous option removes it. Configuration, signal and event subscriptions are
controller-lifetime options, not update fields.

| Member | Contract |
| --- | --- |
| `ready: Promise<void>` | Initial session/observer baseline, requested staging and early watchers are ready; follows policy revisions received during startup; no game authentication/render guarantee |
| `targets` | Immutable `OverlayManagedTarget` attempt snapshots: PID, path, optional exact identity, mode, status and cancellation state |
| `onEvent(handler)` | Add an observer; return an unsubscribe function |
| `update(policy): Promise<void>` | Apply active authorization synchronously; settle serialized future discovery changes |
| `cancel(): Promise<void>` | Apply empty policy; retain uncertain injection reservations |
| `dispose()` | Stop this controller only; the app still owns session/owner/windows and input release |

Events are `ready`, `armed`, `attaching`, `connected`, `transport-lost`,
`cancelled`, `exited`, `error` and `discovery-blocked`. Target lifecycle events
carry a target snapshot; `exited` additionally carries authoritative OS identity;
`error`/`discovery-blocked` carry an Error and optional selector/target context.

An allowed live target keeps its launcher, scene, focus and input when discovery
rules change. For example, adding then removing `**/game.exe` while retaining an
authorizing folder rule does not cancel that target. A genuine deny cancels it
synchronously and stops its delivery. Deny always wins over callbacks.

Updates received while initial discovery is preparing supersede that work.
`ready` waits for the current policy's discovery, rather than rejecting because
an older slot was intentionally retired. Obsolete completions cannot emit a
controller `ready` or a discovery failure for the replacement. Genuine current
startup failures still reject readiness. Uncertain discovery remains blocked
without cancelling otherwise authorized active targets.

After initial readiness has settled, a later policy update has its own discovery
lifetime. A previously recorded `armed` or `ready` event does not establish that
the replacement is ready. Await the current update and observe its current
readiness/blockage events before launching a target; do not add delays or retry
an indeterminate injection.

An unused native watcher is replaced only after checked owned-child exit and
complete output-drain proof that it selected no target. Uncertain/selected attempts
remain reserved; they are never retried merely because a rule changed. A policy
successor excludes retained exact incarnations. A new replacement baseline can
miss processes created during reconfiguration; wait for readiness before launch.

A valid update can resolve while discovery is blocked: it applies authorization,
emits `discovery-blocked` and does not emit a new `ready`. Do not hide an allowed
overlay merely because future discovery could not be replaced. Invalid policies
still throw before application. A timeout, connection loss, cancellation or app
shutdown never implies a game exited or permits a second uncertain injection.

## Native process policy

`createOverlayProcessPolicy(policy)` validates, normalizes, deduplicates and freezes
an `OverlayProcessPolicy`. `overlayProcessPolicyAllows(policy, fullImagePath)`
evaluates the same grammar without starting native work. That JS evaluation alone
is not pre-injection authorization: pass the policy as `earlyPolicy` or a
low-level `ReShadePathTarget.processPolicy` for native filtering.

```js
const { createOverlayProcessPolicy, overlayProcessPolicyAllows } = require('electron-game-overlay');
const policy = createOverlayProcessPolicy({
  allow: ['**/steamapps/**'],
  deny: ['**/private/**'], // Explicit application policy; optional.
});
const allowed = overlayProcessPolicyAllows(policy, 'C:/Steam/steamapps/game.exe');
```

| Pattern feature | Meaning |
| --- | --- |
| Drive path (`C:/Games/**`), UNC path (`//server/share/**`), or `**/` prefix | Required starting form; relative/dot components are rejected |
| `/` or `\` | Path separators; literals use ASCII case folding, with Unicode preserved |
| `*`, `?` | Match within one component |
| Whole-component `**` | Match zero or more components, including hidden ones |
| `deny` | Overrides all allows and `acceptBestEffort` |

Braces, character classes, extglobs, negation, malformed UTF-16 and embedded
controls are rejected. Literal parentheses and spaces are supported. Limits are
1–256 combined normalized patterns with at least one allow, 4096 UTF-16 units and
128 components per pattern, and a 64 KiB public policy document. This is not a
general JavaScript glob engine. There are no implicit helper exclusions or
executable plausibility heuristics; exclude an image only as explicit application
policy. The Steam demo still considers every newly detected executable.

## Read-only process observation

`observeOverlayProcesses(options)` returns `{ready: Promise<void>, dispose()}`.
It observes future Windows processes through native retained handles and never
injects. Already-running processes are baselined. Options are `onCreated`, optional
`onExited`, `onError`, `signal`, `runtimeDirectory` and a `pathContains` substring
(default every full path). A custom runtime directory must be a complete validated
SDK bundle with explicit future-target capability.

```js
const { observeOverlayProcesses } = require('electron-game-overlay');
const observer = observeOverlayProcesses({
  pathContains: '\\steamapps\\',
  onCreated(identity) { console.log('Created', identity); },
  onExited(identity) { console.log('Exited', identity); },
  onError(error) { console.error('Observation stopped', error); },
});
observer.ready.then(() => console.log('Observer armed')).catch(console.error);
// Call observer.dispose() during application cleanup.
```

`OverlayProcessIdentity` is `{pid, executablePath, creationTime100ns}`; creation
time is an exact decimal string, not a JavaScript Number. Errors and disposal do
not fabricate exit events. Feed only authoritative same-incarnation evidence to
manual lifecycle handling. A JS observation callback does not guarantee that
subsequent injection beats graphics initialization.

## Window, input and scale helpers

`ElectronGameOverlay({allowPrereleaseBroker?})` is session-lazy; rc.7 needs explicit
preview-broker opt-in. `createSession()` permits one live session per owner.
`dispose()` closes the owner. `OverlaySession.start()` starts transport;
`whenReady()` waits for it. `on(name, handler)`, `onClose(handler)` and
`onQuit(handler)` return unsubscribe functions; `close()` releases the session.

`session.windows.create(options)` creates a hidden offscreen BrowserWindow;
`session.windows.attach(browserWindow, options?)` wraps an already-offscreen
caller-owned window. `get(id)` looks up a logical ID. Options include `id`, `name`,
`bounds`, `transparent`, `captionHeight`, `dragBorder`, `focusOnReady` and, for
created windows, `browserWindow`, `url` or `file`. URL takes precedence over file.
Destroying an SDK-created window closes its BrowserWindow; destroying an attached
wrapper leaves the caller's BrowserWindow alive.

`ElectronOverlayWindow` exposes `id`, `name`, `nativeId`, `browserWindow`, `visible`,
`captionHeight`, `dragBorder`, `transparent`, `onClose`, `show`, `hide`, `close`,
`destroy`, `focus`, `blur`, `setBounds`, `getBounds`, `followTarget` and
`stopFollowingTarget`. Public bounds use Electron DIP. Follow options select
optional `pid`, `surfaceId` and `area: 'render' | 'client'` (default render).
`session.targets.list()` and `get(pid, surfaceId)` return retained physical-pixel
surfaces; `targetSurfaceChanged`, `targetSurfaceRemoved` and `fps` report changes.

`session.input.intercept()` requests routed input; `release()` releases only this
session's request. Native acknowledgement is asynchronous. Mouse wheels and
common Chromium cursor shapes propagate automatically with capable runtimes;
custom bitmap/exotic cursors fall back to an arrow. There is no public cursor
mapping helper to call. New windows must not replay surviving windows' placement.

OSR bitmap scale is independent of display DPI on modern Electron. The SDK
preserves supplied offscreen options, reads genuine bitmap representations and
converts input/destination placement using display scale; it does not resample a
small frame and label it larger. Caller-owned windows retain their construction
settings; offscreen rendering must be enabled when constructing them. See
[wheel/cursor behavior](sdk-rc3-wheel-and-cursor.md) and
[fractional scaling](sdk-rc4-fractional-scaling.md).

## Structured errors and diagnostics

`isReShadeOperationError(error)` narrows to `ReShadeOperationError`. Inspect its
`code`, `stage`, `retrySafety`, optional `pid`/paths and `evidence` instead of parsing
console text. Evidence can point to owned injector output and native startup
records. Follow the [failure guide](../README.md#handle-failures-and-diagnostics).

`retrySafety: 'indeterminate'` retains possibly consumed ownership until proven
target exit. `definite-safe` is not permission to ignore lifecycle or target policy.
Authentication, graphics-surface readiness, producer frames and effective native
input acknowledgement are distinct observations. Session diagnostics are
structured `OverlayDiagnostic` events; use the public event/diagnostic unions for
fields. Never infer target exit from a lost transport.

## Electron-builder packaging

Import from `electron-game-overlay/packaging` in Node build code, not a renderer.
Keep the SDK as a production dependency. For Windows ASAR builds, use both the
unpack pattern and afterPack helper:

```js
// electron-builder.config.cjs
const { createOverlayAfterPack } = require('electron-game-overlay/packaging');
module.exports = {
  asar: true,
  asarUnpack: ['node_modules/electron-game-overlay/**/*'],
  afterPack: createOverlayAfterPack(),
};
```

| Function | Contract |
| --- | --- |
| `createOverlayAfterPack(options?)` | Return an async electron-builder hook; compose with your other hooks rather than replacing them accidentally |
| `packageOverlayForElectronBuilder(context, options?)` | Restore the complete SDK under the explicit Windows build output after dependency pruning/ASAR; return `OverlayPackagingResult`, or `undefined` for non-Windows output |
| `verifyOverlayPackage(packageRoot)` | Freshly validate sealed payloads and SDK/provider mirrors; return `{sealedPayloads}`; no broker execution, registration, caching or injection |

`OverlayAfterPackContext` needs absolute `appOutDir` and `electronPlatformName`.
`OverlayPackagingOptions.packageRoot` optionally identifies the installed source
package root (including a pnpm root symlink). `OverlayPackagingResult` reports
`packageDirectory`, copied `files` and `sealedPayloads`. The helper modifies only
the SDK under the selected build output and rejects escaping junctions/overlap;
it does not repair a running install or sign/publish the app.

The full distribution includes nested dependency notices, manifests and both
native architectures. Do not filter it down to DLLs or omit nested `node_modules`.
Default runtime discovery resolves the physical ASAR-unpacked package location.
Non-Windows cross-packaging and signing/update integration are not established
by the current Windows acceptance.

## Optional installed add-on preloading

`registerOverlayAddonInstallation({ applicationId, packageRoot?, storageRoot? })`
verifies and caches both architectures from a complete sealed preload-aware SDK.
It returns an immutable `OverlayAddonInstallation` identifying the application,
registration, native build and cached add-on paths. Repeated identical
registration is idempotent; multiple builds can coexist.

`createReShadeLaunchConfig({ addonPreload: { applicationId, storageRoot? } })`
selects this app's exact registered native build. Each new owned host snapshots
the current registered inventory. The private staged INI points to an external
folder; a foreign ReShade installation's configuration remains unchanged.
Offline applications' DLLs stay dormant until explicit session activation.

`unregisterOverlayAddonInstallation({ applicationId, registrationId?, storageRoot? })`
removes one registered build, or all builds for that application when its ID is
omitted. Removal affects future host snapshots; existing targets retain mapped
modules until target exit. `defaultOverlayAddonStorageRoot()` returns the
current account's registry/cache root. Normal startup needs no registration.
See [add-on preloading](addon-preloading.md) for setup, activation and lifetime
limits.

## Optional installed broker registration

Ordinary applications start without registration. Installer/setup code can use
`registerOverlayBrokerInstallation(options?): Promise<string>` to register a
validated cached standalone distribution. Persist its returned registration ID;
`unregisterOverlayBrokerInstallation(id, options?): Promise<void>` removes only
that catalog entry, without stopping a running broker or clearing live claims.

`OverlayBrokerInstallationOptions.distributionPath` optionally supplies an absolute
complete standalone distribution (default the SDK bundle); `allowPrerelease`
explicitly admits candidate versions. `storageRoot` is an internal test option.
Registration itself does not start a coordinator or prepare a target. Never run
registered code elevated. Cross-version election, ownership and recovery remain
specified in the [broker contract](multi-application-broker.md).

## Public types

The root entry exports owner options; created/attached/follow-window options;
`Rect` and `Disposable`; `OverlayProcessIdentity`/`OverlayProcessObserverOptions`;
`OverlayProcessPolicy`; `OverlayEarlyTarget`, `OverlayTargetPolicy`,
`OverlayManagedTarget`, `OverlayTargetWatcherEvent` and
`OverlayTargetWatcherOptions`; launcher target/config/result/state/event/error
families (`ReShade*`); and session event, diagnostic, target-surface, monitor, DPI,
size, rectangle, follow-area, FPS and graphics API families (`Overlay*`).
The packaging and broker entry points export the option/result types described
above. The [source API map](../README.md#api-map) links their declaration files;
no private broker/runtime data structures are required in consumer code.

## Validation and release notes

The [rc.7 notes](sdk-rc7-discovery-policy.md) record 745 passing SDK checks,
9 skips, mixed-version checks, native discovery controls, the standalone
basename-glob lifecycle case, complete package/ASAR verification and the real
Izabela consumer matrix. Historical [rc.5](sdk-rc5-managed-attachment.md),
[rc.6](sdk-rc6-process-policy.md) and [rc.7](sdk-rc7-discovery-policy.md) notes explain
migration and limitations; the contracts in this guide describe current behavior.

General fast-start attachment remains intermittent. Native `ready`/`armed` means
observation is available, not guaranteed pre-graphics injection. Exact-PID polling,
native future polling and successful no-barrier samples do not establish a
universal startup guarantee. The early lane is still exclusive across apps;
exact-PID broker attachment supplies the shared route. Compatible applications
retain one runtime owner and their negotiated optional behavior; later versions
do not replace a committed running runtime.
