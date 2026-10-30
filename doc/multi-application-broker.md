# Same-PID multi-application broker

This is the canonical compatibility and ownership contract for independent
Electron applications using `electron-game-overlay` (EGO) against one target
PID. The overlay-consumer API does not expose a broker instance: every application still
creates its own `ElectronGameOverlay`, `OverlaySession`, windows, and
`ReShadeOverlayLauncher`.

## Product contract: preserve across releases

Independent applications must be able to use different EGO versions against the
same game without coordinating upgrades or competing to inject separate
runtimes. New releases must preserve interoperability with older releases in
the shared-broker architecture, not require all applications to carry the same
package version. The permanent v1 baseline below is part of that commitment;
versions predating this architecture are not retroactively made broker-aware.

The scenario of 500 applications carrying 500 versions expresses the design
goal: one shared target communication/runtime ownership path, isolated member
windows and input, and surviving applications unaffected by another member's
exit or crash. It is not measured capacity, a promise of arbitrary resource
availability, or proof that those package combinations have been tested.

Keep the broker/bootstrap core small, focused, and rarely changing. Its stable
responsibilities are discovery, singleton/target ownership, compatibility
negotiation, scene/input routing, and recovery. Application UI, business logic,
game-specific policy, and evolving renderer features belong outside that core.
New functionality must not require rewriting the coordination foundation or
silently narrowing backward compatibility.

Keep three roles distinct:

- The **bootstrap** finds or starts the shared broker. It uses the stable
  per-user catalog format for optional advance discovery and the calling SDK's
  bundled distribution for ordinary unregistered startup.
- The **broker** coordinates application members and owns the shared target
  communication path. Today the first compatible running broker stays in
  charge; implementation selection happens before starting a replacement service,
  never by hot-replacing a live owner.
- The **runtime provider** supplies the validated native artifacts and performs
  the elected attachment. Its explicit compatible runtime generation, not npm
  semver alone, determines priority in the current bounded target election.

The highest eligible compatible provider registered before the election cutoff
wins. It need not be the first application to start. After target-route
publication may have begun, a later newer version joins the selected runtime;
hot takeover and live native-runtime replacement are not requirements. This
freeze is a safety invariant, not a failure to prefer the newest eligible
candidate within the election window.

The following sections describe the implementation contract, not a blanket
Windows/native acceptance or capacity claim. Keep the verification boundaries
in the release-evidence section explicit.

## Invariants

- One broker protocol-v1 pipe, derived from the Windows process-token account
  identity rather than mutable environment variables, accepts application
  sessions for that user.
- One broker target host and one authenticated loopback transport exist per
  exact PID.
- One process-crash-persistent write-ahead claim under the same user's home
  directory pins the exact target route and lease for each live PID.
- One runtime provider, either a live application or the cached standalone
  implementation, is elected injection owner before any target route is published.
- The target contains one ReShade runtime and one Electron overlay add-on, not
  one copy per application.
- Every application keeps its own local window IDs. Only the broker allocates
  target-global window IDs.
- The broker assigns fixed-width aggregate order tokens. Capability-aware
  clients retain those tokens so cross-application z-order survives a broker
  restart independently of reconnect order.
- A target input/focus event is translated back to the owning application's
  local ID. Foreign applications never receive another application's input.
- Target interception is the logical OR of all live member requests.
- A member disconnect removes its target windows and interception reference
  without releasing the authenticated target transport.
- The authenticated host survives a zero-member interval and retires only on
  authoritative `game.process.disconnected`.

## Window placement and focus

Frozen-v1 caption dragging updates native runtime-local placement; it does not
report new positions back to the Electron `BrowserWindow` or broker metadata.
Re-registering an unchanged window is therefore not a harmless z-order update:
it can overwrite a user-dragged position and invalidate an in-flight drag.
Ordinary new/topmost-window publication must not replay every other member's
geometry. Runtime generation 2 can additionally advertise the optional
`window-order-v1` capability in its authenticated target-transport-v1
`game.process` hello. With that explicit per-connection support, the coordinator
can insert an older retained order token by publishing only the changed window
and a `window.order` packet containing the complete bottom-to-top global-ID
list. The native update changes order only: surviving windows retain their
runtime-local rectangles, frames, placement epochs and input ownership. Invalid
or incomplete order lists do not partially modify the scene.

