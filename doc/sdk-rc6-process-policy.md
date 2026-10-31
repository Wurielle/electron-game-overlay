# rc.6 native process policy candidate

Erratum: rc.6 still fails removal of a global `**/name.exe` rule after adding it
while a folder-authorized target is live. Its literal-path test did not cover that
case. See [the rc.7 fix and evidence](sdk-rc7-discovery-policy.md).

This candidate fixes policy retention and adds native full-path allow/deny
filtering. **It is not accepted for reliable fast-start attachment.** With Izabela
closed, one complete genuine D3D11 folder-only lifecycle case passed without a
startup barrier, while another fresh run selected the intended incarnation and
loaded ReShade but never authenticated. Polling a future process is still a race
with graphics initialization. Do not present `ready` or a successful
DLL load as a guarantee of an attached, rendered overlay.

The candidate uses runtime generation **7**, exact add-on build ID
**12EE788081A34E00B10862242DF38893**, transport/broker v1, ReShade build stamp
schema 29, package manifest schema 4 and optional injector future-target
capability 2. The frozen broker election, recovery claims and no-hot-replacement
rules remain in force. Older compatible clients may join the committed owner.

## Policy API and migration

```js
const targets = new OverlayTargetWatcher(session, {
  config: createReShadeLaunchConfig(),
  earlyPolicy: {
    allow: ['**/steamapps/**'],
    // Explicit application choices; the SDK has no implicit helper exclusions.
    deny: ['**/UnityCrashHandler64.exe', '**/UnityCrashHandler32.exe'],
  },
  onEvent(event) {
    if (event.type === 'error') reportFailure(event.error);
  },
});
await targets.ready; // native watcher armed; attachment is not established
```

The public types are `OverlayProcessPolicy`, `OverlayTargetPolicy` and
`OverlayEarlyTarget`. `createOverlayProcessPolicy` validates and freezes a policy;
`overlayProcessPolicyAllows` applies the same bounded grammar in application code.
`ReShadePathTarget.processPolicy` also exposes this filtering to low-level
launchers. Managed `earlyPolicy` replaces application executable-name expansion
for native folder authorization. No executable enumeration or new name selectors
are needed in the consumer. Existing `earlyTargets` remain supported.

Patterns use full drive/UNC paths or a `**/` prefix, slash or backslash separators,
ASCII-insensitive literals, `*` and `?` within one component and whole-component
`**`. Literal parentheses, spaces, Unicode and hidden components are supported.
Deny wins over every allow and over `acceptBestEffort`. Extglobs, braces, classes,
negation, relative/dot components and malformed UTF-16 are rejected. At most 256
patterns, 4096 UTF-16 units per pattern, 128 components per pattern and a 64 KiB
serialized public policy are accepted. This is an explicit grammar, not arbitrary
JavaScript glob or predicate compatibility.

A policy is written as private data in the owned run directory and checked
natively before mutation. The selected process handle supplies image path and
creation time; the actual reopened mutation handle is checked against that exact
incarnation before injection. Selected identity is also emitted before injection
completion. Managed admission checks the optional native process-instance hello
against this identity. The field adds no mandatory v1 requirement for ordinary
older peers and is not broker recovery/exit evidence.

`update(newPolicy)` retains an already proven target when the new policy still
authorizes it, including removal of a redundant executable rule while a folder
rule or the best-effort policy continues to allow it. Its launcher, scene and input
state remain live. A genuine denial marks the target cancelled and stops private
legacy frame/input delivery synchronously, clears queued frames and sends empty
scene/input-release commands. Delivery stopping locally does not promise that a
remote screen changes in the same synchronous call. Cancellation does not unload
ReShade or prove process exit; the possibly consumed attempt remains reserved.
A late native reconnect cannot restore a revoked target.

A selected policy target gets a successor watcher with the original cutoff and
exact exclusions for attempted incarnations. An allowed helper's attachment
failure is its own result and does not become the game's result. A denied helper
is skipped before injection. There are no default helper-name heuristics. A
reserved PID observed with a different creation time fails closed; no automatic
PID-reuse recovery or retry of uncertain injection is established. Process-exit
retirement still depends on authoritative observer evidence.

The early lane remains exclusive across applications. Use one controller for a
session; do not mix unmanaged global authorization with its admission policy.
The existing shared exact-PID route remains available through `acceptBestEffort`,
which is post-creation policy and can miss fast startup. Native 1 ms polling and
successor staging can also miss or attach too late. Neither route is a controlled
process-creation hook. A general reliable fast-start solution remains required.

