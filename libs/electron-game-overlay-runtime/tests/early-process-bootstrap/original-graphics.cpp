// Controlled pre-main graphics fixture. The earlier DllMain graphics attempt
// returned DXGI_ERROR_UNSUPPORTED and remains failed evidence, not a pass.
// DllMain now records flags only; the executable CRT calls the graphics export
// after DLL loader initialization and before wmain. No ReShade is loaded here.
#ifndef EARLY_ORIGINAL_GRAPHICS_EXPORTS
#define EARLY_ORIGINAL_GRAPHICS_EXPORTS
#endif
#include "original-graphics.h"
#include "trace.hpp"

namespace
{
    HMODULE g_module = nullptr;
    ID3D12Device *g_device = nullptr;
    ID3D12CommandQueue *g_queue = nullptr;
    HRESULT g_device_result = E_PENDING;
    HRESULT g_queue_result = E_PENDING;
    BOOL g_dll_entered = FALSE;
    BOOL g_dll_returned = FALSE;
    BOOL g_entered = FALSE;
    BOOL g_returned = FALSE;
    BOOL g_trace_okay = TRUE;
    volatile LONG g_taken = 0;
    volatile LONG g_initialized = 0;

    void record(const char *event, HRESULT status = S_OK) noexcept
    {
        if (!early_proof::trace(g_module, event, status))
            g_trace_okay = FALSE;
    }
}

extern "C" BOOL WINAPI EarlyOriginalGraphicsTakeV1(EarlyOriginalGraphicsV1 *output)
{
    if (output == nullptr || output->struct_size != static_cast<UINT>(sizeof(EarlyOriginalGraphicsV1)) ||
        InterlockedCompareExchange(&g_taken, 1, 0) != 0)
        return FALSE;
    output->device_result = g_device_result;
    output->queue_result = g_queue_result;
    output->original_dll_attach_entered = g_dll_entered;
    output->original_dll_attach_returned = g_dll_returned;
    output->initializer_entered = g_entered;
    output->initializer_returned = g_returned;
    output->trace_okay = g_trace_okay;
    output->device = g_device;
    output->queue = g_queue;
    g_device = nullptr;
    g_queue = nullptr;
    return TRUE;
}

extern "C" BOOL WINAPI EarlyOriginalGraphicsInitializeV1()
{
    if (InterlockedCompareExchange(&g_initialized, 1, 0) != 0 ||
        !g_dll_entered || !g_dll_returned)
        return FALSE;
    g_entered = TRUE;
    record("original-graphics-initializer-begin");
    g_device_result = D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0,
        __uuidof(ID3D12Device), reinterpret_cast<void **>(&g_device));
    record("original-initializer-device-result", g_device_result);
    if (SUCCEEDED(g_device_result) && g_device != nullptr)
    {
        D3D12_COMMAND_QUEUE_DESC desc = {};
        desc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        g_queue_result = g_device->CreateCommandQueue(&desc,
            __uuidof(ID3D12CommandQueue), reinterpret_cast<void **>(&g_queue));
        record("original-initializer-queue-result", g_queue_result);
    }
    g_returned = TRUE;
    record("original-graphics-initializer-end",
        FAILED(g_device_result) ? g_device_result : g_queue_result);
    return SUCCEEDED(g_device_result) && g_device != nullptr &&
        SUCCEEDED(g_queue_result) && g_queue != nullptr && g_trace_okay;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID)
{
    if (reason != DLL_PROCESS_ATTACH)
        return TRUE;
    g_module = module;
    g_dll_entered = TRUE;
    record("original-dll-attach-entry");
    g_dll_returned = TRUE;
    record("original-dll-attach-return");
    return TRUE;
}
