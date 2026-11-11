#include "contract.hpp"
#include <reshade.hpp>
#include <atomic>
#include <d3d11.h>
#include <wrl/client.h>
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi = 1;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeAdapterReadyV1 = 0;
static std::atomic<std::uint64_t> devices{0}, destroyed_devices{0}, chains{0}, destroyed_chains{0}, runtimes{0}, destroyed_runtimes{0}, presents{0}, runtime_presents{0};
static std::atomic<std::uint64_t> red_readbacks{0},gpu_errors{0};
static std::atomic<std::uint64_t> runtime_hwnd{0};
static void device_init(reshade::api::device *) { ++devices; }
static void device_destroy(reshade::api::device *) { ++destroyed_devices; }
static void chain_init(reshade::api::swapchain *, bool) { ++chains; }
static void chain_destroy(reshade::api::swapchain *, bool) { ++destroyed_chains; }
static void runtime_init(reshade::api::effect_runtime *runtime) { ++runtimes;runtime_hwnd=reinterpret_cast<std::uintptr_t>(runtime->get_hwnd()); }
static void runtime_destroy(reshade::api::effect_runtime *) { ++destroyed_runtimes; }
static void runtime_present(reshade::api::effect_runtime *runtime) {
    ++runtime_presents;
    // Actual callback rendering/readback, independent of the fixture's green
    // baseline. D3D11 public resource handles carry the native resource pointer.
    using Microsoft::WRL::ComPtr;
    auto *texture=reinterpret_cast<ID3D11Texture2D *>(runtime->get_current_back_buffer().handle);
    if(!texture){++gpu_errors;return;}
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<ID3D11RenderTargetView> view;ComPtr<ID3D11Texture2D> staging;
    texture->GetDevice(&device);device->GetImmediateContext(&context);
    if(FAILED(device->CreateRenderTargetView(texture,nullptr,&view))){++gpu_errors;return;}
    const float red[4]{1,0,0,1};context->ClearRenderTargetView(view.Get(),red);
    D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.MiscFlags=0;
    if(FAILED(device->CreateTexture2D(&desc,nullptr,&staging))){++gpu_errors;return;}
    context->CopyResource(staging.Get(),texture);D3D11_MAPPED_SUBRESOURCE mapped{};
    if(FAILED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped))){++gpu_errors;return;}
    const BYTE *pixel=static_cast<const BYTE *>(mapped.pData);const bool bgra=desc.Format==DXGI_FORMAT_B8G8R8A8_UNORM||desc.Format==DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;const bool valid=pixel[bgra?2:0]==255&&pixel[1]==0&&pixel[bgra?0:2]==0&&pixel[3]==255;context->Unmap(staging.Get(),0);
    if(valid)++red_readbacks;else ++gpu_errors;
}
static void present(reshade::api::command_queue *, reshade::api::swapchain *, const reshade::api::rect *, const reshade::api::rect *, std::uint32_t, const reshade::api::rect *) { ++presents; }
extern "C" __declspec(dllexport) DWORD WINAPI QueryCallbacksV1(callback_counts_v1 *out) {
    if (!out || out->struct_size != sizeof(*out) || out->version != 1) return ERROR_REVISION_MISMATCH;
    out->devices=devices.load();out->destroyed_devices=destroyed_devices.load();out->chains=chains.load();out->destroyed_chains=destroyed_chains.load();out->runtimes=runtimes.load();out->destroyed_runtimes=destroyed_runtimes.load();out->presents=presents.load();out->runtime_presents=runtime_presents.load();out->red_readbacks=red_readbacks.load();out->gpu_errors=gpu_errors.load();out->runtime_hwnd=runtime_hwnd.load();return ERROR_SUCCESS;
}
BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        if (!reshade::register_addon(module)) return FALSE;
        reshade::register_event<reshade::addon_event::init_device>(device_init);
        reshade::register_event<reshade::addon_event::destroy_device>(device_destroy);
        reshade::register_event<reshade::addon_event::init_swapchain>(chain_init);
        reshade::register_event<reshade::addon_event::destroy_swapchain>(chain_destroy);
        reshade::register_event<reshade::addon_event::init_effect_runtime>(runtime_init);
        reshade::register_event<reshade::addon_event::destroy_effect_runtime>(runtime_destroy);
        reshade::register_event<reshade::addon_event::reshade_present>(runtime_present);
        reshade::register_event<reshade::addon_event::present>(present);
        InterlockedExchange(&ElectronGameOverlayCooperativeAdapterReadyV1, 1);
    }
    return TRUE;
}
#if defined(_M_IX86)
#pragma comment(linker,"/EXPORT:QueryCallbacksV1=_QueryCallbacksV1@4")
#endif
