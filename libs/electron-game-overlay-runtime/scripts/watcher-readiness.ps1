function Wait-OverlayNativeWatcherReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.Process]$InjectorProcess,
        [Parameter(Mandatory = $true)]
        [string]$StdoutPath,
        [Parameter(Mandatory = $true)]
        [DateTime]$Deadline,
        [string]$Marker = 'ReShade process watcher armed.'
    )

    $Pattern = '^' + [regex]::Escape($Marker) + '\r?$'
    while ([DateTime]::UtcNow -lt $Deadline) {
        $InjectorProcess.Refresh()
        if ($InjectorProcess.HasExited) {
            throw "The injector exited before its future-target watcher was ready. Inspect $StdoutPath."
        }
        if ((Test-Path -LiteralPath $StdoutPath -PathType Leaf) -and
            (Select-String -LiteralPath $StdoutPath -Pattern $Pattern -Quiet)) {
            return
        }
        Start-Sleep -Milliseconds 25
    }
    throw "Timed out waiting for the injector's future-target readiness marker '$Marker'. Inspect $StdoutPath."
}
