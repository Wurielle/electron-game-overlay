#include <Windows.h>
#include <Psapi.h>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>

namespace
{
HMODULE own_module = nullptr;
#ifdef _WIN64
constexpr wchar_t runtime_leaf[] = L"ReShade64.dll";
constexpr wchar_t member_leaf[] = L"electron_game_overlay.addon64";
#else
constexpr wchar_t runtime_leaf[] = L"ReShade32.dll";
constexpr wchar_t member_leaf[] = L"electron_game_overlay.addon32";
#endif

std::wstring module_parent(HMODULE module)
{
    wchar_t path[32768] = {};
    const DWORD length = GetModuleFileNameW(module, path, ARRAYSIZE(path));
    if (length == 0 || length >= ARRAYSIZE(path)) return {};
    wchar_t *const leaf = wcsrchr(path, L'\\');
    if (leaf == nullptr) return {};
    *leaf = L'\0';
    return path;
}

DWORD write_record(const std::wstring &path, const std::string &content)
{
    const HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD written = 0;
    const BOOL ok = WriteFile(file, content.data(), static_cast<DWORD>(content.size()), &written, nullptr);
    const DWORD error = ok && written == content.size() ? ERROR_SUCCESS : ok ? ERROR_WRITE_FAULT : GetLastError();
    CloseHandle(file);
    return error;
}

bool enabled(const wchar_t *name)
{
    return GetFileAttributesW((module_parent(own_module) + L"\\" + name).c_str()) != INVALID_FILE_ATTRIBUTES;
}

volatile LONG *host_gate()
{
    const HMODULE host = GetModuleHandleW(runtime_leaf);
    return host == nullptr ? nullptr : reinterpret_cast<volatile LONG *>(
        GetProcAddress(host, "ElectronGameOverlayReShadeAddonGate"));
}
}

#if defined(FIXTURE_target)
int wmain(int argc, wchar_t **argv)
{
    if (argc != 1 && argc != 4) return ERROR_INVALID_PARAMETER;
    if (argc == 4)
    {
        if (wcscmp(argv[1], L"--preload") != 0) return ERROR_INVALID_PARAMETER;
        const std::wstring directory = argv[2];
        const std::wstring mode = argv[3];
        if (!SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE", directory.c_str())) return GetLastError();
        const HMODULE host = LoadLibraryW((directory + L"\\" + runtime_leaf).c_str());
        if (host == nullptr) return GetLastError();
        if (mode != L"foreign" && mode != L"malformed")
        {
            auto *const gate = reinterpret_cast<volatile LONG *>(GetProcAddress(host, "ElectronGameOverlayReShadeAddonGate"));
            if (gate == nullptr) return ERROR_PROC_NOT_FOUND;
            InterlockedExchange(gate, 1);
            const HMODULE member = LoadLibraryW((directory + L"\\" + member_leaf).c_str());
            if (member == nullptr) return GetLastError();
            if (mode == L"registered") InterlockedExchange(gate, 2);
            else if (mode == L"closed-ready" || mode == L"closed-unready") InterlockedExchange(gate, 3);
            else return ERROR_INVALID_PARAMETER;
        }
    }
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return GetLastError();
    const std::uint64_t instance = (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
    std::printf("{\"pid\":%lu,\"creationTime100ns\":\"%llu\"}\n", GetCurrentProcessId(), instance);
    std::fflush(stdout);
    Sleep(120000);
    return ERROR_SUCCESS;
}
#elif defined(FIXTURE_member)
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi = 1;
extern "C" __declspec(dllexport) const char ElectronGameOverlayReShadeAddonBuildId[] = ADDON_BUILD_ID;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeReadyV1 = 0;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeAdapterReadyV1 = 0;
#ifndef _WIN64
#pragma comment(linker, "/EXPORT:ElectronGameOverlayInitializeMember=_ElectronGameOverlayInitializeMember@4")
#endif
extern "C" __declspec(dllexport) DWORD WINAPI ElectronGameOverlayInitializeMember(void *request)
{
    if (request != nullptr) return ERROR_INVALID_PARAMETER;
    const DWORD error = write_record(module_parent(own_module) + L"\\member.initialized.json",
        "{\"schemaVersion\":1,\"requestWasNull\":true}\n");
    if (error == ERROR_SUCCESS) InterlockedExchange(&ElectronGameOverlayCooperativeReadyV1, 1);
    return error;
}

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        own_module = module;
        auto *const gate = host_gate();
        const LONG value = gate == nullptr ? -1 : InterlockedCompareExchange(gate, 0, 0);
        const DWORD error = write_record(module_parent(module) + L"\\member.loaded.json",
            "{\"schemaVersion\":1,\"gateAtDllMain\":" + std::to_string(value) + "}\n");
        if (error != ERROR_SUCCESS) return FALSE;
        // This inert fixture models completed public callback registration;
        // it does not touch a real ReShade callback vector.
        if (value == 1 && !enabled(L"suppress-adapter-ready.enabled"))
            InterlockedExchange(&ElectronGameOverlayCooperativeAdapterReadyV1, 1);
    }
    return TRUE;
}
#else
extern "C" __declspec(dllexport) const char *ReShadeVersion = "6.7.3";
#if defined(FIXTURE_foreign_host)
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeReadyV1 = 1;
#else
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeHostAbi = 1;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayReShadeAddonGate = 0;
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayOwnedLateD3D11AbiV1 =
#if defined(FIXTURE_malformed_host)
    2;
