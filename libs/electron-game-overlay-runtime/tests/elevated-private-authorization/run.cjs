'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..'),arch=process.argv[2],requireElevated=process.argv[3]==='1';
const api=require(path.join(root,'libs/electron-game-overlay/dist/lib/overlay-consumer-context.js'));
const runtime=path.join(root,'libs/electron-game-overlay-runtime/dist',arch==='x86'?'win32-ia32':'win32-x64');
const config={addonManagerPath:path.join(runtime,'electron_game_overlay_reshade_manager.exe')};
async function main(){
  const context=await api.inspectOverlayConsumerExecutionContext({config});
  if(requireElevated)assert.equal(context.elevated,true,'Start this headless fixture from an already elevated caller; this launcher never requests UAC');
  const original=path.join(root,`build/elevated-private-authorization/compile-${arch}/Release/elevated_private_authorization.exe`);
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
