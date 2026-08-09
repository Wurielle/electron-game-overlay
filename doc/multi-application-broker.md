# Same-PID multi-application broker

This document records the internal ownership contract that lets independent
Electron applications use `electron-game-overlay` against one target PID. The
consumer API does not expose the broker: every application still creates its
own `ElectronGameOverlay`, `OverlaySession`, windows, and
`ReShadeOverlayLauncher`.

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

A future release that cannot preserve protocol and target transport v1 is a
different compatibility family. A new pipe name alone is unsafe because two
broker majors could inject the same PID. Such a release must first add a
protocol-independent per-user arbiter keyed by PID plus process-creation
identity; until then, a breaking broker/target-wire major must not ship.

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
