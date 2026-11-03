# Isolated owned-host readiness enumeration probe

This Windows x64/x86 console probe extracts the exact candidate `ready_word` and
`cooperative_adapter_ready` bodies from `owned_late_d3d11.inl` during CMake
configuration. The evidence records the raw and normalized source hashes.
It loads only its inert data-export DLL in fresh owned console children, with
an explicit `longPathAware=false` manifest, at path lengths 233, 259, 260, 289,
293 and 320. The module is loaded by extended path in every case.
The leaf is `.addon64` for x64 or `.addon32` for x86; reports identify the
architecture and pointer width.

Nine fresh children per length exercise adapter-ready values zero, one and two;
adapter-one/cooperative-zero; legacy modules with no adapter export and
cooperative values zero, one and two; invalid ABI; and missing ABI. The report
compares the exact selector with direct exported-word reads, Toolhelp
enumeration, K32 module handle enumeration, and address-based loader reference
acquisition. Candidate builds add seven deterministic API controls: enumeration
failure, one successful capacity growth, persistent growth to the eight-attempt
limit, an oversized result, a nonintegral handle-byte count, zero modules, and
failed module-reference acquisition. Only the extracted selector sees those
API seams; the telemetry still calls the actual Windows APIs.

All files and children belong to the fixture. No production injector, ReShade,
game, graphics target or Electron application runs, and there is no remote
memory mutation or security setting change.

```powershell
cmake -S libs/electron-game-overlay-runtime/tests/preload-activation-long-path `
  -B build/preload-activation-long-path -G "Visual Studio 17 2022" -A x64 `
  -DOWNED_LATE_SOURCE="$PWD/build/electron-game-overlay-runtime/_deps/reshade-src/source/ego_owned_late_d3d11/owned_late_d3d11.inl"
cmake --build build/preload-activation-long-path --config Release
$root = Join-Path $PWD ('build/ap-probe-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
& build/preload-activation-long-path/Release/preload_activation_fixture.exe `
  --root $root --member "$PWD/build/preload-activation-long-path/Release/preload_activation_member.dll"
node libs/electron-game-overlay-runtime/tests/preload-activation-long-path/verify.cjs `
  --mode candidate --architecture x64 --report "$root/report.json" `
  --source "$PWD/build/electron-game-overlay-runtime/_deps/reshade-src/source/ego_owned_late_d3d11/owned_late_d3d11.inl"
```

For x86, use a separate build directory and `-A Win32`, then pass
`--architecture x86` to the verifier. The fixture automatically selects the
32-bit filename. Keep reports for the two architectures separate.

The command assumes the candidate source is staged. For baseline comparison,
configure a separate build directory with an independently retained pre-patch
source file and run the verifier with `--mode baseline` and that exact source.
The verifier rejects missing/duplicate cases, unexpected words/API counts,
source-hash mismatches, incorrect path spelling, absent module references and
incorrect expected outcomes. A successful verifier writes `verification.json`
beside its input report. Keep expected baseline failures distinct from passing
candidate readiness assertions.

Observed on 2026-11-03: the frozen x64 baseline completed all 54 expected controls.
At 233 characters the exact selector accepted readiness one and rejected zero
or two. At 259/260/289/293/320, `Module32FirstW` failed with
`ERROR_MORE_DATA` (234) even though K32 enumeration and address references found
the valid module and direct exported-word reads succeeded. The candidate
completed all 61 controls on each of x64 and x86, including bounded enumeration
and failure paths. All were verified automatically, with zero explicit remote
mutation calls. The original x64 baseline reports remain unchanged.

Retained reports:

- Baseline: `build/ap-baseline-3a664f8d/report.json`, SHA-256
  `89923D5EA115B7E87A0C305932C168CFD9FD89BBB23CF3349B5288C0CFABC9EB`.
- Candidate: `build/ap-candidate-0eb0f256/report.json`, SHA-256
  `EB35A1279DBC546825F6CD91DAE4D61DA039C97D2D4DF585EF56F21D0ABBE8CB`.
- Candidate x64 with explicit architecture reporting:
  `build/ap-candidate-x64-99878a02/report.json`, SHA-256
  `EC5A719D9565995AA07F81459F7470101C8D12C734036F877D78B8C31A250AD8`.
- Candidate x86:
  `build/ap-candidate-x86-a4db8e95/report.json`, SHA-256
  `F206531AE4BE9EB54B50B24C513B5C76C5BFD56B840857084587527B2901CC9A`.
- Baseline normalized source SHA-256:
  `AEA939BCC391BC5C2F63683558B78A88222BD5E9C4B81EFB5069CAA346F724BE`.
- Candidate normalized source SHA-256:
  `36753053450815B934A6117B1C072A2100AA86032DF30D937F9A127CA0F7A5F0`.

The older exploratory reports `ap-probe-9019dca5` and `ap-probe-209727c0` are
retained separately. The former exposed a fixture ABI-export declaration defect
and is not acceptance evidence; the latter corrected that control before the
expanded, automatically verified matrix above.

Retain every child result, including negative controls. Readiness enumeration
coverage does not establish graphics activation or consumer acceptance.
