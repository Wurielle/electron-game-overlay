'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),arch=process.argv[2]??'x64';assert.ok(['x64','x86'].includes(arch));
const candidate=process.argv[4]??'gen32';assert.ok(['gen32','gen36','production'].includes(candidate));
const relay=process.argv[5]==='relay';assert.ok(process.argv[5]===undefined||relay);
const priorEngine=process.argv[6]??'minhook';assert.ok(['minhook','detours','repatch','repatch-preserve'].includes(priorEngine));
const generation=candidate==='production'?37:candidate==='gen36'?36:32,suffix=(generation>=36?'-gen'+generation:'')+(relay?'-relay':'')+(priorEngine!=='minhook'?'-'+priorEngine:''),label='foreign-present-'+arch+suffix;
const only=process.argv[3]==='first',work=path.join(root,'build/overlay-compatibility'),source=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src'),build=path.join(work,'foreign-present-'+arch),stage=path.join(work,'foreign-present-stage-'+arch+(candidate==='production'?'-production':suffix));
const read=p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/u,'').replaceAll('\r\n','\n'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const candidateRoot=candidate==='production'?path.join(root,'libs/electron-game-overlay-runtime/dist',arch==='x64'?'win32-x64':'win32-ia32'):path.join(root,'build/candidates',generation===36?'owned-deferred-d3d11-gen36':'owned-composition-recovery-gen32','sdk-stage/dist/runtime/win32-x64/reshade');
const input=path.join(candidateRoot,arch==='x64'?'ReShade64.dll':'ReShade32.dll');
const stampName=candidate==='production'?'electron_game_overlay_runtime.build.json':arch==='x64'?'electron_game_overlay_runtime.build.json':'electron_game_overlay_runtime32.build.json';
const stamp=JSON.parse(read(path.join(candidateRoot,stampName)));assert.equal(stamp.runtimeGeneration,generation);
if(candidate==='production')assert.equal(JSON.parse(read(path.join(candidateRoot,arch==='x64'?'ReShade64.build.json':'ReShade32.build.json'))).presentDestinationsPatchSha256,'6CB46B131E4FDEBB06A7EC48DC3BF78C4714F3DD644D5033785FED87B3240236');
const owner=path.join(stage,'.fixture-owner.json');if(fs.existsSync(stage))assert.equal(JSON.parse(read(owner)).kind,'ego-owned-foreign-present-stage');else{fs.mkdirSync(path.join(stage,'addons'),{recursive:true});fs.writeFileSync(owner,JSON.stringify({kind:'ego-owned-foreign-present-stage',architecture:arch}));}
const runtime=path.join(stage,path.basename(input));if(!fs.existsSync(runtime))fs.linkSync(input,runtime);assert.equal(sha(fs.readFileSync(runtime)),sha(fs.readFileSync(input)));
fs.writeFileSync(path.join(stage,'electron-game-overlay-owned-runtime-v1.marker'),'ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1\n');
fs.writeFileSync(path.join(stage,'.electron-game-overlay-run.json'),JSON.stringify({kind:'owned-offscreen-foreign-present-fixture'}));
fs.writeFileSync(path.join(stage,'ReShade.ini'),'[ADDON]\nAddonPath='+path.join(stage,'addons')+'\n[OVERLAY]\nTutorialProgress=4\nShowClock=0\nShowFPS=0\n[GENERAL]\nNoDebugInfo=1\nPerformanceMode=1\n');
function run(exe,args,timeout=120000){const result=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:4*1024*1024});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);return result;}
const detoursSource=path.join(root,'build/fixture-detours-v4.0.1');
const configure=run('cmake.exe',['-S',__dirname,'-B',build,'-A',arch==='x64'?'x64':'Win32','-DRESHAPE_SOURCE='+source,'-DDETOURS_SOURCE_DIR='+(priorEngine==='detours'?detoursSource:'')]);
const compile=run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);fs.writeFileSync(path.join(work,label+'-build.log'),configure.stdout+compile.stdout+compile.stderr);
const output=path.join(build,'Release'),cases=[];
const strategies=priorEngine==='repatch'?['relay-repatch-loss']:priorEngine==='repatch-preserve'?['relay-repatch-preserve']:relay?(only?['relay']:['relay','relay-disabled','relay-forced-error']):only?['inline']:['inline','vtable','disabled','forced-error'];
for(const strategy of strategies)for(const video of only?['video']:['video','ordinary'])for(const prior of only?['prior']:['prior','no-prior'])for(const surface of only?['legacy']:['legacy','flip']){
 const name=[strategy,video,prior,surface].join('-'),result=cp.spawnSync(path.join(output,'foreign_present.exe'),[runtime,path.join(output,'owned_adapter.dll'),path.join(output,priorEngine==='detours'?'prior_detours.dll':'prior_present.dll'),path.join(output,'foreign_renderer.dll'),stage,strategy,video,prior,surface],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:4*1024*1024});
 fs.writeFileSync(path.join(work,label+'-'+name+'.stdout.log'),result.stdout??'');fs.writeFileSync(path.join(work,label+'-'+name+'.stderr.log'),result.stderr??'');
 const nativeLog=path.join(stage,'ReShade.log');let snapshots=[];
 if(fs.existsSync(nativeLog)){const text=read(nativeLog);fs.writeFileSync(path.join(work,label+'-'+name+'.ReShade.log'),text);snapshots=text.split('\n').filter(s=>s.includes('EGO_COMPATIBILITY_SNAPSHOT_V1')).map(s=>JSON.parse(s.slice(s.indexOf('{'))));}
 assert.ifError(result.error);assert.equal(result.status,0,name+'\n'+result.stdout+'\n'+result.stderr);const record=JSON.parse(result.stdout.trim());
 if(priorEngine==='repatch'&&prior==='prior'){
  assert.equal(record.status,'expected-repatch-loss');assert.equal(record.foreignPresentCalls,1);assert.equal(record.nestedRawCalls,1);assert.equal(record.proxyRuntimeCallbacks,2);assert.equal(record.gpuGreenReadbacks,1);assert.equal(record.priorContinues,true);
  cases.push({name,record,snapshots});console.log('EXPECTED_LOSS '+arch+' '+name);continue;
 }
 assert.equal(record.status,'passed');assert.equal(record.foreignPresentCalls,3);assert.equal(record.foreignPresent1Calls,3);assert.equal(record.nestedRawCalls,6);assert.equal(record.proxyRuntimeCallbacks,4);assert.equal(record.gpuGreenReadbacks,strategy.endsWith('disabled')?0:4);assert.equal(record.gpuRedReadbacks,strategy.endsWith('disabled')?4:0);
 const entries=snapshots.filter(s=>s.kind==='present-entry');assert.ok(entries.some(s=>s.role==='proxy'&&s.method==='Present'));assert.ok(entries.some(s=>s.role==='raw'&&s.method==='Present'&&s.dxgiInternal===true));
 const proxy=entries.find(s=>s.role==='proxy'&&s.method==='Present'),raw=entries.find(s=>s.role==='raw'&&s.method==='Present');assert.equal(proxy.downstreamInstance,raw.instance);assert.equal(BigInt('0x'+raw.instance).toString(),String(record.foreignTrackedIdentity));
 if(relay&&arch==='x64'){
  assert.equal(proxy.targetJumpHops,2);assert.equal(proxy.targetJumpOwner,'private-code');
  const registered=snapshots.find(s=>s.kind==='native-registration'&&s.method==='Present');assert.ok(registered);
  assert.equal(proxy.targetJumpFirst,registered.targetJumpFirst);assert.notEqual(proxy.targetJumpDestination,registered.targetJumpDestination);
  assert.equal(raw.savedJumpDestination,registered.savedJumpDestination);
 }
 cases.push({name,record,snapshots});console.log('PASS '+arch+' '+name);
}
const files=['fixture.cpp','renderer.cpp','adapter.cpp','contract.hpp','CMakeLists.txt','run-gate.cjs'].map(name=>({name,sha256:sha(fs.readFileSync(path.join(__dirname,name)))}));
const detoursLock=priorEngine==='detours'?JSON.parse(read(path.join(__dirname,'../early-process-bootstrap/detours-source-lock.json'))):null;
const report={kind:'ego-production-proxy-raw-late-foreign-present-gpu-readback',status:'passed',architecture:arch,relayPlacementModel:relay?(arch==='x64'?'existing-E9-FF25-pointer-slot':'existing-E9-destination-detour'):null,runtimeSha256:sha(fs.readFileSync(runtime)),runtimeGeneration:generation,cases,sourceFiles:files,fullRuntimeCopiesPerCase:0,runtimeHardlinks:1,actualSteam:false,scope:'Production SDK-first/raw-hook installation, independent pre-existing detour, later foreign factory and Present detours, exact original-chain identity, actual registered proxy present callbacks, GPU green backbuffer readback and once-only HRESULT forwarding. A native-parent-factory tracking seam models the later successful tracking boundary in the Steam trace. Relay mode models placement only; it does not emulate Steam or RTSS private implementations. Hidden HWNDs are never shown or activated; no input, user game, Steam code or actual overlay-display acceptance.'};
report.priorHookEngine=priorEngine;report.detoursSourceLock=detoursLock;
const reportPath=path.join(work,label+'-report.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,architecture:arch,cases:cases.length,report:reportPath}));
