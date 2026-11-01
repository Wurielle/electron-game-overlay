'use strict';

// The game fixture executes the installed public entrypoint only after these
// read-only checks. The verifier itself is trusted workspace tooling.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { validateOverlayDistributionSync } = require('../../../libs/electron-game-overlay/dist/lib/overlay-package-manifest.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function regularPath(filename, directory = false) {
  const absolute = path.resolve(filename);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Installed package path contains a symbolic link or junction: ${cursor}`);
  }
  const info = fs.lstatSync(absolute);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(`Unexpected installed package path type: ${absolute}`);
  return fs.realpathSync(absolute);
}

function readJson(filename) {
  const file = regularPath(filename);
  const info = fs.statSync(file);
  if (info.size <= 0 || info.size > 4 * 1024 * 1024) throw new Error('Installed package metadata size is out of bounds.');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
}

function inspectInstalledCooperativeSdk(consumerRoot) {
  if (typeof consumerRoot !== 'string' || !path.isAbsolute(consumerRoot)) throw new Error('An absolute installed consumer root is required.');
  const consumer = regularPath(consumerRoot, true);
  const consumerPackageJson = regularPath(path.join(consumer, 'package.json'));
  readJson(consumerPackageJson);
  const expectedRoot = regularPath(path.join(consumer, 'node_modules', 'electron-game-overlay'), true);
  const consumerRequire = createRequire(consumerPackageJson);
  const packageJsonPath = regularPath(consumerRequire.resolve('electron-game-overlay/package.json'));
  if (!same(path.dirname(packageJsonPath), expectedRoot)) throw new Error('SDK metadata resolved outside this consumer installation.');
  const metadata = readJson(packageJsonPath);
  if (metadata.name !== 'electron-game-overlay' || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+-development\.[0-9A-Za-z.-]+$/u.test(metadata.version)) {
    throw new Error('Installed mixed-version acceptance requires an explicitly labeled development SDK package.');
  }
  if (metadata.main !== './dist/index.js' || metadata.exports?.['.']?.require !== './dist/index.js' || metadata.exports?.['./package.json'] !== './package.json') {
    throw new Error('The installed package public entrypoint metadata does not target its sealed SDK.');
  }
  const sdkDist = regularPath(path.join(expectedRoot, 'dist'), true);
  const entrypoint = regularPath(consumerRequire.resolve('electron-game-overlay'));
  if (!same(entrypoint, regularPath(path.join(sdkDist, 'index.js')))) throw new Error('The installed package public entrypoint does not resolve to its sealed SDK.');
  const manifest = validateOverlayDistributionSync(sdkDist, metadata.version);
  for (const entry of manifest.files.filter(file => file.path.startsWith('node_modules/tslib/'))) {
    const dependency = regularPath(path.join(expectedRoot, entry.path));
    const info = fs.statSync(dependency);
    if (info.size !== entry.size || info.size > 32 * 1024 * 1024 || sha(fs.readFileSync(dependency)) !== entry.sha256) {
      throw new Error('Installed bundled dependency differs from its sealed SDK payload.');
    }
  }
  return {
    schemaVersion: 1,
    consumerRoot: consumer,
    packageRoot: expectedRoot,
    packageJsonPath,
    packageVersion: metadata.version,
    sdkDist,
    entrypoint,
    entrySha256: sha(fs.readFileSync(entrypoint)),
    installedManifestSha256: sha(fs.readFileSync(path.join(sdkDist, 'overlay-manifest.json'))),
    sealedFilesSha256: sha(JSON.stringify(manifest.files)),
    payloadFiles: manifest.files.length,
    bundledDependencyMatchesSealedPayload: true,
    loadMethod: "createRequire(consumer/package.json)('electron-game-overlay')",
    releasedPackageCompatibilityClaimed: false,
  };
}

function loadInstalledCooperativeSdk(consumerRoot) {
  const evidence = inspectInstalledCooperativeSdk(consumerRoot);
  // This is the only SDK load boundary. No repository SDK or absolute-index
  // fallback is permitted when the installed package cannot be loaded.
  const consumerRequire = createRequire(path.join(evidence.consumerRoot, 'package.json'));
  const sdk = consumerRequire('electron-game-overlay');
  if (require.cache[evidence.entrypoint]?.exports !== sdk) throw new Error('The installed package entrypoint did not supply the loaded SDK.');
  return { evidence, sdk };
}

function inspectInstalledPairReport(filename) {
  const reportPath = regularPath(filename);
  const report = readJson(reportPath);
  if (report.schemaVersion !== 1 || report.kind !== 'electron-game-overlay-installed-development-pair' || report.status !== 'passed' || report.releasedPackageCompatibilityClaimed !== false) {
    throw new Error('Expected a successful installed development-pair provenance report.');
  }
  const participants = {};
  for (const member of ['a', 'b']) {
    const record = report.participants?.[member];
    if (!record || typeof record.consumerRoot !== 'string') throw new Error(`Missing installed participant ${member}.`);
    const observed = inspectInstalledCooperativeSdk(record.consumerRoot);
    for (const [expected, actual] of [[record.packageRoot, observed.packageRoot], [record.dist, observed.sdkDist]]) {
      if (typeof expected !== 'string' || !same(fs.realpathSync(expected), actual)) throw new Error(`Participant ${member} installed path differs from package provenance.`);
    }
    if (record.version !== observed.packageVersion || record.installedManifestSha256 !== observed.installedManifestSha256) {
      throw new Error(`Participant ${member} installed version or seal differs from package provenance.`);
    }
    if (record.stagedManifestSha256 !== observed.installedManifestSha256 ||
        record.installedPackageJsonSha256 !== sha(fs.readFileSync(observed.packageJsonPath)) ||
        typeof record.resolvedEntrypoint !== 'string' || !same(regularPath(record.resolvedEntrypoint), observed.entrypoint)) {
      throw new Error(`Participant ${member} installed package metadata or entrypoint changed after npm installation.`);
    }
    const originalSealPath = regularPath(path.join(observed.packageRoot, 'SOURCE_OVERLAY_MANIFEST.json'));
    const originalMetadataPath = regularPath(path.join(observed.packageRoot, 'SOURCE_PACKAGE.json'));
    const provenancePath = regularPath(path.join(observed.packageRoot, 'SDK_PROVENANCE.json'));
    const originalSeal = readJson(originalSealPath);
    const originalMetadata = readJson(originalMetadataPath);
    const provenance = readJson(provenancePath);
    if (record.sourceManifestSha256 !== sha(fs.readFileSync(originalSealPath)) ||
        record.sourcePackageJsonSha256 !== sha(fs.readFileSync(originalMetadataPath)) ||
        record.provenanceSha256 !== sha(fs.readFileSync(provenancePath)) ||
        record.sourcePackageVersion !== originalSeal.packageVersion || originalMetadata.version !== originalSeal.packageVersion ||
        record.sourceSealedFilesSha256 !== observed.sealedFilesSha256 || sha(JSON.stringify(originalSeal.files)) !== observed.sealedFilesSha256 ||
        provenance.transform?.sealedPayloadBytesChanged !== false || provenance.transform?.sealedFilesInventoryChanged !== false ||
        provenance.source?.overlayManifestSha256 !== record.sourceManifestSha256 || provenance.source?.packageVersion !== record.sourcePackageVersion) {
      throw new Error(`Participant ${member} no longer proves unchanged source payloads and its explicit development metadata transform.`);
    }
    participants[member] = observed;
  }
  if (same(participants.a.consumerRoot, participants.b.consumerRoot) || same(participants.a.packageRoot, participants.b.packageRoot) || participants.a.packageVersion === participants.b.packageVersion) {
    throw new Error('Two independently installed, distinctly versioned SDK packages are required.');
  }
  return { schemaVersion: 1, kind: 'electron-game-overlay-installed-pair-observation', reportPath,
    reportSha256: sha(fs.readFileSync(reportPath)), participants, releasedPackageCompatibilityClaimed: false };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--pair-report') throw new Error('Expected --pair-report <absolute report.json>.');
    process.stdout.write(JSON.stringify(inspectInstalledPairReport(path.resolve(args[1])), null, 2) + '\n');
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}

module.exports = { inspectInstalledCooperativeSdk, loadInstalledCooperativeSdk, inspectInstalledPairReport };
