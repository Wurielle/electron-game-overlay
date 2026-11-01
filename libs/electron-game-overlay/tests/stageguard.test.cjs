// Portable source/configuration guards, plus one Windows-only execution of the
// extracted manifest guard. The full native/game gate is never executed here.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const stage = fs.readFileSync(path.join(root, 'libs/electron-game-overlay/scripts/stage-game-overlay-runtime.ps1'), 'utf8');
const producer = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/scripts/build.ps1'), 'utf8');
function patches(source) {
  return [...source.matchAll(/(\w+PatchSha256)\s*=\s*Join-Path \$\w+ "patches\\([^"]+)"/g)].map(([, key, file]) => [key, file]);
}
function requirements(variable) {
  const block = stage.slice(stage.indexOf(`$${variable}.schemaVersion -ne`), stage.indexOf('throw ', stage.indexOf(`$${variable}.schemaVersion -ne`)));
  return [...block.matchAll(new RegExp(`\\$${variable}\\.(\\w+) -ne (\\d+)`, 'g'))].map(([, key, value]) => [key, Number(value)]);
}
function numericAccepts(variable, stamp) {
  return requirements(variable).every(([key, value]) => stamp[key] === value);
}
test('portable source contract: staging mirrors bound cooperative native and package producers', () => {
  assert.match(producer, /\$BuildStamp.schemaVersion -ne 29/);
  assert.match(stage, /\$BuildStamp.schemaVersion -ne 29 -or\s*\$BuildStamp.cooperativeAddonProtocol -ne 1 -or\s*\$BuildStamp.injectorProcessInstanceBinding -ne 1 -or/);
  assert.match(stage, /\$PackageBuildStamp.schemaVersion -ne 4 -or\s*\$PackageBuildStamp.cooperativeAddonProtocol -ne 1 -or\s*\$PackageBuildStamp.injectorProcessInstanceBinding -ne 1 -or/);
  const properties = stage.match(/\$ExpectedPackageBuildStampProperties = @\(([\s\S]*?)\) \| Sort-Object/)[1];
  const produced = producer.match(/\$PackageBuildStamp = \[ordered\]@\{([\s\S]*?)\n\}/)[1];
  assert.deepEqual([...properties.matchAll(/"(\w+)"/g)].map(m => m[1]).sort(), [...produced.matchAll(/^    (\w+) =/gm)].map(m => m[1]).sort());
  assert.deepEqual(patches(stage), patches(producer));
  assert.equal(patches(stage).length, 28);
  for (const [, file] of patches(stage)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/patches', file))).digest('hex').length, 64);
});
test('portable extracted numeric guards reject old stamps and absent/incorrect capabilities', () => {
  for (const [variable, schemaVersion] of [['BuildStamp', 29], ['PackageBuildStamp', 4]]) {
    const valid = Object.fromEntries(requirements(variable));
    assert.equal(valid.schemaVersion, schemaVersion);
    assert.equal(valid.injectorProcessInstanceBinding, 1);
    assert.equal(valid.cooperativeAddonProtocol, 1);
    for (const capability of [undefined, 0, 2, '1']) {
      assert.equal(numericAccepts(variable, { ...valid, cooperativeAddonProtocol: capability }), false);
    }
    assert.equal(valid.injectorFutureTargets, 2);
    for(const cap of [undefined,0,1,3,'2'])assert.equal(numericAccepts(variable,{...valid,injectorFutureTargets:cap}),false);
    assert.equal(numericAccepts(variable, valid), true);
    assert.equal(numericAccepts(variable, { ...valid, schemaVersion: schemaVersion - 1 }), false);
    for (const cap of [undefined, 0, 2, '1']) assert.equal(numericAccepts(variable, { ...valid, injectorProcessInstanceBinding: cap }), false);
  }
});
test('portable structural guards retain all patch checks, architecture matching, SHA/list/reparse and copy checks', () => {
  const entries = patches(stage);
  const stamp = Object.fromEntries(entries.map(([key, file]) => [key, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/patches', file))).digest('hex')]));
  const complete = candidate => entries.every(([key]) => typeof candidate[key] === 'string' && candidate[key] === stamp[key]);
  assert.equal(complete(stamp), true);
  const missing = { ...stamp }; delete missing.injectorProcessInstanceBindingPatchSha256;
  assert.equal(complete(missing), false);
  assert.match(stage, /foreach \(\$PatchEntry in \$ExpectedPatchProvenance.GetEnumerator\(\)\)/);
  assert.match(stage, /-Actual \(\[string\]\$BuildStamp\.\(\$PatchEntry.Key\)\)/);
  for (const [arch, platform, runtime] of [['x86', 'win32-ia32', '32-bit'], ['x64', 'win32-x64', '64-bit']]) {
    assert.ok(stage.includes(`PackagePlatform = "${platform}"`), arch);
    assert.ok(stage.includes(`RuntimePlatform = "${runtime}"`), arch);
    for (const [variable, field, expected, other] of [
      ['BuildStamp', 'RuntimePlatform', runtime, arch === 'x86' ? '64-bit' : '32-bit'],
      ['PackageBuildStamp', 'PackagePlatform', platform, arch === 'x86' ? 'win32-x64' : 'win32-ia32'],
    ]) {
      const guard = `$${variable}.platform -ne $ArchitectureConfig.${field}`;
      assert.ok(stage.includes(guard));
      // Evaluate the extracted inequality only; this is not PowerShell execution.
      const accepts = candidate => stage.includes(guard) && candidate.platform === expected;
      assert.equal(accepts({ platform: expected }), true);
      assert.equal(accepts({ platform: other }), false);
    }
  }
  assert.match(stage, /\$BuildStamp.platform -ne \$ArchitectureConfig.RuntimePlatform/);
  assert.match(stage, /\$PackageBuildStamp.platform -ne \$ArchitectureConfig.PackagePlatform/);
  for (const name of ['runtimeSha256', 'injectorSha256', 'addonSha256', 'managerSha256', 'managerSourceSha256', 'reshadeRuntimeSha256', 'reshadeConfigSha256', 'reshadeBuildStampSha256']) assert.ok(stage.includes(name));
  for (const name of ['Assert-NotReparsePoint $Source', 'Assert-NotReparsePoint $Destination', 'Compare-Object $ExpectedArtifactNames $ActualSourceNames', 'Compare-Object $ExpectedDestinationNames $ActualDestinationNames', '-Expected $SourceHashes[$ArtifactName]', '-LiteralPath $Destination).Hash']) assert.ok(stage.includes(name), name);
});
test('official coexistence fixture requires the current bound package on both source and client sides', () => {
  const source = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-gun-frog-official-reshade-coexistence-gate.ps1'), 'utf8');
  for (const variable of ['PackageBuildStamp', 'ClientBuildStamp']) {
    assert.ok(source.includes(`$${variable}.schemaVersion -ne 4 -or`), variable);
    assert.ok(source.includes(`$${variable}.injectorProcessInstanceBinding -ne 1 -or`), variable);
  }
});

test('official coexistence executes its source-current contract guard without starting the game', {
  skip: process.platform !== 'win32' ? 'PowerShell execution requires Windows' : false,
}, () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-coexistence-contract-'));
  const fixturePath = path.join(directory, 'build.ps1');
  const runnerPath = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-gun-frog-official-reshade-coexistence-gate.ps1');
  const addonId = '0123456789ABCDEF0123456789ABCDEF';
  const currentGeneration = Number(producer.match(/^\$RuntimeGeneration = ([1-9][0-9]*)\r?$/mu)[1]);
  const source = (generation) => `$RuntimeGeneration = ${generation}\n$TargetTransportMin = 1\n$TargetTransportMax = 1\n$ExpectedAddonBuildId = "${addonId}"\n`;
  const stamp = (generation) => ({ runtimeGeneration: generation, targetTransportMin: 1, targetTransportMax: 1, addonBuildId: addonId });
  const cases = [
    { name: 'current source generation', source: source(currentGeneration), package: stamp(currentGeneration), client: stamp(currentGeneration), pass: true },
    { name: 'next source generation without fixture rewrite', source: source(currentGeneration + 1), package: stamp(currentGeneration + 1), client: stamp(currentGeneration + 1), pass: true },
    { name: 'equally stale source and client distributions', source: source(currentGeneration + 1), package: stamp(currentGeneration), client: stamp(currentGeneration), pass: false },
    { name: 'stale client generation', source: source(currentGeneration), package: stamp(currentGeneration), client: stamp(currentGeneration - 1), pass: false },
    { name: 'stale exact add-on ID', source: source(currentGeneration), package: { ...stamp(currentGeneration), addonBuildId: 'F'.repeat(32) }, client: stamp(currentGeneration), pass: false },
    { name: 'wrong client transport range', source: source(currentGeneration), package: stamp(currentGeneration), client: { ...stamp(currentGeneration), targetTransportMax: 2 }, pass: false },
    { name: 'missing source generation', source: source(currentGeneration).replace(/^\$RuntimeGeneration[^\n]*\n/u, ''), package: stamp(currentGeneration), client: stamp(currentGeneration), pass: false },
    { name: 'ambiguous source generation', source: source(currentGeneration) + '$RuntimeGeneration = 999\n', package: stamp(currentGeneration), client: stamp(currentGeneration), pass: false },
    { name: 'nonliteral duplicate source assignment', source: source(currentGeneration) + '$RuntimeGeneration = 999 + 1\n', package: stamp(currentGeneration), client: stamp(currentGeneration), pass: false },
    { name: 'zero source generation', source: source(0), package: stamp(0), client: stamp(0), pass: false },
    { name: 'overflow source generation', source: source('4294967296'), package: stamp(4294967296), client: stamp(4294967296), pass: false },
    { name: 'reversed source transport range', source: source(currentGeneration).replace('$TargetTransportMin = 1', '$TargetTransportMin = 2'), package: stamp(currentGeneration), client: stamp(currentGeneration), pass: false },
    { name: 'malformed source add-on ID', source: source(currentGeneration).replace(addonId, 'invalid'), package: stamp(currentGeneration), client: stamp(currentGeneration), pass: false },
  ];
  const payloadPath = path.join(directory, 'cases.json');
  fs.writeFileSync(payloadPath, JSON.stringify({ runnerPath, fixturePath, cases }));
  const script = `
$ErrorActionPreference = 'Stop'
$InputData = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Tokens = $null; $ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($InputData.runnerPath, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors) { throw $ParseErrors }
$Guard = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Assert-CurrentRuntimeSourceContract' }, $true)
if (-not $Guard) { throw 'Source-current contract guard is missing.' }
. ([scriptblock]::Create($Guard.Extent.Text))
foreach ($Case in $InputData.cases) {
    [IO.File]::WriteAllText($InputData.fixturePath, $Case.source)
    $Accepted = $true
    try { Assert-CurrentRuntimeSourceContract -BuildScriptPath $InputData.fixturePath -PackageBuildStamp $Case.package -ClientBuildStamp $Case.client }
    catch { $Accepted = $false }
    if ($Accepted -ne $Case.pass) { throw ('Unexpected source-contract result: ' + $Case.name) }
}
Write-Output ('Validated ' + $InputData.cases.Count + ' source-current contract cases without launching a game.')
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validated 13 source-current contract cases without launching a game\./u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
