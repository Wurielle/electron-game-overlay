# Shared visual-test precondition only. Loading this file performs no native call.
function Enter-VisualTestDisplayLease([System.Collections.IDictionary]$Report, [int]$TimeoutMs = 2000) {
    if (-not ('EgoVisualDisplayLease' -as [type]) -or -not ('EgoDisplayPowerRead' -as [type])) {
        & (Join-Path $PSScriptRoot 'run-with-display-lease.ps1') -DefinitionsOnly
    }
    $Report.displayPrecondition = [ordered]@{ scope='Temporary display request held through visual-test cleanup; actual ON callback required, no settings or override changes.'; status='pending'; before=$null; during=$null }
    $DisplayLease = $null
    try {
        $Report.displayPrecondition.before = [EgoDisplayPowerRead]::Read('visual-test-display-before', '2b84c20e-ad23-4ddf-93db-05ffbd7efca5', $TimeoutMs)
        $DisplayLease = [EgoVisualDisplayLease]::Create()
        $Report.displayPrecondition.requestCreated = $true
        $Report.displayPrecondition.during = [EgoDisplayPowerRead]::WaitForOn('visual-test-display-required', '2b84c20e-ad23-4ddf-93db-05ffbd7efca5', $TimeoutMs)
        if (-not $Report.displayPrecondition.during.initialNotificationReceived -or $Report.displayPrecondition.during.state -ne 1) {
            $Report.displayPrecondition.status = 'unavailable'
            throw "Visual test display precondition unavailable: observed '$($Report.displayPrecondition.during.stateName)'; exact pixel assertions were not run."
        }
        $Report.displayPrecondition.status = 'on'
        return $DisplayLease
    } catch {
        $Report.displayPrecondition.error = $_.Exception.Message
        Exit-VisualTestDisplayLease $DisplayLease $Report
        throw
    }
}
function Exit-VisualTestDisplayLease([object]$DisplayLease, [System.Collections.IDictionary]$Report) {
    if (-not $DisplayLease) { return }
    try {
        $DisplayLease.Dispose()
        $Report.displayPrecondition.clearSucceeded = $DisplayLease.ClearSucceeded
        $Report.displayPrecondition.clearError = $DisplayLease.ClearError
        $Report.displayPrecondition.closeSucceeded = $DisplayLease.CloseSucceeded
        $Report.displayPrecondition.closeError = $DisplayLease.CloseError
    } catch { $Report.displayPrecondition.cleanupError = $_.Exception.Message }
}
