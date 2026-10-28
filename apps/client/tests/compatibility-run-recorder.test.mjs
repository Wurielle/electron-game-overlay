import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CompatibilityRunRecorder,
  resolveCompatibilityRunsRoot,
} from '../src/main/electron/compatibility-run-recorder.ts';

test('multiline injector stdout saves OpenProcess and LoadLibrary failures, not commands', () => {
  const command =
    'Command failed: C:\\Users\\PrivatePerson\\inject.exe --token=privateSecret\r\n';
  assertSavedError(
    command +
      'Failed to open target application process!\r\nReShade injection not started.',
    'Injector could not open target application process (OpenProcess)',
  );
  assertSavedError(
    command +
      "Failed to execute 'LoadLibrary' in target application!\r\nReShade injection not started.",
    'Injector could not execute LoadLibrary in target application',
  );
  assertSavedError(
    command + 'x'.repeat(4096) + 'Failed to open target application process!',
    'Error details omitted',
  );
  assertSavedError(
    'unknown privateSecret cause: C:\\Users\\PrivatePerson',
    'Error details omitted',
  );
  assertSavedError(
    'loaded-module inspection failed with Windows error 4294967296',
    'loaded-module inspection failed',
  );
});

test('missing executable saves an allowlisted errno without its spawn path', () => {
  assertSavedError(
    'spawn C:\\Users\\PrivatePerson\\node.exe ENOENT',
    'Executable not found (ENOENT)',
  );
});

test('broker startup failures without diagnostics save fixed actionable categories', () => {
  assertSavedError(
    'No validated standalone overlay broker could be started',
    'No validated standalone overlay broker could be started',
  );
  assertSavedError(
    'Unable to prove medium Windows integrity; trusted OS probe failed; shared overlay broker launch is unsupported',
    'Shared overlay broker Windows integrity proof failed',
  );
  assertSavedError(
    'Shared overlay broker requires proven medium Windows integrity; elevated or unknown-integrity launch is unsupported',
    'Shared overlay broker requires medium Windows integrity',
  );
});

function assertSavedError(error, expected) {
  withTemporaryDirectory((directory) => {
    const recorder = createRecorder(directory, 'compatibility-known-error');
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        {
          ...autoTarget(28, 'Game.exe', 'failed'),
          error:
            error + '\r\nstack: C:\\Users\\PrivatePerson token=privateSecret',
        },
      ]),
    );
    recorder.close();
    const event = readEvents(recorder.eventsPath).find(
      (entry) => entry.type === 'target.attachment-state',
    );
    assert.equal(event.data.diagnostic, null);
    assert.equal(event.data.errorPresent, true);
    assert.equal(event.data.errorMessage, expected);
    const saved =
      readFileSync(recorder.eventsPath, 'utf8') +
      readFileSync(recorder.summaryPath, 'utf8');
    for (const forbidden of [
      'PrivatePerson',
      'privateSecret',
      'Command failed:',
      'stack:',
      'cause:',
    ])
      assert.equal(saved.includes(forbidden), false, forbidden);
    assert.ok(expected.length <= 240);
  });
}

test('ordinary auto-attach errors without diagnostics remain actionable in saved JSONL', () => {
  withTemporaryDirectory((fixtureDir) => {
    const recorder = createRecorder(fixtureDir, 'compatibility-ordinary-error');
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        {
          ...autoTarget(28, 'GunFrog.exe', 'failed'),
          error: new Error(
            'loaded-module inspection failed for target pid=28 with Windows error 299',
          ).message,
        },
      ]),
    );
    recorder.close();
    const event = readEvents(recorder.eventsPath).find(
      (entry) => entry.type === 'target.attachment-state',
    );
    assert.equal(event.data.errorPresent, true);
    assert.equal(event.data.diagnostic, null);
    assert.equal(
      event.data.errorMessage,
      'loaded-module inspection failed with Windows error 299',
    );
    assert.equal(event.schemaVersion, 1);
    assert.equal(readSummary(recorder.summaryPath).totals.everFailed, 1);
  });
});

