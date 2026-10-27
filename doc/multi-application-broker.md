# Same-PID multi-application broker

This is the canonical compatibility and ownership contract for independent
Electron applications using `electron-game-overlay` (EGO) against one target
PID. The consumer API does not expose the broker: every application still
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

- The **bootstrap** finds or starts the shared broker. Optional advance
  discovery described below is planned work, not an existing public API.
- The **broker** coordinates application members and owns the shared target
  communication path. Today the first compatible running broker stays in
  charge; selecting a newer broker from an installed catalog is not implemented.
- The **runtime provider** supplies the validated native artifacts and performs
  the elected attachment. Its explicit compatible runtime generation, not npm
  semver alone, determines priority in the current bounded target election.

The highest eligible compatible provider registered before the election cutoff
wins. It need not be the first application to start. After target-route
publication may have begun, a later newer version joins the selected runtime;
hot takeover and live native-runtime replacement are not requirements. This
freeze is a safety invariant, not a failure to prefer the newest eligible
candidate within the election window.

The following current-design sections describe implemented behavior, not a
blanket acceptance claim. The later advance-registration section specifies
required future behavior and explicitly unresolved design details.

## Invariants

- One broker protocol-v1 pipe, derived from the Windows process-token account
  identity rather than mutable environment variables, accepts application
  sessions for that user.
- One broker target host and one authenticated loopback transport exist per
  exact PID.
- One process-crash-persistent write-ahead claim under the same user's home
  directory pins the exact target route and lease for each live PID.
- One application is elected injection owner from a bounded cohort before any
  target route is published.
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

## Attachment sequence

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
   normal injection.
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
- Recovery claims and route-ownership evidence are retained across graceful
  broker shutdown too. Endpoint credentials may rotate only through the pinned
  route's write-ahead transaction; the ownership evidence is removed only
  after definitive target exit, preventing a zero-application interval or
  repeated broker crashes from reopening injection ownership.
- A broker with no clients and no retained target hosts or claim anchors shuts
  down after 30 seconds.

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

## Optional advance registration: required design, not implemented

Advance registration is an additional discovery failsafe. An app may register
its installed EGO implementation ahead of startup so an older app starting first
does not hide a newer available implementation merely because the supplying app
has not started. It must remain optional: no mandatory global installation,
pre-registration ceremony, or registry edit is required to use ordinary
startup registration and joining.

The intended flow is:

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
- A failed candidate may yield only with proof that target-route publication
  has not started, after safely releasing its singleton ownership. Any target
  intent must still be the exact authoritative, pre-consumable intent. The
  `publishing` phase is already beyond that boundary, even before the final
  route file appears. Retain existing target recovery claims; a timeout or
  uncertain mutation cannot authorize another injector before authoritative
  target exit.
- Preserve the catalog's eventual backward-compatible schema and selection
  semantics just as carefully as the wire protocol. Define broker selection
  ordering separately from native artifact generation; an npm version label
  alone is not proof of compatibility or suitability.

The registry location, exact schema/API, trusted launch format, broker-version
ordering, registration/unregistration lifecycle, candidate-host requirements,
and fallback implementation are not yet specified or shipped. Define these and
their compatibility/migration rules before claiming registry support. Do not
publish sample configuration or method names as if an API already exists.

## Required change and release evidence

Documentation is not a substitute for behavior verification. Changes to broker
discovery, election, protocol, recovery, or shared routing must retain the
following regression coverage, with planned registry cases added when that path
is implemented:

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
not establish that the planned registry or every future version already works.

## Legacy attachment lane

Name-only and path-watcher targets need a rendezvous before an exact PID is
known. The SDK preserves that behavior through an app-local legacy transport
and an atomic per-user named-pipe ownership lock that the OS releases on process
death. It is intentionally exclusive and cannot provide same-PID multiplexing.
Applications that may overlap must use their process watcher and pass an exact
PID to `attach()`.

## Trust boundary and deferred hardening

The current broker treats applications running as the same Windows user as
trusted peers. It must not run elevated relative to its clients. The following
remain explicit hardening rather than accepted feature claims:

- verify the connecting process identity and apply an explicit per-user named
  pipe ACL;
- carry target process-creation identity in addition to PID/path and use it for
  any future cross-protocol-major target arbiter;
- cap per-client windows, retained frame bytes, and outbound queue bytes;
- add bounded stalled-owner diagnostics without ever promoting another
  injector after route publication;
- ship a dedicated broker executable for Electron packages that disable the
  RunAsNode fuse;
- add tarball/install acceptance and oldest-v1/latest package matrices in both
  startup orders when package publishing begins.
