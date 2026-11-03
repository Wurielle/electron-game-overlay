// Minimal second first-import DLL. No LoadLibrary, graphics calls, feature
// engine, scene, transport, foreign configuration, or ReShade source changes.
#include "restore.h"
#include "detours.h"
#include "../early-process-bootstrap/trace.hpp"

namespace
{
    EarlyReShadeRestoreStateV1 state = {};
    volatile LONG ready = 0;

    bool same_owned_directory(HMODULE self, HMODULE host) noexcept
    {
        wchar_t own_path[32768] = {}, host_path[32768] = {};
        DWORD own_length = GetModuleFileNameW(self, own_path, 32768);
        const DWORD host_length = GetModuleFileNameW(host, host_path, 32768);
        if (own_length == 0 || own_length >= 32768 || host_length == 0 || host_length >= 32768)
            return false;
        while (own_length != 0 && own_path[own_length - 1] != L'\\' && own_path[own_length - 1] != L'/')
            --own_length;
#ifdef _WIN64
        constexpr wchar_t host_leaf[] = L"ReShade64.dll";
#else
        constexpr wchar_t host_leaf[] = L"ReShade32.dll";
#endif
        if (own_length == 0 || own_length + ARRAYSIZE(host_leaf) > ARRAYSIZE(own_path)) return false;
        for (DWORD index = 0; index != ARRAYSIZE(host_leaf); ++index)
            own_path[own_length + index] = host_leaf[index];
        return _wcsicmp(own_path, host_path) == 0;
    }
}

extern "C" __declspec(dllexport) BOOL WINAPI
EarlyReShadeRestoreQueryV1(EarlyReShadeRestoreStateV1 *output)
{
    if (output == nullptr || output->struct_size != sizeof(state) || output->abi_version != 1 ||
        InterlockedCompareExchange(&ready, 0, 0) != 1)
        return FALSE;
    *output = state;
    return TRUE;
}

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID)
{
    if (DetourIsHelperProcess()) return FALSE; // A helper is never part of this proof.
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    if (!early_proof::trace(self, "restore-attach")) return FALSE;
#ifdef _WIN64
    HMODULE host = GetModuleHandleW(L"ReShade64.dll");
#else
    HMODULE host = GetModuleHandleW(L"ReShade32.dll");
#endif
    const auto host_abi = host == nullptr ? nullptr : reinterpret_cast<const unsigned int *>(
        GetProcAddress(host, "ElectronGameOverlayReShadeHostAbi"));
    if (host == nullptr || !same_owned_directory(self, host) ||
        host_abi == nullptr || *host_abi != 1 ||
        GetProcAddress(host, "ElectronGameOverlayReShadeAddonGate") == nullptr ||
        GetProcAddress(host, "ReShadeRegisterAddon") == nullptr ||
        GetProcAddress(host, "ReShadeCreateEffectRuntime") == nullptr ||
        GetProcAddress(host, MAKEINTRESOURCEA(1)) == nullptr)
    {
        early_proof::trace(self, "restore-owned-host-rejected", ERROR_INVALID_DATA);
        return FALSE;
    }
    if (!early_proof::trace(self, "restore-owned-reshade-present")) return FALSE;
    if (!DetourRestoreAfterWith())
    {
        early_proof::trace(self, "restore-imports-failed", ERROR_INVALID_DATA);
        return FALSE;
    }
    FILETIME creation = {}, exit = {}, kernel = {}, user = {};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return FALSE;
    state.struct_size = sizeof(state);
    state.abi_version = 1;
    state.process_id = GetCurrentProcessId();
    state.thread_id = GetCurrentThreadId();
    state.creation_time_100ns = (std::uint64_t(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
    state.restored_imports = 1;
    state.owned_host_present = 1;
    state.reshade_module = reinterpret_cast<std::uintptr_t>(host);
    if (!early_proof::trace(self, "restore-imports-complete")) return FALSE;
    InterlockedExchange(&ready, 1);
    return TRUE;
}
