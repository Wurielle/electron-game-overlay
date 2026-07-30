# Todo

## Production ReShade runtime

Further expansion of project-owned hudhook input detours is frozen. A ReShade
Gun Frog run proved that Electron could receive a blocked legacy click while
Unity 6 still consumed the same physical action through Windows' second
`WM_POINTER` mouse projection. The repository oracle reproduced that exact
split, and the pinned ReShade runtime now suppresses `PT_MOUSE` client
`WM_POINTER` input while updating native ImGui state. The add-on translates its
primary-pointer stream once for Electron after global queue ordering. D3D11 and
D3D12 controlled acceptance now freeze legacy, raw, polling, cursor, and pointer
counters together. The July 12 Gun Frog rerun passed the same boundary, and the
July 13 exact four-button menu proof confirmed it across Continue, New Game,
Settings, and Quit plus the inverse released Quit action. The SDK/client host
migration then passed the same Gun Frog gate through the built production client
and SDK ReShade launcher on July 13. The same production path subsequently
passed two isolated controlled D3D12 cycles with both Electron windows,
interception/release, caption dragging, normal target exit, cleanup, and fresh
relaunch. The restart lifecycle subsequently passed with one Electron client
and overlay session across two new target PIDs, using the real frontend Inject
action and distinct isolated ReShade runs.

New runs use `build/electron-game-overlay-runtime`. Dated
`build/reshade-imgui-overlay/...` paths below are historical pre-promotion
acceptance evidence and are intentionally preserved as records.

### POC completion boundary

As of July 30, 2026, the library POC is ready for application testing through
the public `electron-game-overlay` SDK within its documented boundary:
near-process-creation injection, automatic D3D11/D3D12 host selection,
multi-window Electron rendering/input, target relaunch without restarting
Electron, demo-owned Steam process observation, target-follow/FPS telemetry, and
structured attachment/transport/runtime/producer diagnostics all have
production-client evidence. Package publishing is intentionally excluded.

Unchecked items below are post-POC compatibility or hardening work. They do not
extend the current completion boundary by implication; stock/arbitrary existing
ReShade integration, late post-swap-chain adoption, clean in-process unload,
additional graphics/input APIs, multi-swap-chain policy, and physical
mixed-monitor acceptance remain explicitly unsupported or deferred until chosen
as a separate task.

### Completed promotion milestones

- [x] Pass the visible ReShade-owned input gate on the controlled D3D11 host.
  - Prove overlay mouse/keyboard interaction, zero game-side message/raw/polling reactions while active, cursor confinement release, pass-through restoration, and clean shutdown.
- [x] Pass the same visible gate on the controlled D3D12 host.
  - Both controlled gates passed on July 12, 2026, including button, text, drag, wheel, active-intercept resize, post-resize click, and release restoration. ReShade's managed ImGui state is sampled once per `Present`; exact fast-edge delivery remains the project-owned Electron queue's responsibility.
- [x] Pass the gate against Gun Frog before migrating the SDK/client runtime.
  - The first ReShade run rendered and operated both Electron windows, but a click on Electron also activated Unity's underlying `Continue` control. The controlled pointer oracle identified and closed the `WM_POINTER` gap.
  - The July 12 rerun clicked the Electron BACK button directly over `Continue`; Electron logged the complete down/drag/up/click sequence and the game stayed on its menu. Both windows accepted focus/text, raising either window and caption dragging worked. Clicking the manual `Release input` control produced the disable acknowledgement, after which the same game control immediately entered gameplay. Normal close succeeded, and no game-directory log, input-order fault, or router reset appeared.
  - The July 13 strengthened acceptance aligned four Electron buttons exactly over Continue, New Game, Settings, and Quit. Each emitted a unique `HUDHOOK_CLIENT_MULTIWINDOW_INPUT ... event=gun-frog-click name=<...>` marker while Gun Frog remained on the menu and alive. Manual release emitted `RELEASE_REQUESTED`, `INTERCEPT_DISABLED`, and `LIFECYCLE_COMPLETE`; clicking the same underlying Quit position afterward closed Gun Frog.
- [x] Extract and promote the backend-neutral Rust transport/scene/input engine.
  - `libs/electron-overlay-transport` owns `electron_wire.rs`,
    `electron_frame.rs`, `electron_input.rs`, ordered scene/router semantics,
    and premultiplied-BGRA conversion. It builds as both an `rlib` and a Windows
    static library; the retained hudhook POC consumes the same crate instead of
    duplicate modules.
- [x] Finish the narrow, versioned C ABI and ReShade-linked smoke target for that engine.
  - Immutable scene/name/RGBA pointers are leased by explicit snapshots, every fallible Rust export contains panics and returns fixed status codes, and the native layout/link/lifecycle smoke passes. The proven native-only D3D11/D3D12 gate targets remain independent of Cargo.
