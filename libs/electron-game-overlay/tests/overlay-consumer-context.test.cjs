'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const {inspectOverlayConsumerExecutionContext:inspect,launchUnelevatedOverlayConsumer:launch,createPrivateElevatedOverlayStage:createStage,verifyPrivateElevatedOverlayStage:verifyStage}=require('../dist/lib/overlay-consumer-context.js');
const config={addonManagerPath:'C:\\verified-runtime\\manager.exe'};
function record(extra={}) { return {schemaVersion:1,kind:'electron-game-overlay-consumer-context',ownerPid:process.pid,creationTime100ns:'134387369353549747',executablePath:process.execPath,executableSha256:'A'.repeat(64),elevated:true,integrityRid:12288,sessionId:1,overlaySupported:true,relaunchAvailable:true,relaunchRefusal:null,status:'inspected',replacementPid:0,replacementCreationTime100ns:'0',...extra}; }
function stub(t,responses) {
  const calls=[],original=cp.execFile;
  cp.execFile=(file,args,options,callback)=>{
    calls.push({file,args,options});
    const response=responses.shift();assert.ok(response,'Unexpected helper invocation');
    queueMicrotask(()=>callback(response.error??null,response.stdout??JSON.stringify(response.record),response.stderr??''));
  };
  t.after(()=>{cp.execFile=original;});return calls;
}
test('consumer inspection is read-only, hidden, shell-free, and binds the actual caller',async t=>{
  const calls=stub(t,[{record:record()}]);const context=await inspect({config});
  assert.equal(context.elevated,true);assert.equal(Object.isFrozen(context),true);
  assert.deepEqual(calls[0].args,['--consumer-context',String(process.pid)]);
  assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);
  assert.equal(calls.length,1);
});
test('elevated consumer launch binds inspected birth and image, preserves literal arguments, and returns verified child identity',async t=>{
  const calls=stub(t,[{record:record()},{record:record({status:'launched',replacementPid:process.pid+1,replacementCreationTime100ns:'134387369353549748'})}]);
  const context=await inspect({config});const args=['C:\\dev app\\main.js','','quote"here','trailing\\','$(literal)','--flag'];
  const result=await launch({config,context,arguments:args});
  assert.equal(result.status,'launched');assert.equal(result.replacement.pid,process.pid+1);
  assert.deepEqual(calls[1].args,['--consumer-relaunch',String(process.pid),context.creationTime100ns,context.executableSha256,...args.flatMap(arg=>['--arg',arg])]);
  assert.equal(Object.isFrozen(result.replacement),true);assert.equal(calls.length,2);
});
test('default arguments preserve the development app path; already medium never reports a replacement',async t=>{
  const medium=record({elevated:false,integrityRid:8192,overlaySupported:true});
  const calls=stub(t,[{record:medium},{record:{...medium,status:'already-unelevated'}}]);
  const result=await launch({config,context:await inspect({config})});
  assert.equal(result.status,'already-unelevated');assert.equal(result.replacement,undefined);
  assert.deepEqual(calls[1].args.slice(4),process.argv.slice(1).flatMap(arg=>['--arg',arg]));
});
for(const [name,extra] of [
  ['foreign caller',{ownerPid:process.pid+1}],['foreign image',{executablePath:'C:\\other.exe'}],['zero birth',{creationTime100ns:'0'}],
  ['invalid hash',{executableSha256:'a'.repeat(64)}],['contradictory token',{overlaySupported:false}],
  ['contradictory capability',{relaunchAvailable:false}],['extra fields',{unexpected:true}],['unexpected launch',{status:'launched',replacementPid:123}],
])test('consumer inspection rejects '+name,async t=>{stub(t,[{record:record(extra)}]);await assert.rejects(inspect({config}));});
for(const response of [
  {stdout:'{}\n{}'}, {record:record(),stderr:'unexpected'}, {stdout:'not JSON'}, {error:Error('native refusal'),stdout:'refused'},
])test('consumer rejects invalid or failed native output without retry '+JSON.stringify(response),async t=>{
  const calls=stub(t,[response]);await assert.rejects(inspect({config}));assert.equal(calls.length,1);
});
test('unavailable desktop context fails before a launch invocation',async t=>{
  const calls=stub(t,[{record:record({relaunchAvailable:false,relaunchRefusal:'desktop-user-mismatch'})}]);
  await assert.rejects(launch({config,context:await inspect({config})}),/unavailable/);assert.equal(calls.length,1);
});
for(const extra of [{creationTime100ns:'134387369353549749'},{executableSha256:'B'.repeat(64)},{replacementPid:process.pid},{replacementCreationTime100ns:'0'},{replacementPid:0},{status:'already-unelevated'}])
  test('replacement contradiction fails without retry '+JSON.stringify(extra),async t=>{
    const calls=stub(t,[{record:record()},{record:record({status:'launched',replacementPid:process.pid+1,replacementCreationTime100ns:'134387369353549748',...extra})}]);
    await assert.rejects(launch({config,context:await inspect({config}),arguments:[]}));assert.equal(calls.length,2);
  });
