'use strict';
// Unsealed local DLL only. Does not mutate the native cache, distribution or SDK.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),arch=process.argv[2]??'x64';
assert.ok(['x64','x86'].includes(arch)); const platform=arch==='x64'?'x64':'Win32';
const source=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src');
const out=path.join(root,'build/overlay-compatibility/rendering-failure-probes/d2d-prototype');
const shadow=path.join(out,'source'); fs.mkdirSync(path.join(shadow,'source/d2d1'),{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=(exe,args,options={})=>{const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,...options}); assert.ifError(r.error); assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;};
const original=fs.readFileSync(path.join(source,'source/d2d1/d2d1.cpp'));
fs.writeFileSync(path.join(shadow,'source/d2d1/d2d1.cpp'),original);
const patch=path.join(root,'libs/electron-game-overlay-runtime/patches/reshade-d2d-factory8.patch');
const patchEnv={...process.env,GIT_CEILING_DIRECTORIES:out};
for(const name of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE']) delete patchEnv[name];
run('git.exe',['apply','--check',patch],{cwd:shadow,env:patchEnv}); run('git.exe',['apply',patch],{cwd:shadow,env:patchEnv});
assert.notEqual(hash(original),hash(fs.readFileSync(path.join(shadow,'source/d2d1/d2d1.cpp'))),'patch must change the isolated translation unit');
let project=fs.readFileSync(path.join(source,'ReShade.vcxproj'),'utf8');
project=project.replace(/<ProjectReference Include="[^"]+">[\s\S]*?<\/ProjectReference>/g,'');
project=project.replace(/<FxCompile Include="[^"]+"(?:\s*\/>|>[\s\S]*?<\/FxCompile>)/g,'');
project=project.replace(/<(PreBuildEvent|PostBuildEvent)(?: [^>]*)?>[\s\S]*?<\/\1>/g,'');
project=project.replace(/<Import Project="([^"]+)"/g,(whole,name)=>name.includes('$(')?whole:'<Import Project="'+path.join(source,name).replaceAll('\\','/')+'"');
project=project.replace(/(<(?:ClCompile|ClInclude|None|ResourceCompile|Manifest) Include=")([^"]+)(")/g,(_,a,name,b)=>a+path.join(name==='source\\d2d1\\d2d1.cpp'?shadow:source,name).replaceAll('\\','/')+b);
project=project.replaceAll('$(IntDir)%(RelativeDir)','$(IntDir)%(Filename).obj');
project=project.replace(/<ModuleDefinitionFile>([^<]+)<\/ModuleDefinitionFile>/g,(_,name)=>'<ModuleDefinitionFile>'+path.join(source,name).replaceAll('\\','/')+'</ModuleDefinitionFile>');
const libs=['fpng.lib','glad.lib','ImGui.lib','jxl_simple_lossless.lib','MinHook.lib','stb.lib',arch==='x64'?'ReShadeFX64.lib':'ReShadeFX32.lib'].map(name=>path.join(source,'bin',platform,'Release',name));
for(const file of libs) assert.ok(fs.existsSync(file),file);
const definitions='<ItemDefinitionGroup><ClCompile><AdditionalIncludeDirectories>'+path.join(source,'source').replaceAll('\\','/')+';%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories></ClCompile><ResourceCompile><AdditionalIncludeDirectories>'+source.replaceAll('\\','/')+';%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories></ResourceCompile><Link><AdditionalDependencies>'+libs.map(file=>'&quot;'+file.replaceAll('\\','/')+'&quot;').join(';')+';%(AdditionalDependencies)</AdditionalDependencies></Link></ItemDefinitionGroup>\n';
const insertion='<Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets"'; assert.ok(project.includes(insertion)); project=project.replace(insertion,definitions+insertion);
const projectPath=path.join(out,'ReShadeD2D-'+platform+'.vcxproj'); fs.writeFileSync(projectPath,project);
const vswhere=path.join(process.env['ProgramFiles(x86)'],'Microsoft Visual Studio/Installer/vswhere.exe');
const vs=run(vswhere,['-latest','-products','*','-requires','Microsoft.Component.MSBuild','-property','installationPath']).stdout.trim();
const result=run(path.join(vs,'MSBuild/Current/Bin/MSBuild.exe'),[projectPath,'/m:4','/t:Build','/p:Configuration=Release',`/p:Platform=${platform}`,`/p:SolutionDir=${source}/`,`/p:OutDir=${out}/bin/${arch}/`,`/p:IntDir=${out}/obj/${arch}/`,'/p:WindowsTargetPlatformVersion=10.0.26100.0','/verbosity:minimal'],{timeout:600000});
fs.writeFileSync(path.join(out,'build-'+arch+'.log'),result.stdout+'\n'+result.stderr);
const runtime=path.join(out,'bin',arch,arch==='x64'?'ReShade64.dll':'ReShade32.dll'); assert.ok(fs.existsSync(runtime));
const record={kind:'unsealed-d2d-factory8-local-prototype',architecture:arch,runtime,runtimeSha256:hash(fs.readFileSync(runtime)),productionSourceChanged:false,productionDistributionChanged:false,
  patchSha256:hash(fs.readFileSync(patch)),originalD2dSourceSha256:hash(original),prototypeD2dSourceSha256:hash(fs.readFileSync(path.join(shadow,'source/d2d1/d2d1.cpp'))),
  sourceProjectSha256:hash(fs.readFileSync(path.join(source,'ReShade.vcxproj'))),reusedLibraries:libs.map(file=>({file,sha256:hash(fs.readFileSync(file))})),
  note:'All host translation units are compiled in the isolated output. No cached host objects are reused. Not a sealed SDK candidate.'};
fs.writeFileSync(path.join(out,'provenance-'+arch+'.json'),JSON.stringify(record,null,2)+'\n'); console.log(JSON.stringify(record));