- [x] Port multi-window ReShade texture composition and exact legacy Electron input return on D3D11.
  - Preserve registration order, click-to-front, alpha hit testing, caption drag, pointer capture, focus-before-input, per-packet scale tags, and desired/active raster transitions.
  - D3D11 connects the real authenticated Electron producer, uploads both overlapping OSR windows, renders the ordered scene, and acknowledges ReShade-owned interception.
  - The pinned API-19 full-add-on observer copies input only after ReShade decides to block it. A bounded lock-free queue delivers exact legacy Win32 records to the shared Electron router. When Windows mouse-in-pointer is active, the add-on captures pointer ID/type/target/modifiers at the callback, sorts the global observer sequence, and only then converts the blocked primary mouse stream into that same single legacy route. Controlled click-to-front, text focus/input, and caption dragging passed while every game-side legacy/raw/polling/pointer oracle counter stayed frozen.
  - Copied `WM_INPUT` and `GetRawInputBuffer` records are retained and counted; normalizing those raw records is deferred below rather than blocking the POC.
- [x] Pass the same real Electron scene and exact legacy-input acceptance on D3D12.
  - D3D12 rendered both ordered Electron windows and passed exact click/focus/text and caption-drag routing while every host oracle counter remained frozen.
- [x] Replace the active client's hudhook launcher/runtime selection with the ReShade host boundary and pass the real client/SDK Gun Frog input gate.
  - The production client now arms by executable process name before launch, lets ReShade select the graphics API, and keeps the public session/window/input surface plus Electron-owned Ctrl+I toggle stable.
  - `gun-frog-client-sdk.ps1` passed against PID 11104: all four aligned Electron controls stayed inside the overlay, Ctrl+I produced the negative acknowledgement, the identical released Quit position closed the game, and the runner persisted `GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS` in the client-run `result.txt`.
- [x] Pass the controlled production-client lifecycle, multi-window, and D3D12 gate twice with a fresh relaunch.
  - `d3d12-client-sdk.ps1` passed against PIDs 17248 and 13528 with distinct isolated ReShade runs. Both Electron windows accepted input, the foreground target oracle froze during interception, caption drag was verified behaviorally, release restored legacy/raw/primary-pointer input and confinement, released Escape closed each host, and no test process remained. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630` contains `D3D12_REAL_CLIENT_SDK_GATE_PASS`.
- [x] Re-arm the SDK and frontend after an exact target disconnect without restarting Electron.
  - `d3d12-client-sdk-reinjection.ps1` kept Electron PID 17756 alive across target PIDs 19764 and 17940. The SDK pinned each injector-selected PID, rejected forged lifecycle events, kept its injection latch across transient transport loss, returned to `idle` only after the OS confirmed the selected target had exited, staged distinct runs, and passed the second D3D12 scene/input/interception cycle. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105` contains `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`.
- [x] Pass exact-PID near-process-creation injection through the production client and public SDK on controlled D3D11 and D3D12.
  - The SDK accepts optional `{ processName, pid }` targets and the Electron demo exposes the optional PID. The intended watcher calls immediately after the process exists and before graphics-device/swap-chain creation.
  - `d3d11-client-sdk-process-start-injection.ps1` passed against PID 7428 with a 72.393 ms process-create-to-frontend-click interval. Exact injector arguments and pre-`ResumeThread` ReShade loading were proven; transport, D3D11, two windows, and input passed after resume. The target exited 0, the frontend returned to `idle`, and no test process remained. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623` contains `D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`.
  - `d3d12-client-sdk-process-start-injection.ps1` passed the same boundary against PID 21508 with an 84.061 ms interval. Evidence under `build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642` contains `D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; D3D12, two windows, input, exit 0, frontend `idle`, and no-leftover checks passed.
  - Those July 13 runs are historical suspended-ordering evidence. The current launchers start the host normally and hold only device creation behind a test marker; D3D11 and D3D12 passed that production client/SDK path again on July 30 under `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-084815` and `client-sdk-d3d12-process-start-20260730-084831`.
- [x] Use a hybrid prearmed Steam-path and exact-PID coordinator and pass normal-client Gun Frog launch/relaunch.
  - The former WMI `WITHIN 1` path loaded ReShade after Gun Frog had created its primary DXGI swap chain, so injection logs could report success while no transported scene appeared. The first native path milestone excluded Unity crash-handler helpers, and its one-shot selection could not cover launcher/child chains. The current design keeps one broad `\\steamapps\\` path launcher prearmed with zero executable exclusions while the continuous observer independently starts an exact-PID attempt for every detected Steam executable; WMI is fallback-only.
  - A native per-PID claim serializes overlapping path/exact selection before target mutation. The coordinator adopts a path winner and disposes its exact loser; an exact winner makes the path attempt yield cleanly. The broad watcher is rearmed after safe completion, target exit, or a definite-safe failure. An indeterminate target mutation remains blocked.
  - On July 13, 2026, ordinary `npm run dev` attached to Gun Frog PIDs 22640 and 8732 in sequence without restarting Electron. Both distinct path-watcher runs selected `Gun Frog.exe`, intercepted `CreateSwapChainForHwnd`, authenticated the target, and rendered transported Electron scenes. The compact dock, expanded Ctrl+I menu, and full main test window were all verified visually; both exits emitted terminal disconnect/release and left a fresh watcher armed.
  - A later real rerun exposed why launches could still fail intermittently: the watcher's permanent startup baseline keyed ignored processes only by numeric PID, so Windows PID reuse made a new game look like an old process. The baseline now retains handles for the exact startup process objects and prunes signaled handles on every poll. With one unchanged Electron client, the final implementation injected and rendered Gun Frog PIDs 19052 and 22644 across close/relaunch; the second run also opened Ctrl+I, captured input, and accepted the `Open status window` click before normal game close left the next watcher armed.
