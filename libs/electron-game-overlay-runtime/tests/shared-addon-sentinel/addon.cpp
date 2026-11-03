// Test-only ordinary ReShade add-on. It has no EGO ABI, transport or engine.
// The isolated controller-owned AddonPath receives an exact-process receipt.
#include <Windows.h>
#include <reshade.hpp>
#include <string>

#ifdef SHARED_ADDON_REJECT
extern "C" __declspec(dllexport) const char *NAME = "Shared directory rejected add-on fixture";
static constexpr wchar_t receipt_prefix[] = L"rejected-";
#else
extern "C" __declspec(dllexport) const char *NAME = "Shared directory ordinary add-on fixture";
static constexpr wchar_t receipt_prefix[] = L"sentinel-";
#endif

extern "C" __declspec(dllexport) bool AddonInit(HMODULE addon, HMODULE)
{
    if (!reshade::register_addon(addon)) return false;
    std::wstring module_path(32768, L'\0');
    const DWORD length = GetModuleFileNameW(addon, module_path.data(), static_cast<DWORD>(module_path.size()));
    if (length == 0 || length >= module_path.size()) { reshade::unregister_addon(addon); return false; }
    module_path.resize(length);
    const size_t separator = module_path.find_last_of(L"\\/");
    if (separator == std::wstring::npos) { reshade::unregister_addon(addon); return false; }
    const std::wstring receipt = module_path.substr(0, separator + 1) + receipt_prefix +
        std::to_wstring(GetCurrentProcessId()) + L".ready";
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user))
        { reshade::unregister_addon(addon); return false; }
    ULARGE_INTEGER creation{}; creation.LowPart = created.dwLowDateTime; creation.HighPart = created.dwHighDateTime;
    const std::string text = "EGO_ORDINARY_ADDON_RECEIPT_V1\npid=" + std::to_string(GetCurrentProcessId()) +
        "\ncreationFileTime=" + std::to_string(creation.QuadPart) + "\n";
    const HANDLE file = CreateFileW(receipt.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { reshade::unregister_addon(addon); return false; }
    DWORD written = 0;
    const bool saved = WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) && written == text.size();
    CloseHandle(file);
#ifdef SHARED_ADDON_REJECT
    (void)saved;
    reshade::unregister_addon(addon);
    return false; // Deliberately exercises an unrelated ordinary add-on failure.
#else
    if (!saved) reshade::unregister_addon(addon);
    return saved;
#endif
}

extern "C" __declspec(dllexport) void AddonUninit(HMODULE addon, HMODULE)
{
    reshade::unregister_addon(addon);
}

BOOL WINAPI DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
