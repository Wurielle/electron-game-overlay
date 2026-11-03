// Inert PE for the console path fixture. It does not register an add-on,
// initialize ReShade, create a route, start a worker or touch the filesystem.
#include <Windows.h>
#include <cstddef>
#include <cstdint>

namespace
{
struct initialize_request
{
    std::uint32_t struct_size;
    std::uint32_t abi_version;
    wchar_t run_directory[32768];
};
static_assert(sizeof(initialize_request) == 65544);
static_assert(alignof(initialize_request) == 4);
static_assert(offsetof(initialize_request, run_directory) == 8);

DWORD validate_request(void *opaque)
{
    if (opaque == nullptr)
        return ERROR_INVALID_PARAMETER;
    const auto &request = *static_cast<const initialize_request *>(opaque);
    if (request.struct_size != sizeof(request) || request.abi_version != 1)
        return ERROR_INVALID_PARAMETER;
    std::size_t length = 0;
    while (length != 32768 && request.run_directory[length] != L'\0')
        ++length;
    if (length == 0 || length == 32768)
        return ERROR_INVALID_PARAMETER;
    const wchar_t drive = request.run_directory[0];
    if (length < 3 || !((drive >= L'A' && drive <= L'Z') ||
        (drive >= L'a' && drive <= L'z')) ||
        request.run_directory[1] != L':' || request.run_directory[2] != L'\\')
        return ERROR_BAD_PATHNAME;
    return ERROR_SUCCESS;
}
}

extern "C" __declspec(dllexport) const unsigned int
    ElectronGameOverlayReShadeAddonAbi = 1;
extern "C" __declspec(dllexport) const char
    ElectronGameOverlayReShadeAddonBuildId[] = "CCE20935ADD44EF6A5A7973014B2E07F";
extern "C" __declspec(dllexport) const char *NAME =
    "Electron Game Overlay Runtime "
    "ego-preload-0123456789abcdef0123456789abcdef-"
    "CCE20935ADD44EF6A5A7973014B2E07F-0123456789abcdef.addon64";

extern "C" __declspec(dllexport) DWORD
ElectronGameOverlayActivatePreloadedMemberV1(void *request)
{
    return validate_request(request);
}

extern "C" __declspec(dllexport) DWORD
ElectronGameOverlayCanUnloadFailedMemberV1()
{
    return 1;
}

BOOL WINAPI DllMain(HMODULE, DWORD, LPVOID)
{
    return TRUE;
}