- [x] Keep independent exact-PID attempts for every detected Steam executable and pass LORT's launcher/renderer chain.
  - The process watcher now initiates one isolated SDK launcher for every `.exe` creation event under `steamapps`. It does not classify or exclude launchers, renderers, crash handlers, helpers, or redistributables. Duplicate events for a live PID are deduplicated, while process deletion releases the PID for a later lifetime.
  - On July 13, 2026, one unchanged client attempted both LORT PID 12232 (`LortGame.exe`) and PID 21272 (`BW\Binaries\Win64\LortGame-Win64-Shipping.exe`). The bootstrap loaded ReShade without a graphics runtime or add-on and did not block the child. The Shipping process initialized D3D12, loaded `Electron Game Overlay Runtime` with API 19, authenticated, published live FPS, toggled interception with Ctrl+I, and accepted the `Open status window` overlay click. Both targets and the client were then closed cleanly.
  - On July 29, 2026, the hybrid path/exact coordinator kept one Electron client alive across Gun Frog PIDs 20856 and 13068. Both D3D11 launches showed the overlay at 60 FPS; Ctrl+I received true/false acknowledgements, the status-window click was captured without changing the game menu, normal Quit closed the released game, and Electron remained alive.
  - After the final observer-readiness and path-first ordering hardening, one client repeated visible 60 FPS attachment, independent exact-PID attempts, normal exit, and rearm for Gun Frog PIDs 11856 and 16892 with no leftover game, client, or injector processes.
- [x] Publish target-surface and real render-FPS telemetry and expose target-follow layout through the SDK.
  - The ReShade add-on now reports changed render/client/window geometry, HWND, graphics API, DPI, monitor/work-area bounds, focus/visibility/minimized/fullscreen-like state, and approximately one injected ImGui FPS sample per second through the versioned Rust C ABI.
  - The authenticated Node transport assigns the authoritative PID and strictly validates the three `game.target.surface`, `game.target.surface.removed`, and `game.graphics.fps` packets. `OverlaySession` retains immutable surfaces by PID/surface ID, emits typed events, and preserves them across transient transport loss until explicit removal or OS-confirmed exit.
  - `ElectronOverlayWindow.followTarget()` owns target-monitor backing placement in DIP and publishes fixed local physical geometry only after the matching OSR raster commits. SDK/client tests cover resize-safe transitions, cross-display conversion, selectors, stale revisions, disconnect cleanup, and forged-PID rejection. The normal demo shows API/resolution/real FPS and uses the public render-follow mode for its main test surface.
  - Controlled D3D11 and D3D12 scene runs on July 13, 2026 both published 1280×720 target telemetry, a nonzero injected FPS sample, rendered two transported Electron windows, acknowledged interception, and exited cleanly. Evidence is under `build/electron-game-overlay-runtime/electron-scene-d3d11-20260713-183425` and `build/electron-game-overlay-runtime/electron-scene-d3d12-20260713-183543`.

### Runtime compatibility and hardening

- [x] Add exact-PID loaded-runtime compatibility preflight and a strict structured injector result.
  - Before target mutation, the injector performs bounded module enumeration
    and PE export inspection. Exact `ReShadeVersion` identifies a candidate;
    private host ABI/gate exports decide compatible reuse versus specific
    fail-closed diagnostics. Inspection that cannot complete safely fails
    closed as `target-module-inspection-failed`.
  - The SDK exports `ReShadeDiagnostic`, `ReShadeDiagnosticStage`,
    `ReShadeDiagnosticCode`, `ReShadeRetrySafety`, `ReShadeOperationError`, and
    `isReShadeOperationError()`, plus `ReShadeRuntimeMode`. The frozen
    structured-clone-safe diagnostic
    preserves stage, code, retry safety, target context, applicable Win32
    status, and staged-run evidence paths. Outcomes proven not to have loaded a
    runtime/add-on payload return to `idle`; indeterminate payload-load outcomes
    remain `blocked`. A reuse-race can perform bounded remote coordination
    before losing its gate CAS, so `definite-safe` does not universally mean
    zero remote mutation.
  - Success requires exactly one structured injector result. It distinguishes
    `injected-runtime` from `existing-runtime` and includes the compatible host
    path for the latter. The SDK continues to parse legacy
    `target-runtime-conflict` diagnostics but the current injector does not emit
    that generic outcome.
  - Module filenames and on-disk proxy-like files are not used as conflict
    proof. This intentionally avoids false-positive, executable-specific
    heuristics.
