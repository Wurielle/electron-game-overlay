'use strict';
// node package-sdk.cjs --package-root <leaf> --built-dist <dist> --output <directory>
// [--version X.Y.Z[-{nightly,rc,alpha,beta}.N]]. Produces a report, retained stage and tgz.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function tree(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`Symbolic link refused: ${relative}`);
    if (entry.isDirectory()) return tree(path.join(root, entry.name), relative + '/');
    if (!entry.isFile()) throw Error(`Nonregular file refused: ${relative}`);
    return [relative];
  });
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
  if (!found) throw Error('npm JavaScript CLI not found beside Node or on PATH');
  return found;
}
function main() {
  const report = { schema: 1, status: 'failed', stage: 'setup', nativeExecuted: false, stageRoot: null, tarball: null };
  let reportPath;
  try {
    // Use the effective parsed values for every path decision, including repeated options.
    // Defer strict validation until safe destinations have failure-default evidence.
    const options = { 'package-root': { type: 'string' }, 'built-dist': { type: 'string' }, output: { type: 'string' }, version: { type: 'string', default: '0.1.0-rc.7' }, 'source-commit': { type: 'string' }, 'source-provenance': { type: 'string' } };
    const { values } = parseArgs({ options, strict: false, allowPositionals: true });
    if (typeof values.output !== 'string' || !values.output) throw Error('--output is required');
    const output = path.resolve(values.output);
    const canonical = file => {
      let existing = file;
      const suffix = [];
      while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); const parent = path.dirname(existing); if (parent === existing) throw Error('Cannot resolve output ancestor'); existing = parent; }
      return path.join(fs.realpathSync(existing), ...suffix);
    };
    const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
    for (const key of ['package-root', 'built-dist']) {
      if (typeof values[key] === 'string' && values[key]) {
        const source = canonical(path.resolve(values[key]));
        const destination = canonical(output);
        if (inside(source, destination) || inside(destination, source)) throw Error('Output must not overlap package-root or built-dist; no report written to unsafe destination');
      }
    }
    fs.mkdirSync(output, { recursive: true });
    reportPath = path.join(output, 'sdk-preview-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    parseArgs({ options }); // Validate syntax only; all work uses the values checked above.
    for (const key of ['package-root', 'built-dist']) if (!values[key]) throw Error(`--${key} is required`);
    report.version = values.version;
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:nightly|rc|alpha|beta)\.(0|[1-9][0-9]*))?$/.test(values.version)) throw Error('Version must be X.Y.Z or X.Y.Z-{nightly,rc,alpha,beta}.N');
    if (values['source-commit'] !== undefined && !/^[0-9a-f]{40}$/.test(values['source-commit'])) throw Error('--source-commit must be a full lowercase Git commit');
    let sourceProvenance;
    if (values['source-provenance']) {
      if (values['source-commit']) throw Error('Use source-commit or source-provenance, not both');
      sourceProvenance = readJson(values['source-provenance']);
      if (sourceProvenance.schemaVersion !== 2 || sourceProvenance.version !== values.version ||
          !/^[0-9a-f]{40}$/.test(sourceProvenance.baseCommit || '') ||
          typeof sourceProvenance.workingTreeDirty !== 'boolean') throw Error('Invalid source provenance metadata');
      for (const key of ['sourceSnapshot','sourceManifest']) {
        const artifact = sourceProvenance[key];
        if (!artifact || typeof artifact.file !== 'string' || path.basename(artifact.file) !== artifact.file ||
            !artifact.file || !/^[0-9a-f]{64}$/.test(artifact.sha256 || '')) throw Error('Invalid source provenance artifact');
        const bytes=fs.readFileSync(path.join(path.dirname(values['source-provenance']),artifact.file));
        if (sha(bytes) !== artifact.sha256) throw Error('Source provenance artifact SHA-256 mismatch');
      }
    }
    const pkg = fs.realpathSync(values['package-root']);
    const dist = fs.realpathSync(values['built-dist']);
    const metadata = readJson(path.join(pkg, 'package.json'));
    if (metadata.name !== 'electron-game-overlay' || metadata.private !== true) throw Error('Expected private electron-game-overlay workspace package');
    // Use only this packager's trusted, built validator. Never require a module
    // from --package-root or --built-dist before its bytes have been verified.
    const { validateOverlayDistributionSync } = require('../dist/lib/overlay-package-manifest.js');
    const manifest = validateOverlayDistributionSync(dist, metadata.version);
    const manifestBytes = fs.readFileSync(path.join(dist, 'overlay-manifest.json'));
    metadata.version = values.version;
    metadata.private = false;
    metadata.files = ['dist', 'README.md', 'LICENSE'];
    if (values['source-commit'] || sourceProvenance) metadata.files.push('SDK_PROVENANCE.json');
    delete metadata.exports['.'].gelectron;
    delete metadata.scripts;
    const selected = manifest.files.map(entry => entry.path);
    const exportTargets = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(exportTargets) : [];
    for (const target of [metadata.main, metadata.module, metadata.types, ...exportTargets(metadata.exports)]) {
      if (typeof target !== 'string' || !target.startsWith('./') || (target !== './package.json' && !selected.includes(target.slice(7))) || (target !== './package.json' && !target.startsWith('./dist/'))) throw Error(`Invalid or missing public export: ${target}`);
    }
    const license = [path.join(pkg, 'LICENSE'), path.resolve(pkg, '../../LICENSE')].find(file => fs.existsSync(file));
    for (const file of [license, path.join(pkg, 'README.md')].filter(file => file && fs.existsSync(file))) if (!fs.lstatSync(file).isFile()) throw Error('Symbolic link or nonregular legal/documentation file');
    if (!license) throw Error('Required GPL LICENSE not found');
    const stage = fs.mkdtempSync(path.join(output, 'sdk-stage-'));
    report.stageRoot = stage;
    const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); };
    for (const file of selected) copy(path.join(dist, file), path.join(stage, 'dist', file));
    // A candidate version override changes metadata only in this new stage.
    // The input's sealed implementation bytes and manifest remain untouched.
    const stagedManifestBytes = Buffer.from(JSON.stringify({ ...manifest, packageVersion: values.version }, null, 2) + '\n');
    fs.writeFileSync(path.join(stage, 'dist', 'overlay-manifest.json'), stagedManifestBytes);
    copy(license, path.join(stage, 'LICENSE'));
    if (fs.existsSync(path.join(pkg, 'README.md'))) copy(path.join(pkg, 'README.md'), path.join(stage, 'README.md'));
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
    if (values['source-commit'] || sourceProvenance) {
      const native = [64, 32].map(bits => {
        const stamp = readJson(path.join(dist, 'runtime/win32-x64/reshade', `electron_game_overlay_runtime${bits === 64 ? '' : '32'}.build.json`));
        const reshade = readJson(path.join(dist, 'runtime/win32-x64/reshade', `ReShade${bits}.build.json`));
        return { architecture: bits === 64 ? 'x64' : 'x86', addonBuildId: stamp.addonBuildId, runtimeGeneration: stamp.runtimeGeneration, reshadeCommit: reshade.commit, patchProvenance: Object.fromEntries(Object.entries(reshade).filter(([key]) => key.endsWith('PatchSha256'))) };
      });
      if (sourceProvenance) {
        fs.writeFileSync(path.join(stage, 'SDK_PROVENANCE.json'), JSON.stringify({...sourceProvenance,native},null,2)+'\n');
        report.sourceProvenance = sourceProvenance;
        report.provenanceSha256 = sha(fs.readFileSync(path.join(stage,'SDK_PROVENANCE.json')));
      } else {
      report.sourceCommit = values['source-commit'];
      fs.writeFileSync(path.join(stage, 'SDK_PROVENANCE.json'), JSON.stringify({ schemaVersion: 1, version: values.version, repository: 'https://github.com/Wurielle/electron-game-overlay', sourceCommit: values['source-commit'], native }, null, 2) + '\n');
      }
    }
    validateOverlayDistributionSync(path.join(stage, 'dist'), values.version);
    report.stage = 'pack';
    const command = [npmCli(), 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output];
    const env = { ...process.env, npm_config_ignore_scripts: 'true', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: path.join(output, 'npm-cache'), NODE_OPTIONS: '' };
    const result = spawnSync(process.execPath, command, { cwd: stage, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, shell: false });
    report.command = { executable: process.execPath, args: command, exit: result.status };
    if (result.error || result.status !== 0) throw Error(`npm pack failed: ${result.error?.message || result.stderr}`);
    const packed = JSON.parse(result.stdout)[0];
    report.tarball = path.join(output, packed.filename);
    report.packFiles = packed.files.map(file => file.path).sort();
    const expectedFiles = tree(stage).sort();
    if (JSON.stringify(report.packFiles) !== JSON.stringify(expectedFiles)) throw Error('npm tarball file allowlist differs from staged files');
    if (sha(fs.readFileSync(path.join(stage, 'dist', 'overlay-manifest.json'))) !== sha(stagedManifestBytes)) throw Error('Staged SDK manifest changed');
    for (const entry of manifest.files) {
      if (sha(fs.readFileSync(path.join(stage, 'dist', entry.path))) !== entry.sha256) throw Error(`Staged sealed payload mismatch: ${entry.path}`);
    }
    validateOverlayDistributionSync(path.join(stage, 'dist'), values.version);
    report.sourceManifestSha256 = sha(manifestBytes);
    report.manifestSha256 = sha(stagedManifestBytes);
    report.sealedPayloadCount = manifest.files.length;
    report.tarballSha256 = sha(fs.readFileSync(report.tarball));
    report.status = 'passed';
    report.stage = 'complete';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
if (require.main === module) main();
