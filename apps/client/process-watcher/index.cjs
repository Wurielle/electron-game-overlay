const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STEAM_APPS_PATH_FRAGMENT = '\\steamapps\\';
const NATIVE_READY_LINE = 'EGO_PROCESS_OBSERVER_READY';
const NATIVE_CREATION_PREFIX = 'EGO_PROCESS_CREATE\t';
const NATIVE_DELETION_PREFIX = 'EGO_PROCESS_DELETE\t';
const NATIVE_READY_TIMEOUT_MS = 5_000;
const MAX_NATIVE_OUTPUT_BUFFER = 64 * 1024;

let closeEventSink = null;
let keepAliveTimer = null;
let nativeObserver = null;
let nativeObserverReady = false;
let nativeObserverState = 'starting';
let nativeReadyTimer = null;
let wmiReady = false;
let wmiStartup = null;
let nativeFailureDetail = null;
let readySent = false;
let failureSent = false;
let shuttingDown = false;

function send(message) {
  if (!process.connected || typeof process.send !== 'function') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      process.send(message, (error) => resolve(!error));
    } catch {
      // The parent is already gone; the disconnect handler performs cleanup.
      resolve(false);
    }
  });
}

function normalizeProcessInfo([processName, pid, filepath, user]) {
  return {
    process: typeof processName === 'string' ? processName : '',
    pid: Number(pid),
    filepath: typeof filepath === 'string' ? filepath : '',
    user: typeof user === 'string' ? user : '',
  };
}

function getErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function reportFailure(error) {
  if (failureSent || shuttingDown) {
    return;
  }
  failureSent = true;
  const message = getErrorMessage(error);
  console.error('[process-watcher] Startup/runtime failure', message);
  void send({ type: 'process-watcher-error', error: message }).then(() =>
    shutdown(1),
  );
}

function publishReadyIfComplete() {
  if (readySent || failureSent || (!nativeObserverReady && !wmiReady)) {
    return;
  }
  readySent = true;
  void send({ type: 'process-watcher-ready' });
}

function parseNativeProcessEvent(line, prefix, type) {
  if (!line.startsWith(prefix)) {
    return null;
  }
  const match = /^([1-9][0-9]*)\t([^\r\n]+)$/.exec(line.slice(prefix.length));
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  const filepath = match[2];
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    pid > 0xffffffff ||
    !path.win32.isAbsolute(filepath)
  ) {
    return null;
  }
  return {
    type,
    payload: {
      process: path.win32.basename(filepath),
      pid,
      filepath,
      user: '',
    },
  };
}

function parseNativeProcessEventLine(line) {
  return (
    parseNativeProcessEvent(line, NATIVE_CREATION_PREFIX, 'process-creation') ??
    parseNativeProcessEvent(line, NATIVE_DELETION_PREFIX, 'process-deletion')
  );
}

function createNativeLineFramer(
  onLine,
  onOverflow,
  maxBufferLength = MAX_NATIVE_OUTPUT_BUFFER,
) {
  let buffer = '';
  return Object.freeze({
    push(chunk) {
      if (typeof chunk !== 'string') {
        throw new TypeError('native observer output chunks must be strings');
      }
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        onLine(line);
      }
      if (buffer.length > maxBufferLength) {
        buffer = '';
        onOverflow();
      }
    },
  });
}

function loadWmiModule() {
  const testModulePath =
    process.env.NODE_ENV === 'test'
      ? process.env.EGO_PROCESS_WATCHER_TEST_WMI_MODULE
      : undefined;
  if (testModulePath) {
    if (!path.isAbsolute(testModulePath)) {
      return Promise.reject(
        new Error('the test WMI module path must be absolute'),
      );
    }
    return import(pathToFileURL(testModulePath).href);
  }
  return import('wql-process-monitor');
}

