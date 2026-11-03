# Cooperative native registry protocol tests

These tests use two independent handles to the current process's shared native
coordination mapping. They do not inject ReShade, load a game, or establish
production graphics/input acceptance.

The protocol stores fixed-layout descriptors and owner callbacks. Windows are
identified by participant, local window ID and incarnation. Each owner keeps
its renderer, frame storage and input normalization. The generic callback
trampoline is claimed once, without selecting another participant's engine.

Build and run with Visual Studio 2022 C++ tools and CMake:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/cooperative-registry.ps1
```

The launcher builds both x64 and x86 and records the tested header hash. For a
single architecture or direct CMake use:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/cooperative-registry.ps1 -Architecture x64
cmake -S experiments/cooperative-registry -B build/cooperative-registry -G "Visual Studio 17 2022" -A x64
cmake --build build/cooperative-registry --config RelWithDebInfo
ctest --test-dir build/cooperative-registry -C RelWithDebInfo --output-on-failure
```

Repeat with `-A Win32` and a distinct `build/cooperative-registry-x86` directory
for the x86 ABI. Both configurations passed on 2026-11-01.

Coverage includes colliding local IDs, A1/B1/A2 per-window interleaving, owner
render dispatch, order-only changes, alpha hit-test callbacks, focus/capture,
interception OR, cached pointer-down/up decisions across normalizers, physical
button draining after departure, independent cleanup and lock-free raw input
broadcast to each owner's queue callback. Registration-rank history preserves
cross-app order across temporary raster gaps, gives recreated windows fresh
ranks, and admits more than 8192 sequential create/close cycles after
authoritative registration reconciliation. Private input recovery clears only
the recovering participant's focus/capture and drains its unmatched releases.

The mapping admits 512 distinct engine registrations and 8192 live windows per
target. Departed registration slots remain tombstones: observer callbacks may
have acquired their immutable context/function pointers without taking the
registry mutex. Modules and their global contexts must therefore remain pinned
until target exit. An application session disconnect should clear its windows
and interception without unregistering/reloading the engine. The input decision
cache retains 8192 projected records and 8192 source-owner decisions. A newer
engine's additional projection of a retained older source keeps that source's
owner without replaying capture transitions. Sources outside the retained cache
are dropped instead of being retargeted using newer focus/capture state. These are
bounds, not measured multi-application capacity claims.

Rank history has 8192 slots and never evicts an admitted registration merely
because its raster is temporarily unavailable. Owners must call
`reconcile_registrations` with the complete authoritative registration set from
the same immutable scene snapshot, including windows without a compositable
frame. This releases history only for closed or recreated registrations, making
the rank bound concurrent-registration rather than lifetime-window capacity.
