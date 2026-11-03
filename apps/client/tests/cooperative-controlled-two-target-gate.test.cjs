const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runner = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts/run-client-sdk-two-app-two-target-gate.ps1');
const discovery = 'electron-overlay-transport-v1.json';
const probe = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:EGO_TWO_TARGET_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Runner must parse'}
foreach($name in @('Assert-TargetDiscoveryRecord','Assert-PrivateTargetRoutes','Get-DiscoveryPathSnapshot','Assert-DiscoveryPathsUnchanged')){
 $definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
 if($definition.Count -ne 1){throw ('Expected one pure helper '+$name)}
 . ([scriptblock]::Create($definition[0].Extent.Text))
}
$payload=Get-Content -LiteralPath $env:EGO_TWO_TARGET_PAYLOAD -Raw | ConvertFrom-Json
$results=@()
foreach($case in $payload.cases){
 $accepted=$true
 try{
  $a=$case.recordARaw | ConvertFrom-Json
  $b=$case.recordBRaw | ConvertFrom-Json
  Assert-PrivateTargetRoutes -RouteAPath $case.routeA -RouteBPath $case.routeB ` + '`' + String.raw`
   -RunDirectoryA $case.runA -RunDirectoryB $case.runB -RecordA $a -RecordB $b ` + '`' + String.raw`
   -ClientPidA $case.clientA -ClientPidB $case.clientB -TargetPidA $case.targetA -TargetPidB $case.targetB
 }catch{$accepted=$false}
 $results += [ordered]@{name=$case.name;accepted=$accepted}
}
$present=Get-DiscoveryPathSnapshot -Path $payload.present
$absent=Get-DiscoveryPathSnapshot -Path $payload.absent
$snapshots=@($present,$absent)
Assert-DiscoveryPathsUnchanged -Snapshots $snapshots
$original=[IO.File]::ReadAllBytes($payload.present)
$changed=[byte[]]$original.Clone(); $changed[$changed.Length-2]=$changed[$changed.Length-2] -bxor 1
[IO.File]::WriteAllBytes($payload.present,$changed)
$mutationRejected=$false
try{Assert-DiscoveryPathsUnchanged -Snapshots $snapshots}catch{$mutationRejected=$true}
[IO.File]::WriteAllBytes($payload.present,$original)
[IO.File]::Delete($payload.present)
$deletionRejected=$false
try{Assert-DiscoveryPathsUnchanged -Snapshots $snapshots}catch{$deletionRejected=$true}
[IO.File]::WriteAllBytes($payload.present,$original)
[IO.File]::WriteAllText($payload.absent,'created unexpectedly')
$creationRejected=$false
try{Assert-DiscoveryPathsUnchanged -Snapshots $snapshots}catch{$creationRejected=$true}
[IO.File]::Delete($payload.absent)
Assert-DiscoveryPathsUnchanged -Snapshots $snapshots
$directoryRejected=$false
try{Get-DiscoveryPathSnapshot -Path $payload.directory | Out-Null}catch{$directoryRejected=$true}
$oversizeRejected=$false
try{Get-DiscoveryPathSnapshot -Path $payload.oversize | Out-Null}catch{$oversizeRejected=$true}
$commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true))
$legacyWaits=@($commands | Where-Object {
 $_.GetCommandName() -in @('Wait-ForDiscoveryRecord','Wait-ForPathRemoval') -and
 $_.Extent.Text -match '\$(GlobalDiscoveryPath|StaticDiscoveryPath[A-Z]*)\b'
})
$ownedLoops=@($ast.FindAll({param($node)
 $node -is [Management.Automation.Language.ForEachStatementAst] -and
 $node.Variable.Extent.Text -eq '$OwnedPath' -and
 $node.Condition.Extent.Text.Contains('$RendezvousPathA') -and
 $node.Condition.Extent.Text.Contains('$RendezvousPathB') -and
 $node.Body.Extent.Text.Contains('Wait-ForPathRemoval')
},$true))
[ordered]@{
 cases=$results; present=$present; absent=$absent
 mutationRejected=$mutationRejected; deletionRejected=$deletionRejected; creationRejected=$creationRejected
 directoryRejected=$directoryRejected; oversizeRejected=$oversizeRejected
 legacyWaitCount=$legacyWaits.Count; ownedRemovalLoops=$ownedLoops.Count
 isolatedInputCalls=@($commands | Where-Object {$_.GetCommandName() -eq 'Test-IsolatedClientInput'}).Count
 unchangedCalls=@($commands | Where-Object {$_.GetCommandName() -eq 'Assert-DiscoveryPathsUnchanged'}).Count
} | ConvertTo-Json -Depth 6 -Compress
`;

test('actual controlled two-target guards enforce private route identity and preserve unrelated discovery files', {
  skip: process.platform !== 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-two-target-guards-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ego-two-target-guards-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const runA = path.join(directory, 'app-a');
  const runB = path.join(directory, 'app-b');
  fs.mkdirSync(runA); fs.mkdirSync(runB);
  const recordA = { version: 1, pid: 101, port: 43210, token: 'a'.repeat(64), targetPid: 1001 };
  const recordB = { version: 1, pid: 202, port: 43211, token: 'b'.repeat(64), targetPid: 2002 };
  const base = {
    runA, runB, routeA: path.join(runA, discovery), routeB: path.join(runB, discovery),
    recordARaw: JSON.stringify(recordA), recordBRaw: JSON.stringify(recordB),
    clientA: 101, clientB: 202, targetA: 1001, targetB: 2002,
  };
  const cases = [];
  function add(name, changes = {}, accepted = false) { cases.push({ ...base, ...changes, name, accepted }); }
  function changedA(changes) { return JSON.stringify({ ...recordA, ...changes }); }
  function changedB(changes) { return JSON.stringify({ ...recordB, ...changes }); }
  add('valid independent routes', {}, true);
  add('distinct full tokens with the same prefix', { recordBRaw: changedB({ token: 'a'.repeat(63) + 'b' }) }, true);
  add('swapped producer', { recordARaw: changedA({ pid: 202 }) });
  add('swapped target', { recordARaw: changedA({ targetPid: 2002 }) });
  add('shared producer identity', { clientB: 101, recordBRaw: changedB({ pid: 101 }) });
  add('shared target identity', { targetB: 1001, recordBRaw: changedB({ targetPid: 1001 }) });
  add('shared token', { recordBRaw: changedB({ token: recordA.token }) });
  add('shared port', { recordBRaw: changedB({ port: recordA.port }) });
  add('shared path', { routeB: base.routeA });
  add('shared staged directory', { runB: runA, routeB: base.routeA });
  add('foreign staged path', { routeA: path.join(directory, 'foreign', discovery) });
  add('lookalike staged prefix', { routeA: path.join(`${runA}-foreign`, discovery) });
  add('relative route', { routeA: discovery });
  add('wrong canonical filename', { routeA: path.join(runA, 'other.json') });
  add('string version', { recordARaw: changedA({ version: '1' }) });
  add('string producer', { recordARaw: changedA({ pid: '101' }) });
  add('fractional target', { recordARaw: changedA({ targetPid: 1001.5 }) });
  add('string port', { recordARaw: changedA({ port: '43210' }) });
  add('floating JSON port', { recordARaw: base.recordARaw.replace('43210', '43210.0') });
  add('zero port', { recordARaw: changedA({ port: 0 }) });
  add('oversized port', { recordARaw: changedA({ port: 65536 }) });
  add('non-string token', { recordARaw: changedA({ token: 123 }) });
  add('uppercase token', { recordARaw: changedA({ token: 'A'.repeat(64) }) });
  add('extra schema key', { recordARaw: changedA({ extra: true }) });
  add('uppercase schema key', { recordARaw: base.recordARaw.replace('"pid"', '"PID"') });
  const present = path.join(directory, 'legacy-existing.json');
  const absent = path.join(directory, 'legacy-absent.json');
  const protectedBytes = Buffer.from('{"token":"fixture-private-credential"}', 'utf8');
  fs.writeFileSync(present, protectedBytes);
  const oversize = path.join(directory, 'legacy-oversize.json');
  fs.writeFileSync(oversize, Buffer.alloc(4097, 0x20));
  const payload = path.join(directory, 'cases.json');
  fs.writeFileSync(payload, JSON.stringify({ cases, present, absent, directory: runA, oversize }), 'utf8');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(probe, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, EGO_TWO_TARGET_SOURCE: runner, EGO_TWO_TARGET_PAYLOAD: payload },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.cases.length, cases.length);
  for (let i = 0; i < cases.length; i += 1) {
    assert.equal(evidence.cases[i].name, cases[i].name);
    assert.equal(evidence.cases[i].accepted, cases[i].accepted, cases[i].name);
  }
  assert.deepEqual(Object.keys(evidence.present).sort(), ['Exists', 'Length', 'Path', 'Sha256']);
  assert.equal(evidence.present.Path, path.resolve(present));
  assert.equal(evidence.present.Exists, true);
  assert.equal(evidence.present.Length, protectedBytes.length);
  assert.equal(evidence.present.Sha256.toLowerCase(), crypto.createHash('sha256').update(protectedBytes).digest('hex'));
  assert.equal(JSON.stringify(evidence.present).includes('fixture-private-credential'), false);
  assert.equal(evidence.absent.Exists, false);
  assert.equal(evidence.absent.Length, 0);
  assert.equal(evidence.absent.Sha256, null);
  for (const flag of ['mutationRejected', 'deletionRejected', 'creationRejected', 'directoryRejected', 'oversizeRejected']) {
    assert.equal(evidence[flag], true, flag);
  }
  assert.equal(evidence.legacyWaitCount, 0);
  assert.equal(evidence.ownedRemovalLoops, 1);
  assert.equal(evidence.isolatedInputCalls, 2);
  assert.ok(evidence.unchangedCalls >= 3);
  const source = fs.readFileSync(runner, 'utf8');
  assert.match(source, /\$SurvivingDiscoveryB\.port\s+-ne\s+\$DiscoveryB\.port/);
  assert.match(source, /\$SurvivingDiscoveryB\.token\s+-cne\s+\$DiscoveryB\.token/);
  assert.ok(source.includes("App A target shutdown terminated App B's independent session."));
  assert.ok(source.includes("App B disconnected when App A's target exited."));
});
