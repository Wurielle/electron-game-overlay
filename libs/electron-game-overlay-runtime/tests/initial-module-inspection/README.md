# Deterministic initial module inspection fixture

This Windows x64/x86 console fixture extracts the exact candidate injector's
initial inspection group, later ReShade preflight wrapper, one-pass preflight,
transient-error predicate and supporting types during CMake configuration.
Its report records the full source's raw/normalized SHA-256 and hashes for each
extracted block. No production injector entrypoint is compiled or called.

Local API seams provide scripted module enumeration, export/data/path reads,
claim lookup, process liveness and a deterministic clock. Every such call asserts
that the original bound handle is retained; claim lookup also asserts the PID.
These are state-machine tests, not real target inspection, process identity
binding or graphics acceptance. Actual Windows loader-startup behavior requires
a separate live console-process probe.

Remote allocation/write/thread/handle-publication calls, process reopening,
payload loading and unbound `Sleep` calls are compile errors in the extracted
functions. This executable launches no child, maps no DLL, touches no other
process and changes no registry/security setting. Its only writes are its fresh
owned evidence directory, a direct child of the SDK repository's `build` folder.

The cases cover both 250 ms transient budgets and the 256-attempt backstop,
recovery from 299 at enumeration/export/data/path stages, persistent failure,
zero/misaligned/truncated module lists, false API results with no Windows error,
exact process exit/wait failure, pinned ownership, existing/conflicting/invalid
hosts, cleared partial outputs and official add-on readiness polling/deadlines.
Observed pinned ownership remains sticky across later misses, and positive host
or cooperative evidence cannot turn into permission to initialize another host.
The tests also allow a temporarily missing known host to reappear safely.
The presence of a host and all refusal outcomes remain observable; no payload
operation is simulated as success.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/initial-module-inspection `
  -B build/initial-module-inspection-x64 -G "Visual Studio 17 2022" -A x64 `
  -DINJECTOR_SOURCE="$PWD/build/initial-inspection-prototype/tools/injector.cpp"
cmake --build build/initial-module-inspection-x64 --config Release
$evidence = Join-Path $PWD ('build/ii-x64-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
& build/initial-module-inspection-x64/Release/initial_module_inspection_fixture.exe `
  --root $evidence
```

Use `-A Win32` with a separate build directory for x86. A passing process exits
zero and writes `report.json` only after all internal assertions pass. Preserve
all failed fixture output; a deterministic retry pass does not establish a
consumer graphics or fast-start game result.

On 2026-11-03, both x64 and x86 passed 54 deterministic cases and 20,982 internal
assertions against normalized candidate source
`58ED5A9C5F0B0806D7D4AE65D060271AD8D62676A62332F0BE6FEAD88B6D8BFA`.
Retained passing reports:

- x64: `build/ii-verified-x64-7514c20b/report.json`, SHA-256
  `1C2DA6F282A45DBEBBA822FE7A55E118C755D9412D0AC498A42C761F377C2F53`.
- x86: `build/ii-verified-x86-d9f17e05/report.json`, SHA-256
  `303D27DF61A6E6E009227B79D67A97EC0B5E298C4F686C29EA8AA142AD2FF04F`.

Earlier `ii-initial-*` and `ii-final-*` reports are preliminary development
controls and are superseded by the positive-evidence preservation matrix above.