test('invalid arguments and foreign contexts never invoke the manager',async t=>{
  const calls=stub(t,[]);
  for(const args of [['bad\0argument'],Array(257).fill(''),['x'.repeat(30001)]])await assert.rejects(launch({config,context:record(),arguments:args}));
  await assert.rejects(launch({config,context:record({ownerPid:process.pid+1}),arguments:[]}));assert.equal(calls.length,0);
});

test('private elevated stage creation binds the calling incarnation and direct-child root without relaunch',async t=>{
  const directory='C:\\runs\\prepared-'+'a'.repeat(32);
  const calls=stub(t,[{record:{schemaVersion:1,kind:'electron-game-overlay-private-elevated-stage',ownerPid:process.pid,creationTime100ns:record().creationTime100ns,directory}}]);
  assert.equal(await createStage(config,record(),'C:\\runs','prepared'),directory);
  assert.deepEqual(calls[0].args,['--create-private-elevated-stage',String(process.pid),record().creationTime100ns,'C:\\runs','prepared']);
  assert.equal(calls[0].options.shell,false);assert.equal(calls.length,1);
});
for(const extra of [{ownerPid:process.pid+1},{creationTime100ns:'1'},{directory:'C:\\other\\prepared-'+'a'.repeat(32)},{directory:'C:\\runs\\prepared-not-random'},{unexpected:true}])test('private elevated stage rejects inconsistent native evidence '+JSON.stringify(extra),async t=>{
  const calls=stub(t,[{record:{schemaVersion:1,kind:'electron-game-overlay-private-elevated-stage',ownerPid:process.pid,creationTime100ns:record().creationTime100ns,directory:'C:\\runs\\prepared-'+'a'.repeat(32),...extra}}]);
  await assert.rejects(createStage(config,record(),'C:\\runs','prepared'));assert.equal(calls.length,1);
});
test('private elevated stage rejects a medium or foreign caller without invoking native code',async t=>{
  const calls=stub(t,[]);
  await assert.rejects(createStage(config,record({elevated:false,integrityRid:8192}),'C:\\runs','prepared'));
  await assert.rejects(createStage(config,record({ownerPid:process.pid+1}),'C:\\runs','prepared'));
  await assert.rejects(createStage(config,record(),'C:\\runs','../foreign'));
  assert.equal(calls.length,0);
});

const verificationRecord=extra=>({schemaVersion:1,kind:'electron-game-overlay-private-elevated-stage-verified',ownerPid:process.pid,creationTime100ns:record().creationTime100ns,directory:'C:\\runs\\owned',payloadFiles:13,diagnosticsFiles:2,...extra});
test('private verification binds every trusted hash, caller and directory without relaunch',async t=>{
  const calls=stub(t,[{record:verificationRecord()}]),hashes=Array.from({length:13},(_,i)=>i.toString(16).toUpperCase().repeat(64));
  await verifyStage(config,record(),'C:\\runs\\owned',hashes);
  assert.deepEqual(calls[0].args,['--verify-private-elevated-stage',String(process.pid),record().creationTime100ns,'C:\\runs\\owned',...hashes]);
  assert.equal(calls[0].options.shell,false);assert.equal(calls.length,1);
});
for(const extra of [{ownerPid:process.pid+1},{creationTime100ns:'1'},{directory:'C:\\other'},{payloadFiles:12},{diagnosticsFiles:3},{unexpected:true}])test('private verification rejects contradictory evidence '+JSON.stringify(extra),async t=>{
  const calls=stub(t,[{record:verificationRecord(extra)}]);
  await assert.rejects(verifyStage(config,record(),'C:\\runs\\owned',Array(13).fill('A'.repeat(64))));assert.equal(calls.length,1);
});
test('private verification rejects incomplete digests or ineligible callers before native code',async t=>{
  const calls=stub(t,[]);
  for(const hashes of [[],Array(12).fill('A'.repeat(64)),Array(13).fill('a'.repeat(64))])await assert.rejects(verifyStage(config,record(),'C:\\runs\\owned',hashes));
  await assert.rejects(verifyStage(config,record({elevated:false,integrityRid:8192}),'C:\\runs\\owned',Array(13).fill('A'.repeat(64))));assert.equal(calls.length,0);
});
