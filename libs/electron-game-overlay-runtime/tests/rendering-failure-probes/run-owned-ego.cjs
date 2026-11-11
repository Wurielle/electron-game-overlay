'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const visible=process.argv[2]==='--visible'; assert.ok(process.argv.length===2 || (process.argv.length===3 && visible));
const root=path.resolve(__dirname,'../../../..'),base=path.join(root,'build/overlay-compatibility/rendering-failure-probes',visible?'full-ego-visible':'full-ego');
const build=path.join(root,'build/overlay-compatibility/rendering-failure-probes/x64/build');
for(const args of [['-S',__dirname,'-B',build,'-A','x64'],['--build',build,'--config','Release','--target','owned_ego_input','--parallel','4']]) {
  const result=cp.spawnSync('cmake.exe',args,{encoding:'utf8',windowsHide:true}); assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
}
const stage=path.join(base,'stage'),evidence=path.join(base,'producer'),owner=path.join(base,'.fixture-owner.json');
if(fs.existsSync(base)) assert.equal(JSON.parse(fs.readFileSync(owner)).kind,'owned-full-ego-input');
else { fs.mkdirSync(base,{recursive:true});fs.writeFileSync(owner,JSON.stringify({kind:'owned-full-ego-input'})); }
fs.mkdirSync(stage,{recursive:true});fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(path.join(stage,'addons'),{recursive:true});
const dist=path.join(root,'libs/electron-game-overlay-runtime/dist/win32-x64'),addon=path.join(stage,'electron_game_overlay.addon64');
fs.copyFileSync(path.join(dist,'electron_game_overlay.addon64'),addon);
fs.writeFileSync(path.join(stage,'ReShade.ini'),'[ADDON]\nAddonPath='+path.join(stage,'addons')+'\n[OVERLAY]\nTutorialProgress=4\n');
for(const file of ['host-command.txt','host-state.json']) {const p=path.join(stage,file);if(fs.existsSync(p))fs.unlinkSync(p);}
for(const file of ['scene-command.json','scene-state.json']) {const p=path.join(evidence,file);if(fs.existsSync(p))fs.unlinkSync(p);}
const children=[],events=[]; const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function launch(executable,args,label) {
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child=cp.spawn(executable,args,{windowsHide:true,env,stdio:['ignore','pipe','pipe']}); children.push(child);
  child.stdout.pipe(fs.createWriteStream(path.join(base,label+'.stdout.log')));child.stderr.pipe(fs.createWriteStream(path.join(base,label+'.stderr.log')));
  return child;
}
function read(file) {try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}}
const hostState=()=>read(path.join(stage,'host-state.json')),sceneState=()=>read(path.join(evidence,'scene-state.json'));
async function until(test,label,timeout=15000) {const start=Date.now(); while(Date.now()-start<timeout) {const value=test();if(value)return value; for(const child of children)assert.equal(child.exitCode,null,'child exited during '+label);await sleep(40);}throw new Error('Timed out: '+label);}
let sceneSeq=0,hostSeq=0;
async function scene(action) {fs.writeFileSync(path.join(evidence,'scene-command.json'),JSON.stringify({sequence:++sceneSeq,action})); await until(()=>sceneState()?.commandSequence===sceneSeq,action);}
async function host(action) {fs.writeFileSync(path.join(stage,'host-command.txt'),`${++hostSeq} ${action}`);await until(()=>hostState()?.sequence===hostSeq,action);}
function record(name) {const value={name,utc:new Date().toISOString(),host:hostState(),scene:sceneState()};events.push(value);console.log(JSON.stringify({name,host:value.host,intercepting:value.scene?.intercepting,keyDowns:value.scene?.window?.keyDowns,value:value.scene?.window?.value}));return value;}
(async()=>{
  let failure=null;
  try {
    launch(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'libs/electron-game-overlay-runtime/tests/late-d3d11-adoption/scene-producer.cjs'),
      '--sdk-dist='+path.join(root,'libs/electron-game-overlay/dist'),'--stage-directory='+stage,'--evidence-directory='+evidence],'producer');
    await until(()=>sceneState()?.ready,'producer ready');
    launch(path.join(build,'Release/owned_ego_input.exe'),[path.join(dist,'ReShade64.dll'),addon,stage,...(visible?['visible']:[])],'host');
    await until(()=>hostState()?.redReadbacks>3 && sceneState()?.targetPid===hostState()?.pid,'actual EGO pixels and authenticated transport',20000);
    await scene('focus'); await scene('intercept'); await until(()=>sceneState()?.intercepting,'interception active');
    await host('pause');await sleep(250);const before=record('paused');
    await host('key');await sleep(350);const queued=record('input-stalled');
    assert.equal(queued.host.frames,before.host.frames);assert.equal(queued.scene.window.keyDowns,before.scene.window.keyDowns);
    assert.equal(queued.host.appKeys,before.host.appKeys);assert.equal(queued.scene.intercepting,true);
    await host('frames');await until(()=>sceneState()?.window.keyDowns>before.scene.window.keyDowns,'queued key reaches real Electron');record('redraw-delivers');
    await scene('release');await sleep(350);assert.equal(sceneState()?.intercepting,true);record('release-stalled');
    await host('frames');await until(()=>sceneState()?.intercepting===false,'redraw releases input');record('redraw-releases');
  } catch(error) {failure=error.stack;console.error(failure);}
  finally {
    fs.writeFileSync(path.join(stage,'host-command.txt'),`${++hostSeq} exit`);
    fs.writeFileSync(path.join(evidence,'scene-command.json'),JSON.stringify({sequence:++sceneSeq,action:'exit'}));
    await sleep(500);for(const child of children)if(child.exitCode===null)child.kill();
    fs.writeFileSync(path.join(base,'assessment.json'),JSON.stringify({schemaVersion:1,status:failure?'failed':'reproduced',failure,events,
      runtimeSha256:hash(path.join(dist,'ReShade64.dll')),addonSha256:hash(addon),actualEgoTransport:true,actualElectronProducer:true,privateDesktopNeverSwitched:!visible,visibleFixture:visible,physicalInput:false,actualApplicationAcceptance:false},null,2)+'\n');
  }
  if(failure)process.exitCode=1;
})();
