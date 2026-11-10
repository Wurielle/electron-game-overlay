'use strict';
// Controlled parser/archive fixture. PE headers below are inert byte records;
// they are never executed and do not establish native or game acceptance.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function writeCooperativeDistribution(dist, {
  packageVersion = '0.1.0-rc.7',
  addonBuildId = 'CCE20935ADD44EF6A5A7973014B2E07F',
  runtimeGeneration = 23,
  resourceIdentityPatch = runtimeGeneration >= 29,
  compatibilitySnapshotPatch = runtimeGeneration >= 31,
  compatibilitySnapshotPatchSha256 = 'C63E22F1768770469C770FB6D4124AE1A293A6D5ACD8402E8EC86F33B1CA1C66',
  steamLoadedModulePatch = runtimeGeneration >= 30,
  steamLoadedModuleHookOrderPatchSha256 = '560BF8A6DB17643F7FA095F75FDBE0677211FC4354BEB6C869C7D4ECD7DB1241',
  privateStageDiagnosticsPatch = runtimeGeneration >= 30,
  injectorPrivateStageDiagnosticsPatchSha256 = 'D73FF95608079571FC6438F8B5E280BB710AD8467F19CA31B664E371929C05F1',
  d3d11SwapchainResourceIdentityPatchSha256 = '25DA093F15FAACF74AA16ED0BFFA233B58D10C7FC1BEA15B667C0E9F5F6AAEF2',
  addonPreloadProtocol = runtimeGeneration >= 17 ? 1 : undefined,
  reshadeSchemaVersion = runtimeGeneration >= 15 ? 30 : 29,
  ownedLateD3d11PatchSha256 = '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE',
  firstHostResultPatch = runtimeGeneration >= 15,
  injectorFirstHostResultPatchSha256 = 'B68368696902CF556A0540328E76FFFE81A0C7348504F9AA678B9DCE91B1B554',
  injectorAddonPreloadPatchSha256 = 'E23FB34118EA5F39D1B2AD19ECAD3049099407D00F125892C6FF455EC7155F5D',
  preloadedFirstHostPatch = runtimeGeneration >= 19,
  injectorPreloadedFirstHostPatchSha256 = 'A8C494EF02E08E5084D7EDC27ABCB73639C18D23469F244F99F090A27DB46309',
  preloadLongPathPatch = runtimeGeneration >= 20,
  injectorPreloadLongPathPatchSha256 = 'FFFF684D2E60D36F1CEC4D073B91A014B7F497A50C4F5B00F7B7F2A57714397B',
  adapterReadyLongPathPatch = runtimeGeneration >= 21,
  ownedLateD3d11AdapterReadyLongPathPatchSha256 = 'BCC0F0CD455B80DB3ED6D850B63600116B1D9881F1C85602CF76CEF7B23C35A6',
  initialInspectionRecoveryPatch = runtimeGeneration >= 22,
  injectorInitialInspectionRecoveryPatchSha256 = '5E9E7D2C8A2EE66F9A478CA193B5962C4F635943D040B121593AD70A3177D8A7',
  sharedAddonDirectoryPatch = runtimeGeneration >= 23,
  injectorSharedAddonDirectoryPatchSha256 = '54AE1F9ABCE02CBB66481C7C2AB30E4D3E7925CD83F27F31D8551D76DEF85125',
  foreignAddonIsolationPatch = runtimeGeneration >= 23,
  inspectionContextPatch = runtimeGeneration >= 24,
  injectorInspectionContextPatchSha256 = '288C2A76AEDBC827BB00117A455FFE87ECB708CA33411449CD56E2BEA190160E',
  selectionBeforeOpenPatch = runtimeGeneration >= 25,
  injectorSelectionBeforeOpenPatchSha256 = 'F83053E59EE9443E98D31A4C238B3D19D6B847D1F6F5E238E05B899FFC87E555',
  memberDiagnosticsPatch = runtimeGeneration >= 26,
  injectorMemberDiagnosticsPatchSha256 = 'D56162D2EA444DB44E7F21128A5F316E124E11E08EC1B6F3328D769EA4048A57',
  startupReadinessPatch = runtimeGeneration >= 26,
  elevatedPrivatePatch = runtimeGeneration >= 27,
  elevatedPrivatePatchSha256 = 'DF33E210E32A3994866ECDA8F6B0461C113A3F27DEC1A79133D4D0AF347B9697',
  injectorStartupReadinessPatchSha256 = '29C8D7ACA8919189D484B2E22F83DBD564B00D344E8C860058AFCCEAFC808D9D',
  ownedLateD3d11ForeignAddonIsolationPatchSha256 = '2A1FF13D7F76258ECF9D5CFB565D68C2522BEE772053A5373A3645823D310F99',
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
  for (const name of ['index', 'broker', 'packaging', 'preload']) {
    write(`${name}.js`, 'module.exports = {};\n');
    write(`${name}.d.ts`, 'export {};\n');
  }
  write('lib/module.js', '// controlled compiled SDK module\n');
  write('lib/reshade-launcher.js', `const OFFICIAL_ADDON_BUILD_ID = '${addonBuildId}';\n`);
  write('lib/overlay-broker-protocol.js', `exports.OVERLAY_BROKER_RUNTIME_GENERATION = ${runtimeGeneration};\n`);
  write('lib/overlay-package-manifest.js', (compatibilitySnapshotPatch
    ? `const COMPATIBILITY_SNAPSHOT_PATCH_SHA256 = '${compatibilitySnapshotPatchSha256}';\n`
    : '') + (steamLoadedModulePatch
    ? `const STEAM_LOADED_MODULE_HOOK_ORDER_PATCH_SHA256 = '${steamLoadedModuleHookOrderPatchSha256}';\n`
    : '') + (privateStageDiagnosticsPatch
    ? `const PRIVATE_STAGE_DIAGNOSTICS_PATCH_SHA256 = '${injectorPrivateStageDiagnosticsPatchSha256}';\n`
    : '') + (resourceIdentityPatch
    ? `const D3D11_SWAPCHAIN_RESOURCE_IDENTITY_PATCH_SHA256 = '${d3d11SwapchainResourceIdentityPatchSha256}';\n`
    : '') + (firstHostResultPatch
    ? `const INJECTOR_FIRST_HOST_RESULT_PATCH_SHA256 = '${injectorFirstHostResultPatchSha256}';\n`
    : '// Controlled retained validator fixture without the later CLI implementation pin\n') +
    (addonPreloadProtocol === 1
      ? `const INJECTOR_ADDON_PRELOAD_PATCH_SHA256 = '${injectorAddonPreloadPatchSha256}';\n`
      : '') +
    (preloadedFirstHostPatch
      ? `const INJECTOR_PRELOADED_FIRST_HOST_PATCH_SHA256 = '${injectorPreloadedFirstHostPatchSha256}';\n`
      : '') +
    (preloadLongPathPatch
      ? `const INJECTOR_PRELOAD_LONG_PATH_PATCH_SHA256 = '${injectorPreloadLongPathPatchSha256}';\n`
      : '') +
    (adapterReadyLongPathPatch
      ? `const OWNED_LATE_D3D11_ADAPTER_READY_LONG_PATH_PATCH_SHA256 = '${ownedLateD3d11AdapterReadyLongPathPatchSha256}';\n`
      : '') +
    (initialInspectionRecoveryPatch
      ? `const INJECTOR_INITIAL_INSPECTION_RECOVERY_PATCH_SHA256 = '${injectorInitialInspectionRecoveryPatchSha256}';\n`
      : '') +
    (sharedAddonDirectoryPatch
      ? `const INJECTOR_SHARED_ADDON_DIRECTORY_PATCH_SHA256 = '${injectorSharedAddonDirectoryPatchSha256}';\n`
      : '') +
    (foreignAddonIsolationPatch
      ? `const OWNED_LATE_D3D11_FOREIGN_ADDON_ISOLATION_PATCH_SHA256 = '${ownedLateD3d11ForeignAddonIsolationPatchSha256}';\n`
      : '') +
    (inspectionContextPatch
      ? `const INJECTOR_INSPECTION_CONTEXT_PATCH_SHA256 = '${injectorInspectionContextPatchSha256}';\n`
      : '') +
    (selectionBeforeOpenPatch
      ? `const INJECTOR_SELECTION_BEFORE_OPEN_PATCH_SHA256 = '${injectorSelectionBeforeOpenPatchSha256}';\n`
      : '') +
    (memberDiagnosticsPatch
      ? `const INJECTOR_MEMBER_DIAGNOSTICS_PATCH_SHA256 = '${injectorMemberDiagnosticsPatchSha256}';\n`
      : '') +
    (elevatedPrivatePatch ? `const INJECTOR_ELEVATED_PRIVATE_PATCH_SHA256 = '${elevatedPrivatePatchSha256}';
` : '') +
    (startupReadinessPatch
      ? `const INJECTOR_STARTUP_READINESS_PATCH_SHA256 = '${injectorStartupReadinessPatchSha256}';\n`
      : ''));
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
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      };
      const previousReShade = read(reshadeName);
      const previousPackage = read(packageName);
      json(runtime + reshadeName, {
        ...(previousReShade ?? {
        schemaVersion: reshadeSchemaVersion, commit: '4a50d1eddace85734871d91792ff214f13f66c01',
        ...(reshadeSchemaVersion === 30 ? { ownedLateD3d11PatchSha256 } : {}),
        ...(firstHostResultPatch ? { injectorFirstHostResultPatchSha256 } : {}),
        ...(addonPreloadProtocol === undefined ? {} : { addonPreloadProtocol }),
        ...(addonPreloadProtocol === 1 ? { injectorAddonPreloadPatchSha256 } : {}),
        ...(preloadedFirstHostPatch ? { injectorPreloadedFirstHostPatchSha256 } : {}),
        ...(preloadLongPathPatch ? { injectorPreloadLongPathPatchSha256 } : {}),
        ...(adapterReadyLongPathPatch ? { ownedLateD3d11AdapterReadyLongPathPatchSha256 } : {}),
        ...(initialInspectionRecoveryPatch ? { injectorInitialInspectionRecoveryPatchSha256 } : {}),
        ...(sharedAddonDirectoryPatch ? { injectorSharedAddonDirectoryPatchSha256 } : {}),
        ...(foreignAddonIsolationPatch ? { ownedLateD3d11ForeignAddonIsolationPatchSha256 } : {}),
        ...(inspectionContextPatch ? { injectorInspectionContextPatchSha256 } : {}),
        ...(selectionBeforeOpenPatch ? { injectorSelectionBeforeOpenPatchSha256 } : {}),
        ...(memberDiagnosticsPatch ? { injectorMemberDiagnosticsPatchSha256 } : {}),
        ...(startupReadinessPatch ? { injectorStartupReadinessPatchSha256 } : {}),
        ...(elevatedPrivatePatch ? { injectorElevatedPrivatePatchSha256: elevatedPrivatePatchSha256 } : {}),
        ...(resourceIdentityPatch ? { d3d11SwapchainResourceIdentityPatchSha256 } : {}),
        ...(privateStageDiagnosticsPatch ? { injectorPrivateStageDiagnosticsPatchSha256 } : {}),
        ...(steamLoadedModulePatch ? { steamLoadedModuleHookOrderPatchSha256 } : {}),
        ...(compatibilitySnapshotPatch ? { compatibilitySnapshotPatchSha256 } : {}),
        cooperativeAddonProtocol: 1, injectorProcessInstanceBinding: 1, injectorFutureTargets: 2,
        configuration: 'Release', platform: bits === 64 ? '64-bit' : '32-bit', addonLevel: 2,
        }),
        runtimeSha256: digest(`ReShade${bits}.dll`), injectorSha256: digest(`inject${suffix}.exe`),
      });
      json(runtime + packageName, {
        ...(previousPackage ?? {
        schemaVersion: 4, kind: 'electron-game-overlay-runtime-build',
        platform: bits === 64 ? 'win32-x64' : 'win32-ia32', configuration: 'RelWithDebInfo',
        addonBuildId, cooperativeAddonProtocol: 1, injectorProcessInstanceBinding: 1,
        ...(runtimeGeneration>=27?{privateElevatedAuthorization:runtimeGeneration>=28?2:1}:{}),
        ...(addonPreloadProtocol === undefined ? {} : { addonPreloadProtocol }),
        injectorFutureTargets: 2, managerProtocolSchemaVersion: 1, runtimeGeneration,
        targetTransportMin: 1, targetTransportMax: 1, managerSourceSha256: sha('controlled manager source'),
        }),
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
