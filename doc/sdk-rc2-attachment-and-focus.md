# SDK 0.1.0-rc.2 attachment and keyboard focus

This candidate replaces rc.1 consumer patches. Install the complete SDK tarball;
do not copy only JavaScript or a native add-on. Windows x64 applications receive
both x86 and x64 target payloads, licenses, build stamps and a sealed standalone
broker distribution. `SDK_PROVENANCE.json` in a release artifact identifies its
source commit and native patch provenance. This is a candidate, not a stable release.

## Public keyboard focus

```ts
const overlay = new ElectronGameOverlay({ allowPrereleaseBroker: true });
const session = overlay.createSession();
const window = session.windows.create({ id: 'search', file: 'overlay.html' });
window.show();
window.focus();
session.input.intercept();
```

Focus the intended DOM input in the page too. `window.focus()` now selects the
native keyboard destination through the broker's application-local to target-global
ID mapping. It can precede the first painted frame and interception activation.
It does not require a pointer click. Call `show(); focus()` again after hiding.
`blur()` addresses that specific window; a stale blur from another window or app
cannot clear the current owner. Hiding or removing the focused window removes its
native focus. Explicit focus survives temporary interception-off and game
foreground loss, but no keys route while either gate is off. A subsequent pointer
selection or explicit focus change selects the new destination.

The additive `window-focus-v1` capability is negotiated independently with the
coordinator and injected runtime. Frozen broker v1 and target transport v1 remain
unchanged. An already-running older coordinator or an already-injected older
runtime continues operating, but cannot implement the new explicit native-focus
command. In that combination the older click-to-focus behavior remains. Restart
the target and allow a focus-capable coordinator to start after its previous
clients/targets have exited to use the new capability. Never terminate an unrelated
broker, replace a live owner, or reinject a game to enable it. Runtime generation 4
outranks rc.1 generation 2 and the temporary generation-3 proof only inside the
normal bounded election window. Later arrivals do not preempt.

## Prearm fast-starting targets safely

An exact-PID request begins its bounded deadlines immediately. If graphics
factories or swapchains were created before ReShade loaded, DLL-load success can
still be followed by an authentication timeout or missing render surfaces. Faster
process polling does not establish graphics-hook compatibility. There is no safe
automatic retry after an uncertain injection into a live PID.

Where the application has already authorized a specific executable path, prearm
that exact path before starting the game:

```ts
const target = {
  processName: 'Gun Frog.exe',
  executablePath: String.raw`C:\Games\Gun Frog\Gun Frog.exe`,
};
launcher.onEvent(event => {
  if (event.type === 'injector-watcher-ready') {
    // The watcher has baselined existing processes. The game may now be started.
    showLaunchReady();
  }
});
const attached = launcher.attach(session, target);
// Start the game only after injector-watcher-ready; awaiting attached first
// would wait for a process which has not been started yet.
await attached;
```

The native watcher compares the whole executable path and basename before
mutation, retains process identity across selection, and ignores baseline
processes. Slash normalization happens in the SDK; matching is case-insensitive.
Name-only prearming remains available for applications whose policy explicitly
permits every future process with that basename. `pathContains` is a substring
selector; `excludedProcessNames` excludes entire basenames. They are not glob,
directory-boundary, path-deny or arbitrary application-policy evaluators. Do not
approximate a restrictive rule with a broader selector and reject it after
`targetConnected`: injection has already happened by then. Resolve permission for
the exact path first, or use read-only observation followed by policy evaluation
and exact-PID attachment, accepting that this may be too late for a fast game.

Future watchers remain armed indefinitely while idle. Native readiness has a
5-second handshake bound. Once native selection is reported, injector execution
has a 120-second bound. After an injector result, selected-target authentication
has the existing bounded proof deadline (120 seconds for name/exact-path targets,
10 seconds for path-substring targets). Disposal/session closure cancels pending
work without launching a competing fallback. The validated injector result and
authenticated target must identify the same selected PID and executable.

