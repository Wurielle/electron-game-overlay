# Pinned ReShade source patches

These patches apply only to the ReShade 6.7.3 commit pinned by this production
runtime and are applied as an ordered stack.

## `reshade-owned-composition-window-eligibility.patch`

Generation 34 omits nonactivating or topmost/layered captionless tool popups that
do not declare APPWINDOW from owned null-HWND inference. It preserves captioned
tools, plain frameless tools, explicit application windows and ordinary peers;
real peer ambiguity still refuses binding. Valid native HWND behavior is intact.
This addresses the exact tooltip/uniqueness/reset chain captured in actual
high-PAGER 1010. No class/game preference, sleep, retry or permission change is
introduced. See `doc/composition-window-eligibility.md` for native controls and
the paired composition-host popup/marker contract for actual input/pixel tests.

## `reshade-owned-composition-binding-diagnostics.patch`

Generation 33 adds bounded exact binding-rejection and reset call-site records to
the owned generation-32 host. It changes no window eligibility, lifetime/reset
policy or forwarding behavior. The five-file tail preserves the full 26-file
inventory and all preceding raw patch pins. Each observer has a 24-attempt budget,
preserves `GetLastError`, catches log failures and performs no COM calls or input.
See `doc/composition-binding-reset-diagnostics.md`. This is a diagnostic candidate
for the unresolved intermittent high-PAGER reset, not an asserted behavior fix.

## `reshade-owned-composition-policy.patch`

Generation 32 adds an owned-host-only D3D11 null-HWND fallback to the single
visible top-level window in the exact process, with lifetime-token validation
and ambiguity refusal. Deferred initialization and normal reset/reinitialization
retain surface/input lifecycle boundaries. Valid native HWND paths remain intact.
Reserved configuration in the validated owned stage stays in memory, including
the global INI dirtied by a secondary runtime. The patch never changes stage
permissions or foreign installations. Its eight-file tail validates the complete
26-file stack before each atomic publication. See
`doc/owned-composition-and-exit-recovery.md` for scope and separate console and
actual graphics acceptance. The feature add-on bytes/build ID are unchanged.

## `reshade-d3d11-swapchain-resource-identity.patch`

Generation 29 installs the existing D3D11 resource `GetDevice` compatibility
hook before `DXGISwapChain::GetBuffer` returns a D3D11 resource. DXGI composition
back buffers can be imported before the application creates an ordinary texture;
without this step they expose the original device while ANGLE holds its proxy.
The existing Media Foundation video-support exception and unwrapped device
behavior are retained. The console/offscreen identity fixture reproduces the
generation-28 mismatch and checks both architectures independently of consumer
and game acceptance.

The patch changes the owned ReShade host, with an exact digest in its build
stamp and sealed SDK validator. The EGO feature add-on implementation and build
ID are unchanged. Existing third-party ReShade installations are never replaced.

## `reshade-injector-private-stage-diagnostics.patch`

Generation 30 adds failure-only fixed artifact/operation diagnostics around the
existing private elevated stage checks. It preserves the original Windows error,
`GetLastError`, restrictive read guards, authorization and refusal decisions.
The console helper fixture forces actual owned file and directory sharing
conflicts; it does not establish the cause or resolution of the consumer's
particular high x86 failure.

## `reshade-steam-loaded-module-hook-order.patch`

Generation 30 retains ReShade's environment-based Steam loader-hook selection
and also recognizes the architecture's already-loaded renderer DLL in the exact
current process. Missing optional environment metadata must not select the DLL
notification path when that renderer is already present. No renderer is loaded
by this check, and it adds no delay, executable heuristic or game exclusion.

The dedicated owned console factory model retains the generation-29 missing-key
failure and exact-name/environment/no-model controls. It is not Valve code or
actual Steam/Overwatch acceptance. Later-renderer ordering remains a separate
limitation; this narrow correction does not claim to fix every load order.

