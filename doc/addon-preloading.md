# Shared ReShade add-on directory

Applications can register their EGO add-ons during installation. When an
application opts in while creating a new injected ReShade host, that host scans
one stable shared add-on directory before graphics startup. Registered applications can be
offline: their DLLs remain dormant until those applications attach.

Registration is optional. Ordinary unregistered attachment continues to work.
This feature uses stock ReShade's external `AddonPath`; it installs no files in
the game's directory and does not require a ReShade fork.

## Installation and removal

Use the Node-only installer entrypoint. It does not require Electron or start a
broker, game, overlay session or native runtime.

```ts
import {
  registerOverlayAddonInstallation,
  unregisterOverlayAddonInstallation,
} from 'electron-game-overlay/preload';

const installation = await registerOverlayAddonInstallation({
  applicationId: 'com.example.my-app',
  // Optional: addonDirectory: 'D:\\Shared\\ReShade\\Addons',
});

// During removal, or after replacing this particular installed build:
await unregisterOverlayAddonInstallation({
  applicationId: installation.applicationId,
  registrationId: installation.registrationId,
});
```

Use a stable application identity. Repeating the same application/build
registration is idempotent. Different builds can coexist while independently
installed applications upgrade. Omitting `registrationId` during removal
unregisters all builds belonging to that application identity.

The default directory is `<account profile>\AppData\Local\ReShade\Addons`
(normally `%LOCALAPPDATA%\ReShade\Addons`). This is this SDK's shared convention,
not an official global ReShade location. `defaultReShadeAddonDirectory()` returns
it without creating it. `addonDirectory` selects another absolute directory;
installation and runtime must use the same value. `storageRoot` is a deprecated
alias for `addonDirectory`; supplying both is an error. `packageRoot` lets an installer register a separately installed,
sealed SDK package. For packaged Electron apps, use the existing
`createOverlayAfterPack()` helper and complete SDK ASAR unpack pattern so the
sealed package is available on the physical filesystem.

Only packages declaring the supported preload protocol can be registered.
Registration verifies the sealed package and both native architectures. The
installed copies survive an application being offline or its original install
directory being moved. Each app/build has deterministic, distinct `.addon64`
and `.addon32` files directly in the shared directory. Registration publishes
each complete file once and never overwrites an existing payload. Repeated
registration and game launches reuse the same paths and files: there are no
per-run add-on copies or moving add-on directories.

The SDK catalog lives under `.electron-game-overlay` inside that directory.
Other libraries can install ordinary ReShade `.addon`, `.addon64` and `.addon32`
files alongside EGO's files without using this catalog or this SDK. Their files
are neither rewritten nor removed by EGO. ReShade scans only the top level and
loads extensions matching the target architecture; it does not scan subfolders.
Third-party add-ons control their own initialization and offline behavior.

Unregistering removes an app/build from the catalog. Immutable DLLs remain in
place because a game may still have them mapped. Future EGO-created hosts add
retired EGO filenames to their private `DisabledAddons` list. Existing games
retain their loaded modules safely until exit. The `ego-preload-` filename
namespace is reserved for EGO; other libraries should use their own names.

## Enabling a host

```ts
import { createReShadeLaunchConfig, ReShadeOverlayLauncher } from 'electron-game-overlay';

const launcher = new ReShadeOverlayLauncher(createReShadeLaunchConfig({
  addonPreload: { applicationId: 'com.example.my-app' },
}));

// Use the launcher with the application's ordinary session and target API.
```

Create this configuration after registration. It validates the calling app's
exact native payload. Each new host reads the current registered inventory,
including installations or removals made while the supplying app was running.
Generation 44 sends the shared `AddonPath` and retired-filename disable list in
the in-memory startup configuration for managed ordinary attachment. The
registered files stay in the shared directory and the version cache retains its
sealed template. The route is private and memory-backed. Explicit logging uses
the logs-only directory. Earlier runtimes provide the same configuration through
their private staged INI.

Generation 23 permits the stable shared directory while retaining native
validation of the owned host, canonical paths, reparse-point rejection and the
calling app's exact payload hash. The directory may contain unrelated add-ons;
those are ordinary ReShade modules, not sealed EGO payloads. A failed unrelated
add-on initialization does not by itself invalidate a ready EGO adapter.

The extended Windows path spelling is used for scanning and selected DLL loads,
so long registered filenames do not require the target to opt into long paths.
This retains the [RC.10 long-path correction](sdk-rc10-preload-long-path.md).

Generation 21 also corrects the owned host's callback-readiness enumeration.
Toolhelp can fail when a loaded module has a long path, despite the DLL loading
successfully. The host now enumerates module handles, then retains and checks
each candidate's ABI and actual callback-ready word. See the
[RC.11 validation boundary](sdk-rc11-preload-activation.md).

The first app creating an owned host supplies that host's shared directory. Later apps
reuse the existing ReShade runtime; they cannot change its startup scan or
replace its host. An existing user-managed ReShade installation keeps its
configuration unchanged. Registration alone cannot make an already initialized
ReShade rescan a directory.

Other libraries benefit from startup loading when they install their add-ons in
this directory before the first cooperating app initializes ReShade. They do
not need to inject another ReShade themselves. A host started by unrelated
software uses that software's configured path. Normal ReShade add-on name/API
compatibility requirements still apply.

The supported startup path uses the bundled owned host. If a user manually
configures a stock host to scan only dormant EGO modules, older injectors that
wait for an active member may need a current app to activate first. This manual
stock-host arrangement is separate from the owned-host compatibility path.

For early loading, attach before graphics initialization. The ordinary limits
of late attachment still apply, including unsupported generic late D3D12 queue
recovery. Preloading does not inject ReShade into games by itself.

## Activation and lifetime

Preloaded DLLs register unique ReShade identities. The baseline adapter can
forward events while its own application is offline. A dormant add-on has no
private participant, transport connection, windows or frame worker.

When an app attaches, its injector locates the exact registered module, checks
its identity, and binds it to that session's private authenticated transport.
Another application's add-on cannot satisfy this selection. Rendering, input,
focus and window ownership remain per application.

A module binds to one session for its lifetime. Restarting an app or replacing
its session uses a fresh private add-on if the preloaded module was already
consumed. Registering after the host's scan also uses ordinary private loading.
An uncertain activation failure is an error; it does not authorize duplicate
activation. App exit never authorizes another ReShade injection.

ReShade add-on disablement is respected, including the registered filename and
unique display name. Disabling a registered add-on cannot be bypassed through
the ordinary loading fallback. Registered per-user code is not injected into
elevated targets.

Generation 27 preserves that shared-preload restriction while supporting an
elevated consumer through its [private elevated lane](elevated-consumers.md).
It keeps the app elevated, leaves registration unchanged, and uses only the
calling app's own sealed engine with `AddonPath=.`. Generation 43 provides
that engine through the protected cache for managed attachment. A high
same-user target may use the private engine. Shared registration is used by
the ordinary lane.
