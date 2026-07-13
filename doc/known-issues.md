## Known compatibility issues

Since we need to inject a dll into an existing game process, it will definitely has some compatible issues.

known issues:

### Current ReShade migration support envelope

The production Windows runtime uses ReShade 6.7.3 full add-on support. Its
controlled D3D11 and D3D12 input gates passed on July 12, 2026: overlay controls
remained interactive, game-side message/raw/polling counters stayed frozen,
cursor confinement was released while intercepting, resize preserved the gate,
and release restored normal input. The D3D11 and D3D12 ReShade compositors now
also render the real ordered multi-window Electron scene and route exact mouse
and keyboard records through the shared Electron transport engine; click-to-front, typing,
and caption dragging passed without new game-side oracle activity. The oracle
now enables Windows mouse-in-pointer and requires `WM_POINTER` update/down/up
counters to stay frozen too. Gun Frog passed its initial corrected gate on July
12 and an exact four-button menu/release gate on July 13, 2026. The production
Electron client and public SDK now use the ReShade launcher for the accepted
process-name, arm-before-launch Gun Frog path. The same production path also
passed two fresh controlled D3D12 lifecycle/multi-window cycles and a separate
same-Electron-client restart/reinjection cycle. The public SDK additionally
accepts an optional exact PID, and the Electron demo exposes the same field, for
a watcher that injects immediately after the process exists and before graphics
device/swap-chain creation. Deterministic `CREATE_SUSPENDED` D3D11/D3D12 gates
passed that ordering on July 13, 2026. Arbitrary unsuspended watcher timing and
games beyond Gun Frog remain unverified.

The normal `npm run dev` Steam-path flow now has a real Gun Frog acceptance as
well. The previous reactive WMI path could report successful injection after
Gun Frog had already created its primary DXGI swap chain, leaving no overlay to
render. The replacement native watcher was armed before launch, ignored
`UnityCrashHandler*.exe`, and selected the absolute `Gun Frog.exe` path. It
attached to PIDs 22640 and 8732 across close/relaunch with the same Electron
client. Both runs logged `CreateSwapChainForHwnd`, authenticated the transport,
and rendered their first transported scenes. Visual inspection confirmed the
compact information dock, the expanded Ctrl+I launcher, and the full main
Electron test window in the game.

That initial success still missed a Windows PID-reuse defect. The watcher kept
its startup baseline as bare numeric PIDs, so a later process that reused any
baseline PID was incorrectly treated as the old process forever. A real
same-client rerun reproduced the reported intermittent no-overlay launch: Gun
Frog matched `\\steamapps\\`, but the armed injector never selected it and
ReShade was absent from the process. The watcher baseline now retains a handle
to each exact startup process object instead. A July 13 final verification kept
one Electron client alive while Gun Frog PID 19052 was launched, closed, and
relaunched as PID 22644. Both runs selected the game, loaded the D3D11
runtime/add-on, published target telemetry/FPS, and rendered the dock. On the
second run Ctrl+I opened the
intercept menu and clicking `Open status window` rendered that Electron surface
inside Gun Frog while input was captured; closing the game left another watcher
armed for the next launch.

Those results cover sequential launch/relaunch after the watcher is genuinely
running. The current `STEAM_GAME_AUTO_ATTACH_ARMING` log is a request marker,
not a native-ready acknowledgement: session readiness, runtime staging, and
injector spawn still follow it. The one-shot watcher also rearms only after the
selected process authenticates, so another matching process launched during
that interval may be present in the next baseline and be skipped. A surfaced
native-ready handshake and continuous or duplicate-safe selection stream remain
hardening work before claiming overlapping or general multi-process Steam game
support.

New runs use `build/electron-game-overlay-runtime`. All dated
`build/reshade-imgui-overlay/...` paths in this document are historical
pre-promotion evidence and are intentionally retained only as records.

