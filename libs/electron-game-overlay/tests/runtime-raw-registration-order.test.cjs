const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gate = path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts/run-client-sdk-input-gate.ps1');

// Parse the real runner, but execute only its argument construction, the
// pre-registration branch and the client launch statement. Every external
// operation reachable from these nodes is a local mock using synthetic paths.
const probe = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:EGO_RAW_GATE_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The production input gate must parse.' }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-ClientSdkAttempt'
}, $true))
if ($functions.Count -ne 1) { throw 'Expected exactly one attempt function.' }
$body = $functions[0].Body
$arguments = @($body.FindAll({ param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$ClientArguments' -and
    $node.Operator -eq [Management.Automation.Language.TokenKind]::Equals
}, $true))
$before = @($body.FindAll({ param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -eq '$RawRegistrationTiming -eq "before-injection"' -and
    $node.Extent.Text.Contains('Wait-ForRawRegistrationBeforeInjection')
}, $true))
$client = @($body.FindAll({ param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$ClientProcess' -and
    $node.Right.Extent.Text -match '^Start-Process\b'
}, $true))
$after = @($body.FindAll({ param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -eq '$RawRegistrationTiming -eq "after-injection"' -and
    $node.Extent.Text.Contains('RESHADE_CLIENT_INJECTOR_WATCHER_READY')
}, $true))
if ($arguments.Count -ne 1 -or $before.Count -ne 1 -or $client.Count -ne 1 -or $after.Count -ne 1) {
    throw 'Expected unique argument, registration, client and future-watcher nodes.'
}
if ($before[0].Extent.EndOffset -gt $client[0].Extent.StartOffset) {
    throw 'Raw registration must be verified before client startup.'
}
$argumentScript = [ScriptBlock]::Create($arguments[0].Extent.Text)
$registrationScript = [ScriptBlock]::Create($before[0].Extent.Text)
$clientScript = [ScriptBlock]::Create($client[0].Extent.Text)
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$PassThru,
        $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
    if ($FilePath -eq 'synthetic-electron.exe') {
        $script:state.calls.Add('client-start')
        $script:state.clientStarts++
        return [pscustomobject]@{ Id = 515151 }
    }
    if ($FilePath -ne 'synthetic-host.exe') { throw 'Unexpected mocked executable.' }
    $script:state.calls.Add('host-start')
    $script:state.hostStarts++
    return [pscustomobject]@{ Id = 424242 }
}
function Wait-ForHostWindow {
    param($HostProcess, $Deadline)
    if ($HostProcess.Id -ne 424242) { throw 'Wrong synthetic host.' }
    $script:state.calls.Add('host-window')
    return 123
}
function Wait-ForRawRegistrationBeforeInjection {
    param($Window, $HostProcess, $Deadline)
    if ($Window -ne 123 -or $HostProcess.Id -ne 424242) { throw 'Wrong registration observation.' }
    $script:state.calls.Add('raw-registration')
    return $script:state.oracle
}
function Write-Host { param($Object) }
function Invoke-ProbeCase([string]$Timing, [string]$Target, [bool]$ValidOracle) {
    $RawRegistrationTiming = $Timing
    $RawRegistrationTarget = $Target
    $RepoRoot = 'synthetic-repository'
    $HostName = 'synthetic-host.exe'
    $TargetExecutablePath = 'synthetic-host.exe'
    $TargetDirectory = 'synthetic-target-directory'
    $UserData = 'synthetic-user-data'
    $Electron = 'synthetic-electron.exe'
    $ClientStdout = 'synthetic-stdout'
    $ClientStderr = 'synthetic-stderr'
    $expectedOracle = if ($Target -eq 'null-focus') {
        'target=null-focus hwndTarget=NULL'
    } else { 'target=explicit-hwnd hwndTarget=window' }
    $script:state = @{
        calls = [Collections.Generic.List[string]]::new()
        hostStarts = 0
        clientStarts = 0
        oracle = if ($ValidOracle) { 'rawRegister=ok ' + $expectedOracle } else { 'rawRegister=ok target=wrong hwndTarget=other' }
    }
    $exception = $null
    try {
        . $argumentScript
        . $registrationScript
        . $clientScript
    }
    catch { $exception = $_.Exception.Message }
    [ordered]@{
        timing = $Timing
        target = $Target
        validOracle = $ValidOracle
        arguments = @($ClientArguments)
        calls = @($script:state.calls.ToArray())
        hostStarts = $script:state.hostStarts
        clientStarts = $script:state.clientStarts
        exception = $exception
    }
}
$cases = @(
    (Invoke-ProbeCase 'before-injection' 'explicit-hwnd' $true),
    (Invoke-ProbeCase 'before-injection' 'null-focus' $true),
    (Invoke-ProbeCase 'after-injection' 'explicit-hwnd' $true),
    (Invoke-ProbeCase 'after-injection' 'null-focus' $true),
    (Invoke-ProbeCase 'before-injection' 'explicit-hwnd' $false),
    (Invoke-ProbeCase 'before-injection' 'null-focus' $false)
)
[ordered]@{ cases = $cases; beforeBranch = $before[0].Extent.Text; afterBranch = $after[0].Extent.Text } |
    ConvertTo-Json -Depth 5 -Compress
`;

test('raw-registration gate binds an already-running host only after its exact oracle passes', {
  skip: process.platform !== 'win32',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-raw-registration-order-'));
  t.after(() => {
    const resolvedDirectory = path.resolve(directory);
    assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedDirectory).startsWith('ego-raw-registration-order-'));
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  });
  const script = path.join(directory, 'probe.ps1');
  fs.writeFileSync(script, probe, 'utf8');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], {
    env: { ...process.env, EGO_RAW_GATE_SOURCE: gate },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.cases.length, 6);
  for (const observed of evidence.cases) {
    const arguments_ = observed.arguments.map((argument) => argument.replace(/^"|"$/g, ''));
    assert.ok(arguments_.includes('--reshade-auto-target-process=synthetic-host.exe'));
    const boundPid = arguments_.filter((argument) => argument.startsWith('--reshade-expected-target-pid='));
    if (!observed.validOracle) {
      assert.match(observed.exception, /wrong pre-injection registration target/i);
      assert.equal(observed.clientStarts, 0);
      assert.deepEqual(boundPid, []);
      assert.deepEqual(observed.calls, ['host-start', 'host-window', 'raw-registration']);
    } else if (observed.timing === 'before-injection') {
      assert.equal(observed.exception, null);
      assert.deepEqual(boundPid, ['--reshade-expected-target-pid=424242']);
      assert.equal(observed.hostStarts, 1);
      assert.equal(observed.clientStarts, 1);
      assert.deepEqual(observed.calls, ['host-start', 'host-window', 'raw-registration', 'client-start']);
    } else {
      assert.equal(observed.exception, null);
      assert.deepEqual(boundPid, []);
      assert.equal(observed.hostStarts, 0);
      assert.equal(observed.clientStarts, 1);
      assert.deepEqual(observed.calls, ['client-start']);
    }
  }
  const before = evidence.beforeBranch;
  assert.match(before, /\$ClientArguments\s*\+=\s*"--reshade-expected-target-pid=\$\(\$HostProcess\.Id\)"/);
  assert.ok(before.indexOf('$RegistrationReadyTitle.Contains($ExpectedReadyTarget)') <
    before.indexOf('--reshade-expected-target-pid='));
  const after = evidence.afterBranch;
  assert.ok(after.indexOf('RESHADE_CLIENT_INJECTOR_WATCHER_READY') <
    after.indexOf('$HostProcess = Start-Process'));
});
