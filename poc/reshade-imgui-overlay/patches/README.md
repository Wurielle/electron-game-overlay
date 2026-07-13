# Pinned ReShade source patches

These patches apply only to the ReShade 6.7.3 commit pinned by this POC and are
applied in order.

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
post-POC hardening.

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
pointer wheel normalization remain explicit post-POC hardening.

CMake applies the ordered patch stack idempotently to ignored fetched source,
including migrating the prior three-patch stack without resetting it, and then
validates the pinned commit, exact eight-file change set, and normalized SHA-256
content for every patched file in each build tree before declaring native
targets. `scripts/build-runtime.ps1` additionally validates all four patch
hashes, the full-add-on configuration, and runtime/injector hashes before
accepting its cache.