An older runtime, a connection without the optional capability, or an older
coordinator keeps the frozen-v1 ordered-registration fallback. The feature does
not change broker membership, required capabilities, election deadlines, route
ownership or the no-takeover rule. It does not preserve a removed window's own
placement when that window is recreated. A native transport disconnect clears its
registered windows; reauthentication reconstructs them from producer metadata,
not native-dragged rectangles. Window names and newly allocated global IDs are
not stable window-incarnation identities. Preserving placement through these
paths requires an explicitly negotiated native feature, not silently treating
v1 registration as an order-only command.

Demo focus callbacks must not hide and recreate a visible control overlay merely
to keep it on top. Let normal native click/focus stacking apply without mutating
the scene. Test child-window focus, actual typed text, and dragging after focus
changes separately from the visibility of control overlays. The demo control
uses a fixed transparent backing surface and changes only its CSS panel size
on interception toggles, avoiding a resize that would resend stale Electron
coordinates. Pixels outside the collapsed panel must remain fully transparent;
verify actual offscreen paint rather than merely hiding DOM controls.

## Attachment sequence

Cold coordinator startup includes discovery, full payload validation, immutable
cache copying and service initialization, not just a pipe connection. The SDK
client and standalone bootstrap share a bounded **75-second total default** for
this path; an explicit `connectTimeoutMs` or bootstrap `timeoutMs` remains a
total-budget override with its existing validation bounds. A healthy existing
owner is still joined immediately. This allowance does not change the
five-second client handshake timer, two-second OS privilege/identity probes,
or any native injection deadline or ownership rule. Optional registration is
not required to prepare the first cache.

Before this sequence, the SDK joins an existing compatible service or bootstraps
an eligible standalone distribution. A valid cached native provider prepares
its first run before the standalone listener opens, without starting an
application UI.

1. Each SDK client connects to the stable per-user v1 pipe and sends its
   protocol range, frozen required capabilities, optional supported
   capabilities, package version, and process ID.
2. Each exact-PID authorization advertises the generation and target-transport
   range read from that launcher's validated staged runtime manifests. The
   broker waits 50 milliseconds from the first request and elects the highest
   generation that can speak target transport v1. Equal modern providers use a
   stable per-lease identifier so a broker restart reproduces the same pending
   winner; legacy requests without that extension use arrival order. Package
   semver is informational and never orders providers.
3. Before returning `injection-owner`, the broker records an `intent`, arms it
   as `publishing`, atomically publishes the pinned broker-owned rendezvous,
   and commits it as `published`. The selected application then performs
   normal injection, or the elected cached provider performs it through the
   same ReShade attachment engine.
4. Other exact-PID authorizations wait. They are not allowed to inject while
   ownership is unresolved.
5. The injected target authenticates once and emits `game.process` with its
   authoritative PID and executable path.
6. Waiting members whose expected executable identity matches are released as
   `joined-existing`. Their launcher result uses `shared-runtime` and skips the
   injector.
7. The broker materializes every member's retained windows and latest frames
   into the one ordered target scene.

A late member joining an already-authenticated target receives the retained
process, target-surface, FPS, and interception snapshot before its
authorization resolves. A member arriving during `game.process.transport-lost`
waits for runtime reauthentication; it is never given stale connected proof.

The cached native candidate is offered synchronously to the same bounded
cohort as application providers; slow staging cannot make its advertisement
arrive after election. An optional executable-path field is not required from
old v1 clients. If absent, the elected cached provider must resolve the exact
process image through an authoritative read-only OS query during preparation,
before route publication. Reject a caller whose supplied executable constraint
conflicts with that image. Cached injection requires at least one active external
caller that accepts the image; a PID-only legacy caller satisfies that condition.
The internal provider itself is not an application request. Failure to prove
identity may permit pre-publication fallback, never guessed paths or another
injector after commitment.

### Read-only native process identity

The cached provider queries the OS through the selected distribution's already
validated x64 `electron_game_overlay_reshade_manager.exe`, not PowerShell, a
caller-supplied program, or an environment/PATH search. The shared broker's
medium-integrity guard still runs before cached native code is executed.

The additive `--query-process-image <pid>` mode accepts one canonical positive
decimal uint32 PID. It opens the process with only
`PROCESS_QUERY_LIMITED_INFORMATION` and calls `QueryFullProcessImageNameW` with
Win32-path flags plus `GetProcessTimes` on the same retained handle. It does not
enumerate target modules, inject, or open/mutate game or ReShade files. An
illustrative extended-helper success record is one UTF-8 JSON line:

```json
{"schemaVersion":1,"kind":"electron-game-overlay-process-image","pid":123,"executablePath":"C:\\Games\\Game.exe","creationTime100ns":"9007199254740993"}
```

