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
Legacy blocked window messages are routed exactly. Copied `WM_INPUT` and
`GetRawInputBuffer` records are retained and counted; their normalization remains
runtime hardening.

## `reshade-injector-base-path.patch`

Sets `RESHADE_BASE_PATH_OVERRIDE` inside the target to the injector directory, so
configuration, add-ons, and logs stay in an isolated stage instead of the game
directory. It also removes the upstream 50 ms post-discovery delay: the Gun Frog
Unity swap chain was created inside that delay, before the runtime could attach.

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
pointer wheel normalization remain explicit runtime hardening.

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
table and rejects an exact `ReShadeVersion` export, matching ReShade's own
duplicate-instance guard without guessing from DLL names or files beside the
game. The complete module snapshot and export scan retries transient loader-list
or remote-read races four times, caps the module and export tables, and
otherwise fails closed before mutation.

Failures emit `ELECTRON_GAME_OVERLAY_INJECTOR_DIAGNOSTIC ` followed by one-line
JSON schema version 1. The `target-preflight` record uses
`target-runtime-conflict` or `target-module-inspection-failed`, includes the
selected PID and `injectionStarted:false`, and carries the module path or Win32
error when available. The legacy `ReShade injection not started.` line remains
present for conservative older launchers.

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
targets. `scripts/build-reshade-runtime.ps1` additionally validates all ten
production-patch hashes, the full-add-on configuration, and runtime/injector
hashes before accepting its cache.
