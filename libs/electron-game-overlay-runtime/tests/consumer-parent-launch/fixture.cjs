'use strict';
const cp=require('node:child_process'),fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const [seamManager,productionManager,report]=process.argv.slice(2).map(p=>path.resolve(p));
const sdk=require('../../../electron-game-overlay/dist/lib/overlay-consumer-context.js');
const literals=['with spaces','','quote"here','trailing\\','$(literal)','日本語'];
function raw(args){const r=cp.spawnSync(seamManager,args,{encoding:'utf8',windowsHide:true});fs.writeFileSync(report+'.native-stdio.json',JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message},null,2));assert.equal(r.status,0,r.stderr||r.stdout||r.error?.message);return JSON.parse(r.stdout);}
async function main(){
  const context=await sdk.inspectOverlayConsumerExecutionContext({config:{addonManagerPath:productionManager}});
  assert.equal(context.overlaySupported,true,'This no-UAC fixture requires an actual medium caller');
  const childReport=report+'.replacement.json';assert.equal(fs.existsSync(childReport),false,'Use a fresh report path');
  const ownChild=path.resolve(__dirname,'../inspection-context-console/consumer-context.cjs');
  process.env.EGO_PARENT_LAUNCH_ENV_SENTINEL='must-not-inherit';
  const args=[ownChild,productionManager,childReport,'--owned-replacement',...literals];
  const result=raw(['--consumer-relaunch',String(process.pid),context.creationTime100ns,context.executableSha256,...args.flatMap(a=>['--arg',a])]);
  fs.writeFileSync(report+'.attempt.json',JSON.stringify({context,result,args},null,2));
  assert.equal(result.status,'launched');
  const deadline=Date.now()+10000;while(!fs.existsSync(childReport)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  const child=JSON.parse(fs.readFileSync(childReport,'utf8'));assert.equal(child.pid,result.replacementPid);
  assert.equal(child.context.creationTime100ns,result.replacementCreationTime100ns);assert.equal(child.context.elevated,false);assert.equal(child.context.integrityRid,8192);
  assert.equal(child.context.sessionId,context.sessionId);assert.equal(child.inheritedSentinel,false);assert.deepEqual(child.args,literals);
  const output={status:'passed',actualElevatedRelaunch:false,fixtureSeam:'force medium early return off; production launch body unchanged',actualMediumDesktopParentLaunch:true,sourceContext:context,child,environmentNotInherited:true,graphics:false,injection:false,uac:false};
  fs.writeFileSync(report,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