The broker requires the matching PID, schema/kind, and a valid full Windows path.
The optional creation time remains an exact positive uint64 decimal string;
malformed present values are rejected. Older image-only helper responses remain
supported by the image-query API, but cannot establish process-instance identity.
Child execution remains shell-disabled, bounded to 2000 milliseconds and 128 KiB
of output. Missing processes, denied access, malformed responses, and timeouts
fail closed without a PowerShell fallback. This is a separate read-only mode;
existing manager file-transaction commands and broker/target protocol v1 are
unchanged, and the mapped runtime build ID/generation does not change.

## Failure and recovery

- If the selected provider leaves before target-route publication starts, the
  broker elects the best remaining compatible waiter.
- Target-route publication is the point of no return. From immediately before
  `authorizeTarget()` begins, ownership is frozen even while that asynchronous
  operation is pending. If the provider then leaves, the broker retains the
  route, permits the already-started runtime to authenticate, and never starts a
  second injector. It retires this unauthenticated tombstone only after the PID
  is definitively observed exited. Only a failure while the exact
  pre-consumable `intent` is still authoritative may roll back and re-elect;
  every failure after the `publishing` write remains frozen.
- The write-ahead claim survives application and broker process death. An
  unconsumed `intent` can be resumed only by its exact stable lease; a failed
  unconsumed intent is rolled back before that lease is rejected. A
  `publishing` or `published` claim is treated as possibly consumed regardless
  of what a reconnecting client remembers, and can never grant another
  injection owner while the PID is alive.
- If an application exits or crashes after authentication, only its mapped
  windows are closed. Surviving members continue rendering and receiving
  input.
- If the target transport is lost, existing members receive
  `targetTransportLost`; late joins wait. A same-PID `game.process` resumes the
  host and releases compatible waiters.
- If the target exits while a late join waits, that authorization is rejected
  instead of hanging.
- If the broker process exits while an SDK client remains alive, the client
  emits one synthetic transport-loss event, reconnects or starts a replacement
  broker, republishes its retained scene and broker-issued window-order tokens,
  and retries its settled target lease with bounded exponential delay. If every
  prior application also exited, a fresh compatible application can start the
  replacement broker and republish only the route pinned by the persistent
  claim so the already-mapped runtime can reconnect. Neither path resolves an
  original launcher authorization twice, changes aggregate order based on
  reconnect order, or starts another injector merely because processes
  restarted.
- If cached attachment fails after its grant, pending callers receive a
  correlated failure rather than waiting indefinitely. The broker retains the
  possibly consumed claim and pinned route. It does not re-elect an injector;
  authentication arriving later may still establish the existing runtime so
  subsequent callers can join it.
- Recovery claims and route-ownership evidence are retained across graceful
  broker shutdown too. Endpoint credentials may rotate only through the pinned
  route's write-ahead transaction; the ownership evidence is removed only
  after definitive target exit, preventing a zero-application interval or
  repeated broker crashes from reopening injection ownership.
- A broker with no clients and no retained target hosts or claim anchors shuts
  down after 30 seconds.

### Optional process-instance evidence

Schema-1 claims may carry an optional `creationTime100ns` string: the exact,
positive uint64 Windows process creation FILETIME, expressed in canonical decimal
without leading zeros or numeric conversion. The image and creation time must
come from the same limited-query OS process handle. A broker uses its own
validated distribution's manager for this observation, independently of which
application/runtime provider wins election. It adds no required v1 client field
or capability.

Only a genuinely new route claim can acquire newly observed instance evidence.
A legacy claim without the field remains unidentified, including intent
resumption; never backfill the creation time of whatever now occupies its PID.
An older coordinator may ignore and drop the additive field when rewriting a
claim. That degrades to legacy unknown, not permission to reconstruct the lost
identity. Malformed present evidence is not an absent legacy value.

For a known instance, a recovery mismatch or unavailable comparison must retain
possibly consumed ownership rather than republish a route, grant a replacement
injector or use PID-wide exit cleanup. Asynchronous observations must not affect
a replaced host, authorization, connection generation or process-exit watch.
Matching evidence permits only the existing recovery path; it is not proof that
the process remains alive after the query.

This deliberately detects and fails closed; it does **not** implement automatic
safe PID-reuse recovery. A separate helper can observe instance A, then A can
exit and a PID-only injector can consume the old grant against replacement B.
Seeing B's different creation time afterward does not prove B was never
injected. Automatically clearing A's claim could therefore inject B twice.
Automatic release on reuse requires injection itself to be bound to creation
identity on the actual target handle, with compatible legacy-provider rules and
exact observed-claim cleanup. No such guarantee follows from the observed claim
field alone. An instance-bound invocation also cannot establish whether an older,
unbound provider previously consumed the same route. No cross-protocol-major
arbiter or automatic claim release is introduced here.

