'use strict';
// Isolated CMake-P source-cache assertions and noncompiled text fixtures only.
// Minimal Git commits below are synthetic test repositories, not upstream
// checkout/build/game acceptance. No production source cache is modified.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const runtime = path.join(root, 'libs/electron-game-overlay-runtime');
const fixtureRoot = path.join(runtime, 'tests/cooperative-injector-migration/fixtures/late-source-cache');
const fixtureManifestPath = path.join(fixtureRoot, 'manifest.json');
const fixtureManifest = JSON.parse(fs.readFileSync(fixtureManifestPath, 'utf8'));
const cmake = fs.readFileSync(path.join(runtime, 'CMakeLists.txt'), 'utf8');
const normalize = text => text.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const normalizedSha = text => sha(normalize(text));
const value = name => cmake.match(new RegExp(`set\\(${name}\\s+"([0-9A-F]+)"\\s*\\)`))?.[1];
const newId = value('ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID');
const finalHash = value('RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256');
const v4Hash = value('RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256');
const preHash = value('RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256');
const latePatch = path.join(runtime, 'patches/reshade-owned-late-d3d11.patch');
const v3Patch = path.join(runtime, 'patches/reshade-injector-cooperative-members-v3.patch');
const v4Patch = path.join(runtime, 'patches/reshade-injector-cooperative-members.patch');
const preFixture = path.join(runtime, 'tests/cooperative-injector-migration/fixtures/pre-cooperative-injector.cpp.txt');
const baselineId = fixtureManifest.baselineAddonBuildId;
const preBaselineId = '12EE788081A34E00B10862242DF38893';
const quoted = text => `[==[${text.replace(/\\/g, '/')}]==]`;
const extractFunction = name => cmake.match(new RegExp(`^function\\(${name}[^\\n]*\\)\\r?\\n[\\s\\S]*?^endfunction\\(\\)`, 'm'))?.[0];
const block = marker => cmake.match(new RegExp(`# BEGIN ${marker}\\r?\\n([\\s\\S]*?)# END ${marker}`))?.[1];
const helpers = block('EGO_SOURCE_CACHE_MIGRATION_HELPERS');
const tables = block('EGO_SOURCE_CACHE_MIGRATION_TABLES');
const setBlock = name => cmake.match(new RegExp(`^set\\(${name}\\s+[\\s\\S]*?^\\)`, 'm'))?.[0];
const unavailable = spawnSync('cmake', ['--version'], { windowsHide: true }).status !== 0 ? 'CMake is unavailable' :
  spawnSync('git', ['--version'], { windowsHide: true }).status !== 0 ? 'Git is unavailable' : false;