test('watcher and manual errors save only bounded privacy-safe summaries', () => {
  withTemporaryDirectory((fixtureDir) => {
    const recorder = createRecorder(fixtureDir, 'compatibility-private-errors');
    const unsafe =
      'Access denied C:\\Users\\PersonalName\\secret.exe /home/PersonalName/private \\\\server\\PersonalName token=superSecret password="hidden credential" Bearer abc.def.ghi --env=PRIVATE_VALUE';
    recorder.recordAutoAttachState({
      watcherStatus: 'failed',
      watcherError: unsafe,
      targets: [],
    });
    for (const error of [
      unsafe,
      'loaded-module inspection failed with Windows error 299\r\nstack: /Users/PersonalName/secret token=superSecret',
      '{"token":"superSecret"}',
      '\u0000' + 'x'.repeat(100_000),
      null,
    ]) {
      recorder.recordAttachmentState(
        {
          phase: 'idle',
          processName: null,
          pid: null,
          error,
          diagnostic: null,
        },
        'attach-failed',
      );
    }
    recorder.close();
    const events = readEvents(recorder.eventsPath);
    assert.equal(
      events.find((event) => event.type === 'watcher.status').data.errorMessage,
      'Access denied',
    );
    const messages = events
      .filter((event) => event.type === 'attachment.state')
      .map((event) => event.data.errorMessage);
    assert.deepEqual(messages, [
      'Access denied',
      'loaded-module inspection failed with Windows error 299',
      'Error details omitted',
      'Error details omitted',
      null,
    ]);
    assert.ok(
      messages.every(
        (message) =>
          message === null ||
          (message.length <= 240 &&
            !/[\x00-\x1f\x7f\u2028\u2029]/.test(message)),
      ),
    );
    const saved =
      readFileSync(recorder.eventsPath, 'utf8') +
      readFileSync(recorder.summaryPath, 'utf8');
    for (const secret of [
      'PersonalName',
      'superSecret',
      'hidden credential',
      'abc.def.ghi',
      'PRIVATE_VALUE',
      'stack:',
    ])
      assert.equal(saved.includes(secret), false, secret);
    assert.equal(readSummary(recorder.summaryPath).watcher.failed, true);
  });
});

test('sanitized error changes drive bounded watcher and target transitions', () => {
  withTemporaryDirectory((fixtureDir) => {
    const recorder = createRecorder(fixtureDir, 'compatibility-error-changes');
    const snapshot = (code, privateText) => ({
      watcherStatus: 'failed',
      watcherError: `loaded-module inspection failed with Windows error ${code} ${privateText}`,
      targets: [
        {
          ...autoTarget(28, 'GunFrog.exe', 'failed'),
          error: `loaded-module inspection failed with Windows error ${code} ${privateText}`,
        },
      ],
    });
    recorder.recordAutoAttachState(snapshot(299, '/home/first/token=one'));
    for (let index = 0; index < 100; index += 1)
      recorder.recordAutoAttachState(snapshot(299, `/home/private-${index}`));
    recorder.recordAutoAttachState(snapshot(5, 'C:\\Users\\Second'));
    recorder.close();
    const events = readEvents(recorder.eventsPath);
    for (const type of ['watcher.status', 'target.attachment-state']) {
      assert.deepEqual(
        events
          .filter((event) => event.type === type)
          .map((event) => event.data.errorMessage),
        [
          'loaded-module inspection failed with Windows error 299',
          'loaded-module inspection failed with Windows error 5',
        ],
      );
    }
    assert.ok(
      [...recorder.autoAttachFingerprints.values()].every(
        (value) => value.length < 512 && !value.includes('/home/'),
      ),
    );
  });
  withTemporaryDirectory((fixtureDir) => {
    const recorder = createRecorder(fixtureDir, 'compatibility-error-flood');
    for (let code = 0; code < 50_010; code += 1)
      recorder.recordAutoAttachState({
        watcherStatus: 'failed',
        watcherError: `loaded-module inspection failed with Windows error ${code}`,
        targets: [],
      });
    recorder.close();
    const events = readEvents(recorder.eventsPath);
    assert.equal(
      events.filter((event) => event.type === 'recorder.truncated').length,
      1,
    );
    assert.equal(events.at(-1).type, 'run.finished');
    assert.ok(events.length <= 50_002);
    assert.ok(
      Buffer.byteLength(readFileSync(recorder.eventsPath)) <=
        10 * 1024 * 1024 + 2048,
    );
    assert.equal(readSummary(recorder.summaryPath).events.truncated, true);
  });
});

