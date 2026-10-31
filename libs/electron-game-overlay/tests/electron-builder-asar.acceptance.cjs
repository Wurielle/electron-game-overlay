// Actual electron-builder ASAR output, then launch the resulting application.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { spawnSync } = require('node:child_process'),
  { createRequire } = require('node:module');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const n = a.indexOf('=');
    return [a.slice(2, n), a.slice(n + 1)];
  }),
);
const candidate = JSON.parse(fs.readFileSync(args.candidate, 'utf8')),
  root = path.resolve(args.output),
  appDir = path.join(root, 'app');
fs.mkdirSync(appDir, { recursive: true });
const report = { status: 'failed', nativeExecuted: false, asarExecuted: false };
const run = (exe, argv, env = process.env) => {
  const r = spawnSync(exe, argv, {
    env,
    cwd: appDir,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message);
  return r;
};
(async () => {
  const nodeModules = path.join(appDir, 'node_modules');
  fs.mkdirSync(nodeModules);
  const extracted = path.join(root, 'extract');
  fs.mkdirSync(extracted);
  run('tar', ['-xzf', candidate.tarball, '-C', extracted]);
  const installed = path.join(nodeModules, 'electron-game-overlay');
  fs.renameSync(path.join(extracted, 'package'), installed);
  const tslib = path.dirname(require.resolve('tslib/package.json'));
  fs.cpSync(tslib, path.join(nodeModules, 'tslib'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({
      name: 'ego-packaged-check',
      version: '1.0.0',
      description: 'Controlled SDK packaging acceptance',
      author: 'EGO acceptance',
      main: 'main.cjs',
      dependencies: {
        'electron-game-overlay': candidate.version,
        tslib: require('tslib/package.json').version,
      },
    }),
  );
  fs.writeFileSync(
    path.join(appDir, 'main.cjs'),
    `const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.argv.find(a=>a.startsWith('--evidence=')).slice(11);
app.setPath('userData',output+'.profile');
app.whenReady().then(async()=>{
 const {createReShadeLaunchConfig,ElectronGameOverlay,OverlayTargetWatcher}=require('electron-game-overlay');
 const {verifyOverlayPackage}=require('electron-game-overlay/packaging');
 const config=createReShadeLaunchConfig({runsRootDirectory:output+'.runs'});
 if(!config.runtimeDirectory.includes('app.asar.unpacked'))throw Error('Default runtime discovery remained inside ASAR');
 const root=path.dirname(require.resolve('electron-game-overlay/package.json')).replace(/app\\.asar([\\\\/])/,'app.asar.unpacked$1');
 const verified=await verifyOverlayPackage(root);
 const owner=new ElectronGameOverlay({allowPrereleaseBroker:true}),session=owner.createSession();
 if(typeof OverlayTargetWatcher!=='function')throw Error('Managed API missing');session.close();owner.dispose();
 fs.writeFileSync(output,JSON.stringify({status:'passed',electron:process.versions.electron,sdk:require('electron-game-overlay/package.json').version,runtimeDirectory:config.runtimeDirectory,sealedPayloads:verified.sealedPayloads,asarEntry:__filename}));app.exit(0);
}).catch(e=>{fs.writeFileSync(output,JSON.stringify({status:'failed',error:e.message}));app.exit(1)});
`,
  );
  const { build, Platform, Arch } = require(path.resolve(args.builder));
  const req = createRequire(path.join(appDir, 'package.json')),
    packaging = req('electron-game-overlay/packaging');
  let hooks = 0;
  await build({
    projectDir: appDir,
    publish: 'never',
    targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64),
    config: {
      appId: 'example.ego.packaging.acceptance',
      productName: 'EGO Packaged Check',
      directories: { output: path.join(root, 'out') },
      electronVersion: args['electron-version'],
      electronDist: path.resolve(args.electron),
      asar: true,
      npmRebuild: false,
      files: ['main.cjs'],
      asarUnpack: ['node_modules/electron-game-overlay/**/*'],
      win: { signAndEditExecutable: false },
      afterPack: async (context) => {
        await packaging.createOverlayAfterPack({ packageRoot: installed })(
          context,
        );
        hooks++;
      },
    },
  });
  assert.equal(hooks, 1);
  const appOut = path.join(root, 'out', 'win-unpacked'),
    exe = path.join(appOut, 'EGO Packaged Check.exe');
  assert.ok(fs.existsSync(path.join(appOut, 'resources', 'app.asar')));
  const finalSdk = path.join(
    appOut,
    'resources/app.asar.unpacked/node_modules/electron-game-overlay',
  );
  report.finalVerification = await packaging.verifyOverlayPackage(finalSdk);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const evidence = path.join(root, 'packaged-smoke.json');
  run(exe, ['--disable-gpu', '--evidence=' + evidence], env);
  report.smoke = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.equal(report.smoke.status, 'passed');
  assert.match(report.smoke.asarEntry, /app\.asar/);
  report.asarExecuted = true;
  const notice = path.join(
      finalSdk,
      'dist/broker/win32-x64/node_modules/tslib/CopyrightNotice.txt',
    ),
    original = fs.readFileSync(notice);
  try {
    fs.writeFileSync(notice, 'removed by dependency pruning');
    const r = spawnSync(exe, ['--disable-gpu', '--evidence=' + evidence], {
      env,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    assert.equal(
      r.status,
      1,
      'packaged corruption must reject, not count as a successful smoke',
    );
    assert.equal(JSON.parse(fs.readFileSync(evidence)).status, 'failed');
  } finally {
    fs.writeFileSync(notice, original);
  }
  run(exe, ['--disable-gpu', '--evidence=' + evidence], env);
  report.mutationSensitivity = true;
  report.status = 'passed';
  report.sdkTarballSha256 = candidate.tarballSha256;
  report.output = appOut;
})()
  .catch((e) => {
    report.error = e.stack;
    process.exitCode = 1;
  })
  .finally(() => {
    fs.writeFileSync(
      path.join(root, 'report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  });
