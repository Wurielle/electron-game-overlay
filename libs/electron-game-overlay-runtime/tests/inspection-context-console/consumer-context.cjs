'use strict';
// Headless owned Node processes only; no Electron, game, UAC prompt or injection.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const [manager,report,...args]=process.argv.slice(2);
if(args[0]==='--owned-replacement')fs.writeFileSync(report+'.bootstrap.json',JSON.stringify({pid:process.pid,args,execPath:process.execPath}));
const config={addonManagerPath:path.resolve(manager)};
async function main(){
  const {inspectOverlayConsumerExecutionContext:inspect,launchUnelevatedOverlayConsumer:launch}=require('../../../electron-game-overlay/dist/lib/overlay-consumer-context.js');
  if(args[0]==='--owned-replacement'){
    const context=await inspect({config});
    fs.writeFileSync(report,JSON.stringify({context,args:args.slice(1),pid:process.pid,inheritedSentinel:process.env.EGO_PARENT_LAUNCH_ENV_SENTINEL!==undefined}));return;
  }
  const context=await inspect({config});
  assert.equal(context.ownerPid,process.pid);assert.ok(context.executableSha256);
  let checks=1,replacement=null;
  for(const argv of [
    ['--consumer-context',String(process.pid+1)],
    ['--consumer-relaunch',String(process.pid),'1',context.executableSha256],
    ['--consumer-relaunch',String(process.pid),context.creationTime100ns,'0'.repeat(64)],
    ['--consumer-relaunch',String(process.pid),context.creationTime100ns,context.executableSha256,'--unrecognized'],
  ]){
    const result=cp.spawnSync(config.addonManagerPath,argv,{encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0,result.stdout);assert.equal(result.error,undefined);checks++;
  }
  if(!context.elevated && context.integrityRid<=8192){
    const result=await launch({config,context,arguments:[]});assert.equal(result.status,'already-unelevated');assert.equal(result.replacement,undefined);checks++;
  }else if(context.relaunchAvailable){
    const childReport=path.resolve(report+'.replacement.json');
    assert.equal(fs.existsSync(childReport),false,'Use a new report path');
    const literal=['with spaces','','quote"here','trailing\\','$(literal)','日本語'];
    const result=await launch({config,context,arguments:[__filename,config.addonManagerPath,childReport,'--owned-replacement',...literal]});
    assert.equal(result.status,'launched');
    const deadline=Date.now()+10000;
    while(!fs.existsSync(childReport)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    replacement=JSON.parse(fs.readFileSync(childReport,'utf8'));
    assert.equal(replacement.pid,result.replacement.pid);assert.equal(replacement.context.creationTime100ns,result.replacement.creationTime100ns);
    assert.equal(replacement.context.elevated,false);assert.ok(replacement.context.integrityRid<=8192);assert.equal(replacement.context.sessionId,context.sessionId);
    assert.deepEqual(replacement.args,literal);checks++;
  }else{
    await assert.rejects(launch({config,context,arguments:[]}),/unavailable/);checks++;
  }
  const result={status:'passed',checks,context,replacement,actualElevatedRelaunch:replacement!==null,graphics:false,injection:false,uac:false};
  fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
main().catch(error=>{if(args[0]==='--owned-replacement')fs.writeFileSync(report,JSON.stringify({error:error.stack,pid:process.pid}));console.error(error);process.exitCode=1;});
