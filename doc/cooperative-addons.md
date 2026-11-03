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

The first registered module supplies only the baseline event trampoline.
On an owned host, the guarded bootstrap completes this registration before late
manual runtimes are adopted; the existing-stock lane preserves its ordinary
installed adapter. Later engine modules join the cooperative registry without
racing mutation of stock ReShade's callback vectors. The trampoline is embedded
in a participating module, not a separately installed feature host. Modules
remain mapped until target exit; producer disconnection
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

### Stable shared add-on directory — generation 23

The optional preload path uses a stable flat directory, normally
`%LOCALAPPDATA%\ReShade\Addons`, with one catalog under its
`.electron-game-overlay` subdirectory. Registration publishes distinct immutable
per-app/build files once. Hosts scan that same directory; no per-host add-on
snapshot is copied. Ordinary add-ons from other libraries are also scanned.
Retired EGO files remain mapped safely and are disabled in future private host
configurations. Selected EGO bytes and actual cooperative callback readiness
remain mandatory even if an unrelated add-on fails initialization. This changes
the injector and bundled owned host; it leaves the mapped EGO feature engine and
its build ID unchanged. See [shared preloading](addon-preloading.md) for the API
and initialization limits. All six repository DX API/architecture cells,
late D3D11 attachment, four full-feature D3D11/D3D12 cells and two retained
generation-16 mixed-implementation cases passed; see the
[shared-directory acceptance record](shared-addon-directory-acceptance-2026-11-03.md).
These results are separate from the earlier release candidates below.

### Transient initial inspection recovery — generation 22

After committing and pushing accepted RC.11 as `b89eeb6`, the user resumed the
separate Windows 299 investigation. Generation 22 adds bounded read-only
recovery to both initial inspection gates, retaining positive ownership facts
and requiring fresh readiness. Real console-process probes reproduce transient
enumeration and remote-read failures and recover on both architectures;
persistent failures still stop before payload loading. The host and add-on
implementations remain unchanged. See the
[RC.12 record](sdk-rc12-initial-inspection.md) for deterministic, actual native
and package evidence. Consumer retesting passed 16/16 native cases across 20
authenticated lifecycles: three fresh fast-folder positive/negative rounds and
the complete standard matrix, with loaded module paths of 292–322 characters.
No 299 or phase telemetry appeared in those consumer samples; direct recovery
proof remains the separate native SDK probes. The complete SDK was unchanged.

### Long-path activation readiness — generation 21

The original long-profile consumer retest of generation 20 loaded and
registered its DLL, then failed owned-host activation with `ERROR_NOT_READY`.
Generation 21 corrects a second path limit in the owned host's module
enumeration while retaining the ABI, actual callback-ready check and unchanged
EGO add-on implementation. This changes the bundled ReShade host's mapped code;
it does not replace an already mapped or user-managed host. See the
[RC.11 record](sdk-rc11-preload-activation.md) for isolated and consumer evidence.
The original long-profile positive/negative pair passed 2/2; the standard native
consumer matrix passed 10/10 on 2026-11-03, including x64/x86, fractional scale
and two-launch rearming. Loaded module paths reached 292–310 characters.
The consumer corrected its test module inspector without patching the SDK or
changing production paths. A separate fast-folder Windows 299 failure is
retained outside that accepted matrix; the subsequent authorized investigation
and generation-22 candidate are recorded above.

### Registered DLL long paths — generation 20

Generation 20 corrects the private `AddonPath` and injector load spelling for
long registered DLL filenames. It retains the generation-19 mapped add-on
implementation, build ID and cooperative ABI. Console loader and ownership
fixtures validated the path correction, but the original generation-20 consumer
case still failed activation. Generation 21 resolves that second failure and
passes the recorded consumer matrix above. See the
[RC.10 record](sdk-rc10-preload-long-path.md) for the retained earlier boundary.

### Optional installed preloading — generation 19

Generation 19, build `CCE20935ADD44EF6A5A7973014B2E07F`, adds optional installed
add-on registration and dormant preloading through a new owned host's external
`AddonPath`. All six core x64 repository D3D11/D3D12 cells passed: registered
self-load/injection and true older-unregistered-gen16 compatibility on each
backend. An offline registered baseline can forward events while each app
activates its own exact module and private transport. Restart and future-only
unregister semantics passed. All nine additional default-path demo regressions
also passed; see the [feature acceptance record](addon-preloading-acceptance-2026-11-02.md).

