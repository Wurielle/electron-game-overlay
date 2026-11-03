# Local preload path console fixture

This Windows/MSVC x64 fixture compares an identical inert DLL at absolute path
lengths 233, 259, 260, 289 and 320, using ordinary and extended (`\\?\`) path
forms. It exercises `LoadLibraryW`, the stock scanner's `LoadLibraryExW` flags,
`std::filesystem::directory_iterator` with ordinary/extended add-on directories,
and a local call to the exact candidate's `participant_loading_thread`.
Each condition runs in a fresh owned console child so an earlier loaded module
cannot satisfy a later condition through the loader's module cache.

The fixture executable explicitly embeds `longPathAware=false`. It does not
change the machine's long-path policy, Defender settings or any other system
setting. A long-path comparison establishes loader/path behavior in this
controlled process, not the root cause of a historical consumer failure.

`member.cpp` is a data-only test PE with the expected public metadata exports
and a no-I/O initializer validating the size/versioned request. Its `DllMain`
returns success. It does not load ReShade, register production callbacks, create
an overlay route or start workers. The production injector entrypoint is renamed
and never called. No `VirtualAllocEx`, `WriteProcessMemory`, `CreateRemoteThread`
or other explicit remote-process mutation/injection operation is permitted.
The only target activity is local DLL loading inside the owned fixture children;
no game, Electron application or graphics test is launched.

Configure and build from the SDK repository:

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preload-long-path `
  -B build/preload-long-path -G "Visual Studio 17 2022" -A x64 `
  -DINJECTOR_SOURCE="$PWD/build/electron-game-overlay-runtime/_deps/reshade-src/tools/injector.cpp"
cmake --build build/preload-long-path --config Release
$probe = Join-Path $PWD ('build/lp-probe-' + [Guid]::NewGuid().ToString('N'))
& build/preload-long-path/Release/preload_long_path_fixture.exe `
  --root $probe `
  --member "$PWD/build/preload-long-path/Release/preload_long_path_member.dll" `
  --report (Join-Path $probe report.json)
```

The parent driver refuses an existing root and creates fresh processes for
`plain-w`, `extended-w`, `plain-ex`, `extended-ex`, `plain-scan`, `extended-scan`,
`thunk-plain`, `thunk-extended`, and `thunk-prefix-load-only`. The last mode deliberately uses
a prefixed load form with an unprefixed expected path, exercising the subsequent
module-path comparison rather than treating a successful DLL load as complete
activation proof.

Use a new output directory under this SDK repository's `build` directory. The
driver's retained child handles and scoped files are the only processes/files
it may clean up. Keep failed conditions alongside passing controls and do not
relabel a console loader pass as SDK graphics or game acceptance. These inert
metadata exports do not establish full SDK package/hash validation.

Observed on Windows x64 on 2026-11-02, with the explicitly disabled long-path
manifest and 35 fresh children:

| Canonical path length | Ordinary W / ExW / native thunk | Extended W / ExW / native thunk |
| --- | --- | --- |
| 233 | Success | Success |
| 259, 260, 289, 320 | `ERROR_FILENAME_EXCED_RANGE` (206), no module | Success |

Both `GetModuleFileNameW` and `K32GetModuleFileNameExW` preserved the extended
prefix when the load path contained it. The `thunk-prefix-load-only` control
mapped the DLL but returned `ERROR_INVALID_NAME` (123) at every tested length:
the native exact-path guard rejected the prefixed observed path against its
ordinary expected path. No forbidden remote mutation call occurred.

The local evidence report is `build/lp-probe-8dfee723/report.json`; it retains all
conditions, immediate Windows errors and both module path representations.
The included injector source SHA-256 was
`A8ECF5046DD3BEDB748B77202504B234E39444FD96A9EAFC35A5877FEBC683E6` and the inert
DLL SHA-256 was
`6CEB5A3369A36806E7F8844BB4C1BA84922F44F2CC5347200BAA89E43342077B`.
These observations isolate an SDK loader failure mechanism. They do not prove
that the historical consumer failure has no other cause, nor establish overlay
acceptance in any application.

The follow-up candidate report `build/lp-probe-2c30daad/report.json` records 45
fresh children against the prototype long-path patch, including ten filesystem
scanner controls. Both directory forms found the one owned inert leaf at each
length. The extended form preserved its prefix through `directory_iterator`
and loaded all five leaves with stock flags; the ordinary form failed with 206
at 259/260/289/320. The thunk and module-path observations above were unchanged.
No forbidden remote mutation call occurred. The candidate's normalized injector
source SHA-256 was
`91D82243D81D2CDC082DA1AF9BFF55A13315BF59F1FE5F9ACA1DFAE8442C8A10`.

## Owned snapshot policy regression

`preload_long_path_policy_fixture` directly calls the exact included candidate's
`validate_first_host_preload_snapshot`, with the production entrypoint renamed
and explicit traps for all current remote allocation, write, thread and handle
transfer calls. It loads no DLL or runtime and starts no external process.

It creates a fresh direct child of the SDK repository's canonical `build`
directory and retains only its owned evidence tree. For candidate file lengths
233, 259, 260, 289 and 320, it admits ordinary and exact extended `AddonPath`
spellings of the canonical owned `stage\preloaded-addons` directory. Generation
23 additionally admits an independent canonical shared directory containing the
same exact selected payload. It rejects relative, dot, dot-dot, trailing-separator, slash and
malformed-prefix aliases. Both admitted forms repeat the marker, missing-file,
full SHA-256, altered-payload and denied-write/delete guard controls. Leaf,
stage-ancestor and snapshot-directory symlink rejection runs only if standard
user symlink creation is available; otherwise the report records the Win32
reason as a skip. No privilege, policy or security setting is changed.

Use a separate build directory when comparing a patched candidate with the
original loader fixture. For example, from the SDK repository:

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preload-long-path `
  -B build/preload-long-path-policy -G "Visual Studio 17 2022" -A x64 `
  -DINJECTOR_SOURCE="$PWD/build/lp-native-prototype/tools/injector.cpp"
cmake --build build/preload-long-path-policy --config Release `
  --target preload_long_path_policy_fixture
$policyRoot = Join-Path $PWD ('build/lp-policy-' + [Guid]::NewGuid().ToString('N'))
& build/preload-long-path-policy/Release/preload_long_path_policy_fixture.exe `
  --root $policyRoot --report (Join-Path $policyRoot report.json)
```

The root must not exist before invocation; `report.json` must be inside that
exact root. A passing JSON report lists every native selector result, assertion
count, optional skipped reparse cases and explicit remote-mutation call count.
This is a local snapshot policy regression, not overlay or graphics acceptance.

Observed on Windows x64 on 2026-11-02 against the isolated native prototype:
290 selector cases and 1,833 assertions passed (20 admissions, 270 rejections).
All 30 actual leaf, stage-ancestor and snapshot-directory reparse cases ran;
there were no skips and no explicit remote mutation calls. The retained evidence
is `build/lp-policy-3ca46b02fc6d4838b52a5a5c0605c8cd/report.json` (SHA-256
`A9479BD1546733020E0DB0681C08A5201BF5CA4FD31DA74099D428DBE31DAB5B`).