## `reshade-compatibility-snapshot.patch`

Generation 31 adds at most 17 read-only records for the actual loader selection,
early factory discovery scope, native callback registration and first non-TEST
proxy/raw Present/Present1. Callback address ownership and at most two recognized
entry jumps are observed without executing them or dumping bytes. Unsupported or
unreadable entries remain unknown. Records contain no paths, tokens or environment
values. Logging failures and GetLastError are isolated from forwarding.

The exact 23-file source inventory includes five restartable diagnostic tail
files. The source-cache gate tests every partial publication boundary and unknown
edit/file/patch refusals. Real owned foreign-hook fixtures verify module/jump
roles, saved trampolines, once-only records, native forwarding and unchanged
references on both architectures. These are diagnostics, not an Overwatch fix
or evidence of actual Steam frames. See `doc/bounded-compatibility-snapshot.md`.

## `reshade-input-observer.patch`

Advances the local full-add-on API from 18 to 19 and adds a passive
`input_message` event after ReShade has decided to suppress an input record. The
callback receives an immutable copied POD. It cannot consume, unblock, or change
ReShade's decision, and transient `HRAWINPUT` pointers are never exposed for
deferred use.

The Electron add-on publishes the POD and any synchronously captured pointer
metadata to a bounded lock-free queue and performs routing later on the render
callback, outside ReShade's input and window locks. Pointer down/up state is
interpreted only after the single consumer sorts the global observer sequence.
Legacy blocked window messages are routed exactly. For `WM_INPUT`, the runtime
copies the transient `RAWINPUT` payload before the callback and never exposes
the `HRAWINPUT`. It mirrors mouse and keyboard registrations only after the real
`RegisterRawInputDevices()` call succeeds. A raw device class becomes
authoritative for Electron only when its exact source HWND is registered with
`RIDEV_NOLEGACY`; otherwise the copied raw record is ignored and the legacy
window-message route remains authoritative. The later registration-
reconciliation patch replaces this base patch's incremental registration map
with authoritative target-process snapshots.

The patch also normalizes blocked `GetRawInputBuffer()` records. Because a
buffered record has no HWND, each device-class batch is eligible only when
there is exactly one successful `RIDEV_NOLEGACY` registration on the calling
thread under the foreground root, a blocking render input can be selected under
that same root, and the registration generation remains unchanged. Mouse input
also requires a valid client-space cursor position. No candidate, multiple
candidates, a stale registration, background input, or an invalid mouse route
is ambiguous and fails open: ReShade leaves that record unchanged for the game.
Only records ReShade actually neutralizes are copied to the add-on.

## `reshade-raw-input-normalization.patch`

This is a terminal migration delta from the exact previous observer-plus-pointer
input stack to the current raw-input implementation. A clean pinned ReShade
checkout already receives the current implementation from
`reshade-input-observer.patch`; this patch exists so an older ignored fetched
tree can migrate without being deleted. Its authoring paths intentionally
require `git apply -p2`. A reverse-applicable check means the fetched tree is
already current; otherwise only the exact older final input state may apply it
forward. Exact normalized source hashes verify the result.

## `reshade-raw-input-registration-reconciliation.patch`

Seeds the pinned runtime's raw-input registration state from
`GetRegisteredRawInputDevices()` before the first registered render HWND can
route input. This recovers mouse and keyboard registrations created before late
injection, which the runtime's `RegisterRawInputDevices()` hook could not have
observed. Later registration calls are serialized with snapshot publication;
an odd generation denotes an update in progress, and routing accepts a snapshot
only while its authoritative even generation remains unchanged.

