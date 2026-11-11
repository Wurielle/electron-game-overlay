'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),arch=process.argv[2]??'x64';assert.ok(['x64','x86'].includes(arch));
const source=path.join(root,'build/candidate-gen24-cache/native/_deps/reshade-src'),base=path.join(root,'build/overlay-compatibility'),generated=path.join(base,'owned-policy-generated'),build=path.join(base,'owned-policy-'+arch);
const read=p=>fs.readFileSync(p,'utf8').replaceAll('\r\n','\n'),sha=s=>crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
const tail=read(path.join(root,'libs/electron-game-overlay-runtime/cmake/owned-composition-policy.cmake'));
const pins=[...tail.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)];assert.equal(pins.length,8);
const newer=read(path.join(root,'libs/electron-game-overlay-runtime/cmake/owned-composition-binding-diagnostics.cmake'));
for(const match of newer.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)){const existing=pins.find(p=>p[1]===match[1]);if(existing)existing[3]=match[3];}
const eligibility=read(path.join(root,'libs/electron-game-overlay-runtime/cmake/owned-composition-window-eligibility.cmake'));
for(const match of eligibility.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)){const existing=pins.find(p=>p[1]===match[1]);if(existing)existing[3]=match[3];}
const lifetime=read(path.join(root,'libs/electron-game-overlay-runtime/cmake/owned-composition-auxiliary-lifetime.cmake'));
for(const match of lifetime.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)){const existing=pins.find(p=>p[1]===match[1]);if(existing)existing[3]=match[3];}
const deferred=read(path.join(root,'libs/electron-game-overlay-runtime/cmake/owned-deferred-d3d11.cmake'));
for(const match of deferred.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)){const existing=pins.find(p=>p[1]===match[1]);if(existing)existing[3]=match[3];}
const destinations=read(path.join(root,'libs/electron-game-overlay-runtime/cmake/present-destinations.cmake'));
for(const match of destinations.matchAll(/"([^"|]+)\|([A-Z0-9]+)\|([A-F0-9]{64})"/g)){const existing=pins.find(p=>p[1]===match[1]);if(existing)existing[3]=match[3];}
for(const [,name,,after]of pins)assert.equal(sha(read(path.join(source,name))),after,name);
const cpp=read(path.join(source,'source/dxgi/dxgi_swapchain.cpp'));
const init=cpp.slice(cpp.indexOf('void DXGISwapChain::on_init('),cpp.indexOf('void DXGISwapChain::on_reset('));
const initBranch=init.slice(init.indexOf('\tassert(!_is_initialized);'),init.indexOf('\n\tconst unique_direct3d_device_lock'));
const present=cpp.slice(cpp.indexOf('void DXGISwapChain::on_present('));
const presentBranch=present.slice(present.indexOf('\t// Some D3D11 games'),present.indexOf('\tassert(_is_initialized);'));
assert.ok(initBranch.includes('_composition_pending_resize = resize'));assert.ok(presentBranch.includes('if (_composition_pending) on_init(_composition_pending_resize)'));
fs.mkdirSync(generated,{recursive:true});
fs.writeFileSync(path.join(generated,'composition_lifecycle_fixture.hpp'),String.raw`#pragma once
#include <dxgi.h>
#include <cassert>
#include <stdexcept>
struct lifecycle_fixture {
 struct impl { HWND window = nullptr; HWND get_hwnd() const { return window; } } implementation;
 impl *_impl = &implementation;
 bool _is_initialized=false, _owned_composition=true, _composition_active=false, _composition_pending=false, _composition_pending_resize=false, _was_still_drawing_last_frame=false;
 unsigned initialized=0, retired=0, frames=0; bool initialized_resize=false,retired_resize=false;
 void on_reset(bool resize, const char * = nullptr) { if (_is_initialized) { ++retired; retired_resize=resize; _is_initialized=false; } }
 void on_init(bool resize) {
`+initBranch+String.raw`
 ++initialized; initialized_resize=resize; _is_initialized=true;
 }
 void on_present(UINT flags) {
`+presentBranch+String.raw`
 if (!_is_initialized) throw std::runtime_error("uninitialized normal path"); ++frames;
 }
};
inline unsigned run_composition_lifecycle_contract() {
 unsigned checks=0; const auto expect=[&](bool ok){++checks;if(!ok)throw std::runtime_error("production composition lifecycle contract");};
 ego_owned_runtime_policy::active=true; lifecycle_fixture f; f.on_init(false);
 expect(f.initialized==0&&f._composition_pending); f.on_present(0); expect(f.frames==0&&f.retired==0);
 f.implementation.window=reinterpret_cast<HWND>(1); f.on_present(DXGI_PRESENT_TEST);expect(f.initialized==0);
 f.on_present(0);expect(f.initialized==1&&f.frames==1&&!f.initialized_resize);
 f.on_reset(true);f.implementation.window=nullptr;f.on_init(true);f.on_present(0);expect(f._composition_pending_resize&&f.initialized==1&&f.retired_resize);
 f.implementation.window=reinterpret_cast<HWND>(1);f.on_present(0);expect(f.initialized==2&&f.initialized_resize&&f.frames==2);
 f.implementation.window=nullptr;f.on_present(0);expect(f.retired==2&&!f.retired_resize&&f.frames==2);
 f.implementation.window=reinterpret_cast<HWND>(1);f.on_present(0);expect(f.initialized==3&&!f.initialized_resize&&f.frames==3);
 lifecycle_fixture normal;normal._owned_composition=false;normal.on_init(false);normal.on_present(0);expect(normal.initialized==1&&normal.frames==1);
 ego_owned_runtime_policy::active=false;lifecycle_fixture late;late.on_init(false);expect(late.initialized==1);
 ego_owned_runtime_policy::active=true;late.on_present(0);expect(late.retired==1&&late._composition_pending&&late.frames==0);
 late.implementation.window=reinterpret_cast<HWND>(1);late.on_present(0);expect(late.initialized==2&&late.frames==1);
 return checks;
}
`);
function run(exe,args){const r=cp.spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r;}
const configure=run('cmake.exe',['-S',__dirname,'-B',build,'-A',arch==='x64'?'x64':'Win32','-DRESHAPE_SOURCE='+source,'-DPOLICY_GENERATED='+generated]);
const compile=run('cmake.exe',['--build',build,'--config','Release','--parallel','4']);fs.writeFileSync(path.join(base,'owned-policy-'+arch+'-build.log'),configure.stdout+compile.stdout+compile.stderr);
const manager=path.join(root,'libs/electron-game-overlay-runtime/dist',arch==='x64'?'win32-x64':'win32-ia32','electron_game_overlay_reshade_manager.exe');
const result=run(path.join(build,'Release/owned_policy.exe'),[manager,path.join(base,'owned-policy-files-'+arch)]);const report={architecture:arch,sourcePins:pins.map(([,file,,sha256])=>({file,sha256})),...JSON.parse(result.stdout.trim())};
const output=path.join(base,'owned-policy-'+arch+'-report.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,output}));
