const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { validateClientAssets, validatePayloads } = require('./package-demo.cjs');

function probeWatcher(app, node) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PATH|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|npm_node_execpath|NODE_ENV|EGO_PROCESS_WATCHER_TEST_WMI_MODULE)$/i.test(key)) delete env[key];
  env.PATH = '';
  return new Promise((resolve, reject) => {
    let ready = false, failure;
    const child = require('node:child_process').fork(path.join(app, 'dist/process-watcher/index.cjs'), [path.join(app, 'node_modules/electron-game-overlay/dist/runtime/win32-x64/reshade/inject.exe')], { execPath: node, execArgv: [], env, cwd: app, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let detail = '';
    child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-8192); });
    let timer = setTimeout(() => { failure = 'watcher ready IPC timed out'; child.kill(); }, 20000);
    child.on('message', message => {
      if (message?.type === 'process-watcher-error') { failure = message.error; child.disconnect(); }
      if (message?.type === 'process-watcher-ready' && !ready) {
        ready = true; clearTimeout(timer);
        timer = setTimeout(() => { failure = 'watcher shutdown timed out'; child.kill(); }, 5000);
        child.disconnect();
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!failure && ready && code === 0 && !signal) resolve({ readyIPC: true, exitCode: code, pathEmpty: true });
      else reject(new Error(`${failure || `watcher exited ${code}/${signal} before clean ready/shutdown`}: ${detail}`));
    });
  });
}
function probeRecoveryDiagnostic(app, node, reportFile) {
  const report = { status: 'failed', stage: 'diagnostic-help', platform: process.platform, windowsExecuted: false, brokerStarted: false, gameInjectionAttempted: false };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PATH|NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT|ELECTRON_RUN_AS_NODE|npm_node_execpath|NODE_ENV|EGO_.*)$/i.test(key)) delete env[key];
  env.PATH = '';
  for (const file of [path.join(app, 'scripts/broker-recovery-diagnostic.cjs'), path.join(app, 'scripts/windows-broker-identity.cjs'), path.resolve(app, '../../Start Broker Recovery Diagnostic.cmd')]) {
    let stat;
    try { stat = fs.statSync(file); } catch { throw new Error('Missing packaged recovery diagnostic support file'); }
    if (!stat.isFile() || !stat.size) throw new Error('Missing packaged recovery diagnostic support file');
  }
  const help = spawnSync(node, [path.join(app, 'scripts/broker-recovery-diagnostic.cjs'), '--help'], { cwd: app, env, timeout: 10000, encoding: 'utf8', windowsHide: true });
  if (help.error || help.status !== 0 || !/Usage:/i.test(help.stdout || '')) throw new Error('Packaged recovery diagnostic help failed');
  report.stage = 'owned-pipe-identity-acceptance';
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const identity = spawnSync(node, [path.resolve(__dirname, '../tests/windows-broker-identity.acceptance.cjs')], {
    cwd: app, env: { ...env, EGO_WINDOWS_IDENTITY_ACCEPTANCE: '1', EGO_WINDOWS_IDENTITY_REPORT: reportFile, EGO_WINDOWS_IDENTITY_MODULE: path.join(app, 'scripts/windows-broker-identity.cjs') },
    timeout: 25000, encoding: 'utf8', windowsHide: true,
  });
  if (identity.error || identity.status !== 0) throw new Error('Packaged owned-pipe identity acceptance failed');
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { throw new Error('Packaged identity evidence unavailable'); }
  if (evidence.status !== 'passed' || evidence.platform !== 'win32' || evidence.windowsExecuted !== true) throw new Error('Packaged identity evidence did not pass');
  return { helpExecuted: true, pathEmpty: true, identity: evidence };
}
async function smoke(output) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Runtime smoke requires Windows x64; no simulated Windows execution');
  if (!output || !path.isAbsolute(output)) throw new Error('--output must identify the absolute packaged directory');
  const reportFile = path.join(output, 'runtime-smoke.json');
  const report = { status: 'failed', scope: 'packaging, genuine Electron import/FFI and bundled-Node watcher ready/clean shutdown; NOT demo UI or real-game attachment', brokerStarted: false, gameInjectionAttempted: false, stage: 'validation' };
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
    const profileRoot = path.join(work, 'profile-probe');
    const profileEntry = path.join(profileRoot, 'resources/app/portable-entry.cjs');
    fs.mkdirSync(path.dirname(profileEntry), { recursive: true });
    fs.copyFileSync(path.join(app, 'portable-entry.cjs'), profileEntry);
    const expectedElectron = require('../../../node_modules/electron/package.json').version;
    fs.writeFileSync(path.join(work, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
app.setPath('userData', ${JSON.stringify(path.join(work, 'user-data'))});
// Execute the shipped profile entry with real Electron path APIs, intercepting
// only the UI main import so this acceptance probe never starts a broker.
const Module = require('node:module');
const originalLoad = Module._load;
const originalArgv = process.argv;
let profileMainIntercepted = false;
try {
  process.argv = [...originalArgv, '--manual-test-profile'];
  Module._load = function(id, parent, isMain) {
    if (parent?.filename === ${JSON.stringify(profileEntry)} && id === './dist/main/main.js') {
      profileMainIntercepted = true;
      return {};
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  require(${JSON.stringify(profileEntry)});
} finally {
  Module._load = originalLoad;
  process.argv = originalArgv;
}
assert.equal(profileMainIntercepted, true);
assert.equal(app.getPath('userData'), ${JSON.stringify(path.join(profileRoot, 'profile'))});
assert.equal(app.getPath('sessionData'), ${JSON.stringify(path.join(profileRoot, 'profile'))});
assert.equal(app.getPath('logs'), ${JSON.stringify(path.join(profileRoot, 'logs'))});
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
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ status: 'passed', versions: process.versions, sdkImported: true, wqlImported: true, koffiWin32FFI: true, ffiPidMatches: true, profilePathSetup: true, uiMainIntercepted: true }));
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
    report.stage = 'genuine-packaged-watcher'; save();
    const node = path.join(output, 'resources/node/node.exe');
    if (process.versions.node !== '26.12.1' || hash(node) !== hash(process.execPath)) throw new Error('Bundled Node differs from pinned packaging runtime');
    if (hash(path.join(output, 'resources/node/LICENSE')) !== hash(path.join(app, 'node_modules/electron-game-overlay/dist/broker/win32-x64/licenses/node.txt'))) throw new Error('Bundled Node license mismatch');
    const version = spawnSync(node, ['--version'], { env: { PATH: '' }, timeout: 5000, encoding: 'utf8', windowsHide: true });
    if (version.status !== 0 || version.stdout.trim() !== 'v26.12.1') throw new Error('Bundled Node version mismatch');
    report.watcher = await probeWatcher(app, node);
    report.stage = 'genuine-packaged-recovery-diagnostic'; save();
    report.recoveryDiagnostic = probeRecoveryDiagnostic(app, node, path.join(output, 'windows-broker-identity.json'));
    report.status = 'passed'; report.stage = 'complete'; save();
    return report;
  } catch (error) { report.error = error.message; save(); throw error; }
  finally { if (work) fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { smoke, probeWatcher, probeRecoveryDiagnostic };
if (require.main === module) {
  (async () => {
  try {
    const { values } = parseArgs({ options: { package: { type: 'string' } } });
    console.log(JSON.stringify(await smoke(values.package && path.resolve(values.package)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  })();
}
