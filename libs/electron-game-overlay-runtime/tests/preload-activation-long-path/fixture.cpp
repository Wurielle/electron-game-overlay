// Isolated local loader/enumeration probe. No production entrypoint, runtime,
// graphics, external process inspection, injection or remote memory writes.
#include <Windows.h>
#include <TlHelp32.h>
#include <Psapi.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct handle
{
    HANDLE value = INVALID_HANDLE_VALUE;
    ~handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
};
// These scoped API seams exercise the exact extracted candidate's bounded
// enumeration and reference-acquisition error paths. Telemetry below calls the
// actual Windows APIs after the macros are undefined.
static int selector_scenario = 0;
static unsigned selector_enumeration_calls = 0;
static BOOL WINAPI fixture_enumerate(HANDLE process, HMODULE *modules, DWORD capacity, LPDWORD needed)
{
    ++selector_enumeration_calls;
    if (selector_scenario == 1) { SetLastError(ERROR_PARTIAL_COPY); return FALSE; }
    if (selector_scenario == 2 && selector_enumeration_calls == 1) { *needed = 256 * sizeof(HMODULE); return TRUE; }
    if (selector_scenario == 3) { *needed = capacity + sizeof(HMODULE); return TRUE; }
    if (selector_scenario == 4) { *needed = 65537 * sizeof(HMODULE); return TRUE; }
    if (selector_scenario == 5) { *needed = sizeof(HMODULE) + 1; return TRUE; }
    if (selector_scenario == 6) { *needed = 0; return TRUE; }
    return K32EnumProcessModules(process, modules, capacity, needed);
}
static BOOL WINAPI fixture_reference(DWORD flags, LPCWSTR address, HMODULE *module)
{
    if (selector_scenario == 7) { SetLastError(ERROR_INVALID_HANDLE); return FALSE; }
    return GetModuleHandleExW(flags, address, module);
}
#define K32EnumProcessModules fixture_enumerate
#define GetModuleHandleExW fixture_reference
#include "exact-readiness.hpp"
#undef GetModuleHandleExW
#undef K32EnumProcessModules

