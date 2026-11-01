# rc.7 basename-glob policy updates

rc.7 fixes the deterministic rc.6 failure when an application adds and removes a
basename glob while an already authenticated game remains authorized by a folder
rule. This is separate from the known intermittent startup race.

The exact regression is:

```js
await targets.update({earlyPolicy: {allow: [folder + '/**'], deny: []}});
// Launch and authenticate a target under folder; its successor is already armed.
await targets.update({earlyPolicy: {
  allow: [folder + '/**', '**/d3d11_overlay_test_host.exe'], deny: [],
}});
await targets.update({earlyPolicy: {allow: [folder + '/**'], deny: []}});
```

The final update now preserves the live target's launcher, scene, focus and input.
No basename expansion, JavaScript attachment fallback, wildcard-inclusion guess,
or reinjection is used. The basename glob changes future coverage globally, so
it is not treated as equivalent to the narrower folder policy.

## Active authorization and discovery

`update(policy)` validates the policy, applies active authorization synchronously,
then settles discovery changes. A still-authorized target remains live. A genuine
deny or removal of its last authorization cancels it synchronously. Invalid policy
still throws before changes are applied.

An unused native policy watcher is stopped and its complete output drained before
a replacement is armed. The existing validated capability-2 injector checks and
flushes its PID/image/creation-time selection record before acquiring an injection
claim, examining reusable runtime gates or mutating target memory. The SDK accepts
an unused-watcher retirement only with authoritative owned-child exit, stdout end,
no output/capture error, and no selection/result/success record. A kill request,
timeout, partial output, output-limit error, old capability, known selection or
uncertain exit cannot supply this proof. Known selected incarnations retain their
reservations; no uncertain live PID is retried. Child retirement never calls target
exit confirmation or releases broker game-recovery claims.

If discovery cannot be safely replaced, the update resolves after applying active
authorization and emits `discovery-blocked`. It does not cancel allowed targets or
emit a new `ready` claim. This replaces rc.6's synchronous reservation exception
and blanket cancellation. Applications should report the discovery condition
without treating it as a request to hide or release an authorized overlay:

```js
onEvent(event) {
  if (event.type === 'discovery-blocked') {
    reportFutureDiscoveryUnavailable(event.error);
  }
}
```

`ready`/`armed` remain the signals that native future discovery is available.
Awaiting `update` means policy application/discovery settlement; it does not imply
that an uncertain reservation was cleared. Named watchers without this native
proof remain conservative. Unrelated authorized discovery can continue. Pending
updates are serialized, and a superseded revision cannot arm its obsolete policy.
Native policy intersections are treated conservatively; the SDK does not infer
general glob inclusion or disjointness to discard a reservation.

A new watcher takes a future-only baseline. Processes created during replacement
can be missed or baselined; await discovery readiness before launching a target.
This change does not turn polling into a controlled creation hook or establish
reliable pre-graphics attachment.

## Validation

- Complete SDK suite: **745 passed, 9 skipped, 0 failed** in
  `build/rc7-sdk-tests.log`. Focused controller and launcher checks: **198 passed**
  (21 controller and 177 launcher cases) in `build/rc7-focused-tests.log`. These include the precise folder/global
  basename/folder sequence with an already-armed successor, an uncertain stop
  preserving an active target, genuine denial, obsolete concurrent revisions,
  pre-spawn cancellation, complete vs incomplete drains, capped output, selected
  or malformed selection records, failed termination and older capabilities.
- Real native unused-watcher checks:
  `build/rc7-native-policy-quiescence.json`. The actual SDK x64 watcher and both
  x64/x86 native injectors were stopped with complete unused output. No target
  was created or injected, and no desktop input was used. The source-order checks
  are identified separately from native execution in that report.
- **Passed real D3D11 x64 basename-glob lifecycle:**
  `build/native-pointer-20261031-200648/report.json` and `a-state.json`.
  Electron 46.0.0-alpha.2, 100% scale, no startup barrier, no injection-wait marker,
  no JavaScript attachment fallback. Initial folder-only authorization was followed
  by adding `**/d3d11_overlay_test_host.exe` and removing it with unchanged denies.
  Both update records are `applied`; actual composited glyph checks prove typing
  immediately after removal without clicking. A fresh same-path no-delay relaunch,
  first key, genuine revoke, native pixels/input release, wheel/cursor and foreground
  controls also passed. Explicit helper, baseline and outside-folder controls were
  checked for absence of ReShade/EGO modules. This is the standalone SDK case;
  the completed real-consumer validation is recorded below.
- The consumer's rc.6 reproduction is retained read-only at
  `C:/Users/Wuriko/.codex/worktrees/0be1/izabela/coverage/experimental-overlay/e2e/2026-10-31T18-51-14.214Z/d3d11-x64/report.json`.
  The SDK fix did not patch Izabela; a separate consumer task installed the complete
  unmodified candidate and tested its real renderer/store/IPC path.
- Final tarball consumer strict types and genuine Electron DOM smoke, actual
  electron-builder ASAR launch with 54 sealed payloads, mutation rejection and
  restored clean verification are recorded under `build/sdk-rc7-discovery` and
  `build/rc7-packaged/report.json`. These are noninjecting package checks.

The exact rc.7 tarball
(`dcf989d08a1c2913023c5d5983f080c12307e9fbd01952e630eed532cc040f9d`)
subsequently passed Izabela's actual basename-glob update regression. Both policy
updates resolved; native typing and glyph pixels survived removal, and genuine
denial removed the overlay and returned native keyboard input to the game. The
consumer index `coverage/experimental-overlay/rc7-validation.json` records 12
passing native scenarios across D3D9/10/11/12, x64/x86, fractional scales, focused
lifecycle runs and focus-negative controls, plus 81 overlay/package and 125 app
checks. Its focused runs are `2026-10-31T19-26-52.139Z` and
`2026-10-31T19-27-07.441Z`. The latter also passed a fresh no-barrier relaunch
after basename removal. An initial harness failure remains preserved: it waited
for a final interception acknowledgement after revocation; the corrected check
uses actual removed pixels and native key delivery as the release evidence.
The SDK candidate's `consumer-validation-addendum.json` and `evidence/izabela-rc7`
retain that evidence without changing the package or its source snapshot.

Runtime generation **7** and exact add-on ID
**12EE788081A34E00B10862242DF38893** remain unchanged. Native runtime files are
verified byte-for-byte against the complete rc.6 candidate. There is no mapped
native implementation or ABI change, broker wire change, coordinator takeover,
new mandatory capability or version equality restriction.

The rc.6 fast-start failures remain valid historical evidence. The new passing
no-barrier sample establishes this policy lifecycle case, not startup reliability.
The standalone case alone does not establish other backends, x86 rendering or
fractional scales; the separate consumer matrix supplies those measured cases.
No npm publication, Defender change or foreign ReShade mutation is part of this
change.

The candidate, per-file source snapshot, dirty-source provenance and checksums are
under `build/sdk-rc7-discovery`. Provenance records the package's base commit and
per-file dirty source snapshot. These consumer-validation notes were added after
that snapshot was sealed; the package and implementation remain unchanged.
