'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cells = [['x64','d3d9'],['x64','d3d10'],['x64','d3d11'],['x64','d3d12'],['x86','d3d9'],['x86','d3d10']];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const MAX_IMAGE = 64 * 1024 * 1024;
const osDlls = new Set(('kernel32 kernelbase user32 gdi32 gdi32full advapi32 shell32 shlwapi ole32 oleaut32 comdlg32 comctl32 uuid rpcrt4 ntdll ws2_32 bcrypt crypt32 secur32 version winmm imm32 setupapi cfgmgr32 dwmapi uxtheme dxgi dxguid d3d9 d3d10 d3d10_1 d3d11 d3d12 d3dcompiler_47 ucrtbase msvcrt winspool normaliz iphlpapi').split(' ').map(x=>x+'.dll'));
function runtimeKind(name) {
  const lower=name.toLowerCase();
  if (/^(vcruntime140(?:_1)?|msvcp140(?:_1|_2|_atomic_wait|_codecvt_ids)?|concrt140|vcomp140)\.dll$/.test(lower)) return 'msvc';
  if(osDlls.has(lower) || /^api-ms-win-[a-z0-9-]+\.dll$/.test(lower) || /^ext-ms-win-[a-z0-9-]+\.dll$/.test(lower))return 'os';
  throw Error(`unsupported host dependency: ${name}; supply a reviewed dependency policy, not assumed app-local closure`);
}
function boundedFile(filename, root, max) {
  const canonical=fs.realpathSync(filename), relative=path.relative(root,canonical);
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw Error('source escapes canonical root');
  if(!fs.lstatSync(filename).isFile())throw Error('source must be a regular non-symlink file');
  const fd=fs.openSync(filename,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile() || stat.size<=0 || stat.size>max)throw Error('source size out of bounds');
    const data=Buffer.alloc(stat.size);let at=0;
    while(at<data.length){const n=fs.readSync(fd,data,at,data.length-at,at);if(!n)throw Error('source changed while reading');at+=n;}
    const after=fs.fstatSync(fd);if(after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || fs.realpathSync(filename)!==canonical)throw Error('source changed while reading');
    return data;
  }finally{fs.closeSync(fd);}
}
function inspectPE(b, architecture) {
  const check=(o,n)=>{if(!Number.isSafeInteger(o)||o<0||o+n>b.length)throw Error('malformed PE bounds');};
  const u16=o=>{check(o,2);return b.readUInt16LE(o);},u32=o=>{check(o,4);return b.readUInt32LE(o);};
  check(0,64);if(b.toString('ascii',0,2)!=='MZ')throw Error('invalid MZ header');
  const p=u32(60);check(p,24);if(p<64 || b.toString('ascii',p,p+4)!=='PE\0\0')throw Error('invalid PE header');
  const peMachine=u16(p+4);if(peMachine!==(architecture==='x64'?0x8664:0x14c))throw Error('wrong PE machine');
  const count=u16(p+6), size=u16(p+20), opt=p+24, wide=architecture==='x64';check(opt,size);
  const dd=wide?112:96;if(size<dd || u16(opt)!==(wide?0x20b:0x10b))throw Error('invalid PE optional header');
  const dirs=u32(opt+dd-4);if(dirs>16 || dd+dirs*8>size || !count || count>96)throw Error('malformed PE directory table');
  const sections=[];check(opt+size,count*40);
  for(let i=0;i<count;i++){const s=opt+size+i*40, va=u32(s+12), raw=u32(s+20), length=u32(s+16);check(raw,length);sections.push({va,raw,length});}
  const headers=u32(opt+60);if(headers>b.length)throw Error('malformed PE headers size');
  const rva=(v,n)=>{
    if(v<headers && v+n<=headers){check(v,n);return v;}
    const matches=sections.filter(s=>v>=s.va && v+n<=s.va+s.length);
    if(matches.length!==1)throw Error('malformed PE RVA');return matches[0].raw+v-matches[0].va;
  };
  const dll=v=>{let name='';for(let i=0;i<260;i++){const c=b[rva(v+i,1)];if(!c){if(!/^[A-Za-z0-9_.-]+\.dll$/i.test(name))throw Error('malformed DLL name');runtimeKind(name);return name;}name+=String.fromCharCode(c);}throw Error('unterminated DLL name');};
  function imports(index,stride,delayed){
    if(dirs<=index)return [];const v=u32(opt+dd+index*8),n=u32(opt+dd+index*8+4);if(!v&&!n)return [];
    if(!v || n<stride || n>1024*1024)throw Error('malformed PE imports directory');rva(v,n);
    const names=[];for(let i=0;i+stride<=n;i+=stride){const offset=rva(v+i,stride);let zero=true;for(let j=0;j<stride;j++)if(b[offset+j])zero=false;if(zero)return [...new Set(names)].sort();
      if(names.length>=256)throw Error('too many PE imports');
      if(delayed && u32(offset)!==1)throw Error('unsupported delay import attributes (RVA required)');
      names.push(dll(u32(offset+(delayed?4:12))));
    }throw Error('unterminated PE imports directory');
  }
  return {peMachine,imports:imports(1,20,false),delayImports:imports(13,32,true)};
}
function packageHosts(options) {
  if(!/^[a-fA-F0-9]{40}$/.test(options.revision))throw Error('revision must be exactly 40 hex characters (informational caller claim)');
  const output=path.resolve(options.output), root64=fs.realpathSync(options.hostRoot64),root32=fs.realpathSync(options.hostRoot32);
  const hosts=cells.map(([architecture,backend])=>{
    const filename=backend+'_overlay_test_host.exe',root=architecture==='x64'?root64:root32;
    const data=boundedFile(path.join(root,filename),root,MAX_IMAGE);
    return {backend,architecture,path:`hosts/${architecture}/${filename}`,sha256:hash(data),size:data.length,...inspectPE(data,architecture),data};
  });
  const runnerPath=path.resolve(options.runnerPath || path.join(__dirname,'broker-smoke-host-runner.cjs'));
  const runner=boundedFile(runnerPath,fs.realpathSync(path.dirname(runnerPath)),1024*1024);
  const prerequisites=['x64','x86'].filter(arch=>hosts.some(h=>h.architecture===arch && [...h.imports,...h.delayImports].some(n=>runtimeKind(n)==='msvc'))).map(architecture=>({architecture,product:'Microsoft Visual C++ 2015–2022 Redistributable (v14), installed runtime version at least the build toolset version',installer:`vc_redist.${architecture}.exe`,required:true,minimumVersion:'must be established from fresh Windows build toolset; DLL names alone do not encode the minimum patch version'}));
  let owned=false;
  try{
    fs.mkdirSync(output);owned=true;
    for(const h of hosts){const dest=path.join(output,h.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,h.data,{flag:'wx'});if(hash(fs.readFileSync(dest))!==h.sha256)throw Error('copied host hash mismatch');
      fs.writeFileSync(path.join(output,`${h.architecture}-${h.backend}.cmd`),`@echo off\r\nsetlocal\r\n"%~dp0..\\resources\\node\\node.exe" "%~dp0broker-smoke-host-runner.cjs" --app-a "%~dp0..\\ElectronGameOverlayDemo.exe" --host-manifest "%~dp0manifest.json" --architecture ${h.architecture} --backend ${h.backend} --output-root "%~dp0results\\${h.architecture}-${h.backend}" %*\r\nexit /b %errorlevel%\r\n`,{flag:'wx'});
    }
    fs.writeFileSync(path.join(output,'broker-smoke-host-runner.cjs'),runner,{flag:'wx'});
    if(hash(fs.readFileSync(path.join(output,'broker-smoke-host-runner.cjs')))!==hash(runner))throw Error('copied runner hash mismatch');
    const manifest={schemaVersion:1,sourceRevision:options.revision,sourceRevisionMeaning:'informational caller claim, not attestation',hosts:hosts.map(({data,...h})=>h),runner:{path:'broker-smoke-host-runner.cjs',sha256:hash(runner),size:runner.length},prerequisites,nativeExecuted:false};
    fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    fs.writeFileSync(path.join(output,'README.md'),`# Controlled prebuilt host smoke bundle\n\nPlace this complete smoke directory inside the complete portable App A root. Do not remove app resources. Run one of the six architecture/backend CMD files. Each uses ../resources/node/node.exe and ../ElectronGameOverlayDemo.exe; no development installation is needed. Optional second independent complete App B: append --app-b "C:\\App B\\ElectronGameOverlayDemo.exe". Never merge or copy SDKs.\n\nThe source revision is informational, not an attestation; SHA-256 covers raw copied bytes. Packaging did not execute native code or prove Windows acceptance. The runner may report manual observation pending or fail; packaging is not a native PASS.\n\n## Host prerequisites\nSupported Windows x64 with WOW64 and appropriate Direct3D drivers; unlocked interactive desktop. No DLLs are copied or installed. Native SDK runtime closure is separate from these host imports. Only import names are inspected, not transitive OS dependency closure.\n${prerequisites.length?prerequisites.map(p=>`- ${p.architecture}: ${p.product}; ${p.installer}. ${p.minimumVersion}`).join('\n'):'- No dynamic MSVC import detected in these hosts; this is not a claim of complete app-local runtime closure.'}\nUse a trusted separately supplied redistributable when required; no automatic installation. Fresh Windows build/toolset and actual final asset verification remain required.\n`,{flag:'wx'});
    const readback=JSON.parse(fs.readFileSync(path.join(output,'manifest.json'),'utf8'));if(readback.hosts.length!==6)throw Error('manifest readback failed');
    return {status:'packaged',nativeExecuted:false,hostCount:6};
  }catch(error){if(owned)fs.rmSync(output,{recursive:true,force:true});throw error;}
}
module.exports={packageHosts};
if(require.main===module){
  const report={schemaVersion:1,status:'failed',nativeExecuted:false};
  try{
    const keys={'--host-root64':'hostRoot64','--host-root32':'hostRoot32','--output':'output','--revision':'revision','--runner-path':'runnerPath'},options={},args=process.argv.slice(2);
    for(let i=0;i<args.length;i+=2){const key=keys[args[i]];if(!key || Object.hasOwn(options,key) || !args[i+1] || args[i+1].startsWith('--'))throw Error('invalid CLI arguments');options[key]=args[i+1];}
    for(const k of ['hostRoot64','hostRoot32','output','revision'])if(!options[k])throw Error('required CLI option missing: '+k);
    Object.assign(report,packageHosts(options));
  }catch(error){report.reason=error.message;process.exitCode=1;}
  console.log(JSON.stringify(report));
}
