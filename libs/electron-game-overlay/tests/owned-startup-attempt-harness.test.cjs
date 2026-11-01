const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('owned startup proof binds actual producer and exact creation identity through one authorized attempt', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-startup-proof-'));
  try {
    const expected = { pid: 31816, producer: 49556, creation: '134380360336846028', executable: path.join(directory, 'target', 'game.exe') };
    const leaf = path.basename(expected.executable);
    const line = args => `RESHADE_CLIENT_INJECTOR_STARTED target=${JSON.stringify(leaf)} arguments=${JSON.stringify(args)}\r\n`;
    const args = [leaf, '--pid', String(expected.pid), '--expected-creation-time-100ns', expected.creation];
    const event = (type, sequence, data) => ({ schemaVersion: 1, runId: 'run-1', sequence, timestamp: '2026-11-01T19:47:15.473Z', type, targetId: 'target-0001', pid: expected.pid, data: { attemptId: 'attempt-0001', ...data } });
    const base = {
      text: line(args),
      events: [
        { schemaVersion: 1, runId: 'run-1', sequence: 1, type: 'run.started', data: { clientPid: expected.producer } },
        event('attachment.rendezvous-authorized', 13, {}),
        event('attachment.injector-started', 14, { strategy: 'exact-pid' }),
        event('attachment.injector-returned', 15, { runtimeMode: 'participant-addon' }),
      ],
    };
    const clone = () => JSON.parse(JSON.stringify(base));
    const cases = [{ name: 'participant completion', accepted: true, ...clone() }];
    const add = (name, mutate, accepted = false) => { const value = clone(); mutate(value); cases.push({ name, accepted, ...value }); };
    add('full host completion', v => { v.events[3].data.runtimeMode = 'injected-runtime'; }, true);
    add('human duplicate', v => { v.text += v.text; });
    add('missing human start', v => { v.text = ''; });
    add('wrong creation time', v => { v.text = line([...args.slice(0, 4), '134380360336846029']); });
    add('wrong argument PID', v => { v.text = line([leaf, '--pid', '99', ...args.slice(3)]); });
    add('missing creation argument', v => { v.text = line(args.slice(0, 3)); });
    add('extra argument', v => { v.text = line([...args, '--other']); });
    add('wrong executable argument', v => { v.text = line(['other.exe', ...args.slice(1)]); });
    add('wrong producer', v => { v.events[0].data.clientPid++; });
    add('string producer', v => { v.events[0].data.clientPid = String(expected.producer); });
    add('duplicate producer run', v => { v.events.push(v.events[0]); });
    add('wrong returned PID', v => { v.events[3].pid++; });
    add('string returned PID', v => { v.events[3].pid = String(expected.pid); });
    add('foreign runtime mode', v => { v.events[3].data.runtimeMode = 'official-addon'; });
    add('missing runtime mode', v => { delete v.events[3].data.runtimeMode; });
    add('wrong strategy', v => { v.events[2].data.strategy = 'process-name'; });
    add('wrong attempt ID', v => { v.events[3].data.attemptId = 'attempt-2'; });
    add('wrong target ID', v => { v.events[3].targetId = 'target-2'; });
    add('wrong run ID', v => { v.events[3].runId = 'run-2'; });
    add('missing authorization', v => { v.events.splice(1, 1); });
    add('duplicate authorization', v => { v.events.push(v.events[1]); });
    add('duplicate start', v => { v.events.push(v.events[2]); });
    add('duplicate return', v => { v.events.push(v.events[3]); });
    add('missing return', v => { v.events.pop(); });
    add('wrong event schema', v => { v.events[3].schemaVersion = 2; });
    add('string event schema', v => { v.events[3].schemaVersion = '1'; });
    add('wrong chronology', v => { v.events[3].sequence = 12; });
    add('invalid timestamp', v => { v.events[3].timestamp = 'invalid'; });
    fs.writeFileSync(path.join(directory, 'input.json'), JSON.stringify({ expected, cases }));
    fs.writeFileSync(path.join(directory, 'check.ps1'), String.raw`
$ErrorActionPreference='Stop'
. $env:EGO_STARTUP_HELPER
$Fixture=Get-Content -Raw $env:EGO_STARTUP_INPUT | ConvertFrom-Json
$Results=@()
foreach($Case in $Fixture.cases) {
  try {
    $Proof=Read-OwnedOverlayStartupAttempt -ClientLogText $Case.text -Events $Case.events -ExpectedPid $Fixture.expected.pid -ExpectedProducerPid $Fixture.expected.producer -ExpectedCreationTime100ns $Fixture.expected.creation -ExpectedExecutablePath $Fixture.expected.executable
    $Results += [pscustomobject]@{name=$Case.name;accepted=$true;proof=$Proof}
  } catch {$Results += [pscustomobject]@{name=$Case.name;accepted=$false;error=$_.Exception.Message}}
}
[Console]::WriteLine(($Results|ConvertTo-Json -Depth 8 -Compress))
`);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(directory, 'check.ps1')], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, EGO_STARTUP_HELPER: path.resolve(__dirname, '../../electron-game-overlay-runtime/scripts/owned-injector-result.ps1'), EGO_STARTUP_INPUT: path.join(directory, 'input.json') },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.length, cases.length);
    for (let index = 0; index < cases.length; index++) {
      assert.equal(observed[index].accepted, cases[index].accepted, `${cases[index].name}: ${observed[index].error || JSON.stringify(observed[index])}`);
      if (cases[index].accepted) {
        assert.equal(observed[index].proof.TargetPid, expected.pid);
        assert.equal(observed[index].proof.ProducerPid, expected.producer);
        assert.equal(observed[index].proof.CreationTime100ns, expected.creation);
        assert.equal(observed[index].proof.AttemptId, 'attempt-0001');
        assert.equal(observed[index].proof.TargetId, 'target-0001');
        assert.equal(observed[index].proof.TargetExecutablePath, expected.executable);
      }
    }
  } finally {
    assert.equal(path.dirname(directory).toLowerCase(), os.tmpdir().replace(/[\\/]$/, '').toLowerCase());
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
