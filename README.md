# Electron game overlay

This repository renders Electron offscreen windows inside Windows games through
a maintained ReShade + Dear ImGui host. The active stack supports controlled
D3D9, D3D10, D3D11, and D3D12 targets on Windows x64 plus controlled D3D9 and
D3D10 targets on Windows x86, ordered multi-window composition, focus and
capture, caption dragging, and an interception mode that routes input to
Electron while ReShade blocks the corresponding game input.

## Production packages

- [`libs/electron-game-overlay`](libs/electron-game-overlay/README.md) is the
  public TypeScript SDK. It owns Electron window registration, offscreen frame
  publication, input return, session state, target attachment, and runtime
  staging.
- [`libs/electron-overlay-transport`](libs/electron-overlay-transport/README.md)
  is the backend-neutral Rust transport,
  frame-processing, ordered scene, and input-routing engine. It exposes a
  versioned C ABI to the injected runtime.
- [`libs/electron-game-overlay-runtime`](libs/electron-game-overlay-runtime/README.md)
  is the Windows injected host. It builds pinned patched x64 and x86 ReShade
  runtimes, injectors, native target-local ReShade add-on managers,
  `.addon64`/`.addon32` payloads, controlled hosts, and human-facing acceptance
  launchers.
- [`apps/client`](apps/client/README.md) is an SDK demo and acceptance client. It
  is not a second overlay implementation.

The old native binary package and Node native add-on have been removed. The
current SDK transport uses Node's maintained networking APIs and does not load a
native Node add-on.

## Build

Install the JavaScript dependencies, then build the workspace:

```powershell
npm install
npm run build
```

On Windows x64, the SDK build compiles x64 and x86 production transport and
injected-runtime payloads, then composes the immutable runtime assets under:

```text
libs/electron-game-overlay/dist/runtime/win32-x64/reshade
```

The composite contains architecture-specific injectors, runtimes, add-ons,
managers, build stamps, and strict schema-2 package manifests. The SDK validates
both manifests against every mapped payload before making a private per-run
copy, then validates that isolated copy again before injection. The x64 native
transaction helper is used for a verified existing official installation;
official x86 coexistence remains fail-closed. Native builds require Rust, CMake,
Git, and Visual Studio 2022 with the Desktop development with C++ workload.
Install Rust through rustup with both supported MSVC targets:

```powershell
rustup target add --toolchain stable x86_64-pc-windows-msvc i686-pc-windows-msvc
```

A clean target uses the repository's bundled, patched ReShade 6.7.3 host. When
preflight detects any target-local x64 ReShade identity, that installation
suppresses fallback project-runtime injection and is attempted as the public
host for the uniquely named Electron add-on. There is no product-version or
runtime-hash allowlist. Compatibility is established only when the loaded
add-on can call `ReShadeRegisterAddon` with public API 18 and obtain the exact
Dear ImGui function table it was built against; the private input observer is
  negotiated only with the repository's patched host. If a current add-on has
  not loaded yet, the SDK gives the host one bounded, inspection-only startup
  grace. A host that remains mapped without loading it is reported as
  host-incompatible; a host that disappears during the wait reports
  `target-official-addon-wait-expired`. Neither outcome can fall back to
  injecting the project runtime.

The launcher resolves the ReShade base path, add-on path, and `DisabledAddons`
state from the exact target process and its configuration. It never replaces or
rewrites the existing runtime/proxy, INI, presets, effects, or foreign add-ons.
Only the native transaction helper may mutate the project's reserved add-on,
marker, journal, and verified temporary/backup files. The runtime hash pins the
exact inspected file through request verification, TOCTOU protection, and
transaction recovery; it is not a compatibility decision. The ReShade hash in
the ownership marker is provenance and is ignored for compatibility. Installing
or updating the project-owned add-on requires a target restart; if the old
add-on is mapped, maintenance is deferred until that exact target's exit is
confirmed. A ReShade upgrade or other runtime-identity change does not
automatically remove the owned add-on. Applicable global Vulkan/OpenXR ReShade
layers are likewise preserved and block fallback injection.

