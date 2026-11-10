// Inert owned test adapter: actual public ReShade device callbacks, no engine,
// transport, rendering callbacks, allocation transfer or target input.
#include "contract.hpp"
#include <reshade.hpp>
#include <atomic>
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi = 1;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeAdapterReadyV1 = 0;
static std::atomic<std::uint64_t> initialized {0}, destroyed {0};
static void on_init(reshade::api::device *) { ++initialized; }
static void on_destroy(reshade::api::device *) { ++destroyed; }
extern "C" __declspec(dllexport) DWORD WINAPI QueryDeviceCountsV1(device_counts_v1 *result) {
    if (result == nullptr || result->struct_size != sizeof(*result) || result->version != 1) return ERROR_REVISION_MISMATCH;
    result->initialized = initialized.load(); result->destroyed = destroyed.load(); return ERROR_SUCCESS;
}
BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        if (!reshade::register_addon(module)) return FALSE;
        reshade::register_event<reshade::addon_event::init_device>(on_init);
        reshade::register_event<reshade::addon_event::destroy_device>(on_destroy);
        InterlockedExchange(&ElectronGameOverlayCooperativeAdapterReadyV1, 1);
    }
    return TRUE;
}
#if defined(_M_IX86)
#pragma comment(linker, "/EXPORT:QueryDeviceCountsV1=_QueryDeviceCountsV1@4")
#endif