An exact non-NULL target retains the established HWND route. A
`hwndTarget = nullptr` registration is treated as Windows' focus-following
registration: queued `WM_INPUT` accepts it only for the calling GUI thread's
exact focused foreground HWND, and buffered input resolves it through that same
thread focus before applying the existing foreground-root and single-owner
checks. A transient Win32 query failure clears authority and can retry no more
than once per second; stable unsupported or duplicate device-class state stays
invalid until another hooked registration mutation triggers a new snapshot.
Query failure, concurrent update state, missing focus, generation change, or
ambiguous ownership fails open. In those cases the runtime neither neutralizes
the raw record nor projects it into Electron.

This is an internal pinned-runtime bookkeeping change. It does not change local
add-on API 19, private host ABI 1, the published transport C ABI or wire schema,
or the public Node SDK API.

## `reshade-raw-input-focus-following-root.patch`

Layers exact device-class provenance over registration reconciliation. A queued
record derived from `hwndTarget = nullptr` may select only the most recently
rendered input manager under the focused source's normalized `GA_ROOT`; no
candidate under that root fails open. The source and focused HWND must belong to
the calling GUI thread and process, the root must be foreground, and queued raw
input additionally requires `RIM_INPUT` plus exact focus. Promoted mouse pointer
messages require a non-null focus under the same foreground root.

The patch resolves `WM_INPUT`'s actual mouse/keyboard class from `RID_HEADER`
before fallback selection. A NULL bit takes the root-constrained route, an exact
source-HWND bit retains the established process-wide render fallback, and no bit
for that class fails open before any input state is mutated. It is incremental
over the preceding reconciliation patch so an exact schema-22 fetched tree can
migrate without replacement.

## `reshade-injector-base-path.patch`

Sets `RESHADE_BASE_PATH_OVERRIDE` inside the target to the injector directory
when injecting a new runtime, so configuration, add-ons, and logs stay in an
isolated stage instead of the game directory. Compatible shared-runtime reuse
leaves the host's ReShade base path unchanged and routes only this project's
transport through `ELECTRON_GAME_OVERLAY_RUN_DIRECTORY`. The patch also removes
the upstream 50 ms post-discovery delay: the Gun Frog Unity swap chain was
created inside that delay, before the runtime could attach.

## `reshade-injector-exact-pid.patch`

The original `inject.exe <exe name>` prelaunch watcher remains available. An
exact-target form, `inject.exe <exe name> --pid <uint32>`, instead opens and holds
only that PID, then verifies the opened process image's actual basename before
performing any remote write or creating a remote thread. Strict decimal parsing
rejects zero, signs, whitespace, overflow, and trailing characters. Exact-PID
failures that occur before a remote thread is created print the stable
`ReShade injection not started.` line; its absence is deliberately not evidence
that injection succeeded.

## `reshade-injector-name-watcher-ready.patch`

Adds the stable, flushed `ReShade process watcher armed.` line to the name-only
prelaunch watcher immediately before it begins scanning. The Node launcher
converts this native handshake into a distinct watcher-readiness event, so an
application can launch its target only after the watcher can observe it. Exact-
PID injection does not emit this marker; the path watcher retains its existing
`ReShade path watcher armed.` marker.

## `reshade-pointer-input-block.patch`

Adds client `WM_POINTERUPDATE`, `WM_POINTERDOWN`, `WM_POINTERUP`, enter/leave,
and wheel messages to ReShade's mouse-input classification only when
`GetPointerInfo` identifies `PT_MOUSE`. It also updates ReShade's managed cursor,
five-button, and vertical-wheel state before suppression, keeping native ImGui
interactive. Unity 6's `InputSystem.ForUI` enabled this second Windows mouse
projection, allowing the same physical click to reach Unity after ReShade had
already blocked and copied the legacy projection.

The Electron add-on converts the accepted primary pointer move/left-click stream
into one legacy route after suppression and global sequence ordering. It carries
pointer ID, target, type, and Ctrl/Shift state in the queued copy. Touch and pen
remain unblocked/unconverted. Secondary/X buttons, double-click semantics, and
pointer wheel normalization remain explicit runtime hardening. If the exact
target has an authoritative `RIDEV_NOLEGACY` raw-mouse registration, the raw
stream owns the physical action and the corresponding promoted mouse-pointer
copy is discarded to prevent duplicate Electron clicks.

