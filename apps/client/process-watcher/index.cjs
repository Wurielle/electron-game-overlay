const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

let closeEventSink = null;
let keepAliveTimer = null;
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

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  if (closeEventSink) {
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      timer.unref();
    });
    try {
      await Promise.race([closeEventSink(), timeout]);
    } catch (error) {
      console.error(
        '[process-watcher] Failed to close the WMI event sink',
        error,
      );
    }
  }
  process.exit(exitCode);
}

process.once('disconnect', () => {
  void shutdown(0);
});
process.once('SIGINT', () => {
  void shutdown(0);
});
process.once('SIGTERM', () => {
  void shutdown(0);
});

void import('wql-process-monitor')
  .then(async (wql) => {
    closeEventSink = wql.closeEventSink;
    const monitor = await wql.subscribe({
      creation: true,
      deletion: true,
    });

    monitor.on('creation', (info) => {
      void send({
        type: 'process-creation',
        payload: normalizeProcessInfo(info),
      });
    });
    monitor.on('deletion', (info) => {
      void send({
        type: 'process-deletion',
        payload: normalizeProcessInfo(info),
      });
    });

    keepAliveTimer = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
    void send({ type: 'process-watcher-ready' });
  })
  .catch(async (error) => {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    console.error('[process-watcher] Startup failed', error);
    await send({ type: 'process-watcher-error', error: message });
    await shutdown(1);
  });
