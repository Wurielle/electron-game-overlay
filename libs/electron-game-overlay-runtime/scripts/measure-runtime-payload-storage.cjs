'use strict';
// Storage-only gate: hashes retained real payload files, executes no payload.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repository = path.resolve(__dirname, '../../..');
const { stageRuntimePayload } = require(
  path.join(
    repository,
    'libs/electron-game-overlay/dist/lib/runtime-payload-store.js',
  ),
);
const storage = require(
  path.join(
    repository,
    'libs/electron-game-overlay/dist/lib/runtime-stage-storage.js',
  ),
);
const { pruneReShadeRuntimeStorage } = require(
  path.join(
    repository,
    'libs/electron-game-overlay/dist/lib/reshade-launcher.js',
  ),
);
const hash = (file) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
    .toUpperCase();
const readJson = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const specs = [
  [
    'electron_game_overlay_runtime.build.json',
    'ReShade64.dll',
    'inject.exe',
    'electron_game_overlay.addon64',
    'electron_game_overlay_reshade_manager.exe',
    'ReShade64.build.json',
  ],
  [
    'electron_game_overlay_runtime32.build.json',
    'ReShade32.dll',
    'inject32.exe',
    'electron_game_overlay.addon32',
    'electron_game_overlay_reshade_manager32.exe',
    'ReShade32.build.json',
  ],
];
async function validate(files) {
  for (const [stamp, runtime, injector, addon, manager, build] of specs) {
    const manifest = readJson(files.get(stamp));
    for (const [name, key] of [
      [runtime, 'reshadeRuntimeSha256'],
      [injector, 'injectorSha256'],
      [addon, 'addonSha256'],
      [manager, 'managerSha256'],
      [build, 'reshadeBuildStampSha256'],
      ['ReShade.ini', 'reshadeConfigSha256'],
    ]) {
      if (hash(files.get(name)) !== manifest[key])
        throw new Error('Measured payload hash mismatch: ' + name);
    }
  }
}
async function stage(spec, label) {
  const session = path.join(spec.runs, label);
  await fsp.mkdir(session);
  try {
    const runId = crypto.randomUUID();
    await fsp.writeFile(
      path.join(session, '.electron-game-overlay-run.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'electron-game-overlay-reshade-run',
        runId,
        directoryName: label,
        createdAt: new Date().toISOString(),
      }),
      { flag: 'wx' },
    );
    await storage.createRuntimeStorageRecord(session, runId, null);
    const staged = await stageRuntimePayload(
      new Map(spec.sources),
      spec.runs,
      session,
      validate,
    );
    await storage.recordRuntimeStorageArtifacts(session, runId, staged);
  } catch (error) {
    if (
      path.dirname(session) !== spec.runs ||
      fs.realpathSync(session).toLowerCase() !== session.toLowerCase()
    )
      throw new Error('Unsafe failed-stage cleanup');
    await fsp.rm(session, { recursive: true, force: false });
    throw error;
  }
  return session;
}
async function retireUnused(session) {
  // This gate never executes an injector or maps an add-on: all preparations
  // here are positively unused. Production retirement has stricter lifecycle
  // proof and hash/ownership checks in reshade-launcher.ts.
  const owned = readJson(path.join(session, '.electron-game-overlay-run.json'));
  await fsp.writeFile(
    path.join(session, '.electron-game-overlay-run-reclaimable.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'electron-game-overlay-reshade-run-reclaimable',
      runId: owned.runId,
      directoryName: path.basename(session),
      retiredAt: new Date().toISOString(),
      privateImagesUnmapped: true,
    }),
    { flag: 'wx' },
  );
  await storage.compactRuntimeStorageRun(session);
  // Fixture runs are positively unused; disable all OS recovery probes. This
  // metadata-only config invokes no native helper or actor inspection.
  await pruneReShadeRuntimeStorage({
    config: {
      runsRootDirectory: path.dirname(session),
      addonManagerPath: path.join(session, 'must-never-execute.exe'),
    },
    maxRecoveryProbes: 0,
  });
}
function inventory(root) {
  let logical = 0,
    unique = 0,
    allocated = 0,
    files = 0;
  const ids = new Set();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Unexpected test reparse point');
      if (entry.isDirectory()) visit(file);
      else {
        const stat = fs.statSync(file, { bigint: true });
        const id = `${stat.dev}:${stat.ino}`;
        logical += Number(stat.size);
        files++;
        if (!ids.has(id)) {
          ids.add(id);
          unique += Number(stat.size);
          allocated += Number(stat.blocks) * 512;
        }
      }
    }
  }
  visit(root);
  return {
    logicalFileBytes: logical,
    uniqueFileContentBytes: unique,
    uniqueAllocatedBytes: allocated,
    files,
    uniqueFiles: ids.size,
  };
}
async function main() {
  if (process.argv[2] === '--child') {
    const spec = JSON.parse(fs.readFileSync(process.argv[3]));
    await retireUnused(await stage(spec, 'after-node-restart'));
    return;
  }
  const parent = path.join(repository, 'build/runtime-payload-storage');
  await fsp.mkdir(parent, { recursive: true });
  const root = await fsp.mkdtemp(path.join(parent, 'owned-'));
  const runs = path.join(root, 'runs');
  await fsp.mkdir(runs);
  const sources = new Map();
  const dist = path.join(repository, 'libs/electron-game-overlay-runtime/dist');
  for (let i = 0; i < 2; i++) {
    const directory = path.join(dist, i ? 'win32-ia32' : 'win32-x64');
    for (const name of specs[i]) {
      const sourceName =
        name === 'inject32.exe'
          ? 'inject.exe'
          : name === 'electron_game_overlay_runtime32.build.json'
            ? 'electron_game_overlay_runtime.build.json'
            : name === 'electron_game_overlay_reshade_manager32.exe'
              ? 'electron_game_overlay_reshade_manager.exe'
              : name;
      sources.set(name, path.join(directory, sourceName));
    }
  }
  sources.set('ReShade.ini', path.join(dist, 'win32-x64/ReShade.ini'));
  const spec = { runs, sources: [...sources] };
  const payloadBytes = [...sources.values()].reduce(
    (total, file) => total + fs.statSync(file).size,
    0,
  );
  const report = {
    scope:
      'Storage only, retained real binary sizes; no payload execution, graphics, game or consumer acceptance. Allocation counts stat.blocks * 512 once per NTFS file identity, excluding filesystem metadata. Repeated sessions are positively unused preparations retired by the gate; SDK lifecycle proof is tested separately.',
    payloadBytes,
    payloadAllocatedBytes: [...sources.values()].reduce(
      (total, file) => total + fs.statSync(file).blocks * 512,
      0,
    ),
    sourceHashes: Object.fromEntries(
      [...sources].map(([name, file]) => [name, hash(file)]),
    ),
  };
  const first = await stage(spec, 'first');
  report.firstActiveSession = inventory(root);
  await retireUnused(first);
  report.first = inventory(root);
  for (let i = 1; i < 12; i++)
    await retireUnused(await stage(spec, `repeat-${i}`));
  report.twelveSessions = inventory(root);
  const beforeFailure = inventory(root);
  const invalid = path.join(root, 'invalid-injector');
  fs.writeFileSync(invalid, 'owned invalid fixture');
  const bad = {
    ...spec,
    sources: spec.sources.map(([name, file]) => [
      name,
      name === 'inject.exe' ? invalid : file,
    ]),
  };
  let rejected = false;
  try {
    await stage(bad, 'failure');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Changed source was accepted');
  fs.unlinkSync(invalid);
  report.failedStagePreservedStorage =
    JSON.stringify(inventory(root)) === JSON.stringify(beforeFailure);
  const childSpec = path.join(parent, `${path.basename(root)}-child.json`);
  fs.writeFileSync(childSpec, JSON.stringify(spec));
  try {
    execFileSync(process.execPath, [__filename, '--child', childSpec], {
      windowsHide: true,
    });
  } finally {
    fs.unlinkSync(childSpec);
  }
  report.afterProcessRestart = inventory(root);
  for (let i = 12; i < 32; i++)
    await retireUnused(await stage(spec, `bounded-${i}`));
  report.thirtyTwoSessions = inventory(root);
  report.retainedRunDirectories = fs.readdirSync(runs).length;
  if (report.retainedRunDirectories > 16)
    throw new Error('Retired diagnostics directory bound failed');
  const heldOriginal = await stage(spec, 'held-original');
  // A synthetic verified upgrade changes only injector bytes and its manifest.
  // Real payloads are never edited or loaded.
  const upgradedInjector = path.join(root, 'upgraded-injector');
  fs.copyFileSync(sources.get('inject.exe'), upgradedInjector);
  fs.appendFileSync(upgradedInjector, 'owned upgrade fixture');
  const manifest = readJson(sources.get(specs[0][0]));
  manifest.injectorSha256 = hash(upgradedInjector);
  const upgradedManifest = path.join(root, 'upgraded-manifest');
  fs.writeFileSync(upgradedManifest, JSON.stringify(manifest));
  const upgrade = new Map(sources);
  upgrade.set('inject.exe', upgradedInjector);
  upgrade.set(specs[0][0], upgradedManifest);
  const upgradedSession = await stage(
    { runs, sources: [...upgrade] },
    'upgrade',
  );
  fs.unlinkSync(upgradedInjector);
  fs.unlinkSync(upgradedManifest);
  report.afterUpgrade = inventory(root);
  await retireUnused(upgradedSession);
  report.afterUpgradeRetired = inventory(root);
  report.originalSessionPreserved =
    hash(path.join(heldOriginal, 'inject.exe')) ===
    report.sourceHashes['inject.exe'];
  report.retiredPayloadsAbsent = fs
    .readdirSync(runs)
    .filter((name) => !['held-original'].includes(name))
    .every((name) => !fs.existsSync(path.join(runs, name, 'inject.exe')));
  report.payloadBuilds = fs.readdirSync(`${runs}.payloads-v2`).length;
  if (
    !report.failedStagePreservedStorage ||
    !report.originalSessionPreserved ||
    !report.retiredPayloadsAbsent ||
    report.payloadBuilds !== 2
  )
    throw new Error('Storage lifecycle invariant failed');
  await retireUnused(heldOriginal);
  report.ownedTestDirectory = root;
  const output = path.join(parent, 'report.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  // Only this invocation's freshly created owned directory; report stays outside.
  if (
    path.dirname(root) !== parent ||
    !path.basename(root).startsWith('owned-')
  )
    throw new Error('Unsafe test cleanup path');
  await fsp.rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      output,
      payloadBytes,
      first: report.first.uniqueFileContentBytes,
      twelveSessions: report.twelveSessions.uniqueFileContentBytes,
      restart: report.afterProcessRestart.uniqueFileContentBytes,
      upgrade: report.afterUpgradeRetired.uniqueFileContentBytes,
      twelveAllocated: report.twelveSessions.uniqueAllocatedBytes,
      failurePreserved: report.failedStagePreservedStorage,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