Precreation name/path attachment uses the existing exclusive legacy rendezvous.
It does **not** acquire same-PID multi-application sharing. Overlapping independent
applications use exact-PID broker leases. This release does not add a shared
precreation policy arbiter, suspend arbitrary games, or promise universal late
graphics-hook attachment.

`injector-returned` proves a validated DLL-load/preflight result. `attach()`
resolves only after that selected process authenticates. Rendering additionally
requires `targetSurfaceChanged` and runtime `runtime-swapchain-ready` /
`runtime-scene-rendering-started` diagnostics. Input additionally requires
foreground game focus and effective `inputInterceptionChanged`. Keep these
milestones distinct when reporting success. Initialization timeouts preserve
injector/startup evidence paths and explain the early-attachment alternative.

## Public process observation

```ts
import { observeOverlayProcesses } from 'electron-game-overlay';

const observer = observeOverlayProcesses({
  pathContains: String.raw`\steamapps\`,
  onCreated(identity) {
    // identity: { pid, executablePath, creationTime100ns }
    // Evaluate the application's own allow/deny rules before requesting attach.
  },
  onExited(identity) {
    // Authoritative exit of this exact observed process incarnation.
    // Cancel its app work and, if appropriate, rearm a fresh launcher.
  },
  onError(error) {
    // Observation has stopped. Existing target exits are unknown.
  },
  signal: abortController.signal,
});
await observer.ready;
// Later:
observer.dispose(); // repeatable; does not fabricate process exits
```

The SDK validates its bundled payloads and hides the native CLI/output protocol.
Future-target support is an explicit `injectorFutureTargets: 1` declaration in
both validated private runtime manifests; generation numbers alone do not grant
that support. Older manifests remain readable without acquiring the capability.
Creation time is an exact decimal FILETIME string, never a JavaScript number.
The native observer baselines existing processes, retains process handles,
streams UTF-8 paths, and reports an exit only after authoritative retained-handle
evidence. PID reuse is a different incarnation. Unknown/denied identity is not a
creation event. Transport loss, cancellation and observer failure are not target
exit. The observer does not inject, authorize policy, or promise low enough
latency for every graphics initialization. Its identity is observational evidence;
it is not a new caller-supplied broker injection expectation. Discard asynchronous
policy results for incarnations that have exited and cancel their pending work.

## Repeatable evidence boundaries

- Rust packet-dispatch/router tests cover no-pointer first key, first-frame wait,
  reopening, two windows, conditional blur/removal, interception and foreground gates.
- Broker tests translate colliding local IDs across members. Independently built
  rc.1/current coordinator/client matrices exercise optional-focus fallback in
  both startup orders, late joins, isolation, ownership freeze and single authorization.
- Windows ABI tests cover both architectures. The public native observer test
  verifies baseline exclusion, Unicode, creation identity and retained-handle exit.
- `scripts/test-cases/d3d11-explicit-keyboard-focus.ps1` runs actual public SDK
  applications against an owned D3D11 target, using a private test broker pipe.
  It tests first show/reopen, two app processes, member exit and native input gates.
  Default input is OS `SendInput`, not direct Electron input or a hardware key.
- `d3d11-idle-future-target-focus.ps1` waits 130 seconds after prearming an exact
  future path, then checks authenticated rendering and native input.
- Add `-PhysicalKeyboard` to the dedicated launchers for a human physical-key
  check. `gun-frog-explicit-keyboard-focus.ps1 -GameExecutable <absolute path>`
  tests a newly launched real game through exact-path prearming. Leave existing
  games alone; start with the target closed. This case is single-application.

Electron 39 remains the normal declared range. The exact prerelease
`46.0.0-alpha.2` is additionally admitted after the Windows controlled native
acceptance. This does not validate other Electron 40–46 builds, every graphics
API/game, or all alpha behavior. A noninjecting DOM smoke is separate evidence
from native routing and from a human physical-key test.
