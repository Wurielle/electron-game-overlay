# Optional installed add-on preloading

Applications can register their EGO add-ons during installation. When an
application opts in while creating a new injected ReShade host, that host scans
the registered add-ons before graphics startup. Registered applications can be
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

The default registry and immutable native payload cache belong to the current
Windows account, outside game directories. `storageRoot` selects a separate
absolute registry directory when needed; installation and runtime must use the
same value. `packageRoot` lets an installer register a separately installed,
sealed SDK package. For packaged Electron apps, use the existing
`createOverlayAfterPack()` helper and complete SDK ASAR unpack pattern so the
sealed package is available on the physical filesystem.

Only packages declaring the supported preload protocol can be registered.
Registration verifies the sealed package and both native architectures. The
cache survives an application being offline or its original install directory
being moved. Removing registration changes future host snapshots; existing
games retain their already loaded modules safely until they exit.

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
Each private staging directory gets its own flat snapshot and an absolute
`AddonPath` in its own copied INI. Packaged templates remain unchanged.

The first app creating an owned host supplies that host's snapshot. Later apps
reuse the existing ReShade runtime; they cannot change its startup scan or
replace its host. An existing user-managed ReShade installation keeps its
configuration unchanged. Registration alone cannot make an already initialized
ReShade rescan a directory.

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