Only repository demos were used for this feature. No user game was launched;
the generation-16 game evidence below is historical, not a generation-19 rerun.
Two registered current apps share the same build in these tests; the separate
current/old16 dynamic-join cells establish mixed-native-version behavior.

### Prior full acceptance — generation 16

The previous full acceptance candidate is generation 16, build
`E8FE3783F29E4FB297D8B006D0087725`. All four original Gun Frog cases and all
four independently installed gen11/gen16 startup-order × graceful/crash cells
passed. The mixed run retained one ReShade, both apps' exact private engines,
isolated/interleaved windows and input, continued survivor operation and fresh
game relaunch in every cell. The user waived the final physical-key rerun; no
synthetic result is relabeled as physical input.

The normal x64/x86 build and sealed SDK passed, with 1,035 of 1,045 Node tests
passing and ten expected skips. Four native ABI/registry CTests and four loader
suites passed separately from GUI acceptance. Owned late D3D11 passed all eight
standalone/same-HWND lifecycle cells, and actual delayed-UI-thread hook recovery
passed on both architectures. All ten final control cases passed, including
unbarriered folder discovery/relaunch, as did all six final input/scaling,
four backend cases and the final eight-cycle resource run. The 32-script matrix,
three additional manually exercised original game lanes and four installed
mixed-game cells are complete within their recorded scopes. See the
[current readiness evidence](readiness-acceptance-2026-11-01.md) for exact
candidate hashes, completed cases, retained failed attempts and remaining work.

Generic late D3D12 queue recovery remains unsupported, stock copied buffered
input remains an explicit capability limit, and the historical D3D11 GPU hang
is still unattributed. The 500-app/500-version scenario has not been measured.

### Earlier acceptance milestones

The following records retain their original generations and scopes; they are
not silent reruns against the current candidate.

- Explicit private-directory Rust transport, registered-window metadata,
  incarnation-checked routing and logical focus across raster gaps: implemented;
  164 Rust tests passed on each of x64 and x86, including cooperative
  interception acknowledgement races.
- App-private TypeScript transport and default SDK/launcher activation:
  implemented and tested with real socket peers. The normal sealed SDK package
  no longer starts or requires a broker executable. The coordinated SDK and
  packaging test run reports 526 passing tests, separate from native/game runs.
- Per-engine native registry/composition/input integration and member attachment:
  implemented and compiled for x64 and x86. Registry protocol, transport ABI and
  loader/claim fixtures passed on both architectures. These controlled checks do
  not establish rendering or game acceptance.
- Candidate generation-11 native package: normal Nx build passed for both
  architectures, SDK sealing and client output at source
  `cdc6e80f0aa0cede23e4ba7272b9f8afa3e795ed`. Earlier
  controlled SDK input cycles passed after fixing acknowledgement ordering and
  test harness environment/readiness issues. Their recorded backend/generation
  boundaries remain separate from current-candidate acceptance.
- Generation 9 fixed internal-reset/session-transition ACK provenance. Its
  build `3309FB779CFC4E39BA7681AA4A7F8A6B` has passed all five original Gun Frog
  cases: full SDK interaction, low-level Electron scene, automatic no-click
  focus, human physical first-show/reopen keys, and stock-ReShade coexistence.
  The stock case retains exact module identities, foreign add-on/effect
  coexistence and protected-file preservation/restoration. Automatic and
  physical focus runs recorded zero pointer-downs; later gates in the physical
  case used SendInput. These are retained generation-9 results, not relabeled
  as current generation 11.
- Generation-11 build `E16461475E524DBA83398B19CDD95EBB` has passed four original
  Gun Frog cases: automatic focus, full SDK interaction, low-level Electron
  scene and stock-host coexistence with strict release/preservation checks. A
  physical-mode attempt reached rendering/focus with zero pointer-downs but
  timed out without the first human key. The user subsequently explicitly waived
  the final physical-keyboard rerun. Its final status is waived, not passed;
  the earlier generation-9 human pass remains separate and no synthetic input
  is relabeled as physical-key evidence.