test('compatibility evidence keeps concurrent targets and PID reuse isolated', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(rootDirectory, 'compatibility-concurrent');
    const failedDiagnostic = createReShadeDiagnostic({
      code: 'runtime-initialization-timeout',
      stage: 'runtime-initialization',
      pid: 202,
      message: 'private detail\nthat must stay out of evidence',
    });
    const firstSnapshot = autoAttachState('running', [
      autoTarget(101, 'First Game.exe', 'attaching'),
      autoTarget(202, 'Second Game.exe', 'failed', failedDiagnostic),
    ]);

    recorder.recordAutoAttachState(firstSnapshot);
    recorder.recordAutoAttachState(firstSnapshot);
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        autoTarget(101, 'First Game.exe', 'connected'),
        autoTarget(202, 'Second Game.exe', 'failed', failedDiagnostic),
      ]),
    );
    recorder.recordAutoAttachState(autoAttachState('running', []));
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        autoTarget(101, 'First Game.exe', 'attaching'),
      ]),
    );
    recorder.recordAutoAttachState(autoAttachState('running', []));
    recorder.close();
    const eventCountAfterClose = readEvents(recorder.eventsPath).length;
    recorder.recordInputRequested(true);
    recorder.close();

    const events = readEvents(recorder.eventsPath);
    const summary = readSummary(recorder.summaryPath);
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index + 1),
    );
    assert.equal(events.at(-1).type, 'run.finished');
    assert.equal(
      events.filter((event) => event.type === 'target.attachment-state').length,
      4,
      'an identical full-state snapshot must not create duplicate transitions',
    );
    assert.equal(readEvents(recorder.eventsPath).length, eventCountAfterClose);
    assert.equal(summary.recorderClosedOrderly, true);
    assert.deepEqual(summary.totals, {
      targetLifetimes: 3,
      connected: 1,
      surfacesObserved: 0,
      scenesRendered: 0,
      everFailed: 1,
      recovered: 0,
      released: 3,
      incomplete: 0,
    });
    assert.deepEqual(
      summary.targets.map((target) => [target.pid, target.targetId]),
      [
        [101, 'target-0001'],
        [202, 'target-0002'],
        [101, 'target-0003'],
      ],
    );
    assert.equal(
      readFileSync(recorder.eventsPath, 'utf8').includes('private detail'),
      false,
    );
  });
});

