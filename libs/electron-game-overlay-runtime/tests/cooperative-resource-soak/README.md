# Cooperative resource soak

This isolated Windows console fixture includes the production registry header.
It never loads a native engine or ReShade, injects a process, opens a game, or
claims SDK/rendering/input acceptance. Each case starts in its own process.

Run its launcher after the fixture build is authorized:

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/cooperative-resource-soak.ps1 -Architecture all
```

The cases enforce exact bounds:

- One stable participant survives 8,209 registration/paint/focus/capture/clear
  cycles. Its callback/context identity and one lifetime slot stay unchanged;
  each clear leaves zero windows, ranks, focus, capture and interception.
- One survivor retains its scene/input while 511 other participants join and
  leave. All 512 immutable lifetime slots are then consumed. Another 1,025
  admissions fail without changing the survivor or publishing callbacks.
- A broadcast already inside a callback survives concurrent departure. The
  retired callback/context slot stays immutable while a new participant takes
  a distinct slot. Later broadcasts do not call the departed participant.
- 1,024 cancelled unpublished reservations release their slots. An existing
  engine's baseline join skips a pending reservation. Publication exposes a
  callback only after the caller commits; simulated irreversible pin failures
  retain invisible bounded tombstones instead of reopening capacity.

The two sequential cases require identical tracked C++ outstanding allocations,
process handles, threads and module counts at warmed quiescent checkpoints.
Tracked C++ allocations cover ordinary new/delete used by the registry; they
do not claim to intercept all CRT/OS allocations. Mapping sizes and slot counts
are exact. Private bytes are recorded only as a diagnostic, not a tolerance or
flat-RSS assertion. Evidence and source/binary hashes stay under the ignored
`build/cooperative-resource-soak` directory.

All four cases passed on x64 and x86 on 2026-11-01. The portable
[evidence record](evidence-2026-11-01.json) binds their exact bounds and resource
checkpoints to the fixture/header/binary hashes. This is controlled unit
evidence, separate from running the production engine or genuine SDK controller.

Pure evidence-validation tests require no compiler or desktop:

```powershell
node --test libs/electron-game-overlay-runtime/tests/cooperative-resource-soak/evidence.test.cjs
```

This fixture proves the registry's current **lifetime** admission bound, not
512 concurrent application capacity or 500-version acceptance. In production,
fresh staged modules remain pinned until game exit and consume new lifetime
slots. A producer reconnect to the same engine is different from a newly
staged session or app restart. Production module/worker retention and bounded
rejected native loads require separate native-process and genuine SDK evidence.

The separate [executing SDK/native evidence](sdk-evidence-2026-11-01.json)
records eight x64 D3D11 fresh-stage cycles after fixing native epoch-rank cleanup
and SDK session namespace reuse. That run reached nine retained engines/slots
and does not extend this controlled exhaustion result to production capacity.
