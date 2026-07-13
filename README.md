# Electron game overlay

This repository renders Electron offscreen windows inside Windows games through
a maintained ReShade + Dear ImGui host. The active stack supports controlled
D3D11 and D3D12 targets, ordered multi-window composition, focus and capture,
caption dragging, and an interception mode that routes input to Electron while
ReShade blocks the corresponding game input.

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
  is the Windows x64 injected host. It builds the pinned patched ReShade
  runtime, injector, `electron_game_overlay.addon64`, controlled D3D11/D3D12
  hosts, and human-facing acceptance launchers.
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

On Windows x64, the SDK build compiles the production transport and injected
runtime, then stages the immutable runtime assets under:

```text
libs/electron-game-overlay/dist/runtime/win32-x64/reshade
```

The staged add-on is `electron_game_overlay.addon64`. Native builds require
Rust, CMake, Git, and Visual Studio 2022 with the Desktop development with C++
workload. ReShade and Dear ImGui are pinned; a stock ReShade 6.7.3 runtime is
not ABI-compatible with this repository's patched add-on API.

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

This demo command starts prearming the SDK's native injector for the next new
process whose normalized executable path contains `/steamapps/`. Start the demo
first, let its overlay session and injector come up, and then launch the game.
The native watcher—not the later WMI notification—selects and injects the new
process. After an authenticated target connects, the client prearms a fresh
watcher for the next sequential Steam launch. ReShade selects D3D11 or D3D12
inside each process, so application code does not choose a graphics payload.
Press **Ctrl+I** while a game is focused to toggle interception.

The normal demo starts with one compact in-game information dock. It shows the
shortcut, attachment, interception, and frame-rate state without opening all of
the test windows at once. Enabling interception expands that same dock into a
clickable menu for opening the input playground, diagnostics strip, transparent
popup, and video surface. Releasing interception collapses it again.

The client retains its WMI watcher only for demo status and lifecycle evidence;
its roughly one-second notification delay no longer starts injection. The
prearmed native path is still an observer of an ordinary unsuspended process,
not a `CREATE_SUSPENDED` launcher, so the controlled acceptance launchers remain
the deterministic injection-before-graphics proof.

The current demo acceptance covers sequential launch, close, and relaunch. A
native-ready signal and the watcher gap for overlapping/multi-process launches
are tracked in `doc/todo.md` rather than treated as POC blockers.

The same prearmed path target is available through the SDK:

```ts
await launcher.attach(session, { pathContains: '\\steamapps\\' });
```

It ignores processes that were already alive when armed, selects a newly
created matching executable, and reports the selected PID and full path.

The SDK also accepts an exact PID:

```ts
await launcher.attach(session, {
  processName: detectedProcess.name,
  pid: detectedProcess.pid,
});
```

Use exact PID targeting for a process that your own launcher created suspended,
or only when the caller can otherwise prove graphics initialization has not
started. It is not post-render attachment. In a controlled probe, injecting
after rendering had started loaded `ReShade64.dll` but did not adopt the
existing device or swap chain.

## Acceptance launchers

Every human-facing runtime case has its own launcher under
`libs/electron-game-overlay-runtime/scripts/test-cases`:

```powershell
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-native-input-gate.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-reinjection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d11-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\d3d12-client-sdk-process-start-injection.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-electron-scene.ps1
.\libs\electron-game-overlay-runtime\scripts\test-cases\gun-frog-client-sdk.ps1
```

New runs are written under `build/electron-game-overlay-runtime`. Dated
`build/reshade-imgui-overlay/...` paths in the documentation are historical
acceptance evidence produced before the runtime was promoted and renamed; they
are intentionally preserved as evidence paths, not current build instructions.

The deterministic D3D11 and D3D12 exact-PID gates create the target suspended,
inject through the real frontend, and resume only after injection succeeds. The
D3D12 client gate exercises two fresh target/client cycles. The reinjection gate
keeps one Electron client alive while the controlled target exits and restarts.
The Gun Frog gate is a permitted real-game proof for the process-name,
arm-before-launch route.

## Input acceptance boundary

Interception is accepted only when all of the following hold:

- the visible Electron overlay receives hover, click, drag, wheel, keyboard,
  text, focus, and pointer-capture behavior;
- the target does not observe the same message, raw, polling, or primary
  mouse-pointer activity;
- target cursor confinement or recentering does not prevent overlay use;
- release, target exit, transport failure, or shutdown restores safe game
  input.

Controlled D3D11/D3D12 hosts and Gun Frog passed this boundary in July 2026,
including Electron controls placed directly over four game menu controls. The
game stayed unchanged during interception and received the same Quit position
only after release. Exact-PID near-process-creation injection and same-client
target restart also passed their dedicated gates.

These results do not establish arbitrary late injection, every game, Vulkan,
OpenGL, unusual presentation paths, live simultaneous-game acceptance,
anti-cheat compatibility, or VR. Use the unsigned full add-on runtime only with
the included controlled hosts or an offline/single-player application you are
allowed to modify. Do not use it to bypass anti-cheat controls.

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
