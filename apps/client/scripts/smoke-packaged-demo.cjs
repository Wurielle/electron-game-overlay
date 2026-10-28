const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { validateClientAssets, validatePayloads } = require('./package-demo.cjs');

function smoke(output) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Runtime smoke requires Windows x64; no simulated Windows execution');
  if (!output || !path.isAbsolute(output)) throw new Error('--output must identify the absolute packaged directory');
  const reportFile = path.join(output, 'runtime-smoke.json');
  const report = { status: 'failed', scope: 'packaging and genuine Electron import/FFI probe only; NOT demo UI or real-game attachment', brokerStarted: false, gameInjectionAttempted: false, stage: 'validation' };
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  save();
  let work;
  try {
    const app = path.join(output, 'resources/app');
    validateClientAssets(path.join(app, 'dist'));
    validatePayloads(app);
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Packaged symlink: ${file}`);
        if (entry.isDirectory()) walk(file);
      }
    }
    walk(output);
    for (const name of ['electron', 'vite', 'nx', 'typescript', '@nx']) {
      if (fs.existsSync(path.join(app, 'node_modules', name))) throw new Error(`Development dependency shipped: ${name}`);
    }
    for (const name of ['LICENSE', 'LICENSES.chromium.html', 'icudtl.dat', 'resources.pak', 'Start Demo.cmd', 'README.txt']) {
      if (!fs.statSync(path.join(output, name)).size) throw new Error(`Missing support file: ${name}`);
    }
    const original = path.resolve(__dirname, '../../../node_modules/electron/dist/electron.exe');
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash(original) !== hash(path.join(output, 'ElectronGameOverlayDemo.exe'))) throw new Error('Packaged Electron differs from locked installed runtime');
    work = fs.mkdtempSync(path.join(output, '.runtime-probe-'));
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ private: true, main: 'main.cjs' }));
    const resultFile = path.join(work, 'result.json');
    const expectedElectron = require('../../../node_modules/electron/package.json').version;
    fs.writeFileSync(path.join(work, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
app.setPath('userData', ${JSON.stringify(path.join(work, 'user-data'))});
app.whenReady().then(async () => {
  const load = createRequire(${JSON.stringify(path.join(app, 'package.json'))});
  assert.equal(process.versions.electron, ${JSON.stringify(expectedElectron)});
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.match(process.versions.node, /^22\\./);
  assert.ok(Number(process.versions.modules) > 0);
  assert.ok(Number(process.versions.napi) >= 8);
  assert.equal(typeof load('electron-game-overlay').ElectronGameOverlay, 'function');
  assert.equal(typeof load('electron-game-overlay/broker').registerOverlayBrokerInstallation, 'function');
  const koffi = load('koffi');
  const kernel = koffi.load('kernel32.dll');
  const pid = kernel.func('uint32_t __stdcall GetCurrentProcessId()')();
  assert.equal(pid, process.pid);
  const wql = await import(pathToFileURL(load.resolve('wql-process-monitor')).href);
  assert.equal(typeof wql.subscribe, 'function');
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ status: 'passed', versions: process.versions, sdkImported: true, wqlImported: true, koffiWin32FFI: true, ffiPidMatches: true }));
  app.exit(0);
}).catch(error => { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ status: 'failed', error: error.message })); app.exit(1); });
`);
    report.stage = 'genuine-electron-probe'; save();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
    const child = spawnSync(original, [work], { cwd: work, env, timeout: 45000, encoding: 'utf8', windowsHide: true });
    const broker = spawnSync(path.join(app, 'node_modules/electron-game-overlay/dist/broker/win32-x64/electron-game-overlay-broker.exe'), ['--help'], { cwd: work, env: { ...env, PATH: '' }, timeout: 15000, encoding: 'utf8', windowsHide: true });
    if (broker.error || broker.status !== 0 || !/Usage:/.test(broker.stdout || '')) throw new Error('Genuine sealed broker --help probe failed (service was not requested)');
    report.brokerHelpExecuted = true;
    if (fs.existsSync(resultFile)) report.runtime = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (child.error || child.status !== 0 || report.runtime?.status !== 'passed') throw new Error(`Bounded Electron runtime probe failed: ${child.error?.message || `exit ${child.status}`}`);
    report.status = 'passed'; report.stage = 'complete'; save();
    return report;
  } catch (error) { report.error = error.message; save(); throw error; }
  finally { if (work) fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { smoke };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { package: { type: 'string' } } });
    console.log(JSON.stringify(smoke(values.package && path.resolve(values.package)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
