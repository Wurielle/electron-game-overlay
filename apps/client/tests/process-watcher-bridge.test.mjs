import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(testDirectory, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');
const processWatcherEntry = path.join(
  clientRoot,
  'process-watcher',
  'index.cjs',
);
const injectorPath = path.join(
  repoRoot,
  'libs',
  'electron-game-overlay-runtime',
  'dist',
  'win32-x64',
  'inject.exe',
);
const mockWmiModulePath = path.join(
  testDirectory,
  'fixtures',
  'mock-wql-process-monitor.mjs',
);
const { createNativeLineFramer, parseNativeProcessEventLine } = require(
  processWatcherEntry,
);

test('native observer records are strictly framed and parsed', () => {
  const lines = [];
  let overflowCount = 0;
  const framer = createNativeLineFramer(
    (line) => lines.push(line),
    () => {
      overflowCount += 1;
    },
  );

  framer.push('EGO_PROCESS_OBSERVER_');
  assert.deepEqual(lines, []);
  framer.push(
    'READY\r\nEGO_PROCESS_CREATE\t42\tD:\\SteamLibrary\\steamapps\\common\\Tést 観測\\遊戲.exe\n',
  );
  framer.push(
    'EGO_PROCESS_DELETE\t42\tD:\\SteamLibrary\\steamapps\\common\\Tést 観測\\遊戲.exe\r',
  );
  assert.equal(lines.length, 2, 'an unterminated record must remain buffered');
  framer.push('\n');
  assert.deepEqual(lines, [
    'EGO_PROCESS_OBSERVER_READY',
    'EGO_PROCESS_CREATE\t42\tD:\\SteamLibrary\\steamapps\\common\\Tést 観測\\遊戲.exe',
    'EGO_PROCESS_DELETE\t42\tD:\\SteamLibrary\\steamapps\\common\\Tést 観測\\遊戲.exe',
  ]);
  assert.equal(overflowCount, 0);

  assert.deepEqual(parseNativeProcessEventLine(lines[1]), {
    type: 'process-creation',
    payload: {
      process: '遊戲.exe',
      pid: 42,
      filepath: 'D:\\SteamLibrary\\steamapps\\common\\Tést 観測\\遊戲.exe',
      user: '',
    },
  });
  assert.deepEqual(parseNativeProcessEventLine(lines[2]), {
    type: 'process-deletion',
    payload: {
      process: '遊戲.exe',
      pid: 42,
      filepath: 'D:\\SteamLibrary\\steamapps\\common\\Tést 観測\\遊戲.exe',
      user: '',
    },
  });

  for (const malformed of [
    'EGO_PROCESS_CREATE\t0\tD:\\SteamLibrary\\steamapps\\zero.exe',
    'EGO_PROCESS_CREATE\t4294967296\tD:\\SteamLibrary\\steamapps\\large.exe',
    'EGO_PROCESS_CREATE\t42\trelative\\game.exe',
    'EGO_PROCESS_CREATE\t42\t',
    'EGO_PROCESS_CREATE\t42\tD:\\SteamLibrary\\steamapps\\game.exe\nextra',
    'EGO_PROCESS_UNKNOWN\t42\tD:\\SteamLibrary\\steamapps\\game.exe',
    'EGO_PROCESS_OBSERVER_READY',
  ]) {
    assert.equal(
      parseNativeProcessEventLine(malformed),
      null,
      `malformed record was accepted: ${JSON.stringify(malformed)}`,
    );
  }

  const overflowLines = [];
  const boundedFramer = createNativeLineFramer(
    (line) => overflowLines.push(line),
    () => {
      overflowCount += 1;
    },
    8,
  );
  boundedFramer.push('123456789');
  boundedFramer.push('ok\n');
  assert.equal(overflowCount, 1);
  assert.deepEqual(overflowLines, ['ok']);
  assert.throws(
    () => boundedFramer.push(Buffer.from('bytes')),
    /chunks must be strings/,
  );
});

test(
  'the executable production bridge forwards native ready/create/delete records and shuts down',
  {
    skip:
      process.platform !== 'win32'
        ? 'the production observer is Windows-only'
        : !existsSync(injectorPath)
          ? `build the runtime injector first: ${injectorPath}`
          : false,
  },
  async () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), 'ego-process-watcher-bridge-'),
    );
    const fixtureDirectory = path.join(
      fixtureRoot,
      'steamapps',
      'common',
      'Tést 観測',
    );
    const fixturePath = path.join(fixtureDirectory, '遊戲.exe');
    mkdirSync(fixtureDirectory, { recursive: true });
    copyFileSync(
      path.join(process.env.WINDIR, 'System32', 'ping.exe'),
      fixturePath,
    );

    const watcher = forkProductionWatcher(injectorPath);
    let fixture = null;
    try {
      await watcher.waitForMessage(
        (message) => message?.type === 'process-watcher-ready',
        'the production bridge did not forward the native ready record',
      );

      const creation = watcher.waitForMessage(
        (message) =>
          message?.type === 'process-creation' &&
          message.payload?.pid === fixture?.pid,
        'the production bridge did not forward the native creation record',
      );
      fixture = spawn(fixturePath, ['127.0.0.1', '-n', '30'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await waitForSpawn(fixture);
      const fixturePid = fixture.pid;
      const creationMessage = await creation;
      assert.equal(creationMessage.payload.process, path.basename(fixturePath));
      assert.equal(
        path.resolve(creationMessage.payload.filepath).toLowerCase(),
        path.resolve(fixturePath).toLowerCase(),
      );

      const deletion = watcher.waitForMessage(
        (message) =>
          message?.type === 'process-deletion' &&
          message.payload?.pid === fixturePid,
        'the production bridge did not forward the native deletion record',
      );
      await stopChild(fixture);
      fixture = null;
      const deletionMessage = await deletion;
      assert.equal(
        path.resolve(deletionMessage.payload.filepath).toLowerCase(),
        path.resolve(fixturePath).toLowerCase(),
      );

      const [code, signal] = await watcher.stop();
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      if (fixture) {
        await stopChild(fixture).catch(() => undefined);
      }
      await watcher.stop().catch(() => undefined);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test(
  'a native observer startup failure triggers the WMI fallback before clean shutdown',
  { skip: process.platform !== 'win32' },
  async () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), 'ego-process-watcher-fallback-'),
    );
    const missingObserver = path.join(fixtureRoot, 'missing-inject.exe');
    const watcher = forkProductionWatcher(missingObserver, {
      wmiModulePath: mockWmiModulePath,
    });
    try {
      await watcher.waitForStderr(
        '[process-watcher] Native observer failed; starting WMI fallback:',
        'the production bridge did not trigger its WMI fallback',
      );
      await watcher.waitForMessage(
        (message) => message?.type === 'process-watcher-ready',
        'the production bridge did not become ready through its WMI fallback',
      );
      const [code, signal] = await watcher.stop();
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      await watcher.stop().catch(() => undefined);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);

function forkProductionWatcher(observerPath, { wmiModulePath } = {}) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_TEST_CONTEXT;
  if (wmiModulePath) {
    environment.NODE_ENV = 'test';
    environment.EGO_PROCESS_WATCHER_TEST_WMI_MODULE = wmiModulePath;
  } else {
    delete environment.EGO_PROCESS_WATCHER_TEST_WMI_MODULE;
  }
  const child = fork(processWatcherEntry, [observerPath], {
    env: environment,
    execArgv: [],
    execPath: process.execPath,
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stdout = '';
  let stderr = '';
  let stopPromise = null;
  child.on('message', (message) => messages.push(message));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    waitForMessage(predicate, failureMessage) {
      return waitForCondition(
        () => messages.find(predicate),
        failureMessage,
      ).catch((error) => {
        throw new Error(
          `${error.message}; exit=${child.exitCode ?? 'running'}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
        );
      });
    },
    waitForStderr(fragment, failureMessage) {
      return waitForCondition(() => stderr.includes(fragment), failureMessage);
    },
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve([child.exitCode, child.signalCode]);
      }
      const exit = waitForEmitter(
        child,
        'exit',
        () => true,
        'the production process-watcher bridge did not exit',
        5_000,
      );
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }, 2_500);
      if (child.connected) {
        child.disconnect();
      } else {
        child.kill();
      }
      stopPromise = exit.finally(() => clearTimeout(forceKillTimer));
      return stopPromise;
    },
  };
}

function waitForSpawn(child) {
  if (child.pid) {
    return Promise.resolve();
  }
  return waitForEmitter(
    child,
    'spawn',
    () => true,
    'the observer fixture process did not spawn',
  ).then(() => undefined);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exit = waitForEmitter(
    child,
    'exit',
    () => true,
    `process ${child.pid ?? 'unknown'} did not exit`,
    5_000,
  );
  child.kill();
  await exit;
}

function waitForEmitter(
  emitter,
  eventName,
  predicate,
  failureMessage,
  timeoutMilliseconds = 10_000,
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(failureMessage));
    }, timeoutMilliseconds);
    const onEvent = (...args) => {
      const value = args.length === 1 ? args[0] : args;
      if (!predicate(value)) {
        return;
      }
      cleanup();
      resolve(value);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(eventName, onEvent);
      emitter.off('error', onError);
    };
    emitter.on(eventName, onEvent);
    emitter.on('error', onError);
  });
}

function waitForCondition(
  condition,
  failureMessage,
  timeoutMilliseconds = 10_000,
) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMilliseconds;
    const timer = setInterval(() => {
      let value;
      try {
        value = condition();
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(failureMessage));
      }
    }, 10);
  });
}