The native projects can also be addressed directly through Nx:

```powershell
npx nx build electron-overlay-transport
npx nx build electron-game-overlay-runtime
npx nx build electron-game-overlay
```

## Run the demo

Start the Electron client with:

```powershell
npm run dev
```

This demo command watches process creation and starts an independent exact-PID
SDK injection for every detected executable whose normalized path contains
`/steamapps/`. Start the demo first, let its overlay session and watcher come
up, and then launch the game. The client does not guess which executable owns
rendering: bootstrap launchers, child renderers, helpers, and redistributables
all receive one attempt. Whatever process initializes the overlay authenticates
and renders without blocking later candidates. ReShade selects the target's
supported Direct3D API inside each process, so application code does not choose
a graphics payload.
Press **Ctrl+I** while a game is focused to toggle interception.

The normal demo starts with one compact in-game information dock. It shows the
shortcut, attachment, interception, injected graphics API/render resolution,
and real render-process frame-rate state without opening all of the test windows
at once. Enabling interception expands that same dock into a clickable menu for
opening the target-following input playground, diagnostics strip, transparent
popup, and video surface. The main playground uses the public `followTarget()`
API and fills the reported game render surface. Releasing interception
collapses the dock again.

Applications can inspect the same retained target state or follow it directly:

```ts
session.on('targetSurfaceChanged', (surface) => {
  console.log(surface.graphicsApi, surface.renderSize);
});
session.on('fps', ({ pid, fps }) => console.log(pid, fps));
session.on('diagnostic', (diagnostic) => {
  console.log(diagnostic.source, diagnostic.code, diagnostic.pid);
});

overlayWindow.followTarget({ area: 'render' });
```

The demo's native Steam-path observer supplies each exact PID, executable
basename, and canonical executable path; WMI is started only if that observer
fails. The trusted path lets the SDK identify an adjacent target-local ReShade
installation without guessing. Observation starts before
the demo concurrently prepares a pool of four isolated SDK launchers. Creation
events wait in order for prepared slots, and every successful consumption starts
replacement preparation immediately. Preparation failures use bounded retry
backoff instead of moving runtime staging onto a detected target's hot path.
Native notification and injector startup still happen after ordinary
unsuspended process creation, rather than through a `CREATE_SUSPENDED` launcher.
Independent launchers remove the one-shot gap for overlapping and
launcher/child process chains, but the controlled acceptance launchers remain
the deterministic injection-before-device-creation proof through a cooperating
pre-device startup barrier.

The demo uses the SDK's exact-PID target:

```ts
await launcher.attach(session, {
  processName: detectedProcess.processName,
  pid: detectedProcess.pid,
  executablePath: detectedProcess.filepath,
});
```

Each detected PID receives a separate launcher, staged runtime, proof window,
and cleanup lifecycle. The SDK's one-shot `pathContains` target remains
available separately, but the demo does not use it for multi-process games.

The SDK also accepts an exact PID:

```ts
await launcher.attach(session, {
  processName: detectedProcess.name,
  pid: detectedProcess.pid,
  executablePath: detectedProcess.filepath,
});
```

Use exact PID targeting only when the caller can reach the process before
graphics initialization starts. It is not post-render attachment. In a
controlled probe, injecting after rendering had started loaded
`ReShade64.dll` but did not adopt the existing device or swap chain.

## Acceptance launchers