function startWmiFallback(nativeError) {
  nativeFailureDetail = getErrorMessage(nativeError);
  if (wmiStartup || shuttingDown) {
    return;
  }
  console.error(
    `[process-watcher] Native observer failed; starting WMI fallback: ${nativeFailureDetail}`,
  );
  wmiStartup = loadWmiModule()
    .then(async (wql) => {
      closeEventSink = wql.closeEventSink;
      const monitor = await wql.subscribe({
        creation: true,
        deletion: true,
      });
      if (shuttingDown) {
        await closeEventSink();
        closeEventSink = null;
        return;
      }

      monitor.on('creation', (info) => {
        if (nativeObserverState === 'failed') {
          void send({
            type: 'process-creation',
            payload: normalizeProcessInfo(info),
          });
        }
      });
      monitor.on('deletion', (info) => {
        if (nativeObserverState === 'failed') {
          void send({
            type: 'process-deletion',
            payload: normalizeProcessInfo(info),
          });
        }
      });

      wmiReady = true;
      publishReadyIfComplete();
    })
    .catch((error) => {
      reportFailure(
        new Error(
          `native observer failed (${nativeFailureDetail}); WMI fallback failed (${getErrorMessage(error)})`,
        ),
      );
    });
}

function failNativeObserver(error, child = nativeObserver) {
  if (nativeObserverState === 'failed' || shuttingDown) {
    return;
  }
  nativeObserverState = 'failed';
  nativeObserverReady = false;
  if (nativeReadyTimer) {
    clearTimeout(nativeReadyTimer);
    nativeReadyTimer = null;
  }
  if (child && nativeObserver === child) {
    nativeObserver = null;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  startWmiFallback(error);
}

function handleNativeLine(line, child) {
  if (line === NATIVE_READY_LINE) {
    if (nativeObserver === child && nativeObserverState === 'starting') {
      nativeObserverState = 'running';
      nativeObserverReady = true;
      if (nativeReadyTimer) {
        clearTimeout(nativeReadyTimer);
        nativeReadyTimer = null;
      }
      publishReadyIfComplete();
    }
    return;
  }

  const event = parseNativeProcessEventLine(line);
  if (event && nativeObserver === child && nativeObserverState === 'running') {
    void send(event);
    return;
  }

  if (line.length > 0) {
    failNativeObserver(
      new Error(`malformed native observer line: ${JSON.stringify(line)}`),
      child,
    );
  }
}

function startNativeObserver(injectorPath) {
  if (
    typeof injectorPath !== 'string' ||
    !path.win32.isAbsolute(injectorPath)
  ) {
    throw new Error('the native process observer path must be absolute');
  }

  const child = spawn(
    injectorPath,
    [
      '--observe-path-contains',
      STEAM_APPS_PATH_FRAGMENT,
      '--parent-pid',
      String(process.pid),
    ],
    {
      cwd: path.win32.dirname(injectorPath),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  nativeObserver = child;
  nativeObserverState = 'starting';
  nativeReadyTimer = setTimeout(() => {
    failNativeObserver(
      new Error('native process observer did not publish its ready handshake'),
      child,
    );
  }, NATIVE_READY_TIMEOUT_MS);
  nativeReadyTimer.unref();

  const stdoutFramer = createNativeLineFramer(
    (line) => handleNativeLine(line, child),
    () =>
      failNativeObserver(
        new Error('native process observer output exceeded its line limit'),
        child,
      ),
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutFramer.push(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    console.error(`[process-watcher:native] ${chunk.trimEnd()}`);
  });
  child.once('error', (error) => {
    failNativeObserver(error, child);
  });
  child.once('exit', (code, signal) => {
    if (nativeObserver === child) {
      nativeObserver = null;
    }
    if (!shuttingDown && nativeObserverState !== 'failed') {
      failNativeObserver(
        `native process observer exited unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'})`,
        child,
      );
    }
  });
}

function stopNativeObserver() {
  const child = nativeObserver;
  nativeObserver = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  const nativeStop = stopNativeObserver();
  const wmiStop = (async () => {
    if (closeEventSink) {
      try {
        await closeEventSink();
      } catch (error) {
        console.error(
          '[process-watcher] Failed to close the WMI event sink',
          error,
        );
      }
    }
  })();
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
  await Promise.race([Promise.all([nativeStop, wmiStop]), timeout]);
  process.exit(exitCode);
}

function main() {
  process.once('disconnect', () => {
    void shutdown(0);
  });
  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });

  keepAliveTimer = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);

  try {
    startNativeObserver(process.argv[2]);
  } catch (error) {
    failNativeObserver(error, null);
  }
}

if (require.main === module) {
  main();
}

module.exports = Object.freeze({
  createNativeLineFramer,
  parseNativeProcessEventLine,
});
