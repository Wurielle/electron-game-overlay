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

## Busy UI startup recovery

The separate `late-d3d11-ui-busy-hook-recovery.ps1` launcher opts into a 2.8-second
UI stall after the owned bootstrap initializes, before its first adoption. A
worker alone owns the immediate context and performs the first actual native
Presents/adoptions while the real HWND owner sleeps without pumping messages.
The host records distinct UI/presentation thread IDs, elapsed busy time, at
least six native Presents and both adoptions during that interval. It joins the
worker before the UI resumes pumping or touches the context again. This is a
startup-delay regression, not a claim of concurrent context access support.

After resume, the ordinary strict paused-primary lane remains intact. Target
authentication and swapchain/input readiness must be dated after the UI resumes;
critical native diagnostics fail the existing producer. The gate then requires
real overlay pixels, fresh registration/focus, DOM keys/pointer, zero intercepted
WM_INPUT/legacy/poll leakage, explicit release, an actual Windows text cursor,
restored game cursor/clipping, producer withdrawal and final native retirement.
Input is synthetic SendInput, never physical-key acceptance. Existing launchers
leave this mode disabled. Root coordinates all GUI execution.

```powershell
& libs/electron-game-overlay-runtime/scripts/test-cases/late-d3d11-ui-busy-hook-recovery.ps1 `
  -RuntimePath C:/absolute/owned/ReShade64.dll `
  -AddonPath C:/absolute/owned/electron_game_overlay.addon64 `
  -Architecture x64
```

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

## Recorded busy-UI regression acceptance

[Portable paired evidence](evidence-ui-busy-2026-11-01.json) records the actual
2026-11-01 generation-15 negative and generation-16 positive controls, including
full binary/source/artifact hashes and the matched generation-16 package records.
The x64 host, controller, producer and SDK entry shim hashes match between the
negative and positive controls. Entry-shim equality does not establish equality
of the complete imported SDK JavaScript graph.

| Candidate | Architecture | Result | Busy UI / worker Presents | Readiness after UI resume |
| --- | --- | --- | --- | --- |
| Generation 15, `BCE6C5C8746F4300861300B2BDA3594E` | x64 | Failed: critical `runtime-input-routing-failed`, native Win32 1460 | Startup did not complete | No input acceptance claimed |
| Generation 16, `E8FE3783F29E4FB297D8B006D0087725` | x64 | Passed | 2828 ms / 160 Presents, 2 adoptions | Hello +15 ms; ready +15/+17 ms |
| Generation 16, `E8FE3783F29E4FB297D8B006D0087725` | Win32 | Passed | 2860 ms / 162 Presents, 2 adoptions | Hello +11 ms; ready +12 ms |

Both positive controls delivered DOM key down/up and pointer input while native
legacy messages, WM_INPUT and all three polling APIs remained suppressed.
Explicit release and producer exit restored native input. Actual Windows cursor
checks passed and restored the prior cursor/clipping rectangle. Fresh window
IDs replaced the old rank without implicit focus or TCP reconnection; producer
exit withdrew windows/ranks/focus and red pixels. Final cleanup recorded two
retirements, zero render/quarantine/pipeline faults, unchanged staged INI,
zero generated INIs and clean host/producer exits. Display evidence observed ON
before/during each pass and released its temporary request.

The stopped producer's final saved interception flag is stale; post-disconnect
restoration is established by native polling/messages and registry/pixel
withdrawal, not an acknowledgement from a closed socket. This is controlled
owned-host D3D11 acceptance with synthetic foreground input. It is not a
real-game, automatic-attachment, buffered-raw-input or physical-key result.
