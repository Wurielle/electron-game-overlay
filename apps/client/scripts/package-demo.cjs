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

function copyProductionGraph(root, output, graph) {
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
    const real = fs.realpathSync(node.path);
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
function validatePayloads(app) {
  const sdk = path.join(app, 'node_modules/electron-game-overlay/dist');
  for (const name of ['index.js', 'broker.js']) regular(path.join(sdk, name));
  const runtime = path.join(sdk, 'runtime/win32-x64/reshade');
  regular(path.join(runtime, 'ReShade.ini'));
  for (const bits of [32, 64]) {
    const suffix = bits === 64 ? '' : '32';
    for (const name of [`electron_game_overlay.addon${bits}`, `electron_game_overlay_reshade_manager${suffix}.exe`, `inject${suffix}.exe`, `ReShade${bits}.dll`]) pe(path.join(runtime, name));
    for (const name of [`electron_game_overlay_runtime${suffix}.build.json`, `ReShade${bits}.build.json`]) regular(path.join(runtime, name));
  }
  const broker = path.join(sdk, 'broker/win32-x64');
  const manifest = JSON.parse(fs.readFileSync(path.join(broker, 'broker-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || !manifest.files?.length || manifest.executable !== 'electron-game-overlay-broker.exe') throw new Error('Invalid sealed Windows broker manifest');
  for (const entry of manifest.files) {
    if (entry.path.includes('..') || path.isAbsolute(entry.path)) throw new Error('Unsafe broker manifest path');
    const file = path.join(broker, entry.path);
    regular(file);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Broker seal mismatch: ${entry.path}`);
  }
  pe(path.join(broker, manifest.executable));
  pe(path.join(app, 'node_modules/koffi/build/koffi/win32_x64/koffi.node'));
  pe(path.join(app, 'node_modules/wql-process-monitor/lib/dist/processMonitor.x64.dll'));
  return manifest;
}
function copyNodeRuntime(output, source, license) {
  pe(source); regular(license);
  const destination = path.join(output, 'resources/node');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, 'node.exe'));
  fs.copyFileSync(license, path.join(destination, 'LICENSE'));
}
function packageDemo(output) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable demo packaging requires genuine Windows x64 build inputs');
  if (!path.isAbsolute(output)) throw new Error('--output must be an absolute job-owned directory');
  output = path.resolve(output);
  const relativeOutput = path.relative(path.join(repo, 'artifacts'), output);
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) throw new Error('Package output must be a new directory inside repository artifacts');
  if (fs.existsSync(output)) throw new Error('Output must not already exist; refusing to overwrite');
  if (repo === output || repo.startsWith(output + path.sep)) throw new Error('Output must not contain repository');
  validateClientAssets(path.join(repo, 'apps/client/dist'));
  const graph = JSON.parse(execFileSync('npm.cmd', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: repo, encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 }));
  const electron = path.join(repo, 'node_modules/electron/dist');
  pe(path.join(electron, 'electron.exe'));
  copyTree(electron, output);
  fs.renameSync(path.join(output, 'electron.exe'), path.join(output, executable));
  const app = path.join(output, 'resources/app');
  fs.mkdirSync(app, { recursive: true });
  fs.rmSync(path.join(output, 'resources/default_app.asar'), { force: true });
  const source = require(path.join(repo, 'package.json'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(createAppManifest(source, graph), null, 2));
  copyTree(path.join(repo, 'apps/client/dist'), path.join(app, 'dist'));
  copyProductionGraph(repo, app, graph);
  fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(app, 'LICENSE'));
  if (process.versions.node !== '26.12.1') throw new Error('Portable watcher requires pinned Node 26.12.1');
  copyNodeRuntime(output, process.execPath, path.join(app, 'node_modules/electron-game-overlay/dist/broker/win32-x64/licenses/node.txt'));
  validatePayloads(app);
  validateClientAssets(path.join(app, 'dist'));
  fs.writeFileSync(path.join(output, 'Start Demo.cmd'), '@echo off\r\nstart "" "%~dp0ElectronGameOverlayDemo.exe" --reshade-overlay --steam-auto-attach --demo-presentation %*\r\n');
  fs.writeFileSync(path.join(output, 'README.txt'), 'Electron Game Overlay portable Windows x64 demo\r\nExtract ALL files before running Start Demo.cmd as a normal user (not Administrator).\r\nNo Node.js/npm installation is needed. Close using the tray menu Quit.\r\nSteam auto-attach attempts detected Steam executables. Test only games you own and are permitted to modify.\r\nAvoid anti-cheat/protected/multiplayer games: injection may violate game rules or trigger bans.\r\nExisting ReShade installations are fail-closed; this is an experimental demo.\r\nCI packaging/runtime smoke is NOT proof of real-game attachment.\r\n');
  return { output, executable, scope: 'portable packaging; no game attachment' };
}
module.exports = { copyNodeRuntime, createAppManifest, copyProductionGraph, validateClientAssets, validatePayloads, packageDemo };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' } } });
    if (!values.output) throw new Error('Usage: node apps/client/scripts/package-demo.cjs --output <absolute-new-job-owned-folder>');
    console.log(JSON.stringify(packageDemo(values.output), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
