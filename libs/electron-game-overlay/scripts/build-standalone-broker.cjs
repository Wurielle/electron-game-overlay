const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const BUILD_NODE_VERSION = '26.12.1';
const sdkRoot = path.resolve(__dirname, '..');

function copyTree(source, destination, include = () => true) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symbolic link: ${from}`);
    if (entry.isDirectory()) copyTree(from, to, include);
    else if (entry.isFile() && include(entry.name)) fs.copyFileSync(from, to);
    else if (!entry.isFile()) throw new Error(`Not a regular asset: ${from}`);
  }
}

function fileManifest(root, prefix = '') {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${prefix}${entry.name}`;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) return fileManifest(file, `${relative}/`);
      const bytes = fs.readFileSync(file);
      return [
        {
          path: relative,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function validateRuntime(runtimeDir) {
  const reshade = path.join(runtimeDir, 'win32-x64/reshade');
  const required = ['ReShade.ini'];
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    required.push(
      `electron_game_overlay.addon${bits}`,
      `electron_game_overlay_reshade_manager${suffix}.exe`,
      `electron_game_overlay_runtime${suffix}.build.json`,
      `inject${suffix}.exe`,
      `ReShade${bits}.build.json`,
      `ReShade${bits}.dll`,
    );
  }
  for (const name of required) {
    const file = path.join(reshade, name);
    if (
      !fs.existsSync(file) ||
      !fs.lstatSync(file).isFile() ||
      fs.statSync(file).size === 0
    ) {
      throw new Error(
        `Required runtime asset missing or not a nonempty regular file: ${file}`,
      );
    }
  }
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    let stamp;
    try {
      stamp = JSON.parse(
        fs.readFileSync(
          path.join(
            reshade,
            `electron_game_overlay_runtime${suffix}.build.json`,
          ),
          'utf8',
        ),
      );
    } catch {
      throw new Error(`Runtime build manifest invalid for ${bits}-bit payload`);
    }
    const assets = {
      addonSha256: `electron_game_overlay.addon${bits}`,
      managerSha256: `electron_game_overlay_reshade_manager${suffix}.exe`,
      injectorSha256: `inject${suffix}.exe`,
      reshadeRuntimeSha256: `ReShade${bits}.dll`,
      reshadeConfigSha256: 'ReShade.ini',
      reshadeBuildStampSha256: `ReShade${bits}.build.json`,
    };
    for (const [field, name] of Object.entries(assets)) {
      const actual = createHash('sha256')
        .update(fs.readFileSync(path.join(reshade, name)))
        .digest('hex');
      if (
        typeof stamp[field] !== 'string' ||
        actual !== stamp[field].toLowerCase()
      ) {
        throw new Error(`Runtime SHA-256 integrity mismatch: ${name}`);
      }
    }
  }
}

function buildStandaloneBroker({
  outputDir = path.join(
    sdkRoot,
    'dist/broker',
    `${process.platform}-${process.arch}`,
  ),
  runtimeDir = path.join(sdkRoot, 'dist/runtime'),
  libDir = path.join(sdkRoot, 'dist/lib'),
} = {}) {
  if (process.versions.node !== BUILD_NODE_VERSION)
    throw new Error(
      `Standalone broker builds require Node ${BUILD_NODE_VERSION}; received ${process.versions.node}`,
    );
  if (!['win32', 'linux'].includes(process.platform))
    throw new Error(
      `Unsupported standalone broker build platform: ${process.platform}`,
    );
  outputDir = path.resolve(outputDir);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`))
    );
  };
  const sources = [path.resolve(runtimeDir), path.resolve(libDir)];
  if (
    contains(outputDir, sdkRoot) ||
    sources.some(
      (source) => contains(outputDir, source) || contains(source, outputDir),
    )
  ) {
    throw new Error(
      'Standalone broker output must not overlap the SDK or staged source assets',
    );
  }
  validateRuntime(runtimeDir);
  const executable = `electron-game-overlay-broker${process.platform === 'win32' ? '.exe' : ''}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-broker-build-'));
  const distribution = path.join(work, 'distribution');
  try {
    fs.mkdirSync(distribution);
    fs.writeFileSync(
      path.join(distribution, 'package.json'),
      `${JSON.stringify({ private: true, type: 'commonjs' }, null, 2)}\n`,
    );
    copyTree(libDir, path.join(distribution, 'lib'), (name) =>
      name.endsWith('.js'),
    );
    const tslibRoot = path.dirname(
      require.resolve('tslib/package.json', { paths: [sdkRoot] }),
    );
    const tslibOutput = path.join(distribution, 'node_modules/tslib');
    fs.mkdirSync(tslibOutput, { recursive: true });
    for (const name of [
      'package.json',
      'tslib.js',
      'LICENSE.txt',
      'CopyrightNotice.txt',
    ])
      fs.copyFileSync(path.join(tslibRoot, name), path.join(tslibOutput, name));
    copyTree(runtimeDir, path.join(distribution, 'runtime'));
    const nodeDirectory = path.dirname(fs.realpathSync(process.execPath));
    const nodeLicense = [
      path.join(nodeDirectory, 'LICENSE'),
      path.join(nodeDirectory, '..', 'LICENSE'),
    ].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!nodeLicense) {
      throw new Error(
        'The pinned Node distribution must include its LICENSE file',
      );
    }
    const licenses = path.join(distribution, 'licenses');
    fs.mkdirSync(licenses);
    fs.copyFileSync(nodeLicense, path.join(licenses, 'node.txt'));
    fs.copyFileSync(
      path.resolve(sdkRoot, '../../LICENSE'),
      path.join(licenses, 'electron-game-overlay.txt'),
    );
    const main = path.join(work, 'bootstrap.cjs');
    fs.writeFileSync(
      main,
      "const { createRequire } = require('node:module');\nconst load = createRequire(process.execPath);\nvoid load('./lib/overlay-broker-entry.js').runOverlayBrokerMain();\n",
    );
    const config = path.join(work, 'sea-config.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        main: 'bootstrap.cjs',
        output: path.join(distribution, executable),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: 'none',
      }),
    );
    const result = spawnSync(process.execPath, ['--build-sea', config], {
      cwd: work,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Node --build-sea failed (${result.status}): ${result.stderr || result.stdout}`,
      );
    fs.chmodSync(path.join(distribution, executable), 0o755);
    const manifest = {
      schema: 1,
      version: require('../package.json').version,
      protocolMin: 1,
      protocolMax: 1,
      platform: process.platform,
      arch: process.arch,
      executable,
      files: fileManifest(distribution),
    };
    fs.writeFileSync(
      path.join(distribution, 'broker-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.cpSync(distribution, outputDir, {
      recursive: true,
      preserveTimestamps: false,
    });
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { buildStandaloneBroker };

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        output: { type: 'string' },
        runtime: { type: 'string' },
        lib: { type: 'string' },
      },
    });
    const manifest = buildStandaloneBroker({
      outputDir: values.output,
      runtimeDir: values.runtime,
      libDir: values.lib,
    });
    console.log(
      `ELECTRON_GAME_OVERLAY_BROKER_BUILT platform=${manifest.platform}-${manifest.arch} files=${manifest.files.length}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
