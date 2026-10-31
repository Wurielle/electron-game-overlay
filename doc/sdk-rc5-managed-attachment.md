# rc.5 managed attachment and packaging

rc.5 adds public application-side helpers around the existing launcher, process
observer and sealed distribution. The broker wire contract and mapped native
runtime are unchanged from rc.4: generation **6**, add-on build ID
**1CAEA7482B41451AB31FC2F91B46F2DD**. Different SDK versions retain the same
single-owner v1 route, election rules, and no-hot-replacement behavior.

## Public API

`createReShadeLaunchConfig(options?)` directly validates runtime artifacts and both
architecture manifests. It starts nothing and needs no synthetic CLI flag.
`bundledRuntimeDirectory` and `runsRootDirectory` remain optional overrides.
Default runtime discovery now resolves the compiled SDK's physical
`app.asar.unpacked` location automatically, as broker discovery already did.
`parseReShadeLaunchConfig(argv, options?)` remains the explicit opt-in parser for
real CLI applications and uses the same validator.

`new OverlayTargetWatcher(session, options)` owns observation and launcher
lifetimes. Start the session separately and await `watcher.ready` before target
launch. Initial readiness covers session readiness, the observer baseline,
prepared best-effort assets when requested, and every native early watcher.
It does not mean a game is attached or rendered.

```js
const config = createReShadeLaunchConfig({
  runsRootDirectory: path.join(app.getPath('userData'), 'overlay-runs'),
});
session.start();
const targets = new OverlayTargetWatcher(session, {
  config,
  earlyTargets: [{processName: 'game.exe', executablePath: approvedExactPath}],
  // Optional application policy for OTHER newly observed processes:
  acceptBestEffort: identity => applicationAllows(identity.executablePath),
  onEvent(event) {
    if (event.type === 'armed') console.log('Selector ready for a future launch');
    if (event.type === 'connected') console.log('Authenticated', event.target.pid);
    if (event.type === 'error') reportFailure(event.error);
  },
});
await targets.ready;
```

Early selectors must already be fully authorized: exact executable basename and
optional exact full path, without globs or JS predicates. They retain native
filtering before mutation. Case-equivalent and overlapping selectors are rejected.
Already-running processes are baselined and are never treated as creation events.

The optional best-effort predicate is synchronous application policy evaluated
after an authoritative process-creation observation. It cannot safely authorize
pre-graphics injection; fast graphics startup may outrun it. Native exact-PID
attachment still uses the existing broker ownership and identity checks.
A matching early selector, including a busy or disabled reservation, suppresses
duplicate exact-PID fallback. No executable-name heuristics or exclusions were
added to the demo Steam auto-attacher.

Events are `ready`, `armed`, `attaching`, `connected`, `transport-lost`,
`cancelled`, `exited`, and `error`. `targets` returns immutable attempt snapshots
with mode, status, cancellation state and the observer's exact creation-time
identity when available. Authentication is coordinated by the existing launcher,
including authentication arriving before the injector result. A later
authentication can recover a retained known failed/transport-lost attempt without
a second injection. Authenticated connection does not promise a graphics surface;
continue using session surface events for layout.

`update(policy)` cancels removed watchers synchronously and returns readiness for
new watchers/preparation. An unchanged best-effort target can be retained by the
new predicate; cancellation never authorizes reattachment. `cancel()` removes
policy but continues authoritative observation of retained attempts.
`dispose()`, an AbortSignal, or session close stops only this controller's work.
Callers still own session/owner/window disposal and interception requests.

Uncertain attempts remain reserved until authoritative observer exit. Timeouts,
transport loss, policy cancellation and application shutdown never imply exit.
Only matching OS process-incarnation observations call confirmTargetExited and
retire an attempt. A fresh early launcher is rearmed after proven exit; observe
the next `armed` event before launching again. A cancelled selector whose PID
was never proven can remain reserved for the controller lifetime. Re-adding or
narrowing an overlapping uncertain selector rejects and cancels active policy.
A fresh controller starts a new future-only baseline; it must not be used to
retry an uncertain live PID. Ambiguous PID reuse or observer failure fails closed.

One early watcher consumes one matching process until its exit. It does not cover
simultaneous additional instances or guarantee coverage during the rearm gap.
The existing early/untargeted lane remains exclusive across applications; exact-PID
attachment remains the multi-application route. This additive controller does not
remove that architectural limitation or turn post-creation policy into an early
injection guarantee.

## Electron-builder integration

Install the SDK as a production dependency. From a Node build configuration:

```js
const {createOverlayAfterPack} = require('electron-game-overlay/packaging');
module.exports = {
  asar: true,
  asarUnpack: ['node_modules/electron-game-overlay/**/*'],
  afterPack: createOverlayAfterPack(),
};
```

Keep other unpack patterns and compose existing hooks: await the application's
hook, then await the SDK hook. Use this before signing/installer generation.
The helper does not rewrite ASAR headers, so the SDK unpack pattern is required.
It derives the installed SDK root itself; an explicit `packageRoot` override
supports build layouts that resolve it elsewhere, including pnpm package symlinks.

