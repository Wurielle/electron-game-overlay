# Per-application cooperative add-ons

This is the implementation contract for the unreleased clean rewrite authorized
on 2026-11-01. The former broker design is recorded in
[multi-application-broker.md](multi-application-broker.md). Compatibility with
that unreleased implementation is not a migration requirement. Application
overlay features and real-game acceptance remain requirements.

## Ownership and implementation boundaries

Each application owns its SDK implementation, private authenticated loopback
transport, native engine module, input normalization/router, scene and GPU
resources. A game contains one ReShade runtime. No EGO runtime generation or
package version selects the native feature implementation used by other apps.

Every engine implements a common fixed-layout cooperative protocol. The shared
registry contains participant/window identities, order, focus, capture and
same-process callback tables. Each owner renders its own windows and handles its
own input. Global order is per window, including interleaved windows from
different apps. It must not be reduced to fixed whole-application layers.

A module registered with ReShade before graphics initialization supplies only
the baseline event trampoline. Later engine modules can join the cooperative
registry without racing mutation of stock ReShade's callback vectors. That
trampoline is embedded in a participating module, not a separately installed
feature host. Modules remain mapped until target exit; producer disconnection
deactivates only that participant's state/resources. A first participant losing
its application must not disable the event source for surviving participants.

The cooperative ABI uses explicit sizes/versions, fixed-width POD fields,
opaque owned handles and callback tables. It must not expose private C++ class
layouts, STL objects, cross-module allocator ownership or private input records.
Different engine implementations must interpret the same baseline records.
New owner-specific normalization/projections cannot depend on an earlier
engine recognizing the same feature.

## ReShade initialization safety

ReShade itself remains a common dependency. The first eligible initialization
supplies the host when none exists. A later app never replaces a mapped host or
injects another ReShade because its preferred version is newer.

The injector retains and validates the exact target process handle, image and
creation time before mutation. A process-instance-keyed native claim is pinned
into that target before remote publication may begin, so injector/application
death cannot reopen possibly consumed full-runtime ownership. A later request
may load its own engine into the existing host; it may not assume another
ReShade injection is safe from a timeout, missing socket or application exit.
Name/path watcher selection must pass through the same native boundary.

Existing ReShade runtime/proxy files, configuration, presets, effects and foreign
add-ons are protected. Only the native transaction helper may change the
reserved EGO installation files. First-party injected-host files live in owned
external staging/cache directories. The existing-official lane must retain all
its preservation checks; it must not silently modify a foreign runtime to add a
source patch.

## Required overlay behavior

Retain rendering, transparency/alpha hit testing, caption dragging, individual
window raising, focus, pointer capture, cursor ownership, keyboard/IME delivery,
wheel axes/deltas, interception OR/release, DPI/raster scaling, attached surfaces,
telemetry, target following, managed discovery/admission and multi-swap-chain
lifetime. Preserve raw/legacy provenance and duplicate suppression, including
buffered raw input where supported by the existing patched host.

Participant removal releases only its windows, input and resource ownership.
It is never evidence of target exit. A survivor must keep rendering and taking
input after another application's graceful exit or crash. A producer reconnect
must not revive stale frames, focus, capture or session incarnation state.

See the [acceptance matrix](cooperative-addons-acceptance.md). Controlled socket
tests, native protocol fixtures, independently built engines and actual game
acceptance establish different boundaries. Keep their results separate. A
physical-key gate requires physical input, not a relabeled synthetic event.

## Implementation status

Work is in progress on `codex/explore-independent-overlay-instances`.

- Explicit private-directory Rust transport, registered-window metadata,
  incarnation-checked routing and logical focus across raster gaps: implemented;
  158 Rust tests passed on each of x64 and x86, including cooperative
  interception acknowledgement races.
- App-private TypeScript transport and default SDK/launcher activation:
  implemented and tested with real socket peers. The normal sealed SDK package
  no longer starts or requires a broker executable.
- Per-engine native registry/composition/input integration and member attachment:
  implemented and compiled for x64 and x86. Registry protocol, transport ABI and
  loader/claim fixtures passed on both architectures. These controlled checks do
  not establish rendering or game acceptance.
- Candidate native package: built and sealed for both architectures. Earlier
  controlled SDK input cycles passed after fixing acknowledgement ordering and
  test harness environment/readiness issues. Their recorded backend/generation
  boundaries remain separate from current-candidate acceptance.
- Generation 9 fixes internal-reset/session-transition ACK provenance. Its
  build `3309FB779CFC4E39BA7681AA4A7F8A6B` has passed all five original Gun Frog
  cases: full SDK interaction, low-level Electron scene, automatic no-click
  focus, human physical first-show/reopen keys, and stock-ReShade coexistence.
  The stock case retains exact module identities, foreign add-on/effect
  coexistence and protected-file preservation/restoration. Automatic and
  physical focus runs recorded zero pointer-downs; later gates in the physical
  case used SendInput.
- Actual mixed-implementation Gun Frog acceptance passed all four startup-order
  and graceful/crash cells with generation-8 and generation-9 native engines,
  different JavaScript/native hashes, private authenticated routes and one
  ReShade host. Interleaved rendering/input, owner disappearance, survivor
  operation and fresh-game relaunch passed in each cell. Both are unreleased
  development snapshots with the same package-version label; this does not
  claim independently released-package compatibility.
- Surface-lifetime and delayed-source fixes passed actual generation-9 two-app
  D3D11 acceptance. A late participant survived primary destruction with a
  never-presented secondary and unchanged authenticated TCP connections. Final
  destruction cleared surfaces/focus in 66 ms; recreated windows retained IDs
  without reviving old implicit focus, then accepted explicit focus and survivor
  input. Pixel checks and direct foreground guards were retained.
- Full controlled feature acceptance is still in progress: raw registration and
  buffered input, fractional raster/attached windows, D3D12 lifetime/session
  closure, managed discovery/policy and existing-installation rejection and
  maintenance need their current-candidate results recorded. See the
  [acceptance evidence and pending matrix](cooperative-addons-acceptance.md).
- One generation-9 full SDK attempt failed with a graphics-device hang and
  contemporaneous NVIDIA display-driver events; its dump/events were preserved.
  A fresh run passed on unchanged bytes. The earlier failure's cause remains
  unassigned, as do earlier generation-8 initial pixel timeouts.

These passes do not mark the entire feature/backend matrix complete or provide
native fault containment between modules sharing the game's address space.