- [x] Prove the narrow project-compatible existing-runtime foundation.
  - A loaded runtime may be reused only when it exports private host ABI 1 and
    its add-on gate is still `OPEN`. The injector then loads only the privately
    staged Electron add-on and leaves the host proxy, ReShade configuration, and
    base-path ownership unchanged.
  - `d3d11-client-sdk-shared-runtime.ps1` and
    `d3d12-client-sdk-shared-runtime.ps1` passed on July 30, 2026 with normal
    target startup behind a test-only pre-device marker. Both proved
    `existing-runtime`, no second loaded runtime, unchanged proxy/config hashes,
    no add-on copied into the target directory, and the full scene/input/release
    boundary.
- [ ] Support games already modded with ReShade through a compatible
      shared-runtime/add-on integration path.
  - The controlled foundation does not support stock API-18 or differently
    patched ReShade, missing private host exports, an already-active/closed host
    gate, arbitrary real-game startup timing, or interactions with an existing
    effect/add-on set. Prove those cases or produce clear fail-closed
    diagnostics without modifying the installation.
  - Use loaded-module capability inspection as the authoritative runtime
    decision; proxy-like files beside the executable are only prelaunch
    discovery hints. A validated official on-disk ReShade hint takes precedence
    before launch: stage the official-ABI add-on and suppress project-runtime
    injection for that launch, then validate the actual loaded host and its
    capabilities. Only inject the project runtime when neither a loaded ReShade
    nor a validated official prelaunch hint exists. Reuse a project-compatible
    runtime while its private gate is open.
  - Never silently replace an existing ReShade proxy, configuration, effects,
    or add-ons. If an official host has already completed add-on initialization,
    leave the current process untouched and prepare/report the integration for
    its next launch unless ReShade gains a supported dynamic-registration
    lifecycle.
  - Pursue upstream support for both a passive post-suppression input event and
    a race-free add-on registration capability. Until those exist, the official
    build is a prelaunch/partial integration path; the project fork remains the
    full Electron input-routing host. Add explicit host-version/capability
    negotiation before considering the two paths interchangeable.
  - Resolve host installation/base-path ownership. The current existing-mode
    `reshadeLogPath` is inferred beside the host module, while ReShade
    `[INSTALL] BasePath` may put the authoritative log elsewhere.
- [ ] Define a supported coexistence strategy for targets using another proxy
      runtime.
- [ ] Add clean runtime disable/unload behavior.
- [ ] Investigate the non-fatal ReShade reference-count warnings emitted during accepted shutdowns: `ID3D11Device3` in Gun Frog and D3D12 command-queue/device objects in PEAK. Keep this under resource retirement/unload hardening.
- [ ] Carry process creation identity end to end through exact-PID requests and WMI lifecycle correlation.
  - The native Steam-path watcher's ignore-baseline now retains handles for exact process objects, so sequential launch/relaunch cannot skip a new process solely because Windows reused a baseline PID. Exact-PID selection and fallback-WMI create/delete correlation still use PID plus executable basename and need an equivalent creation nonce before stale lifecycle events are considered fully hardened.
- [x] Replace WMI as the hot creation path with continuous native multi-process observation and an explicit ready handshake.
  - The parent-scoped continuous observer reports matching creation/deletion identities through a strict UTF-8 protocol and exits with its forked watcher parent. A separate broad `\\steamapps\\` path launcher remains prearmed alongside exact-PID attempts, with the native per-PID claim arbitrating overlap. WMI is now created only as the slower fallback if the continuous observer fails.
  - The first 5 ms implementation walked a full Toolhelp snapshot and every retained process handle on each pass. After a PEAK thermal report, it was replaced with one compact `EnumProcesses` PID array per pass, executable-path queries only until resolution, and stable process handles that are retained but never polled. Temporarily inaccessible paths retry with bounded backoff until exit. The tightened automated gate measured 1.5% of one CPU core with no accumulating handle/private-memory growth in the latest focused run, versus roughly 25-34% for the retired scanner.
  - Observation starts before the demo prepares four launchers concurrently. Creation events wait in order for prepared slots, successful consumption starts an immediate refill, and preparation failures emit diagnostics and retry with bounded backoff instead of staging reactively for a detected target. The SDK hard-links non-mutating artifacts when supported, privately copies `ReShade64.dll`, `electron_game_overlay.addon64`, and mutable `ReShade.ini`, and removes unconsumed prepared directories on disposal or staging failure.
  - The old WMI path reached PEAK roughly 481 ms after process creation and missed its existing D3D12 objects. A preliminary native-observer run caught PEAK before D3D12 initialization and rendered the overlay, but it used the retired hot scanner. On July 28, 2026, the bounded replacement injected PEAK PID 11920 before `d3d12.dll` loaded, initialized the transport, rendered the dock, captured Ctrl+I, and accepted the status-window click. The observer measured 0.6% of one CPU core before launch and rounded to 0% during the in-game sample; PEAK itself reported 374-396 FPS during its splash and roughly 94 FPS on the menu. No readable temperature sensor was available, so this closes the short functional/resource rerun but not a thermal soak.
