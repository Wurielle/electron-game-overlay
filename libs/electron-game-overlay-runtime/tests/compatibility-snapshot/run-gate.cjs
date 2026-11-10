'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),architecture=process.argv[2]??'x64';assert.ok(['x64','x86'].includes(architecture));
const base=path.join(root,'build/overlay-compatibility'),cache=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src');
const header=path.join(base,'snapshot-production-header.hpp'),build=path.join(base,'snapshot-fixture-'+architecture);
const patch=fs.readFileSync(path.join(root,'libs/electron-game-overlay-runtime/patches/reshade-compatibility-snapshot.patch'),'utf8').replaceAll('\r\n','\n');
const section=patch.slice(patch.indexOf('+++ b/source/ego_owned_late_d3d11/compatibility_snapshot.hpp'));
assert.ok(section.startsWith('+++ b/'));fs.writeFileSync(header,section.split('\n').filter(s=>s.startsWith('+')&&!s.startsWith('+++')).map(s=>s.slice(1)).join('\n')+'\n');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sourceSha256=sha(fs.readFileSync(header,'utf8').replaceAll('\r\n','\n'));assert.equal(sourceSha256,'b6c215b7780483a6b859759f088a565be9f5af023115935441f373e81a1dcdee');
function run(exe,args){const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;}
run('cmake.exe',['-S',__dirname,'-B',build,'-A',architecture==='x64'?'x64':'Win32','-DSNAPSHOT_HEADER='+header,'-DMINHOOK_SOURCE_DIR='+path.join(cache,'deps/minhook')]);
run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);
const r=run(path.join(build,'Release/compatibility_snapshot.exe'),[path.join(build,'Release/snapshot_foreign.dll')]);
fs.writeFileSync(path.join(base,'snapshot-'+architecture+'.log'),r.stdout);
const lines=r.stdout.trim().split(/\r?\n/),records=lines.slice(0,-1).map(s=>{assert.ok(s.startsWith('EGO_COMPATIBILITY_SNAPSHOT_V1 '));return JSON.parse(s.slice(s.indexOf('{')));}),fixture=JSON.parse(lines.at(-1));
assert.equal(fixture.status,'passed');assert.equal(records.length,17);assert.equal(fixture.nativeCalls,9);assert.equal(fixture.foreignCalls,9);assert.equal(fixture.referenceCount,1);
for(const rec of records){assert.equal(rec.schemaVersion,1);assert.equal(rec.runtimeGeneration,31);assert.ok(rec.pid>0&&rec.tid>0);assert.ok(JSON.stringify(rec).length<1800);assert.ok(!Object.keys(rec).some(k=>/path|token|environmentValue/i.test(k)));}
assert.equal(records.filter(r=>r.kind==='loader').length,1);assert.equal(records.filter(r=>r.kind==='factory-entry'&&r.methodDiscovery).length,1);
const registrations=records.filter(r=>r.kind==='native-registration');assert.equal(registrations.length,2);
for(const rec of registrations){assert.equal(rec.currentOwner,'other-image');assert.equal(rec.targetOwner,'reshade-host');assert.equal(rec.targetJumpOwner,'other-image');assert.ok(rec.targetJumpHops>0&&rec.targetJumpHops<=2);assert.equal(rec.savedOwner,'private-code');}
assert.equal(records.filter(r=>r.kind==='present-entry').length,4);assert.equal(records.filter(r=>r.kind==='present-return').length,4);
const report={kind:'ego-bounded-compatibility-snapshot-owned-foreign-chain-contract',status:'passed',architecture,sourceSha256,fixture,records,scope:'Exact production observation helpers with real MinHook detours through an owned foreign DLL into saved private-code trampolines. Validates role ownership, arguments/HRESULT, exactly-once forwarding, unchanged reference count, GetLastError, log failure isolation and17-record bound. No actual Steam, graphics, input, target injection or game acceptance.'};
const output=path.join(base,'snapshot-'+architecture+'-report.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'passed',architecture,assertions:fixture.assertions,records:records.length,output}));
