'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sdkRoot = path.resolve(__dirname, '..');
const dist = path.join(sdkRoot, 'dist');

function copyDependency(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Dependency payload symlink refused: ' + source);
  if (fs.existsSync(destination)) {
    const target = fs.lstatSync(destination);
    if (target.isSymbolicLink() || (stat.isDirectory() && !target.isDirectory())) {
      throw new Error('Sealed dependency destination is not regular: ' + destination);
    }
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyDependency(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) {
    if (fs.existsSync(destination)) {
      const current = fs.lstatSync(destination);
      if (!current.isFile() || current.isSymbolicLink() || !fs.readFileSync(destination).equals(fs.readFileSync(source))) {
        throw new Error('Existing sealed dependency differs; clean the SDK dist first: ' + destination);
      }
    } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else throw new Error('Dependency payload is not a regular file: ' + source);
}

function sealSdkDistribution() {
  if (!fs.lstatSync(dist).isDirectory() || fs.lstatSync(dist).isSymbolicLink()) throw new Error('SDK dist must be a regular directory');
  const source = fs.realpathSync(path.dirname(require.resolve('tslib/package.json')));
  for (const directory of [path.join(dist, 'node_modules'), path.join(dist, 'node_modules/tslib')]) {
    if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) {
      throw new Error('Sealed dependency directory must be regular: ' + directory);
    }
  }
  copyDependency(source, path.join(dist, 'node_modules/tslib'));
  const { createOverlayDistributionManifestSync, validateOverlayDistributionSync, OVERLAY_DISTRIBUTION_MANIFEST_FILE_NAME } =
    require(path.join(dist, 'lib/overlay-package-manifest.js'));
  const version = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;
  const manifest = createOverlayDistributionManifestSync(dist, version);
  const temporary = path.join(dist, '.overlay-manifest-' + crypto.randomUUID() + '.tmp');
  const manifestPath = path.join(dist, OVERLAY_DISTRIBUTION_MANIFEST_FILE_NAME);
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, manifestPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  validateOverlayDistributionSync(dist, version);
  return { files: manifest.files.length, manifestPath };
}

module.exports = { sealSdkDistribution };
if (require.main === module) {
  try { console.log('ELECTRON_GAME_OVERLAY_SDK_SEALED ' + JSON.stringify(sealSdkDistribution())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