- [ ] Harden fallback-WMI startup teardown.
  - Disconnecting the isolated watcher child while the real `wql-process-monitor` subscription is still starting reproduced Windows exit `0xC0000005`. The normal native-observer path is unaffected, and hermetic fallback coverage passes with the same ready/shutdown ordering, but the real COM subscription needs a cancellation-safe startup/drain before fallback teardown is considered reliable.
- [x] Add bounded age/count retention for safely completed SDK run directories.
  - Every new isolated run receives an immutable SDK ownership marker. Definite-safe failures and OS-confirmed target disconnects receive a matching reclaimable marker; asynchronous sweeps after staging and retirement remove reclaimable runs older than seven days or outside the newest 64 reclaimable runs. Prepared, active, indeterminate, unmarked, malformed, and legacy pre-marker directories are preserved, and cleanup failure remains nonfatal.
- [ ] Add process-identity-aware cleanup for crash-orphaned and legacy pre-marker run directories.
  - The bounded retention policy intentionally fails closed for directories that lack terminal lifecycle proof. Future scavenging must prove that no live producer, injector, or target owns a run before deleting it.
- [ ] If a future target outruns the native observer, add client-owned suspended launch or existing-device/swap-chain adoption instead of executable-specific delays. User-mode near-creation observation improves practical coverage but cannot prove the deterministic pre-entry ordering of `CREATE_SUSPENDED`.
- [ ] Prewarm a canonical immutable cache under `runsRootDirectory` when the packaged SDK runtime and writable run root are on different volumes; cross-volume hard-link fallback still copies each non-mutating artifact on the first target path.
- [ ] Treat post-render attachment as unsupported unless existing-device/swap-chain adoption is implemented and proven. A controlled probe at plus three seconds loaded `ReShade64.dll` into already-rendering D3D11/D3D12 targets but produced no runtime, add-on, API-hook, or Electron-scene initialization.
- [ ] Defer package publishing and installer work until repository-local SDK/client testing closes the remaining acceptance and hardening items.
- [ ] Expand real-client compatibility through additional permitted games; do not infer other-game support from the accepted Gun Frog path or controlled hosts.
- [ ] Run real physical/VM mixed-scale acceptance for target-follow placement; the contract and simulated cross-display tests are complete, but this machine still exposes only one 100% virtual display.
- [x] Isolate production rendezvous and authentication for simultaneous exact-PID target processes.
  - Every exact-PID `attach()` now publishes `electron-overlay-transport-v1.targeted` before writing a unique token and expected PID into the consumed run directory. Revoking the credential leaves that marker in place, so a payload that initializes late fails closed instead of falling back globally; removing the staged run directory removes the marker with it. The injected transport resolves the adjacent route through `ELECTRON_GAME_OVERLAY_RUN_DIRECTORY`, with `RESHADE_BASE_PATH_OVERRIDE` as the injected-runtime fallback, rejects malformed credentials and target-PID mismatch, and pins the selected route. The Node listener validates token plus PID before publishing its scene and can retain multiple authenticated PIDs concurrently.
  - Configured or call-site exact PIDs are snapshotted into the injector invocation before asynchronous work. `attach()` reserves its launcher while session readiness is pending, and session close revokes active or late-completing authorization leases. Rust unit coverage directly verifies missing-local legacy fallback before route intent, marker and invalid-local fail-closed pinning, target binding, and fail-closed reconnect selection after local credential deletion. Node coverage verifies distinct simultaneous credentials on one listener, same-path rejection, cross-PID token rejection, global-token bypass rejection with zero pre-snapshot bytes, scoped socket-loss and reauthentication, independent credential release, and route-intent marker persistence. Independent-producer and end-to-end native poison-global coverage remain follow-up tests. Legacy controlled and low-level launchers fall back to the well-known record only when neither an adjacent credential nor its route-intent marker exists.
  - A local July 28, 2026 D3D11 process-start run recorded PID 15836 authorization before injector spawn, a subsequent target connection, two-window rendering, input acceptance, terminal disconnect, and cleanup. Its evidence remains in the ignored local directory `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260728-222813` and is not part of the repository. The run proves publication and end-to-end operation in the same attempt; it does not independently prove that the Rust client selected the run-local credential instead of the legacy fallback.
