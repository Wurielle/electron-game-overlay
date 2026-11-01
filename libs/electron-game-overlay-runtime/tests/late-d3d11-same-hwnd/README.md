# Late D3D11 same-HWND input lifetime proof

This standalone fixture extends the source-only generic discovery experiment.
It does not modify the frozen manual/generic hosts, the owned-host prototype,
production targets, or existing official ReShade installations. All three human
launchers default to the final production owned-host ABI: exported capability
`ElectronGameOverlayOwnedLateD3D11AbiV1` must equal one, initialization uses
`ElectronGameOverlayInitializeOwnedLateD3D11V1(nullptr)`, and the query uses the
fixed 104-byte version-1 diagnostics record. A missing capability/export fails;
the caller never falls back to the prototype ABI. No target graphics pointers
or caller-controlled configuration path are handed to production initialization.
The controlled self-loader validates host ABI 1 and atomically claims the OPEN
adapter gate before loading the add-on. Successful DllMain completion publishes
REGISTERED before member/bootstrap initialization. A failed LoadLibrary alone
may restore its own LOADING claim to OPEN; an unknown or already closed gate
fails without loading or replacing another adapter.

The host creates two raw D3D11 discard swapchains on the same verified HWND.
Both present at least 60 frames before either supplied DLL is loaded. The first
post-bootstrap cycle presents A before B so that A initially acquires ReShade's
input ownership. Later cycles present B before A, keeping the EGO primary A's
transported scene visible. After A's final release, B continues presenting.
There is no startup barrier or wait for injection before graphics creation.

Each run selects one independent case:

- `primary-resize`: call A's actual `ResizeBuffers` while B remains live. The
  existing client/buffer dimensions are retained to isolate input-consumer
  reset/reinitialization from DPI and coordinate scaling. Statistics must show
  exactly one native resize/reset. This is not a resolution-change acceptance
  claim; the separate generic fixture exercises changed dimensions.
- `primary-final-destroy`: release A's RTV and raw chain while B remains live.
  Continue only after the actual notifier reports exactly one retirement.
- `primary-paused`: keep A's native chain, RTV and runtime alive, but stop its
  Present calls. B alone must continue presenting. Create a fresh SDK window in
  the same session, require its new native ID and only its registration/rank,
  and verify no implicit native focus before an explicit focus command. The
  authenticated TCP endpoint must remain identical. Prove DOM keyboard/pointer
  delivery, native WM_INPUT/message/poll suppression and explicit release.
  Then exit the producer while interception is enabled: B must withdraw all
  windows/ranks/focus, show the native background, and restore native input.

Final cleanup releases both chains and waits at most five seconds for two
retirement notifications while retaining their shared device/context. A timeout
fails; a reference count or elapsed timeout never substitutes for destruction.

## Input oracle

The controller runs three sampling windows with a controller-owned, bounded
`SendInput` hold of `VK_A`. Input is synthetic foreground input, not physical-key
acceptance. Every window has a distinct native epoch and monotonic timestamps.

1. Release EGO interception and prove all three native polling APIs see the held
   key before the lifecycle event. This calibrates the real polling path.
2. Apply the selected lifecycle event, focus/intercept with EGO, and wait for its
   acknowledgement. The transported DOM must receive key down/up, while the game
   receives no native key/character messages and all three native polling APIs
   remain zero for at least three samples while the key is actually held.
3. Release interception again and prove native polling sees another held key.
   This also detects suppression stuck on after the primary lifetime change.

The native host calls `GetAsyncKeyState`, `GetKeyState`, and `GetKeyboardState`
through its normal imports, so it exercises the installed ReShade hooks. It does
not call an unhooked trampoline. Message delivery and key polling are separate
oracles: successful DOM routing or suppressed `WM_KEYDOWN` alone cannot prove
that game polling was suppressed. The controller separately confirms that the
key is down in its uninjected process and always releases its synthetic hold.
The paused case also registers ordinary foreground keyboard/mouse WM_INPUT and
checks raw delivery separately. This does not claim GetRawInputBuffer coverage.
All cases record the actual first adoption count transition around native
Present, including the adopted raw pointer/role; A-first is checked, not assumed.