- Actual mixed-implementation Gun Frog acceptance passed all four startup-order
  and graceful/crash cells with generation-8 and generation-11 native engines,
  different JavaScript/native hashes, private authenticated routes and one
  ReShade host. Interleaved rendering/input, owner disappearance, survivor
  operation and fresh-game relaunch passed in each cell. Both are unreleased
  development snapshots with the same package-version label; this does not
  claim independently released-package compatibility.
- Surface-lifetime and delayed-source fixes passed actual generation-11 two-app
  D3D11 acceptance. A late participant survived primary destruction with a
  never-presented secondary and unchanged authenticated TCP connections. Final
  destruction cleared surfaces/focus in 85 ms; recreated windows retained IDs
  without reviving old implicit focus, then accepted explicit focus and survivor
  input. Pixel checks and direct foreground guards were retained.
- Generation-10 before-injection and NULL-target registration passed both raw
  modes on D3D11/D3D12, as did explicit session close and final surface drain on
  both APIs. Its attached 125% display-scale pointer case passed eleven strict
  rendering/input checks; observed raster scale was 1.25 on Electron 39 despite
  requested OSR 1.5, so mismatched-raster coverage is not claimed. Generation-11
  D3D12 multi-swapchain promotion also passed.
- Generation-11 D3D11 WM_INPUT/buffered input and D3D11/12 session deactivation
  passed. Attached 125% and SDK-created 150% pointer cases each passed eleven
  strict feature checks; the requested 150% attached raster was still observed
  at 125%. Managed early and best-effort observers each passed two exact target
  lifetimes, baseline exclusion, authoritative exit/rearm and cancellation.
- Generation-11 WM_INPUT and buffered pointer lanes each passed all eleven
  strict cursor/wheel/pixel/no-click/reopen/release checks on unchanged mapped
  native bytes. D3D9 and D3D10, each x64/x86, passed two fresh SDK cycles per
  cell. The D3D11/D3D12 two-app/two-target isolation case and fail-closed inactive
  ReShade installation rejection also passed.
- The concurrent two-app/one-target D3D11 gate passed with App B supplying the
  sole ReShade host, both early requests, exact private engines/routes, colliding
  IDs, the interception OR matrix and isolated text. Force-killing A left B's
  credential and input route unchanged and B interactive.
- The controlled future-target focus gate passed after 130 seconds of idle
  observation before target creation. Automatic first show/reopen, blur/release,
  foreground rejection and resumed typing passed with zero pointer-downs.
- Existing-host changed-runtime-hash acceptance passed with exact retained
  process identity, one existing ReShade runtime, a preserved installed adapter
  and an independent private participant. The owned fixture models a still-loadable
  runtime upgrade using a benign PE overlay byte; all protected seed bytes,
  attributes and timestamps remained unchanged through normal exit. This is
  distinct from testing every reserved-file mutation/rollback transaction.
- Current x64/x86 registry fixtures and generation-11 packaged injector/claim
  loader fixtures passed in their protocol/console scopes. Native watcher
  quiescence passed without creating or injecting a target. They remain
  separate from desktop/game evidence.
- Additional raster/backend, managed-policy and reserved-file transaction
  variants remain available as future release coverage; the complete launcher
  matrix is not claimed executed. The fast unbarriered managed-folder run at `151225` timed out
  before native startup/authentication; its generation-11 rerun at `152840`
  passed initial input/policy retention but failed the fresh target's graphics
  startup/authentication. Reliable fast-start attachment was already excluded by
  the [pre-rewrite RC6 process-policy evidence](sdk-rc6-process-policy.md); the
  historical failures' exact cause was not established by those runs. A later
  generation-15 unbarriered lifecycle/relaunch case passed, and the
  generation-16 rerun also passed in the current readiness record. Those earlier
  reports remain failed. See the
  [acceptance evidence and additional coverage](cooperative-addons-acceptance.md).
- One generation-9 full SDK attempt failed with a graphics-device hang and
  contemporaneous NVIDIA display-driver events; its dump/events were preserved.
  A fresh run passed on unchanged bytes. The earlier failure's cause remains
  unassigned, as do earlier generation-8 initial pixel timeouts.

These passes do not mark the entire feature/backend matrix complete or provide
native fault containment between modules sharing the game's address space.
