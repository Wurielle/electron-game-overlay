'use strict';
// Controlled parser/archive fixture. PE headers below are inert byte records;
// they are never executed and do not establish native or game acceptance.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function writeCooperativeDistribution(dist, {
  packageVersion = '0.1.0-rc.7',
  addonBuildId = '412D57BEA49440738CC4C3903038F2E7',
  runtimeGeneration = 14,
} = {}) {
  dist = path.resolve(dist);
  fs.mkdirSync(dist, { recursive: true });
  const write = (file, bytes) => {
    const target = path.resolve(dist, file);
    if (!target.startsWith(dist + path.sep)) throw new Error('Fixture writes must remain inside its distribution');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
  const pe = machine => {
    const bytes = Buffer.alloc(128);
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60);
    bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(machine, 68);
    return bytes;
  };
  for (const name of ['index', 'broker', 'packaging']) {
    write(`${name}.js`, 'module.exports = {};\n');
    write(`${name}.d.ts`, 'export {};\n');
  }
  write('lib/module.js', '// controlled compiled SDK module\n');
  write('lib/reshade-launcher.js', `const OFFICIAL_ADDON_BUILD_ID = '${addonBuildId}';\n`);
  json('node_modules/tslib/package.json', { name: 'tslib', version: '2.8.1', main: 'tslib.js' });
  write('node_modules/tslib/tslib.js', '// controlled dependency, never executed\n');
  write('node_modules/tslib/LICENSE.txt', 'Controlled immutable dependency license\n');
  write('node_modules/tslib/CopyrightNotice.txt', 'Controlled immutable dependency notice\n');
  write('runtime/THIRD-PARTY-NOTICES.txt', 'Controlled native runtime notice\n');
  const runtime = 'runtime/win32-x64/reshade/';
  write(runtime + 'ReShade.ini', '[ADDON]\nAddonPath=.\n');
  for (const bits of [64, 32]) {
    const suffix = bits === 64 ? '' : '32';
    const machine = bits === 64 ? 0x8664 : 0x14c;
    for (const name of [
      `electron_game_overlay.addon${bits}`,
      `electron_game_overlay_reshade_manager${suffix}.exe`,
      `inject${suffix}.exe`, `ReShade${bits}.dll`,
    ]) write(runtime + name, pe(machine));
  }
  const digest = file => sha(fs.readFileSync(path.join(dist, runtime, file)));
  function bindNativeHashes() {
    for (const bits of [64, 32]) {
      const suffix = bits === 64 ? '' : '32';
      const reshadeName = `ReShade${bits}.build.json`;
      const packageName = `electron_game_overlay_runtime${suffix}.build.json`;
      const read = name => {
        try { return JSON.parse(fs.readFileSync(path.join(dist, runtime, name), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
      };
      json(runtime + reshadeName, {
        schemaVersion: 29, commit: '4a50d1eddace85734871d91792ff214f13f66c01',
        cooperativeAddonProtocol: 1, injectorProcessInstanceBinding: 1, injectorFutureTargets: 2,
        configuration: 'Release', platform: bits === 64 ? '64-bit' : '32-bit', addonLevel: 2,
        ...read(reshadeName),
        runtimeSha256: digest(`ReShade${bits}.dll`), injectorSha256: digest(`inject${suffix}.exe`),
      });
      json(runtime + packageName, {
        schemaVersion: 4, kind: 'electron-game-overlay-runtime-build',
        platform: bits === 64 ? 'win32-x64' : 'win32-ia32', configuration: 'RelWithDebInfo',
        addonBuildId, cooperativeAddonProtocol: 1, injectorProcessInstanceBinding: 1,
        injectorFutureTargets: 2, managerProtocolSchemaVersion: 1, runtimeGeneration,
        targetTransportMin: 1, targetTransportMax: 1, managerSourceSha256: sha('controlled manager source'),
        ...read(packageName),
        addonSha256: digest(`electron_game_overlay.addon${bits}`),
        managerSha256: digest(`electron_game_overlay_reshade_manager${suffix}.exe`),
        injectorSha256: digest(`inject${suffix}.exe`),
        reshadeRuntimeSha256: digest(`ReShade${bits}.dll`), reshadeConfigSha256: digest('ReShade.ini'),
        reshadeBuildStampSha256: digest(reshadeName),
      });
    }
  }
  bindNativeHashes();
  const manifestPath = path.join(dist, 'overlay-manifest.json');
  let manifest;
  function seal() {
    const files = [];
    function visit(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (name === 'overlay-manifest.json') continue;
        if (entry.isSymbolicLink()) throw new Error('Fixture manifest refuses symbolic payloads');
        if (entry.isDirectory()) visit(path.join(directory, entry.name), name + '/');
        else {
          const bytes = fs.readFileSync(path.join(directory, entry.name));
          files.push({ path: name, size: bytes.length, sha256: sha(bytes) });
        }
      }
    }
    visit(dist);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    manifest = { schema: 1, kind: 'electron-game-overlay-sdk-distribution', packageVersion, files };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  }
  seal();
  return {
    dist, manifestPath, write, seal, bindNativeHashes,
    get manifest() { return manifest; },
    get files() { return manifest.files; },
  };
}
module.exports = { writeCooperativeDistribution };
