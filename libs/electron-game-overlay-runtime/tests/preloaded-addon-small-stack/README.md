# Actual add-on small-stack DLL notification regression

This Windows console fixture loads an exact, already staged production EGO
add-on under an inert API-18 host shim. It then creates threads requesting
16, 32 and 64 KiB stack reservations and requires each worker to enter and exit.
Windows delivers real `DLL_THREAD_ATTACH` and `DLL_THREAD_DETACH` notifications
to the loaded candidate. The fixture never calls `DllMain` directly.

The shim supplies metadata/event-registration exports and an inert nonnull ImGui
table pointer. It dispatches no events and never invokes that table. No ReShade
runtime, graphics device, desktop interaction, game, input hook, producer or
private transport is started. The supplied candidate must retain a valid
architecture-specific `ego-preload-...addon64` or `.addon32` filename; native
initialization validates its exact format and build ID.

Use the dedicated
[small-stack test launcher](../../scripts/test-cases/preloaded-addon-small-stack.ps1):

```powershell
& ./libs/electron-game-overlay-runtime/scripts/test-cases/preloaded-addon-small-stack.ps1 `
  -Architecture x64 `
  -AddonPath C:/absolute/owned-stage/ego-preload-APP32-BUILD32-HASH16.addon64
```

The filename above is a placeholder. The controller must supply an exact valid
candidate path from its owned stage. The launcher builds only this console
fixture under `build/ss`, then records candidate, source and executable hashes,
output and the exact exit status in a fresh `build/ss/r-.../evidence.json`.
Use `-Architecture Win32` and the matching `.addon32` for x86. Building does not
execute the candidate, and no automatic CTest entry loads it.

`-SkipBuild -FixturePath <retained-fixture.exe>` reuses an exact existing
workspace fixture, allowing an old negative control and fixed candidate to run
under identical shim bytes. Add `-ExpectStackOverflow -SuppressCrashDialog` for
the old negative control. The latter briefly changes only the launcher's own
process error mode while creating its child and immediately restores it; it
does not change registry or system settings. The launcher never changes the
supplied candidate, the SDK distribution or canonical native build outputs.
The negative-control launcher checks the exact expected exit status; a retained
debugger stack is needed separately to establish the failure phase and cause.

The fixture reads the supplied DLL without copying files or writing runtime or
configuration files. It emits one JSON pass record after all threads complete.
Small stack requests may be rounded by Windows; the record includes each
allocation base and a worker stack address. This is a real DLL notification
regression against the built candidate, not a pure parser or source-pattern test.

Generation 17 reserved approximately 64 KiB in the `DllMain` prologue even for
thread notifications because its process-attach branch contained a large local
path array. That candidate is expected to exit with `STATUS_STACK_OVERFLOW`
(`0xC00000FD`) before the first worker entry. The fixed candidate must complete
all three workers while remaining a dormant participant with only the baseline
event adapter registered. This fixture establishes no rendering/input or
physical-keyboard result. No pass is claimed merely by adding these sources.
