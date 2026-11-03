'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');

test('all cooperative controllers select and execute exactly the first Node when PATH has multiple real copies', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-node-path-order-'));
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.copyFileSync(process.execPath, path.join(first, 'node.exe'));
  fs.copyFileSync(process.execPath, path.join(second, 'node.exe'));
  const runners = [
    ['run-client-sdk-cooperative-surface-lifecycle-gate.ps1', 'Node'],
    ['run-client-sdk-cooperative-two-app-game-gate.ps1', 'Node'],
    ['run-client-sdk-two-app-one-target-gate.ps1', 'EvidenceNode'],
  ].map(([name, variable]) => ({ path: path.join(root, 'libs/electron-game-overlay-runtime/scripts', name), variable }));
  const dataPath = path.join(directory, 'fixture.json');
  fs.writeFileSync(dataPath, JSON.stringify({ first, second, runners, version: process.version }));
  const script = `
$ErrorActionPreference='Stop'
$Data=Get-Content -LiteralPath '${dataPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$OriginalPath=$env:PATH
foreach($Order in @(@($Data.first,$Data.second),@($Data.second,$Data.first))){
 $env:PATH=$Order[0]+[IO.Path]::PathSeparator+$Order[1]+[IO.Path]::PathSeparator+$OriginalPath
 $Candidates=@(Get-Command node.exe -CommandType Application -All -ErrorAction Stop)
 foreach($Directory in $Order){if(@($Candidates|Where-Object{[string]::Equals($_.Source,(Join-Path $Directory 'node.exe'),[StringComparison]::OrdinalIgnoreCase)}).Count -ne 1){throw 'Expected two independently resolvable real Node copies'}}
 foreach($Runner in $Data.runners){
  $Tokens=$null;$Errors=$null
  $Ast=[Management.Automation.Language.Parser]::ParseFile($Runner.path,[ref]$Tokens,[ref]$Errors)
  if($Errors){throw $Errors}
  $Variable=$Runner.variable
  $Assignments=@($Ast.FindAll({param($AstNode) $AstNode -is [Management.Automation.Language.AssignmentStatementAst] -and $AstNode.Left -is [Management.Automation.Language.VariableExpressionAst] -and $AstNode.Left.VariablePath.UserPath -ceq $Variable},$true))
  if($Assignments.Count -ne 1){throw ('Expected one isolated Node resolver in '+$Runner.path)}
  . ([scriptblock]::Create($Assignments[0].Extent.Text))
  $Resolved=Get-Variable -Name $Variable -ValueOnly
  if($Resolved -isnot [string] -or -not [string]::Equals($Resolved,(Join-Path $Order[0] 'node.exe'),[StringComparison]::OrdinalIgnoreCase)){throw 'Controller selected multiple executables or ignored PATH order'}
  $Version=& $Resolved --version
  if($LASTEXITCODE -ne 0 -or $Version -cne $Data.version){throw 'The selected single Node path could not execute normally'}
 }
}
Write-Output 'Three actual controller resolvers selected one real Node in both PATH orders.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Three actual controller resolvers selected one real Node in both PATH orders/u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