### Optional instance-bound injection

`process-instance-injection-v1` is an optional supported capability, never part
of the required v1 baseline. A capable injection owner can receive the broker's
already pinned `expectedCreationTime100ns`. The field is a canonical positive
uint64 decimal string, with the same exact-value rules as the observed creation
time above. It is not a new authenticated-target field: `joined-existing` skips
the injector and receives no injection expectation. Legacy peers and an older
coordinator may omit the field; absence remains unbound, not evidence that an
instance comparison happened.

The exact broker expectation must survive object/function authorization
normalization, session wrapping, cached-provider grants, x86 handoff and
existing official-add-on wait/reopen paths. An independent later sample must
never replace the broker's A with a replacement process B. A malformed present
expectation, or one that the staged artifacts cannot enforce, is rejected before
execution rather than silently retried without binding.

Native binding support comes from validated private runtime package schema 4,
with `injectorProcessInstanceBinding: 1` and matching declarations for both
architectures. Source and staged payload hashes must still validate. Schemas 2
and 3 remain accepted as unbound artifacts. SDK capability negotiation, a caller
boolean, runtime generation, package version or the manager's read-only creation
time query does not upgrade old injector bytes.

The native check uses `GetProcessTimes` on the retained `remote_process` handle
that performs injection. It follows same-handle executable identity validation
and precedes architecture/module inspection, injection-mutex acquisition, file
ACL changes, remote allocation/writes and thread creation. The handle is not
closed and reopened by PID for mutation. If the instance exits after comparison,
that handle still refers to the old process object; a later failure must not
retarget a replacement process. Every reopened x86 or official-add-on invocation
must compare the same original expectation on its own actual target handle.

A mismatch is a terminal `target-process-instance-mismatch` preflight error
with `injectionStarted: false` and exit/error 1306. A query failure is a terminal
`target-process-instance-query-failed` error carrying the immediately captured
Win32 error; zero creation time is invalid data. Neither permits repair,
unbound retry, replacement-owner election or cleanup of possibly consumed
claims. Current conservative ownership retention applies even to a locally
not-started invocation; full provider-history and exact-claim cleanup proof
remain separate requirements.

## Version compatibility and runtime election

The default pipe name includes the broker protocol major. Protocol v1 uses a
framed JSON/control and BGRA-frame stream plus explicit capability negotiation.
The required v1 baseline is:

- `scene-multiplex-v1`
- `global-window-order-v1`
- `input-arbitration-v1`
- `target-lease-election-v1`
- `target-telemetry-v1`
- `target-transport-v1`

Protocol v1 is the permanent compatibility-family baseline. Maintainers must
not change its framing, reinterpret existing messages, or add another required
v1 capability. Future features are optional capabilities and are used only when
they appear in the broker/client supported-capability intersection. Missing v1
hello/authorization extensions retain their legacy meaning: runtime generation
1, target-transport range `[1, 1]`, and supported capabilities equal to required
capabilities.

The target recovery-claim schema and its stable per-user path are also part of
the permanent v1 contract. Schema-1 meanings cannot be reinterpreted. Future
schema-1 fields must be additive and safe for older readers to ignore; readers
accept those additive fields but fail closed on an unknown schema while its PID
is live. A claim-schema bump is a breaking compatibility family and requires
the same cross-family PID plus process-creation-identity arbiter as a broker or
target-transport break.

Package versions do not need to match. Every backward-compatible runtime
generation must continue speaking target transport v1, even if it also supports
newer transports. The broker always selects v1 for this compatibility family so
an older surviving application can recreate the broker after a crash. A
monotonic runtime generation describes the actual staged runtime artifacts; it
is not derived from npm semver.

The 50-millisecond cohort chooses the newest compatible provider that arrived
before the ownership freeze, not the globally newest installed SDK. A higher
generation that arrives after route publication joins the selected runtime and
can become a provider only after that target process exits. This bounded wait is
what handles applications launched a few milliseconds apart without delaying
every attachment indefinitely.

The first running compatible broker remains authoritative and is never
hot-replaced by a newer application. Releases in this compatibility family can
therefore coexist in either startup order if they preserve the frozen v1
contract and a v1-capable runtime fallback. SDK versions predating the broker
cannot participate.