The managed example accepts either `--target=C:\Games\game.exe` or the explicit
`--directory=C:\Games` and repeated `--deny=<pattern>` arguments. Exact-target
selection never silently authorizes its containing folder. Keep games closed
until armed, and treat native startup failures as failures without retrying the
live PID. The rc.5 setup/packaging API continues to apply.

## Validation evidence

- Full SDK build and unit regression results: **732 passed, 9 skipped, 0 failed**. `build/rc6-final-build.log` and
  `build/rc6-final-sdk-tests.log`. The policy tests invoke both real injector
  architectures in read-only evaluation mode, including component boundaries,
  explicit helper denial, Unicode and literal Program Files (x86) paths.
- Launcher regression covers split UTF-8 selection records, exact creation-time
  preservation into x86 handoff and rejection of an older injector capability.
  Managed controller tests cover retention, genuine denial, successor filtering
  and cancellation races. Real TCP loopback tests cover per-target revocation,
  continued delivery to another peer, reconnect rejection and optional incarnation
  admission. These tests do not establish real desktop rendering after updates.
- Native x64/x86 process binding controls: `build/rc6-native-binding.json`;
  Rust transport tests: 108 passed on each architecture; both transport ABI smoke
  executables passed. Binding gate source-placement reporting remains separate
  (`sameHandlePlacementVerified` is false); it is not claimed as a mechanical
  source-placement proof.
- Independently compiled old/new broker packages: five scenarios, mutation
  sensitivity and clean rerun passed (`build/rc6-mixed-package.log`). The native
  injection boundary is controlled in this matrix; it is not native desktop
  mixed-package acceptance.
- **Passed complete native lifecycle case:**
  `build/native-pointer-20261031-192126/report.json`. D3D11 x64, Electron
  46.0.0-alpha.2, 100% scale, native legacy input, folder-only allow and explicit
  helper deny. No startup barrier or injection-wait marker was present. Actual
  composited calibration/glyph pixels, first key without clicking, vertical and
  horizontal nested wheel input, cursor transitions, redundant-rule retention,
  a fresh same-path no-delay relaunch, genuine synchronous revocation and game
  input/pixel restoration all passed. The probe was proven OS foreground during
  the negative-control key. Explicitly denied helper, pre-existing baseline and
  outside-folder host modules had no ReShade/EGO injection.
- **Intermittent fresh-start failure remains:**
  `build/native-pointer-20261031-192056/report.json` and its state/injector logs.
  Izabela was closed, the exact PID/incarnation was selected and ReShade loaded,
  but no runtime startup/authentication occurred. The earlier
  `build/native-pointer-20261031-190611/report.json` failure is also preserved.
  A passing sample does not remove these failures or establish a universal early
  injection guarantee. These uncertain live PIDs were never retried.
- The first closed-Izabela run (`build/native-pointer-20261031-191822`) exposed
  a controller bug: restoring a policy after a redundant literal allow cancelled
  its armed successor as an uncertain reservation. The fix retains the same
  watcher for policies proven equivalent by covered literal allows and identical
  denies; it infers no general wildcard inclusion. An 18th controller regression
  covers add/remove with an armed successor. A later partial run
  (`build/native-pointer-20261031-192001`) reached relaunch but exposed an unproven
  foreground assumption in the harness. The corrected probe explicitly activates
  and checks its OS HWND before and after input. Both failures remain historical
  evidence; neither is counted as a full pass.
- The new complete desktop case covers only D3D11 x64, Electron 46 and 100% scale.
  The x86, other graphics backends and fractional-scale policy matrix remain
  unverified for this candidate.
- Historical rc.4/rc.5 desktop results remain historical. Generation 7 mapped
  bytes changed for the optional hello identity, so the previous desktop matrix
  is not a substitute for validating this candidate.

- Isolated tarball consumer checks for the managed example on Electron
  39.8.10 and 46.0.0-alpha.2, plus the existing basic example on Electron
  39.8.10: `build/sdk-rc6-policy/consumer-*.json`. Each checks strict public
  types and a genuine hidden Electron DOM without native attachment.
- Actual electron-builder 26.18.0 ASAR build with Electron 46.0.0-alpha.2:
  `build/rc6-packaged-successor/report.json`. It launches the final application,
  verifies default runtime discovery and all 54 sealed payloads, rejects a
  damaged nested notice, then restores it and verifies a clean rerun. It is
  a noninjecting smoke.

The complete local package and source snapshot are under `build/sdk-rc6-policy`.
`SDK_PROVENANCE.json` records the dirty per-file snapshot and base commit without
claiming that unchanged HEAD contains these edits. Package/consumer/ASAR reports
are noninjecting installation checks, not acceptance of the failed fast path.
No Izabela source/settings, running consumer, Defender settings, foreign ReShade
installation, commit, publication or PR merge was changed by this work.
