# Runtime checkpoint, 2026-11-10

This draft source checkpoint integrates the owned composition corrections
through generation 36 locally, after the generation-35 draft PR checkpoint. It
also retains diagnostic fixtures for separate startup
and Steam investigations. It is not a release or a claim that every actual-game
failure is resolved. Generated artifacts and machine-specific evidence remain
outside Git.

## Integrated behavior

The owned host can bind a null-HWND composition chain to exactly one eligible
visible top-level window in the exact target process. Lifetime tokens,
nonmigration and ambiguity checks remain mandatory. Reserved owned-stage INI
changes stay in memory; foreign ReShade installations remain protected.

Bounded binding/reset diagnostics expose why a composition binding changes.
Generation 34 excludes nonpresentation popup tools under the documented style
predicate. Generation 35 remembers only an already-excluded layered/topmost
popup tool without NOACTIVATE across changes to its LAYERED bit, with exact
window lifetime, owner, PID, thread and shape validation. A previously unseen
unlayered tool remains eligible. The table is bounded and fails closed.
See [the auxiliary lifetime contract](composition-auxiliary-lifetime.md).

The read-only process-incarnation query permits recovery from the exact native
image-query error 31 only with separate authoritative PID/creation-time evidence
of exit, absence or reuse. Error 31 alone never permits retirement. Each app
retains its own feature engine and transport, and possibly consumed host
ownership remains pinned until authoritative target exit.

Both architectures, staging and distribution validation require the exact new
patch/source provenance. Retained native fixtures reconstruct frozen inputs in
scratch directories. Dedicated launchers cover the human-facing cases. The
feature add-on and manager bytes remain unchanged in candidate 1012; the
feature add-on build ID remains `CCE20935ADD44EF6A5A7973014B2E07F`.

## Immutable candidate and validation boundary

Candidate `1.0.1-alpha.2026111012` / generation 35 remains immutable:

- Package SHA-256:
  `771bf913de1eb6d14492820b672659a484e0f91de2fd1a4372d40877e20fe96a`.
- Paired source ZIP SHA-256:
  `b279e64a6c9772fac54930ed0b4e1719d964374ac7bb76c1e9fc353684a3a59f`.
- Both native architectures built. Native policy, lifetime, diagnostics,
  forwarding, identity and source-cache gates passed. All 163 sealed payloads
  and the paired source capture/replay were verified.
- The final offline suite reported 707 tests: 706 passes, no failures and one
  unavailable historical fixture skip. An earlier run hit an existing launcher
  teardown ENOTEMPTY error; the isolated rerun and subsequent full rerun passed.
- Consumer acceptance reported 18 packaged graphics cases across 19
  authenticated lifecycles, including three administrator positive/focus-negative
  pairs. The controlled popup completed six layered/visibility transitions.
- Actual PAGER first/reopen scene and native glyph checks passed at normal
  integrity and high-to-medium integrity with OS typing and zero pointer clicks.
  Windows SendInput does not establish physical-key acceptance.

Candidate 1011's actual layered-tooltip reset failure remains recorded; passing
1012 launches do not erase earlier failures. A late 1012 hidden-tooltip
uniqueness diagnostic had no observed runtime reset or input loss. A possible
visibility sampling race remains a separate investigation, not a proven fix.

## Remaining startup and Steam investigations

A separate normal PAGER startup timeout (PID 56144) remains unresolved. A later
positive ETL validates the measurement path but does not establish the cause of
that untraced failure. The deterministic delayed-hook fixture reproduces a real
device being missed when a D3D11 load encounters the delayed-hook try-lock:
serialized controls pass, while contended cases return 3 with
`gatePassed:false` on both architectures. Later hook installation observes a
second device, but the original usable device remains native. This demonstrates
the mechanism without attributing the actual PAGER timeout to it.
See [the reproduction boundary](delayed-hook-publication-reproduction.md).

Generation 36 integrates the narrow owned deferred-adoption bootstrap into the
normal production patch pipeline. A validated missing-backend result may queue
one worker after successful D3D11 publication on the existing LoadLibrary path
and release of its delayed-path mutex. The worker revalidates stage/readiness.
The notification path, original try-lock and early returns remain unchanged.
It introduces no timer, loader wait, retry, reinjection or public ABI change.
A later Present adoption does not retroactively wrap the missed device or
guarantee first-frame observation. See [the correction and gates](owned-deferred-d3d11.md).

Both normal production architectures passed 24 deferred-startup cases with
four immutable 1012 failures retained. The 28-case cohort contains 2,744
assertions, 78 green hardware readbacks and 80 red runtime-callback readbacks.
It includes missed original HWND and null-HWND BGRA composition chains,
automatic proxy controls, DllMain/nested loads, exact forwarding and HRESULTs,
resize/resume/retirement, and foreign/readiness/queue-error negatives. The
composition presentation HWND stays outside all monitors without activation;
no DirectComposition visual or actual game is exercised. The original failed
window-setup attempt is preserved separately. Notification rendering passes
with zero deferred work items. These controls are distinct from actual startup,
application scene/input and mixed-application acceptance still owned by the
consumer test coordinator. Candidate 1013 binds the local changes to a fresh
paired source capture; candidate 1012 is not rewritten.

Local offline Overwatch testing observed the Steam performance HUD in both its
baseline and the authenticated high-to-medium 1012 launch. First-key/native
glyph acceptance passed in that separate launch. Full Shift+Tab menu acceptance
is inconclusive because it opened in neither baseline nor injected trial.
The earlier remote missing-overlay report remains separate. Owned foreign
Present controls validate forwarding, callbacks and GPU readbacks but do not
execute Valve's wrapper or establish rendered Steam frames on their own.

A separate normal-integrity Overwatch attempt (PID 4012, creation time
134388197973881950) failed in the injector before consumer authentication.
Its retained stdout ends at the injection prefix, stderr is empty, and no
structured result/startup file was retained. The exact game nevertheless loaded
ReShade, later registered its add-on and returned successful proxy Present
downstream to the Steam renderer. Those facts neither authenticate the consumer
nor identify why the injector exited. No crash/security cause is established;
generation 36's validated-initializer precondition is not proven in that failed
lifetime, so this candidate does not claim to fix it. Any repeat must retain
the injector's numeric exit status/signal alongside exact process identity and
the existing logs, without reopening possibly consumed ownership.
See [the Steam investigation controls](steam-overlay-investigation-controls.md).

The delayed-hook fixture, its documentation and the experimental test header
were added after candidate 1012 was sealed. This Git checkpoint therefore
contains additional diagnostic source and does not replace that candidate's
source snapshot or validation report.