"Newest" is evaluated among eligible candidates known before the bounded
selection cutoff, not all installed packages or applications that might start
later. The optional catalog below is intended to make candidates discoverable
in advance; it must not reopen committed target ownership.

A future release that cannot preserve protocol and target transport v1 is a
different compatibility family. A new pipe name alone is unsafe because two
broker majors could inject the same PID. Such a release must first add a
protocol-independent per-user arbiter keyed by PID plus process-creation
identity; until then, a breaking broker/target-wire major must not ship.
That arbiter is a safety prerequisite, not an exception to the product contract:
it prevents competing injectors but does not itself make old clients work. Any
future internal protocol family must still retain an adapter or fallback that
preserves older participating clients' interoperability. A new npm major or a
separate pipe name never authorizes replacing coexistence with rejection of
older applications.

## Optional advance registration

Advance registration is an additional discovery failsafe. An app may register
its installed EGO implementation ahead of startup so another catalog-aware SDK
can discover it while the supplying app is stopped. It remains optional: no
mandatory global installation, pre-registration ceremony, or registry edit is
required to use ordinary startup registration and joining.

The discovery flow is:

1. An opting-in application records its installed implementation, validated
   selection/compatibility metadata, and a usable launch location in one shared
   catalog for the supported user scope. Do not create a separate discovery
   catalog per EGO version.
2. With no compatible broker already running, the first invoked bootstrap reads
   valid entries and starts the highest eligible compatible registered broker
   implementation, even if its supplying application is not running. This must
   start the shared service, not the supplying application's UI/business logic.
3. With no usable catalog or candidate, ordinary runtime discovery/election
   remains available using implementations supplied by starting applications.
   An unregistered application can still register and join a compatible owner.
4. Applications register their live sessions with that shared service. Selecting
   a broker implementation and electing native artifacts for an exact target
   remain distinct operations; advance-discovered providers must have a defined
   way to participate without relying on their original app being awake.
5. Existing committed broker/target ownership wins over catalog changes or a
   later higher version. Discovery and recovery must preserve the same pinned
   route and no-second-injection rules as ordinary startup.

This removes dependence on application startup order for discovering an already
registered implementation. It does not guarantee that registration makes an
app's UI ready, remove the pre-graphics native attachment deadline, or promise
that unsupported targets, invalid installations, or OS failures cannot fail.
Errors must remain actionable without compromising another app's live session.

### Registry and fallback constraints

- The optional installed-implementation catalog is **not** a target discovery
  credential, the existing per-PID recovery claim, or the authority to inject.
  Its presence does not prove that a broker owns a game, and its absence never
  revokes a possibly consumed ownership claim.
- Missing, stale, removed, moved, unreadable, or malformed catalog entries alone
  must not make ordinary startup fail. Ignore unusable discovery candidates or
  use the normal registration path, while still honoring live owners and
  existing recovery evidence.
- Concurrent registrations and first starters need atomic catalog updates and
  crash-safe singleton arbitration. The shared file is discovery data, not a
  file-existence lock or an instruction to spawn competing brokers.
- Validate candidate identity, compatibility, launchability, and permitted
  trust scope before loading code. Never execute arbitrary registry strings as
  shell commands or use this mechanism to escalate a client's privileges.
- A failed native attachment candidate may yield to another injector only with
  proof that target-route publication has not started and its unconsumed target
  authorization can be safely abandoned. Only the exact, still-authoritative
  pre-consumable intent may be rolled back for that purpose. The `publishing`
  phase is already beyond that boundary, even before the final route file
  appears. Retain existing target recovery claims; a timeout or uncertain
  mutation cannot authorize another injector before authoritative target exit.
- Preserve the catalog's backward-compatible schema and selection
  semantics just as carefully as the wire protocol. Define broker selection
  ordering separately from native artifact generation; an npm version label
  alone is not proof of compatibility or suitability.

### Application and installer API

The Node-only `electron-game-overlay/broker` entry point exports
`registerOverlayBrokerInstallation(options?)` and
`unregisterOverlayBrokerInstallation(registrationId, options?)`.
Registration returns an opaque installation-registration identity; persist it
for uninstall. It copies a validated independent distribution into the per-user
cache and publishes discovery metadata without opening a service listener or
starting the supplying application's UI. The standalone executable also exposes
`--register`, `--unregister <registrationId>`, and `--help`, so installer setup
does not need a separate Node.js or Electron runtime.

Use the intended user's account for registration. A system-wide installer
running as another account does not register on behalf of every Windows user.
Keep registration ownership distinct from content identity: equal payloads may
share cached bytes, but removing one app's registration must retain another
app's registration for those bytes.

