'use strict';
// Own-process access-refusal gate: real injector, real process DACL, no injection.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const [fixtureDirectory, injector, reportFile] = process.argv.slice(2,5).map(value => path.resolve(value));
const negativeControl = process.argv[5] === '--negative-control';
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = JSON.parse(fs.readFileSync(path.join(path.dirname(injector),'electron_game_overlay_runtime.build.json'),'utf8').replace(/^\uFEFF/,''));
if(negativeControl)assert.equal(stamp.runtimeGeneration,24);else assert.ok(stamp.runtimeGeneration>=25&&stamp.runtimeGeneration<=26);
assert.equal(sha(injector).toUpperCase(),stamp.injectorSha256.toUpperCase());
const ownerFile = path.join(fixtureDirectory,'owned_access_refusal_owner.exe');
const targetFile = path.join(fixtureDirectory,'owned_access_refused_target.exe');
const policyFile = path.join(fixtureDirectory,`owned-native-policy-${process.pid}.txt`);
fs.writeFileSync(policyFile,'EGO_PROCESS_POLICY_V1\nA\t'+targetFile.replaceAll('\\','/').toLowerCase()+'\n',{flag:'wx'});
const report = {status:'failed',scope:'Owned process DACL refusal through an actual native binary; no injection, graphics or external target',nativeGeneration:stamp.runtimeGeneration,negativeControl,
  injectorSha256:sha(injector),ownerSha256:sha(ownerFile),targetSha256:sha(targetFile)};
const children=[];
function start(file,args=[]) {
  const child=spawn(file,args,{cwd:path.dirname(file),stdio:['pipe','pipe','pipe'],windowsHide:true});
  const record={child,stdout:'',stderr:'',code:null}; children.push(record);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',bytes=>{record.stdout+=bytes;});child.stderr.on('data',bytes=>{record.stderr+=bytes;});
  record.closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{record.code=code;resolve();});});
  record.closed.catch(()=>{}); return record;
}
async function until(test,milliseconds=10000) {
  const end=Date.now()+milliseconds;
  while(Date.now()<end) {const result=test();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Owned refusal gate deadline exceeded');
}
const records = record => record.stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
(async()=>{
  try {
    const watcher=start(injector,['--path-contains',fixtureDirectory,'--policy-file',policyFile]);
    await until(()=>watcher.stdout.includes('ReShade path watcher armed.'));
    const owner=start(ownerFile);
    const ready=await until(()=>records(owner).find(record=>record.ready));
    assert.equal(ready.kind,'EGO_OWNED_ACCESS_REFUSAL_V1');assert.equal(ready.readOnlyIdentityVerified,true);assert.equal(ready.fullAccessWindowsError,5);
    assert.equal(ready.executablePath.toLowerCase(),targetFile.toLowerCase());report.identity=ready;
    await until(()=>watcher.code!==null); await watcher.closed;
    assert.equal(watcher.code,5,watcher.stderr||watcher.stdout);
    const selected=`EGO_TARGET_SELECTED_V2\t${ready.pid}\t${ready.creationTime100ns}\t${ready.executablePath}`;
    const index=watcher.stdout.indexOf(selected);
    if(negativeControl) assert.equal(index,-1,'Historical control must reproduce the missing V2 refusal');
    else {assert.ok(index>=0);assert.ok(watcher.stdout.indexOf('Failed to open target application process!')>index);}
    assert.match(watcher.stdout,/ReShade injection not started\./);assert.doesNotMatch(watcher.stdout,/(?:^|\n)EGO_TARGET_SELECTED\t/);
    assert.equal(owner.code,null,'refused instance must remain alive until its owner confirms exit');
    owner.child.stdin.end('exit\n'); await until(()=>owner.code!==null); await owner.closed;
    assert.equal(owner.code,0,owner.stderr);
    const exited=records(owner).find(record=>record.exited);assert.ok(exited);assert.equal(exited.pid,ready.pid);assert.equal(exited.creationTime100ns,ready.creationTime100ns);assert.equal(exited.retainedHandle,true);
    report.status='passed';report.nativeStdout=watcher.stdout;report.nativeStderr=watcher.stderr;report.exit=exited;
  } catch(error) {report.error=error.stack;process.exitCode=1;}
  finally {
    for(const record of children) if(record.child.exitCode===null) {if(path.basename(record.child.spawnfile)===path.basename(ownerFile))record.child.stdin.end('exit\n');else record.child.kill();}
    await Promise.allSettled(children.map(record=>record.closed));
    fs.unlinkSync(policyFile);fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({status:report.status,report:reportFile,pid:report.identity?.pid,nativeGeneration:stamp.runtimeGeneration,negativeControl}));
  }
})();