namespace fs = std::filesystem;
namespace
{
#ifdef _WIN64
constexpr char architecture[] = "x64";
constexpr wchar_t leaf[] = L"ego-preload-0123456789abcdef0123456789abcdef-CCE20935ADD44EF6A5A7973014B2E07F-0123456789abcdef.addon64";
#else
constexpr char architecture[] = "x86";
constexpr wchar_t leaf[] = L"ego-preload-0123456789abcdef0123456789abcdef-CCE20935ADD44EF6A5A7973014B2E07F-0123456789abcdef.addon32";
#endif
void require(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
std::wstring extended(const fs::path &path)
{
    const std::wstring value = path.wstring();
    if (value.rfind(L"\\\\?\\", 0) == 0) return value;
    if (value.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + value.substr(2);
    return L"\\\\?\\" + value;
}
std::string utf8(const std::wstring &value)
{
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    require(size >= 0, "UTF8 size failure");
    std::string result(static_cast<std::size_t>(size), '\0');
    if (size) require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) == size, "UTF8 conversion failed");
    return result;
}
std::string quoted(const std::wstring &value)
{
    std::string result = "\"";
    for (const char c : utf8(value))
    {
        if (c == '\\' || c == '"') result += '\\';
        require(static_cast<unsigned char>(c) >= 32, "Control character in JSON string");
        result += c;
    }
    return result + '"';
}
fs::path allowed(const fs::path &candidate)
{
    const fs::path absolute = fs::absolute(candidate).lexically_normal();
    const std::wstring root = fs::canonical(EGO_ALLOWED_TEST_ROOT).wstring();
    const std::wstring value = absolute.wstring();
    require(value.size() > root.size() && value[root.size()] == L'\\' && _wcsnicmp(value.c_str(), root.c_str(), root.size()) == 0, "Probe output must be beneath this SDK's build directory");
    return absolute;
}
struct observation
{
    bool exact_ready = false, direct_adapter_ready = false, direct_cooperative_ready = false;
    bool toolhelp_found = false, k32_found = false, address_reference = false;
    DWORD toolhelp_first_error = 0, toolhelp_end_error = 0, toolhelp_count = 0, k32_error = 0, k32_count = 0;
    std::wstring toolhelp_path, module_path;
};
observation observe(HMODULE selected)
{
    observation result;
    result.exact_ready = cooperative_adapter_ready();
    result.direct_adapter_ready = ready_word(selected, "ElectronGameOverlayCooperativeAdapterReadyV1");
    result.direct_cooperative_ready = ready_word(selected, "ElectronGameOverlayCooperativeReadyV1");
    HMODULE retained = nullptr;
    result.address_reference = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, reinterpret_cast<LPCWSTR>(selected), &retained) != FALSE && retained == selected;
    if (retained != nullptr) FreeLibrary(retained);
    handle snapshot;
    snapshot.value = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, GetCurrentProcessId());
    if (snapshot.value == INVALID_HANDLE_VALUE) result.toolhelp_first_error = GetLastError();
    else
    {
        MODULEENTRY32W entry = {};
        entry.dwSize = sizeof(entry);
        if (!Module32FirstW(snapshot.value, &entry)) result.toolhelp_first_error = GetLastError();
        else
        {
            do
            {
                ++result.toolhelp_count;
                if (reinterpret_cast<HMODULE>(entry.modBaseAddr) == selected)
                {
                    result.toolhelp_found = true;
                    result.toolhelp_path.assign(entry.szExePath, wcsnlen_s(entry.szExePath, std::size(entry.szExePath)));
                }
            } while (Module32NextW(snapshot.value, &entry));
            result.toolhelp_end_error = GetLastError();
        }
    }
    std::vector<HMODULE> modules(128);
    DWORD needed = 0;
    if (!K32EnumProcessModules(GetCurrentProcess(), modules.data(), static_cast<DWORD>(modules.size() * sizeof(HMODULE)), &needed)) result.k32_error = GetLastError();
    else
    {
        result.k32_count = needed / sizeof(HMODULE);
        if (needed > modules.size() * sizeof(HMODULE))
        {
            modules.resize(result.k32_count);
            require(K32EnumProcessModules(GetCurrentProcess(), modules.data(), needed, &needed) != FALSE, "K32 repeat enumeration failed");
        }
        for (DWORD index = 0; index < result.k32_count; ++index) if (modules[index] == selected) result.k32_found = true;
    }
    std::wstring name(32768, L'\0');
    const DWORD length = GetModuleFileNameW(selected, name.data(), static_cast<DWORD>(name.size()));
    require(length != 0 && length < name.size(), "GetModuleFileNameW failed");
    name.resize(length); result.module_path = std::move(name);
    return result;
}
int child(const fs::path &module_path, const std::wstring &variant, LONG state, int scenario)
{
    const std::wstring load_path = extended(module_path);
    HMODULE module = LoadLibraryW(load_path.c_str());
    const DWORD load_error = module == nullptr ? GetLastError() : 0;
    require(module != nullptr, "Inert module load failed");
    auto *adapter = reinterpret_cast<volatile LONG *>(GetProcAddress(module, "ElectronGameOverlayCooperativeAdapterReadyV1"));
    auto *cooperative = reinterpret_cast<volatile LONG *>(GetProcAddress(module, "ElectronGameOverlayCooperativeReadyV1"));
    const auto *abi = reinterpret_cast<const unsigned int *>(GetProcAddress(module, "ElectronGameOverlayReShadeAddonAbi"));
    require(cooperative != nullptr, "Inert cooperative readiness export missing");
    const bool legacy = variant == L"legacy";
    require(legacy ? adapter == nullptr : adapter != nullptr, "Inert adapter export variant wrong");
    require(variant == L"unrelated" ? abi == nullptr : abi != nullptr && *abi == (variant == L"invalid" ? 2u : 1u), "Inert addon ABI export variant wrong");
    if (adapter != nullptr) InterlockedExchange(adapter, state == 3 ? 1 : state);
    InterlockedExchange(cooperative, legacy ? state : state == 3 ? 0 : 1);
    selector_scenario = scenario;
    const observation value = observe(module);
    const bool expected_ready = (variant == L"member" ? state == 1 || state == 3 : legacy && state == 1) &&
        (scenario == 0 || scenario == 2);
    std::cout << "{\"canonicalPath\":" << quoted(module_path.wstring()) << ",\"canonicalLength\":" << module_path.wstring().size()
        << ",\"variant\":" << quoted(variant) << ",\"state\":" << state << ",\"scenario\":" << scenario
        << ",\"selectorEnumerationCalls\":" << selector_enumeration_calls << ",\"expectedReady\":" << (expected_ready ? "true" : "false")
        << ",\"semanticPass\":" << (value.exact_ready == expected_ready ? "true" : "false") << ",\"loadError\":" << load_error << ",\"moduleLoaded\":true"
        << ",\"exactReady\":" << (value.exact_ready ? "true" : "false")
        << ",\"directAdapterReady\":" << (value.direct_adapter_ready ? "true" : "false")
        << ",\"directCooperativeReady\":" << (value.direct_cooperative_ready ? "true" : "false")
        << ",\"toolhelpFound\":" << (value.toolhelp_found ? "true" : "false")
        << ",\"toolhelpCount\":" << value.toolhelp_count << ",\"toolhelpFirstError\":" << value.toolhelp_first_error << ",\"toolhelpEndError\":" << value.toolhelp_end_error
        << ",\"toolhelpPath\":" << quoted(value.toolhelp_path) << ",\"k32Found\":" << (value.k32_found ? "true" : "false")
        << ",\"k32Count\":" << value.k32_count << ",\"k32Error\":" << value.k32_error
        << ",\"addressReference\":" << (value.address_reference ? "true" : "false") << ",\"modulePath\":" << quoted(value.module_path)
        << ",\"explicitRemoteMutationCalls\":0}";
    FreeLibrary(module);
    return 0;
}
std::string read_all(const fs::path &path)
{
    std::ifstream stream(path, std::ios::binary);
    require(stream.is_open(), "Could not read owned child evidence");
    std::ostringstream text; text << stream.rdbuf(); return text.str();
}
std::string run_child(const fs::path &self, const fs::path &module, const fs::path &output, const std::wstring &variant, LONG state, int scenario)
{
    SECURITY_ATTRIBUTES security = { sizeof(security), nullptr, TRUE };
    handle file;
    file.value = CreateFileW(output.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &security, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(file.value != INVALID_HANDLE_VALUE, "Could not create owned child evidence");
    STARTUPINFOW startup = {}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = nullptr; startup.hStdOutput = file.value; startup.hStdError = file.value;
    PROCESS_INFORMATION process = {};
    std::wstring command = L"\"" + self.wstring() + L"\" --child \"" + module.wstring() + L"\" " + variant + L" " + std::to_wstring(state) + L" " + std::to_wstring(scenario);
    require(CreateProcessW(self.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process) != FALSE, "Could not start fresh owned console child");
    handle owned_process; owned_process.value = process.hProcess;
    handle owned_thread; owned_thread.value = process.hThread;
    const DWORD wait = WaitForSingleObject(process.hProcess, 15000);
    if (wait != WAIT_OBJECT_0) { TerminateProcess(process.hProcess, ERROR_TIMEOUT); WaitForSingleObject(process.hProcess, 5000); throw std::runtime_error("Owned fixture child timed out"); }
    DWORD exit = 0; require(GetExitCodeProcess(process.hProcess, &exit) != FALSE, "Could not query child status");
    CloseHandle(file.value); file.value = INVALID_HANDLE_VALUE;
    require(exit == 0, "Owned child failed; retain its evidence output");
    return read_all(output);
}
}
int wmain(int argc, wchar_t **argv)
{
    try
    {
        if (argc == 6 && std::wstring(argv[1]) == L"--child") return child(allowed(argv[2]), argv[3], std::stol(argv[4]), std::stoi(argv[5]));
        require(argc == 5 && std::wstring(argv[1]) == L"--root" && std::wstring(argv[3]) == L"--member", "Usage: --root <fresh-owned-build-directory> --member <inert-member.dll>");
        const fs::path root = allowed(argv[2]);
        require(!fs::exists(root), "Probe root must be fresh");
        const fs::path member = allowed(argv[4]);
        require(fs::is_regular_file(member), "Missing inert member DLL");
        fs::create_directory(root);
        std::wstring executable(32768, L'\0');
        const DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
        require(length != 0 && length < executable.size(), "Could not locate fixture executable"); executable.resize(length);
        std::vector<std::string> cases;
        for (const std::wstring variant : { L"member", L"legacy", L"invalid", L"unrelated" })
        for (const std::size_t path_length : { 233u, 259u, 260u, 289u, 293u, 320u })
        {
            fs::path directory = root / variant;
            const std::size_t overhead = directory.wstring().size() + 1 + 1 + std::size(leaf) - 1;
            require(path_length > overhead, "Owned probe root is too long for controls");
            std::size_t padding = path_length - overhead;
            while (padding > 180) { directory /= std::wstring(100, L'x'); padding -= 101; }
            directory /= std::wstring(padding, L'x');
            require((directory / leaf).wstring().size() == path_length, "Path length construction error");
            fs::create_directories(fs::path(extended(directory)));
            const fs::path module = directory / leaf;
            const fs::path variant_member = variant == L"member" ? member : member.parent_path() / (L"preload_activation_member_" + variant + L".dll");
            fs::copy_file(fs::path(extended(variant_member)), fs::path(extended(module)), fs::copy_options::none);
            const std::vector<LONG> states = variant == L"member" ? std::vector<LONG>{0, 1, 2, 3} : variant == L"legacy" ? std::vector<LONG>{0, 1, 2} : std::vector<LONG>{1};
            for (const LONG state : states)
            {
                const fs::path output = root / (L"child-" + variant + L"-" + std::to_wstring(path_length) + L"-" + std::to_wstring(state) + L".json");
                cases.push_back(run_child(executable, module, output, variant, state, 0));
            }
            if (EGO_SELECTOR_USES_K32 && variant == L"member" && path_length == 293)
            {
                for (int scenario = 1; scenario <= 7; ++scenario)
                {
                    const fs::path output = root / (L"child-scenario-" + std::to_wstring(scenario) + L".json");
                    cases.push_back(run_child(executable, module, output, variant, 1, scenario));
                }
            }
        }
        std::ofstream report(root / L"report.json", std::ios::binary);
        report << "{\"schemaVersion\":1,\"status\":\"probe-completed\",\"architecture\":\"" << architecture << "\",\"pointerBytes\":" << sizeof(void *) << ",\"scope\":\"Exact owned-host readiness selector with inert DLL and fresh longPathAware=false local console children; no ReShade, graphics or injection\",\"sourceRawSha256\":\"" << EGO_SOURCE_RAW_SHA << "\",\"sourceNormalizedSha256\":\"" << EGO_SOURCE_NORMALIZED_SHA << "\",\"cases\":[";
        for (std::size_t index = 0; index < cases.size(); ++index) { if (index) report << ','; report << cases[index]; }
        report << "],\"explicitRemoteMutationCalls\":0}\n";
        report.close();
        std::cout << "PROBE_COMPLETED children=" << cases.size() << " report=" << utf8((root / L"report.json").wstring()) << '\n';
        return 0;
    }
    catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
