// Isolated first-import ordering proof. Does not load or initialize ReShade.
// Transaction pattern follows the official Microsoft Detours simple sample.
#include <windows.h>
#include <d3d12.h>
#include "detours.h"
#include "trace.hpp"

namespace
{
    HMODULE module_handle = nullptr;
    volatile LONG ready = 0;
    volatile LONG calls = 0;
    decltype(&D3D12CreateDevice) real_create_device = D3D12CreateDevice;

    HRESULT WINAPI observed_create_device(IUnknown *adapter, D3D_FEATURE_LEVEL minimum,
        REFIID iid, void **device)
    {
        const LONG count = InterlockedIncrement(&calls);
        if (!early_proof::trace(module_handle, "bootstrap-create-device-enter", 0, count))
            return E_FAIL;
        const HRESULT result = real_create_device(adapter, minimum, iid, device);
        if (!early_proof::trace(module_handle, "bootstrap-create-device-return", result, count))
            return E_FAIL;
        return result;
    }
}

extern "C" __declspec(dllexport) BOOL WINAPI EarlyBootstrapReadyV1()
{
    return InterlockedCompareExchange(&ready, 0, 0) == 1;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved)
{
    if (DetourIsHelperProcess()) return TRUE;
    if (reason == DLL_PROCESS_ATTACH)
    {
        module_handle = module;
        if (!early_proof::trace(module, "bootstrap-attach")) return FALSE;
        if (!DetourRestoreAfterWith())
        {
            early_proof::trace(module, "bootstrap-restore-failed", ERROR_INVALID_DATA);
            return FALSE;
        }
        LONG result = DetourTransactionBegin();
        if (result == NO_ERROR) result = DetourUpdateThread(GetCurrentThread());
        if (result == NO_ERROR) result = DetourAttach(
            reinterpret_cast<PVOID *>(&real_create_device),
            reinterpret_cast<PVOID>(observed_create_device));
        if (result == NO_ERROR) result = DetourTransactionCommit();
        else DetourTransactionAbort();
        if (result != NO_ERROR)
        {
            early_proof::trace(module, "bootstrap-hook-failed", result);
            return FALSE;
        }
        InterlockedExchange(&ready, 1);
        if (!early_proof::trace(module, "bootstrap-ready")) return FALSE;
    }
    else if (reason == DLL_PROCESS_DETACH && reserved == nullptr &&
        InterlockedExchange(&ready, 0) == 1)
    {
        // The fixture never explicitly unloads this imported DLL. Keep the
        // standard sample's detach behavior for an unexpected explicit unload.
        LONG result = DetourTransactionBegin();
        if (result == NO_ERROR) result = DetourUpdateThread(GetCurrentThread());
        if (result == NO_ERROR) result = DetourDetach(
            reinterpret_cast<PVOID *>(&real_create_device),
            reinterpret_cast<PVOID>(observed_create_device));
        if (result == NO_ERROR) DetourTransactionCommit();
        else DetourTransactionAbort();
    }
    return TRUE;
}