The first injected Gun Frog run is a recorded failed gate, not acceptance:
Electron received and rendered a full click while the same physical click also
activated Unity's underlying `Continue` control. Gun Frog uses Unity 6 with
`Unity.InputSystem.ForUI`, and `UnityPlayer.dll` enables mouse-in-pointer. The
controlled hosts reproduced the split: ReShade froze legacy/raw/polled input but
allowed `WM_POINTERUPDATE/DOWN/UP`. A pinned compatibility patch now suppresses
that `PT_MOUSE` client-pointer projection and updates ReShade's managed mouse
state. The add-on captures pointer metadata without mutating route state, then
converts primary move/left-click records into one Electron legacy stream only
after global sequence ordering on the single consumer. Native ImGui and Electron
both passed this regression on controlled D3D11 and D3D12. The subsequent Gun
Frog rerun clicked Electron directly above Unity's `Continue` control; Electron
received the complete click while the game stayed on its menu. Text, z-order
changes, and caption drag also passed. The manual release control produced the
disable acknowledgement; the next click on Continue entered gameplay, proving
normal pass-through restoration. Normal shutdown then closed the real-game
input gate.

The July 13 strengthened acceptance placed Electron controls exactly over Gun
Frog's Continue, New Game, Settings, and Quit buttons. All four emitted distinct
`HUDHOOK_CLIENT_MULTIWINDOW_INPUT ... event=gun-frog-click name=<...>` records
while Unity remained on the menu and the process stayed alive. Manual release
then emitted `RELEASE_REQUESTED`, `INTERCEPT_DISABLED`, and
`LIFECYCLE_COMPLETE`; a click at the same underlying Quit position closed Gun
Frog only after interception was disabled. This is the current exact real-game
menu acceptance boundary.

The production client/SDK gate passed the same boundary through
`libs/electron-game-overlay-runtime/scripts/test-cases/gun-frog-client-sdk.ps1`.
The
built client armed for `Gun Frog.exe` before launch, received a positive input
interception acknowledgement for PID 11104, and clicked the aligned Continue,
New Game, Settings, and Quit Electron controls once each while Gun Frog stayed
alive on its menu. Ctrl+I produced the negative acknowledgement, then the same
Quit position closed the game. The runner emitted
`GUN_FROG_REAL_CLIENT_INPUT_GATE_PASS`; evidence is retained under
the historical pre-promotion path
`build/reshade-imgui-overlay/client-Gun-Frog-20260713-005018` and
`%TEMP%/electron-game-overlay/reshade-runs/Gun-Frog.exe-yE20tq`. The persisted
client-run `result.txt` contains the same pass marker.

The controlled production client/SDK D3D12 gate passed twice through
`libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk.ps1`
against PIDs
17248 and 13528. Both Electron windows accepted text and focus, the main caption
moved and remained clickable at its new coordinates, the target stayed
foreground, and its complete input title remained byte-identical during
interception. After release, legacy down/up, raw input, and primary `PT_MOUSE`
pointer counters advanced, cursor confinement returned, and released Escape
closed each target normally. The runner force-cleaned the isolated Electron tree
between attempts, used two distinct ReShade run directories, left no test
processes, and emitted `D3D12_REAL_CLIENT_SDK_GATE_PASS`. Evidence is retained
under the historical pre-promotion path
`build/reshade-imgui-overlay/client-sdk-d3d12-20260713-083630`. Current runs use
`build/electron-game-overlay-runtime`.

That controlled host uses a test-only injection-wait marker before its unusually
fast D3D12 initialization. It validates the prearmed SDK launcher and automatic
ReShade D3D12 selection for a cooperating target, not general injection timing.
Forced client cleanup plus a fresh launch is accepted here; graceful client
disable/unload remains open.

The same-client gate passed through
`libs/electron-game-overlay-runtime/scripts/test-cases/d3d12-client-sdk-reinjection.ps1`.
Electron PID 17756 attached to target PIDs 19764 and 17940 in sequence. The
launcher correlated each authenticated transport with the injector-selected
PID. Socket close emitted a transient transport-loss event and retained the
injection latch; only OS-confirmed process exit emitted the terminal disconnect
that returned the SDK and frontend to `idle`. Client-originated lifecycle
messages are reserved and rejected. Outcomes after the injector may have
spawned remain `blocked` until launcher disposal when no target PID exit can be
proven. The runner emitted `D3D12_REAL_CLIENT_SDK_REINJECTION_GATE_PASS`;
evidence is retained under
the historical pre-promotion path
`build/reshade-imgui-overlay/client-sdk-d3d12-reinjection-20260713-110105`.