#else
    1;
#endif
#endif

static volatile LONG bootstrap_calls = 0;
#ifndef _WIN64
#pragma comment(linker, "/EXPORT:ElectronGameOverlayInitializeOwnedLateD3D11V1=_ElectronGameOverlayInitializeOwnedLateD3D11V1@4")
#endif
extern "C" __declspec(dllexport) DWORD WINAPI ElectronGameOverlayInitializeOwnedLateD3D11V1(void *request)
{
    const LONG calls = InterlockedIncrement(&bootstrap_calls);
    auto *const gate = host_gate();
    const LONG before = gate == nullptr ? -1 : InterlockedCompareExchange(gate, 0, 0);
    unsigned int initialized = 0;
    HMODULE modules[1024] = {};
    DWORD bytes = 0;
    if (!K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &bytes) || bytes > sizeof(modules))
        return ERROR_INSUFFICIENT_BUFFER;
    for (DWORD i = 0; i != bytes / sizeof(HMODULE); ++i)
    {
        if (GetProcAddress(modules[i], "ElectronGameOverlayReShadeAddonAbi") == nullptr) continue;
        auto *const ready = reinterpret_cast<volatile LONG *>(GetProcAddress(modules[i], "ElectronGameOverlayCooperativeReadyV1"));
        if (ready != nullptr && InterlockedCompareExchange(ready, 0, 0) == 1) ++initialized;
    }
    const bool fail = enabled(L"bootstrap-failure.enabled");
    const DWORD record = write_record(module_parent(own_module) + L"\\bootstrap.called.json",
        "{\"schemaVersion\":1,\"requestWasNull\":" + std::string(request == nullptr ? "true" : "false") +
        ",\"calls\":" + std::to_string(calls) + ",\"gateAtEntry\":" + std::to_string(before) +
        ",\"initializedMembers\":" + std::to_string(initialized) + ",\"explicitFailure\":" + (fail ? "true" : "false") + "}\n");
    if (record != ERROR_SUCCESS) return record;
#if defined(FIXTURE_foreign_host)
    return ERROR_ACCESS_DENIED; // A trap: the injector must never call this export without the owned capability.
#else
    if (request != nullptr || (before != 2 && before != 3) || initialized == 0) return ERROR_INVALID_STATE;
    InterlockedExchange(gate, 3); // Models retained manager completion, not graphics initialization.
    return fail ? ERROR_NOT_SUPPORTED : ERROR_SUCCESS;
#endif
}

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        own_module = module;
        return write_record(module_parent(module) + L"\\host.loaded.json", "{\"schemaVersion\":1}\n") == ERROR_SUCCESS;
    }
    return TRUE;
}
#endif
