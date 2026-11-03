const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptsDirectory = path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts');
const helper = path.join(scriptsDirectory, 'process-environment.ps1');

const probe = String.raw`
$ErrorActionPreference = 'Stop'
. $env:EGO_RUNTIME_ENV_HELPER
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class EgoEnvironmentProbe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool SetEnvironmentVariableW(string name, string value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetEnvironmentVariableW(string name, StringBuilder value, uint length);
    public static uint Required(string name) { return GetEnvironmentVariableW(name, null, 0); }
    public static void Absent(string name) { Set(name, null); }
    public static void Empty(string name) { Set(name, String.Empty); }
    public static void Value(string name, string value) { Set(name, value); }
    private static void Set(string name, string value) {
        if (!SetEnvironmentVariableW(name, value)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@
$name = 'EGO_ENVIRONMENT_TEST_' + [Guid]::NewGuid().ToString('N')
$other = $name + '_OTHER'
function Assert-Required([uint32]$Expected, [string]$Label) {
    $observed = [EgoEnvironmentProbe]::Required($name)
    if ($observed -ne $Expected) { throw "$Label required $Expected UTF-16 units, got $observed" }
    if ([Environment]::GetEnvironmentVariable($other, 'Process') -cne 'unchanged') {
        throw "$Label changed an unrelated variable"
    }
}
$results = @()
[EgoEnvironmentProbe]::Value($other, 'unchanged')
try {
    foreach ($state in @('absent', 'empty', 'value')) {
        $expected = switch ($state) { 'absent' { 0 } 'empty' { 1 } 'value' { 8 } }
        switch ($state) {
            'absent' { [EgoEnvironmentProbe]::Absent($name) }
            'empty' { [EgoEnvironmentProbe]::Empty($name) }
            'value' { [EgoEnvironmentProbe]::Value($name, 'payload') }
        }
        Assert-Required $expected "initial $state"
        Set-OverlayProcessEnvironmentVariable -Name $name -Value $null
        Assert-Required 0 "clear $state"
        switch ($state) {
            'absent' { [EgoEnvironmentProbe]::Absent($name) }
            'empty' { [EgoEnvironmentProbe]::Empty($name) }
            'value' { [EgoEnvironmentProbe]::Value($name, 'payload') }
        }
        $previous = Get-OverlayProcessEnvironmentVariable -Name $name
        if ($state -eq 'absent' -and $null -ne $previous) { throw 'Absent capture became a value' }
        if ($state -eq 'empty' -and ($null -eq $previous -or $previous -cne '')) {
            throw 'Present-empty capture became absent'
        }
        Set-OverlayProcessEnvironmentVariable -Name $name -Value 'replacement'
        Assert-Required 12 "replace $state"
        Set-OverlayProcessEnvironmentVariable -Name $name -Value $previous
        Assert-Required $expected "restore $state"
        if ($state -eq 'value' -and [Environment]::GetEnvironmentVariable($name, 'Process') -cne 'payload') {
            throw 'Restored value contents changed'
        }
        $results += [ordered]@{ state = $state; cleared = 0; restored = $expected }
    }
    Set-OverlayProcessEnvironmentVariable -Name $name -Value ''
    Assert-Required 1 'explicit present-empty value'
    Set-OverlayProcessEnvironmentVariable -Name $name -Value $null
    Assert-Required 0 'explicit null after empty'
    [ordered]@{ cases = $results; emptyPreserved = $true; unrelatedPreserved = $true } |
        ConvertTo-Json -Depth 4 -Compress
}
finally {
    [EgoEnvironmentProbe]::Absent($name)
    [EgoEnvironmentProbe]::Absent($other)
}
`;

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell} distinguishes removing, setting and restoring empty process variables`, {
    skip: process.platform !== 'win32',
  }, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-process-environment-'));
    t.after(() => {
      const resolvedDirectory = path.resolve(directory);
      assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolvedDirectory).startsWith('ego-process-environment-'));
      fs.rmSync(resolvedDirectory, { recursive: true, force: true });
    });
    const script = path.join(directory, 'probe.ps1');
    fs.writeFileSync(script, probe, 'utf8');
    const result = spawnSync(shell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], {
      env: { ...process.env, EGO_RUNTIME_ENV_HELPER: helper },
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') {
      t.skip('PowerShell 7 is not installed');
      return;
    }
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.deepEqual(evidence.cases, [
      { state: 'absent', cleared: 0, restored: 0 },
      { state: 'empty', cleared: 0, restored: 1 },
      { state: 'value', cleared: 0, restored: 8 },
    ]);
    assert.equal(evidence.emptyPreserved, true);
    assert.equal(evidence.unrelatedPreserved, true);
  });
}

test('runtime scripts preserve absence and empty values when clearing and capturing process variables', () => {
  const untypedNull = /\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*\(\s*[^,]+,\s*\$null\s*,/gi;
  const lossyCapture = /\$PreviousEnvironment\[[^\]]+\]\s*=\s*\[(?:System\.)?Environment\]::GetEnvironmentVariable/gi;
  const offenders = [];
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith('.ps1')) {
        const source = fs.readFileSync(file, 'utf8');
        if (untypedNull.test(source) || lossyCapture.test(source)) {
          offenders.push(path.relative(scriptsDirectory, file));
        }
      }
      untypedNull.lastIndex = 0;
      lossyCapture.lastIndex = 0;
    }
  }
  inspect(scriptsDirectory);
  assert.deepEqual(offenders, [],
    'Untyped null can become present-empty under PowerShell 7; managed capture loses present-empty under Windows PowerShell');
});
