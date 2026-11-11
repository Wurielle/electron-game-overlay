// Real hardware with hidden or verified-offscreen HWNDs; no game or input.
#include "contract.hpp"
#include "probe_contract.hpp"
#define RESHADE_OWNED_LATE_D3D11_ABI_ONLY
#include "owned_late_d3d11.hpp"
#include <d3d11.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <MinHook.h>
#include <intrin.h>
#include <atomic>
#include <thread>
#include <string>
#include <cstdio>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
static unsigned checks=0, green_readbacks=0;
static void require(bool ok,const char *text) { ++checks;if(!ok)throw std::runtime_error(text); }
static void hr(HRESULT value,const char *text) { if(FAILED(value))std::fprintf(stderr,"%s hr=%08lx\n",text,value);require(SUCCEEDED(value),text); }
template<class T>static T symbol(HMODULE module,const char *name) { const auto fn=reinterpret_cast<T>(GetProcAddress(module,name));require(fn!=nullptr,name);return fn; }
static HMODULE owner(void *address) { MEMORY_BASIC_INFORMATION info{};return VirtualQuery(address,&info,sizeof(info))?static_cast<HMODULE>(info.AllocationBase):nullptr; }
static void wait(HANDLE event,const char *text) { require(WaitForSingleObject(event,10000)==WAIT_OBJECT_0,text); }
struct loader_guard {
    HANDLE entered=CreateEventW(nullptr,TRUE,FALSE,nullptr),release=CreateEventW(nullptr,TRUE,FALSE,nullptr),done=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    std::thread thread;
    ~loader_guard(){SetEvent(release);if(thread.joinable())thread.join();for(auto event:{entered,release,done})if(event)CloseHandle(event);}
};
static loader_guard *sync_state=nullptr;
static HMODULE host=nullptr;
using stats_fn=DWORD(WINAPI *)(ego_owned_late_d3d11_stats_v1 *);
static stats_fn captured_query_stats=nullptr;
static HANDLE captured_completion=nullptr;
static std::atomic<DWORD> captured_queues{0},captured_workers{0},captured_queue_thread{0},captured_worker_thread{0},captured_error{0},captured_result{ERROR_IO_PENDING};
static std::atomic<bool> fail_captured_queue{false};
static std::atomic<bool> captured_contract_ok{true};
static LPTHREAD_START_ROUTINE captured_callback=nullptr;
static void *captured_parameter=nullptr;
using queue_work_fn=BOOL(WINAPI *)(LPTHREAD_START_ROUTINE,PVOID,ULONG);
static queue_work_fn real_queue_work=nullptr;
static DWORD WINAPI observed_work(void *) {
    ++captured_workers;captured_worker_thread=GetCurrentThreadId();
    captured_result=captured_callback(captured_parameter);SetEvent(captured_completion);return captured_result.load();
}
static BOOL WINAPI observe_queue(LPTHREAD_START_ROUTINE callback,PVOID parameter,ULONG flags) {
    if(owner(_ReturnAddress())!=host)return real_queue_work(callback,parameter,flags);
    const DWORD count=++captured_queues;captured_queue_thread=GetCurrentThreadId();
    if(owner(reinterpret_cast<void *>(callback))!=host||parameter!=nullptr||flags!=WT_EXECUTELONGFUNCTION)captured_contract_ok=false;
    if(fail_captured_queue){captured_error=ERROR_NOT_ENOUGH_MEMORY;captured_result=ERROR_NOT_ENOUGH_MEMORY;SetEvent(captured_completion);SetLastError(ERROR_NOT_ENOUGH_MEMORY);return FALSE;}
    if(count!=1)return real_queue_work(callback,parameter,flags);
    captured_callback=callback;captured_parameter=parameter;
    const BOOL result=real_queue_work(&observed_work,nullptr,flags);
    if(!result){const DWORD error=GetLastError();captured_error=error;SetEvent(captured_completion);SetLastError(error);}
    return result;
}
static DWORD WINAPI observed_probe(deferred_probe_v1 *out) {
    ego_owned_late_d3d11_stats_v1 current{};current.struct_size=sizeof(current);current.abi_version=1;
    const DWORD result=captured_query_stats(&current);if(result)return result;
    out->pending=current.status==4&&current.last_win32_error==ERROR_MOD_NOT_FOUND;out->queued=captured_queues.load()!=0;out->queue_calls=captured_queues;out->worker_calls=captured_workers;out->queue_thread=captured_queue_thread;out->worker_thread=captured_worker_thread;out->queue_error=captured_error;
    // Production exposes status/error, not its private worker return value.
    out->result=current.status==3?current.last_win32_error:captured_result.load();out->host_status=current.status;out->reserved=captured_contract_ok?0:1;return ERROR_SUCCESS;
}
static std::atomic<DWORD> scan_thread{0};
static std::atomic<bool> armed{false},claimed{false},barrier_timeout{false};
using query_module_fn=BOOL(WINAPI *)(DWORD,LPCWSTR,HMODULE *);
static query_module_fn real_query=nullptr;
static BOOL WINAPI query_module(DWORD flags,LPCWSTR name,HMODULE *out) {
    if(armed.load()&&GetCurrentThreadId()==scan_thread.load()&&name&&
       (flags&(GET_MODULE_HANDLE_EX_FLAG_PIN|GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS))==GET_MODULE_HANDLE_EX_FLAG_PIN&&owner(_ReturnAddress())==host){
        bool expected=false;if(claimed.compare_exchange_strong(expected,true)){
            SetEvent(sync_state->entered);if(WaitForSingleObject(sync_state->release,10000)!=WAIT_OBJECT_0)barrier_timeout=true;
        }
    }
    return real_query(flags,name,out);
}
static IDXGISwapChain *tracked=nullptr;
static unsigned native_presents=0,native_present1s=0,native_resizes=0;
static UINT last_sync=0,last_flags=0;
static HRESULT last_native=S_OK;
static bool force_error=false;
using present_fn=HRESULT(STDMETHODCALLTYPE *)(IDXGISwapChain *,UINT,UINT);
using present1_fn=HRESULT(STDMETHODCALLTYPE *)(IDXGISwapChain1 *,UINT,UINT,const DXGI_PRESENT_PARAMETERS *);
using resize_fn=HRESULT(STDMETHODCALLTYPE *)(IDXGISwapChain *,UINT,UINT,UINT,DXGI_FORMAT,UINT);
static present_fn real_present=nullptr;static present1_fn real_present1=nullptr;static resize_fn real_resize=nullptr;
static HRESULT STDMETHODCALLTYPE observe_present(IDXGISwapChain *chain,UINT sync,UINT flags) {
    const HRESULT result=real_present(chain,sync,flags);if(chain==tracked){++native_presents;last_sync=sync;last_flags=flags;last_native=force_error?DXGI_ERROR_WAS_STILL_DRAWING:result;return last_native;}return result;
}
static HRESULT STDMETHODCALLTYPE observe_present1(IDXGISwapChain1 *chain,UINT sync,UINT flags,const DXGI_PRESENT_PARAMETERS *params) {
    const HRESULT result=real_present1(chain,sync,flags,params);if(chain==tracked){++native_present1s;last_sync=sync;last_flags=flags;last_native=force_error?DXGI_ERROR_WAS_STILL_DRAWING:result;return last_native;}return result;
}
static HRESULT STDMETHODCALLTYPE observe_resize(IDXGISwapChain *chain,UINT count,UINT width,UINT height,DXGI_FORMAT format,UINT flags) {
    const HRESULT result=real_resize(chain,count,width,height,format,flags);if(chain==tracked){++native_resizes;last_native=result;}return result;
}
static void install_observers(IDXGISwapChain1 *chain) {
    tracked=chain;auto **methods=*reinterpret_cast<void ***>(chain);
    require(MH_CreateHook(methods[8],reinterpret_cast<void *>(&observe_present),reinterpret_cast<void **>(&real_present))==MH_OK,"native Present observer");
    require(MH_CreateHook(methods[22],reinterpret_cast<void *>(&observe_present1),reinterpret_cast<void **>(&real_present1))==MH_OK,"native Present1 observer");
    require(MH_CreateHook(methods[13],reinterpret_cast<void *>(&observe_resize),reinterpret_cast<void **>(&real_resize))==MH_OK,"native Resize observer");
    require(MH_EnableHook(MH_ALL_HOOKS)==MH_OK,"enable owned observers");
}
static void green(ID3D11Device *device,ID3D11DeviceContext *context,IDXGISwapChain *chain) {
    ComPtr<ID3D11Texture2D> texture,staging;ComPtr<ID3D11RenderTargetView> view;
    hr(chain->GetBuffer(0,IID_PPV_ARGS(&texture)),"real original backbuffer");
    hr(device->CreateRenderTargetView(texture.Get(),nullptr,&view),"real render target");
    const float color[4]{0,1,0,1};context->ClearRenderTargetView(view.Get(),color);
    D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.MiscFlags=0;
    hr(device->CreateTexture2D(&desc,nullptr,&staging),"real staging buffer");context->CopyResource(staging.Get(),texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};hr(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped),"GPU readback");
    const BYTE *pixel=static_cast<const BYTE *>(mapped.pData);const bool valid=pixel[0]==0&&pixel[1]==255&&pixel[2]==0&&pixel[3]==255;context->Unmap(staging.Get(),0);require(valid,"green GPU pixel");++green_readbacks;
}
static ego_owned_late_d3d11_stats_v1 stats(stats_fn query) { ego_owned_late_d3d11_stats_v1 value{};value.struct_size=sizeof(value);value.abi_version=1;require(query(&value)==0,"production stats");return value; }
static callback_counts_v1 callbacks(query_callbacks_fn query) { callback_counts_v1 value;require(query(&value)==0,"public callback counts");return value; }
static deferred_probe_v1 probe(query_deferred_probe_fn query) { deferred_probe_v1 value;if(query)require(query(&value)==0,"prototype observation");return value; }
int wmain(int argc,wchar_t **argv)try {
    require(argc==8,"HOST ADAPTER INERT-TRIGGER NESTED-LOADER STAGE CASE baseline|prototype|production");const std::wstring mode=argv[6];const bool production=std::wcscmp(argv[7],L"production")==0;
    const bool composition=mode==L"contended-composition",serialized=mode==L"serialized",contended=mode==L"contended"||composition,queue_failure=mode==L"queue-failure",foreign=mode==L"foreign",unready=mode==L"unready",no_backend=mode==L"no-backend",dllmain=mode==L"dllmain",nested=mode==L"nested",revoked=mode==L"revoked-ready",revoked_stage=mode==L"revoked-stage",notification=mode==L"notification-control";
    require(serialized||contended||queue_failure||foreign||unready||no_backend||dllmain||nested||revoked||revoked_stage||notification,"known assessment mode");
    require(!GetModuleHandleW(L"d3d11.dll")&&!GetModuleHandleW(L"dxgi.dll"),"graphics absent before host");
    require(SetEnvironmentVariableW(L"SteamOverlayGameId",L"1")!=FALSE,"owned production LoadLibrary lane");
    if(notification){require(SetEnvironmentVariableW(L"SteamOverlayGameId",nullptr)!=FALSE,"notification control clears only its own child environment");require(!GetModuleHandleW(L"GameOverlayRenderer64.dll")&&!GetModuleHandleW(L"GameOverlayRenderer.dll"),"notification control has no Steam renderer module");}
    require(SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE",argv[5])!=FALSE,"owned fixture stage");
    host=LoadLibraryW(argv[1]);require(host!=nullptr,"host loaded");
    auto gate=symbol<volatile LONG *>(host,"ElectronGameOverlayReShadeAddonGate");require(InterlockedCompareExchange(gate,1,0)==0,"registration gate");
    const HMODULE counter=LoadLibraryW(argv[2]);require(counter!=nullptr,"public callback adapter loaded");
    auto ready=symbol<volatile LONG *>(counter,"ElectronGameOverlayCooperativeAdapterReadyV1");
    if(unready)InterlockedExchange(ready,0);require(InterlockedCompareExchange(gate,2,1)==1,"adapter published");
    const auto query=symbol<query_callbacks_fn>(counter,"QueryCallbacksV1");
    const auto initialize=symbol<DWORD(WINAPI *)(const ego_owned_late_d3d11_initialize_v1 *)>(host,"ElectronGameOverlayInitializeOwnedLateD3D11V1");
    const auto query_stats=symbol<stats_fn>(host,"ElectronGameOverlayQueryOwnedLateD3D11V1");
    auto query_probe=reinterpret_cast<query_deferred_probe_fn>(GetProcAddress(host,"EgoReproQueryDeferredBootstrapV1"));
    require(MH_Initialize()==MH_OK,"owned hooks initialized");
    HANDLE complete=nullptr;
    if(production){
        require(query_probe==nullptr,"production DLL excludes prototype exports");captured_query_stats=query_stats;query_probe=&observed_probe;
        complete=captured_completion=CreateEventW(nullptr,TRUE,FALSE,nullptr);require(complete!=nullptr,"test-owned completion event");
        require(MH_CreateHook(reinterpret_cast<void *>(&QueueUserWorkItem),reinterpret_cast<void *>(&observe_queue),reinterpret_cast<void **>(&real_queue_work))==MH_OK,"owned public work-queue observation");
        require(MH_EnableHook(reinterpret_cast<void *>(&QueueUserWorkItem))==MH_OK,"work-queue observation enabled");
        fail_captured_queue=queue_failure;
    }else{
        if(query_probe)require(symbol<acquire_deferred_completion_fn>(host,"EgoReproAcquireDeferredCompletionV1")(&complete)==0,"caller-owned completion handle");
        if(queue_failure)symbol<force_deferred_queue_failure_fn>(host,"EgoReproForceDeferredQueueFailureV1")(TRUE);
    }
    const DWORD initial_result=initialize(nullptr);const auto initial=stats(query_stats);const auto initial_probe=probe(query_probe);
    require(foreign?initial_result!=0:unready?initial_result==ERROR_NOT_READY:initial_result==0,"owned validation boundary");
    require(foreign||unready?initial.status==0:initial.status==4&&initial.last_win32_error==ERROR_MOD_NOT_FOUND,"exact initial missing-module state");
    require(!GetModuleHandleW(L"d3d11.dll"),"initializer did not load irrelevant backend");
    if(query_probe)require(initial_probe.queue_calls==0&&initial_probe.worker_calls==0&&initial_probe.pending==(!foreign&&!unready),"pending only for validated owned absence");
    if(no_backend){require(LoadLibraryW(argv[3])!=nullptr,"unrelated library load");const auto final=probe(query_probe);require(!GetModuleHandleW(L"d3d11.dll")&&final.queue_calls==0&&final.worker_calls==0,"no backend means no worker");require(MH_DisableHook(MH_ALL_HOOKS)==MH_OK&&MH_Uninitialize()==MH_OK,"fixture observation retired");std::printf("{\"case\":\"no-backend\",\"status\":\"passed\",\"gatePassed\":true,\"assertions\":%u,\"queueCalls\":0,\"workerCalls\":0,\"onscreen\":false,\"input\":false,\"actualGame\":false}\n",checks);if(complete)CloseHandle(complete);return 0;}
    // Shared storage precedes guard so it remains alive while its thread joins.
    std::string scan_error;loader_guard state;sync_state=&state;
    require(state.entered&&state.release&&state.done,"fixture synchronization events");
    const bool held=contended||queue_failure||revoked||revoked_stage;
    if(held){
        require(MH_CreateHook(reinterpret_cast<void *>(&GetModuleHandleExW),reinterpret_cast<void *>(&query_module),reinterpret_cast<void **>(&real_query))==MH_OK,"scan barrier hook");
        require(MH_EnableHook(reinterpret_cast<void *>(&GetModuleHandleExW))==MH_OK,"scan barrier enabled");
        state.thread=std::thread([&]{scan_thread=GetCurrentThreadId();armed=true;if(!LoadLibraryW(argv[3]))scan_error="inert trigger load failed";SetEvent(state.done);});
        const HANDLE events[]{state.entered,state.done};require(WaitForMultipleObjects(2,events,FALSE,10000)==WAIT_OBJECT_0,"real scan barrier entered");
    }
    if(revoked)InterlockedExchange(ready,0);
    if(revoked_stage)require(DeleteFileW((std::wstring(argv[5])+L"\\electron-game-overlay-owned-runtime-v1.marker").c_str())!=FALSE,"remove only fixture-owned marker before worker validation");
    if(dllmain||nested){
        const HMODULE loader=LoadLibraryW(argv[4]);require(loader!=nullptr,"owned nested loader returned without deadlock");
        if(nested)require(symbol<DWORD(WINAPI *)()>(loader,"LoadBackendV1")()==0,"nested ordinary DLL load returned");
    }
    wchar_t system[MAX_PATH]{};require(GetSystemDirectoryW(system,MAX_PATH)!=0,"system backend path");
    const HMODULE d3d=LoadLibraryW((std::wstring(system)+L"\\d3d11.dll").c_str());require(d3d!=nullptr,"real backend load returned");
    const auto create=symbol<PFN_D3D11_CREATE_DEVICE_AND_SWAP_CHAIN>(d3d,"D3D11CreateDeviceAndSwapChain");
    const HWND foreground=GetForegroundWindow();RECT virtual_screen{GetSystemMetrics(SM_XVIRTUALSCREEN),GetSystemMetrics(SM_YVIRTUALSCREEN),0,0};virtual_screen.right=virtual_screen.left+GetSystemMetrics(SM_CXVIRTUALSCREEN);virtual_screen.bottom=virtual_screen.top+GetSystemMetrics(SM_CYVIRTUALSCREEN);RECT placement{-32000,-32000,-31872,-31872},intersection{};require(!IntersectRect(&intersection,&placement,&virtual_screen),"offscreen placement outside every monitor before any visible style");
    HWND window=CreateWindowExW(WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW,L"STATIC",L"Owned deferred original chain",composition?WS_POPUP|WS_CAPTION:WS_POPUP,-32000,-32000,128,128,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
    require(window!=nullptr,"offscreen HWND created");
    if(composition)ShowWindow(window,SW_SHOWNOACTIVATE);
    require((IsWindowVisible(window)!=FALSE)==composition,"offscreen HWND has expected visibility");
    require(GetForegroundWindow()==foreground,"offscreen HWND preserves foreground");
    DXGI_SWAP_CHAIN_DESC desc{};desc.BufferDesc.Width=desc.BufferDesc.Height=64;desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=2;desc.OutputWindow=window;desc.Windowed=TRUE;desc.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<IDXGISwapChain> base;ComPtr<IDXGISwapChain1> chain;
    if(composition){
        const auto create_device=symbol<PFN_D3D11_CREATE_DEVICE>(d3d,"D3D11CreateDevice");hr(create_device(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context),"real missed BGRA hardware device");
        const HMODULE dxgi=GetModuleHandleW(L"dxgi.dll");require(dxgi!=nullptr,"actual device loaded DXGI");using factory_fn=HRESULT(WINAPI *)(UINT,REFIID,void **);const auto create_factory=symbol<factory_fn>(dxgi,"CreateDXGIFactory2");ComPtr<IDXGIFactory2> factory;hr(create_factory(0,IID_PPV_ARGS(&factory)),"real missed native factory");
        DXGI_SWAP_CHAIN_DESC1 composition_desc{};composition_desc.Width=composition_desc.Height=64;composition_desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;composition_desc.SampleDesc.Count=1;composition_desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;composition_desc.BufferCount=2;composition_desc.SwapEffect=DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;composition_desc.AlphaMode=DXGI_ALPHA_MODE_IGNORE;
        hr(factory->CreateSwapChainForComposition(device.Get(),&composition_desc,nullptr,&chain),"original composition chain");hr(chain.As(&base),"composition base interface");DXGI_SWAP_CHAIN_DESC observed{};hr(chain->GetDesc(&observed),"composition descriptor");HWND native_window=nullptr;require(observed.OutputWindow==nullptr&&FAILED(chain->GetHwnd(&native_window)),"actual null-HWND composition path");desc.BufferDesc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;
    }else{hr(create(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&base,&device,nullptr,&context),"real hardware device and chain");hr(base.As(&chain),"original chain1");}
    const bool first_proxy=owner((*reinterpret_cast<void ***>(device.Get()))[3])==host;
    if(held)require(!first_proxy&&callbacks(query).devices==0,"first real device missed by automatic hooks");
    else require(first_proxy,"ordinary automatic device control remains wrapped");
    green(device.Get(),context.Get(),chain.Get());hr(chain->Present(0,DXGI_PRESENT_TEST),"first native test Present");
    // Observers are on original methods; proxy controls exercise their downstream.
    static constexpr GUID unwrapped={0x7f2c9a11,0x3b4e,0x4d6a,{0x81,0x2f,0x5e,0x9c,0xd3,0x7a,0x1b,0x42}};
    ComPtr<IDXGISwapChain1> original=chain;if(first_proxy){original.Reset();hr(chain->QueryInterface(unwrapped,&original),"original chain observation");}
    install_observers(original.Get());
    if(held){require(WaitForSingleObject(state.done,0)==WAIT_TIMEOUT,"publication held through first usable chain");SetEvent(state.release);wait(state.done,"scan returned after publication");state.thread.join();armed=false;require(scan_error.empty()&&!barrier_timeout,"scan liveness");}
    const bool inactive=foreign||unready||queue_failure||revoked||revoked_stage||notification;
    if(query_probe&&!foreign&&!unready&&!notification){wait(complete,"deferred work completed outside loader thread");const auto p=probe(query_probe);require(p.queue_calls==1&&p.queued==1,"one queue attempt");require(p.worker_calls==(queue_failure?0u:1u),"one worker or explicit queue failure");if(!queue_failure)require(p.worker_thread!=p.queue_thread,"worker not loader caller");if(queue_failure)require(p.queue_error==ERROR_NOT_ENOUGH_MEMORY,"queue failure terminal");if(revoked)require(p.result==ERROR_NOT_READY,"worker revalidates adapter readiness");if(revoked_stage)require(p.result==ERROR_ACCESS_DENIED,"worker revalidates exact owned stage marker");}
    else if(query_probe)require(probe(query_probe).queue_calls==0,"foreign and unready never queued");
    const auto before=stats(query_stats);const auto cb_before=callbacks(query);
    if(production)require(probe(query_probe).reserved==0,"owned callback, opaque parameter and queue flags preserved");
    if(query_probe&&!inactive)require(before.status==2,"deferred raw methods active");
    if(query_probe&&(revoked||revoked_stage))require(before.status==3&&before.last_win32_error==(revoked?ERROR_NOT_READY:ERROR_ACCESS_DENIED),"asynchronous validation failure remains passive and queryable");
    unsigned calls=0;
    for(unsigned i=0;i<5;++i){
        const bool extended=i%2!=0;const UINT flags=i==0?DXGI_PRESENT_TEST:i==4?DXGI_PRESENT_DO_NOT_WAIT:0;
        const unsigned observed=native_presents+native_present1s;force_error=i==4;
        DXGI_PRESENT_PARAMETERS parameters{};const HRESULT result=extended?chain->Present1(0,flags,&parameters):chain->Present(0,flags);++calls;
        require(native_presents+native_present1s==observed+1,"exactly one original Present forwarding");require(last_sync==0&&last_flags==flags,"sync and flags preserved");require(result==last_native,"downstream HRESULT preserved");if(force_error)require(result==DXGI_ERROR_WAS_STILL_DRAWING,"forced error preserved");force_error=false;
    }
    auto after=stats(query_stats);auto cb_after=callbacks(query);const bool adopted=after.adoption_successes==1;
    const bool recovered=query_probe&&!inactive;
    if(held&&recovered){require(adopted&&after.adoption_attempts==1,"original missed chain adopted once");require(cb_after.runtimes==1&&cb_after.chains==1&&cb_after.runtime_presents-cb_before.runtime_presents==4,"actual runtime surface and reshade_present callbacks");require(cb_after.presents==0,"manual public runtime path does not invent automatic device Present callbacks");require(owner((*reinterpret_cast<void ***>(device.Get()))[3])!=host,"original device remains native");}
    if(composition&&recovered)require(cb_after.runtime_hwnd==reinterpret_cast<std::uintptr_t>(window),"raw composition runtime resolves the exact offscreen presentation HWND");
    if(!held&&recovered)require(after.adoption_successes==0&&after.adoption_attempts==0&&cb_after.runtimes==1,"automatic proxy not adopted twice");
    if(recovered)require(cb_after.red_readbacks-cb_before.red_readbacks==4&&cb_after.gpu_errors==0,"registered runtime callback actually paints and reads red GPU pixels");
    if(inactive)require(after.adoption_successes==0&&after.adoption_attempts==0,"negative case never manually adopted");
    if(notification)require(after.status==4&&after.present_calls==0&&cb_after.runtime_presents==4&&cb_after.red_readbacks==4&&cb_after.gpu_errors==0,"notification lane keeps automatic rendering without deferred work");
    require(after.quarantines==0&&after.render_failures==0,"no raw quarantine or rendering failure");
    green(device.Get(),context.Get(),chain.Get());context->ClearState();context->Flush();
    hr(chain->ResizeBuffers(2,80,80,desc.BufferDesc.Format,0),"real resize after deferred adoption");require(native_resizes==1,"one original ResizeBuffers forwarding");
    green(device.Get(),context.Get(),chain.Get());const auto post_resize=stats(query_stats);if(held&&recovered)require(post_resize.resize_calls==1&&post_resize.resize_successes==1,"raw resize succeeds");
    const auto before_resume=callbacks(query);const auto forwarded_before_resume=native_presents+native_present1s;DXGI_PRESENT_PARAMETERS resumed_parameters{};
    const HRESULT resumed=chain->Present1(0,0,&resumed_parameters);require(resumed==last_native&&native_presents+native_present1s==forwarded_before_resume+1,"resized original chain forwards once");
    if(recovered){const auto resumed_cb=callbacks(query);require(resumed_cb.runtime_presents==before_resume.runtime_presents+1&&resumed_cb.red_readbacks==before_resume.red_readbacks+1&&resumed_cb.gpu_errors==0,"resized runtime resumes actual red GPU callback");}
    require(LoadLibraryW(argv[3])!=nullptr,"later unrelated scan");if(query_probe)require(probe(query_probe).queue_calls==(!foreign&&!unready&&!notification?1u:0u),"no later queue retry");
    RECT final_rect{};require(GetWindowRect(window,&final_rect)&&!IntersectRect(&intersection,&final_rect,&virtual_screen)&&(IsWindowVisible(window)!=FALSE)==composition&&GetForegroundWindow()==foreground,"HWND stays offscreen with original visibility and foreground preserved");
    // Release actual chains before removing downstream observers.
    tracked=nullptr;original.Reset();chain.Reset();base.Reset();context.Reset();device.Reset();DestroyWindow(window);
    const auto final=stats(query_stats);const auto final_cb=callbacks(query);if(held&&recovered)require(final.retirements==1&&final_cb.destroyed_runtimes==final_cb.runtimes,"adopted lifetime retired once and resized runtimes balanced");
    require(MH_DisableHook(MH_ALL_HOOKS)==MH_OK&&MH_Uninitialize()==MH_OK,"fixture hooks retired");if(complete)CloseHandle(complete);
    const bool missing_gate=contended&&!query_probe;
    const auto final_probe=probe(query_probe);
    std::printf("{\"case\":\"%ls\",\"status\":\"%s\",\"gatePassed\":%s,\"assertions\":%u,\"firstDeviceProxy\":%s,\"adoptedOriginalChain\":%s,\"hostStatus\":%u,\"rawPresentCalls\":%llu,\"nativePresents\":%u,\"nativePresent1s\":%u,\"nativeResizes\":%u,\"gpuGreenReadbacks\":%u,\"runtimeCallbacks\":%llu,\"automaticPresentCallbacks\":%llu,\"runtimePresentCallbacks\":%llu,\"callbackRedReadbacks\":%llu,\"retirements\":%llu,\"queueCalls\":%u,\"workerCalls\":%u,\"queueThread\":%u,\"workerThread\":%u,\"queueError\":%u,\"workerResult\":%u,\"onscreen\":false,\"input\":false,\"actualGame\":false}\n",mode.c_str(),missing_gate?"baseline-late-adoption-missing":"passed",missing_gate?"false":"true",checks,first_proxy?"true":"false",adopted?"true":"false",after.status,static_cast<unsigned long long>(final.present_calls),native_presents,native_present1s,native_resizes,green_readbacks,static_cast<unsigned long long>(final_cb.runtimes),static_cast<unsigned long long>(final_cb.presents),static_cast<unsigned long long>(final_cb.runtime_presents),static_cast<unsigned long long>(final_cb.red_readbacks),static_cast<unsigned long long>(final.retirements),final_probe.queue_calls,final_probe.worker_calls,final_probe.queue_thread,final_probe.worker_thread,final_probe.queue_error,final_probe.result);
    return missing_gate?3:0;
}catch(const std::exception &error){std::fprintf(stderr,"%s after %u assertions; Win32=%lu\n",error.what(),checks,GetLastError());return 1;}
