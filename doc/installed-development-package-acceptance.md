# Independently packed and installed development SDKs

This lane verifies two separately packed npm archives and two independent npm
consumer installations before running the existing real Gun Frog matrix. These
are explicitly labeled development packages, not independently released SDK
versions. Each package retains its own native engine and private transport;
the game gate still requires one ReShade host and two exact engine identities.

The packer validates the source seals, copies every sealed payload unchanged,
and changes only packaging metadata in a new stage. The copied SDK seal's
`packageVersion` follows the development package version; its payload inventory,
sizes and SHA-256 values remain identical. Original metadata and seal bytes are
retained as `SOURCE_PACKAGE.json` and `SOURCE_OVERLAY_MANIFEST.json`.
`SDK_PROVENANCE.json` and `report.json` record the transformation, original and
installed seals, full file inventories, archive integrity, independent lockfiles,
resolved package exports, JavaScript hashes and both native build identities.

The packer uses real offline `npm pack` and `npm install`, ignores package
scripts, and bundles an exact copy of the already sealed `tslib` dependency.
Electron is supplied separately by the acceptance controller. The packer does
not execute SDK implementations or native payloads.

## Existing gen9/gen11 package artifacts

`build/installed-cooperative-pair-gen9-gen11-20261101-verified/report.json`
records two independent installations:

| Member | Development package version | Native generation |
| --- | --- | --- |
| A | `0.1.0-development.gen9.79b29cf` | 9 |
| B | `0.1.0-development.gen11.cdc6e80` | 11 |

The member-B installation preserves the gen11 SDK for the final-candidate lane,
even after the normal workspace distribution is rebuilt. The package fixture
tests establish packaging and tamper rejection; they do not establish game
acceptance.

## Final-candidate commands

Run these from the repository root after the coordinated final build. The output
directory must be new. Source revision labels are informational; recorded byte
hashes and native exports identify the actual implementations.

```powershell
$baselinePackage = Join-Path $PWD 'build/installed-cooperative-pair-gen9-gen11-20261101-verified/consumer-b/node_modules/electron-game-overlay'
$candidateStamp = Get-Content -LiteralPath 'libs/electron-game-overlay/dist/runtime/win32-x64/reshade/electron_game_overlay_runtime.build.json' -Raw | ConvertFrom-Json
$candidateRevision = (git rev-parse --short HEAD).Trim()
$pairOutput = Join-Path $PWD ('build/installed-cooperative-pair-final-' + [Guid]::NewGuid().ToString('N'))
node apps/client/scripts/package-installed-cooperative-pair.cjs --sdk-a $baselinePackage --sdk-b libs/electron-game-overlay --version-a 0.1.0-development.baseline.gen11.cdc6e80 --version-b "0.1.0-development.candidate.gen$($candidateStamp.runtimeGeneration).$candidateRevision" --output $pairOutput
if ($LASTEXITCODE -ne 0) { throw 'Offline installed pair preparation failed.' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File libs/electron-game-overlay-runtime/scripts/test-cases/gun-frog-installed-mixed-sdk-packages.ps1 -PairReport (Join-Path $pairOutput 'report.json') -StartupOrder both -FirstAppExit both
```

The game launcher validates the installed packages again before delegating to
the established controller. Each genuine Electron producer loads
`createRequire(consumer/package.json)('electron-game-overlay')`; no workspace SDK
fallback exists. The controller records each producer's installed entrypoint,
version and seal, then retains all module, composited-pixel, input, graceful/crash
survivor and fresh-game relaunch assertions. Its input is Windows SendInput and
does not claim human physical-key evidence.

Pure verification, without Electron, a game, input APIs or a native build:

```powershell
node --test apps/client/tests/package-installed-cooperative-pair.test.cjs apps/client/tests/installed-cooperative-sdk.test.cjs
node apps/client/scripts/installed-cooperative-sdk.cjs --pair-report build/installed-cooperative-pair-gen9-gen11-20261101-verified/report.json
```
