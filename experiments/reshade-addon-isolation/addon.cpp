#include <Windows.h>
#include <atomic>
#include <cstdint>
#include <reshade.hpp>

#if RESHADE_API_VERSION != 18
#error "Use the unmodified public API-18 headers, not EGO's patched API-19 headers."
#endif

namespace
{
std::atomic<std::uint64_t> frames{0};
std::atomic<std::uint64_t> swapchain_inits{0};
bool registered = false;

void on_present(reshade::api::effect_runtime *)
{
    frames.fetch_add(1, std::memory_order_relaxed);
}

void on_init_swapchain(reshade::api::swapchain *, bool)
{
    swapchain_inits.fetch_add(1, std::memory_order_relaxed);
}
}

extern "C" __declspec(dllexport) const char *NAME = PROBE_NAME;
extern "C" __declspec(dllexport) const char *DESCRIPTION =
    "Research-only frame and lifecycle callback counter; no EGO runtime.";

extern "C" __declspec(dllexport) std::uint64_t ProbeFrames()
{
    return frames.load(std::memory_order_relaxed);
}

extern "C" __declspec(dllexport) std::uint64_t ProbeSwapchainInits()
{
    return swapchain_inits.load(std::memory_order_relaxed);
}

extern "C" __declspec(dllexport) bool AddonInit(HMODULE module, HMODULE runtime)
{
    if (!reshade::register_addon(module, runtime))
        return false;
    registered = true;
    reshade::register_event<reshade::addon_event::init_swapchain>(on_init_swapchain);
    reshade::register_event<reshade::addon_event::reshade_present>(on_present);
    return true;
}

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_DETACH && registered)
        reshade::unregister_addon(module);
    return TRUE;
}