Every human-facing runtime case has its own launcher under
`libs/electron-game-overlay-runtime/scripts/test-cases`:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d9-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d10-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-session-deactivation.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-session-deactivation.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-d3d12-client-sdk-two-app-two-target.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-shared-runtime.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\existing-reshade-installation-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\global-reshade-layer-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\reshade-addon-manager.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-official-reshade-addon-preflight.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-existing-reshade-installation.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-official-reshade-addon.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk-official-reshade-coexistence.ps1
```

New runs are written under `build/electron-game-overlay-runtime`. Dated
`build/reshade-imgui-overlay/...` paths in the documentation are historical
acceptance evidence produced before the runtime was promoted and renamed; they
are intentionally preserved as evidence paths, not current build instructions.

The deterministic D3D11 and D3D12 exact-PID gates start the target normally but
hold controlled device creation behind a marker, then inject through the real
frontend before releasing that marker. The shared-runtime variants start with a
compatible target-local `dxgi.dll` proxy already loaded and prove that the SDK
registers only its staged add-on without replacing the proxy or its
configuration. The existing-installation gates prove that the injector performs
no target mutation when an inactive ReShade installation is present. The
official-add-on gates exercise a caller-supplied target-local x64 ReShade
fixture through the public capability-negotiation path and assert that the
project runtime is not loaded. The session-deactivation variants close the
public SDK session while the target and producer process remain alive. A
monotonic producer-session epoch makes the target dormant on its next ReShade
overlay callback, releases input, and retires the prior single-swap-chain scene
textures without unloading ReShade or the add-on. The two-app launcher proves
independent Electron processes against separate exact-PID D3D11 and D3D12
targets, including isolated credentials, scenes, input, and teardown. The D3D12
client gate exercises two fresh target/client cycles, and the reinjection gate
keeps one Electron client alive while the controlled target exits and restarts.
The normal Gun Frog gate covers the process-name, arm-before-launch
project-runtime route. The official-ReShade Gun Frog launcher passed on July 31,
2026 with a stock host, a pristine foreign API-18 add-on, and one enabled benign
effect. It is a narrow real-game coexistence proof, not compatibility with
arbitrary proxy chains or public hosts.

The controlled x64 and x86 D3D9/D3D10 production-client gates each passed two
fresh client/target cycles on August 1, 2026. They require the exact ReShade API
hook, matching target-surface telemetry, a two-window Electron scene,
intercepted and released input, and a post-scene resize with successful resource
recreation. The Win32 runs additionally prove the SDK's validated x64-to-x86
injector handoff and packaged PE32 runtime/add-on/transport stack. The installed
Portal `hl2.exe` remains unclaimed until the same lifecycle and input boundary
passes in that real game.

## Input acceptance boundary

Interception is accepted only when all of the following hold:

- the visible Electron overlay receives hover, click, drag, wheel, keyboard,
  text, focus, and pointer-capture behavior;
- the target does not observe the same message, raw, polling, or primary
  mouse-pointer activity;
- target cursor confinement or recentering does not prevent overlay use;
- release, target exit, transport failure, or shutdown restores safe game
  input.

Explicit release is acknowledged on a rendering frame. Producer loss is
detected by a monotonic session epoch and fails open on the target's next
ReShade overlay callback; a target that has stopped presenting entirely cannot
complete that render-thread transition until presentation resumes.

Controlled x64 D3D9 and D3D10 hosts passed this boundary in August 2026;
controlled D3D11/D3D12 hosts and Gun Frog passed it in July 2026, including
Electron controls placed directly over four game menu controls. The game stayed
unchanged during interception and received the same Quit position only after
release. Exact-PID near-process-creation injection and same-client target
restart also passed their dedicated D3D11/D3D12 gates.

These results do not establish arbitrary late injection, every game, Vulkan,
OpenGL, unusual presentation paths, simultaneous arbitrary real-game
acceptance, anti-cheat compatibility, or VR. Use the unsigned full add-on
runtime only with the included controlled hosts or an offline/single-player
application you are allowed to modify. Do not use it to bypass anti-cheat
controls.

## Historical hudhook experiment

The retained [`poc/hudhook-imgui-overlay`](poc/hudhook-imgui-overlay/README.md)
records the earlier compositor, transport, DPI, and input-routing work. Its
standalone controlled-host regressions remain runnable, but it is not part of
the production build or staged SDK runtime. The retired real-client entries
remain as launchers that explain their replacement. All named cases remain under
[`poc/hudhook-imgui-overlay/scripts/test-cases`](poc/hudhook-imgui-overlay/scripts/test-cases/README.md).

See the [SDK usage guide](doc/doc.md), [known issues](doc/known-issues.md), and
[runtime README](libs/electron-game-overlay-runtime/README.md) for the current
contract and supported envelope.
