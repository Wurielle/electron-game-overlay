#include "contract.hpp"
#include <d3d11.h>
#include <wrl/client.h>
#include <MinHook.h>
#include <cstring>
using Microsoft::WRL::ComPtr;
static renderer_state state;
using present_fn=HRESULT(STDMETHODCALLTYPE *)(IDXGISwapChain *,UINT,UINT);
using present1_fn=HRESULT(STDMETHODCALLTYPE *)(IDXGISwapChain1 *,UINT,UINT,const DXGI_PRESENT_PARAMETERS *);
using factory_fn=HRESULT(WINAPI *)(UINT,REFIID,void **);
static present_fn next_present=nullptr;
static present1_fn next_present1=nullptr;
static factory_fn next_factory=nullptr;
static unsigned mode=0;
static bool painting=false;
static IUnknown *tracked_chain=nullptr,*tracked_device=nullptr;
static bool unknown_identity(IUnknown *object,IUnknown *expected) {
 ComPtr<IUnknown> identity;return object&&SUCCEEDED(object->QueryInterface(IID_PPV_ARGS(&identity)))&&identity.Get()==expected;
}
static void paint(IDXGISwapChain *chain,UINT flags) {
 if((flags&DXGI_PRESENT_TEST)!=0){++state.test_calls;return;}
 const bool green_disabled=mode==2;if(green_disabled)++state.disabled;
 if(painting){++state.errors;return;}
 painting=true;
 if(unknown_identity(chain,tracked_chain))++state.identity_matches;else ++state.errors;
 ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<ID3D11Texture2D> back,staging;ComPtr<ID3D11RenderTargetView> view;
 HRESULT hr=chain->GetDevice(IID_PPV_ARGS(&device));
 if(SUCCEEDED(hr)&&unknown_identity(device.Get(),tracked_device))++state.device_matches;else ++state.errors;
 if(SUCCEEDED(hr))device->GetImmediateContext(&context);
 if(SUCCEEDED(hr))hr=chain->GetBuffer(0,IID_PPV_ARGS(&back));
 if(SUCCEEDED(hr))hr=device->CreateRenderTargetView(back.Get(),nullptr,&view);
 if(SUCCEEDED(hr)) {
  // Establish a deterministic red fixture baseline before the optional green
  // foreign-render operation. Both positive and disabled controls read the GPU.
  const float red[4]={1.0f,0.0f,0.0f,1.0f},green[4]={0.0f,1.0f,0.0f,1.0f};
  context->ClearRenderTargetView(view.Get(),red);if(!green_disabled)context->ClearRenderTargetView(view.Get(),green);
  D3D11_TEXTURE2D_DESC description{};back->GetDesc(&description);description.Usage=D3D11_USAGE_STAGING;description.BindFlags=0;description.CPUAccessFlags=D3D11_CPU_ACCESS_READ;description.MiscFlags=0;
  hr=device->CreateTexture2D(&description,nullptr,&staging);
  if(SUCCEEDED(hr)){context->CopyResource(staging.Get(),back.Get());D3D11_MAPPED_SUBRESOURCE mapped{};hr=context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped);
   if(SUCCEEDED(hr)){const auto *pixel=static_cast<const unsigned char *>(mapped.pData);
    if(!green_disabled&&pixel[0]==0&&pixel[1]==255&&pixel[2]==0&&pixel[3]==255)++state.painted;
    else if(green_disabled&&pixel[1]==0&&pixel[3]==255&&((description.Format==DXGI_FORMAT_R8G8B8A8_UNORM&&pixel[0]==255&&pixel[2]==0)||(description.Format==DXGI_FORMAT_B8G8R8A8_UNORM&&pixel[0]==0&&pixel[2]==255)))++state.red_readbacks;
    else ++state.errors;context->Unmap(staging.Get(),0);}
  }
 }
 if(FAILED(hr))++state.errors;
 painting=false;
}
static HRESULT STDMETHODCALLTYPE present_hook(IDXGISwapChain *chain,UINT interval,UINT flags) {
 ++state.present_calls;
#ifndef EGO_PRIOR_RENDERER
 paint(chain,flags);
#endif
 const HRESULT result=next_present(chain,interval,flags);state.last_result=result;return result;
}
static HRESULT STDMETHODCALLTYPE present1_hook(IDXGISwapChain1 *chain,UINT interval,UINT flags,const DXGI_PRESENT_PARAMETERS *parameters) {
 ++state.present1_calls;
#ifndef EGO_PRIOR_RENDERER
 paint(chain,flags);
#endif
 const HRESULT native_result=next_present1(chain,interval,flags,parameters);
 const HRESULT result=mode==3&&state.present1_calls==3?DXGI_ERROR_WAS_STILL_DRAWING:native_result;
 state.last_result=result;return result;
}
static HRESULT WINAPI factory_hook(UINT flags,REFIID iid,void **out) {
 const HRESULT result=next_factory(flags,iid,out);if(FAILED(result))return result;++state.factory_calls;
 auto **table=*reinterpret_cast<void ***>(*out);HMODULE owner=nullptr;
 GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,reinterpret_cast<LPCWSTR>(table[10]),&owner);
 if(owner!=GetModuleHandleW(L"dxgi.dll"))++state.factory_proxy_skips;else ++state.native_factories;
 return result;
}
extern "C" __declspec(dllexport) DWORD WINAPI RendererStart(void *present,void *present1,unsigned selected_mode) {
 mode=selected_mode;if(MH_Initialize()!=MH_OK)return 1;
#ifdef EGO_PRIOR_RENDERER
 if(MH_CreateHook(present,&present_hook,reinterpret_cast<void **>(&next_present))!=MH_OK||MH_CreateHook(present1,&present1_hook,reinterpret_cast<void **>(&next_present1))!=MH_OK)return 2;
 return MH_EnableHook(MH_ALL_HOOKS)==MH_OK?0:3;
#else
 const auto factory=GetProcAddress(GetModuleHandleW(L"dxgi.dll"),"CreateDXGIFactory2");
 if(MH_CreateHook(factory,&factory_hook,reinterpret_cast<void **>(&next_factory))!=MH_OK)return 4;
 return MH_EnableHook(MH_ALL_HOOKS)==MH_OK?0:5;
#endif
}
extern "C" __declspec(dllexport) DWORD WINAPI RendererTrack(IDXGIFactory2 *factory,IDXGISwapChain1 *chain,IUnknown *device,unsigned strategy) {
 if(!chain||!device)return 10;
 tracked_chain=nullptr;tracked_device=nullptr;
 if(FAILED(chain->QueryInterface(IID_PPV_ARGS(&tracked_chain)))||FAILED(device->QueryInterface(IID_PPV_ARGS(&tracked_device))))return 11;
 // Numeric identity is retained only until process exit, as are all detours.
 state.chain_identity=reinterpret_cast<std::uintptr_t>(tracked_chain);state.device_identity=reinterpret_cast<std::uintptr_t>(tracked_device);
 if(factory){auto **table=*reinterpret_cast<void ***>(factory);HMODULE owner=nullptr;GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,reinterpret_cast<LPCWSTR>(table[10]),&owner);if(owner==GetModuleHandleW(L"dxgi.dll"))++state.native_factories;}
 auto **table=*reinterpret_cast<void ***>(chain);
 if(strategy==0){
  if(MH_CreateHook(table[8],&present_hook,reinterpret_cast<void **>(&next_present))!=MH_OK||MH_CreateHook(table[22],&present1_hook,reinterpret_cast<void **>(&next_present1))!=MH_OK)return 12;
  return MH_EnableHook(MH_ALL_HOOKS)==MH_OK?0:13;
 }
 if(strategy!=1)return 14;
 next_present=reinterpret_cast<present_fn>(table[8]);next_present1=reinterpret_cast<present1_fn>(table[22]);
 DWORD prior=0,ignored=0;if(!VirtualProtect(table,sizeof(void *)*23,PAGE_READWRITE,&prior))return 15;
 table[8]=reinterpret_cast<void *>(&present_hook);table[22]=reinterpret_cast<void *>(&present1_hook);
 return VirtualProtect(table,sizeof(void *)*23,prior,&ignored)?0:16;
}
extern "C" __declspec(dllexport) void WINAPI RendererState(renderer_state *out){if(out&&out->size==sizeof(state))*out=state;}
#if defined(_M_IX86)
#pragma comment(linker,"/EXPORT:RendererStart=_RendererStart@12")
#pragma comment(linker,"/EXPORT:RendererTrack=_RendererTrack@16")
#pragma comment(linker,"/EXPORT:RendererState=_RendererState@4")
#endif
