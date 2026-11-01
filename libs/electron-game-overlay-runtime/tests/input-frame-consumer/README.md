# Input frame consumer console fixture

This standalone C++17 fixture tests the exact supplied
`reshade::input_frame_consumer` header. It has no Windows, ReShade runtime,
graphics, EGO add-on, or production-build dependencies. It does not establish
desktop input suppression, same-HWND rendering, real-game acceptance, or a
physical-key result.

Configure an isolated build against the frozen header under review:

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/input-frame-consumer `
  -B build/input-frame-consumer/x64 -A x64 `
  -DINPUT_CONSUMER_HEADER=C:/absolute/path/to/input_frame_consumer.hpp
cmake --build build/input-frame-consumer/x64 --config Release
ctest --test-dir build/input-frame-consumer/x64 -C Release --output-on-failure
```

Use a separate `Win32` build directory and `-A Win32` for the x86 console gate.
Other C++17 toolchains can configure without a Visual Studio architecture flag.
The test prints one JSON success record; failures identify the deterministic
case or random seed/step and return a nonzero status.

The seven deterministic cases cover empty/null acquisition, final destruction
and reinitialization, A reset/reinit while B remains active, paused-A handoff,
stale-A removal preserving B's newer block decision, current removal clearing
old suppression before a peer presents, retained shared input references, and
an externally serialized two-thread handoff. The shared-reference case keeps
more than twelve references alive after the final active runtime unregisters;
those references must not count as active consumers.

Eight fixed seeds each execute 5,000 bounded operations against an independent
active-token set and current-identity model. Random-order drains check explicit
registration counts and final removal, including intervals where no consumer
is currently presenting. Every step verifies all token identities and null
behavior. The randomized model never reads private helper fields.

The caller contract is preserved: mutators run under an external input mutex,
each registration has one matching unregister, and an acquire/unregister token
belongs to an active runtime. Tokens are opaque addresses of real fixture
objects and are never dereferenced by the helper. Duplicate unregister and
acquiring an unregistered nonnull token are outside this helper's contract;
the fixture does not invent identity-set validation that its API does not
provide. The two-thread schedule is bounded and checks serialized handoff; it
does not claim lock-free multiwriter support.

On 2026-11-01, the frozen helper passed this console fixture in Release on both
x64 and Win32 with MSVC 19.44: seven deterministic cases, 40,000 randomized steps,
and 835,573 assertions per architecture. The exact helper/source/binary hashes
and results are recorded in [evidence-2026-11-01.json](evidence-2026-11-01.json).
This result covers the pure helper only; host integration, native key polling,
desktop rendering/input, and real-game acceptance remain separate gates.
