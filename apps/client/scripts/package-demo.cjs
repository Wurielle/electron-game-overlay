const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const executable = 'ElectronGameOverlayDemo.exe';

function createAppManifest(source, graph) {
  const dependencies = {};
  for (const name of Object.keys(source.dependencies || {})) {
    if (name === 'electron') continue;
    const version = graph.dependencies?.[name]?.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)) throw new Error(`Missing installed dependency version: ${name}`);
    dependencies[name] = version;
  }
  return { name: 'electron-game-overlay-demo', version: source.version, private: true, type: 'commonjs', main: 'dist/main/main.js', dependencies };
}

function copyTree(source, destination, filter = () => true) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink: ${source}`);
  if (!filter(source, stat)) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), filter);
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  } else throw new Error(`Not a regular file: ${source}`);
}

function copyProductionGraph(root, output, graph, sdkPackage) {
  if (sdkPackage) validateSDKPackage(sdkPackage, output);
  const visited = new Set();
  function visit(node, name) {
    if (name === 'electron' || !node.path) return;
    if (visited.has(node.path)) {
      for (const [childName, child] of Object.entries(node.dependencies || {})) visit(child, childName);
      return;
    }
    visited.add(node.path);
    const relative = path.relative(root, node.path);
    if (!relative.startsWith(`node_modules${path.sep}`) || relative.includes(`..${path.sep}`)) throw new Error(`Dependency outside node_modules: ${node.path}`);
    const real = fs.realpathSync(sdkPackage && name === 'electron-game-overlay' ? sdkPackage : node.path);
    if (name === 'electron-game-overlay') validateSDKPackage(real, output);
    const workspace = real !== path.resolve(node.path);
    copyTree(real, path.join(output, relative), (file) => {
      const rel = path.relative(real, file).split(path.sep);
      // Installed dependency children are copied from the graph separately;
      // dependencies sealed inside dist belong to the packaged artifact itself.
      if (rel[0] === 'node_modules') return false;
      return !workspace || rel[0] === '' || rel[0] === 'dist' || /^(package\.json|licen[cs]e.*|copying.*|notice.*)$/i.test(rel[0]);
    });
    for (const [childName, child] of Object.entries(node.dependencies || {})) visit(child, childName);
  }
  for (const [name, node] of Object.entries(graph.dependencies || {})) visit(node, name);
}

function regular(file) {
  if (!fs.lstatSync(file).isFile() || !fs.statSync(file).size) throw new Error(`Required nonempty regular file missing: ${file}`);
}
function pe(file) {
  regular(file);
  const bytes = fs.readFileSync(file);
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error(`Not a PE binary: ${file}`);
}
function validateClientAssets(dist) {
  const html = path.join(dist, 'index/index.html');
  for (const match of fs.readFileSync(html, 'utf8').matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const value = match[1];
    if (/^(?:\/|[a-z]+:)/i.test(value)) throw new Error(`Asset must use a relative file URL: ${value}`);
    const file = fileURLToPath(new URL(value, pathToFileURL(html)));
    if (!file.startsWith(path.resolve(dist) + path.sep)) throw new Error(`Asset escapes dist: ${value}`);
    regular(file);
  }
  for (const name of ['main/main.js', 'process-watcher/index.cjs']) regular(path.join(dist, name));
}
function validateSDKPayloads(sdk) {
  regular(path.join(sdk, 'index.js'));
  // The validator is part of this trusted build checkout, not code from a
  // caller-supplied SDK. Inspect incoming bytes before executing any of them.
  const { validateOverlayDistributionSync } = require(path.join(repo, 'libs/electron-game-overlay/dist/lib/overlay-package-manifest.js'));
  const manifest = validateOverlayDistributionSync(sdk);
  const runtime = path.join(sdk, 'runtime/win32-x64/reshade');
  regular(path.join(runtime, 'ReShade.ini'));
  for (const bits of [32, 64]) {
    const suffix = bits === 64 ? '' : '32';
    for (const name of [`electron_game_overlay.addon${bits}`, `electron_game_overlay_reshade_manager${suffix}.exe`, `inject${suffix}.exe`, `ReShade${bits}.dll`]) pe(path.join(runtime, name));
    for (const name of [`electron_game_overlay_runtime${suffix}.build.json`, `ReShade${bits}.build.json`]) regular(path.join(runtime, name));
  }
  return manifest;
}
function validatePayloads(app) {
  const manifest = validateSDKPayloads(path.join(app, 'node_modules/electron-game-overlay/dist'));
  pe(path.join(app, 'node_modules/koffi/build/koffi/win32_x64/koffi.node'));
  pe(path.join(app, 'node_modules/wql-process-monitor/lib/dist/processMonitor.x64.dll'));
  return manifest;
}
function validateSDKPackage(root, output) {
  root = fs.realpathSync(root);
  const target = path.resolve(output);
  if (root === target || root.startsWith(target + path.sep) || target.startsWith(root + path.sep)) throw new Error('SDK and output overlap');
  regular(path.join(root, 'package.json'));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'electron-game-overlay' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(metadata.version) || !['./dist/index.js', 'dist/index.js'].includes(metadata.main)) throw new Error('Invalid SDK package metadata or root output');
  const manifest = validateSDKPayloads(path.join(root, 'dist'));
  if (manifest.packageVersion !== metadata.version) throw new Error('SDK seal package version mismatch');
  if (!manifest.files.some(entry => entry.path.startsWith('node_modules/tslib/'))) throw new Error('SDK seal lacks its compiled helper dependency');
  return metadata;
}
function supportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major === 20 && minor >= 19 || major === 22 && minor >= 12 || major > 22;
}
function copyNodeRuntime(output, source, license, version = process.versions.node) {
  pe(source); regular(license);
  if (!supportedNodeVersion(version)) throw new Error('Portable watcher requires a supported Node.js runtime (^20.19.0 || >=22.12.0)');
  const destination = path.join(output, 'resources/node');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, 'node.exe'));
  fs.copyFileSync(license, path.join(destination, 'LICENSE'));
  fs.writeFileSync(path.join(destination, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'electron-game-overlay-watcher-runtime',
    version,
    executableSha256: createHash('sha256').update(fs.readFileSync(path.join(destination, 'node.exe'))).digest('hex'),
    licenseSha256: createHash('sha256').update(fs.readFileSync(path.join(destination, 'LICENSE'))).digest('hex'),
  }, null, 2));
}
function resolveNodeRuntime(options) {
  const source = fs.realpathSync(path.resolve(options.nodeRuntime ?? process.execPath));
  pe(source);
  const license = options.nodeLicense !== undefined
    ? path.resolve(options.nodeLicense)
    : [path.join(path.dirname(source), 'LICENSE'), path.join(path.dirname(source), '..', 'LICENSE')]
      .find(file => { try { return fs.lstatSync(file).isFile(); } catch { return false; } });
  if (!license) throw new Error('Supply the matching Node.js license with --node-license <path>; it is independent of the SDK distribution.');
  try { regular(license); }
  catch { throw new Error('Supply the matching Node.js license with --node-license <path>; it is independent of the SDK distribution.'); }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  const version = execFileSync(source, ['--version'], { env, timeout: 5000, encoding: 'utf8', windowsHide: true }).trim().replace(/^v/, '');
  if (!supportedNodeVersion(version)) throw new Error('Portable watcher requires a supported Node.js runtime (^20.19.0 || >=22.12.0)');
  return { source, license, version };
}
function copyRecoveryDiagnostic(source, app) {
  const names = ['broker-recovery-diagnostic.cjs', 'windows-broker-identity.cjs'];
  for (const name of names) regular(path.join(source, name));
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(source, name), path.join(app, 'scripts', name));
}
function writeLaunchers(output) {
  const app = path.join(output, 'resources/app');
  fs.writeFileSync(path.join(app, 'portable-entry.cjs'), `