test('failure followed by an authenticated transport is one recovered lifetime', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(rootDirectory, 'compatibility-recovery');
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        autoTarget(
          301,
          'Recovery Game.exe',
          'failed',
          createReShadeDiagnostic({
            code: 'runtime-initialization-timeout',
            stage: 'runtime-initialization',
            pid: 301,
          }),
        ),
        autoTarget(
          302,
          'Other Game.exe',
          'failed',
          createReShadeDiagnostic({
            code: 'injector-failed',
            stage: 'injector',
            pid: 302,
          }),
        ),
      ]),
    );
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        autoTarget(301, 'Recovery Game.exe', 'attaching'),
        autoTarget(
          302,
          'Other Game.exe',
          'failed',
          createReShadeDiagnostic({
            code: 'injector-failed',
            stage: 'injector',
            pid: 302,
          }),
        ),
      ]),
    );
    recorder.recordNativeEvent('game.process', {
      pid: 301,
      path: 'D:\\SteamLibrary\\steamapps\\common\\Recovery\\Recovery Game.exe',
    });
    recorder.recordAutoAttachState(autoAttachState('running', []));
    recorder.close();

    const summary = readSummary(recorder.summaryPath);
    const recoveryTarget = summary.targets.find((target) => target.pid === 301);
    const otherTarget = summary.targets.find((target) => target.pid === 302);
    assert.equal(recoveryTarget.recoveredAfterFailure, true);
    assert.equal(recoveryTarget.connectionCount, 1);
    assert.equal(otherTarget.recoveredAfterFailure, false);
    assert.equal(summary.totals.targetLifetimes, 2);
    assert.equal(summary.totals.recovered, 1);
    assert.equal(summary.verdict.automated, 'inconclusive');
    assert.equal(summary.verdict.manual, 'not-recorded');
  });
});

test('launcher, surface, FPS, diagnostic, and input evidence is structured and sanitized', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(rootDirectory, 'compatibility-structured');
    recorder.recordLauncherEvent({
      type: 'runtime-staged',
      runDirectory: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\attempt-a',
    });
    recorder.recordLauncherEvent({
      type: 'injector-started',
      invocation: {
        executable: 'C:\\secret\\inject.exe',
        arguments: ['Example.exe', '--pid', '401'],
        targetLabel: 'process:Example.exe:pid:401',
        workingDirectory: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\attempt-a',
      },
    });
    recorder.recordLauncherEvent({
      type: 'injector-watcher-ready',
      invocation: {
        executable: 'C:\\secret\\inject.exe',
        arguments: ['Example.exe'],
        targetLabel: 'process:Example.exe',
        workingDirectory: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\attempt-a',
      },
    });
    recorder.recordLauncherEvent({
      type: 'injector-returned',
      result: {
        processName: 'Example.exe',
        targetExecutablePath:
          'D:\\SteamLibrary\\steamapps\\common\\Example\\Example.exe',
        targetLabel: 'process:Example.exe:pid:401',
        injectorTargetPid: 401,
        runtimeMode: 'injected-runtime',
        runDirectory: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\attempt-a',
        injectorStdoutPath: 'C:\\secret\\stdout.log',
        injectorStderrPath: 'C:\\secret\\stderr.log',
        reshadeLogPath: 'C:\\secret\\ReShade.log',
      },
    });
    recorder.recordTargetSurface(createSurface(401, 'd3d10'));
    assert.equal(
      recorder.getSummary().targets[0].sceneRenderingObserved,
      false,
      'surface telemetry alone is not Electron scene-rendering proof',
    );
    recorder.recordFps({ pid: 401, fps: 60 });
    recorder.recordFps({ pid: 401, fps: 58 });
    recorder.recordInputRequested(true);
    recorder.recordInputEffective(true);
    recorder.recordNativeEvent('game.input.intercept', {
      pid: 401,
      intercepting: true,
      text: 'must not be recorded',
    });
    recorder.recordInputAcknowledged(401, true);
    recorder.recordOverlayDiagnostic({
      schemaVersion: 1,
      source: 'electron-game-overlay-runtime',
      severity: 'info',
      code: 'runtime-scene-rendering-started',
      message: 'rendering C:\\private\\scene',
      pid: 401,
      context: { path: 'C:\\private\\scene' },
    });
    recorder.close();

    const evidence = readFileSync(recorder.eventsPath, 'utf8');
    assert.equal(evidence.includes('C:\\\\Users'), false);
    assert.equal(evidence.includes('C:\\\\secret'), false);
    assert.equal(evidence.includes('must not be recorded'), false);
    assert.equal(evidence.includes('C:\\\\private'), false);
    const events = readEvents(recorder.eventsPath);
    assert.equal(
      events.find((event) => event.type === 'attachment.runtime-staged').data
        .attemptId,
      'attempt-0001',
    );
    assert.deepEqual(
      events.find((event) => event.type === 'attachment.injector-watcher-ready')
        .data,
      {
        attemptId: 'attempt-0001',
        targetLabel: 'Example.exe',
        strategy: 'name',
      },
    );
    const summary = readSummary(recorder.summaryPath);
    const target = summary.targets[0];
    assert.equal(target.processName, 'Example.exe');
    assert.deepEqual(target.graphicsApis, ['d3d10']);
    assert.deepEqual(target.runtimeModes, ['injected-runtime']);
    assert.deepEqual(target.fps, {
      samples: 2,
      minimum: 58,
      maximum: 60,
      mean: 59,
      latest: 58,
    });
    assert.equal(target.surfaceObserved, true);
    assert.equal(target.sceneRenderingObserved, true);
    assert.equal(target.input.interceptAcknowledgements, 1);
    assert.equal(target.diagnosticCounts['runtime-scene-rendering-started'], 1);
  });
});

