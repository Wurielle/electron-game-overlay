'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-two-app-one-target-gate.ps1');

test('controlled two-app route evidence rejects the old shared endpoint and mismatched producer/target credentials', {
  skip: process.platform !== 'win32' ? 'PowerShell metadata validation requires Windows' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-controlled-private-routes-'));
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  const extra = path.join(directory, 'extra');
  for (const item of [a, b, extra]) fs.mkdirSync(item);
  const record = (pid, port, token) => ({ version: 1, pid, targetPid: 303, port, token });
  const recordA = record(101, 41001, 'ab'.repeat(32));
  const recordB = record(102, 41002, 'cd'.repeat(32));
  const aLog = path.join(directory, 'a.log');
  const bLog = path.join(directory, 'b.log');
  const line = item => `RESHADE_CLIENT_RUNTIME_STAGED directory=${JSON.stringify(item)}\n`;
  fs.writeFileSync(aLog, line(a));
  fs.writeFileSync(bLog, line(b));
  const expectedFingerprint = crypto.createHash('sha256').update(recordA.token).digest('hex');
  const payload = { runner, a, b, extra, aLog, bLog, recordA, recordB, expectedFingerprint };
  const payloadPath = path.join(directory, 'fixture.json');
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  const script = `
$ErrorActionPreference = 'Stop'
$Data = Get-Content -LiteralPath '${payloadPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Data.runner,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
foreach ($Name in @('Get-RunDirectoriesFromClientLog','Get-PrivateParticipantRoute','Assert-PrivateParticipantRoutes')) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('Required private route guard is missing: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
function Get-ClientLogText { param([string]$Path) Get-Content -LiteralPath $Path -Raw }
function Save-Record([string]$Directory,[object]$Record) { $Record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'electron-overlay-transport-v1.json') -Encoding UTF8 }
function Must-Reject([scriptblock]$Operation,[string]$Label) { $Rejected=$false;try{ & $Operation | Out-Null }catch{$Rejected=$true};if(-not $Rejected){throw ('Incorrectly accepted ' + $Label)} }
Save-Record $Data.a $Data.recordA
Save-Record $Data.b $Data.recordB
$A = Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303
$B = Get-PrivateParticipantRoute -ClientLog $Data.bLog -ProducerPid 102 -TargetPid 303
Assert-PrivateParticipantRoutes $A $B
if ($A.TokenFingerprint -cne $Data.expectedFingerprint -or @($A.PSObject.Properties.Name) -contains 'token') { throw 'Private route evidence leaked a credential or used the wrong fingerprint.' }
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 999 -TargetPid 303 } 'a broker/foreign producer PID'
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 999 } 'a foreign target PID'
foreach ($Field in @('Port','TokenFingerprint','ProducerPid','DiscoveryPath')) {
    $Bad = $B | Select-Object *
    $Bad.$Field = $A.$Field
    Must-Reject { Assert-PrivateParticipantRoutes $A $Bad } ('shared route field ' + $Field)
}
foreach ($Port in @(0,65536,'41001')) {
    $Bad = $Data.recordA | Select-Object *
    $Bad.port = $Port
    Save-Record $Data.a $Bad
    Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303 } 'an invalid port'
}
$Bad = $Data.recordA | Select-Object *
$Bad.token = 'ab'
Save-Record $Data.a $Bad
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303 } 'an invalid credential'
Save-Record $Data.a $Data.recordA
Save-Record $Data.extra $Data.recordA
$ExtraLine = 'RESHADE_CLIENT_RUNTIME_STAGED directory=' + (ConvertTo-Json -InputObject $Data.extra -Compress)
Add-Content -LiteralPath $Data.aLog -Value $ExtraLine
Must-Reject { Get-PrivateParticipantRoute -ClientLog $Data.aLog -ProducerPid 101 -TargetPid 303 } 'ambiguous staged routes'
Write-Output 'Controlled private route evidence verified without starting a host or app.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Controlled private route evidence verified without starting a host or app\./u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
