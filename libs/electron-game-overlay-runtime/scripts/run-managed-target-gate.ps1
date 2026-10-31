param([string]$ElectronExecutable, [switch]$BestEffort)
$ErrorActionPreference='Stop'
$RepoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
if(-not $ElectronExecutable){$ElectronExecutable=Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'}
$Evidence=Join-Path $RepoRoot ('build\managed-targets-'+(Get-Date -Format yyyyMMdd-HHmmss))
$ScriptPath=Join-Path $RepoRoot 'libs\electron-game-overlay\tests\managed-targets.acceptance.cjs'
$HostPath=Join-Path $RepoRoot 'build\electron-game-overlay-runtime-production\RelWithDebInfo\d3d11_overlay_test_host.exe'
$Arguments=@('--no-error-dialogs', ('"'+$ScriptPath+'"'), ('"--host='+$HostPath+'"'), ('"--evidence='+$Evidence+'"'))
if($BestEffort){$Arguments+='--mode=best-effort'}
$PreviousPipe=$env:ELECTRON_GAME_OVERLAY_BROKER_PIPE
$env:ELECTRON_GAME_OVERLAY_BROKER_PIPE='\\.\pipe\ego-managed-native-'+[guid]::NewGuid().ToString('N')
try {
  New-Item -ItemType Directory -Path $Evidence | Out-Null
  $Client=Start-Process -FilePath $ElectronExecutable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Evidence 'stdout.log') -RedirectStandardError (Join-Path $Evidence 'stderr.log')
  $Deadline=[DateTime]::UtcNow.AddSeconds(210)
  $Mapped=@{}
  while(-not $Client.HasExited -and [DateTime]::UtcNow -lt $Deadline){
    $Progress=Join-Path $Evidence 'progress.json'
    if(Test-Path -LiteralPath $Progress){
      try{
        $State=Get-Content -LiteralPath $Progress -Raw | ConvertFrom-Json
        $Target=Get-Process -Id $State.targetPid -ErrorAction Stop
        $ExpectedTarget=Join-Path $Evidence 'target\managed-native-host.exe'
        if($Target.MainModule.FileName -ne $ExpectedTarget){throw 'Owned acceptance target identity mismatch'}
        $Runtime=@($Target.Modules | Where-Object {$_.ModuleName -eq 'ReShade64.dll'}) | Select-Object -First 1
        if($Runtime){
          $Log=Join-Path ([IO.Path]::GetDirectoryName($Runtime.FileName)) 'inject.stdout.log'
          if((Test-Path -LiteralPath $Log) -and (Get-Content -LiteralPath $Log -Raw) -match 'ELECTRON_GAME_OVERLAY_INJECTOR_RESULT'){
            $Addon=@($Target.Modules | Where-Object {$_.ModuleName -eq 'electron_game_overlay.addon64'}) | Select-Object -First 1
            Remove-Item -LiteralPath (Join-Path $Evidence 'target\electron-game-overlay-startup-barrier.enabled') -Force -ErrorAction SilentlyContinue
            if($Addon){
              $Hash=(Get-FileHash -LiteralPath $Addon.FileName -Algorithm SHA256).Hash
              $ExpectedHash=(Get-FileHash -LiteralPath (Join-Path $RepoRoot 'libs\electron-game-overlay\dist\runtime\win32-x64\reshade\electron_game_overlay.addon64') -Algorithm SHA256).Hash
              if($Hash -ne $ExpectedHash){throw 'Mapped acceptance add-on does not match candidate payload'}
              $Mapped[[string]$State.targetPid]=@{pid=$State.targetPid;addonSha256=$Hash;runtimePath=$Runtime.FileName}
              $Mapped.Values | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Evidence 'mapped-artifacts.json')
              # The provider may own a cache run outside this fixture's runsRoot.
              # Release only this fixture's graphics barrier after its mapped
              # runtime and successful injector output have both been observed.
              Remove-Item -LiteralPath (Join-Path $Evidence 'target\electron-game-overlay-startup-barrier.enabled') -Force -ErrorAction SilentlyContinue
            }
          }
        }
      }catch{
        if($_.Exception.Message -match 'identity mismatch|does not match candidate'){throw}
      }
    }
    Start-Sleep -Milliseconds 40
    $Client.Refresh()
  }
  if(-not $Client.HasExited){$Client.Kill();throw 'Owned managed-target acceptance timed out'}
  if($Client.ExitCode -ne 0){Get-Content (Join-Path $Evidence 'report.json');throw 'Managed target acceptance failed'}
  Write-Host "Managed target evidence: $Evidence"
}finally{$env:ELECTRON_GAME_OVERLAY_BROKER_PIPE=$PreviousPipe}