- [ ] Add safe texture retirement and per-swap-chain production routing. Multiple swap chains still need explicit resource/input ownership and a primary-surface policy for process-level FPS.
- [ ] Make final target-surface removal a bounded graceful transport drain. OS-confirmed disconnect already clears retained SDK state, but destroying the final swap chain can close the socket before its explicit removal revision reaches Electron.
- [ ] Normalize copied `WM_INPUT` and `GetRawInputBuffer` mouse/keyboard records into the Electron router, including buffered-record target ownership and raw-only text policy.
- [ ] Extend the accepted `WM_POINTER` translation beyond primary mouse move/left click to secondary/X buttons, double-click semantics, pointer wheel, and explicit touch/pen policy, with duplicate-projection tests.
- [ ] Harden observer ordering/recovery and per-swap-chain resource/input ownership for concurrent input pumps or multiple swap chains.
- [ ] Expand the compatibility matrix only from observed evidence: Vulkan/OpenGL, exclusive/fullscreen variants, gamepads, DirectInput/XInput/GameInput, and other backend-specific paths.
- [ ] Keep competitive and anti-cheat-protected targets, anti-cheat bypasses, and VR outside the unsigned full-add-on runtime boundary.

## Retained hudhook follow-ups (historical/deferred)

These items document the completed hudhook experiment and possible upstream work;
they are not the active production-host roadmap.

- [x] Replace hudhook 0.9.1's deferred `WM_INPUT` handle use with a synchronous owned-input seam.
  - The local path patch copies raw mouse/keyboard packets while the receiving WndProc is active, performs foreground `DefWindowProcW` cleanup, and exposes a thread-safe synchronous observer.
  - The project observer owns intercepted mouse/raw propagation and fans one normalized pointer queue to ImGui and Electron. Upstream this narrow patch or replace it with a pinned revision after contribution.
- [ ] Move legacy/raw keyboard and text onto the same owned event queue as pointer input.
  - Pointer delivery is synchronous, while hudhook currently drains copied keyboard messages before `before_render`; a click and following key within one presentation interval can therefore be reordered.
  - Raw-keyboard-only text requires explicit Unicode generation; keep the existing legacy key/character path until that is implemented and tested.
- [x] Add a guarded custom-input-hook teardown phase and bounded process mouse adapter.
  - Ejection now runs outside an active detour, disables every MinHook entry point, drains guarded callbacks, performs fallible WndProc/backend cleanup, and only then calls `MH_Uninitialize()`. Cleanup failure keeps the module pinned.
  - The payload masks mouse buttons from `GetAsyncKeyState`, `GetKeyState`, and `GetKeyboardState`, returns a game-only off-client `GetCursorPos`, and neutralizes `GetRawInputBuffer` mouse records after copying them into the owned overlay queue. The pipeline binds its target HWND and seeds the real client cursor before buffered-only input can arrive. High-bit physical state repairs missing held-button edges; the racy low-bit press hint is ignored so it cannot duplicate a buffered click pair.
  - The raw-buffer behavior follows ReShade's maintained BSD-licensed Win32 implementation. Per-API call/masked counters are reported from the render thread; if Gun Frog still reacts while `raw_buffer_calls` remains zero, stop expanding this adapter and move the backend to ReShade instead of guessing more APIs.
- [ ] Harden runtime ejection and same-process hook retry before exposing either as a supported SDK feature.
  - The current client never calls hudhook's `eject()`; closing the target process is the supported POC teardown.
  - A thread redirected into a detour but suspended before the Rust guard can outlive the current drain barrier. Keep runtime unload out of the public SDK until entry accounting is established at the detour boundary or the DLL is deliberately pinned after deactivation.
  - Make partial DX9/DX11/DX12 hook construction transactional, replace the process-input `OnceLock` bundle with resettable lifecycle state, and make non-owner MinHook removal retry-safe.
- [ ] Prove or reject the bounded polling adapter against Gun Frog and a second real title.
  - Keep DirectInput, other Unity Input System device APIs, XInput, and GameInput as distinct compatibility adapters; do not mark them covered by the User32/raw-buffer proof.
  - If either title requires one of those broader paths, record the counter evidence and evaluate a ReShade add-on host rather than growing an open-ended local hook matrix.
- [x] Remove manual graphics-backend selection from the active client path.
  - The selected ReShade host identifies the target graphics API; applications arm one process name and no longer choose a D3D11 or D3D12 payload. The former hudhook auto-detection task is retained only as historical context and will not be implemented in the inactive path.

## Production package boundary

- [x] Promote the active native implementation into owned Nx packages.
  - `libs/electron-overlay-transport` owns the backend-neutral Rust engine and
    C ABI.
  - `libs/electron-game-overlay-runtime` owns the Windows ReShade injector,
    add-on, controlled hosts, patches, and test launchers.
  - `libs/electron-game-overlay` owns the public TypeScript/Electron SDK and
    stages the runtime as a build dependency.
  - The superseded binary runtime and native Node add-on packages have been
    removed; they are not future modernization targets.