Stable versions are eligible by default. Registering a prerelease requires
`{ allowPrerelease: true }`; selecting one during ordinary SDK startup requires
`new ElectronGameOverlay({ allowPrereleaseBroker: true })`. Registration alone
does not opt unrelated clients into preview selection. An already-running
compatible owner always wins over this preference.

Unregistration removes discovery, not running services or game ownership.
Cached files are retained conservatively so an update or uninstall cannot
remove dependencies still in use. Do not delete cache directories or target
claims merely because the supplying app has exited. This is not a background
cache-management or installation-service framework.

### Distribution and bootstrap baseline

The generated standalone distribution lives in
`dist/broker/<platform>-<architecture>`; Windows x64 hosts use `win32-x64`.
Keep its complete file tree intact and unpack it onto the real filesystem when
using ASAR packaging. `broker-manifest.json` schema 1 records the implementation
version, broker protocol range, platform, architecture, fixed executable name,
and relative payload paths with byte sizes and SHA-256 digests. The manifest
excludes itself. The executable embeds Node.js 26.12.1; the adjacent service
modules, tslib and its notices, Node/project licenses, and both native target
architectures are part of the sealed distribution. No catalog entry supplies
an arbitrary command line or asks another application's Electron to host it.

The catalog is `catalog.json` under the account-token home directory's
`.electron-game-overlay/broker-v1` namespace. Use the supported setup API rather
than hand-editing it. Schema 1 has an `entries` array:

- `id` is the lowercase SHA-256 content identity of the normalized validated
  distribution manifest. Equal distributions share this identity and cache.
- `registrationId` is the lowercase SHA-256 of the canonical source directory,
  case-folded on Windows. It is the return value used for owner-specific
  unregistration. It remains stable when that installation updates its payload.
- `rankingVersion` is an optional implementation-version hint written from the
  validated manifest. It permits ranking a large snapshot without opening every
  payload. It supplies no launch path or execution authority; the selected
  manifest must match the hint and content identity and pass full validation.

Legacy entries containing only `id`, or `id` plus `registrationId`, remain
readable. Deduplicate content across the complete admitted snapshot before
expensive reads; do not exclude owners after an arbitrary registration prefix.
Legacy manifest lookups remain subject to the actual metadata deadline.

Discovery ignores unusable optional catalogs and retains ordinary own-bundle
fallback. Catalog mutation is stricter: only a missing file initializes an empty
document. Registration/unregistration refuse unsupported, malformed, oversized
or unreadable existing documents rather than overwriting them. Schema-1 writes
preserve safe additive document and other-owner entry fields. Publication is
atomic, not a guarantee of power-loss durability.

The catalog and standalone manifest are compatibility contracts for catalog-aware
bootstraps: preserve existing meanings, tolerate safe additive fields, and never
add a new required field to the frozen baseline.
Hashes detect damaged or changed payloads; they are not publisher signatures or
protection against malicious software running as the same user.

Pre-catalog POC SDKs can still join through frozen broker v1, but their old
bootstrap code cannot retroactively consult this catalog. Do not confuse those
mixed-wire compatibility tests with proof that old POC launchers implement
advance discovery. From the catalog-aware baseline onward, every compatible
bootstrap must preserve this discovery path.

Coordinator startup is not native-injection ownership. An OS-released launch
mutex limits concurrent starts, and the fixed v1 listener selects one running
coordinator. A crashed launcher or stale advisory startup record must not make
ordinary startup permanently unavailable. A replacement compatible coordinator
still has to adopt every durable target claim; it cannot reinterpret its own
restart as permission to inject again. Shared startup requires proven medium
Windows integrity and rejects elevated or unknown-integrity callers before
executing per-user cached code. OS probes resolve the protected Object Manager
`SystemRoot` link through native filesystem canonicalization, then use the
resulting Win32 DOS path for executable and working-directory arguments.
Environment `SystemRoot`/`PATH` values are not authority, and a `GLOBALROOT`
device path must not be passed directly as a Windows process working directory.
Cross-user or cross-integrity delegation is not supported. The direct no-argument
executable entry repeats the integrity check
before loading service/native-provider modules; it cannot rely solely on an
SDK launcher having checked. Help and copy/write-only setup do not start that
service and remain usable in their documented current-account context.

## Required change and release evidence

Documentation is not a substitute for behavior verification. Changes to broker
discovery, election, protocol, recovery, or shared routing must retain the
following regression coverage, including the optional registry path:

