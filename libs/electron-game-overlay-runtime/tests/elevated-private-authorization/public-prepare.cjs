'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
const sdk=process.env.EGO_PREPARE_SDK_ROOT||path.join(root,'libs/electron-game-overlay/dist');
const api=require(path.join(sdk,'lib/overlay-consumer-context.js'));
const {createReShadeLaunchConfig,ReShadeOverlayLauncher}=require(path.join(sdk,'lib/reshade-launcher.js'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const config=createReShadeLaunchConfig({runsRootDirectory:path.join(root,'build/elevated-private-authorization/public-prepare-stages')});
async function main(){
  const context=await api.inspectOverlayConsumerExecutionContext({config});
  assert.equal(context.elevated,true,'Requires an already high controller; this test never requests UAC');assert.equal(context.integrityRid,12288);
  assert.equal(config.privateElevatedAuthorization,2);
  const launcher=new ReShadeOverlayLauncher(config);let directory;const events=[];
  launcher.onEvent(event=>{events.push(event.type);if(event.type==='runtime-staged')directory=event.runDirectory;});
  try {
    await launcher.prepare();assert.ok(directory);assert.deepEqual(events,['runtime-staged']);
    assert.equal(path.dirname(directory),fs.realpathSync(config.runsRootDirectory));assert.equal(fs.realpathSync(directory).toLowerCase(),directory.toLowerCase());
    const leaves=['inject.exe','inject32.exe','electron_game_overlay_reshade_manager.exe','electron_game_overlay_reshade_manager32.exe','ReShade64.dll','ReShade32.dll','ReShade64.build.json','ReShade32.build.json','electron_game_overlay_runtime.build.json','electron_game_overlay_runtime32.build.json','electron_game_overlay.addon64','electron_game_overlay.addon32','ReShade.ini'];
    const hashes=leaves.map(name=>hash(path.join(path.dirname(config.injectorPath),name)));
    for(let i=0;i<leaves.length;i++){const file=path.join(directory,leaves[i]);assert.equal(fs.lstatSync(file).nlink,1);assert.equal(hash(file),hashes[i]);}
    await api.verifyPrivateElevatedOverlayStage(config,context,directory,hashes);
    await api.verifyPrivateElevatedOverlayStage({...config,addonManagerPath:config.x86AddonManagerPath},context,directory,hashes);
    const corrupt=[...hashes];corrupt[0]=(hashes[0][0]==='A'?'B':'A')+hashes[0].slice(1);
    await assert.rejects(api.verifyPrivateElevatedOverlayStage(config,context,directory,corrupt),/private-stage-payload-mismatch/);
    const alias=path.join(directory,'alias.exe');fs.linkSync(path.join(directory,'inject.exe'),alias);
    try{await assert.rejects(api.verifyPrivateElevatedOverlayStage(config,context,directory,hashes),/path-identity-invalid/);}finally{fs.unlinkSync(alias);}
    await api.verifyPrivateElevatedOverlayStage(config,context,directory,hashes);
    const after=await api.inspectOverlayConsumerExecutionContext({config});assert.equal(after.elevated,true);assert.equal(after.integrityRid,12288);assert.equal(after.creationTime100ns,context.creationTime100ns);
    const report={kind:'ego-high-public-prepare',passed:true,context,after,directory,events,verifiedArchitectures:['x64','x86'],payloadFiles:leaves.map((name,index)=>({name,sha256:hashes[index]})),negativeControls:['changed-package-digest-rejected','hard-link-alias-rejected'],helperSha256:hash(config.addonManagerPath),x86HelperSha256:hash(config.x86AddonManagerPath),managerSourceSha256:JSON.parse(fs.readFileSync(config.packageBuildStampPath,'utf8')).managerSourceSha256,scope:'Actual high public prepare and native verification; no target, injection, transport, graphics or physical-key claims'};
    const reportPath=process.argv[2]||path.join(root,'build/c28-work/high-public-prepare.json');fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } finally {
    launcher.dispose();
    // No target or injection was started. Let the SDK drain and remove its
    // unused prepared stage; do not race its asynchronous ownership checks.
    if(directory){
      assert.equal(path.dirname(directory),fs.realpathSync(config.runsRootDirectory));
      const deadline=Date.now()+10000;
      while(fs.existsSync(directory)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(fs.existsSync(directory),false,'SDK must remove its unused prepared stage');
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
