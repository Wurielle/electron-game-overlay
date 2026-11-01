# Independent overlay instances: architecture investigation

Research branch: `codex/explore-independent-overlay-instances`.
Source baseline: `90d5bb4`. Investigation date: 2026-11-01.

This is an exploration, not a replacement broker contract or a claim of native
acceptance. Production behavior and the compatibility contract in
[multi-application-broker.md](multi-application-broker.md) remain unchanged.

## Finding

The useful boundary is **one ReShade graphics/input host, with independently
installed application SDKs and application logic outside the game**. Loading a
complete ReShade per application is neither supported by stock ReShade nor a
way to isolate native failures. Multiple public add-ons are a supported
extension mechanism, but they still share the game, rendering callbacks and
input authority. They cannot simply replace the broker while preserving the
current behavior.

Do not begin by removing the existing ownership/recovery machinery. First make
the shared EGO host a deliberately small surface compositor/input arbiter and
measure specific remaining sources of interference. Most application logic is
already outside that host; this is a refinement of the current architecture.

## What is actually selected today

The broker does not hot-replace every app's API with the latest npm release.
The first compatible running coordinator remains. At each target's initial
bounded election, the highest eligible compatible **native runtime generation**
registered within 50 ms wins. Publication freezes the choice. A later newer SDK
joins that runtime, including when an older runtime lacks its optional feature.

Each app already has its own Electron windows, OSR paint, Chromium input
translation, SDK implementation and managed attachment policy. The broker owns
global window IDs, aggregate order, focus/interception arbitration, target
transport, election and recovery. The native add-on owns the scene, hit testing,
capture, cursor, game-input suppression and GPU resources.

See `overlay-broker-protocol.ts`, `overlay-broker-server.ts`,
`electron-overlay-window.ts`, `overlay-session.ts`, `overlay-target-watcher.ts`
under `libs/electron-game-overlay/src/lib`, and
`libs/electron-overlay-transport/src/electron_input.rs`.

## Why separate copies are insufficient

