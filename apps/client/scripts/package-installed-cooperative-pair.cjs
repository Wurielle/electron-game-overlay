'use strict';

// DEVELOPMENT snapshot packaging only. No implementation is rebuilt, loaded or
// relabeled as a released SDK. Only the copied npm/seal package-version metadata
// changes; SOURCE_OVERLAY_MANIFEST.json preserves the exact original seal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { parseArgs } = require('node:util');
const repo = path.resolve(__dirname, '../../..');
const trustedSdk = path.join(repo, 'libs/electron-game-overlay');
const { validateOverlayDistributionSync } = require(path.join(trustedSdk, 'dist/lib/overlay-package-manifest.js'));
const { verifyOverlayPackage } = require(path.join(trustedSdk, 'dist/packaging.js'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const DEVELOPMENT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-development\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const MAX_JSON = 4 * 1024 * 1024;

function regular(file, maximum = 512 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('Expected bounded regular file: ' + file);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size) throw new Error('File changed while reading: ' + file);
  return bytes;
}
function json(file) { return JSON.parse(regular(file, MAX_JSON).toString('utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function noLinks(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const name of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, name);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic link/junction refused: ' + current);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symbolic package payload refused: ' + relative);
    if (entry.isDirectory()) return files(root, relative + '/');
    if (!entry.isFile()) throw new Error('Nonregular package payload refused: ' + relative);
    return [relative];
  }).sort(compare);
}
function copy(source, target, expected) {
  const bytes = regular(source);
  if (expected && (bytes.length !== expected.size || hash(bytes) !== expected.sha256)) throw new Error('Source payload changed: ' + source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
}
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [process.env.npm_execpath, path.join(bin, 'node_modules/npm/bin/npm-cli.js'), path.join(bin, '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    const command = path.join(directory, 'npm');
    if (fs.existsSync(command)) candidates.push(fs.realpathSync(command));
  }
  const found = candidates.find(file => file && /(?:^|[\\/])npm-cli\.js$/.test(file) && fs.existsSync(file));
  if (!found) throw new Error('npm JavaScript CLI not found');
  return found;
}
function runNpm(cli, args, cwd, output, report) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  Object.assign(env, { NODE_OPTIONS: '', NODE_PATH: '', npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' });
  const flags = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(output, 'npm-cache'), '--userconfig', path.join(output, 'empty-user.npmrc'), '--globalconfig', path.join(output, 'empty-global.npmrc')];
  const command = [cli, ...args, ...flags];
  const result = spawnSync(process.execPath, command, { cwd, env, shell: false, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  report.commands.push({ executable: process.execPath, args: command, cwd, exit: result.status });
  if (result.error || result.status !== 0) throw new Error('Offline npm ' + args[0] + ' failed: ' + (result.error?.message || result.stderr));
  return JSON.parse(result.stdout);
}
function inspectSdk(input) {
  const source = noLinks(input);
  if (!fs.lstatSync(source).isDirectory()) throw new Error('SDK source must be a regular directory');
  const dist = fs.existsSync(path.join(source, 'overlay-manifest.json')) ? source : path.join(source, 'dist');
  const root = path.dirname(dist);
  noLinks(dist);
  const metadataPath = path.join(root, 'package.json');
  const metadataBytes = regular(metadataPath, MAX_JSON);
  const metadata = JSON.parse(metadataBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (metadata.name !== 'electron-game-overlay' || typeof metadata.version !== 'string') throw new Error('Expected electron-game-overlay source metadata');
  if (Object.keys(metadata.dependencies || {}).some(name => name !== 'tslib') || !/^[~^]?\d+\.\d+\.\d+$/.test(metadata.dependencies?.tslib || '') || metadata.optionalDependencies || metadata.devDependencies || metadata.bin || metadata.workspaces) throw new Error('Unexpected SDK dependency graph or package commands');
  const manifest = validateOverlayDistributionSync(dist, metadata.version);
  const manifestBytes = regular(path.join(dist, 'overlay-manifest.json'), MAX_JSON);
  const exportTargets = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.entries(value).filter(([key]) => key !== 'gelectron').flatMap(([, item]) => exportTargets(item)) : [];
  const selected = new Set(manifest.files.map(file => './dist/' + file.path));
  for (const target of [metadata.main, metadata.module, metadata.types, ...exportTargets(metadata.exports)].filter(value => value !== undefined)) {
    if (typeof target !== 'string' || (target !== './package.json' && !selected.has(target))) throw new Error('Unsafe or missing SDK export: ' + target);
  }
  if (metadata.main !== './dist/index.js' || !metadata.exports?.['.']) throw new Error('SDK main/public exports missing');
  // Match cooperative-game-evidence's public hash representation exactly,
  // including sealed dependencies and the `bytes` field spelling.
  const javascript = manifest.files.filter(file => file.path.endsWith('.js')).map(file => ({ path: file.path, bytes: file.size, sha256: file.sha256 }));
  const native = [64, 32].map(bits => {
    const suffix = bits === 64 ? '' : '32';
    const base = path.join(dist, 'runtime/win32-x64/reshade');
    const stampName = 'electron_game_overlay_runtime' + suffix + '.build.json';
    const stamp = json(path.join(base, stampName));
    return { architecture: bits === 64 ? 'x64' : 'x86', addonBuildId: stamp.addonBuildId, runtimeGeneration: stamp.runtimeGeneration, cooperativeAddonProtocol: stamp.cooperativeAddonProtocol, addonSha256: stamp.addonSha256.toLowerCase(), runtimeManifestSha256: hash(regular(path.join(base, stampName))) };
  });
  return { root, dist, metadataPath, metadata, metadataBytes, manifest, manifestBytes, manifestSha256: hash(manifestBytes), metadataSha256: hash(metadataBytes), javascriptGraphSha256: hash(JSON.stringify(javascript)), sealedFilesSha256: hash(JSON.stringify(manifest.files)), native };
}
function developmentMetadata(source, version) {
  const metadata = structuredClone(source.metadata);
  metadata.version = version;
  metadata.private = true;
  metadata.files = ['dist', 'LICENSE', 'README.md', 'SOURCE_PACKAGE.json', 'SOURCE_OVERLAY_MANIFEST.json', 'SDK_PROVENANCE.json'];
  metadata.bundleDependencies = ['tslib'];
  delete metadata.bundledDependencies;
  delete metadata.scripts;
  if (metadata.exports?.['.'] && typeof metadata.exports['.'] === 'object') delete metadata.exports['.'].gelectron;
  return metadata;
}
function stageParticipant(id, source, version, output) {
  const stage = path.join(output, 'staged', id);
  fs.mkdirSync(stage, { recursive: true });
  for (const entry of source.manifest.files) copy(path.join(source.dist, entry.path), path.join(stage, 'dist', entry.path), entry);
  const stagedManifest = { ...source.manifest, packageVersion: version };
  writeJson(path.join(stage, 'dist/overlay-manifest.json'), stagedManifest);
  fs.writeFileSync(path.join(stage, 'SOURCE_OVERLAY_MANIFEST.json'), source.manifestBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(stage, 'SOURCE_PACKAGE.json'), source.metadataBytes, { flag: 'wx' });
  writeJson(path.join(stage, 'package.json'), developmentMetadata(source, version));
  const license = [path.join(source.root, 'LICENSE'), path.join(repo, 'LICENSE')].find(file => fs.existsSync(file));
  if (!license) throw new Error('GPL license is required');
  copy(license, path.join(stage, 'LICENSE'));
  const readme = path.join(source.root, 'README.md');
  if (fs.existsSync(readme)) copy(readme, path.join(stage, 'README.md'));
  // npm's normal dependency semantics are preserved: bundle a second, exact copy
  // of the already sealed dependency, without consulting a registry/cache.
  const dependency = source.manifest.files.filter(file => file.path.startsWith('node_modules/tslib/'));
  for (const entry of dependency) copy(path.join(source.dist, entry.path), path.join(stage, entry.path), entry);
  const provenance = {
    schemaVersion: 1, kind: 'electron-game-overlay-development-snapshot-package', developmentOnly: true,
    independentlyReleasedPackage: false, nativeExecuted: false, version,
    source: { packageRoot: source.root, dist: source.dist, packageVersion: source.metadata.version, packageJsonSha256: source.metadataSha256, overlayManifestSha256: source.manifestSha256, sealedFilesSha256: source.sealedFilesSha256, javascriptGraphSha256: source.javascriptGraphSha256, sealedPayloads: source.manifest.files.length },
    transform: { copiedSealFieldChanged: 'packageVersion', originalPackageVersion: source.manifest.packageVersion, stagedPackageVersion: version, sealedPayloadBytesChanged: false, sealedFilesInventoryChanged: false, packageMetadataChanges: ['version', 'private=true', 'files allowlist', 'bundleDependencies=[tslib]', 'remove scripts', 'remove gelectron source export'], bundledTslibSource: 'verified dist/node_modules/tslib' },
    native: source.native,
  };
  writeJson(path.join(stage, 'SDK_PROVENANCE.json'), provenance);
  validateOverlayDistributionSync(path.join(stage, 'dist'), version);
  const stagedFiles = files(stage).map(name => { const bytes = regular(path.join(stage, name)); return { path: name, size: bytes.length, sha256: hash(bytes) }; });
  return { id, version, sourceSdkRoot: source.root, sourceDist: source.dist, sourcePackageVersion: source.metadata.version, sourceManifestSha256: source.manifestSha256, sourcePackageJsonSha256: source.metadataSha256, sourceSealedFilesSha256: source.sealedFilesSha256, javascriptGraphSha256: source.javascriptGraphSha256, sealedPayloads: source.manifest.files.length, sealedBytes: source.manifest.files.reduce((total, file) => total + file.size, 0), stagedRoot: stage, stagedFiles, stagedFilesSha256: hash(JSON.stringify(stagedFiles)), stagedManifestSha256: hash(regular(path.join(stage, 'dist/overlay-manifest.json'))), provenanceSha256: hash(regular(path.join(stage, 'SDK_PROVENANCE.json'))), native: source.native };
}
async function verifyInstalledParticipant(participant, source) {
  const consumer = participant.consumerRoot;
  const packageRoot = path.join(consumer, 'node_modules/electron-game-overlay');
  noLinks(packageRoot);
  const metadata = json(path.join(packageRoot, 'package.json'));
  if (metadata.name !== 'electron-game-overlay' || metadata.version !== participant.version) throw new Error('Installed package identity mismatch');
  const manifest = validateOverlayDistributionSync(path.join(packageRoot, 'dist'), participant.version);
  if (JSON.stringify(manifest.files) !== JSON.stringify(source.manifest.files)) throw new Error('Installed sealed inventory differs from original source');
  if (hash(regular(path.join(packageRoot, 'SOURCE_OVERLAY_MANIFEST.json'))) !== source.manifestSha256 || hash(regular(path.join(packageRoot, 'SOURCE_PACKAGE.json'))) !== source.metadataSha256) throw new Error('Installed original source evidence changed');
  if (hash(regular(path.join(packageRoot, 'SDK_PROVENANCE.json'))) !== participant.provenanceSha256) throw new Error('Installed package provenance changed');
  const installedManifestSha256 = hash(regular(path.join(packageRoot, 'dist/overlay-manifest.json')));
  if (installedManifestSha256 !== participant.stagedManifestSha256) throw new Error('Installed package seal changed');
  const requireConsumer = createRequire(path.join(consumer, 'package.json'));
  const resolvedMain = requireConsumer.resolve('electron-game-overlay');
  const resolvedMetadata = requireConsumer.resolve('electron-game-overlay/package.json');
  if (resolvedMain !== path.join(packageRoot, 'dist/index.js') || resolvedMetadata !== path.join(packageRoot, 'package.json')) throw new Error('Consumer SDK export resolves outside its own installation');
  const verification = await verifyOverlayPackage(packageRoot);
  const lockPath = path.join(consumer, 'package-lock.json');
  const lock = json(lockPath);
  const locked = lock.packages?.['node_modules/electron-game-overlay'];
  if (locked?.version !== participant.version || locked.integrity !== participant.npmIntegrity) throw new Error('Independent npm lockfile does not identify the packed SDK');
  if (typeof locked.resolved !== 'string' || !locked.resolved.startsWith('file:') || path.resolve(consumer, locked.resolved.slice(5)) !== participant.tarball || lock.packages['']?.dependencies?.['electron-game-overlay'] !== locked.resolved) throw new Error('npm lockfile archive path differs from its own local tarball');
  if (lock.packages['node_modules/electron']) throw new Error('Electron peer unexpectedly installed');
  // Verify the actual installed bundled dependency against its sealed source.
  for (const entry of source.manifest.files.filter(file => file.path.startsWith('node_modules/tslib/'))) {
    const target = path.join(packageRoot, entry.path);
    const bytes = regular(target);
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error('Installed bundled dependency changed: ' + entry.path);
  }
  const stagedFiles = participant.stagedFiles;
  if (!Array.isArray(stagedFiles) || hash(JSON.stringify(stagedFiles)) !== participant.stagedFilesSha256 || JSON.stringify(files(packageRoot)) !== JSON.stringify(stagedFiles.map(entry => entry.path))) throw new Error('Installed package file inventory differs from the exact npm stage');
  for (const entry of stagedFiles) {
    const bytes = regular(path.join(packageRoot, entry.path));
    if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error('Installed package file differs from npm stage: ' + entry.path);
  }
  return { packageRoot, dist: path.join(packageRoot, 'dist'), resolvedEntrypoint: resolvedMain, resolvedMain, resolvedPackageJson: resolvedMetadata, installedManifestSha256, installedPackageJsonSha256: hash(regular(path.join(packageRoot, 'package.json'))), packageLock: lockPath, packageLockSha256: hash(regular(lockPath)), installedSealedPayloads: verification.sealedPayloads };
}
async function packageInstalledCooperativePair(options) {
  if (!DEVELOPMENT.test(options.versionA || '') || !DEVELOPMENT.test(options.versionB || '') || options.versionA === options.versionB) throw new Error('Two distinct x.y.z-development.* prerelease versions are required');
  const a = inspectSdk(options.sdkA), b = inspectSdk(options.sdkB);
  if (inside(a.root, b.root) || inside(b.root, a.root)) throw new Error('SDK sources must be independent directories');
  if (a.javascriptGraphSha256 === b.javascriptGraphSha256 || a.native.some((native, index) => native.addonBuildId === b.native[index].addonBuildId || native.addonSha256 === b.native[index].addonSha256 || native.runtimeGeneration === b.native[index].runtimeGeneration)) throw new Error('Distinct JavaScript and native implementations/generations are required; labels alone are insufficient');
  if (!options.output) throw new Error('A new --output directory is required');
  const output = noLinks(options.output);
  for (const source of [a.root, b.root]) if (inside(source, output) || inside(output, source)) throw new Error('Output must not overlap either SDK source');
  if (fs.existsSync(output)) throw new Error('Output directory must be new and absent');
  const cli = npmCli();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const reportPath = path.join(output, 'report.json');
  const report = { schemaVersion: 1, kind: 'electron-game-overlay-installed-development-pair', status: 'failed', scope: 'Offline npm packaging and independent installation of two development snapshots; not released-package or native/game acceptance', developmentOnly: true, releasedPackageCompatibilityClaimed: false, independentlyReleasedPackagesVerified: false, nativeExecuted: false, output, reportPath, commands: [], participants: {} };
  try {
    fs.writeFileSync(path.join(output, 'empty-user.npmrc'), '', { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'empty-global.npmrc'), '', { flag: 'wx' });
    for (const [id, source, version] of [['a', a, options.versionA], ['b', b, options.versionB]]) {
      const participant = stageParticipant(id, source, version, output);
      report.participants[id] = participant;
      const archiveRoot = path.join(output, 'archives', id);
      fs.mkdirSync(archiveRoot, { recursive: true });
      const packed = runNpm(cli, ['pack', '--json', '--pack-destination', archiveRoot], participant.stagedRoot, output, report);
      if (!Array.isArray(packed) || packed.length !== 1 || path.basename(packed[0].filename || '') !== packed[0].filename || packed[0].name !== 'electron-game-overlay' || packed[0].version !== version) throw new Error('Unexpected npm pack archive identity');
      const pack = packed[0];
      if (JSON.stringify(pack.files.map(file => file.path).sort(compare)) !== JSON.stringify(files(participant.stagedRoot))) throw new Error('npm pack file inventory differs from the exact stage');
      participant.tarball = path.join(archiveRoot, pack.filename);
      participant.tarballSha256 = hash(regular(participant.tarball));
      participant.npmIntegrity = 'sha512-' + crypto.createHash('sha512').update(regular(participant.tarball)).digest('base64');
      if (pack.integrity !== participant.npmIntegrity) throw new Error('npm pack integrity does not match actual tarball bytes');
      participant.packFiles = pack.files.map(file => file.path).sort(compare);
      participant.consumerRoot = path.join(output, 'consumer-' + id);
      fs.mkdirSync(participant.consumerRoot);
      writeJson(path.join(participant.consumerRoot, 'package.json'), { name: 'cooperative-development-consumer-' + id, version: '0.0.0', private: true });
      runNpm(cli, ['install', '--json', '--save-exact', '--legacy-peer-deps', '--package-lock=true', participant.tarball], participant.consumerRoot, output, report);
      Object.assign(participant, await verifyInstalledParticipant(participant, source));
    }
    for (const source of [a, b]) {
      if (hash(regular(source.metadataPath)) !== source.metadataSha256 || hash(regular(path.join(source.dist, 'overlay-manifest.json'))) !== source.manifestSha256) throw new Error('Source metadata/seal changed during packaging');
      const validated = validateOverlayDistributionSync(source.dist, source.metadata.version);
      if (JSON.stringify(validated) !== JSON.stringify(source.manifest)) throw new Error('Source distribution changed during packaging');
    }
    if (report.participants.a.packageRoot === report.participants.b.packageRoot || report.participants.a.packageLock === report.participants.b.packageLock) throw new Error('Consumer installations are not independent');
    report.status = 'passed';
  } catch (error) { report.error = error.message; throw Object.assign(error, { report }); }
  finally { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  return report;
}
async function main(argv = process.argv.slice(2)) {
  const options = { 'sdk-a': { type: 'string' }, 'sdk-b': { type: 'string' }, 'version-a': { type: 'string' }, 'version-b': { type: 'string' }, output: { type: 'string' } };
  const { values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  for (const name of Object.keys(options)) if (!values[name]) throw new Error('--' + name + ' is required');
  return packageInstalledCooperativePair({ sdkA: values['sdk-a'], sdkB: values['sdk-b'], versionA: values['version-a'], versionB: values['version-b'], output: values.output });
}
module.exports = { inspectSdk, packageInstalledCooperativePair, verifyInstalledParticipant, main };
if (require.main === module) main().then(report => console.log(JSON.stringify(report))).catch(error => { console.error(error.message); if (error.report) console.log(JSON.stringify(error.report)); process.exitCode = 1; });
