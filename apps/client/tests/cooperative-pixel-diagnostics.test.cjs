'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts/run-client-sdk-cooperative-surface-lifecycle-gate.ps1');

test('actual pixel oracle retains strict color checks while recording mismatch RGB, existing foreground and geometry', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-pixel-diagnostic-'));
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
# These test-only constant-returning types have no P/Invoke or screen/input API.
Add-Type -TypeDefinition @'
using System;
namespace ReShadeClientSdkGate {
 public static class NativeInputMethods {
  public struct POINT { public int X,Y; }
  public static bool IsForegroundWindow(IntPtr h) { return true; }
  public static string WindowTitle(IntPtr h) { return "isolated constant test title"; }
  private static IntPtr GetForegroundWindow() { return new IntPtr(0x123); }
  private static bool ClientToScreen(IntPtr h,ref POINT p) { p.X+=1000;p.Y+=2000;return true; }
 }
}
public static class EgoCooperativeSurfacePixels {
 public static uint ColorA=0,ColorB=0;
 public static uint Pixel(IntPtr h,int x,int y) { return x==55?ColorA:ColorB; }
}
'@
foreach($Name in @('Convert-PixelColorRef','Get-PixelProbeContext','Assert-Pixels','Assert-Foreground')){
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
 if(-not $Definition){throw ('Pixel evidence function missing: '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
$RunDirectory='${directory.replaceAll("'", "''")}'
$PrimaryWindow=[IntPtr]::new(0x123);$SecondaryWindow=[IntPtr]::new(0x234)
$Report=[ordered]@{pixelProbes=@()}
function Read-State {param($Member) if($Member -eq 'a'){[pscustomobject]@{processId=101;attached=$true;surface=[pscustomobject]@{hwnd='0x123';renderSize=[pscustomobject]@{width=1280;height=720};clientScreenBounds=[pscustomobject]@{x=1000;y=2000;width=1280;height=720}};windows=[pscustomobject]@{main=[pscustomobject]@{bounds=[pscustomobject]@{x=40;y=80;width=300;height=220};dpr=1;color='#c62828'}}}}}
function Save-Json {param($Value,$Path) $Value|ConvertTo-Json -Depth 35|Set-Content -LiteralPath $Path -Encoding UTF8}
function Wait-Condition {param([scriptblock]$Predicate,$Label,$Milliseconds) if($Milliseconds -ne 15000){throw 'Pixel deadline changed'};for($Index=0;$Index -lt 3;$Index++){if(&$Predicate){return}};throw 'Strict pixel mismatch'}
$Rejected=$false
try{Assert-Pixels $PrimaryWindow $false}catch{$Rejected=$_.Exception.Message -eq 'Strict pixel mismatch'}
if(-not $Rejected){throw 'A wrong pixel was accepted or the original failure was masked'}
$First=$Report.pixelProbes[0]
if($First.status -ne 'failed' -or $First.attempts -ne 3 -or $First.samples[-1].a.hex -ne '0x00000000' -or $First.expectedA.hex -ne '0x002828c6'){throw 'Missing actual/expected COLORREF failure evidence'}
if($First.context.actualForegroundHwnd -ne '0x123' -or $First.context.screenPoints[0].screenX -ne 1055 -or $First.context.screenPoints[0].screenY -ne 2200 -or $First.context.members.a.surface.renderSize.width -ne 1280 -or $First.context.members.a.windows.main.dpr -ne 1 -or $null -ne $First.context.members.b){throw 'Existing foreground/geometry/first-app-only evidence was lost'}
[EgoCooperativeSurfacePixels]::ColorA=0x2828c6
Assert-Pixels $PrimaryWindow $false
if($Report.pixelProbes[1].status -ne 'matched'){throw 'A-only oracle changed while adding B diagnostics'}
$Rejected=$false;try{Assert-Pixels $PrimaryWindow $true}catch{$Rejected=$_.Exception.Message -eq 'Strict pixel mismatch'}
if(-not $Rejected){throw 'The two-app oracle accepted a wrong B pixel'}
[EgoCooperativeSurfacePixels]::ColorB=0xc06515
Assert-Pixels $PrimaryWindow $true
$Last=$Report.pixelProbes[3]
if($Last.status -ne 'matched' -or $Last.samples[0].a.red -ne 198 -or $Last.samples[0].a.green -ne 40 -or $Last.samples[0].b.blue -ne 192){throw 'COLORREF RGB interpretation is incorrect'}
if(@(Get-ChildItem -LiteralPath $RunDirectory -Filter 'pixel-probe-*.json').Count -ne 4){throw 'Per-assertion evidence files were not preserved'}
Write-Output 'Strict pixel outcomes and diagnostic files verified without reading a desktop.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Strict pixel outcomes and diagnostic files verified/u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