## `reshade-injector-path-watcher.patch`

Adds a one-shot `inject.exe --path-contains <fragment>` prelaunch watcher that
snapshots and ignores processes already present when armed, then polls new
processes every 50 milliseconds and resolves new candidates' absolute
executable paths. Path
matching is case-insensitive and treats forward and backward slashes equally.
Repeatable `--exclude-name <exe basename>` arguments skip helper processes such
as Unity crash handlers before selection. The watcher flushes a stable armed
line immediately and reports the matched absolute path before the existing
matching-PID line. Failures that are still safe to retry emit the existing
`ReShade injection not started.` marker.

## `reshade-injector-path-watcher-process-identity.patch`

Layers over the path watcher and changes its startup baseline from bare process
IDs to retained process handles keyed by PID. A retained handle identifies the
exact process object and becomes signaled when that process exits; the watcher
then closes and removes it before examining later candidates. Windows PID reuse
therefore cannot make a replacement process look like the old baseline process.
The same retained handles avoid reopening every ignored process on each poll.
This patch remains separate so build trees containing the original watcher
migrate forward without resetting the pinned ReShade checkout.

## `reshade-injector-persistent-path-observer.patch`

Adds a non-injecting `inject.exe --observe-path-contains <fragment>
--parent-pid <uint32>` mode for the demo's fast process-creation path. It emits
an explicit UTF-8 ready record, then reports every matching executable's
creation and deletion as a PID plus absolute path while retaining process
handles to distinguish PID reuse. Each 5 ms pass uses `EnumProcesses` to obtain
one compact PID array. It resolves paths only for newly observed PIDs, retries
briefly when a just-created process is not queryable yet, and performs handle
waits only for matching Steam-path processes. It remains armed while exact-PID
injections run in parallel and exits with its supervising process. It does not
classify or exclude executable names.

## `reshade-injector-resilient-path-observer.patch`

Layers durable process identities and bounded path-query retry over the
persistent observer. It retains one lightweight handle for every process it can
open, which prevents Windows from reusing that PID until an enumeration pass
observes deletion and releases the handle. Resolved nonmatching processes are
not queried again. Temporarily inaccessible processes retry with bounded
backoff until they exit, and the observer never polls all retained handles.

## `reshade-injector-conflict-preflight.patch`

Adds a bounded target-module inspection after identity and architecture
validation but before `VirtualAllocEx`, `WriteProcessMemory`, or
`CreateRemoteThread`. It parses each loaded image module's remote PE export
table and identifies an exact `ReShadeVersion` export, matching ReShade's own
duplicate-instance guard without guessing from DLL names or files beside the
game. The complete module snapshot and export scan retries transient loader-list
or remote-read races four times, caps the module and export tables, and
otherwise fails closed before mutation. This is the inspection/protocol
foundation; the later shared-runtime patch refines a proven ReShade match into
compatible reuse or a specific fail-closed diagnostic.

Failures emit `ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ` followed by one-line
JSON schema version 1. The final `target-preflight` record uses
`target-runtime-incompatible`, `target-runtime-reuse-too-late`,
`target-runtime-reuse-raced`, or `target-module-inspection-failed`, includes the
selected PID and `injectionStarted:false`, and carries the module path or Win32
error when available. The SDK still accepts the older
`target-runtime-conflict` code for protocol compatibility. The legacy
`ReShade injection not started.` line remains present for conservative older
launchers. In this schema, `injectionStarted:false` means no ReShade runtime or
add-on payload was loaded. `target-runtime-reuse-raced` is detected after the
bounded remote loader starts, but its gate CAS loses before environment mutation
or `LoadLibrary`, so retry cannot duplicate a payload.

## `reshade-injector-per-pid-claim.patch`