The Node-only packaging export also provides
`packageOverlayForElectronBuilder(context, options?)` and
`verifyOverlayPackage(packageRoot)`. It validates the source sealed manifest,
copies package metadata/legal/provenance files and all distribution files,
including nested dependencies and notices, then verifies the actual destination.
Root module/runtime mirrors must match the sealed provider. Top-level peer
dependencies and .bin wrappers are not package payload and are not copied.
Source payload symlinks and output junctions escaping the specified build
directory are refused. A verified staged tree replaces only this SDK package
inside the supplied build output, with rollback on failure. No cache registration,
broker startup, injection or user-install modification occurs in this helper.

## Izabela migration

Read-only review used apps/app/src/electron/experimental-game-overlay.ts and
apps/app/electron-builder.config.js at the consumer checkout. No Izabela file
was changed.

| Current consumer code | Adoption |
| --- | --- |
| Synthetic parseReShadeLaunchConfig argv and manual ASAR runtime path | createReShadeLaunchConfig with only the app's writable runsRootDirectory |
| prepared launcher, observer, launchers/earlyProcesses maps, armEarlyProcess | one OverlayTargetWatcher |
| injector-watcher-ready handlers and custom readiness promises | await ready/update; armed events after exit/rearm |
| processEvent attachment/deduplication, uncertain retention, exit confirmation | controller lifecycle; use its target snapshots/events |
| Custom afterPack SDK copy/filter logic | SDK createOverlayAfterPack; preserve SDK asarUnpack pattern |
| Settings/database hydration and micromatch allowlist/denylist | retain in Izabela; calculate fully authorized early selectors and best-effort policy there |
| IPC compatibility, surfaces, backend selection, cleanup | retain in Izabela |
| Opening and choosing a DOM input | retain show(), focus(), input.intercept() and application DOM focus |

Policy changes should build a fresh policy snapshot and call update immediately;
handle rejection by leaving the cancelled policy stopped and reporting it.
No arbitrary glob authorization is moved into the broker. The adapter can also
simplify redundant local readiness/generation plumbing once one controller owns
the relevant lifetime, but UI state and application cancellation still belong in
Izabela. The new minimal consumer is examples/managed-overlay; the existing
low-level basic-overlay example remains compatible.

## Validation and release evidence

- SDK TypeScript and standalone broker build, full SDK unit suite, dedicated
  controller races, direct setup validation, packaging/pruning/junction tests:
  **721 passed, 9 skipped, 0 failed** in build/rc5-final-sdk-tests.log;
  **15 controller races passed** in build/rc5-watcher-tests.log.
- Independent compiled v1 mixed-package/startup-order acceptance:
  build/rc5-mixed-package.log. No broker protocol/election change was introduced.
- Genuine managed D3D11 acceptance launches two owned fresh targets, verifies
  authenticated rendered scenes and exact observer creation identities, confirms
  real exits, excludes an already-running baseline target throughout, and cancels
  policy. Final evidence: build/managed-targets-20261031-135905/report.json
  and mapped-artifacts.json (both mapped add-on hashes match rc.4/rc.5).
  The host intentionally waits before graphics initialization; this is
  best-effort lifecycle acceptance, not proof of race-free early attachment.
- Native early-controller acceptance was blocked by the running Izabela instance's
  legitimate exclusive early lane. It was left untouched. Early readiness,
  cancellation, ordering, deduplication, failure and rearm are regression tested;
  native early-controller acceptance remains unverified in this session.
- Actual electron-builder 26.18.0 dir build with Electron 46.0.0-alpha.2,
  ASAR creation, SDK afterPack, final EXE launch, default runtime discovery from
  ASAR, all 53 sealed files, damaged nested notice rejection and restored clean
  rerun: build/rc5-packaged/report.json. This is a noninjecting packaged smoke.
- Isolated tarball installs, strict public types and genuine Electron 39/46 DOM
  smoke for the managed example: build/sdk-rc5-managed/consumer-electron39.json
  and consumer-electron46.json. Basic-example compatibility is checked separately.
- rc.4's 20 native wheel/cursor/scaling cases remain historical evidence.
  The mapped native bytes remain identical; that full desktop-input matrix was
  not rerun for these application-side APIs.

Candidate and checksum/provenance are retained under build/sdk-rc5-managed.
SDK_PROVENANCE.json identifies the dirty source snapshot and per-file manifest,
rather than claiming base 1ff4baeb5930bb20d6dff0d8e69ca05c8eb8be98 is the modified
source revision. The exact native generation and both architecture identities
are recorded. No commit, push, publication, PR merge, Defender change, unrelated
client termination, or runtime hot replacement was performed.

Custom bitmap cursors still use the documented arrow fallback. Installer signing,
updates, non-Windows cross-packaging, arbitrary game startup timing, and native
early-controller coexistence are not established by this release's tests.
