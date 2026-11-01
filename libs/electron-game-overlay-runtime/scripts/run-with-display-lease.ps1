[CmdletBinding()]
param(
    [string]$TestScript,
    [string]$TestParametersJson = '{}',
    [ValidateRange(100,3000)][int]$PowerTimeoutMs = 1000,
    [ValidateRange(0,30)][int]$HoldSeconds = 0,
    [string]$EvidencePath,
    [switch]$DefinitionsOnly
)
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if (-not $EvidencePath) { $EvidencePath = Join-Path $RepoRoot ('build\display-lease-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.json') }
$EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
$BuildRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'build')) + [IO.Path]::DirectorySeparatorChar
if (-not $EvidencePath.StartsWith($BuildRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Display-lease evidence must stay within this workspace build directory.' }
$Parameters = @{}
$Parsed = $TestParametersJson | ConvertFrom-Json
if ($null -eq $Parsed -or $Parsed -is [array] -or $Parsed -is [string] -or $Parsed -is [ValueType]) { throw 'TestParametersJson must be a JSON object.' }
foreach ($Property in $Parsed.PSObject.Properties) { $Parameters[$Property.Name] = $Property.Value }
if ($TestScript) {
    $TestScript = (Resolve-Path -LiteralPath $TestScript).Path
    if (-not $TestScript.StartsWith($RepoRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetExtension($TestScript) -ne '.ps1' -or $TestScript -eq $PSCommandPath) { throw 'The visual test must be an explicit workspace PowerShell script.' }
}
& (Join-Path $PSScriptRoot 'read-display-power-state.ps1') -DefinitionsOnly
if (-not ('EgoVisualDisplayLease' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class EgoVisualDisplayLease : IDisposable {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr PowerCreateRequest(IntPtr context);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool PowerSetRequest(IntPtr request,int type);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool PowerClearRequest(IntPtr request,int type);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 IntPtr request=IntPtr.Zero,context=IntPtr.Zero,reason=IntPtr.Zero;
 bool active=false;
 public bool ClearSucceeded {get;private set;}
 public bool CloseSucceeded {get;private set;}
 public int ClearError {get;private set;}
 public int CloseError {get;private set;}
 public static EgoVisualDisplayLease Create() {
  var lease=new EgoVisualDisplayLease();
  try {
   // REASON_CONTEXT: version/flags DWORDs, union at offset8. Its native
   // maximum size is32 on64-bit,24 on32-bit. Keep reason storage alive.
   int bytes=IntPtr.Size==8?32:24;
   lease.context=Marshal.AllocHGlobal(bytes);Marshal.Copy(new byte[bytes],0,lease.context,bytes);
   lease.reason=Marshal.StringToHGlobalUni("Electron Game Overlay bounded visual acceptance test");
   Marshal.WriteInt32(lease.context,0,0);Marshal.WriteInt32(lease.context,4,1);Marshal.WriteIntPtr(lease.context,8,lease.reason);
   lease.request=PowerCreateRequest(lease.context);
   if(lease.request==IntPtr.Zero||lease.request==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"PowerCreateRequest failed");
   if(!PowerSetRequest(lease.request,0))throw new Win32Exception(Marshal.GetLastWin32Error(),"PowerSetRequest(DisplayRequired) failed");
   lease.active=true;return lease;
  }catch{lease.Dispose();throw;}
 }
 public void Dispose() {
  if(request!=IntPtr.Zero&&request!=new IntPtr(-1)) {
   if(active){ClearSucceeded=PowerClearRequest(request,0);ClearError=ClearSucceeded?0:Marshal.GetLastWin32Error();active=false;}
   CloseSucceeded=CloseHandle(request);CloseError=CloseSucceeded?0:Marshal.GetLastWin32Error();request=IntPtr.Zero;
  }
  if(context!=IntPtr.Zero){Marshal.FreeHGlobal(context);context=IntPtr.Zero;}
  if(reason!=IntPtr.Zero){Marshal.FreeHGlobal(reason);reason=IntPtr.Zero;}
 }
}
'@
}
if ($DefinitionsOnly) { return }
$Report = [ordered]@{ schemaVersion=1; startedAt=[DateTime]::UtcNow.ToString('o'); collectorPid=$PID; collectorSession=[Diagnostics.Process]::GetCurrentProcess().SessionId; scope='Temporary PowerRequestDisplayRequired handle only; no persistent settings, override, input or GUI change.'; testScript=$TestScript; testParameters=$Parameters; status='failed'; testAttempted=$false }
$Lease = $null
try {
    $Report.before = [EgoDisplayPowerRead]::Read('session-display-before', '2b84c20e-ad23-4ddf-93db-05ffbd7efca5', $PowerTimeoutMs)
    $Lease = [EgoVisualDisplayLease]::Create()
    $Report.requestCreated = $true
    $Report.during = [EgoDisplayPowerRead]::WaitForOn('session-display-with-request', '2b84c20e-ad23-4ddf-93db-05ffbd7efca5', $PowerTimeoutMs)
    if (-not $Report.during.initialNotificationReceived -or $Report.during.state -ne 1) {
        $Report.status = 'display-precondition-unavailable'
        throw "Visual test requires an observed display-on notification; observed '$($Report.during.stateName)'. No test input or rendering case was started."
    }
    if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }
    if ($TestScript) {
        $Report.testAttempted = $true
        & $TestScript @Parameters
        if (-not $?) { throw 'The visual test returned an unsuccessful status.' }
    }
    $Report.status = 'passed'
} catch {
    $Report.error = $_.Exception.Message
    throw
} finally {
    if ($Lease) {
        $Lease.Dispose()
        $Report.clearSucceeded=$Lease.ClearSucceeded; $Report.clearError=$Lease.ClearError
        $Report.closeSucceeded=$Lease.CloseSucceeded; $Report.closeError=$Lease.CloseError
    }
    $Report.finishedAt=[DateTime]::UtcNow.ToString('o')
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($EvidencePath)) -Force | Out-Null
    $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
    Write-Host "Display lease evidence: $EvidencePath"
}