Serializes path-watcher and exact-PID injector attempts for the same target
before remote mutation. One injector owns the native claim; a competing lane
receives the structured `target-injection-already-claimed` coordination result
and can yield without treating it as runtime incompatibility.

## `reshade-shared-runtime-host.patch`

Exports the private `ElectronGameOverlayReShadeHostAbi` value 1 and
`ElectronGameOverlayReShadeAddonGate` state from this repository's runtime.
Before normal add-on loading begins, the gate is `OPEN`; one injector may claim
it, set `ELECTRON_GAME_OVERLAY_RUN_DIRECTORY`, and load only the privately
staged Electron add-on. Normal initialization closes or waits out that claim
before dispatching add-on callbacks.

The injector emits one strict `ELECTRON_GAME_OVERLAY_INJECTOR_RESULT` JSON
record for success. It reports `injected-runtime`, or `existing-runtime` with
the host module path and ABI. Stock/differently patched ReShade lacks the
private ABI, and a compatible runtime whose gate is already active or closed
cannot accept late registration. Add-on load failure is reported separately as
`existing-runtime-addon-load-failed` because target mutation has begun.

## `reshade-injector-export-read-bounds.patch`

Bounds each remote export-name read to the requested symbol length and the
remaining PE image range. This keeps shared-host capability lookup from reading
across a sparse or malformed image page while preserving the export table's
lexical binary search.

## `reshade-injector-existing-installation-preflight.patch`

Finds inactive target-local x64 ReShade candidates and resolves the effective
base path, add-on directory, and `DisabledAddons` state from the exact target
process and its configuration. A detected installation suppresses project-host
injection and is returned to the SDK for ownership-checked add-on preparation;
the injector never replaces the runtime, proxy, configuration, presets, effects,
or foreign add-ons.

## `reshade-injector-official-addon-host.patch`

Recognizes the uniquely named Electron add-on when an official ReShade host has
loaded it, then emits the structured `official-addon` result with the exact
runtime and add-on module paths. The injector verifies the add-on ABI and build
identity, while host-version compatibility is decided inside the add-on through
public API-18 registration and the requested Dear ImGui function table. There is
no ReShade product-version or runtime-hash allowlist. In this public-host mode,
the add-on's same-thread message interception can copy, route, and suppress
foreground `WM_INPUT` records and requires either the exact source HWND's
current `RIDEV_NOLEGACY` registration or a valid NULL focus-following
registration resolved to that exact focused foreground HWND. The controlled
NULL-target gates exercise only the bundled private runtime; official-host NULL
routing remains ungated. The current public-host add-on does not add the pinned
runtime's `GetRawInputBuffer()` detour to an official host, so buffered-only
raw-input consumers remain outside that compatibility boundary.

## `reshade-injector-global-layer-preflight.patch`

Extends preservation-only preflight to applicable configured global
Vulkan/OpenXR ReShade layers and is the terminal injector patch over the
preceding stack. It also adds the SDK-private exact-PID
`--wait-for-official-addon <milliseconds>` inspection mode. The SDK uses that
mode only after the native manager proves the current reserved add-on is already
installed, giving a newly starting ReShade host one bounded chance to load it
without polling through repeated injector processes. The option performs no
runtime or add-on injection and is capped at 60 seconds.

## `reshade-shared-runtime-hardening.patch`

Closes or waits out external registration for every `load_addons()` caller
before callback dispatch, and changes the fail-closed wait to a low-CPU
`Sleep(1)`. The copied remote loader uses the compiler's inline interlocked
primitive instead of an invalid remote function pointer. Its exact x64 extent
is measured through unwind metadata and rejected if it is absent or exceeds the
bounded loader buffer.

## Migration-only observer patches