test('a losing injector attempt cannot mark a connected target failed', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(rootDirectory, 'compatibility-loser');
    recorder.recordAutoAttachState(
      autoAttachState('running', [
        autoTarget(501, 'Winning Game.exe', 'connected'),
      ]),
    );
    recorder.recordLauncherEvent({
      type: 'injector-failed',
      diagnostic: createReShadeDiagnostic({
        code: 'target-injection-already-claimed',
        stage: 'injector',
        pid: 501,
        retrySafety: 'definite-safe',
      }),
    });
    recorder.close();

    const summary = readSummary(recorder.summaryPath);
    assert.equal(summary.targets[0].attachmentPhase, 'connected');
    assert.equal(summary.targets[0].failureCount, 0);
    assert.equal(summary.targets[0].recoveredAfterFailure, false);
    assert.equal(
      summary.events.diagnosticCounts['target-injection-already-claimed'],
      1,
    );
  });
});

test('a process-name-only manual failure uses the diagnostic PID', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(
      rootDirectory,
      'compatibility-manual-failure',
    );
    const diagnostic = createReShadeDiagnostic({
      code: 'runtime-initialization-timeout',
      stage: 'runtime-initialization',
      pid: 551,
    });
    recorder.recordLauncherEvent({ type: 'injector-failed', diagnostic });
    recorder.recordAttachmentState(
      {
        phase: 'idle',
        processName: 'Manual Game.exe',
        pid: null,
        error: 'private failure',
        diagnostic,
      },
      'attach-failed',
    );
    recorder.close();

    const summary = readSummary(recorder.summaryPath);
    assert.equal(summary.targets.length, 1);
    assert.equal(summary.targets[0].pid, 551);
    assert.equal(summary.targets[0].processName, 'Manual Game.exe');
    assert.equal(summary.targets[0].attachmentPhase, 'failed');
    assert.equal(summary.targets[0].failureCount, 1);
    assert.equal(summary.totals.everFailed, 1);
  });
});

test('duplicate terminal sources retain the original target lifetime', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(rootDirectory, 'compatibility-terminal');
    recorder.recordNativeEvent('game.process', {
      pid: 601,
      path: 'D:\\SteamLibrary\\steamapps\\common\\Terminal\\Terminal.exe',
    });
    recorder.recordNativeEvent('game.process.disconnected', { pid: 601 });
    recorder.recordLauncherEvent({
      type: 'target-disconnected',
      targetLabel: 'process:Terminal.exe:pid:601',
      pid: 601,
      path: 'D:\\SteamLibrary\\steamapps\\common\\Terminal\\Terminal.exe',
    });
    recorder.recordAttachmentState(
      {
        phase: 'idle',
        processName: 'Terminal.exe',
        pid: 601,
        error: null,
        diagnostic: null,
      },
      'target-disconnected',
    );
    recorder.close();

    const events = readEvents(recorder.eventsPath).filter(
      (event) => event.pid === 601,
    );
    assert.equal(new Set(events.map((event) => event.targetId)).size, 1);
    assert.equal(readSummary(recorder.summaryPath).totals.targetLifetimes, 1);
  });
});

