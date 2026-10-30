import assert from 'node:assert/strict';
import test from 'node:test';
import { logReShadeLauncherEvent } from '../src/main/electron/reshade-launcher-logging.ts';

test('demo launcher logging preserves the controlled-gate lifecycle markers', () => {
  const logs = [];
  const errors = [];
  const logger = {
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };
  const invocation = Object.freeze({
    executable: 'C:\\runtime\\inject.exe',
    arguments: Object.freeze(['game.exe', '--pid', '42']),
    targetLabel: 'process:game.exe:pid:42',
    workingDirectory: 'C:\\runtime',
  });
  const result = Object.freeze({
    processName: 'game.exe',
    targetLabel: 'process:game.exe:pid:42',
    injectorTargetPid: 42,
    runtimeMode: 'injected-runtime',
    runDirectory: 'C:\\runtime',
    injectorStdoutPath: 'C:\\runtime\\stdout.log',
    injectorStderrPath: 'C:\\runtime\\stderr.log',
    reshadeLogPath: 'C:\\runtime\\ReShade.log',
  });
  const diagnostic = Object.freeze({
    schemaVersion: 1,
    source: 'electron-game-overlay',
    severity: 'error',
    stage: 'injector',
    code: 'injector-failed',
    retrySafety: 'definite-safe',
    message: 'injector exited with code 1',
    targetLabel: 'process:game.exe:pid:42',
  });

  for (const event of [
    { type: 'runtime-staged', runDirectory: 'C:\\runtime' },
    {
      type: 'target-rendezvous-authorized',
      targetLabel: 'process:game.exe:pid:42',
      pid: 42,
      discoveryPath: 'C:\\runtime\\overlay-transport.json',
    },
    { type: 'injector-started', invocation },
    { type: 'injector-watcher-ready', invocation },
    { type: 'injector-returned', result },
    {
      type: 'target-connected',
      targetLabel: 'process:game.exe:pid:42',
      pid: 42,
      path: 'C:\\games\\game.exe',
    },
    {
      type: 'target-disconnected',
      targetLabel: 'process:game.exe:pid:42',
      pid: 42,
      path: 'C:\\games\\game.exe',
    },
    { type: 'injector-failed', diagnostic },
  ]) {
    logReShadeLauncherEvent(event, logger);
  }

  assert.deepEqual(logs, [
    'RESHADE_CLIENT_RUNTIME_STAGED directory="C:\\\\runtime"',
    'RESHADE_CLIENT_TARGET_RENDEZVOUS_AUTHORIZED pid=42 path="C:\\\\runtime\\\\overlay-transport.json"',
    'RESHADE_CLIENT_INJECTOR_STARTED target="game.exe" arguments=["game.exe","--pid","42"]',
    'RESHADE_CLIENT_INJECTOR_WATCHER_READY target="game.exe" arguments=["game.exe","--pid","42"]',
    'RESHADE_CLIENT_INJECTOR_RETURNED target="game.exe"',
    'RESHADE_CLIENT_TARGET_CONNECTED pid=42',
    'RESHADE_CLIENT_TARGET_DISCONNECTED pid=42',
  ]);
  assert.deepEqual(errors, [
    'RESHADE_CLIENT_INJECTOR_FAILED target="process:game.exe:pid:42" detail="injector exited with code 1"',
  ]);
});

test('path-target logging retains the readable target description', () => {
  const logs = [];

  logReShadeLauncherEvent(
    {
      type: 'injector-started',
      invocation: Object.freeze({
        executable: 'C:\\runtime\\inject.exe',
        arguments: Object.freeze([
          '--path-contains',
          '\\steamapps\\',
          '--exclude-name',
          'helper.exe',
          '--exclude-name',
          'crash.exe',
        ]),
        targetLabel: 'path-contains:\\steamapps\\:exclude:crash.exe,helper.exe',
        workingDirectory: 'C:\\runtime',
      }),
    },
    {
      log: (message) => logs.push(message),
      error: () => assert.fail('no error marker was expected'),
    },
  );

  assert.equal(
    logs[0],
    'RESHADE_CLIENT_INJECTOR_STARTED target="path contains \\\\steamapps\\\\ excluding helper.exe, crash.exe" arguments=["--path-contains","\\\\steamapps\\\\","--exclude-name","helper.exe","--exclude-name","crash.exe"]',
  );
});