- Independently built old/new compatible SDKs in both startup orders; late
  arrival of a higher generation after commitment must not replace the owner.
  Changing version strings on the same implementation is not sufficient.
- Highest eligible candidate selection within the bounded window, deterministic
  ties, and safe rejection of incompatible candidates without excluding older
  compatible clients.
- One target runtime/communication owner under simultaneous starts, ownership
  freeze, transport loss, broker restart, and possibly consumed authorization.
- Per-app scene/input isolation, retained ordering, interception arbitration,
  member exit/crash, and continued operation of surviving applications.
- Optional pre-registration with the selected implementation's supplying app
  stopped; a valid compatible service must be launchable independently.
- Absent/stale/corrupt/unavailable catalogs, unregistered clients, concurrent
  catalog updates, and safe pre-publication fallback. None may silently bypass
  committed ownership or require developers to register in advance.
- Frozen raw-v1 message/recovery fixtures plus actual mixed-package acceptance
  as releases become available. Additive features must preserve old readers and
  negotiate optional capabilities rather than expand the required baseline.
- Bounded resource/slow-consumer behavior as client and scene counts grow. Keep
  synthetic many-client stress, independently built mixed-version packages,
  and real Windows/native acceptance distinct; do not turn a simulated count
  into a 500-app/500-version capacity claim.

For each change, state which gates ran, which boundaries were controlled, and
what remains unverified. Existing source/tests and historical Windows runs do
not establish that every future package combination or Windows/native target
already works.

`broker-package-install.acceptance.cjs` packs the actual built SDK, installs it
and its real bundled dependency offline with scripts disabled, and checks the
installed public Node-only `./broker` export and declarations without Electron
or ancestor dependency fallback. It verifies every declared sealed payload and
packaged PE architecture. Removing a sealed dependency must fail the actual
tarball check; a source import or package file count alone is not acceptance.

`native-injection-binding.acceptance.cjs` takes explicit freshly built x64/x86
injectors and the installed MSVC developer-environment script. It compiles only
owned console targets and an inert marker DLL, compares actual child-reported
FILETIMEs with retained parent query handles, and exercises matching, mismatched
and malformed exact-PID expectations on both architectures. Both legacy marker
loads must succeed before an old injector's unknown-option rejection can count
as a missing-CLI RED. A compiler/setup failure, timeout or arbitrary nonzero exit
is not that behavioral result. Genuine Windows matching/mismatch acceptance and
source review of actual same-handle placement remain distinct from portable
parser, cancellation and LF/CRLF checkout regressions. The fixture changes no
host token or security setting and proves neither ordinary-medium shared-service
startup nor real-game graphics/input behavior.

## Repeatable failure and contention exercises

After compiling the SDK, the normal unit suite includes
`broker-crash-recovery-hardening.test.cjs`. It launches only fixture-owned broker
children, uses the production server/client, persistent claim files and target
TCP transport, and abruptly terminates only those children. Cases cover a crash
after the real `publishing` claim rename but before grant delivery, recovery
with no prior SDK application process left alive, and two consecutive crashes
with surviving clients. A controlled game peer reauthenticates after
replacement. The regression checks pinned ownership,
retained scene/order/frame data, isolated input, interception requests and
single settlement of existing authorizations. The fixture suppresses automatic
external bootstrap and starts its replacement child explicitly: this is not
standalone SEA startup or native-game acceptance.

`broker-election-load-hardening.acceptance.cjs` requires an absolute
`EGO_HARDENING_OLD_DIST` pointing to an independently compiled compatible SDK
`dist` directory. Run it with `node --test`; it is intentionally outside the
ordinary unit-test glob. CI reuses its separately compiled compatibility ref.
Both coordinator implementations and both client arrival orders run against
fresh servers; apps become ready before submitting their target requests into
the actual 50 ms cohort. A later generation-99 provider must wait and join,
not replace the committed owner.

The same acceptance exercises 32 and 64 real socket members with colliding
local window IDs and bounded frames. A paused reader uses a test-only reduced
256 KiB pending-queue ceiling to exercise the production overflow/cleanup path
without allocating the full default queue budget. Surviving members must keep
routing frames and input, and their interception requests remain effective.
The target/injection boundary and generation advertisements are controlled;
these counts are not Electron-app, native-runtime or 500-version capacity.

`process-instance-mixed.acceptance.cjs` also requires an independently compiled
old SDK, passed as an absolute `dist` path:

```sh
node libs/electron-game-overlay/tests/process-instance-mixed.acceptance.cjs /absolute/old-sdk/dist
```