`reshade-injector-legacy-snapshot-observer.patch` and
`reshade-injector-low-latency-observer.patch` describe the retired observer
stack. That implementation walked a full Toolhelp snapshot and every retained
process handle at 5 ms intervals. CMake uses these two files only to remove that
stack from an existing ignored fetched tree before applying the bounded
observer above; neither is part of the production patch identity or build
stamp.

## `reshade-suppress-splash.patch`

Suppresses ReShade's branded startup window while leaving its full Dear ImGui
and add-on overlay pipeline enabled. The Electron compositor owns user-facing
startup presentation, so the five-second `ReShade ... UNOFFICIAL` message is
not drawn over the game. A non-branded progress spinner remains available for
later explicit full effect reloads. The runtime remains identified as a
modified ReShade build in DLL metadata, exports, logs, and its About page; this
patch does not claim official upstream signing.

## `reshade-x86-runtime.patch`

Makes the production injector implementation architecture-aware instead of
assuming AMD64 PE headers, registry views, runtime/add-on names, and process
environment layout. The Win32 build targets `ReShade32.dll` and
`electron_game_overlay.addon32`, and bounds its position-independent remote
loader with an ordered code-section end marker because x86 images do not carry
the x64 unwind metadata used to measure that thunk.

## `reshade-injector-inspection-context.patch`

Generation 24 adds optional `EGO_TARGET_INSPECTION_CONTEXT_V1` stdout telemetry
after transient module-inspection failures, using the exact retained target
handle. It reports selected/handle PIDs, process creation time, injector/process/
native machine values, architecture-query error, diagnostic loader state/error
and process liveness. PEB loader fields are observations only and never authorize
injection, bypass a host check, resume a thread or extend the 250 ms inspection
budget. The existing strict diagnostic/result schemas remain unchanged.

The patch also checks the previously ignored `IsWow64Process` return value and
refuses before module inspection or injection if that query fails. Its failure
emits context before the diagnostic without a module-inspection summary. Mapped
host/add-on implementations are unchanged, so their exact add-on build ID stays
`CCE20935ADD44EF6A5A7973014B2E07F`. Injector source, patch provenance and runtime
generation change together; generation-24 seals require that provenance in both
architectures. Source-cache migration reverses this tail before generation 23.

The remote report for PID 24224 proves exhausted module enumeration at 250 ms
with error 299 before injection. It does not establish the underlying cause.
The separate warnings for PIDs 12028 (preflight), 27116 (runtime initialization)
and 27592 (injector) cannot be joined into the same attempt. A controlled suspended
console target reproduced 17 attempts/250 ms/299 on both x64 and x86, then passed
read-only inspection through the same handle after its owner resumed it. This
proves one possible cause; it does not diagnose the remote game.

For the next remote investigation, collect one complete attempt's native stdout
and stderr, its SDK diagnostic with stage/PID/retry safety, selected V2 creation
identity, SDK version, both package/build manifests and Windows version/machine.
With this candidate's diagnostics, compare the context creation identity and
handle PID to that selection. `not-created`/`not-initialized` identifies observed
loader startup; `initialized` excludes that particular observation but does not
prove a stable module list. `unavailable` must retain its query/read error instead
of being treated as an empty list. Machine 34404 is AMD64, 332 is I386; a process
machine of zero means the native machine. A launcher holding the primary thread
suspended is additional evidence to record, not an inference from 299. No consumer
retry or longer timeout is prescribed. Do not combine evidence across launches.

Validation launchers:
`scripts/test-cases/initial-module-inspection-console.ps1 -Architecture x64`
and `-Architecture x86`; they launch owned inert console fixtures only. Each also
checks distinct private image globals and the merged-hard-link control. The
existing deterministic fixture still covers all 54 ownership/failure cases and
20,982 assertions on each architecture against the exact candidate source.

