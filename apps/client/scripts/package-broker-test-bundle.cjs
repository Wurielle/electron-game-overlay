'use strict';
// Copy-only assembler: no SDK merging, framework pruning, native execution or registration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cells = ['x64-d3d9','x64-d3d10','x64-d3d11','x64-d3d12','x86-d3d9','x86-d3d10'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const inside = (root,p) => {const r=path.relative(root,p);return r!== '..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r);};
function inventory(root) {
  const entries=[];let total=0;
  function walk(dir,depth) {
    if(depth>64)throw Error('source depth exceeds bound');
    const names=fs.readdirSync(dir).sort();const seen=new Set();
    for(const name of names) {
      if(/[\x00-\x1f]/.test(name) || seen.has(name.toLowerCase()))throw Error('unsafe source entry');seen.add(name.toLowerCase());
      const file=path.join(dir,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || !inside(root,fs.realpathSync(file)))throw Error('source must be canonical regular files/directories');
      if(entries.length>=100000)throw Error('source entry count exceeds bound');
      if(stat.isDirectory()){entries.push({path:path.relative(root,file),directory:true});walk(file,depth+1);}
      else {if(stat.size>1024*1024*1024 || (total+=stat.size)>8*1024*1024*1024)throw Error('source size exceeds bound');entries.push({path:path.relative(root,file),size:stat.size,sha256:hash(fs.readFileSync(file))});}
    }
  }
  walk(root,0);return entries;
}
function json(root,p) {return JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''));}
function validateApp(root,role,entries) {
  const files=new Map(entries.filter(e=>!e.directory).map(e=>[e.path,e]));
  const requireFile=p=>{const e=files.get(path.normalize(p));if(!e || e.size===0)throw Error('incomplete app: '+p);return e;};
  for(const p of ['ElectronGameOverlayDemo.exe','resources/node/node.exe','resources/app/package.json','Start Broker Test.cmd','SDK-REVISION.json'])requireFile(p);
  const main=json(root,'resources/app/package.json').main;
  if(typeof main!=='string' || !inside(path.join(root,'resources/app'),path.resolve(root,'resources/app',main)))throw Error('invalid app main');
  requireFile(path.join('resources/app',main));
  const sdk='resources/app/node_modules/electron-game-overlay/';
  const metadata=json(root,sdk+'package.json'),revision=json(root,'SDK-REVISION.json');
  const impl=requireFile(sdk+'dist/lib/overlay-broker-native-provider.js');
  if(metadata.name!=='electron-game-overlay' || revision.role!==role || !/^[a-f0-9]{40}$/.test(revision.sdkSourceRevision) || revision.packageVersion!==metadata.version || !/^[a-f0-9]{64}$/.test(revision.sdkImplementationSha256) || revision.sdkImplementationSha256!==impl.sha256 || (role==='previous' && !/^[0-9]+$/.test(revision.sdkArtifactId)))throw Error('invalid SDK revision or raw implementation hash');
  const seals=entries.filter(e=>!e.directory && e.path.startsWith(path.normalize(sdk+'dist/')) && path.basename(e.path)==='broker-manifest.json');
  if(!seals.length)throw Error('missing SDK broker seal');
  for(const seal of seals) {
    const manifest=json(root,seal.path),base=path.dirname(seal.path),seen=new Set();
    if(manifest.schema!==1 || !Array.isArray(manifest.files) || !manifest.files.length)throw Error('invalid SDK seal');
    for(const entry of manifest.files) {
      if(typeof entry.path!=='string' || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(p=>p==='..' || p==='') || seen.has(entry.path.toLowerCase()))throw Error('invalid sealed path');
      seen.add(entry.path.toLowerCase());const copied=requireFile(path.join(base,entry.path));
      if(copied.size!==entry.size || copied.sha256!==entry.sha256)throw Error('SDK seal raw hash mismatch');
    }
  }
  const manifest=json(root,'smoke/manifest.json');
  if(manifest.schemaVersion!==1 || !Array.isArray(manifest.hosts) || manifest.hosts.length!==6)throw Error('invalid six-cell host manifest');
  const seen=new Set();
  for(const h of manifest.hosts) {
    const cell=h.architecture+'-'+h.backend;
    if(!cells.includes(cell) || seen.has(cell) || typeof h.path!=='string' || path.isAbsolute(h.path) || h.path.split(/[\\/]/).includes('..'))throw Error('invalid host cell');seen.add(cell);
    const e=requireFile('smoke/'+h.path);if(e.size!==h.size || e.sha256!==h.sha256)throw Error('host raw hash mismatch');
  }
  if(manifest.runner?.path!=='broker-smoke-host-runner.cjs')throw Error('invalid runner');
  const runner=requireFile('smoke/'+manifest.runner.path);
  if(runner.size!==manifest.runner.size || runner.sha256!==manifest.runner.sha256)throw Error('runner raw hash mismatch');
  return impl.sha256;
}
function packageBundle(options) {
  const sources={};const entries={};const identities={};
  for(const role of ['current','previous']) {
    const p=path.resolve(options[role]);if(fs.realpathSync(p)!==p || !fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())throw Error('source root must be canonical');
    sources[role]=p;entries[role]=inventory(p);identities[role]=validateApp(p,role,entries[role]);
  }
  if(inside(sources.current,sources.previous) || inside(sources.previous,sources.current) || identities.current===identities.previous)throw Error('independent different SDK applications required');
  const output=path.resolve(options.output),parent=path.dirname(output);
  if(fs.realpathSync(parent)!==parent || ['current','previous'].some(r=>inside(sources[r],output) || inside(output,sources[r])))throw Error('output must be canonical and separate from sources');
  let owned=false;
  try {
    fs.mkdirSync(output);owned=true;
    for(const role of ['current','previous']) {
      const dest=path.join(output,role);fs.mkdirSync(dest);
      for(const e of entries[role]) {
        const target=path.join(dest,e.path);
        if(e.directory)fs.mkdirSync(target);
        else {fs.copyFileSync(path.join(sources[role],e.path),target,fs.constants.COPYFILE_EXCL);if(hash(fs.readFileSync(target))!==e.sha256)throw Error('copied app raw hash mismatch');}
      }
      if(JSON.stringify(inventory(sources[role]))!==JSON.stringify(entries[role]) || JSON.stringify(inventory(dest))!==JSON.stringify(entries[role]))throw Error('source or copy changed during packaging');
      fs.writeFileSync(path.join(output,role+'.cmd'),`@echo off\r\nsetlocal\r\ncall "%~dp0${role}\\Start Broker Test.cmd"\r\nexit /b %errorlevel%\r\n`,{flag:'wx'});
    }
    fs.mkdirSync(path.join(output,'tests'));
    for(const cell of cells) {
      const [arch,backend]=cell.split('-');
      fs.writeFileSync(path.join(output,'tests',cell+'.cmd'),`@echo off\r\nsetlocal\r\n"%~dp0..\\current\\resources\\node\\node.exe" "%~dp0..\\current\\smoke\\broker-smoke-host-runner.cjs" --app-a "%~dp0..\\current\\ElectronGameOverlayDemo.exe" --app-b "%~dp0..\\previous\\ElectronGameOverlayDemo.exe" --host-manifest "%~dp0..\\current\\smoke\\manifest.json" --architecture ${arch} --backend ${backend} --output-root "%~dp0results\\${cell}"\r\nexit /b %errorlevel%\r\n`,{flag:'wx'});
    }
    fs.writeFileSync(path.join(output,'README.md'),`# Portable test bundle\n\nExtract the complete ego folder; keep current and previous intact. Both complete apps retain their original SDK-REVISION.json and all dependencies. Never merge SDKs or resources. No developer tools are required. The separately installed Microsoft runtime prerequisites below still apply.\n\n## Ordinary watcher launch\nRun current.cmd and previous.cmd for the ordinary watcher-based game workflow, including game relaunch. These call each app's existing Start Broker Test.cmd. Read each app's displayed hotkey labels: per-app shortcuts can differ. Use the tray to show or quit the app; return to the desktop with the normal Windows desktop/task-switch controls if needed.\n\n## Six paired controlled-host tests\nRun one CMD in tests. Both apps and the appropriate prebuilt host are selected automatically; no app-b path to type. Read current/smoke/README.md for architecture, graphics and separately supplied Microsoft runtime prerequisites. This exact-PID workflow is distinct from watcher-based game relaunch. Close the owned host or cancel its console when finished; reports go under tests/results.\n\nUse visible overlays and interaction to judge acceptance; readiness logs are not proof of native injection count or GUI success. Packaging is copy-only and does not prove Windows/native acceptance. No broker termination, crash test, security probe or registration is requested by these wrappers.\n`,{flag:'wx'});
    const entryCount=inventory(output).filter(e=>!e.directory).length;
    const expected=entries.current.filter(e=>!e.directory).length+entries.previous.filter(e=>!e.directory).length+9;
    if(entryCount!==expected)throw Error('bundle entry count mismatch');
    return {status:'packaged',nativeExecuted:false,entryCount,pairedLauncherCount:cells.length};
  }catch(error){if(owned)fs.rmSync(output,{recursive:true,force:true});throw error;}
}
module.exports={packageBundle};
if(require.main===module) {
  const report={status:'failed',nativeExecuted:false};
  try {
    const options={},keys={'--current':'current','--previous':'previous','--output':'output'},args=process.argv.slice(2);
    for(let i=0;i<args.length;i+=2){const key=keys[args[i]];if(!key || options[key] || !args[i+1] || args[i+1].startsWith('--'))throw Error('invalid CLI arguments');options[key]=args[i+1];}
    if(Object.keys(options).length!==3)throw Error('current, previous and output are required');
    Object.assign(report,packageBundle(options));
  }catch(error){report.reason=error.message;process.exitCode=1;}
  console.log(JSON.stringify(report));
}
