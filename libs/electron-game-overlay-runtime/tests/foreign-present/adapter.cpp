// Owned test adapter: actual public callback registration, no feature engine,
// transport, target input or assertion of real-game acceptance.
#include <Windows.h>
#include <reshade.hpp>
#include <atomic>
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi=1;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeAdapterReadyV1=0;
static std::atomic<unsigned> calls {0};
static void on_present(reshade::api::command_queue *,reshade::api::swapchain *,const reshade::api::rect *,const reshade::api::rect *,uint32_t,const reshade::api::rect *) {++calls;}
extern "C" __declspec(dllexport) unsigned WINAPI OwnedAdapterPresentCalls(){return calls.load();}
BOOL WINAPI DllMain(HMODULE module,DWORD reason,LPVOID){
 if(reason==DLL_PROCESS_ATTACH){if(!reshade::register_addon(module))return FALSE;reshade::register_event<reshade::addon_event::present>(on_present);InterlockedExchange(&ElectronGameOverlayCooperativeAdapterReadyV1,1);}
 return TRUE;
}
#if defined(_M_IX86)
#pragma comment(linker,"/EXPORT:OwnedAdapterPresentCalls=_OwnedAdapterPresentCalls@0")
#endif