Actual foreground pixel checks and HWND/PID ownership guards remain in the
controller. Connection continuity requires one authentication and zero transport
loss/disconnection events. The final native report requires two adoptions, the
case-specific resize count, two actual retirements, and zero quarantines/render
failures. Its lifecycle success does not independently claim input acceptance;
the controller's stronger oracles determine that result.

## Launch

Run each case in a fresh process with the explicit production owned binaries:

```powershell
& libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d11-same-hwnd-primary-resize.ps1 `
  -RuntimePath C:/absolute/owned/ReShade64.dll `
  -AddonPath C:/absolute/owned/electron_game_overlay.addon64 `
  -Architecture x64

& libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d11-same-hwnd-primary-final-destroy.ps1 `
  -RuntimePath C:/absolute/owned/ReShade64.dll `
  -AddonPath C:/absolute/owned/electron_game_overlay.addon64 `
  -Architecture x64

& libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d11-same-hwnd-primary-paused.ps1 `
  -RuntimePath C:/absolute/owned/ReShade64.dll `
  -AddonPath C:/absolute/owned/electron_game_overlay.addon64 `
  -Architecture x64
```

The dedicated launcher builds only this standalone host and stages exact copies
in a unique owned directory. It uses the existing private SDK scene producer;
it never authorizes a fake scene as success. Global environment and game files
are not changed. GUI execution and any production host rebuild require the
root task's coordinated test slot.
The recreation command is enabled by an explicit producer flag only in the
paused case. Native registry observations open only the exact process-instance
mapping for read access under its mutex; they create no registry or participant.
No actual paused-case result is claimed by source/VM tests.

Production stages contain the final
`electron-game-overlay-owned-runtime-v1.marker`, normal owned-run JSON, and
the `ReShade.ini` template. The runner verifies that the template hash stays
unchanged and no generated per-chain INIs remain after final retirement.

Only the internal runner accepts `-Prototype -DiagnosticInputOnly` to retry the
old V2 baseline. That explicit diagnostic writes the old prototype marker and
uses its request/config-path/export pair. The human launchers expose neither
switch, and prototype mode can never report production ABI acceptance.

The internal runner accepts `-DiagnosticInputOnly` for investigating native
polling despite a known pixel failure. It records the sampled pixels and keeps
all held-key/lifetime checks, but reports `diagnostic`, never `passed`, and leaves
both rendering and feature-acceptance flags false. The dedicated feature
launchers do not expose this diagnostic switch.

## Native command protocol

The host accepts the generic fixture's explicit stage/runtime/add-on/config/
report arguments plus required `--case` and optional `--command-file`. The
configuration must be a new `ego-late-d3d11-*.ini` directly under its owned stage;
the stage marker and child base override follow the generic prototype contract.
The default command file is `same-hwnd-command.txt` under that stage.

The controller atomically publishes one ASCII line:

```text
EGO_SAME_HWND_COMMAND_V1 <positive increasing sequence> <action>
```

Actions are `sample-begin`, `sample-end`, `apply-lifecycle`, and `finish`.
Acknowledgements use `commandSequence`; each sampling epoch equals its begin
sequence. `finish` requires the lifecycle event, at least 60 subsequent survivor
frames, and three completed sampling windows. The host does not automatically
finish when its bounded lifetime expires: a missing controller result fails.

Live reports are replaced atomically and must be read with delete sharing.
`polling` contains total/down counts, errors, active/epoch fields, and start/end/
last-sample uptime timestamps. Counters freeze at `sample-end` for review.

Atomic report replacement retries sharing/lock violations for at most 50 ms;
other errors fail immediately. Reports retain publication operation, Win32 error
and retry counters. Final controller evidence records each owned child's actual
exit code and whether controller cleanup requested its termination.

The original V2 `primary-resize` baseline failed the strict post-lifecycle
desktop pixel check with native background RGB 20,31,51, before post-lifecycle
polling could be tested. Evidence is under
`build/late-d3d11-same-hwnd/proof-primary-resize-x64-6f22aaad5b954ad0ab90c958016048c8`.
The first `primary-final-destroy` attempt stopped through its report-publication
failure path after 39 pre-load presents per chain, before either DLL was loaded;
it establishes no graphics, lifecycle or polling result. Its artifact directory
ends in `dce887d8e1c8424098b99846888bfe82`. Neither run is a passing same-HWND
input-promotion result.