The exact-PID process-start gates passed through the real frontend and public
SDK. D3D11 targeted PID 7428, reached the frontend click 72.393 ms after process
creation, and emitted
`D3D11_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d11-process-start-20260713-131623`.
D3D12 targeted PID 21508 at 84.061 ms and emitted
`D3D12_REAL_CLIENT_SDK_PROCESS_START_INJECTION_GATE_PASS`; evidence is under
`build/reshade-imgui-overlay/client-sdk-d3d12-process-start-20260713-131642`.
Both proved the exact injector arguments and ReShade loading before
`ResumeThread`. Transport, API selection, two Electron windows, and input passed
after resume; both targets exited 0, both frontends returned to `idle`, and no
test process remained.

Exact PID narrows selection but does not make post-render injection work. In a
controlled probe, the injector ran three seconds after D3D11 and D3D12 targets
were already rendering. It returned success and `ReShade64.dll` was present in
each process, but there were no graphics-API redirect, runtime-initialization,
add-on-load, or first-scene markers. The pinned runtime did not adopt the
existing device or swap chain, so this route is unsupported. Evidence is under
`build/reshade-imgui-overlay/late-injection-probe-20260713-114753`.

The native path watcher's ignore-baseline now retains exact process handles,
closing the sequential relaunch defect above. Exact-PID requests and the demo's
WMI lifecycle correlation still identify targets by PID plus verified executable
basename; a creation token is not yet carried end to end. Delayed WMI events
across PID reuse therefore remain a lifecycle-hardening item. The suspended
gates also establish ordering, not an arbitrary safe delay for a normal running
process. Package publishing is intentionally deferred while the repository-built
client and SDK remain under local acceptance testing.

The accepted Gun Frog shutdown emitted a non-fatal ReShade warning about an
inconsistent `ID3D11Device3` reference count. There was no crash,
target-directory log, input ordering fault, or router reset. Treat the warning
as recorded resource-retirement/unload hardening rather than an input-gate
failure.

The runtime now publishes target HWND, render/client/window geometry, DPI,
monitor bounds, graphics API, state, and real injected FPS to the SDK. The
SDK's `followTarget()` layout uses that physical geometry and has simulated
cross-display/scale coverage. Real mixed-scale hardware or VM acceptance is
still outstanding. The public `fullscreen` value is a geometry-derived signal
that the client covers its monitor, not proof of DXGI exclusive-fullscreen
state.

For this project, **Steam-like** describes the behavior required inside an
explicitly supported target: passive mode leaves game input unchanged; intercept
mode keeps the Electron/ImGui overlay fully interactive, releases game cursor
confinement/recentering, prevents the game from observing the same mouse and
keyboard activity, and restores normal input on release, focus loss, transport
failure, or shutdown. It does not claim Steam's code signing, launcher ownership,
anti-cheat relationships, compatibility database, or universal game coverage.

The initial candidate envelope is Windows x64 with controlled D3D11 and D3D12
hosts, followed by permitted offline/single-player applications. These cases are
not supported by the current production runtime:

- competitive, anti-cheat-protected, protected, or otherwise restricted
  processes; no stealth or anti-cheat bypass work is in scope;
- target/runtime integrity-level mismatch or an elevated target launched from
  a lower-integrity client;
- x86 targets and VR runtimes (`reshade_overlay` is not invoked for VR);
- Vulkan, OpenGL, D3D9, unusual/exclusive presentation paths, multiple swap
  chains, and multiple simultaneous targets until each has an explicit test;
- coexistence with an existing ReShade installation or another proxy DLL until
  conflict detection and a supported installation strategy are implemented;