The separate mixed-watcher recovery launchers described in the SDK README use
unmodified released generation-23 native binaries with the current SDK; they do
not validate a complete generation-24 graphics build. On 2026-11-09, configuring
the existing canonical native cache refused an unrecognized complete source-cache
state without changing files. That cache was preserved. Generation-24 injector
console and deterministic checks instead compiled isolated verified source
reconstructions on x64 and x86. A subsequent complete generation-24 build on both
architectures passed using `-BuildCacheRoot build/candidate-gen24-cache`, seeded
with clean checkouts from the pinned Git objects. The original unrecognized cache
was not reset or overwritten. Headless ABI, native policy and installed-package
checks accompany the local candidate under
`build/candidates/attachment-recovery-gen24`; its validation report identifies
the exact artifact and dirty source provenance. Generation-24 consumer graphics
and input acceptance belong to the separate consumer test run.

## `reshade-injector-selection-before-open.patch`

Generation 25 moves future-target V2 selection publication ahead of the
full-access `OpenProcess`, using the exact retained limited-access identity and
path already verified by the native selector. Previously a matched process could
be refused before V2, leaving an armed SDK policy slot with no identity to
exclude or retire and no safe way to discover a successor. The original
generation-24 injector reproduces that path on an owned process with a DACL
supplied atomically to `CreateProcessW`; generation 25 emits its exact PID/path/
creation identity before the same refusal. No injection access is granted.

V2 identifies selection only. A full-access handle must still independently
match the path and creation time before architecture/module inspection, claims
or VM work. The legacy selection line remains after those checks. Failed or
unavailable identity queries do not synthesize V2 or authorize a blind retry.
Mapped host/add-on code and build ID remain unchanged. This frozen one-file
tail reverses before generation 24 and validates the complete source vector
before publication; both runtime manifests bind its exact provenance.

The owned headless launchers are
`scripts/test-cases/unopened-target-selection-console.ps1` and
`scripts/test-cases/owned-target-access-refusal.ps1`, each accepting x64/x86. The
former compiles the complete production entrypoint with a targeted API seam for
live refusal and a fast-exit race. The latter runs the actual built injector
against the owned DACL fixture and verifies retained-handle cleanup. The separate
`owned-target-access-refusal-negative-control.ps1` preserves generation-24
reproduction. Its [fixture protocol](../tests/unopened-target-selection/README.md)
also documents consumer integration. No graphics, external target or system
security configuration is involved in these gates.

## Generation-27 private elevated authorization

`reshade-injector-elevated-private-authorization.patch` adds a same-account,
same-interactive-session token gate on the exact retained target handle.
It permits high-to-high and high-to-medium attachment only through the isolated
private lane, with no shared registered add-on scan. Normal-to-high, system,
cross-user/session and unknown token evidence remain refused before mutation.
The SDK supplies expected hashes for the runtime, engine and private INI;
native code compares the write-pinned files against those hashes and validates
the newly created high-labelled directory, its owner/protected DACL and scan
inventory. The native manager creates only new project-owned directories;
it never changes a saved administrator preference or existing ReShade assets.

See the [elevated consumer contract](../../../doc/elevated-consumers.md) for
the token matrix, diagnostic-only medium-writable files and verification limits.
The new human-facing headless gate is
`scripts/test-cases/elevated-private-authorization-console.ps1`.
Injector/helper changes do not alter the mapped EGO feature engine, whose exact
build ID remains `CCE20935ADD44EF6A5A7973014B2E07F`.

## Generation-26 diagnostics and initial loader readiness

`reshade-injector-member-diagnostics.patch` preserves the authorization policy
and reports each actor's token-query phase through
`EGO_PRELOAD_AUTHORIZATION_CONTEXT_V1`. Windows error 5 alone does not identify
the elevated actor. Structured member failures distinguish preflight from an
already consumed participant load; the SDK keeps mutation uncertainty terminal.

