'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const runnerPath = '../scripts/broker-smoke-host-runner.cjs';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'portable-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hosts = [];
  for (const [architecture, backend] of [['x64','d3d9'],['x64','d3d10'],['x64','d3d11'],['x64','d3d12'],['x86','d3d9'],['x86','d3d10']]) {
    const image = Buffer.alloc(256); image.write('MZ'); image.writeUInt32LE(128, 60); image.write('PE\0\0',128); image.writeUInt16LE(architecture === 'x64' ? 0x8664 : 0x14c,132);
    const file = path.join(root, `${architecture}-${backend}.exe`); fs.writeFileSync(file,image);
    hosts.push({architecture,backend,path:path.basename(file),sha256:sha(image),size:image.length,peMachine:architecture === 'x64' ? 0x8664:0x14c});
  }
  const apps = ['A','B'].map((role) => {
    const dir = path.join(root,role); fs.mkdirSync(path.join(dir,'resources/app/node_modules/electron-game-overlay/dist/lib'),{recursive:true});
    const implementation = Buffer.from(role); fs.writeFileSync(path.join(dir,'resources/app/node_modules/electron-game-overlay/dist/lib/overlay-broker-native-provider.js'),implementation);
    fs.writeFileSync(path.join(dir,'resources/app/node_modules/electron-game-overlay/package.json'),JSON.stringify({version:'1.0.0'}));
    fs.mkdirSync(path.join(dir,'resources/node'),{recursive:true}); fs.writeFileSync(path.join(dir,'resources/node/node.exe'),'controlled-not-executable');
    const exe = path.join(dir,'app.exe'); fs.writeFileSync(exe,'controlled-not-executable');
    fs.writeFileSync(path.join(dir,'SDK-REVISION.json'),JSON.stringify({sdkSourceRevision:'b'.repeat(40),sdkImplementationSha256:sha(implementation),packageVersion:'1.0.0',role:role === 'A' ? 'current':'previous',...(role === 'B'?{sdkArtifactId:'123'}:{})}));
    return exe;
  });
  const hostManifest = path.join(root,'manifest.json'); fs.writeFileSync(hostManifest,JSON.stringify({schemaVersion:1,sourceRevision:'a'.repeat(40),hosts}));
  return {root,hosts:hosts.map(h=>({...h,path:path.join(root,h.path)})),options:{appA:apps[0],appB:apps[1],hostManifest,architecture:'x64',backend:'d3d11',mode:'singleApp',outputRoot:path.join(root,'output'),prepareMs:1000,observeMs:30,cleanupMs:500}};
}
test('missing prebuilt invalidates stale report before setup failure', async(t) => {
  const f=fixture(t); fs.mkdirSync(f.options.outputRoot); fs.writeFileSync(path.join(f.options.outputRoot,'report.json'),'{"status":"passed"}');
  fs.unlinkSync(f.hosts[5].path);
  const r=await require(runnerPath).run(f.options);
  assert.equal(r.status,'failed'); assert.equal(r.reason,'invalid-prebuilt');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.outputRoot,'report.json'))).status,'failed');
});
function controlled(t, f, {failApp=false, silent=false, autoClose=true}={}) {
  const calls=[], children=[];
  t.after(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill();});
  return {calls,children,controlledNonNative:true,spawn(exe,args,opts){
    const host=calls.length===0, barrier=host?path.join(path.dirname(exe),'electron-game-overlay-startup-barrier.enabled'):calls[0].barrier;
    calls.push({exe,args,opts,barrier});
    if(host)assert.equal(fs.existsSync(barrier),true);
    const script=host ? `const fs=require('fs');let closing=false;setInterval(()=>{if(!fs.existsSync(${JSON.stringify(barrier)})){fs.writeFileSync(${JSON.stringify(barrier+'.released')},'released');if(${autoClose}&&!closing){closing=true;setTimeout(()=>process.exit(0),150);}}},5)` : failApp ? 'process.exit(2)' : silent ? 'setInterval(()=>{},1000)' : `const fs=require('fs');console.log('secret=DO_NOT_RETAIN');console.log('RESHADE_CLIENT_OVERLAY_SESSION_READY');${calls.length===2?"console.log('RESHADE_CLIENT_INJECTOR_RETURNED');":''}setInterval(()=>{if(!fs.existsSync(${JSON.stringify(barrier)}))console.log('RESHADE_CLIENT_TARGET_CONNECTED pid=${children[0].pid}');},5);`;
    const child=cp.spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe']});children.push(child);return child;
  }};
}
test('controlled non-native held file barrier host-first exact PID allows joined auth after release',async(t)=>{
  const f=fixture(t), boundary=controlled(t,f);
  const r=await require(runnerPath).run({...f.options,mode:'twoAppSameTarget'},boundary);
  const calls=boundary.calls;
  assert.equal(r.status,'manual-observation-pending');assert.equal(r.nativeExecuted,false);assert.equal(calls.length,3);
  assert.equal(r.runtimeConnectedApps,2);
  for(const c of calls.slice(1)){
    assert.ok(c.args.includes(`--reshade-expected-target-pid=${boundary.children[0].pid}`));
    assert.ok(c.args.includes(`--reshade-auto-target-process=${path.basename(calls[0].exe)}`));
    assert.ok(!c.args.some(a=>/manual-test|sandbox|debug|remote-allow/.test(a)));
  }
  assert.notEqual(calls[1].args.find(a=>a.startsWith('--user-data-dir=')),calls[2].args.find(a=>a.startsWith('--user-data-dir=')));
  assert.ok(r.stages.indexOf('sessions-ready')<r.stages.indexOf('startup-barrier-released'));
  assert.ok(!JSON.stringify(r).includes('DO_NOT_RETAIN'));
  assert.ok(boundary.children.every(c=>c.exitCode!==null||c.signalCode!==null));assert.equal(fs.existsSync(r.privateRoot),false);
});
test('CLI invalidates stale success and refuses unknown options', (t)=>{
  const f=fixture(t);fs.mkdirSync(f.options.outputRoot);fs.writeFileSync(path.join(f.options.outputRoot,'report.json'),'{"status":"passed"}');
  const r=cp.spawnSync(process.execPath,[path.resolve(__dirname,runnerPath),'--output-root',f.options.outputRoot,'--unknown','x'],{encoding:'utf8',timeout:2000});
  assert.equal(r.status,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.outputRoot,'report.json'))).reason,'invalid-options');
});
test('production modes refuse native platform on Linux without spawning',async(t)=>{
  const f=fixture(t);for(const mode of ['singleApp','twoAppSameTarget']){
    const r=await require(runnerPath).run({...f.options,mode});assert.equal(r.reason,'unsupported-native-platform');assert.equal(r.nativeExecuted,false);
  }
});
test('cancellation during readiness prevents late host and cleans owned child',async(t)=>{
  const f=fixture(t),abort=new AbortController(),children=[];let calls=0;
  t.after(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill();});
  const r=await require(runnerPath).run({...f.options,signal:abort.signal},{controlledNonNative:true,spawn(){calls++;const c=cp.spawn(process.execPath,['-e','setTimeout(()=>console.log("RESHADE_CLIENT_INJECTOR_WATCHER_READY target=late"),500);setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});children.push(c);c.once('spawn',()=>abort.abort());return c;}});
  assert.equal(r.reason,'cancelled');assert.equal(calls,1);assert.equal(fs.existsSync(r.privateRoot),false);assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));
  const persisted=fs.readFileSync(path.join(f.options.outputRoot,'report.json'),'utf8');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(fs.readFileSync(path.join(f.options.outputRoot,'report.json'),'utf8'),persisted);assert.equal(calls,1);
});
test('every cell rejects changed hash or PE machine before spawning',async(t)=>{
  const f=fixture(t);for(const host of f.hosts){
    const bytes=fs.readFileSync(host.path);const changed=Buffer.from(bytes);changed.writeUInt16LE(0,132);fs.writeFileSync(host.path,changed);
    const r=await require(runnerPath).run({...f.options,architecture:host.architecture,backend:host.backend});assert.equal(r.reason,'invalid-prebuilt');fs.writeFileSync(host.path,bytes);
  }
});
test('SDK metadata is allowlisted in reports',async(t)=>{
  const f=fixture(t);const p=path.join(path.dirname(f.options.appA),'SDK-REVISION.json');const m=JSON.parse(fs.readFileSync(p));m.secret='DO_NOT_RETAIN';fs.writeFileSync(p,JSON.stringify(m));
  const r=await require(runnerPath).run(f.options,{controlledNonNative:true,spawn(){throw Error('controlled setup failure');}});assert.ok(!JSON.stringify(r).includes('DO_NOT_RETAIN'));
});
test('controlled six cells retain validation and app startup failures never release barrier',async(t)=>{
  const f=fixture(t);
  for(const host of f.hosts){const boundary=controlled(t,f);const r=await require(runnerPath).run({...f.options,architecture:host.architecture,backend:host.backend},boundary);assert.equal(r.status,'manual-observation-pending');assert.equal(r.nativeExecuted,false);}
  for(const failApp of [true,false]){const boundary=controlled(t,f,{failApp,silent:!failApp});const r=await require(runnerPath).run({...f.options,prepareMs:150},boundary);assert.equal(r.reason,failApp?'child-failed':'deadline');assert.ok(!r.stages.includes('startup-barrier-released'));assert.equal(fs.existsSync(r.privateRoot),false);}
});
test('manifest rejects escape, size, hash, duplicate and inconsistent PE fields',async(t)=>{
  const f=fixture(t),original=JSON.parse(fs.readFileSync(f.options.hostManifest));
  for(const mutate of [m=>m.hosts[0].path='../outside.exe',m=>m.hosts[0].size++,m=>m.hosts[0].sha256='0'.repeat(64),m=>m.hosts[1]=m.hosts[0],m=>m.hosts[0].peMachine=0x14c]){
    const m=structuredClone(original);mutate(m);fs.writeFileSync(f.options.hostManifest,JSON.stringify(m));const r=await require(runnerPath).run(f.options);assert.equal(r.reason,'invalid-prebuilt');
  }
});
test('unsafe report links and output ancestors never overwrite private outside sentinel',async t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  const sentinel=path.join(outside,'report.json');fs.writeFileSync(sentinel,'untouched');
  for(const kind of ['report','root','ancestor']){
    const outputRoot=path.join(f.root,`unsafe-${kind}`);
    if(kind==='report'){fs.mkdirSync(outputRoot);fs.symlinkSync(sentinel,path.join(outputRoot,'report.json'));}
    else fs.symlinkSync(outside,outputRoot,'junction');
    await assert.rejects(require(runnerPath).run({...f.options,outputRoot:kind==='ancestor'?path.join(outputRoot,'nested'):outputRoot}),/unsafe-output/);
    assert.equal(fs.readFileSync(sentinel,'utf8'),'untouched');
    assert.equal(fs.existsSync(path.join(outside,'nested')),false);
  }
});
test('two app mode rejects same executable and alias complete root before spawning',async t=>{
  const f=fixture(t),alias=path.join(f.root,'alias');fs.symlinkSync(path.dirname(f.options.appA),alias,'junction');
  const alternate=path.join(path.dirname(f.options.appA),'alternate.exe');fs.copyFileSync(f.options.appA,alternate);
  for(const appB of [f.options.appA,path.join(alias,'app.exe'),alternate]){
    let spawned=false;
    const r=await require(runnerPath).run({...f.options,mode:'twoAppSameTarget',appB},{controlledNonNative:true,spawn(){spawned=true;throw Error('must not spawn');}});
    assert.equal(r.reason,'invalid-app');assert.equal(spawned,false);
  }
});
test('interactive lifetime retains owned children through readiness and App A exit until host close or cancel',async t=>{
  for(const ending of ['host-close','cancel']){
    const f=fixture(t),boundary=controlled(t,f,{autoClose:false}),abort=new AbortController();let settled=false;
    const operation=require(runnerPath).run({...f.options,mode:'twoAppSameTarget',signal:abort.signal},boundary).then(r=>{settled=true;return r;});
    const deadline=Date.now()+2000;
    while((!boundary.calls[0] || fs.existsSync(boundary.calls[0].barrier)) && !settled && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    await new Promise(r=>setTimeout(r,100));
    try{
      assert.equal(settled,false,'readiness must not finalize the manual session');
      assert.ok(boundary.children.every(c=>c.exitCode===null&&c.signalCode===null));
      boundary.children[1].kill();await new Promise(r=>setTimeout(r,50));
      assert.equal(settled,false,'closing A must leave B and host available');
      assert.equal(boundary.children[2].exitCode,null);assert.equal(boundary.children[2].signalCode,null);
    }finally{if(ending==='cancel')abort.abort();else boundary.children[0]?.kill();}
    const r=await operation;
    assert.equal(r.status,'manual-observation-pending');assert.equal(r.manualObservationPending,true);
    assert.equal(r.reason,ending==='cancel'?'operator-cancelled':'owned-host-closed');
    assert.equal(r.nativeExecuted,false);assert.ok(boundary.children.every(c=>c.exitCode!==null||c.signalCode!==null));
    assert.equal(fs.existsSync(r.privateRoot),false);
  }
});
module.exports={fixture};

test('actual CLI preflight refuses native Linux and does not expose controlled boundary',t=>{
  const f=fixture(t);
  const args=['--app-a',f.options.appA,'--host-manifest',f.options.hostManifest,'--architecture','x64','--backend','d3d11','--output-root',f.options.outputRoot];
  const result=cp.spawnSync(process.execPath,[path.resolve(__dirname,runnerPath),...args],{encoding:'utf8',timeout:2000});
  assert.equal(result.status,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.outputRoot,'report.json'))).reason,'unsupported-native-platform');
  const denied=cp.spawnSync(process.execPath,[path.resolve(__dirname,runnerPath),...args,'--controlled-non-native','true'],{encoding:'utf8',timeout:2000});assert.equal(denied.status,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.outputRoot,'report.json'))).reason,'invalid-options');
});
test('one returned injector never releases barrier without both sessions',async t=>{
  const f=fixture(t),boundary=controlled(t,f);const original=boundary.spawn;
  boundary.spawn=function(exe,args,opts){if(boundary.calls.length===2){const c=cp.spawn(process.execPath,['-e',"console.log('RESHADE_CLIENT_INJECTOR_RETURNED');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});boundary.calls.push({exe,args,opts});boundary.children.push(c);return c;}return original(exe,args,opts);};
  const r=await require(runnerPath).run({...f.options,mode:'twoAppSameTarget',prepareMs:200},boundary);assert.equal(r.reason,'deadline');assert.ok(!r.stages.includes('startup-barrier-released'));assert.equal(fs.existsSync(r.privateRoot),false);
});
