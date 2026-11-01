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
const reshadeProducer = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/scripts/build-reshade-runtime.ps1'), 'utf8');
const ownedLatePatchSha256 = '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE';
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
  assert.match(producer, /\$BuildStamp.schemaVersion -ne 30/);
  assert.match(stage, /\$BuildStamp.schemaVersion -ne 30 -or\s*\$BuildStamp.cooperativeAddonProtocol -ne 1 -or\s*\$BuildStamp.injectorProcessInstanceBinding -ne 1 -or/);
  assert.match(stage, /\$PackageBuildStamp.schemaVersion -ne 4 -or\s*\$PackageBuildStamp.cooperativeAddonProtocol -ne 1 -or\s*\$PackageBuildStamp.injectorProcessInstanceBinding -ne 1 -or/);
  const properties = stage.match(/\$ExpectedPackageBuildStampProperties = @\(([\s\S]*?)\) \| Sort-Object/)[1];
  const produced = producer.match(/\$PackageBuildStamp = \[ordered\]@\{([\s\S]*?)\n\}/)[1];
  assert.deepEqual([...properties.matchAll(/"(\w+)"/g)].map(m => m[1]).sort(), [...produced.matchAll(/^    (\w+) =/gm)].map(m => m[1]).sort());
  assert.deepEqual(patches(stage), patches(producer));
  assert.equal(patches(stage).length, 29);
  assert.deepEqual(patches(stage).filter(([key]) => key === 'ownedLateD3d11PatchSha256'), [['ownedLateD3d11PatchSha256', 'reshade-owned-late-d3d11.patch']]);
  for (const [, file] of patches(stage)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/patches', file))).digest('hex').length, 64);
});
test('portable extracted numeric guards reject old stamps and absent/incorrect capabilities', () => {
  for (const [variable, schemaVersion] of [['BuildStamp', 30], ['PackageBuildStamp', 4]]) {
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

test('current source cache binds the complete nineteen-file stack and frozen terminal patch', () => {
  const expectedFiles = [...reshadeProducer.match(/\$ExpectedPatchedFiles = @\(([\s\S]*?)\r?\n\)/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]).sort();
  const contentPins = [...reshadeProducer.match(/\$ExpectedPatchedContentSha256 = \[ordered\]@\{([\s\S]*?)\r?\n\}/)[1].matchAll(/"([^"]+)" = "([0-9A-F]{64})"/g)].map(([, name, digest]) => [name, digest]);
  assert.equal(expectedFiles.length, 19);
  assert.deepEqual(contentPins.map(([name]) => name).sort(), expectedFiles);
  const patch = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/patches/reshade-owned-late-d3d11.patch'));
  assert.equal(crypto.createHash('sha256').update(patch).digest('hex').toUpperCase(), ownedLatePatchSha256);
  const changed = [...patch.toString('utf8').matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(match => match[2]);
  assert.equal(changed.length, 15);
  for (const name of changed) assert.ok(expectedFiles.includes(name), name);
  assert.match(reshadeProducer, /return \$Stamp.schemaVersion -eq 30 -and/);
  assert.match(reshadeProducer, /schemaVersion = 30/);
  assert.match(reshadeProducer, /\$Stamp.ownedLateD3d11PatchSha256 -eq \$OwnedLateD3d11PatchHash -and/);
  assert.match(reshadeProducer, /ownedLateD3d11PatchSha256 = \$OwnedLateD3d11PatchHash/);
  const reverseChecks = reshadeProducer.match(/foreach \(\$Patch in @\(([\s\S]*?)\r?\n    \)\)/)[1];
  assert.deepEqual(reverseChecks.match(/\$\w+Patch/g), ['$OwnedLateD3d11Patch']);
  for (const source of [reshadeProducer, producer, stage]) assert.ok(source.includes(ownedLatePatchSha256), 'Frozen production patch is pinned before packaging/cache acceptance');
});

for (const shell of ['powershell.exe', 'pwsh.exe']) test('actual extracted current schema/provenance guards reject a missing or substituted late patch under ' + shell, {
  skip: process.platform !== 'win32' ? 'PowerShell execution requires Windows' : false,
}, t => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (available.error?.code === 'ENOENT') { t.skip(shell + ' is unavailable'); return; }
  assert.equal(available.status, 0, available.stderr);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-owned-late-stamp-guard-'));
  const payload = {
    sources: [path.join(root, 'libs/electron-game-overlay-runtime/scripts/build.ps1'), path.join(root, 'libs/electron-game-overlay/scripts/stage-game-overlay-runtime.ps1')],
    patch: path.join(root, 'libs/electron-game-overlay-runtime/patches/reshade-owned-late-d3d11.patch'),
    cases: [
      { name: 'exact required production patch', schema: 30, present: true, value: ownedLatePatchSha256, pass: true },
      { name: 'hex case does not alter digest identity', schema: 30, present: true, value: ownedLatePatchSha256.toLowerCase(), pass: true },
      { name: 'missing required patch', schema: 30, present: false, pass: false },
      { name: 'null required patch', schema: 30, present: true, value: null, pass: false },
      { name: 'boolean required patch', schema: 30, present: true, value: false, pass: false },
      { name: 'numeric required patch', schema: 30, present: true, value: 1, pass: false },
      { name: 'malformed required patch', schema: 30, present: true, value: 'not-a-sha256', pass: false },
      { name: 'substituted syntactically valid digest', schema: 30, present: true, value: 'A'.repeat(64), pass: false },
      { name: 'legacy schema cannot supply current native artifacts', schema: 29, present: true, value: ownedLatePatchSha256, pass: false },
    ],
  };
  const payloadPath = path.join(directory, 'input.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  const script = `
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent can supply its module path to Windows PowerShell 5.1;
# load this shell's own hashing cmdlet rather than inheriting a Core module.
Import-Module -Force -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')
$InputData = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Validated = 0
foreach ($SourcePath in $InputData.sources) {
    $Tokens = $null; $ParseErrors = $null
    $Ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$Tokens, [ref]$ParseErrors)
    if ($ParseErrors) { throw $ParseErrors }
    $Hasher = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Assert-Sha256Equal' }, $true)
    $Guard = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.IfStatementAst] -and $Node.Extent.Text.StartsWith('if ($BuildStamp.schemaVersion -ne ') }, $true)
    $Provenance = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.ForEachStatementAst] -and $Node.Extent.Text.StartsWith('foreach ($PatchEntry in $ExpectedPatchProvenance.GetEnumerator())') }, $true)
    if (-not $Hasher -or -not $Guard -or -not $Provenance) { throw 'Current source manifest guards are missing.' }
    . ([scriptblock]::Create($Hasher.Extent.Text))
    $ExpectedReShadeCommit = '4a50d1eddace85734871d91792ff214f13f66c01'
    $ArchitectureConfig = [pscustomobject]@{ RuntimePlatform = '64-bit' }
    $BuildStampPath = 'controlled-no-runtime-fixture'
    $ExpectedPatchProvenance = [ordered]@{ ownedLateD3d11PatchSha256 = $InputData.patch }
    foreach ($Case in $InputData.cases) {
        $Fields = [ordered]@{ schemaVersion = $Case.schema; cooperativeAddonProtocol = 1; injectorProcessInstanceBinding = 1; injectorFutureTargets = 2; commit = $ExpectedReShadeCommit; configuration = 'Release'; platform = '64-bit'; addonLevel = 2 }
        if ($Case.present) { $Fields.ownedLateD3d11PatchSha256 = $Case.value }
        $BuildStamp = [pscustomobject]$Fields
        $Accepted = $true
        $FailureMessage = ''
        try { . ([scriptblock]::Create($Guard.Extent.Text)); . ([scriptblock]::Create($Provenance.Extent.Text)) }
        catch { $Accepted = $false; $FailureMessage = $_.Exception.Message }
        if ($Accepted -ne $Case.pass) { throw ('Unexpected current manifest result for ' + $SourcePath + ': ' + $Case.name + '; ' + $FailureMessage) }
        $Validated++
    }
}
Write-Output ('Validated ' + $Validated + ' current manifest cases without building or loading a runtime.')
`;
  try {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validated 18 current manifest cases without building or loading a runtime\./u);
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
