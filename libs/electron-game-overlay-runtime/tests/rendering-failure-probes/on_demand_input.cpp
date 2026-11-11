// Production ReShade input suppression/callbacks with a tiny probe add-on.
// Hidden owned HWND, posted messages only; no SDK transport or physical input.
#include <Windows.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <reshade.hpp>
#include <cstdio>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
static unsigned frames=0, observed=0, delivered=0, app_keys=0;
static bool desired=false, dirty=false;
static void require(bool b,const char *s) { if(!b) throw std::runtime_error(s); }
static void input(const reshade::api::input_message &m) { if(m.message==WM_KEYDOWN) ++observed; }
static void overlay(reshade::api::effect_runtime *r) {
  ++frames; delivered=observed;
  if(desired) r->block_input_next_frame();
}
static LRESULT CALLBACK wndproc(HWND w,UINT m,WPARAM p,LPARAM l) {
  if(m==WM_KEYDOWN) { ++app_keys; dirty=true; return 0; }
  if(m==WM_APP+1) { dirty=true; return 0; }
  return DefWindowProcW(w,m,p,l);
}
static void pump() { MSG m; unsigned n=0; while(PeekMessageW(&m,nullptr,0,0,PM_REMOVE)) {
  require(++n<4096,"unbounded message pump"); DispatchMessageW(&m);
} }
static void sample(const char *phase) {
  std::printf("{\"phase\":\"%s\",\"frames\":%u,\"observed\":%u,\"delivered\":%u,\"appKeys\":%u,\"dirty\":%s}\n",phase,frames,observed,delivered,app_keys,dirty?"true":"false");
}
int wmain(int argc,wchar_t **argv) {
  try {
    if(argc!=3) return 64;
    SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE",argv[2]);
    HMODULE host=LoadLibraryW(argv[1]); require(host!=nullptr,"LoadLibrary");
    require(reshade::register_addon(GetModuleHandleW(nullptr),host),"register probe");
    reshade::register_event<reshade::addon_event::input_message>(input);
    reshade::register_event<reshade::addon_event::reshade_overlay>(overlay);
    WNDCLASSW wc={}; wc.hInstance=GetModuleHandleW(nullptr); wc.lpfnWndProc=wndproc; wc.lpszClassName=L"EgoOwnedDemandProbe";
    require(RegisterClassW(&wc)!=0,"RegisterClass");
    HWND window=CreateWindowW(wc.lpszClassName,L"",WS_OVERLAPPEDWINDOW,0,0,64,64,nullptr,nullptr,wc.hInstance,nullptr);
    require(window!=nullptr,"CreateWindow"); // Never shown or focused.
    DXGI_SWAP_CHAIN_DESC desc={}; desc.BufferDesc.Width=64; desc.BufferDesc.Height=64;
    desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count=1;
    desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT; desc.BufferCount=2; desc.OutputWindow=window;
    desc.Windowed=TRUE; desc.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
    ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context; ComPtr<IDXGISwapChain> chain;
    require(SUCCEEDED(D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&chain,&device,nullptr,&context)),"create device/chain");
    auto present=[&] { require(SUCCEEDED(chain->Present(0,0)),"Present"); dirty=false; pump(); };
    for(int i=0;i<4;++i) present();
    require(frames>0,"no production rendering callbacks");
    PostMessageW(window,WM_KEYDOWN,'A',1); pump(); require(app_keys==1 && dirty,"unblocked redraw control"); present();
    desired=true; present(); present();
    const auto start_frames=frames, start_keys=app_keys, start_observed=observed, start_delivered=delivered;
    PostMessageW(window,WM_KEYDOWN,'B',1); pump();
    require(app_keys==start_keys && !dirty,"suppressed input reached target redraw handler");
    require(observed>start_observed && delivered==start_delivered,"input was not queued pending render");
    sample("blocked-without-redraw");
    desired=false; // Represents an out-of-band consumer request; no Present follows yet.
    for(int i=0;i<20;++i) { pump(); Sleep(5); }
    PostMessageW(window,WM_KEYDOWN,'C',1); pump();
    require(frames==start_frames && app_keys==start_keys,"idle unexpectedly released suppression");
    sample("release-pending-without-redraw");
    PostMessageW(window,WM_APP+1,0,0); pump(); require(dirty,"explicit redraw wake failed");
    present(); present();
    require(delivered==observed,"render did not drain queued observation");
    PostMessageW(window,WM_KEYDOWN,'D',1); pump(); require(app_keys==start_keys+1,"render did not release suppression");
    sample("redraw-restores-progress");
    chain.Reset(); context.Reset(); device.Reset(); DestroyWindow(window);
    reshade::unregister_addon(GetModuleHandleW(nullptr),host);
    std::puts("{\"status\":\"reproduced\",\"hiddenWindow\":true,\"physicalInput\":false,\"egoTransport\":false}");
    return 0;
  } catch(const std::exception &e) { std::fprintf(stderr,"%s\n",e.what()); return 3; }
}
