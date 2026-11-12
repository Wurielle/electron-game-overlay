'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..'),arch=process.argv[2],requireElevated=process.argv[3]==='1';
const api=require(path.join(root,'libs/electron-game-overlay/dist/lib/overlay-consumer-context.js'));
const [, , , , build, runtime]=process.argv;
const standaloneManager=path.join(runtime,'electron_game_overlay_reshade_manager.exe');
const x86Manager=path.join(runtime,'electron_game_overlay_reshade_manager32.exe');
const config={addonManagerPath:arch==='x86'&&fs.existsSync(x86Manager)?x86Manager:standaloneManager};
async function main(){
  const context=await api.inspectOverlayConsumerExecutionContext({config});
  if(requireElevated)assert.equal(context.elevated,true,'Start this headless fixture from an already elevated caller; this launcher never requests UAC');
  const {buildReShadeInvocation,createReShadeLaunchConfig,ReShadeOverlayLauncher}=require(path.join(root,'libs/electron-game-overlay/dist/lib/reshade-launcher.js'));
  const aclDirectory=fs.mkdtempSync(path.join(build,'cache-acl-'));
  try {
    const acl=cp.spawnSync(path.join(build,'Release','elevated_cache_acl.exe'),[aclDirectory],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(acl.status,0,acl.error?.message||acl.stderr);
    assert.match(acl.stdout,/EGO_PROTECTED_CACHE_ACL_PASSED/);
    process.stdout.write(acl.stdout);
    const runsRoot=path.join(aclDirectory,'runs');
    if (!context.elevated) {
      const refused=cp.spawnSync(config.addonManagerPath,
        ['--hold-private-elevated-cache-root',String(process.pid),context.creationTime100ns,runsRoot],
        {encoding:'utf8',windowsHide:true,input:''});
      assert.notEqual(refused.status,0);
      assert.match(refused.stdout,/consumer-integrity-rejected/);
      assert.deepEqual(fs.readdirSync(aclDirectory),[]);
      const hash='0'.repeat(64);
      const invocation=buildReShadeInvocation({pid:process.pid,processName:path.basename(process.execPath),executablePath:process.execPath},runtime,{
        expectedCreationTime100ns:context.creationTime100ns,
        privateElevatedPayload:{runtimeSha256:hash,addonSha256:hash,configSha256:hash},
      });
      const injector=arch==='x86'?path.join(runtime,'inject32.exe'):invocation.executable;
      const denied=cp.spawnSync(injector,[...invocation.arguments,'--cache-bootstrap-stdin'],
        {cwd:runtime,encoding:'utf8',windowsHide:true,input:'',timeout:5000});
      assert.equal(denied.status,5,denied.error?.message||denied.stdout||denied.stderr);
      assert.equal(denied.stdout.trim(),'ReShade injection not started.');
      console.log('EGO_PROTECTED_CACHE_MEDIUM_CALLER_REFUSED');
    } else {
      const {privateCacheVersion,RUNTIME_PAYLOAD_NAMES}=require(path.join(root,'libs/electron-game-overlay/dist/lib/runtime-payload-store.js'));
      const cacheConfig=createReShadeLaunchConfig({bundledRuntimeDirectory:runtime,runsRootDirectory:runsRoot});
      assert.equal(cacheConfig.elevatedCacheBootstrap,1);
      const launcher=new ReShadeOverlayLauncher(cacheConfig);
      try { await launcher.prepare(); } finally { await launcher.disposeAsync(); }
      assert.deepEqual(fs.readdirSync(aclDirectory),['runs.elevated']);
      const sources=new Map(RUNTIME_PAYLOAD_NAMES.map(name=>[name,path.join(runtime,name)]));
      const sdkMetadata=JSON.parse(fs.readFileSync(path.join(root,'libs/electron-game-overlay/package.json'),'utf8'));
      const version=await privateCacheVersion(sources,sdkMetadata.version);
      const lease=await api.holdPrivateElevatedCache(cacheConfig,context,version);
      try {
        assert.equal(fs.readdirSync(lease.directory).length,14);
        assert.equal(fs.readdirSync(path.dirname(lease.directory)).length,1);
        assert.equal(fs.existsSync(lease.runsDirectory),false);
        assert.throws(()=>fs.renameSync(lease.directory,lease.directory+'-busy'));
      } finally { await lease.release(); }
      const changed={...version,hashes:new Map(version.hashes)};
      changed.hashes.set('inject.exe','0'.repeat(64));
      await assert.rejects(api.holdPrivateElevatedCache(cacheConfig,context,changed),/private-cache-payload-mismatch/);
      console.log('EGO_PROTECTED_CACHE_ACTUAL_HIGH_PREPARE_PASSED');
    }
  } finally { fs.rmSync(aclDirectory,{recursive:true,force:true}); }
  const original=path.join(build,'Release','elevated_private_authorization.exe');
  let directory,executable=original;
  if(context.elevated){
    const runsRoot=path.join(root,'build/elevated-private-authorization/owned-stages');fs.mkdirSync(runsRoot,{recursive:true});
    directory=await api.createPrivateElevatedOverlayStage(config,context,runsRoot,'authorization');
    executable=path.join(directory,'authorization.exe');fs.copyFileSync(original,executable);
    const bits=arch==='x86'?32:64;
    for(const name of [`electron_game_overlay.addon${bits}`,`ReShade${bits}.dll`,'ReShade.ini'])fs.copyFileSync(path.join(runtime,name),path.join(directory,name));
    fs.writeFileSync(path.join(directory,'.electron-game-overlay-run.json'),JSON.stringify({schemaVersion:1,kind:'electron-game-overlay-reshade-run',runId:crypto.randomUUID(),directoryName:path.basename(directory),createdAt:new Date().toISOString()}));
  }else{
    const refusal=cp.spawnSync(config.addonManagerPath,['--create-private-elevated-stage',String(process.pid),context.creationTime100ns,path.join(root,'build'),'must-not-create'],{encoding:'utf8',windowsHide:true});
    assert.notEqual(refusal.status,0);assert.match(refusal.stdout,/consumer-integrity-rejected/);
  }
  const result=cp.spawnSync(executable,[],{encoding:'utf8',windowsHide:true,timeout:30000});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.match(result.stdout,/EGO_ELEVATED_PRIVATE_AUTHORIZATION_PASSED/);
  if(requireElevated)assert.match(result.stdout,/"actualCallerElevated":true/);
  if(directory){assert.equal(path.dirname(directory),path.join(root,'build/elevated-private-authorization/owned-stages'));assert.equal(fs.realpathSync(directory).toLowerCase(),directory.toLowerCase());fs.rmSync(directory,{recursive:true,force:false});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