- [x] Remove unused pre-release SDK compatibility surface and make instance
      ownership explicit.
  - The always-throwing `findWindows()` and `attachToProcess()` methods are no
    longer public APIs; target selection belongs to `ReShadeOverlayLauncher`.
  - Each `ElectronGameOverlay` owns an independent transport and allows one live
    session. Closing it releases the slot for a new session on the same overlay
    instance.
  - Independent instances cannot overwrite the process-wide discovery record:
    one transport owns the fixed endpoint until stop, and failed startups
    release that ownership for retry.
  - Created and attached Electron windows no longer focus on `ready-to-show`
    unless the caller opts in with `focusOnReady: true`; the option defaults to
    `false`.

## Diagnostics and logging

- [x] Replace direct SDK launcher console markers with typed lifecycle events.
  - `ReShadeOverlayLauncher.onEvent()` publishes immutable `runtime-staged`,
    `target-rendezvous-authorized`, `injector-started`, `injector-returned`,
    `injector-failed`, `target-connected`, and `target-disconnected` records.
    Handler failures are isolated and the subscription returns an idempotent
    unsubscribe function.
  - The old SDK marker constants and direct lifecycle marker output are gone.
    Stable markers retained by demos and test runners are client-owned
    formatting over these events.
- [x] Add bounded typed diagnostics for the SDK launcher/injector attachment
      boundary.
  - Injector preflight, injector execution/result validation, runtime connection
    timeout, and lifecycle cancellation/disconnect failures now carry stable
    `ReShadeDiagnosticCode`, `ReShadeDiagnosticStage`, and
    `ReShadeRetrySafety` values. Staged failures retain applicable evidence
    paths.
  - Success requires one strict structured injector result and exposes
    `injected-runtime` versus `existing-runtime`. Failure after claiming a
    compatible host gate is reported as the post-mutation
    `existing-runtime-addon-load-failed` runtime-initialization stage.
- [x] Forward bounded authenticated diagnostics from the injected runtime.
  - A versioned strings-free C ABI record now publishes eight fixed runtime,
    swap-chain, first-scene, scene/frame/upload, and input observations through
    a dedicated 32-record queue without dropping input, control, or telemetry.
  - The Node boundary validates the exact packet, supplies the authenticated
    PID, owns severity/message text, rate-limits each code per connected target,
    and never forwards the packet through the generic native-event callback.
    Invalid runtime records fail closed as `invalid-runtime-diagnostic`.
  - Render/input failure publication has a native 7.5-second per-code cooldown
    in addition to the Node rate limit, so alternating good/bad frames cannot
    cross the C++/Rust IPC boundary at render rate. `DllMain`, the
    allocation-free input producer, and failures before IPC connection retain
    local-only `ReShade.log` coverage.
  - The production client/SDK process-start gates observed authenticated
    runtime-ready, swap-chain-ready, and first-scene diagnostics on D3D11 and
    D3D12 and exited normally on July 30, 2026. Local evidence is under
    `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-111004`
    and
    `build/electron-game-overlay-runtime/client-sdk-d3d12-process-start-20260730-111018`.
- [x] Add bounded producer-side Electron window, frame, and input diagnostics.
  - Six fixed `electron-game-overlay` codes distinguish successful window
    registration and first-frame publication from window publication, frame
    rejection/publication, and input-forwarding failures. Severities and
    messages are code-owned. Context accepts only validated window IDs, fixed
    operation/stage or rejection values, bounded frame dimensions, and an
    allowlisted OS error code.
  - Producer records use a 32-entry asynchronous queue and a 7.5-second
    per-PID/code/window/variant cooldown, with PID omitted for window/frame
    records and rate state retired on target or final-window removal. The
    asynchronous boundary prevents diagnostic listeners from re-entering a
    partially committed window lifecycle. Input failures receive the
    authenticated target PID and allow window ID `0` for focus reset.
  - Window/control packets are encoded before retained transport state mutates,
    and session geometry/raster state advances only after backend publication
    succeeds. Translation, focus/blur, and Chromium dispatch exceptions are
    diagnosed and contained instead of escaping as `packet-handler-failed` and
    tearing down the authenticated target connection.
  - The production client process-start gates require registration and
    first-frame producer milestones and reject any producer warning/error.
    Clean D3D11 and D3D12 evidence is preserved in
    `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-120110`
    and
    `build/electron-game-overlay-runtime/client-sdk-d3d12-process-start-20260730-120149`.
- [x] Preserve fixed run-local startup evidence before authenticated runtime
      IPC exists.
  - The Rust bridge atomically records only schema version, fixed source,
    target PID, and an allowlisted startup code in each isolated SDK run. Codes
    distinguish bridge creation, discovery readiness/validation, target
    binding, loopback setup, network-worker startup, and pre-auth disconnect.
  - Attachment timeout reads are bounded, require the exact schema and selected
    PID, and produce only a code-owned `runtimeStartupCode` and message. The SDK
    does not parse or forward arbitrary `ReShade.log` content.
  - Controlled process-start gates require a matching
    `network-worker-started` record for D3D11 and D3D12. Initialization before
    the add-on reaches the Rust bridge remains local ReShade evidence.
  - All four injected-runtime and compatible shared-runtime production
    client/SDK gates passed that record requirement on July 30, 2026. Evidence
    is under
    `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-131543`
    and `client-sdk-d3d12-process-start-20260730-125958`, plus
    `client-sdk-d3d11-shared-runtime-20260730-130358` and
    `client-sdk-d3d12-shared-runtime-20260730-130412` in the same build root.
