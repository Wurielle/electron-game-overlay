'use strict';
// Opt-in genuine Electron paint acceptance; not part of Node unit-test globs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const reportPath = path.resolve(
  process.argv[2] || 'real-electron-control-panel.json',
);
const report = {
  passed: false,
  stage: 'setup',
  platform: process.platform,
  command: [process.execPath, ...process.argv.slice(1)],
  boundaries: {
    real: [
      'production HTML',
      'production window factory',
      'Electron offscreen paint NativeImage bitmap',
      'renderer state IPC',
    ],
    controlled: [
      'SDK attachment metadata boundary',
      'trusted local IPC state provider',
    ],
    excluded: [
      'native caption dragging',
      'Windows native hit testing',
      'game injection',
      'broker transport',
    ],
  },
};
function save() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
save();
let child;
let profile;
(async () => {
  try {
    const electron = require('electron');
    profile = fs.mkdtempSync(
      path.join(process.env.TMPDIR || os.tmpdir(), 'ego-control-ui-'),
    );
    const env = { ...process.env, EGO_CONTROL_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    report.stage = 'electron';
    child = fork(
      path.join(__dirname, 'helpers/real-electron-control-panel-child.cjs'),
      [],
      {
        execPath: electron,
        execArgv: [
          '--disable-gpu',
          ...(process.platform === 'linux'
            ? ['--no-sandbox', '--ozone-platform=headless']
            : []),
        ],
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    report.stderr = '';
    child.stderr.on('data', (data) => {
      report.stderr = (report.stderr + data).slice(-12000);
    });
    child.stdout.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Electron acceptance exceeded 35s deadline'));
      }, 35000);
      child.on('message', (message) => {
        report.result = message;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        report.exit = { code, signal };
        code === 0 && report.result?.passed
          ? resolve()
          : reject(
              new Error(
                report.result?.error || `Electron exited ${code}/${signal}`,
              ),
            );
      });
    });
    report.passed = true;
    report.stage = 'completed';
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGKILL');
      });
    }
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
    save();
    console.log(
      JSON.stringify({
        passed: report.passed,
        samples: report.result?.samples?.length,
        reportPath,
        error: report.error,
      }),
    );
  }
})();