It exercises current publication, actual older-reader acceptance and coordinator
rewrite, then current recovery after the older implementation drops the identity
field. Both a published claim and an actual held legacy-intent transaction must
retain their pinned route/lease without backfilling a new instance identity.
The runner checks an in-memory no-backfill mutation and a clean rerun, preserving
compiled graph hashes. These are private filesystem/transport fixtures, not OS
process identity, native injection or game acceptance.

## Read-only live recovery evidence

The demo's `broker-recovery-diagnostic.cjs` is an optional observer outside the
SDK/broker core; see [the manual procedure](two-application-game-test.md#observe-broker-recovery-without-changing-ownership).
It loads the embedded SDK's existing protocol implementation, sends only the
frozen hello, and closes its session. It never bootstraps an absent service,
authorizes a target, changes ownership files, or implements a new wire message.

On Windows, its own pipe handles obtain the server PID through
`GetNamedPipeServerProcessId`; limited-rights process handles obtain the image,
exact 64-bit creation time and token-user comparison. Matching before/after OS
observations must corroborate the welcome. A self-reported PID, expected image
basename or unchanged claim alone is not authoritative proof of a live broker
instance, executable authenticity, exclusive use or permission to terminate.
The observer's SID and full path remain in memory only. Claim credentials are
omitted; bounded projections retain phase and lease/route fingerprints.

Its transient hello sessions can delay idle shutdown. Reports explicitly leave
other-client exclusivity, native injection count and native recovery unverified.
An observation of unchanged pinned ownership is not physical-game acceptance.
The diagnostic does not add process-creation identity to existing target claims
or implement the deferred ACL/client-identity hardening below. Missing evidence
is unknown, never permission to inject again or erase a claim.

## Resource bounds and backpressure

The broker uses fixed admission bounds, not a performance scheduler:

- The frozen v1 JSON body limit remains 1 MiB. Broker-wide window metadata is
  admitted conservatively so any retained aggregate scene can still fit an
  `overlay.init` snapshot, including its target-global IDs. Rejected changes do
  not replace previously accepted metadata.
- Retained frame packets have a 256 MiB aggregate budget across broker clients,
  and each loopback transport scene has the same retained-frame ceiling.
  Framing bytes count toward that budget. Admission precedes retaining or
  copying new frame pixels; closing a window or client releases its share.
- Each peer's unsent packet queue has a 258 MiB ceiling, allowing a maximum
  frame plus v1 initialization/control data. Only still-unsent frames for the
  same window in the same control-free segment can replace one another.
  Control messages remain ordered and are never silently discarded to make
  room for a frame.
- If a queue cannot remain within its bound, its write-error path closes that
  connection and releases its resources. Other peers and the target ownership
  claim remain intact. Target-side queue overflow reports a normalized
  `ENOBUFS` diagnostic and permits reauthentication to the existing route,
  never another injection merely because the connection closed.

These are bounds on specific retained and queued structures, not a total RSS,
GPU-memory, throughput, or 500-application capacity guarantee. There is no
adaptive throttling, per-app performance score, fairness scheduler, or
busy-client timeout policy.

## Legacy attachment lane

Name-only and path-watcher targets need a rendezvous before an exact PID is
known. The SDK preserves that behavior through an app-local legacy transport
and an atomic per-user named-pipe ownership lock that the OS releases on process
death. It is intentionally exclusive and cannot provide same-PID multiplexing.
Applications that may overlap must use their process watcher and pass an exact
PID to `attach()`.

## Trust boundary and deferred hardening

The current broker treats applications running as the same Windows user as
trusted peers. It must not run elevated relative to its clients. The startup
guard verifies the mandatory-integrity label; it does not audit every token
group or privilege. Medium integrity alone is not a sandbox or proof that a
manually filtered administrative token is equivalent to an ordinary desktop
user token. Do not add automatic de-elevation or use relabeled token output to
claim supported-token acceptance. The following remain explicit hardening
rather than accepted feature claims:

- verify the connecting process identity and apply an explicit per-user named
  pipe ACL;
- bind injection itself to process-creation identity before allowing automatic
  PID-reuse claim release, and use that authority for any future
  cross-protocol-major target arbiter; the optional recovery evidence above does
  not provide either guarantee;
- add per-client quotas only if concrete usage justifies them; the current
  broker-wide admission and per-peer queue bounds are described above;
- add further stalled-owner diagnostics only where needed, without ever
  promoting another injector after route publication;
- add tarball/install acceptance and oldest-v1/latest package matrices in both
  startup orders when package publishing begins.
