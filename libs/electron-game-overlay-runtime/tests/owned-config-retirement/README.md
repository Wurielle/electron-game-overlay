# Owned config retirement console fixture

This fixture loads no ReShade DLL and creates no graphics/window/input objects.
It compiles the exact supplied `owned_config_file.hpp`, and includes the pinned
stock `ini_file.cpp` in its translation unit. Cache counts therefore measure the
actual stock cache, and the guarded writes use its real CRT `SH_DENYWR` save path.
The separate read-only lifetime handle includes `FILE_READ_DATA`: metadata-only
access does not enforce the no-delete sharing required to block replacement.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/owned-config-retirement `
  -B build/owned-config-retirement/x64 -A x64 `
  -DOWNED_CONFIG_HEADER=C:/absolute/path/to/owned_config_file.hpp `
  -DRESHADE_SOURCE_DIR=C:/absolute/path/to/pinned/reshade-src
cmake --build build/owned-config-retirement/x64 --config Release
# Parent directory must already exist; the named final directory must not exist.
& build/owned-config-retirement/x64/Release/owned_config_retirement.exe `
  --directory C:/absolute/owned/build-stage/run-unique
```

The only writes are inside that fresh owned directory. Never supply a game
directory. There is no recursive cleanup and an existing report is not replaced.

The JSON report covers 128 create/load/modify/flush/exact-cache-clear/delete
cycles, normal cache and handle return to baseline, real CRT save compatibility,
live guard rename rejection, same-content and different-content replacement
protection, seed-write/encoding failure cleanup, and preserved quarantine.
An actual CRT writer denies deletion, then releases after a requested 10 ms;
retirement retries only sharing/lock open failures before any mutation, clears
the exact cache once, and deletes the generated file. The nominal retry deadline
is 20 ms; Windows scheduling and tick granularity can increase elapsed wall time,
which the report records without treating this as a hard realtime guarantee.
Template and unrelated files use SHA-256 before/after comparisons and retain
their actual cache entries. Replacement cases keep the renamed original object
pinned during the test, so they do not rely on rapid file-ID reuse assumptions.

The intentional quarantine is retained through report creation and process exit;
its extra file, cache entry and handle are reported separately from normal
retirement balance. Fixture teardown removes only its own replacement samples
after preservation assertions. This is filesystem/cache evidence, not actual
runtime destruction, graphics, injection, or real-game acceptance.

`evidence.windows-console-20261101.json` records passing x64 and Win32 runs of
the exact hashed helper, fixture, and stock INI source. Each architecture retired
128 configs with unchanged normal cache/handle counts and unchanged template
and unrelated-file SHA-256 hashes.
