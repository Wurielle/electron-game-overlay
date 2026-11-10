'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),architecture=process.argv[2]??'x64';assert.ok(['x64','x86'].includes(architecture));
const source=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src/tools/injector.cpp');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sourceHash=sha(fs.readFileSync(source,'utf8').replaceAll('\r\n','\n'));assert.equal(sourceHash,'7a6dc34363ff8ebd78484d8aee6ce0463f22e90ab35dd1261fc9fbd9b09a3a3e');
const base=path.join(root,'build/overlay-compatibility'),build=path.join(base,'private-diagnostic-fixture-'+architecture);
function run(exe,args){const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;}
run('cmake.exe',['-S',__dirname,'-B',build,'-A',architecture==='x64'?'x64':'Win32','-DINJECTOR_SOURCE='+source]);run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);
const data=path.join(build,'owned-diagnostic-data.bin');
const result=run(path.join(build,'Release/private_stage_diagnostics.exe'),[data]);assert.equal(fs.existsSync(data),false);
fs.writeFileSync(path.join(base,'private-diagnostic-'+architecture+'.log'),result.stdout);fs.writeFileSync(path.join(base,'private-diagnostic-'+architecture+'.stderr.log'),result.stderr);
const lines=result.stdout.trim().split(/\r?\n/u),diagnostics=lines.filter(s=>s.startsWith('EGO_PRIVATE_ELEVATED_STAGE_DIAGNOSTIC_V1 ')).map(s=>JSON.parse(s.slice(s.indexOf('{'))));
assert.equal(diagnostics.length,2);assert.deepEqual(diagnostics.map(d=>[d.artifact,d.operation,d.windowsError]),[['fixture-owned-data','open-native-read-guard',32],['stage-directory','open-directory-read-guard',32]]);
for(const d of diagnostics){assert.deepEqual(Object.keys(d).sort(),['artifact','injectorPid','operation','schemaVersion','windowsError']);assert.equal(d.schemaVersion,1);assert.ok(Number.isInteger(d.injectorPid)&&d.injectorPid>0);}
const fixture=JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf('{')));assert.equal(fixture.status,'passed');assert.equal(fixture.assertions,17);assert.equal(fixture.injection,false);assert.equal(fixture.graphics,false);
const report={kind:'ego-private-stage-diagnostic-native-contract',status:'passed',architecture,sourceSha256:sourceHash,diagnostics,fixture,scope:'Frozen production helpers with real owned Win32 file/directory sharing conflicts. Verifies exact failure operation, preserved error and GetLastError, retained read-guard write exclusion and release on scope exit. No injection, actual high-stage acceptance, graphics or input.'};
fs.writeFileSync(path.join(base,'private-diagnostic-'+architecture+'-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
