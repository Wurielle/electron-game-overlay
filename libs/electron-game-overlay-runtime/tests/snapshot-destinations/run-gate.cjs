'use strict';
// Prepare and test an unapplied diagnostic proposal. Never touches runtime source/cache.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),architecture=process.argv[2]??'x64';assert.ok(['x64','x86'].includes(architecture));
const cache=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src');
const base=path.join(root,'build/overlay-compatibility/snapshot-destinations',architecture),scratch=path.join(base,'proposal');
const relative='source/ego_owned_late_d3d11/compatibility_snapshot.hpp',header=path.join(scratch,relative),build=path.join(base,'build');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const live=fs.readFileSync(path.join(cache,relative),'utf8').replaceAll('\r\n','\n');
const {frozenInputs}=require('../frozen-source-inputs.cjs');
const original=frozenInputs({pins:[{name:relative,digest:'C0FE868ED8B0FA7FE7688DB19252BE427316DFC1D73C5F4AF5BBD299A8662F50'}],cache,scratch:path.join(base,'frozen-basis'),transitions:[]}).get(relative).toString();
assert.equal(sha(original),'c0fe868ed8b0fa7fe7688db19252be427316dfc1d73c5f4af5bbd299a8662f50');
const patch=fs.readFileSync(path.join(__dirname,'proposal.patch'),'utf8').replaceAll('\r\n','\n');
assert.equal(sha(patch),'18b097700582fcfe1160c3e554165d792488ed356aabf5e6585a24b4c9ca5243');
fs.mkdirSync(path.dirname(header),{recursive:true});fs.writeFileSync(header,original);
const patchPath=path.join(base,'proposal.patch');fs.writeFileSync(patchPath,patch);
function run(exe,args,options={}){const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024,...options});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;}
const env={...process.env,GIT_CEILING_DIRECTORIES:base};delete env.GIT_DIR;delete env.GIT_WORK_TREE;delete env.GIT_INDEX_FILE;
for(const mode of ['--check','--apply'])run('git',['-c','core.autocrlf=false','apply',mode,patchPath],{cwd:scratch,env});
const proposed=fs.readFileSync(header,'utf8');assert.equal(sha(proposed),'907fb8defd69988e3b244ab958a0bf362af808b254e080c7dbd1940d7d9b7c14');
const source=path.join(root,'libs/electron-game-overlay-runtime/tests/compatibility-snapshot');
const configure=run('cmake.exe',['-S',source,'-B',build,'-A',architecture==='x64'?'x64':'Win32','-DSNAPSHOT_HEADER='+header,'-DMINHOOK_SOURCE_DIR='+path.join(cache,'deps/minhook'),'-DSNAPSHOT_DESTINATIONS=ON']);
const compile=run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);fs.writeFileSync(path.join(base,'build.log'),configure.stdout+compile.stdout+compile.stderr);
const result=run(path.join(build,'Release/compatibility_snapshot.exe'),[path.join(build,'Release/snapshot_foreign.dll')]);fs.writeFileSync(path.join(base,'stdout.log'),result.stdout);
const lines=result.stdout.trim().split(/\r?\n/),fixture=JSON.parse(lines.at(-1)),records=lines.slice(0,-1).map(s=>JSON.parse(s.slice(s.indexOf('{'))));
assert.equal(fixture.status,'passed');assert.equal(records.length,17);assert.equal(fixture.nativeCalls,9);assert.equal(fixture.foreignCalls,9);assert.equal(fixture.referenceCount,1);
const callbacks=records.filter(r=>r.kind==='native-registration'||r.kind==='present-entry');assert.equal(callbacks.length,6);
const pointer=s=>BigInt('0x'+s);
for(const rec of records){assert.equal(rec.runtimeGeneration,36);assert.ok(JSON.stringify(rec).length<3000);assert.ok(!Object.keys(rec).some(k=>/path|token|environmentValue/i.test(k)));}
for(const rec of callbacks){
 assert.equal(rec.addressDetailsVersion,1);assert.equal(rec.targetJumpOwner,'other-image');assert.ok(rec.targetJumpHops>0&&rec.targetJumpHops<=2);
 assert.equal(pointer(rec.targetJumpDestination),pointer(rec.current));
 assert.equal(pointer(rec.targetJumpDestination),pointer(rec.targetJumpAllocationBase)+pointer(rec.targetJumpAllocationOffset));
 assert.equal(pointer(rec.targetJumpDestination),pointer(rec.targetJumpHops===1?rec.targetJumpFirst:rec.targetJumpSecond));
 assert.equal(rec.savedOwner,'private-code');
 for(const prefix of ['current','target','saved']){assert.ok(rec[prefix+'JumpHops']<=2);if(pointer(rec[prefix+'JumpAllocationBase']))assert.equal(pointer(rec[prefix+'JumpDestination']),pointer(rec[prefix+'JumpAllocationBase'])+pointer(rec[prefix+'JumpAllocationOffset']));}
}
assert.equal(fs.readFileSync(path.join(cache,relative),'utf8').replaceAll('\r\n','\n'),live);
const report={kind:'unapplied-bounded-present-destination-diagnostic',status:'passed',architecture,productionSourceChanged:false,productionRuntimeBuilt:false,basisGeneration:36,baseSha256:sha(original),proposedSha256:sha(proposed),patchSha256:sha(patch),fixture,records,scope:'Existing production observer plus unapplied address-only proposal; actual independent DLL detours, saved private trampoline, two-hop cycle bound, E9/FF25 decode, unreadable/page-boundary rejection, exact module range, unchanged callbacks/arguments/results/references/last-error, and 17-record bound. Not Steam or game acceptance.'};
const output=path.join(base,'report.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'passed',architecture,assertions:fixture.assertions,records:records.length,output}));
