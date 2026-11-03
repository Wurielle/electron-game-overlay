#include <Windows.h>
#include <cstdint>
#include <cwchar>
#include <cstring>

namespace {
struct initialize_v1 {
    std::uint32_t struct_size;
    std::uint32_t abi_version;
    wchar_t run_directory[32768];
};
static_assert(sizeof(initialize_v1) == 65544 && alignof(initialize_v1) == 4);
char unique_name[160] = {};
wchar_t mode[32] = {};
}

extern "C" __declspec(dllexport) const char *NAME = "Electron Game Overlay Runtime";
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi = 1;
extern "C" __declspec(dllexport) const char ElectronGameOverlayReShadeAddonBuildId[] = ADDON_BUILD_ID;
extern "C" __declspec(dllexport) volatile LONG FixtureActivationCount = 0;
extern "C" __declspec(dllexport) volatile LONG FixtureRouteAccepted = 0;
extern "C" __declspec(dllexport) volatile LONG FixtureDllMainCompleted = 0;
extern "C" __declspec(dllexport) volatile LONG FixtureLoadLibraryCalls = 0;
extern "C" __declspec(dllexport) volatile LONG FixtureFreeLibraryCalls = 0;
#if defined(_M_IX86)
#pragma comment(linker, "/EXPORT:ElectronGameOverlayActivatePreloadedMemberV1=_ElectronGameOverlayActivatePreloadedMemberV1@4")
#pragma comment(linker, "/EXPORT:FixtureLoadLibraryTrap=_FixtureLoadLibraryTrap@4")
#pragma comment(linker, "/EXPORT:FixtureFreeLibraryTrap=_FixtureFreeLibraryTrap@4")
#endif
extern "C" __declspec(dllexport) HMODULE WINAPI FixtureLoadLibraryTrap(const wchar_t *)
{
    InterlockedIncrement(&FixtureLoadLibraryCalls);
    SetLastError(ERROR_INVALID_FUNCTION);
    return nullptr;
}
extern "C" __declspec(dllexport) BOOL WINAPI FixtureFreeLibraryTrap(HMODULE)
{
    InterlockedIncrement(&FixtureFreeLibraryCalls);
    return TRUE;
}
extern "C" __declspec(dllexport) DWORD WINAPI ElectronGameOverlayActivatePreloadedMemberV1(void *opaque)
{
    InterlockedIncrement(&FixtureActivationCount);
    if (opaque == nullptr) return ERROR_INVALID_PARAMETER;
    const auto &request = *static_cast<const initialize_v1 *>(opaque);
    if (request.struct_size != sizeof(request) || request.abi_version != 1 ||
        wcsnlen_s(request.run_directory, 32768) == 32768) return ERROR_INVALID_PARAMETER;
    wchar_t expected[32768] = {};
    const DWORD length = GetEnvironmentVariableW(L"EGO_RACE_EXPECTED_ROUTE", expected, ARRAYSIZE(expected));
    if (length == 0 || length >= ARRAYSIZE(expected) ||
        CompareStringOrdinal(expected, -1, request.run_directory, -1, FALSE) != CSTR_EQUAL)
        return ERROR_INVALID_NAME;
    InterlockedExchange(&FixtureRouteAccepted, 1);
    if (wcscmp(mode, L"assigned") == 0) return ERROR_ALREADY_ASSIGNED;
    if (wcscmp(mode, L"denied") == 0) return ERROR_ACCESS_DENIED;
    return ERROR_SUCCESS;
}

BOOL WINAPI DllMain(HMODULE module, DWORD reason, void *)
{
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(module);
    wchar_t entered_name[160] = {}, release_name[160] = {}, path[32768] = {};
    if (GetEnvironmentVariableW(L"EGO_RACE_ENTERED_EVENT", entered_name, ARRAYSIZE(entered_name)) == 0 ||
        GetEnvironmentVariableW(L"EGO_RACE_RELEASE_EVENT", release_name, ARRAYSIZE(release_name)) == 0 ||
        GetEnvironmentVariableW(L"EGO_RACE_MODE", mode, ARRAYSIZE(mode)) == 0)
        return FALSE;
    HANDLE entered = OpenEventW(EVENT_MODIFY_STATE, FALSE, entered_name);
    HANDLE release = OpenEventW(SYNCHRONIZE, FALSE, release_name);
    if (entered == nullptr || release == nullptr) return FALSE;
    SetEvent(entered);
    const DWORD wait = WaitForSingleObject(release, 10000);
    CloseHandle(entered);
    CloseHandle(release);
    if (wait != WAIT_OBJECT_0) return FALSE;
    if (wcscmp(mode, L"wrong-name") != 0)
    {
        const DWORD length = GetModuleFileNameW(module, path, ARRAYSIZE(path));
        const wchar_t *leaf = wcsrchr(path, L'\\');
        if (length == 0 || length >= ARRAYSIZE(path) || leaf == nullptr) return FALSE;
        strcpy_s(unique_name, "Electron Game Overlay Runtime ");
        std::size_t at = strlen(unique_name);
        for (++leaf; *leaf != L'\0'; ++leaf)
        {
            if (*leaf > 127 || at + 1 >= ARRAYSIZE(unique_name)) return FALSE;
            unique_name[at++] = static_cast<char>(*leaf);
        }
        unique_name[at] = '\0';
        NAME = unique_name;
    }
    InterlockedExchange(&FixtureDllMainCompleted, 1);
    return TRUE;
}
