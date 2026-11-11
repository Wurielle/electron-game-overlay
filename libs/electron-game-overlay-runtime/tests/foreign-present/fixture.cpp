// Real production host + actual independent MinHook chains and GPU readback.
// Windows created below are never shown or activated. No input is synthesized.
#include "contract.hpp"
#include <d3d11.h>
#include <wrl/client.h>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <stdexcept>
#define RESHADE_OWNED_LATE_D3D11_ABI_ONLY
#include "owned_late_d3d11.hpp"
using Microsoft::WRL::ComPtr;
static constexpr GUID unwrapped={0x7f2c9a11,0x3b4e,0x4d6a,{0x81,0x2f,0x5e,0x9c,0xd3,0x7a,0x1b,0x42}};
static unsigned checks=0;
static void require(bool ok,const char *message){++checks;if(!ok)throw std::runtime_error(message);}
static void hr(HRESULT result,const char *message){if(FAILED(result))std::fprintf(stderr,"%s hr=%08lx\n",message,result);require(SUCCEEDED(result),message);}
template<class T>static T symbol(HMODULE module,const char *name){const auto result=reinterpret_cast<T>(GetProcAddress(module,name));require(result!=nullptr,name);return result;}
static renderer_state state(HMODULE module){renderer_state result;symbol<renderer_state_fn>(module,"RendererState")(&result);return result;}
static ComPtr<IUnknown> identity(IUnknown *value){ComPtr<IUnknown> result;hr(value->QueryInterface(IID_PPV_ARGS(&result)),"IUnknown identity");return result;}
int wmain(int argc,wchar_t **argv)try{
 // production host, owned adapter, prior detour, later renderer, stage, strategy, video, use-prior, surface
 require(argc==10,"nine fixture arguments required");const bool relay=std::wcsncmp(argv[6],L"relay",5)==0;const unsigned strategy=relay?2:std::wcscmp(argv[6],L"vtable")==0?1:0;
 const bool disabled=std::wcscmp(argv[6],L"disabled")==0||std::wcscmp(argv[6],L"relay-disabled")==0,video=std::wcscmp(argv[7],L"video")==0,prior_enabled=std::wcscmp(argv[8],L"prior")==0;
 const bool forced_error=std::wcscmp(argv[6],L"forced-error")==0||std::wcscmp(argv[6],L"relay-forced-error")==0,legacy=std::wcscmp(argv[9],L"legacy")==0;
 const bool repatch_loss=std::wcscmp(argv[6],L"relay-repatch-loss")==0,repatch_preserve=std::wcscmp(argv[6],L"relay-repatch-preserve")==0;
 const bool expect_loss=repatch_loss&&prior_enabled;
 require(SetEnvironmentVariableW(L"SteamOverlayGameId",L"1")!=FALSE,"Steam environment control");
 require(SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE",argv[5])!=FALSE,"owned stage override");
 // Native method discovery for the optional pre-existing third-party detour.
 ComPtr<ID3D11Device> early_device;ComPtr<ID3D11DeviceContext> early_context;ComPtr<IDXGIFactory2> early_factory;ComPtr<IDXGISwapChain1> early_chain;
 hr(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&early_device,nullptr,&early_context),"early hardware device");
 hr(CreateDXGIFactory2(0,IID_PPV_ARGS(&early_factory)),"early native factory");
 DXGI_SWAP_CHAIN_DESC1 description{};description.Width=description.Height=32;description.Format=DXGI_FORMAT_B8G8R8A8_UNORM;description.SampleDesc.Count=1;description.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;description.BufferCount=2;description.SwapEffect=DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;description.AlphaMode=DXGI_ALPHA_MODE_IGNORE;
 hr(early_factory->CreateSwapChainForComposition(early_device.Get(),&description,nullptr,&early_chain),"early offscreen chain");
 auto **native_methods=*reinterpret_cast<void ***>(early_chain.Get());void *native_present=native_methods[8],*native_present1=native_methods[22];
 HMODULE prior=nullptr;if(prior_enabled){prior=LoadLibraryW(argv[3]);require(prior!=nullptr,"pre-existing owned third-party image");require(symbol<renderer_start_fn>(prior,"RendererStart")(native_present,native_present1,repatch_loss?4:repatch_preserve?5:0)==0,"prior independent detours");require(state(prior).hook_engine==(repatch_loss?3u:repatch_preserve?4u:std::wcsstr(argv[3],L"prior_detours.dll")?2u:1u),"selected prior hook engine active");}
 early_chain.Reset();early_factory.Reset();early_context.Reset();early_device.Reset();
 const HMODULE host=LoadLibraryW(argv[1]);require(host!=nullptr,"production host loaded before renderer");
 auto *gate=symbol<volatile LONG *>(host,"ElectronGameOverlayReShadeAddonGate");require(InterlockedCompareExchange(gate,1,0)==0,"owned test adapter gate acquired");
 const HMODULE adapter=LoadLibraryW(argv[2]);require(adapter!=nullptr,"actual test adapter callback registration");require(InterlockedCompareExchange(gate,2,1)==1,"adapter registration published");
 require(symbol<DWORD(WINAPI *)(const ego_owned_late_d3d11_initialize_v1 *)>(host,"ElectronGameOverlayInitializeOwnedLateD3D11V1")(nullptr)==0,"production owned bootstrap");
 const auto query=symbol<DWORD(WINAPI *)(ego_owned_late_d3d11_stats_v1 *)>(host,"ElectronGameOverlayQueryOwnedLateD3D11V1");
 ego_owned_late_d3d11_stats_v1 before{};before.struct_size=sizeof(before);before.abi_version=1;require(query(&before)==0&&before.status==2,"real raw Present hooks active before foreign renderer");
 const HMODULE foreign=LoadLibraryW(argv[4]);require(foreign!=nullptr,"foreign renderer loaded later");require(symbol<renderer_start_fn>(foreign,"RendererStart")(native_present,native_present1,disabled?2:forced_error?3:0)==0,"late independent factory detour");
 ComPtr<IDXGIFactory2> factory;hr(CreateDXGIFactory2(0,IID_PPV_ARGS(&factory)),"real application proxy factory");
 auto factory_state=state(foreign);require(factory_state.factory_calls>=1&&factory_state.factory_proxy_skips>=1,"outer late renderer observes actual proxy-factory registration skip");
 ComPtr<ID3D11Device> device,raw_device;ComPtr<ID3D11DeviceContext> context;
 hr(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,(legacy?0:D3D11_CREATE_DEVICE_BGRA_SUPPORT)|(video?D3D11_CREATE_DEVICE_VIDEO_SUPPORT:0),nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context),"hooked application device");
 hr(device->QueryInterface(unwrapped,&raw_device),"original application device");
 require(raw_device.Get()!=device.Get(),"real SDK device proxy active");
 // Never show this HWND. A valid hidden native HWND exercises the full normal
 // ReShade runtime path without involving the desktop compositor or input.
 HWND window=CreateWindowExW(WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW,L"STATIC",L"Owned hidden foreign Present fixture",WS_POPUP,-32000,-32000,32,32,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
 require(window!=nullptr&&!IsWindowVisible(window),"never-shown target window");
 ComPtr<IDXGISwapChain1> chain,original;
 if(legacy){
  DXGI_SWAP_CHAIN_DESC old_description{};old_description.BufferDesc.Width=old_description.BufferDesc.Height=32;old_description.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;old_description.SampleDesc.Count=1;old_description.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;old_description.BufferCount=2;old_description.OutputWindow=window;old_description.Windowed=TRUE;old_description.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
  ComPtr<IDXGISwapChain> old_chain;hr(factory->CreateSwapChain(device.Get(),&old_description,&old_chain),"matched legacy RGBA8 discard proxy swapchain");hr(old_chain.As(&chain),"legacy swapchain1");
 }else hr(factory->CreateSwapChainForHwnd(device.Get(),window,&description,nullptr,nullptr,&chain),"actual proxy HWND swapchain");
 hr(chain->QueryInterface(unwrapped,&original),"tracked original swapchain");require(chain.Get()!=original.Get(),"proxy and original are distinct");
 ComPtr<IUnknown> app_chain_device;hr(chain->GetDevice(IID_PPV_ARGS(&app_chain_device)),"proxy GetDevice identity");require(app_chain_device.Get()==identity(device.Get()).Get(),"proxy device IUnknown identity unchanged");
 ComPtr<IDXGIDevice> dxgi_device;ComPtr<IDXGIAdapter> native_adapter;ComPtr<IDXGIFactory2> native_factory;
 hr(raw_device.As(&dxgi_device),"raw DXGI device");hr(dxgi_device->GetAdapter(&native_adapter),"native adapter");hr(native_adapter->GetParent(IID_PPV_ARGS(&native_factory)),"native parent factory");
 // Explicit owned observation seam models the later native-factory/chain
 // tracking proven in the Steam trace. This is not a claim about Valve code.
 require(symbol<renderer_track_fn>(foreign,"RendererTrack")(native_factory.Get(),original.Get(),raw_device.Get(),strategy)==0,"foreign tracks exact native chain and installs real Present hooks");
 auto tracked=state(foreign);require(tracked.native_factories>=1,"real native factory observed after proxy skip");require(tracked.chain_identity==reinterpret_cast<std::uintptr_t>(identity(original.Get()).Get()),"tracked original IUnknown identity");
 const auto adapter_calls=symbol<unsigned(WINAPI *)()>(adapter,"OwnedAdapterPresentCalls");
 const unsigned callbacks_before=adapter_calls();
 for(unsigned i=0;i!=6;++i){
  const bool extended=i==2||i==3||i==5;const UINT flags=!expect_loss&&(i==0||i==3)?DXGI_PRESENT_TEST:0;
  const auto prior_before=prior?state(prior):renderer_state{},foreign_before=state(foreign);
  DXGI_PRESENT_PARAMETERS parameters{};const HRESULT result=extended?chain->Present1(0,flags,&parameters):chain->Present(0,flags);
  const auto observed=state(foreign),downstream=prior?state(prior):renderer_state{};
  if(expect_loss&&i==1){
   require(observed.present_calls==1&&observed.present1_calls==0,"fixed repatch removes later renderer after first call");
   require(downstream.present_calls==prior_before.present_calls+1&&result==downstream.last_result&&downstream.errors==0,"prior callback and native forwarding continue");
   ego_owned_late_d3d11_stats_v1 lost{};lost.struct_size=sizeof(lost);lost.abi_version=1;require(query(&lost)==0,"raw query after repatch");
   require(lost.present_calls-before.present_calls==1,"fixed repatch also removes later raw shim");
   require(observed.painted==1&&observed.errors==0,"first later renderer callback painted successfully");
   require(adapter_calls()-callbacks_before==2,"proxy rendering callbacks survive both application presents");
   std::printf("{\"status\":\"expected-repatch-loss\",\"assertions\":%u,\"applicationPresents\":2,\"foreignPresentCalls\":1,\"nestedRawCalls\":1,\"proxyRuntimeCallbacks\":2,\"gpuGreenReadbacks\":1,\"priorContinues\":true,\"actualRTSS\":false,\"actualSteam\":false,\"onscreen\":false,\"input\":false}\n",checks);
   return 0;
  }
  require(observed.present_calls+observed.present1_calls==foreign_before.present_calls+foreign_before.present1_calls+1,"foreign callback once per application Present");
  require(result==observed.last_result,"foreign downstream HRESULT preserved by production proxy/raw path");
  if(prior){require(downstream.present_calls+downstream.present1_calls==prior_before.present_calls+prior_before.present1_calls+1,"bottom native forwarding once");if(!forced_error||i!=5)require(result==downstream.last_result,"actual native HRESULT preserved");}
  if(forced_error&&i==5)require(result==DXGI_ERROR_WAS_STILL_DRAWING,"foreign-supplied error HRESULT preserved");
 }
 const auto final=state(foreign);require(final.present_calls==3&&final.present1_calls==3,"Present and Present1 role counts");require(final.errors==0,"foreign GPU and COM identity checks");
 if(disabled)require(final.painted==0&&final.disabled==4&&final.red_readbacks==4,"disabled green-rendering negative control reads red GPU baseline");
 else require(final.painted==4&&final.identity_matches==4&&final.device_matches==4,"foreign actually paints and reads green backbuffer on tracked original chain");
 ego_owned_late_d3d11_stats_v1 after{};after.struct_size=sizeof(after);after.abi_version=1;require(query(&after)==0&&after.status==2,"owned raw bootstrap remains active");
 require(after.present_calls-before.present_calls==6,"production raw shim receives each proxy downstream call once");
 require(after.adoption_attempts==before.adoption_attempts&&after.adoption_successes==before.adoption_successes&&after.render_failures==0&&after.quarantines==0,"nested raw shim does not independently adopt the proxy chain");
 const unsigned actual_callbacks=adapter_calls()-callbacks_before;require(actual_callbacks==4,"production proxy runtime invokes actual registered present callbacks");
 require(!IsWindowVisible(window),"fixture target stayed hidden");
 std::printf("{\"status\":\"passed\",\"assertions\":%u,\"sdkFirst\":true,\"foreignLoadedLater\":true,\"proxyFactorySkips\":%u,\"nativeFactoriesObserved\":%u,\"proxyIdentity\":\"%p\",\"originalIdentity\":\"%p\",\"foreignTrackedIdentity\":%llu,\"deviceIdentity\":%llu,\"foreignPresentCalls\":%u,\"foreignPresent1Calls\":%u,\"gpuGreenReadbacks\":%u,\"gpuRedReadbacks\":%u,\"foreignGreenRenderingDisabled\":%s,\"proxyRuntimeCallbacks\":%u,\"nestedRawCalls\":%llu,\"priorDetour\":%s,\"strategy\":\"%s\",\"video\":%s,\"legacyDiscard\":%s,\"forcedErrorHresult\":%s,\"lastDownstreamHresult\":%ld,\"actualSteam\":false,\"onscreen\":false,\"input\":false}\n",
 checks,final.factory_proxy_skips,final.native_factories,chain.Get(),original.Get(),static_cast<unsigned long long>(final.chain_identity),static_cast<unsigned long long>(final.device_identity),final.present_calls,final.present1_calls,final.painted,final.red_readbacks,disabled?"true":"false",actual_callbacks,static_cast<unsigned long long>(after.present_calls-before.present_calls),prior_enabled?"true":"false",relay?"relay":strategy?"vtable":"inline",video?"true":"false",legacy?"true":"false",forced_error?"true":"false",static_cast<long>(final.last_result));
 chain.Reset();original.Reset();factory.Reset();context.Reset();device.Reset();raw_device.Reset();DestroyWindow(window);
 return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s after %u checks\n",error.what(),checks);return 1;}
