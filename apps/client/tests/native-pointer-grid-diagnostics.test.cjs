'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = path.resolve(__dirname, '../../../libs/electron-game-overlay-runtime/scripts/run-native-pointer-gate.ps1');

test('pointer failure diagnostics preserve the strict scaled red/blue acceptance oracle', () => {
  const source = fs.readFileSync(runner, 'utf8');
  assert.ok(source.includes("foreach ($PixelCase in @(@(480,100,0x3539e5),@(540,100,0xe5881e))) {"));
  assert.ok(source.includes('$PixelX = [int][Math]::Round($PixelCase[0]*$Ready.scaleFactor)'));
  assert.ok(source.includes('$PixelY = [int][Math]::Round($PixelCase[1]*$Ready.scaleFactor)'));
  assert.ok(source.includes("Wait-State a {param($s) [EgoPointer]::Pixel($Target.MainWindowHandle,$PixelX,$PixelY) -eq $PixelCase[2]} 'native composited calibration pixel' 30"));
});

test('extracted pointer diagnostic collector bounds samples and preserves the original failure when diagnostics fail', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-pointer-grid-'));
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
# Constant test doubles only: no P/Invoke, desktop reads, input or native host.
Add-Type -TypeDefinition @'
using System;
public static class EgoPointer {
 public static int Calls=0;
 public static bool ThrowPixel=false,ThrowForeground=false,InvalidPixel=false;
 public static uint Pixel(IntPtr h,int x,int y) {
  Calls++;
  if(h.ToInt64()!=0x456)throw new Exception("wrong target HWND");
  if(ThrowPixel)throw new Exception("isolated pixel diagnostic failure");
  return InvalidPixel?UInt32.MaxValue:0x123456u;
 }
 public static string Foreground() {
  if(ThrowForeground)throw new Exception("isolated foreground diagnostic failure");
  return "1110:constant owned host title";
 }
 public static string CursorSnapshot() { return "constant cursor"; }
}
'@
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Get-NativeCalibrationDiagnostics'},$true)
if(-not $Definition){throw 'Missing diagnostic collector'}
. ([scriptblock]::Create($Definition.Extent.Text))
$Target=[pscustomobject]@{Id=123;MainWindowHandle=[IntPtr]::new(0x456)}
$Fixture=[pscustomobject]@{scaleFactor=1.25;renderer=[pscustomobject]@{dpr=1.25;width=600;height=480};paint=[pscustomobject]@{scales=@(1);dipSize=[pscustomobject]@{width=750;height=600}};attached=$true;rendering=$true}
$Report=@{status='failed';checks=@();error='original acceptance failure'}
$Before=$Report|ConvertTo-Json -Depth 20 -Compress
$Result=Get-NativeCalibrationDiagnostics $Target $Fixture 1.25 1.5
if(($Report|ConvertTo-Json -Depth 20 -Compress) -cne $Before){throw 'Diagnostic collection mutated gate outcome'}
if([EgoPointer]::Calls -ne 148 -or $Result.calibrationPoints.Count -ne 4 -or $Result.grid.samples.Count -ne 144){throw 'Sampling is not bounded to four exact points and144 grid points'}
if($Result.grid.columns -ne 16 -or $Result.grid.rows -ne 9 -or $Result.grid.width -ne 1280 -or $Result.grid.height -ne 720){throw 'Unexpected diagnostic grid'}
if($Result.grid.samples[0].clientX -ne 40 -or $Result.grid.samples[0].clientY -ne 40 -or $Result.grid.samples[-1].clientX -ne 1240 -or $Result.grid.samples[-1].clientY -ne 680){throw 'Grid does not span the bounded1280x720 client'}
foreach($Sample in $Result.grid.samples){if($Sample.clientX -lt 0 -or $Sample.clientX -ge 1280 -or $Sample.clientY -lt 0 -or $Sample.clientY -ge 720){throw 'Grid point is out of bounds'};if($Sample.colorRef -ne 0x123456 -or $Sample.hex -cne '0x00123456' -or $Sample.red -ne 86 -or $Sample.green -ne 52 -or $Sample.blue -ne 18 -or -not $Sample.valid){throw 'COLORREF/RGB evidence is incorrect'}}
$Expected=@(@(480,100),@(600,125),@(540,100),@(675,125))
for($Index=0;$Index -lt 4;$Index++){if($Result.calibrationPoints[$Index].clientX -ne $Expected[$Index][0] -or $Result.calibrationPoints[$Index].clientY -ne $Expected[$Index][1]){throw 'Scaled/unscaled exact calibration coordinates changed'}}
if($Result.calibrationPoints[0].expectedColorRef -ne 0x3539e5 -or $Result.calibrationPoints[2].expectedColorRef -ne 0xe5881e){throw 'Expected calibration colors changed'}
if($Result.expectedTarget.pid -ne 123 -or $Result.expectedTarget.hwnd -cne '0x456' -or $Result.foregroundTitle -cne '1110:constant owned host title' -or $Result.fixture.paint.dipSize.width -ne 750 -or $Result.requestedOsrScaleFactor -ne 1.5){throw 'Target, foreground, raster or requested scale provenance lost'}
[EgoPointer]::InvalidPixel=$true
$Invalid=Get-NativeCalibrationDiagnostics $Target $Fixture 1.25 1.5
if($Invalid.grid.samples[0].valid -or $Invalid.grid.samples[0].hex -cne '0xffffffff'){throw 'GetPixel failure sentinel became valid evidence'}
[EgoPointer]::InvalidPixel=$false;[EgoPointer]::ThrowPixel=$true;[EgoPointer]::ThrowForeground=$true
$Failed=Get-NativeCalibrationDiagnostics $Target $Fixture 1.25 1.5
if($Failed.grid.samples.Count -ne 144 -or -not $Failed.grid.samples[0].error -or -not $Failed.foregroundError){throw 'Diagnostic failure was not bounded and recorded'}
# Execute the runner's actual top-level catch, without its body/finally/process setup.
$TopTry=@($Ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.TryStatementAst]})[-1]
if(-not $TopTry -or $TopTry.CatchClauses.Count -ne 1){throw 'Expected the isolated real failure handler'}
function Command {param($Member,$Action) throw 'isolated capture diagnostic failure'}
function Read-State {param($Member) return $Fixture}
$Evidence='${directory.replaceAll("'", "''")}';$ScaleFactor=1.25;$OsrScaleFactor=1.5
$Operation=[scriptblock]::Create("try { throw 'original strict calibration failure' } " + $TopTry.CatchClauses[0].Extent.Text)
$Caught=$null
try { & $Operation } catch { $Caught=$_.Exception.Message }
if($Caught -cne 'original strict calibration failure' -or $Report.error -cne $Caught -or $Report.status -cne 'failed' -or $Report.checks.Count -ne 0){throw 'Diagnostic errors masked or changed the strict gate failure'}
$Saved=Get-Content -LiteralPath (Join-Path $Evidence 'native-calibration-failure.json') -Raw|ConvertFrom-Json
if($Saved.grid.samples.Count -ne 144 -or -not $Saved.grid.samples[0].error -or -not $Report.nativePixelDiagnosticError -or -not $Report.nativeCalibrationDiagnostics){throw 'Failure JSON/report did not survive diagnostic errors'}
Write-Output 'Bounded pointer RGB diagnostics and original gate failure verified without a desktop.'
`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Bounded pointer RGB diagnostics and original gate failure verified/u);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