`reshade-injector-startup-readiness.patch` adds a separate 3000 ms bounded wait
only after the identity-bound handle positively reports a missing or
uninitialized loader. It checks liveness on that same handle and never resumes
or suspends a target, reopens a PID, or retries an uncertain injection. Unknown
initial state delegates to strict inspection; losing a known pending state
fails closed. The existing strict module inspection retains its 250 ms budget
after startup readiness. Readiness neither proves module absence nor authorizes
injection. Timeout/exit emits `target-startup-readiness-failed` before mutation.
Successor selection still publishes its own V2 identity independently.

Both tails are frozen, reversible source-cache phases with exact SDK/native
provenance on x64 and x86. They do not change mapped host/add-on implementation;
the add-on ID stays `CCE20935ADD44EF6A5A7973014B2E07F`.

Human-facing headless gates have separate launchers:
`startup-readiness-console.ps1` (owned paused child, 800 ms owner resume,
unchanged 299 negative control, timeout and exit),
`member-diagnostics-console.ps1` (real token observations and deterministic
failure/formatter seams), `consumer-execution-context-console.ps1` (real caller
binding and fail-closed identity checks), and `consumer-parent-launch-console.ps1`
(actual medium desktop-parent launch with a test-only early-return seam).
The latter proves the real process creation, environment and argv path at medium
integrity; it does not establish an elevated-to-medium consumer round trip.
None starts graphics, a game or a UAC prompt.

## `reshade-x86-target-architecture-diagnostic.patch`

Emits the existing strict pre-mutation injector diagnostic with
`target-architecture-mismatch`, the selected PID/path, and Windows error 706
when a valid target belongs to the other architecture. The SDK accepts only
that exact evidence before handing the same PID/path from `inject.exe` to
`inject32.exe`; malformed, contradictory, or repeated mismatch results remain
terminal.

## `reshade-injector-exact-target-path.patch`

Allows an exact-PID request to include the trusted absolute executable path and
compares it with `QueryFullProcessImageNameW` before architecture handoff,
native claim acquisition, or target mutation. Basename-only exact-PID requests
remain supported, but SDK process-watcher lanes use the full path so PID reuse
cannot silently select a different executable at another location.

## `reshade-owned-composition-auxiliary-lifetime.patch`

Generation 35 remembers an already-excluded layered/topmost popup-tool lifetime
across removal/restoration of only WS_EX_LAYERED. A bounded host-owned table and
separate window-property token validate the same HWND/PID/thread/owner/style.
Previously unseen unlayered tools stay eligible; caption/APPWINDOW and token
changes revoke remembered state. This corrects the observed Windows tooltip
fade transition without a blanket exclusion of interactive topmost tools.
See `doc/composition-auxiliary-lifetime.md` for limits, native gates and the
paired real-renderer fixture contract. Actual PAGER acceptance remains required.

CMake applies the ordered patch stack idempotently to ignored fetched source,
including migrating prior patch stacks without resetting them, and then
validates the pinned commit, exact nine-file change set, and normalized SHA-256
content for every patched file in each build tree before declaring native
targets. `scripts/build-reshade-runtime.ps1` additionally validates every
production-patch hash, the full-add-on configuration, and runtime/injector
hashes before accepting its cache. Raw-input normalization reuses the existing
normalized Win32 input path; it changes no published transport C ABI, transport
wire schema, or public Node SDK API.

## Owned deferred D3D11, generation 36

`reshade-owned-deferred-d3d11.patch` queues one pinned owned-host worker only
after successful D3D11 publication on the existing LoadLibrary path and release
of the delayed-path mutex. Only an already validated missing-backend outcome
may reopen, and the worker revalidates stage/adapter readiness before using the
existing raw-adoption path. Existing try-lock, notification, official/foreign,
target-exit, public ABI and per-app feature boundaries remain unchanged.
It provides later Present adoption, not retroactive device wrapping or a
first-frame guarantee. See `doc/owned-deferred-d3d11.md` and the separate
production, loader, negative and source-cache gate launchers. Actual game
acceptance remains separate; candidate 1012 stays immutable.
