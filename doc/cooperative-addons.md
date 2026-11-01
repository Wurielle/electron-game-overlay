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
- Candidate native package: built and sealed for both architectures. Both fresh
  D3D11 SDK input cycles pass after fixing acknowledgement ordering and two test
  harness issues (environment deletion and waiting for native watcher readiness).
  Gun Frog's automatic and physical-first-key focus cases pass with zero
  pointer-downs on generation 8, as does its full SDK interaction case.
- Generation 9 fixes internal-reset/session-transition ACK provenance. Its
  stock-ReShade Gun Frog coexistence gate passes, including exact native module
  identities, foreign add-on/effect coexistence, intercepted clicks, release and
  protected-file preservation/restoration. Remaining generation-9 reruns and
  mixed-build game acceptance are pending.
- Surface-lifetime and delayed-source fixes: implemented, reviewed, compiled and
  covered by registry tests. Actual two-app multi-surface lifecycle acceptance is
  still required. Remaining game and full feature acceptance are in progress.

This status is not a claim that a complete replacement or game acceptance has
already been achieved.
