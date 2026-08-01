# Pinned ReShade source patches

These patches apply only to the ReShade 6.7.3 commit pinned by this production
runtime and are applied as an ordered stack.

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
foreground `WM_INPUT` records and queries the exact source HWND's current
`RIDEV_NOLEGACY` registration before treating raw input as authoritative. The
current public-host add-on does not add the pinned runtime's
`GetRawInputBuffer()` detour to an official host, so buffered-only raw-input
consumers remain outside that compatibility boundary.

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

CMake applies the ordered patch stack idempotently to ignored fetched source,
including migrating prior patch stacks without resetting them, and then
validates the pinned commit, exact nine-file change set, and normalized SHA-256
content for every patched file in each build tree before declaring native
targets. `scripts/build-reshade-runtime.ps1` additionally validates all nineteen
production-patch hashes, the full-add-on configuration, and runtime/injector
hashes before accepting its cache. Raw-input normalization reuses the existing
normalized Win32 input path; it changes no published transport C ABI, transport
wire schema, or public Node SDK API.
