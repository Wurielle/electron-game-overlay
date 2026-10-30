// Portable source/configuration guards, NOT PowerShell or Windows execution.
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
test('portable source contract: staging mirrors schema28/cap1 native and schema4/cap1 package producer', () => {
  assert.match(producer, /\$BuildStamp.schemaVersion -ne 28/);
  assert.match(stage, /\$BuildStamp.schemaVersion -ne 28 -or\s*\$BuildStamp.injectorProcessInstanceBinding -ne 1 -or/);
  assert.match(stage, /\$PackageBuildStamp.schemaVersion -ne 4 -or\s*\$PackageBuildStamp.injectorProcessInstanceBinding -ne 1 -or/);
  const properties = stage.match(/\$ExpectedPackageBuildStampProperties = @\(([\s\S]*?)\) \| Sort-Object/)[1];
  const produced = producer.match(/\$PackageBuildStamp = \[ordered\]@\{([\s\S]*?)\n\}/)[1];
  assert.deepEqual([...properties.matchAll(/"(\w+)"/g)].map(m => m[1]).sort(), [...produced.matchAll(/^    (\w+) =/gm)].map(m => m[1]).sort());
  assert.deepEqual(patches(stage), patches(producer));
  assert.equal(patches(stage).length, 26);
  for (const [, file] of patches(stage)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/patches', file))).digest('hex').length, 64);
});
test('portable extracted numeric guards reject old stamps and absent/incorrect capabilities', () => {
  for (const [variable, schemaVersion] of [['BuildStamp', 28], ['PackageBuildStamp', 4]]) {
    const valid = Object.fromEntries(requirements(variable));
    assert.equal(valid.schemaVersion, schemaVersion);
    assert.equal(valid.injectorProcessInstanceBinding, 1);
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
