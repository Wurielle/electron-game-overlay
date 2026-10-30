'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/package-broker-smoke-hosts.cjs');
const revision = 'A'.repeat(40);
const cells = [['x64','d3d9'],['x64','d3d10'],['x64','d3d11'],['x64','d3d12'],['x86','d3d9'],['x86','d3d10']];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
// Synthetic PE parser fixtures only: these are not executable Windows hosts.
function pe(arch, dll = 'KERNEL32.dll', delay = false) {
  const b = Buffer.alloc(2048); b.write('MZ'); b.writeUInt32LE(128,60); b.write('PE\0\0',128);
  b.writeUInt16LE(arch === 'x64' ? 0x8664 : 0x14c,132); b.writeUInt16LE(1,134);
  const n = arch === 'x64' ? 240 : 224, opt = 152;
  b.writeUInt16LE(n,148); b.writeUInt16LE(arch === 'x64' ? 0x20b : 0x10b,opt);
  b.writeUInt32LE(512,opt+60); b.writeUInt32LE(16,opt+(arch==='x64'?108:92));
  const section = opt+n; b.write('.rdata',section); b.writeUInt32LE(1536,section+8); b.writeUInt32LE(4096,section+12); b.writeUInt32LE(1536,section+16); b.writeUInt32LE(512,section+20);
  const directory = opt+(arch==='x64'?112:96)+(delay?13:1)*8;
  b.writeUInt32LE(4096,directory); b.writeUInt32LE(delay?64:40,directory+4);
  if(delay){b.writeUInt32LE(1,512);b.writeUInt32LE(4352,516);}else b.writeUInt32LE(4352,524);
  b.write(dll+'\0',768); return b;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'host-packager-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options = { hostRoot64:path.join(root,'64'),hostRoot32:path.join(root,'32'),output:path.join(root,'complete app','smoke'),revision,runnerPath:path.join(root,'runner.cjs') };
  fs.mkdirSync(path.dirname(options.output),{recursive:true}); fs.mkdirSync(options.hostRoot64); fs.mkdirSync(options.hostRoot32); fs.writeFileSync(options.runnerPath,"'use strict';\n");
  for(const [arch,backend] of cells)fs.writeFileSync(path.join(arch==='x64'?options.hostRoot64:options.hostRoot32,backend+'_overlay_test_host.exe'),pe(arch));
  return {root,options};
}
test('rejects missing, wrong-machine, malformed imports, unknown dependencies and escapes without output',t=>{
  const {packageHosts}=require(script);
  for(const kind of ['missing','machine','header','imports','delay','unknown','escape','oversize','revision']){
    const {options,root}=fixture(t); const file=path.join(options.hostRoot64,'d3d9_overlay_test_host.exe');
    if(kind==='missing')fs.unlinkSync(file);
    if(kind==='machine')fs.writeFileSync(file,pe('x86'));
    if(kind==='header')fs.writeFileSync(file,Buffer.from('MZ'));
    if(kind==='imports'){const b=pe('x64');b.writeUInt32LE(0xfffffff0,524);fs.writeFileSync(file,b);}
    if(kind==='delay'){const b=pe('x64','KERNEL32.dll',true);b.writeUInt32LE(0,512);fs.writeFileSync(file,b);}
    if(kind==='unknown')fs.writeFileSync(file,pe('x64','foreign.dll'));
    if(kind==='escape'){fs.renameSync(file,path.join(root,'outside.exe'));fs.symlinkSync(path.join(root,'outside.exe'),file);}
    if(kind==='oversize')fs.truncateSync(file,64*1024*1024+1);
    if(kind==='revision')options.revision='bad';
    assert.throws(()=>packageHosts(options),undefined,kind);assert.equal(fs.existsSync(options.output),false,kind);
  }
});
test('records normal and delayed MSVC prerequisites separately by architecture',t=>{
  const {options}=fixture(t);const {packageHosts}=require(script);
  fs.writeFileSync(path.join(options.hostRoot64,'d3d9_overlay_test_host.exe'),pe('x64','VCRUNTIME140.dll'));
  fs.writeFileSync(path.join(options.hostRoot32,'d3d9_overlay_test_host.exe'),pe('x86','MSVCP140.dll',true));
  packageHosts(options);const m=JSON.parse(fs.readFileSync(path.join(options.output,'manifest.json')));
  assert.deepEqual(m.hosts[0].imports,['VCRUNTIME140.dll']);assert.deepEqual(m.hosts[4].delayImports,['MSVCP140.dll']);
  assert.deepEqual(m.prerequisites.map(x=>x.architecture),['x64','x86']);
  const readme=fs.readFileSync(path.join(options.output,'README.md'),'utf8');assert.match(readme,/vc_redist.x64.exe/);assert.match(readme,/vc_redist.x86.exe/);assert.match(readme,/not.*attestation/i);
});
test('preserves existing destinations and cleans partial writes on failure',t=>{
  const {options}=fixture(t);const {packageHosts}=require(script);fs.mkdirSync(options.output);fs.writeFileSync(path.join(options.output,'keep'),'unchanged');
  assert.throws(()=>packageHosts(options));assert.equal(fs.readFileSync(path.join(options.output,'keep'),'utf8'),'unchanged');
  fs.rmSync(options.output,{recursive:true});const original=fs.writeFileSync;
  try{fs.writeFileSync=function(p,...args){if(String(p).endsWith('manifest.json'))throw Error('controlled disk write failure');return original.call(this,p,...args);};assert.throws(()=>packageHosts(options),/controlled disk write failure/);}finally{fs.writeFileSync=original;}
  assert.equal(fs.existsSync(options.output),false);
});
test('CLI reports failure-default JSON for invalid arguments and headers without native execution',t=>{
  const {options}=fixture(t);
  const args=['--host-root64',options.hostRoot64,'--host-root32',options.hostRoot32,'--output',options.output,'--revision',revision];
  const run=extra=>spawnSync(process.execPath,[script,...args,...extra],{encoding:'utf8',timeout:10000});
  const bad=run(['--unexpected','x']);assert.equal(bad.status,1);assert.equal(JSON.parse(bad.stdout).nativeExecuted,false);assert.equal(fs.existsSync(options.output),false);
  fs.writeFileSync(path.join(options.hostRoot64,'d3d9_overlay_test_host.exe'),'MZ');const broken=run([]);assert.equal(broken.status,1);assert.equal(JSON.parse(broken.stdout).status,'failed');
});
test('rejects copied-byte hash corruption and removes only the newly created output',t=>{
  const {options}=fixture(t);const {packageHosts}=require(script);const original=fs.writeFileSync;
  try{fs.writeFileSync=function(p,data,...args){if(String(p).startsWith(options.output) && String(p).endsWith('.exe')){const changed=Buffer.from(data);changed[changed.length-1]^=1;return original.call(this,p,changed,...args);}return original.call(this,p,data,...args);};assert.throws(()=>packageHosts(options),/hash mismatch/);}finally{fs.writeFileSync=original;}
  assert.equal(fs.existsSync(options.output),false);assert.equal(fs.readdirSync(options.hostRoot64).length,4);
});
test('real CLI packages parser fixtures with an explicit trusted runner and reads back exact counts',t=>{
  const {options}=fixture(t);const result=spawnSync(process.execPath,[script,'--host-root64',options.hostRoot64,'--host-root32',options.hostRoot32,'--output',options.output,'--revision',options.revision,'--runner-path',options.runnerPath],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).nativeExecuted,false);
  const list=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(x=>x.isDirectory()?list(path.join(root,x.name)):[path.join(root,x.name)]);
  const files=list(options.output);assert.equal(files.length,15);assert.equal(files.filter(f=>f.endsWith('.exe')).length,6);assert.equal(files.filter(f=>f.endsWith('.cmd')).length,6);assert.equal(files.filter(f=>f.endsWith('.dll')).length,0);
  const m=JSON.parse(fs.readFileSync(path.join(options.output,'manifest.json')));assert.equal(m.runner.sha256,hash(fs.readFileSync(options.runnerPath)));
});
test('packages exactly six parser fixtures with hashes, runner and relative CMD launchers',t=>{
  const {options}=fixture(t); const {packageHosts}=require(script); const result=packageHosts(options);
  assert.equal(result.nativeExecuted,false); assert.equal(result.status,'packaged');
  const m=JSON.parse(fs.readFileSync(path.join(options.output,'manifest.json'))); assert.equal(m.sourceRevision,revision);assert.equal(m.hosts.length,6);
  for(const h of m.hosts){const b=fs.readFileSync(path.join(options.output,h.path));assert.equal(h.sha256,hash(b));assert.equal(h.size,b.length);assert.equal(h.peMachine,h.architecture==='x64'?0x8664:0x14c);}
  assert.equal(fs.readFileSync(path.join(options.output,'broker-smoke-host-runner.cjs'),'utf8'),fs.readFileSync(options.runnerPath,'utf8'));
  const cmds=fs.readdirSync(options.output).filter(x=>x.endsWith('.cmd'));assert.equal(cmds.length,6);
  for(const name of cmds){const cmd=fs.readFileSync(path.join(options.output,name),'utf8');assert.match(cmd,/%~dp0\.\.\\resources\\node\\node\.exe/);assert.match(cmd,/--app-a "%~dp0\.\.\\ElectronGameOverlayDemo\.exe"/);assert.match(cmd,/%\*/);assert.doesNotMatch(cmd,/sandbox|devtools|remote-debug|\bnpm\b/);}
});