- [ ] Improve error logging and diagnostics across every overlay layer.
  - Current issue: failures can happen in multiple places: Electron SDK code,
    runtime staging, injector launch, DLL injection, authenticated transport,
    graphics API hook setup, frame upload, input forwarding, and per-game
    rendering. Today those failures are hard to distinguish, which makes
    agent-driven debugging and user support slow.
  - Desired direction: make every layer report structured diagnostics with enough context to identify where the failure occurred and what the next action should be.
  - The completed launcher/injector, injected-runtime, and Electron-producer
    slices above cover attachment, authentication, render milestones,
    scene/frame upload, native input routing, producer registration/frame
    publication, contained Electron input-forwarding failures, and fixed
    pre-auth transport-bridge startup evidence. Initialization before the
    add-on reaches that bridge still needs richer structured coverage.
  - The SDK now exposes a frozen `session.on("diagnostic")` contract. The Node
    loopback transport emits bounded, redacted startup/discovery,
    authorization/authentication, authenticated-packet, socket, and
    process-inspection observations; the demo retains the latest record, logs
    it, and shows warnings/errors in the always-visible control dock. Discovery
    credentials, raw packets, executable paths, stacks, and arbitrary error
    messages are excluded. Authenticated native `game.diagnostic` publication
    covers the fixed injected-runtime codes, while SDK-owned producer records
    are canonicalized and delivered locally without crossing target IPC.
  - Producer raster-recovery diagnostics remain open: renderer DPR/viewport
    acknowledgement timeouts, capture-size mismatches, and `capturePage()`
    failures still retry and retain their existing console warnings.
  - Redesigning the control side of `BackpressurePacketQueue` with a global
    memory/count bound remains separate work. This slice makes publication
    transactional and contains synchronous socket-write failures; it does not
    claim a fully bounded outbound control queue.
  - Completed: every authenticated `game.input` record is parsed before PID
    attachment or SDK forwarding. Only the exact legacy fields
    `type/windowId/msg/wparam/lparam` and optional `scaleFactorMicros` are
    accepted; window and scale IDs are positive uint32 values, `msg` must be in
    the native producer's routable Win32 message set, `wparam`/`lparam` are
    uint32, extra fields and wire-supplied PID are rejected, and PID comes only
    from the authenticated socket. Window metadata rejects zero IDs and scales
    before native routing. A malformed record closes that target connection with
    fixed `invalid-game-input` evidence instead of reaching translator state or
    Electron. Only an omitted legacy scale uses the active-window fallback; a
    malformed scale is rejected.
  - The D3D11 and D3D12 production process-start gates passed the strict input
    boundary on July 30, 2026. Both forwarded intercepted Escape, kept the host
    alive, and emitted no `target-packet-rejected` diagnostic. Evidence is under
    `build/electron-game-overlay-runtime/client-sdk-d3d11-process-start-20260730-134210`
    and
    `build/electron-game-overlay-runtime/client-sdk-d3d12-process-start-20260730-134224`.
  - Stock/differently patched ReShade and arbitrary modded-game coexistence
    remain the explicit compatibility task under “Runtime compatibility and
    hardening”; producer diagnostics do not expand that support envelope.
  - Suggested logging layers:
    - `electron-game-overlay`: typed events such as `session.on("diagnostic", ...)`, attach results, window registration state, frame send failures, focus/input forwarding failures.
    - `electron-overlay-transport`: rendezvous, authentication, producer/target
      connection state, packet validation, scene publication, and input routing.
    - `electron-game-overlay-runtime`: staged asset paths, injector arguments and
      results, target identity, graphics backend, hook/runtime initialization,
      swap-chain creation, frame composition, and input-intercept state.
  - DLL logging options: write to `OutputDebugString` for DebugView/Visual Studio, write rotating log files under a configurable temp/app-data directory, or send diagnostic IPC messages back to the host when the IPC link is available. Before IPC is connected, the DLL should still log locally so early injection/hook failures are not lost.
  - Possible API shape: `new GameOverlay({ logger, logLevel, diagnostics: true })`, `session.on("diagnostic", event => ...)`, and a stable diagnostic event schema with `layer`, `code`, `severity`, `message`, `context`, and optional `windowsErrorCode`.
  - Agent workflow goal: when a user reports "nothing appears", logs should show whether the failure is asset copy, injection launch, DLL load, IPC connect, graphics hook, window registration, frame upload, or game compatibility.
