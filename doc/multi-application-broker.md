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
Win32-path flags. It does not enumerate target modules, inject, or open/mutate
game or ReShade files. Success is one UTF-8 JSON line:

```json
{"schemaVersion":1,"kind":"electron-game-overlay-process-image","pid":123,"executablePath":"C:\\Games\\Game.exe"}
```

The broker requires the matching PID, schema/kind, and a valid full Windows path.
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
trusted peers. It must not run elevated relative to its clients. The following
remain explicit hardening rather than accepted feature claims:

- verify the connecting process identity and apply an explicit per-user named
  pipe ACL;
- carry target process-creation identity in addition to PID/path and use it for
  any future cross-protocol-major target arbiter;
- add per-client quotas only if concrete usage justifies them; the current
  broker-wide admission and per-peer queue bounds are described above;
- add further stalled-owner diagnostics only where needed, without ever
  promoting another injector after route publication;
- add tarball/install acceptance and oldest-v1/latest package matrices in both
  startup orders when package publishing begins.
