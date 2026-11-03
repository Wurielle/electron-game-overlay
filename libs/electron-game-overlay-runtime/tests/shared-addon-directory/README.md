# Shared add-on directory native isolation controls

The existing `preloaded-injector-policy` console fixture includes the complete
candidate injector source with its production entrypoint renamed and unused.
Its selector controls now use a stable directory outside the private runtime
stage, alongside unrelated ordinary add-ons. It checks the ordinary and extended
path spellings, exact selected hash, owned runtime/base/markers, file pinning,
concurrent independent publication, directory replacement protection, missing
payloads, a target-game directory, malformed paths, leaf reparse points and
shared-directory ancestor junctions. It opens no other process and executes no
injector entrypoint, production native payload, game or graphics device.

The fixture in this directory extracts the **complete actual owned-host
initializer** from the exact source specified at configure time. Its scanner,
readiness and graphics dependencies are inert seams. Controls establish that a
foreign scanner failure preserves a ready EGO host, while missing callback
readiness, invalid ownership/request/gate state and EGO's own hook failures
retain their outcomes. It also checks consumed-reference retention and repeated
initialization. Its Windows module reference pins only its own console executable.
This fixture does not perform an actual add-on scan or prove graphics acceptance.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/shared-addon-directory `
  -B build/shared-addon-host-isolation-x64 -G "Visual Studio 17 2022" -A x64 `
  -DOWNED_LATE_SOURCE="$PWD/build/electron-game-overlay-runtime/_deps/reshade-src/source/ego_owned_late_d3d11/owned_late_d3d11.inl"
cmake --build build/shared-addon-host-isolation-x64 --config Release
ctest --test-dir build/shared-addon-host-isolation-x64 -C Release --output-on-failure
```

Use a separate build directory and `-A Win32` for x86. The executable emits its
raw/normalized candidate source hashes, case/assertion counts and pointer width.
Retain console results separately from production DX-demo acceptance.

Recorded on 2026-11-03: the candidate passed the exact injector policy fixture
on x64 and x86 (nine grouped cases and 744 assertions per architecture), the
exact extracted host initializer on both architectures (18 cases and 54
assertions each), and all 290 x64 long-path policy conditions (1,843 assertions,
zero skips). The frozen generation-22 x64 controls reproduced both the stable
shared-directory rejection and the foreign add-on failure blocking EGO. Those
two expected baseline failures are retained separately from candidate passes in
[the console evidence](evidence.windows-console-20261103.json), with source and
executable hashes. No production payload or graphics target ran in these probes.