- real physical/VM mixed-scale target-follow acceptance, safe texture
  retirement, or broader gamepad/DirectInput/XInput/GameInput handling until
  their recorded acceptance work is complete.

Unsupported or untested must produce a clear diagnostic rather than silently
claiming compatibility. Maintain a matrix per target with architecture,
integrity level, graphics API, presentation mode, runtime load result, overlay
input result, game-input suppression result, and required workaround.

ReShade's managed ImGui context samples button and key state once per `Present`.
The Electron path does not rely on that sample: a pinned passive full-add-on
observer copies already-blocked records into the project-owned bounded queue.
Exact legacy window-message delivery and ordered primary `PT_MOUSE`
`WM_POINTER` move/left-click translation are accepted on D3D11 and D3D12.
Captured Ctrl/Shift state is preserved. Copied `WM_INPUT` and
`GetRawInputBuffer` records are currently retained/countable but are not yet
normalized into Electron events. Touch/pen, secondary/X pointer buttons,
double-click semantics, pointer wheel, concurrent input pumps, multiple swap
chains, and raw-only input/text therefore remain explicit runtime hardening.
Target FPS is currently process-scoped and sampled per observed swap chain, so
multi-swap-chain support also needs an explicit primary-surface policy. Final
swap-chain destruction can race the asynchronous explicit surface-removal
packet; OS-confirmed process disconnect still clears retained SDK target state,
while bounded graceful transport draining remains a lifecycle hardening item.

#### Overlay runtime issues to fix

- [x] Reassert Chromium page focus before forwarding input to an offscreen overlay.
  - Root cause: Electron 16's offscreen `WebContents.focus()` path is a no-op and its OSR view reports itself unfocused. Calling it before `webContents.sendInputEvent(...)` did not focus Chromium's render widget.
  - Resolution: `OverlaySession` now calls `BrowserWindow.focusOnWebView()` immediately before every forwarded packet. This is the Electron 16 OSR-specific page-focus path and does not activate the hidden native window or take foreground ownership from the game.
- [ ] Overlay compatibility is not universal across all games.
  - Source / likely cause: the production ReShade runtime proves controlled
    D3D11 and D3D12, but that does not establish every graphics API,
    presentation path, or launch timing a game can use, such as Vulkan, OpenGL,
    unusual swap-chain modes, exclusive fullscreen behavior, multiple swap
    chains, protected/anti-cheat processes, elevated integrity processes, or
    arbitrary fast-start D3D12 games. Steam Overlay can appear universal because
    Steam owns the launcher/runtime integration, has broad backend support, and
    can carry a large compatibility database and per-game handling over time.
  - Current direction: let ReShade own the maintained graphics/input host rather than expanding private hudhook detours. Expose runtime and hook status through the SDK, fail clearly for unsupported or partially hooked targets, and add backends/presentation modes only with explicit acceptance evidence. Keep the compatibility matrix described above.

#### Origin overlay and Steam overlay

It can work together with Steam overlay, but unfortunately did not work with Origin overlay.

The coexistence statement and game list below describe the legacy overlay runtime
and are not compatibility claims for the active ReShade client host.

#### Games that I played and tested

Some of the games can use multiple versions of graphics API, make sure set graphics api to one of dx9, dx10, dx11

- [x] League of Legends
- [x] Dota 2
- [x] CS:GO
- [x] Team Fortress 2
- [x] Life Is Strange
- [x] Ori
- [x] GTA 5
- [x] Fallout 4
- [x] Rise Of The Tomb Raider
- [x] Guts and Glory
- [x] PlayerUnknown's Battlegrounds
- [x] Life is Strange Before the Storm
- [x] Child of Light
- [x] Borderlands 2
- [x] Cuphead
- [x] Witcher 3
- [x] WORLD OF FINAL FANTASY®
- [x] Left 4 Dead 2
- [x] Tom Clancy's The Division
- [x] Tom Clancy's Rainbow Six Siege
- [x] Half-Life 2

#### games that have issues for now

- [ ] Battlefield 1
- [ ] Star Wars battlefront 2
