'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-cooperative-two-app-game-gate.ps1');
const fixture = path.join(root, 'apps/client/scripts/cooperative-two-app-game-fixture.cjs');

test('Electron acceptance fixture has valid JavaScript syntax without executing Electron or a game', () => {
  const result = spawnSync(process.execPath, ['--check', fixture], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('game controller parses, compiles its input interop, and refuses ownership of an existing game', {
  skip: process.platform !== 'win32' ? 'PowerShell and Windows interop compilation require Windows' : false,
}, () => {
  // Extract only the controller-owned launch function. The process-start
  // boundary and process inventory are replaced; no executable is launched by
  // this test except the isolated PowerShell interpreter itself.
  const script = `
$ErrorActionPreference = 'Stop'
$Runner = '${runner.replaceAll("'", "''")}'
$Tokens = $null; $Errors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Runner,[ref]$Tokens,[ref]$Errors)
if ($Errors) { throw $Errors }
$Source = Get-Content -LiteralPath $Runner -Raw
$Interop = [regex]::Match($Source,"(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@")
if (-not $Interop.Success) { throw 'Input interop source is missing.' }
Add-Type -TypeDefinition $Interop.Groups[1].Value
foreach ($Name in @('Start-Game','Assert-NoRunningGame')) {
    $Definition = $Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
    if (-not $Definition) { throw ('Controller-owned launch function is missing: ' + $Name) }
    . ([scriptblock]::Create($Definition.Extent.Text))
}
$script:Existing = $false
$script:Starts = 0
$script:Games = [Collections.ArrayList]::new()
$GameExecutable = 'C:\\owned-test\\Gun Frog.exe'
function Get-Process { param([string]$Name) if ($script:Existing) { [pscustomobject]@{Id=777} } }
function Start-OwnedProcess {
    param([Diagnostics.ProcessStartInfo]$StartInfo,[string]$Label)
    $script:Starts++
    if ($StartInfo.FileName -cne $GameExecutable -or $StartInfo.UseShellExecute -or
        $StartInfo.WorkingDirectory -cne (Split-Path -Parent $GameExecutable) -or
        $StartInfo.Environment['SteamAppId'] -cne '3173130' -or
        $StartInfo.Environment['SteamGameId'] -cne '3173130') { throw 'Unexpected game launch identity/environment.' }
    return [pscustomobject]@{Id=123;StartTime=[DateTime]::UtcNow}
}
$Identity = @(Start-Game)
if ($script:Starts -ne 1 -or $script:Games.Count -ne 1 -or $Identity[-1].pid -ne 123 -or
    $Identity[-1].creationTime100ns -notmatch '^[1-9][0-9]*$') { throw 'Controller did not retain the owned game identity.' }
$script:Existing = $true
$Rejected = $false
try { Start-Game | Out-Null } catch { $Rejected = $_.Exception.Message -like '*already running*' }
if (-not $Rejected -or $script:Starts -ne 1 -or $script:Games.Count -ne 1) { throw 'An existing game was adopted or another launch attempted.' }
Write-Output 'Controller ownership and interop verified without launching a game.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Controller ownership and interop verified without launching a game\./u);
});