The upstream source examined is the exact production pin,
[`4a50d1eddace85734871d91792ff214f13f66c01`](https://github.com/crosire/reshade/tree/4a50d1eddace85734871d91792ff214f13f66c01),
which the build identifies as ReShade 6.7.3. Findings concern that source, not an
assumption about every future ReShade release.

| Approach | What it provides | What remains coupled |
| --- | --- | --- |
| Rename and inject another stock ReShade DLL | No second working host: initialization rejects another module exporting `ReShadeVersion` | Process-wide graphics and input ownership |
| Patch out the duplicate-runtime guard | Only removes one loading barrier | Hook chains, wrapped interfaces, add-on host discovery, input, teardown, and the game crash domain still need proof |
| Create several public `effect_runtime` objects in one ReShade | Separate effect runtime objects/configuration through the manual integration API | Same ReShade implementation, shared add-on event registry and same-HWND input manager; caller must drive presentation and lifetime |
| Give each SDK its own uniquely named add-on | Separately compiled native implementations can register with one host | Global z-order, keyboard focus, capture, cursor, suppression, callback lifecycle and native failures |
| Keep one small EGO host and app-private producers | Independent SDK/feature logic and producer lifetime, with one composition/input authority | Native primitives must remain backward compatible or have negotiated fallbacks |
| Use external transparent overlay windows | App processes can be separated from game native code | Exclusive fullscreen, input interception, capture behavior and presentation latency need different acceptance |

The guard is in upstream
[`source/dll_main.cpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/source/dll_main.cpp).
The public header finds one ReShade module by its exported add-on API functions;
automatic discovery does not select a private host per library version. See
[`include/reshade.hpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/include/reshade.hpp).

Manual `ReShadeCreateEffectRuntime` allocates wrappers/runtime objects for the
Direct3D integrations in
[`source/addon.cpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/source/addon.cpp).
This is an interesting integration API, not multiple independent ReShade DLLs.
Same-HWND runtimes share input state and only the primary input handler updates
and blocks it; see
[`source/runtime.cpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/source/runtime.cpp) and
[`source/runtime_gui.cpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/source/runtime_gui.cpp).

Several add-ons are supported, but duplicate exported `NAME` values are rejected.
Callback registration and dispatch use shared vectors. Arbitrary remote-thread
loading/unloading while dispatch is running is not established as safe by the
public interface; a controlled single-thread fixture cannot prove that case.
See upstream
[`source/addon_manager.cpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/source/addon_manager.cpp) and
[`source/addon_manager.hpp`](https://github.com/crosire/reshade/blob/4a50d1eddace85734871d91792ff214f13f66c01/source/addon_manager.hpp).

## Additional constraints in the current EGO add-on

`libs/electron-game-overlay-runtime/src/electron_game_overlay_addon.cpp`:

- Registers through public API 18 and negotiates the exact ImGui table. An
  official-host lane already exists; replacing it is unnecessary to research
  stock ReShade.
- Exports the fixed name `Electron Game Overlay Runtime` and uses a fixed
  swap-chain private-data UUID. Renaming current copies does not separate state.
- Uses one shared process transport and exact-PID rendezvous. A distinct filename
  does not create independent routes.
- Initializes transport/state on `init_swapchain`. Loading a new add-on after
  swap-chain creation does not replay that event; current render callbacks skip
  a swap chain without that state.
- In the official-host input path, consumed keyboard/raw messages become
  `WM_NULL` before the next message hook observes them. Multiple independent
  routers cannot each recover the original event or safely decide focus.

Two opaque overlays cannot both independently decide they own the same click.
Either they coordinate topmost hit testing/focus/capture, or users get duplicate
typing, click-through, inconsistent cursor behavior or starvation. That
coordination can be smaller than today's implementation, but it cannot vanish.

Every native add-on still executes inside the game. A fatal native failure can
terminate the game and every overlay regardless of separate add-on names or
DLL directories. The proposed boundary isolates producer processes and logic;
it does not promise isolation from all native/GPU/resource failures.

## Official ReShade and patches

Today the default runtime is already a pinned upstream build with a substantial
ordered patch stack; the official-host lane uses an unchanged installed runtime.
See [the runtime README](../libs/electron-game-overlay-runtime/README.md) and
[patch descriptions](../libs/electron-game-overlay-runtime/patches/README.md).

Stock-host parity is not complete: public API 18 does not expose copied
`GetRawInputBuffer` records, and same-HWND input-handler promotion needs a pinned
runtime change. These are recorded in [known issues](known-issues.md).
Replacing the patched host with stock ReShade today would discard accepted
behavior. Preserve the existing route until equivalent behavior is demonstrated.

Prefer the public add-on API. If small upstream patches remain necessary, keep
them restricted to an input/lifecycle seam, verify exact upstream source, and
seek upstream support. Removing the singleton guard and maintaining independent
hooking implementations would be a much larger maintenance commitment; merely
calling those changes patches would not remove that commitment.

Never alter an existing user's ReShade runtime, INI, preset, effects or foreign
add-ons to implement this design. Research fixtures use fresh, owned directories.

## Concrete interference to address first

Current admission is bounded globally across broker clients:

- `overlay-broker-server.ts::assertSceneFits` reserves aggregate metadata against
  the frozen 1 MiB initialization packet limit.
- `overlay-broker-server.ts::handleFrame` sums retained frames across all clients
  against the 256 MiB budget.

An app can consume remaining admission even when another app targets a different
game. Existing retained windows/frames are preserved on rejection, and socket
overflow closes the offending connection, but there is no per-app reservation
or fairness policy. Independent DLLs do not fix this. A fair admission policy
needs an explicit resource model, legacy compatibility and overload acceptance;
adding arbitrary equal quotas can itself reject previously valid applications.

## Recommended next implementation boundary

Keep the existing permanent v1 control/ownership path and native host. Keep
application-specific UI, policy, rasterization and extensible feature logic in
the app or a private helper process. Define optional bounded producer surfaces
and input delivery behind that host, with per-member namespaces and explicit
resource accounting. A private frame/shared-memory lane may reduce relay work,
but must be justified by measurements and retain v1 packet fallback.

Do not make arbitrary per-version native DLL loading part of the first design.
A fixed native surface API avoids introducing additional native implementations
and unbounded callback lifetimes into the game. New native primitives on an
already-running old host need a fallback or a later game launch; a second
injection is not a compatibility strategy.

Before changing production, prove independently built old/new SDKs in both
startup orders, a late newer SDK, colliding local IDs, alpha hit testing, focus,
capture, dragging, cursor ownership, independent close/crash/reconnect, frame
flooding, broker recovery and zero-member recovery. Verify one native owner and
one injection throughout. Keep transport fixtures, mixed-package gates and
actual Windows graphics/input acceptance distinct.

## Experiment status

An isolated stock-ReShade add-on loading/lifetime probe is being prepared on
this branch. It does not change the production SDK, broker, injector, runtime
patch stack or official add-on build ID. Results must distinguish callbacks from
rendering and input acceptance before they are used to justify implementation.