const options = { skip: unavailable, timeout: 30000 };
const allPaths = fixtureManifest.entries.map(entry => entry.path);
const oldIds = {
  8: 'A8E9DA12477741B9979D9B1B51994EF3', 9: '3309FB779CFC4E39BA7681AA4A7F8A6B',
  10: '280C7D267CA94332834D85A075A453AE', 11: 'E16461475E524DBA83398B19CDD95EBB',
  12: 'E975AA8639164AED979E9770674B9546', 13: '4127FD92CC904E0AA75C7784189AE969',
  14: '412D57BEA49440738CC4C3903038F2E7',
};
const oldV3 = {
  8: '246B4B1DC7259C2EBF4BC4C4278B03B5083507FAE8BDB071B264692F73730135',
  9: '88E5980C5737539918CDFD0A4070802780B44FA5FBCA2BB251B79952F180C621',
  10: '5F4C08D04AB5E720851326EB72DED1D59D9E1924036B866CAC6E56602417C377',
  11: '5265F91C9308F755CF585EA7C3083E60DF48AED6CDC435C25518B7130A748F5B',
};
const oldV4 = {
  11: 'D0A885F093B5364FF7ED1D84761E758E7544579185E9EEA8517B4058D7C29B94',
  12: 'C436078556B22BDAD9DFCD662A745E73339758E227F0178234B41D1392956974',
  13: '3A58324E3AE6CE96F3F312D965A384CB825B27B64CE3E4E95CF4B4194032946C',
  14: 'EB8B4AD906DC0AC144EF2EF71DD3A9714C4C4325C01D42B66D22B48EE69060F1',
};

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-late-cache-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
    assert.ok(path.basename(directory).startsWith('ego-late-cache-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function runGit(source, args) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(source) };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const result = spawnSync('git', args, { cwd: source, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function body(entry, shape) {
  const record = entry[shape];
  if (!record) return null;
  const text = fs.readFileSync(path.join(fixtureRoot, record.fixture), 'utf8');
  assert.equal(normalizedSha(text), record.normalizedSha256, `Immutable ${shape} fixture: ${entry.path}`);
  return normalize(text);
}
function copyShape(source, shape) {
  for (const entry of fixtureManifest.entries) {
    const text = body(entry, shape), file = path.join(source, entry.path);
    if (text !== null) write(file, text);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
function fixture(t, shape = 'base') {
  const directory = temporary(t), source = path.join(directory, 'source'), binary = path.join(directory, 'binary');
  fs.mkdirSync(source); fs.mkdirSync(binary);
  copyShape(source, 'pristine');
  // Synthetic fixture commits explicitly identify source as text so later
  // CRLF working-tree conversion does not depend on Git auto-detection caches.
  write(path.join(source,'.gitattributes'),'* text\n');
  runGit(source, ['init', '--quiet']);
  runGit(source, ['config', 'core.autocrlf', 'true']);
  runGit(source, ['config', 'user.name', 'EGO isolated fixture']);
  runGit(source, ['config', 'user.email', 'fixture@example.invalid']);
  runGit(source, ['add', '--all']);
  const emptyHooks = path.join(directory, 'empty-hooks'); fs.mkdirSync(emptyHooks);
  runGit(source, ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test fixture']);
  const commit = runGit(source, ['rev-parse', 'HEAD']);
  if (shape !== 'pristine') copyShape(source, 'base');
  return { directory, source, binary, commit, injector: path.join(source, 'tools/injector.cpp') };
}
function useWorkspaceBinary(t,f) {
  fs.mkdirSync(path.join(root,'build'),{recursive:true});
  const buildRoot=fs.realpathSync(path.join(root,'build'));
  const buildRelative=path.relative(fs.realpathSync(root),buildRoot);
  assert.ok(buildRelative&&!path.isAbsolute(buildRelative)&&buildRelative!=='..'&&!buildRelative.startsWith('..'+path.sep));
  const directory=fs.mkdtempSync(path.join(buildRoot,'ego-late-cache-unit-'));
  t.after(()=>{
    const target=fs.realpathSync(directory),relative=path.relative(buildRoot,target);
    assert.ok(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
    assert.ok(path.basename(target).startsWith('ego-late-cache-unit-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  f.binary=directory;
}
function snapshot(source) {
  const files = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === '.git') continue;
      const name = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) files.push({ path: name, type: 'link', target: fs.readlinkSync(file) });
      else if (entry.isDirectory()) walk(file, name + '/');
      else files.push({ path: name, type: 'file', sha256: sha(fs.readFileSync(file)) });
    }
  }
  walk(source); return files;
}
function runGuard(f, overrides = {}) {
  assert.ok(helpers, 'Production helper block is required');
  assert.ok(tables, 'Production source-state tables are required');
  const script = path.join(f.directory, `guard-${crypto.randomBytes(5).toString('hex')}.cmake`);
  const expectedBlocks = ['RESHAPE_EXPECTED_PATCHED_FILES', 'RESHAPE_EXPECTED_PATCHED_CONTENT_SHA256']
    .filter(name => !tables.includes(`set(${name}`)).map(name => setBlock(name));
  assert.ok(expectedBlocks.every(Boolean), 'Final expected-file table is required');
  write(script, [
    'cmake_minimum_required(VERSION 3.24)',
    `set(ELECTRON_GAME_OVERLAY_ADDON_BUILD_ID "${newId}")`,
    `set(RESHAPE_CURRENT_INJECTOR_CONTENT_SHA256 "${overrides.finalHash || finalHash}")`,
    `set(RESHAPE_PRE_LATE_V4_INJECTOR_CONTENT_SHA256 "${overrides.v4Hash || v4Hash}")`,
    `set(RESHAPE_PRE_COOPERATIVE_INJECTOR_CONTENT_SHA256 "${preHash}")`,
    `set(RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256 "${value('RESHAPE_PRE_X86_INJECTOR_CONTENT_SHA256')}")`,
    `set(RESHAPE_PINNED_COMMIT "${overrides.commit || f.commit}")`,
    'set(GIT_EXECUTABLE "git")',
    `set(CMAKE_CURRENT_SOURCE_DIR ${quoted(runtime)})`,
    `set(CMAKE_CURRENT_BINARY_DIR ${quoted(f.binary)})`,
    `set(RESHAPE_OWNED_LATE_D3D11_PATCH ${quoted(overrides.latePatch || latePatch)})`,
    `set(RESHAPE_OWNED_LATE_D3D11_PATCH_SHA256 "${overrides.patchHash || '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE'}")`,
    `set(RESHAPE_COOPERATIVE_MEMBERS_PATCH ${quoted(v4Patch)})`,
    `set(RESHAPE_COOPERATIVE_MEMBERS_V3_PATCH ${quoted(v3Patch)})`,
    tables, ...expectedBlocks,
    `set(RESHAPE_PINNED_COMMIT "${overrides.commit || f.commit}")`,
    `set(RESHAPE_OWNED_LATE_D3D11_PATCH ${quoted(overrides.latePatch || latePatch)})`,
    `set(RESHAPE_OWNED_LATE_D3D11_PATCH_SHA256 "${overrides.patchHash || '51E1FA4ABE6CC35158DC9B347E1FF3FB29CD838FE6040A48EE108C48AD8693CE'}")`,
    extractFunction('verify_reshade_pinned_commit'), extractFunction('verify_reshade_patched_source'), helpers,
    ...(overrides.prepare===false?[]:[`ego_prepare_owned_late_source_cache(${quoted(f.source)})`]),
    ...(overrides.injector ? [`ego_rollover_known_addon_build_id(${quoted(f.injector)})`] : []),
    ...(overrides.replay ? [`ego_apply_owned_late_source_tail(${quoted(f.source)})`] : []),
  ].filter(Boolean).join('\n'));
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return spawnSync('cmake', ['-P', script], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
}
function accepted(result) { assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr || result.stdout); }
function rejectedUnchanged(f, before, overrides) {
  const result = runGuard(f, overrides);
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, 'Unknown tree must fail before live peeling');
  assert.deepEqual(snapshot(f.source), before, 'Every source file and presence must survive rejection unchanged');
  return result;
}
function setInjector(f, id, shape = 'v4') {
  if (shape === 'v4') write(f.injector, body(fixtureManifest.entries.find(entry => entry.path === 'tools/injector.cpp'), 'base').replace(baselineId, id));
  else {
    const pre = normalize(fs.readFileSync(preFixture, 'utf8'));
    assert.equal(normalizedSha(pre), 'E6EB9FFC0431EE5703E44EB757819AB946E2E8B0335A6D39186D0B32776DE359');
    write(f.injector, pre.replace(preBaselineId, id));
    if (shape === 'v3') runGit(f.source, ['apply', '--whitespace=nowarn', v3Patch]);
  }
}
function applyLate(f) { runGit(f.source, ['apply', '--whitespace=nowarn', latePatch]); }
function makeLate(f) { setInjector(f, newId); assert.equal(normalizedSha(fs.readFileSync(f.injector, 'utf8')), v4Hash); applyLate(f); assert.equal(normalizedSha(fs.readFileSync(f.injector, 'utf8')), finalHash); }
function assertBase(f, injectorHash) {
  for (const entry of fixtureManifest.entries) {
    const file = path.join(f.source, entry.path);
    if (!entry.base) { assert.equal(fs.existsSync(file), false, `Added header removed: ${entry.path}`); continue; }
    const bytes = fs.readFileSync(file);
    assert.equal(normalizedSha(bytes.toString('utf8')), entry.path === 'tools/injector.cpp' ? injectorHash : entry.base.normalizedSha256, `${entry.path} [raw final bytes ${bytes.subarray(-8).toString('hex')}]`);
  }
}

test('whole-tree fixtures retain independently pinned noncompiled upstream and old-base bodies', () => {
  assert.equal(normalizedSha(fs.readFileSync(fixtureManifestPath, 'utf8')), '14F88C644EECCEE8460F3490C89C8F08F43E502BD806EAECB338A79B7A8CC107');
  assert.equal(fixtureManifest.sourceCommit, '4a50d1eddace85734871d91792ff214f13f66c01');
  assert.equal(allPaths.length, 19); assert.equal(fixtureManifest.oldModifiedPaths.length, 9); assert.equal(fixtureManifest.addedPaths.length, 4);
  assert.equal(normalizedSha(fs.readFileSync(latePatch, 'utf8')), fixtureManifest.latePatchNormalizedSha256);
  for (const entry of fixtureManifest.entries) for (const shape of ['pristine','base']) body(entry, shape);
});
test('pinned pristine fixture tree is accepted without changing any source bytes', options, t => {
  const f = fixture(t, 'pristine'), before = snapshot(f.source); accepted(runGuard(f)); assert.deepEqual(snapshot(f.source), before);
});
test('a pristine source edit is rejected without starting historical patch replay',options,t=>{
  const f=fixture(t,'pristine'),file=path.join(f.source,'source/input.cpp');write(file,fs.readFileSync(file,'utf8')+'\n// local pristine edit\n');rejectedUnchanged(f,snapshot(f.source));
});
for (const generation of [8,9,10,11]) test(`known generation ${generation} v3 full tree keeps host files while migrating its real injector`, options, t => {
  const f = fixture(t); setInjector(f, oldIds[generation], 'v3'); assert.equal(normalizedSha(fs.readFileSync(f.injector,'utf8')), oldV3[generation]); accepted(runGuard(f,{injector:true})); assertBase(f,v4Hash);
});
for (const generation of [11,12,13,14]) test(`known generation ${generation} v4 full tree reaches the exact pre-late injector`, options, t => {
  const f = fixture(t); setInjector(f,oldIds[generation]); assert.equal(normalizedSha(fs.readFileSync(f.injector,'utf8')),oldV4[generation]); accepted(runGuard(f,{injector:true})); assertBase(f,v4Hash);
});
for (const generation of [8,9,10,11,12,13,14]) test(`known generation ${generation} pre-cooperative tree preserves its lower-stack boundary`, options, t => {
  const f=fixture(t); setInjector(f,oldIds[generation],'pre'); accepted(runGuard(f,{injector:true})); assertBase(f,preHash);
});
test('final late tree is peeled in full before legacy migration and can be replayed repeatedly', options, t => {
  const f=fixture(t);useWorkspaceBinary(t,f);makeLate(f); accepted(runGuard(f,{injector:true})); assertBase(f,v4Hash); const base=snapshot(f.source); accepted(runGuard(f,{injector:true})); assert.deepEqual(snapshot(f.source),base);
  runGit(f.source,['config','core.autocrlf','true']);runGit(f.source,['config','core.eol','crlf']);
  for(const entry of fixtureManifest.entries)if(entry.base){const file=path.join(f.source,entry.path);write(file,normalize(fs.readFileSync(file,'utf8')).replace(/\n/g,'\r\n'));}
  assertBase(f,v4Hash);const statusBeforeReplay=runGit(f.source,['status','--porcelain=v1']);
  // Production applies the tail after historical replay, without re-running
  // the cache-entry guard. The complete pre-late body was checked above.
  const replay=runGuard(f,{prepare:false,replay:true});if(replay.status!==0)replay.stderr+='\nNode status before replay:\n'+statusBeforeReplay+'\nFixture core.autocrlf='+runGit(f.source,['config','--get','core.autocrlf'])+'\n'+runGit(f.source,['ls-files','--eol']);accepted(replay); assert.equal(normalizedSha(fs.readFileSync(f.injector,'utf8')),finalHash); accepted(runGuard(f)); assertBase(f,v4Hash);
});
for(const shape of ['base','late']) for(const name of allPaths) test(`unknown ${shape} edit to ${name} is rejected before any live file changes`,options,t=>{
  const f=fixture(t); if(shape==='late')makeLate(f); const file=path.join(f.source,name); write(file,(fs.existsSync(file)?fs.readFileSync(file):Buffer.alloc(0))+'\n// unrecognized source edit\n'); rejectedUnchanged(f,snapshot(f.source));
});
for(const name of fixtureManifest.addedPaths) test(`missing late header ${name} never authorizes a partial tail peel`,options,t=>{
  const f=fixture(t);makeLate(f);fs.unlinkSync(path.join(f.source,name));rejectedUnchanged(f,snapshot(f.source));
});
test('individually known old and late bodies cannot form an accepted mixed source vector',options,t=>{
  const f=fixture(t);makeLate(f);const entry=fixtureManifest.entries.find(e=>e.path==='ReShade.vcxproj');write(path.join(f.source,entry.path),body(entry,'base'));rejectedUnchanged(f,snapshot(f.source));
});
for(const shape of ['base','late']) test(`unexpected untracked source files block ${shape} migration without alteration`,options,t=>{
  const f=fixture(t);if(shape==='late')makeLate(f);write(path.join(f.source,'source/foreign-user-edit.hpp'),'Foreign source must remain intact\n');rejectedUnchanged(f,snapshot(f.source));
});
test('wrong pinned source commit fails before source mutation',options,t=>{
  const f=fixture(t);makeLate(f);rejectedUnchanged(f,snapshot(f.source),{commit:'0'.repeat(40)});
});
test('modified late patch input fails before any source mutation',options,t=>{
  const f=fixture(t);makeLate(f);const patch=path.join(f.directory,'wrong.patch');write(patch,fs.readFileSync(latePatch,'utf8')+'\n# modified patch\n');rejectedUnchanged(f,snapshot(f.source),{latePatch:patch});
});
test('wrong expected final injector hash cannot peel a known late tree',options,t=>{
  const f=fixture(t);makeLate(f);rejectedUnchanged(f,snapshot(f.source),{finalHash:'0'.repeat(64)});
});
test('wrong expected pre-late hash fails staged reversal before publishing any file',options,t=>{
  const f=fixture(t);makeLate(f);rejectedUnchanged(f,snapshot(f.source),{v4Hash:'0'.repeat(64)});
});
test('wrong declared late patch hash fails before source mutation',options,t=>{
  const f=fixture(t);makeLate(f);rejectedUnchanged(f,snapshot(f.source),{patchHash:'0'.repeat(64)});
});
test('a symbolic link to a recognized late file is never followed for mutation',options,t=>{
  const f=fixture(t);makeLate(f);const name='source/runtime.cpp',file=path.join(f.source,name),foreign=path.join(f.directory,'foreign-runtime.txt');const bytes=fs.readFileSync(file);write(foreign,bytes);fs.unlinkSync(file);
  try{fs.symlinkSync(foreign,file,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Owned fixture symbolic links are unavailable');return;}throw error;}
  rejectedUnchanged(f,snapshot(f.source));assert.deepEqual(fs.readFileSync(foreign),bytes);
});
test('a blocked mid-vector publication recovers known preimages before the next complete peel',{
  ...options,skip:unavailable||(process.platform!=='win32'?'Windows FileStream sharing semantics are required':false),
},async t=>{
  const f=fixture(t);makeLate(f);
  const blocked=path.join(f.source,'source/runtime.hpp'),blockedBytes=fs.readFileSync(blocked);
  const permitted=new Map(fixtureManifest.entries.map(entry=>[entry.path,new Set([
    normalizedSha(fs.readFileSync(path.join(f.source,entry.path),'utf8')),
    entry.base?(entry.path==='tools/injector.cpp'?v4Hash:entry.base.normalizedSha256):'ABSENT',
  ])]));
  const ready=path.join(f.directory,'file-lock-ready'),release=path.join(f.directory,'file-lock-release');
  const psQuote=text=>`'${text.replaceAll("'","''")}'`;
  const script=`$ErrorActionPreference='Stop';$stream=[IO.File]::Open(${psQuote(blocked)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[IO.File]::WriteAllText(${psQuote(ready)},'ready');$deadline=[DateTime]::UtcNow.AddSeconds(30);while(-not [IO.File]::Exists(${psQuote(release)}) -and [DateTime]::UtcNow -lt $deadline){[Threading.Thread]::Sleep(10)}}finally{$stream.Dispose()}`;
  const locker=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let lockerError='';locker.stderr.on('data',bytes=>{lockerError+=bytes.toString('utf8');});
  const exited=new Promise((resolve,reject)=>{locker.once('error',reject);locker.once('exit',code=>resolve(code));});
  let failed;
  try{
    const deadline=Date.now()+5000;while(!fs.existsSync(ready)){if(locker.exitCode!==null)assert.fail('Owned fixture locker exited before readiness: '+lockerError);if(Date.now()>=deadline)assert.fail('Owned fixture locker did not become ready');await new Promise(resolve=>setTimeout(resolve,10));}
    failed=runGuard(f);
  }finally{
    write(release,'release');
    let timer;try{const code=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{locker.kill();reject(new Error('Owned fixture locker did not release'));},5000);})]);assert.equal(code,0,lockerError);}finally{clearTimeout(timer);}
  }
  assert.equal(failed.error,undefined,failed.error?.message);
  assert.notEqual(failed.status,0,'A held FileStream sharing lock must block publication on this Windows fixture');
  assert.deepEqual(fs.readFileSync(blocked),blockedBytes,'Failed publication preserves the blocked original target');
  for(const entry of fixtureManifest.entries){const file=path.join(f.source,entry.path),actual=fs.existsSync(file)?normalizedSha(fs.readFileSync(file,'utf8')):'ABSENT';assert.ok(permitted.get(entry.path).has(actual),`Interrupted publication contains only known before/after images: ${entry.path}`);}
  const journals=fs.readdirSync(f.directory).filter(name=>/^\.ego-source-cache-.+\.journal\.json$/u.test(name));
  assert.equal(journals.length,1,'Interrupted publication must retain one recovery journal');
  const journalPath=path.join(f.directory,journals[0]),journalBytes=fs.readFileSync(journalPath),journal=JSON.parse(journalBytes);
  const foreignPath='ReShade.vcxproj',foreignFile=path.join(f.source,foreignPath),foreignBytes=fs.readFileSync(foreignFile);
  const vectorPaths=[...setBlock('RESHAPE_EXPECTED_PATCHED_FILES').matchAll(/"([^\"]+)"/g)].map(match=>match[1]);
  const index=vectorPaths.indexOf(foreignPath);assert.ok(index>=0);
  write(foreignFile,'Unknown current source must never be restored over, even with a forged journal after hash.\n');
  journal.after[index]=sha(fs.readFileSync(foreignFile)).toLowerCase();write(journalPath,JSON.stringify(journal));
  const forgedJournal=fs.readFileSync(journalPath);
  const refused=rejectedUnchanged(f,snapshot(f.source));assert.match(refused.stderr,/unknown recovery postimage/iu);assert.deepEqual(fs.readFileSync(journalPath),forgedJournal,'Rejected recovery preserves the untrusted journal');
  write(foreignFile,foreignBytes);write(journalPath,journalBytes);
  accepted(runGuard(f));assertBase(f,v4Hash);
});
test('LF and CRLF/BOM late source and patch copies retain the same complete hash contract',options,t=>{
  const f=fixture(t);makeLate(f);for(const name of allPaths){const file=path.join(f.source,name);write(file,'\uFEFF'+normalize(fs.readFileSync(file,'utf8')).replace(/\n/g,'\r\n'));}
  const patch=path.join(f.directory,'late-crlf.patch');write(patch,'\uFEFF'+normalize(fs.readFileSync(latePatch,'utf8')).replace(/\n/g,'\r\n'));accepted(runGuard(f,{latePatch:patch}));assertBase(f,v4Hash);
});
