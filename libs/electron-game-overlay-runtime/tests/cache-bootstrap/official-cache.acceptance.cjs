'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');
const sdk = '../../../electron-game-overlay/dist/lib/';
const { ReShadeOverlayLauncher, createReShadeLaunchConfig } = require(sdk + 'reshade-launcher.js');
const { existingReShadeAddonFileName, existingReShadeAddonMarkerFileName, prepareExistingReShadeAddon } = require(sdk + 'existing-reshade-installation.js');
const { CooperativeOverlayTransport } = require(sdk + 'cooperative-overlay-transport.js');
const { memoryTargetAuthorizers } = require(sdk + 'overlay-session-authorization.js');
const { sdkRuntimeCacheDirectory } = require(sdk + 'runtime-payload-store.js');

const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('stock ReShade install, repair and bounded startup handoff use the verified version cache', { timeout: 55000 }, async () => {
  const fixture = await fs.realpath(process.env.EGO_OFFICIAL_FIXTURE_ROOT);
  const root = await fs.mkdtemp(path.join(fixture, 'proof-'));
  const bundledRuntimeDirectory = await fs.realpath(process.env.EGO_OFFICIAL_FIXTURE_RUNTIME);
  const stock = await fs.realpath(process.env.EGO_OFFICIAL_FIXTURE_STOCK);
  const previousAddon = await fs.realpath(process.env.EGO_OFFICIAL_FIXTURE_PREVIOUS);
  const runsRootDirectory = path.join(root, 'runs');
  const logging = process.env.EGO_OFFICIAL_FIXTURE_LOGGING === '1';
  const config = createReShadeLaunchConfig({ bundledRuntimeDirectory, runsRootDirectory, logging });
  assert.equal(config.cacheOfficialBootstrap, 1);
  const transport = new CooperativeOverlayTransport({ directory: path.join(root, 'unused-discovery'), publishGlobalDiscovery: false });
  const launcher = new ReShadeOverlayLauncher(config);
  const events = new EventEmitter();
  const session = {
    whenReady: () => transport.whenReady(),
    on: (name, handler) => { events.on(name, handler); return () => events.off(name, handler); },
    onClose: (handler) => { events.on('close', handler); return () => events.off('close', handler); },
  };
  memoryTargetAuthorizers.set(session, identity => transport.authorizeMemoryTarget(identity));
  transport.setEventCallback((type, payload) => {
    if (type === 'game.process') events.emit('targetConnected', { pid: payload.pid, executablePath: payload.path });
  });
  transport.start();
  const cases = [];
  const createInstallation = async name => {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    const executablePath = path.join(directory, 'stock-target.exe');
    const runtime = path.join(directory, 'd3d11.dll');
    await fs.copyFile(process.env.EGO_OFFICIAL_FIXTURE_HOST, executablePath);
    await fs.copyFile(stock, runtime);
    await fs.writeFile(path.join(directory, 'ReShade.ini'), '[INSTALL]\nBasePath=.\nLogging=0\n\n[ADDON]\nAddonPath=.\nDisabledAddons=\n\n[GENERAL]\nEffectSearchPaths=.\nTextureSearchPaths=.\nPresetPath=.\\ReShadePreset.ini\n');
    await fs.writeFile(path.join(directory, 'ReShadePreset.ini'), '[GENERAL]\nTechniques=\n');
    await fs.writeFile(path.join(directory, 'keep.fx'), '// owned fixture sentinel\n');
    const protectedPaths = ['d3d11.dll', 'ReShade.ini', 'ReShadePreset.ini', 'keep.fx'].map(leaf => path.join(directory, leaf));
    return { directory, executablePath, runtime, protectedPaths, before: await Promise.all(protectedPaths.map(hash)),
      barrier: path.join(directory, 'electron-game-overlay-startup-barrier.enabled') };
  };
  let child, exited;
  const stop = async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    child = undefined;
    exited = undefined;
  };
  const start = async target => {
    await fs.writeFile(target.barrier, '');
    child = spawn(target.executablePath, ['--headless'], { cwd: target.directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(8000) });
    assert.equal(line, 'before-device');
    return { processName: path.basename(target.executablePath), executablePath: target.executablePath, pid: child.pid };
  };
  let releaseBarrier;
  const invocations = [];
  launcher.onEvent(event => {
    if (event.type !== 'injector-started') return;
    invocations.push(event.invocation);
    if (event.invocation.arguments.includes('--wait-for-official-addon') && releaseBarrier) releaseBarrier();
  });
  const assertStorage = async () => {
    if (!logging) await assert.rejects(fs.stat(runsRootDirectory), { code: 'ENOENT' });
    else for (const name of await fs.readdir(runsRootDirectory)) {
      assert.match(name, /^logs-/);
      assert.deepEqual((await fs.readdir(path.join(runsRootDirectory, name))).sort(), ['inject.stderr.log', 'inject.stdout.log']);
    }
    const cache = sdkRuntimeCacheDirectory(runsRootDirectory);
    const versions = await fs.readdir(cache);
    assert.equal(versions.length, 1);
    assert.equal((await fs.readdir(path.join(cache, versions[0]))).length, 14);
  };
  const restartRequired = async (target, operation) => {
    await assert.rejects(launcher.attach(session, await start(target)), error => {
      assert.equal(error.code, 'existing-reshade-addon-restart-required', error.message);
      assert.match(error.message, new RegExp(`was ${operation}`));
      return true;
    });
    assert.equal(await hash(path.join(target.directory, existingReShadeAddonFileName)), await hash(config.addonPath));
    await fs.access(path.join(target.directory, existingReShadeAddonMarkerFileName));
    assert.deepEqual(await Promise.all(target.protectedPaths.map(hash)), target.before);
    await assertStorage();
    await stop();
    cases.push(operation);
  };
  try {
    const fresh = await createInstallation('fresh');
    await restartRequired(fresh, 'installed');
    const repair = await createInstallation('repair');
    const seeded = await prepareExistingReShadeAddon({ targetExecutablePath: repair.executablePath,
      reshadeModulePath: repair.runtime, addonSourcePath: previousAddon, managerExecutablePath: config.addonManagerPath,
      targetEffectiveSettings: { reshadeBasePath: repair.directory, addonDirectoryPath: repair.directory, electronGameOverlayAddonDisabled: false } });
    assert.equal(seeded.status, 'installed');
    assert.notEqual(await hash(seeded.addonDestinationPath), await hash(config.addonPath));
    await restartRequired(repair, 'updated');

    const target = await start(repair);
    let barrierWork;
    releaseBarrier = () => { barrierWork = fs.unlink(repair.barrier); barrierWork.catch(() => undefined); };
    const attached = await launcher.attach(session, target);
    await barrierWork;
    assert.equal(attached.pid, target.pid);
    assert.equal(attached.runtimeMode, 'participant-addon');
    assert.equal(path.win32.basename(attached.hostRuntimePath).toLowerCase(), 'd3d11.dll');
    assert.ok(invocations.some(invocation => invocation.arguments.includes('--wait-for-official-addon')));
    assert.ok(invocations.some(invocation => invocation.arguments.includes('--addon-only')));
    assert.ok(invocations.every(invocation => invocation.arguments.includes('--cache-bootstrap-stdin')));
    assert.deepEqual(await Promise.all(repair.protectedPaths.map(hash)), repair.before);
    await assertStorage();
    cases.push('read-only startup wait', 'cached member');
    console.log(JSON.stringify({ cases, logging, host: path.basename(stock), stockSha256: await hash(stock), noProjectRunStage: true }));
  } finally {
    await launcher.disposeAsync();
    transport.stop();
    await stop();
    assert.equal(path.dirname(await fs.realpath(root)), fixture);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
