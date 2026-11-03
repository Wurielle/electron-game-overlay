'use strict';

// Cooperative installed-SDK acceptance (the filename is retained for CI links).
// Opt-in: node this-file --package-root <package> --sdk-root <built-dist>
//   --tslib-root <real-tslib> --typescript-root <real-typescript>
//   --scratch-root <parent-owned-directory> --report <persistent-json>
// --drop-sealed <manifest-relative-path> mutates only the private package copy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (i % 2 === 0) pairs.push([value.replace(/^--/, ''), all[i + 1]]);
  return pairs;
}, []));
const report = { status: 'failed', stage: 'setup', nativeExecuted: false,
  electronPeerInstalled: false, commands: [] };
let owned;
const cleanup = () => {
  if (owned) fs.rmSync(owned, { recursive: true, force: true, maxRetries: 3 });
};
// Registered before allocating any children; synchronous children have deadlines.
process.once('exit', cleanup);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function run(command, argv, cwd) {
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '',
    npm_config_ignore_scripts: 'true', npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_cache: path.join(owned, 'npm-cache'),
    HOME: path.join(owned, 'home'), USERPROFILE: path.join(owned, 'home'),
    TMPDIR: owned, TMP: owned, TEMP: owned };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8',
    timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  report.commands.push({ command, argv, exit: result.status,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
function pack(root, destination) {
  const output = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--offline',
    '--ignore-scripts', '--pack-destination', destination], root));
  const data = Array.isArray(output) ? output[0] : Object.values(output)[0];
  return { ...data, tarball: path.join(destination, data.filename) };
}
let npmCli;
try {
  assert.ok(args.report, '--report is required');
  fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
  for (const name of ['package-root', 'tslib-root', 'typescript-root', 'scratch-root']) {
    assert.ok(args[name], `--${name} is required`);
    args[name] = fs.realpathSync(args[name]);
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Resolve npm's JavaScript CLI without a shell (including Windows installs).
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  if (process.platform !== 'win32') {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const file = path.join(dir, npmCommand);
      if (fs.existsSync(file)) candidates.push(fs.realpathSync(file));
    }
  }
  npmCli = candidates.find((file) => file && /(?:npm-cli\.js|[\\/]npm)$/.test(file) && fs.existsSync(file));
  assert.ok(npmCli, 'npm CLI not found; invoke via npm or install npm beside Node');
  owned = fs.mkdtempSync(path.join(args['scratch-root'], 'broker-package-install-'));
  for (const dir of ['stage', 'packs', 'consumer', 'home']) fs.mkdirSync(path.join(owned, dir));
  const stage = path.join(owned, 'stage');
  fs.cpSync(args['package-root'], stage, { recursive: true,
    filter: (source) => !['node_modules', '.git', 'dist'].includes(path.basename(source)) });
  const sdk = fs.realpathSync(args['sdk-root'] || path.join(args['package-root'], 'dist'));
  fs.cpSync(sdk, path.join(stage, 'dist'), { recursive: true });
  const leaf = 'dist';
  const originalManifest = json(path.join(sdk, 'overlay-manifest.json'));
  assert.equal(originalManifest.schema, 1);
  assert.equal(originalManifest.kind, 'electron-game-overlay-sdk-distribution');
  assert.equal(fs.existsSync(path.join(sdk, 'broker')), false, 'cooperative SDK must not contain a standalone broker');
  report.manifestSha256 = sha(path.join(sdk, 'overlay-manifest.json'));
  report.distributionKind = originalManifest.kind;
  // Match the public packager when this gate consumes the workspace package.
  // An already prepared candidate is packed without changing its metadata.
  const stageMetadata = json(path.join(stage, 'package.json'));
  assert.equal(stageMetadata.version, originalManifest.packageVersion);
  if (stageMetadata.private === true) {
    stageMetadata.private = false;
    stageMetadata.files = ['dist', 'README.md', 'LICENSE'];
    if (fs.existsSync(path.join(stage, 'SDK_PROVENANCE.json'))) stageMetadata.files.push('SDK_PROVENANCE.json');
    delete stageMetadata.exports['.'].gelectron;
    delete stageMetadata.scripts;
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(stageMetadata, null, 2) + '\n');
  }
  if (!fs.existsSync(path.join(stage, 'LICENSE'))) {
    fs.copyFileSync(path.resolve(args['package-root'], '../../LICENSE'), path.join(stage, 'LICENSE'));
  }
  if (args['drop-sealed']) {
    assert.ok(originalManifest.files.some((entry) => entry.path === args['drop-sealed']), 'mutation must name a declared sealed payload');
    fs.unlinkSync(path.join(stage, leaf, args['drop-sealed']));
    report.mutation = args['drop-sealed'];
  }
  report.stage = 'pack';
  const packed = pack(stage, path.join(owned, 'packs'));
  report.tarballSha256 = sha(packed.tarball);
  report.packFileCount = packed.files.length;
  report.packFiles = packed.files.map((entry) => entry.path);
  const files = new Set(report.packFiles);
  assert.ok(files.has('dist/overlay-manifest.json'), 'direct SDK seal missing from actual npm tarball');
  assert.equal(report.packFiles.some(file => file.startsWith('dist/broker/')), false, 'broker payload entered cooperative tarball');
  for (const entry of originalManifest.files) {
    assert.ok(files.has(`${leaf}/${entry.path}`), `sealed payload missing from actual npm tarball: ${entry.path}`);
  }
  const tslib = pack(args['tslib-root'], path.join(owned, 'packs'));
  report.tslibTarballSha256 = sha(tslib.tarball);
  const consumer = path.join(owned, 'consumer');
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'broker-package-consumer',
    version: '1.0.0', private: true, dependencies: {
      'electron-game-overlay': `file:${packed.tarball}`, tslib: `file:${tslib.tarball}` } }));
  report.stage = 'offline-install';
  run(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--legacy-peer-deps', '--package-lock=false'], consumer);
  const installed = path.join(consumer, 'node_modules/electron-game-overlay');
  const metadata = json(path.join(installed, 'package.json'));
  assert.equal(metadata.dependencies.tslib, '^2.8.1');
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules/electron')), false);
  function targets(value) {
    return typeof value === 'string' ? [value] : Object.values(value).flatMap(targets);
  }
  for (const target of [metadata.main, metadata.types, ...targets(metadata.exports)]) {
    assert.ok(target.startsWith('./'), `nonlocal export target: ${target}`);
    assert.ok(fs.existsSync(path.join(installed, target)), `installed export missing: ${target}`);
  }
  report.stage = 'installed-payload';
  const manifest = json(path.join(installed, leaf, 'overlay-manifest.json'));
  assert.equal(sha(path.join(installed, leaf, 'overlay-manifest.json')), report.manifestSha256);
  report.sealedPayloads = manifest.files.map((entry) => {
    const file = path.resolve(installed, leaf, entry.path);
    assert.ok(inside(path.join(installed, leaf), file), 'sealed path escapes distribution');
    assert.equal(fs.statSync(file).size, entry.size, `sealed size: ${entry.path}`);
    assert.equal(sha(file), entry.sha256, `sealed hash: ${entry.path}`);
    return { ...entry };
  });
  assert.ok(fs.statSync(path.join(installed, 'dist/lib/overlay-process-identity.d.ts')).size > 0);
  const binaries = [];
  for (const base of ['dist']) {
    const runtime = path.join(base, 'runtime/win32-x64/reshade');
    for (const [file, machine] of [['electron_game_overlay_reshade_manager.exe', 0x8664],
      ['electron_game_overlay_reshade_manager32.exe', 0x14c], ['inject.exe', 0x8664],
      ['inject32.exe', 0x14c], ['electron_game_overlay.addon64', 0x8664],
      ['electron_game_overlay.addon32', 0x14c], ['ReShade64.dll', 0x8664], ['ReShade32.dll', 0x14c]]) {
      binaries.push({ file: path.join(runtime, file), machine });
    }
  }
  for (const binary of binaries) {
    const bytes = fs.readFileSync(path.join(installed, binary.file));
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ', binary.file);
    const offset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(offset), 0x4550, binary.file);
    assert.equal(bytes.readUInt16LE(offset + 4), binary.machine, binary.file);
  }
  report.binaryArchitectureChecks = binaries;
  report.stage = 'node-only-consumer';
  const probe = path.join(consumer, 'probe.cjs');
  fs.writeFileSync(probe, `const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const Module = require('node:module'); const root = fs.realpathSync(__dirname);
const crypto = require('node:crypto');
const original = Module._resolveFilename; const seen = new Set();
Module._resolveFilename = function(request, parent, ...rest) {
  assert.notEqual(request, 'electron', 'installer/packaging imported Electron');
  const resolved = original.call(this, request, parent, ...rest);
  if (!Module.isBuiltin(resolved)) {
    const real = fs.realpathSync(resolved); const relative = path.relative(root, real);
    assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'ancestor dependency fallback: ' + request);
    seen.add(relative);
  }
  return resolved;
};
const preload = require('electron-game-overlay/preload');
const packaging = require('electron-game-overlay/packaging');
for (const name of ['defaultReShadeAddonDirectory', 'registerOverlayAddonInstallation', 'unregisterOverlayAddonInstallation']) assert.equal(typeof preload[name], 'function');
for (const name of ['createOverlayAfterPack', 'packageOverlayForElectronBuilder', 'verifyOverlayPackage']) assert.equal(typeof packaging[name], 'function');
assert.ok(require.resolve('electron-game-overlay').endsWith(path.join('dist', 'index.js')));
assert.equal(require('electron-game-overlay/package.json').name, 'electron-game-overlay');
assert.ok(require.resolve('tslib').startsWith(root + path.sep));
assert.throws(() => require.resolve('electron-game-overlay/dist/lib/overlay-addon-preload.js'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
async function main() {
  const packageRoot = path.dirname(require.resolve('electron-game-overlay/package.json'));
  const verified = await packaging.verifyOverlayPackage(packageRoot);
  const appOutDir = path.join(root, 'packaged-app'); fs.mkdirSync(appOutDir);
  await packaging.createOverlayAfterPack({ packageRoot })({ appOutDir, electronPlatformName: 'win32' });
  const restored = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'electron-game-overlay');
  assert.deepEqual(await packaging.verifyOverlayPackage(restored), verified);
  assert.equal(fs.existsSync(path.join(restored, 'dist', 'broker')), false);
  const addonDirectory = path.join(root, 'shared-addons'); fs.mkdirSync(addonDirectory);
  const foreign = path.join(addonDirectory, 'ordinary-placeholder.addon');
  fs.writeFileSync(foreign, 'inert ordinary add-on, never executed');
  const fileIdentity = file => { const stat = fs.statSync(file); return { ino: stat.ino, mtimeMs: stat.mtimeMs, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }; };
  const foreignIdentity = fileIdentity(foreign);
  const options = { applicationId: 'com.example.installed-a', addonDirectory };
  const first = await preload.registerOverlayAddonInstallation(options);
  const identities = [first.addonPath, first.x86AddonPath].map(fileIdentity);
  assert.deepEqual(await preload.registerOverlayAddonInstallation(options), first);
  assert.deepEqual([first.addonPath, first.x86AddonPath].map(fileIdentity), identities);
  const peer = await preload.registerOverlayAddonInstallation({ applicationId: 'com.example.installed-b', addonDirectory });
  for (const file of [first.addonPath, first.x86AddonPath, peer.addonPath, peer.x86AddonPath]) assert.equal(path.dirname(file), addonDirectory);
  assert.notEqual(first.addonPath, peer.addonPath);
  await preload.unregisterOverlayAddonInstallation({ ...options, registrationId: first.registrationId });
  assert.deepEqual([first.addonPath, first.x86AddonPath].map(fileIdentity), identities);
  assert.deepEqual(fileIdentity(foreign), foreignIdentity);
  const catalog = JSON.parse(fs.readFileSync(path.join(addonDirectory, '.electron-game-overlay', 'registrations.json'), 'utf8'));
  assert.deepEqual(catalog.registrations.map(item => item.applicationId), ['com.example.installed-b']);
  console.log(JSON.stringify({ resolved: [...seen].sort(), electronImported: false, nativeExecuted: false,
    verifiedSealedPayloads: verified.sealedPayloads, afterPackSealedPayloads: (await packaging.verifyOverlayPackage(restored)).sealedPayloads,
    registration: { flatFiles: 4, stableIdentity: true, retiredFilesRetained: true, foreignUnchanged: true } }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
`);
  report.nodeConsumer = JSON.parse(run(process.execPath, [probe], consumer));
  report.stage = 'public-types';
  const typeFile = path.join(consumer, 'consumer.cts');
  fs.writeFileSync(typeFile, `import { registerOverlayAddonInstallation, unregisterOverlayAddonInstallation, type OverlayAddonInstallationOptions, type OverlayAddonInstallation } from 'electron-game-overlay/preload';
import { verifyOverlayPackage, createOverlayAfterPack } from 'electron-game-overlay/packaging';
const options: OverlayAddonInstallationOptions = { applicationId: 'com.example.consumer', addonDirectory: 'C:/isolated/addons' };
const installation: Promise<OverlayAddonInstallation> = registerOverlayAddonInstallation(options);
const result: Promise<void> = unregisterOverlayAddonInstallation({ applicationId: options.applicationId, registrationId: 'a'.repeat(64) });
const verification: Promise<Readonly<{ sealedPayloads: number }>> = verifyOverlayPackage('C:/installed/sdk');
const hook: (context: { appOutDir: string; electronPlatformName: string }) => Promise<void> = createOverlayAfterPack();
// @ts-expect-error application identity must be a string
unregisterOverlayAddonInstallation({ applicationId: 123 });
// @ts-expect-error options must be typed
registerOverlayAddonInstallation({ applicationId: 'com.example.consumer', addonDirectory: false });
void installation; void result; void verification; void hook;
`);
  const compiler = require(path.join(args['typescript-root'], 'lib/typescript.js'));
  // The compiler is tooling outside the consumer; resolution has no source aliases.
  const program = compiler.createProgram([typeFile], { strict: true, noEmit: true,
    target: compiler.ScriptTarget.ES2022, module: compiler.ModuleKind.Node16,
    moduleResolution: compiler.ModuleResolutionKind.Node16, types: [], skipLibCheck: false });
  const diagnostics = compiler.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, compiler.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => consumer, getNewLine: () => os.EOL }));
  const consumerSource = program.getSourceFile(typeFile);
  assert.ok(consumerSource, 'type consumer root missing from program');
  const declarations = program.getSourceFiles().filter((file) =>
    !program.isSourceFileDefaultLibrary(file) && file !== consumerSource
  ).map((file) => fs.realpathSync(file.fileName));
  assert.ok(declarations.some((file) => file === path.join(installed, 'dist/preload.d.ts')));
  assert.ok(declarations.some((file) => file === path.join(installed, 'dist/packaging.d.ts')));
  for (const file of declarations) assert.ok(inside(path.join(consumer, 'node_modules'), file), 'type consumer escaped installed dependency tree');
  report.typeDeclarations = declarations.map((file) => path.relative(installed, file));
  report.sealedPayloadCount = report.sealedPayloads.length;
  report.status = 'passed';
  report.stage = 'complete';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try { cleanup(); report.cleanup = 'completed'; }
  catch (error) { report.cleanup = error.message; report.status = 'failed'; process.exitCode = 1; }
  if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, stage: report.stage, sealedPayloadCount: report.sealedPayloadCount,
    packFileCount: report.packFileCount, error: report.error, cleanup: report.cleanup }));
}
