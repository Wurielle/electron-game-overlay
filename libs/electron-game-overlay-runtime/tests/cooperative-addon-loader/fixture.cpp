#include <Windows.h>
#include <cstdint>
#include <cstdio>
#include <string>

namespace
{
HMODULE own_module = nullptr;

std::wstring module_parent(HMODULE module)
{
    wchar_t path[32768]{};
    const DWORD length = GetModuleFileNameW(module, path, ARRAYSIZE(path));
    if (length == 0 || length >= ARRAYSIZE(path)) return {};
    wchar_t *leaf = wcsrchr(path, L'\\');
    if (leaf == nullptr) return {};
    *leaf = L'\0';
    return path;
}
}

#if defined(FIXTURE_target)
int wmain(int argc, wchar_t **argv)
{
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return 1;
    const std::uint64_t instance = (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
    HANDLE mapping = nullptr;
    if (argc == 2 && wcscmp(argv[1], L"--pin-empty-claim") == 0)
    {
        const auto name = L"Local\\electron-game-overlay-host-v1-" +
            std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(instance);
        mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, 64, name.c_str());
        if (mapping == nullptr) return 2;
    }
    std::printf("{\"pid\":%lu,\"creationTime100ns\":\"%llu\"}\n", GetCurrentProcessId(), instance);
    std::fflush(stdout);
    Sleep(120000);
    if (mapping != nullptr) CloseHandle(mapping);
    return 0;
}
#else
#if defined(FIXTURE_member)
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi = 1;
extern "C" __declspec(dllexport) const char ElectronGameOverlayReShadeAddonBuildId[] = ADDON_BUILD_ID;
#ifndef _WIN64
#pragma comment(linker, "/EXPORT:ElectronGameOverlayInitializeMember=_ElectronGameOverlayInitializeMember@4")
#endif
extern "C" __declspec(dllexport) DWORD WINAPI ElectronGameOverlayInitializeMember(void *)
{
    const auto path = module_parent(own_module) + L"\\member.initialized";
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    const char content[] = "initialized from own module parent\n";
    DWORD written = 0;
    const BOOL result = WriteFile(file, content, sizeof(content) - 1, &written, nullptr);
    const DWORD error = result ? ERROR_SUCCESS : GetLastError();
    CloseHandle(file);
    return error;
}
#elif defined(FIXTURE_host)
extern "C" __declspec(dllexport) const char *ReShadeVersion = "6.7.3";
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeReadyV1 = 0;

static DWORD WINAPI initialize_first_member(void *)
{
    const auto directory = module_parent(own_module);
    SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE", directory.c_str());
#ifdef _WIN64
    const auto path = directory + L"\\electron_game_overlay.addon64";
#else
    const auto path = directory + L"\\electron_game_overlay.addon32";
#endif
    const HMODULE member = LoadLibraryW(path.c_str());
    if (member == nullptr) return GetLastError();
    using initialize = DWORD (WINAPI *)(void *);
    const auto function = reinterpret_cast<initialize>(GetProcAddress(member, "ElectronGameOverlayInitializeMember"));
    if (function == nullptr) return ERROR_PROC_NOT_FOUND;
    const DWORD error = function(nullptr);
    if (error == ERROR_SUCCESS) InterlockedExchange(&ElectronGameOverlayCooperativeReadyV1, 1);
    return error;
}
#endif

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        own_module = module;
#if defined(FIXTURE_host)
        const auto directory = module_parent(module);
        if (GetFileAttributesW((directory + L"\\hold-host-load.enabled").c_str()) != INVALID_FILE_ATTRIBUTES)
        {
            const HANDLE marker = CreateFileW((directory + L"\\host-load-entered").c_str(),
                GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (marker != INVALID_HANDLE_VALUE) CloseHandle(marker);
            // Deliberately hold only this owned inert target's DLL load. The
            // controller kills its injector, then verifies frozen ownership.
            Sleep(120000);
            return FALSE;
        }
        // This worker cannot run until the loader lock is released. The fixture
        // never waits for it in DllMain and never calls another DllMain itself.
        const HANDLE worker = CreateThread(nullptr, 0, initialize_first_member, nullptr, 0, nullptr);
        if (worker == nullptr) return FALSE;
        CloseHandle(worker);
#endif
    }
    return TRUE;
}
#endif