if (process.argv.includes('--manual-test-profile')) {
  const { app } = require('electron');
  const path = require('node:path');
  const fs = require('node:fs');
  const output = path.resolve(__dirname, '../..');
  const profile = path.join(output, 'profile');
  const logs = path.join(output, 'logs');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  app.setName(path.basename(output));
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setAppLogsPath(logs);
}
require('./dist/main/main.js');
`);
  fs.writeFileSync(path.join(output, 'Start Demo.cmd'), '@echo off\r\nstart "" "%~dp0ElectronGameOverlayDemo.exe" --reshade-overlay --steam-auto-attach --demo-presentation %*\r\n');
  fs.writeFileSync(path.join(output, 'Start Broker Test.cmd'), '@echo off\r\nstart "" "%~dp0ElectronGameOverlayDemo.exe" --manual-test-profile --reshade-overlay --steam-auto-attach --steam-exact-pid-only --demo-presentation %*\r\n');
  fs.writeFileSync(path.join(output, 'Start Manual Test.cmd'), '@echo off\r\nstart "" "%~dp0ElectronGameOverlayDemo.exe" --manual-test-profile --reshade-overlay --demo-presentation %*\r\n');
  fs.copyFileSync(path.join(repo, 'libs/electron-game-overlay-runtime/scripts/test-cases/broker-recovery-diagnostic.cmd'), path.join(output, 'Start Broker Recovery Diagnostic.cmd'));
}
function packageDemo(output, sdkPackage, options = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable demo packaging requires genuine Windows x64 build inputs');
  if (!path.isAbsolute(output)) throw new Error('--output must be an absolute job-owned directory');
  output = path.resolve(output);
  const relativeOutput = path.relative(path.join(repo, 'artifacts'), output);
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) throw new Error('Package output must be a new directory inside repository artifacts');
  if (fs.existsSync(output)) throw new Error('Output must not already exist; refusing to overwrite');
  if (repo === output || repo.startsWith(output + path.sep)) throw new Error('Output must not contain repository');
  const sdkMetadata = sdkPackage ? validateSDKPackage(sdkPackage, output) : undefined;
  validateClientAssets(path.join(repo, 'apps/client/dist'));
  const nodeRuntime = resolveNodeRuntime(options);
  const graph = JSON.parse(execFileSync('npm.cmd', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: repo, encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 }));
  const electron = path.join(repo, 'node_modules/electron/dist');
  pe(path.join(electron, 'electron.exe'));
  copyTree(electron, output);
  fs.renameSync(path.join(output, 'electron.exe'), path.join(output, executable));
  const app = path.join(output, 'resources/app');
  fs.mkdirSync(app, { recursive: true });
  fs.rmSync(path.join(output, 'resources/default_app.asar'), { force: true });
  const source = require(path.join(repo, 'package.json'));
  const metadata = createAppManifest(source, graph);
  metadata.main = 'portable-entry.cjs';
  if (sdkMetadata) metadata.dependencies['electron-game-overlay'] = sdkMetadata.version;
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(metadata, null, 2));
  copyTree(path.join(repo, 'apps/client/dist'), path.join(app, 'dist'));
  copyRecoveryDiagnostic(path.join(repo, 'apps/client/scripts'), app);
  copyProductionGraph(repo, app, graph, sdkPackage);
  fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(app, 'LICENSE'));
  copyNodeRuntime(output, nodeRuntime.source, nodeRuntime.license, nodeRuntime.version);
  validatePayloads(app);
  validateClientAssets(path.join(app, 'dist'));
  writeLaunchers(output);
  fs.writeFileSync(path.join(output, 'README.txt'), 'Electron Game Overlay portable Windows x64 demo\r\nExtract ALL files before running Start Demo.cmd as a normal user (not Administrator).\r\nNo Node.js/npm installation is needed. Close using the tray menu Quit.\r\nSteam auto-attach attempts detected Steam executables. Test only games you own and are permitted to modify.\r\nAvoid anti-cheat/protected/multiplayer games: injection may violate game rules or trigger bans.\r\nExisting ReShade installations are fail-closed; this is an experimental demo.\r\nCI packaging/runtime smoke is NOT proof of real-game attachment.\r\n');
  return { output, executable, scope: 'portable packaging; no game attachment' };
}
module.exports = { writeLaunchers, copyRecoveryDiagnostic, copyNodeRuntime, supportedNodeVersion, createAppManifest, copyProductionGraph, validateClientAssets, validatePayloads, packageDemo };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, 'sdk-package': { type: 'string' }, 'node-runtime': { type: 'string' }, 'node-license': { type: 'string' } } });
    if (!values.output) throw new Error('Usage: node apps/client/scripts/package-demo.cjs --output <absolute-new-job-owned-folder>');
    console.log(JSON.stringify(packageDemo(values.output, values['sdk-package'], { nodeRuntime: values['node-runtime'], nodeLicense: values['node-license'] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
