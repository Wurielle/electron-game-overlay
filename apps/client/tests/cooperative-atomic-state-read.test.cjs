'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { publishJsonSnapshot } = require('../scripts/cooperative-atomic-state.cjs');
const root = path.resolve(__dirname, '../../..');

test('snapshot publisher retries bounded transient Windows sharing failures without exposing a partial target', () => {
  const filename = path.join(os.tmpdir(), 'isolated-state.json');
  const attempts = [];
  let writes = 0, waits = 0, failures = 2, errorCode = 'EPERM';
  const module = { exports: {} };
  const context = {
    module, require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs') return {
        writeFileSync(destination, value) { writes++; assert.equal(destination, `${filename}.tmp`); assert.equal(JSON.parse(value).value, 7); },
        renameSync(source, destination) {
          attempts.push([source, destination]);
          if (failures-- > 0) throw Object.assign(new Error('sharing failure'), { code: errorCode });
        },
      };
      throw new Error(`Unexpected publisher dependency ${name}`);
    },
    Atomics: { wait() { waits++; } },
  };
  new vm.Script(fs.readFileSync(path.join(root, 'apps/client/scripts/cooperative-atomic-state.cjs'), 'utf8')).runInNewContext(context);
  module.exports.publishJsonSnapshot(filename, { value: 7 });
  assert.equal(writes, 1);
  assert.equal(attempts.length, 3);
  assert.equal(waits, 2);
  assert.ok(attempts.every(([source, destination]) => source === `${filename}.tmp` && destination === filename));
  attempts.length = 0; waits = 0; failures = 1000;
  assert.throws(() => module.exports.publishJsonSnapshot(filename, { value: 7 }), /sharing failure/u);
  assert.equal(attempts.length, 40);
  assert.equal(waits, 39);
  attempts.length = 0; waits = 0; errorCode = 'ENOENT';
  assert.throws(() => module.exports.publishJsonSnapshot(filename, { value: 7 }), /sharing failure/u);
  assert.equal(attempts.length, 1);
  assert.equal(waits, 0);
});

test('actual Windows controller readers consume complete snapshots during concurrent fixture-style atomic renames', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-shared-delete-state-'));
  const runners = ['run-client-sdk-cooperative-surface-lifecycle-gate.ps1', 'run-client-sdk-cooperative-two-app-game-gate.ps1'].map(name => path.join(root, 'libs/electron-game-overlay-runtime/scripts', name));
  const dataPath = path.join(directory, 'test.json');
  const filename = path.join(directory, 'a-state.json');
  const padding = 'x'.repeat(65536);
  fs.writeFileSync(dataPath, JSON.stringify({ directory, runners }));
  publishJsonSnapshot(filename, { value: 0, padding });
  const script = `
$ErrorActionPreference='Stop'
$Data=Get-Content -LiteralPath '${dataPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
$RunDirectory=$Data.directory
$script:CaseDirectory=$Data.directory
foreach($Runner in $Data.runners){
 $Tokens=$null;$Errors=$null
 $Ast=[Management.Automation.Language.Parser]::ParseFile($Runner,[ref]$Tokens,[ref]$Errors)
 if($Errors){throw $Errors}
 $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Read-State'},$true)
 if(-not $Definition){throw ('Read-State missing from '+$Runner)}
 . ([scriptblock]::Create($Definition.Extent.Text))
 $Reads=0
 for($Index=0;$Index -lt 300;$Index++){
  $State=Read-State a
  if($null -eq $State){Start-Sleep -Milliseconds 1;continue}
  if($State.value -lt 0 -or $State.padding.Length -ne 65536){throw 'Atomic rename exposed an incomplete JSON snapshot'}
  $Reads++
 }
 if($Reads -lt 100){throw 'Reader could not observe enough complete concurrent snapshots'}
}
Write-Output 'Both actual readers consumed complete snapshots during atomic publication.'
`;
  let child, timer, writes = 0, writerError, stdout = '', stderr = '';
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    timer = setInterval(() => {
      try { publishJsonSnapshot(filename, { value: ++writes, padding }); }
      catch (error) { writerError = error; clearInterval(timer); child.kill(); }
    }, 2);
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearInterval(timer);
    assert.equal(writerError, undefined, writerError?.stack);
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    assert.ok(writes > 10, `Only ${writes} concurrent snapshots were published.`);
    assert.match(stdout, /Both actual readers consumed complete snapshots/u);
  } finally {
    clearInterval(timer);
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