test('a pre-watcher failure for a reused PID is not assigned to its released lifetime', () => {
  withTemporaryDirectory((rootDirectory) => {
    const recorder = createRecorder(rootDirectory, 'compatibility-pid-reuse');
    recorder.recordNativeEvent('game.process', {
      pid: 651,
      path: 'D:\\SteamLibrary\\steamapps\\common\\Old\\Old.exe',
    });
    recorder.recordNativeEvent('game.process.disconnected', { pid: 651 });
    recorder.recordLauncherEvent({
      type: 'injector-failed',
      diagnostic: createReShadeDiagnostic({
        code: 'injector-failed',
        stage: 'injector',
        pid: 651,
      }),
    });
    recorder.recordAutoAttachState(
      autoAttachState('running', [autoTarget(651, 'New.exe', 'attaching')]),
    );
    recorder.close();

    const events = readEvents(recorder.eventsPath);
    const failure = events.find(
      (event) => event.type === 'attachment.injector-failed',
    );
    assert.equal(failure.pid, 651);
    assert.equal(Object.hasOwn(failure, 'targetId'), false);
    const summary = readSummary(recorder.summaryPath);
    assert.equal(summary.targets.length, 2);
    assert.deepEqual(summary.targets[0].diagnosticCounts, {});
    assert.equal(summary.targets[1].processName, 'New.exe');
  });
});

test('exclusive run files preserve an existing collision and reject relative roots', () => {
  withTemporaryDirectory((rootDirectory) => {
    assert.throws(
      () =>
        new CompatibilityRunRecorder({
          rootDirectory: 'relative-evidence',
          mode: 'manual',
          runId: 'compatibility-relative',
        }),
      /root must be absolute/,
    );

    const eventsPath = path.join(
      rootDirectory,
      'compatibility-collision.events.jsonl',
    );
    const sentinel = 'do not replace\n';
    writeFileSync(eventsPath, sentinel, 'utf8');
    assert.throws(
      () => createRecorder(rootDirectory, 'compatibility-collision'),
      /exist/i,
    );
    assert.equal(readFileSync(eventsPath, 'utf8'), sentinel);

    const summaryPath = path.join(
      rootDirectory,
      'compatibility-summary-collision.summary.json',
    );
    writeFileSync(summaryPath, sentinel, 'utf8');
    assert.throws(
      () => createRecorder(rootDirectory, 'compatibility-summary-collision'),
      /exist/i,
    );
    assert.equal(readFileSync(summaryPath, 'utf8'), sentinel);
    assert.equal(
      existsSync(
        path.join(
          rootDirectory,
          'compatibility-summary-collision.events.jsonl',
        ),
      ),
      false,
      'the recorder must remove only the events file it created before the collision',
    );
  });
});

test('compatibility evidence root overrides must be absolute', () => {
  const fallback = path.join(tmpdir(), 'fallback-compatibility-runs');
  assert.equal(resolveCompatibilityRunsRoot(undefined, fallback), fallback);
  assert.throws(
    () => resolveCompatibilityRunsRoot('relative-runs', fallback),
    /root must be absolute/,
  );
});

