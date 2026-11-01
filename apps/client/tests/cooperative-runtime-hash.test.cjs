'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts/cooperative-native-evidence.ps1');

test('actual runtime identity oracle accepts hex case variations and rejects different or malformed SHA-256 digests', { skip: process.platform !== 'win32' }, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Assert-CooperativeRuntimeHash'},$true)
if(-not $Definition){throw 'Runtime hash oracle is missing'}
. ([scriptblock]::Create($Definition.Extent.Text))
$Lower='783bed'+('abcdef0123456789'*4).Substring(0,58)
$Upper=$Lower.ToUpperInvariant()
$Mixed=$Lower.Substring(0,32)+$Upper.Substring(32)
foreach($Observed in @($Lower,$Upper,$Mixed)){
 foreach($Expected in @($Lower,$Upper,$Mixed)){Assert-CooperativeRuntimeHash -Observed $Observed -Expected @($Expected)}
}
$Wrong='0'+$Lower.Substring(1)
Assert-CooperativeRuntimeHash -Observed $Lower -Expected @($Wrong,$Upper)
function Must-Reject([scriptblock]$Operation){$Rejected=$false;try{&$Operation|Out-Null}catch{$Rejected=$true};if(-not $Rejected){throw 'Runtime hash oracle accepted different or malformed bytes'}}
Must-Reject {Assert-CooperativeRuntimeHash -Observed $Wrong -Expected @($Lower)}
Must-Reject {Assert-CooperativeRuntimeHash -Observed $Wrong -Expected @($Lower,$Mixed)}
foreach($Invalid in @('',('a'*63),('a'*65),('g'*64),$null)){
 Must-Reject {Assert-CooperativeRuntimeHash -Observed $Invalid -Expected @($Lower)}
 Must-Reject {Assert-CooperativeRuntimeHash -Observed $Lower -Expected @($Invalid)}
}
Must-Reject {Assert-CooperativeRuntimeHash -Observed @($Lower,$Upper) -Expected @($Lower)}
Must-Reject {Assert-CooperativeRuntimeHash -Observed $Lower -Expected @()}
Must-Reject {Assert-CooperativeRuntimeHash -Observed $Lower -Expected @($Lower,$Lower,$Lower)}
Write-Output 'Case-insensitive exact SHA-256 runtime identity verified.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Case-insensitive exact SHA-256 runtime identity verified/u);
});
