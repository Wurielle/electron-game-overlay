'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const fixture = path.join(root, 'apps/client/scripts/cooperative-surface-lifecycle-fixture.cjs');
const runner = path.join(root, 'libs/electron-game-overlay-runtime/scripts/run-client-sdk-cooperative-surface-lifecycle-gate.ps1');

async function simulatedProducer(directory, invalidDiscovery = false) {
  const stage = path.join(directory, 'stage');
  const sdkDist = path.join(directory, 'sdk');
  fs.mkdirSync(stage);
  fs.mkdirSync(sdkDist);
  fs.writeFileSync(path.join(stage, 'electron-overlay-transport-v1.json'), JSON.stringify({ version: 1, pid: invalidDiscovery ? 9999 : 2020, targetPid: 3030, port: 41001, token: 'ab'.repeat(32) }));
  const handlers = new Map();
  const observed = { value: '', downs: 0, ups: 0, keydowns: 0, heldKeys: [], dpr: 1 };
  const nativeCalls = { focus: 0, blur: 0, exits: [] };
  let tick;
  const window = {
    nativeId: 1,
    browserWindow: { webContents: {
      executeJavaScript: async code => {
        if (code.startsWith('({...window.observed')) return structuredClone(observed);
        if (code.includes("input').value=''")) observed.value = '';
      },
    }, loadURL: async () => {} },
    show() {}, focus() { nativeCalls.focus++; }, blur() { nativeCalls.blur++; },
  };
  const session = {
    on(name, listener) { handlers.set(name, listener); },
    windows: { create: () => window }, input: { intercept() {}, release() {} },
  };
  const sdk = {
    ElectronGameOverlay: class { createSession() { return session; } dispose() {} },
    ReShadeOverlayLauncher: class { onEvent(listener) { this.listener = listener; } attach() { this.listener({ type: 'injector-returned' }); return Promise.resolve({ pid: 3030, runDirectory: stage }); } dispose() {} },
    parseReShadeLaunchConfig: () => ({}),
  };
  const app = { setPath() {}, disableHardwareAcceleration() {}, on() {}, whenReady: () => Promise.resolve(), exit(code) { nativeCalls.exits.push(code); } };
  const context = {
    require(name) {
      if (name === 'electron') return { app };
      if (name === './cooperative-game-evidence.cjs') return { collectSdkEvidence: () => ({ sdkDist }) };
      if (name === './cooperative-atomic-state.cjs') return require('../scripts/cooperative-atomic-state.cjs');
      if (name === path.join(sdkDist, 'index.js')) return sdk;
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected fixture dependency ${name}`);
    },
    process: { argv: ['electron', fixture, '--member=b', `--evidence=${directory}`, `--sdk-dist=${sdkDist}`, '--target=C:/controlled/host.exe', '--pid=3030'], pid: 2020, on() {} },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {}, console,
  };
  await new vm.Script(fs.readFileSync(fixture, 'utf8'), { filename: fixture }).runInNewContext(context);
  return { handlers, observed, nativeCalls, tick: () => tick(), read: () => JSON.parse(fs.readFileSync(path.join(directory, 'b-state.json'), 'utf8')), command: async (action, sequence) => {
    fs.writeFileSync(path.join(directory, 'b-command.json'), JSON.stringify({ action, sequence }));
    await tick();
  } };
}

test('lifecycle producer retains IDs and cumulative authentication/loss/input counters without inventing explicit focus', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-lifecycle-producer-'));
  try {
    const producer = await simulatedProducer(directory);
    assert.equal(producer.read().attached, true);
    assert.equal(producer.read().injectorReturned, true);
    assert.equal(producer.nativeCalls.focus, 0);
    producer.handlers.get('targetConnected')({ pid: 3030, executablePath: 'C:/controlled/host.exe', creationTime100ns: '134000000000000001' });
    producer.handlers.get('diagnostic')({ code: 'target-authenticated', severity: 'info', pid: 3030 });
    producer.handlers.get('targetSurfaceChanged')({ pid: 3030, surfaceId: '0x11', hwnd: '0x10', renderSize: { width: 1280, height: 720 } });
    producer.handlers.get('windowFocused')({ pid: 3030, windowId: 1 });
    Object.assign(producer.observed, { value: 'bp', downs: 2, ups: 2, keydowns: 2 });
    await producer.tick();
    const before = producer.read();
    assert.equal(before.connectionCount, 1);
    assert.equal(before.authenticationCount, 1);
    assert.equal(before.explicitFocusCount, 0);
    assert.equal(before.focusedWindowId, 1);
    assert.equal(before.windows.main.keydowns, 2);
    producer.handlers.get('targetSurfaceRemoved')({ pid: 3030, surfaceId: '0x11', revision: 2 });
    producer.handlers.get('windowFocused')({ pid: 3030, windowId: 0 });
    producer.handlers.get('targetTransportLost')({ pid: 3030 });
    await producer.tick();
    const destroyed = producer.read();
    assert.equal(destroyed.surface, null);
    assert.equal(destroyed.removedSurfaceCount, 1);
    assert.equal(destroyed.transportLostCount, 1);
    assert.equal(destroyed.targetDisconnectedCount, 0);
    assert.equal(destroyed.windows.main.id, before.windows.main.id);
    producer.handlers.get('targetConnected')({ pid: 3030, executablePath: 'C:/controlled/host.exe', creationTime100ns: '134000000000000001' });
    producer.handlers.get('diagnostic')({ code: 'target-authenticated', severity: 'info', pid: 3030 });
    producer.handlers.get('targetSurfaceChanged')({ pid: 3030, surfaceId: '0x22', hwnd: '0x10' });
    await producer.tick();
    const recreated = producer.read();
    assert.equal(recreated.connectionCount, 2);
    assert.equal(recreated.authenticationCount, 2);
    assert.equal(recreated.transportLostCount, 1);
    assert.equal(recreated.windows.main.id, before.windows.main.id);
    assert.equal(recreated.focusedWindowId, 0);
    assert.equal(producer.nativeCalls.focus, 0);
    await producer.command('focus', 1);
    assert.equal(producer.read().explicitFocusCount, 1);
    assert.equal(producer.nativeCalls.focus, 1);
    assert.equal(producer.read().commandSequence, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('lifecycle producer fails closed when staged transport belongs to another producer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-lifecycle-bad-route-'));
  try {
    const producer = await simulatedProducer(directory, true);
    assert.equal(producer.read().attached, false);
    assert.match(producer.read().error, /Private transport route did not match/u);
    assert.deepEqual(producer.nativeCalls.exits, [1]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('actual keyboard-only stale-focus phase rejects desktop foreground loss before or after input', { skip: process.platform !== 'win32' }, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$Send=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $Node.Member.Value -ceq 'SendUnicodeText' -and $Node.Arguments.Count -eq 1 -and $Node.Arguments[0] -is [Management.Automation.Language.StringConstantExpressionAst] -and $Node.Arguments[0].Value -ceq 'z'},$true)
if(-not $Send){throw 'Native stale-focus keyboard attempt missing'}
$Body=$Send
while($Body -isnot [Management.Automation.Language.StatementBlockAst]){$Body=$Body.Parent}
$Statement=$Send
while($Statement.Parent -ne $Body){$Statement=$Statement.Parent}
$Statements=@($Body.Statements)
$Index=[array]::IndexOf($Statements,$Statement)
if($Index -lt 1 -or $Index+2 -ge $Statements.Count){throw 'Incomplete keyboard-only observation phase'}
$Phase=[scriptblock]::Create(($Statements[($Index-1)..($Index+2)]|ForEach-Object{$_.Extent.Text}) -join [Environment]::NewLine)
# A non-native test double; it cannot send real input or observe a screen.
Add-Type -TypeDefinition @'
using System;
namespace ReShadeClientSdkGate {
 public static class NativeInputMethods {
  public static bool Foreground=true,LoseOnSend=false;
  public static int Sends=0;
  public static void SendUnicodeText(string value) { if(value!="z")throw new Exception("Wrong key marker");Sends++;if(LoseOnSend)Foreground=false; }
 }
}
'@
$PrimaryWindow=[IntPtr]::new(123)
$script:Guards=0
function Assert-Foreground {param($Window) $script:Guards++;if(-not [ReShadeClientSdkGate.NativeInputMethods]::Foreground){throw 'Foreground changed'}}
function Start-Sleep {param($Milliseconds) if($Milliseconds -ne 500){throw 'Keyboard-only observation interval changed'}}
&$Phase
if($script:Guards -ne 2 -or [ReShadeClientSdkGate.NativeInputMethods]::Sends -ne 1){throw 'Missing direct foreground guards around actual SendInput phase'}
[ReShadeClientSdkGate.NativeInputMethods]::Foreground=$false
[ReShadeClientSdkGate.NativeInputMethods]::Sends=0
$Rejected=$false;try{&$Phase}catch{$Rejected=$_.Exception.Message -eq 'Foreground changed'}
if(-not $Rejected -or [ReShadeClientSdkGate.NativeInputMethods]::Sends -ne 0){throw 'Input was attempted after preexisting foreground loss'}
[ReShadeClientSdkGate.NativeInputMethods]::Foreground=$true
[ReShadeClientSdkGate.NativeInputMethods]::LoseOnSend=$true
$Rejected=$false;try{&$Phase}catch{$Rejected=$_.Exception.Message -eq 'Foreground changed'}
if(-not $Rejected -or [ReShadeClientSdkGate.NativeInputMethods]::Sends -ne 1){throw 'Post-input foreground loss could produce a false stale-focus pass'}
Write-Output 'Actual keyboard-only phase requires foreground before and after the input attempt.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Actual keyboard-only phase requires foreground/u);
});

test('controlled lifecycle TCP observer binds both endpoints to exact producer/target PIDs', { skip: process.platform !== 'win32' }, () => {
  const script = `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${runner.replaceAll("'", "''")}',[ref]$Tokens,[ref]$Errors)
if($Errors){throw $Errors}
$Source=Get-Content -LiteralPath '${runner.replaceAll("'", "''")}' -Raw
$Interop=[regex]::Match($Source,"(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@")
if(-not $Interop.Success){throw 'Pixel interop source missing'}
Add-Type -TypeDefinition $Interop.Groups[1].Value
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Get-TcpEvidence'},$true)
if(-not $Definition){throw 'TCP evidence function missing'}
. ([scriptblock]::Create($Definition.Extent.Text))
$HostProcess=[pscustomobject]@{Id=3030}
$State=[pscustomobject]@{processId=2020;transport=[pscustomobject]@{port=41001}}
$script:Rows=@([pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=41001;RemoteAddress='127.0.0.1';RemotePort=52001;OwningProcess=2020;State='Established'},[pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=52001;RemoteAddress='127.0.0.1';RemotePort=41001;OwningProcess=3030;State='Established'})
function Get-NetTCPConnection { param($State,$OwningProcess,$ErrorAction) @($script:Rows | Where-Object { $_.OwningProcess -eq $OwningProcess -and $_.State -eq $State }) }
$Actual=Get-TcpEvidence $State
if($Actual.owningProcess -ne 2020 -or $Actual.remotePort -ne 52001){throw 'Wrong exact TCP identity'}
function Must-Reject([scriptblock]$Operation){$Rejected=$false;try{&$Operation|Out-Null}catch{$Rejected=$true};if(-not $Rejected){throw 'Accepted foreign/missing/duplicate target TCP evidence'}}
$script:Rows[1].OwningProcess=9999
Must-Reject {Get-TcpEvidence $State}
$script:Rows[1].OwningProcess=3030
$script:Rows[1].RemotePort=41002
Must-Reject {Get-TcpEvidence $State}
$script:Rows[1].RemotePort=41001
$script:Rows+=($script:Rows[0]|Select-Object *)
Must-Reject {Get-TcpEvidence $State}
foreach($Name in @('Host-Text','Start-App','New-StartInfo')){
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name},$true)
 if(-not $Definition){throw ('Missing lifecycle startup guard '+$Name)}
 . ([scriptblock]::Create($Definition.Extent.Text))
}
$RunDirectory='C:\\isolated-test'
function Test-Path {param($LiteralPath) return $true}
function Get-Content {param($LiteralPath,[switch]$Raw) return $null}
$Empty=Host-Text
if($null -eq $Empty -or $Empty -isnot [string] -or $Empty.Length -ne 0){throw 'Empty stdout did not normalize to a safe string'}
if([regex]::Matches($Empty,'marker').Count -ne 0){throw 'Empty stdout fabricated a marker'}
$Apps=@{};$Electron='C:\\isolated-test\\electron.exe';$Fixture='C:\\isolated-test\\fixture.cjs';$TargetPath='C:\\isolated-test\\host.exe';$RepoRoot='C:\\isolated-test';$SdkDistA='C:\\isolated-test\\sdk';$SdkDistB=$SdkDistA
$script:ProducerState=[pscustomobject]@{ready=$true;injectorReturned=$true;attached=$false}
function Read-State {param($Member) return $script:ProducerState}
function Start-Owned {param($Info) return [pscustomobject]@{StandardOutput=[IO.StringReader]::new('');StandardError=[IO.StringReader]::new('')}}
function Wait-Condition {param([scriptblock]$Predicate,$Label,$Milliseconds) if(-not (&$Predicate)){throw ('Unsatisfied '+$Label)}}
Start-App a $false
Must-Reject {Start-App b}
$script:ProducerState.attached=$true
Start-App b
$script:ProducerState.injectorReturned=$false
Must-Reject {Start-App a $false}
Write-Output 'Exact TCP peer guards verified without starting a native host.'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Exact TCP peer guards verified/u);
});