test('new runs prune only completed compatibility evidence beyond the count bound', () => {
  withTemporaryDirectory((rootDirectory) => {
    const timestampBase = Date.parse('2026-08-01T11:59:00.000Z');
    for (let index = 0; index < 34; index += 1) {
      const runId = `compatibility-retained-${String(index).padStart(2, '0')}`;
      const summaryPath = path.join(rootDirectory, `${runId}.summary.json`);
      const eventsPath = path.join(rootDirectory, `${runId}.events.jsonl`);
      writeFileSync(
        summaryPath,
        JSON.stringify({
          schemaVersion: 1,
          runId,
          recorderClosedOrderly: true,
        }),
        'utf8',
      );
      writeFileSync(eventsPath, '{}\n', 'utf8');
      const modifiedAt = new Date(timestampBase + index * 1_000);
      utimesSync(summaryPath, modifiedAt, modifiedAt);
      utimesSync(eventsPath, modifiedAt, modifiedAt);
    }

    const recorder = createRecorder(rootDirectory, 'compatibility-retention');
    assert.equal(
      existsSync(
        path.join(rootDirectory, 'compatibility-retained-00.summary.json'),
      ),
      false,
    );
    assert.equal(
      existsSync(
        path.join(rootDirectory, 'compatibility-retained-01.events.jsonl'),
      ),
      false,
    );
    assert.equal(
      existsSync(
        path.join(rootDirectory, 'compatibility-retained-33.summary.json'),
      ),
      true,
    );
    recorder.close();
  });
});

test('a recorder write failure and throwing error callback cannot escape', () => {
  withTemporaryDirectory((rootDirectory) => {
    let errors = 0;
    const recorder = new CompatibilityRunRecorder({
      rootDirectory,
      mode: 'manual',
      runId: 'compatibility-write-failure',
      onError: () => {
        errors += 1;
        throw new Error('observer callback failure');
      },
    });
    closeSync(recorder.descriptor);
    recorder.descriptor = -1;

    assert.doesNotThrow(() => recorder.recordInputRequested(true));
    assert.doesNotThrow(() => recorder.recordInputEffective(true));
    assert.equal(errors, 1);
    assert.doesNotThrow(() => recorder.close());
  });
});

function createRecorder(rootDirectory, runId) {
  let time = Date.parse('2026-08-01T12:00:00.000Z');
  return new CompatibilityRunRecorder({
    rootDirectory,
    mode: 'steam-auto-attach',
    runId,
    clientPid: 999,
    platform: 'win32',
    architecture: 'x64',
    appVersion: '1.0.1',
    electronVersion: '16.0.10',
    now: () => new Date(time++),
  });
}

function autoAttachState(watcherStatus, targets) {
  return {
    watcherStatus,
    watcherError: watcherStatus === 'failed' ? 'private watcher failure' : null,
    targets,
  };
}

function autoTarget(pid, processName, phase, diagnostic = null) {
  return {
    pid,
    processName,
    filepath: `D:\\SteamLibrary\\steamapps\\common\\${processName}\\${processName}`,
    phase,
    error: phase === 'failed' ? 'private attachment failure' : null,
    diagnostic,
  };
}

function createReShadeDiagnostic(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'electron-game-overlay',
    severity: 'error',
    stage: 'runtime-initialization',
    code: 'runtime-initialization-timeout',
    retrySafety: 'indeterminate',
    message: 'private failure detail',
    ...overrides,
  };
}

function createSurface(pid, graphicsApi) {
  return {
    pid,
    surfaceId: 'private-hwnd:swap-chain-1',
    hwnd: '12345',
    revision: 1,
    graphicsApi,
    renderSize: { width: 1920, height: 1080 },
    clientBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    clientScreenBounds: { x: 100, y: 100, width: 1920, height: 1080 },
    windowScreenBounds: { x: 92, y: 69, width: 1936, height: 1119 },
    dpi: { x: 96, y: 96, scaleFactor: 1 },
    monitor: {
      id: 'private-monitor-id',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    },
    focused: true,
    minimized: false,
    visible: true,
    fullscreen: false,
  };
}

function readEvents(eventsPath) {
  const contents = readFileSync(eventsPath, 'utf8');
  assert.equal(contents.endsWith('\n'), true);
  return contents.trimEnd().split('\n').map(JSON.parse);
}

function readSummary(summaryPath) {
  return JSON.parse(readFileSync(summaryPath, 'utf8'));
}

function withTemporaryDirectory(run) {
  const rootDirectory = mkdtempSync(
    path.join(tmpdir(), 'electron-overlay-compatibility-recorder-'),
  );
  try {
    run(rootDirectory);
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true });
  }
}
