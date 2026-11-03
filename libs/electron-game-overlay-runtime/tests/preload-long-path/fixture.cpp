// Local loader/API seam only. The production injector entry point is renamed
// and never invoked; no ReShade, actual EGO add-on or remote mutation is used.
#include <Windows.h>
#include <Psapi.h>
#include <cstdint>
#include <cstring>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

static volatile LONG forbidden_mutations = 0;
static LPVOID WINAPI forbidden_virtual_alloc(HANDLE, LPVOID, SIZE_T, DWORD, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return nullptr; }
static BOOL WINAPI forbidden_virtual_free(HANDLE, LPVOID, SIZE_T, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
static BOOL WINAPI forbidden_write(HANDLE, LPVOID, LPCVOID, SIZE_T, SIZE_T *)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
static HANDLE WINAPI forbidden_remote_thread(HANDLE, LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return nullptr; }
static BOOL WINAPI forbidden_duplicate(HANDLE, HANDLE, HANDLE, LPHANDLE, DWORD, BOOL, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }

#define VirtualAllocEx forbidden_virtual_alloc
#define VirtualFreeEx forbidden_virtual_free
#define WriteProcessMemory forbidden_write
#define CreateRemoteThread forbidden_remote_thread
#define DuplicateHandle forbidden_duplicate
#define wmain ego_unused_production_injector_entry
#include EGO_INJECTOR_SOURCE
#undef wmain
#undef DuplicateHandle
#undef CreateRemoteThread
#undef WriteProcessMemory
#undef VirtualFreeEx
#undef VirtualAllocEx

namespace
{
constexpr wchar_t leaf[] = L"ego-preload-0123456789abcdef0123456789abcdef-CCE20935ADD44EF6A5A7973014B2E07F-0123456789abcdef.addon64";
constexpr char build[] = "CCE20935ADD44EF6A5A7973014B2E07F";
constexpr char public_name[] = "Electron Game Overlay Runtime ego-preload-0123456789abcdef0123456789abcdef-CCE20935ADD44EF6A5A7973014B2E07F-0123456789abcdef.addon64";

void require(bool value, const char *message)
{ if (!value) throw std::runtime_error(message); }

std::wstring full(const std::wstring &input)
{
    DWORD error = ERROR_SUCCESS;
    std::wstring result;
    require(get_full_path(input, result, error), "Could not canonicalize fixture path");
    return result;
}
bool within(const std::wstring &parent, const std::wstring &file)
{
    return file.size() > parent.size() && file[parent.size()] == L'\\' &&
        CompareStringOrdinal(parent.c_str(), static_cast<int>(parent.size()),
            file.c_str(), static_cast<int>(parent.size()), TRUE) == CSTR_EQUAL;
}
std::wstring checked_build_path(const std::wstring &path)
{
    const auto result = full(path);
    require(within(full(EGO_ALLOWED_TEST_ROOT), result), "Fixture path must stay inside the SDK build directory");
    return result;
}
std::wstring extended(const std::wstring &path)
{ return make_extended_length_path(path); }
std::string utf8(const std::wstring &text)
{
    if (text.empty()) return {};
    const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
        text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    require(length > 0, "UTF-8 encoding failed");
    std::string result(static_cast<std::size_t>(length), '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
        static_cast<int>(text.size()), result.data(), length, nullptr, nullptr) == length,
        "UTF-8 encoding changed");
    return result;
}
std::string json_quote(const std::wstring &value)
{
    std::string result = "\"";
    for (const unsigned char c : utf8(value)) {
        if (c == '\\' || c == '"') { result += '\\'; result += static_cast<char>(c); }
        else if (c < 0x20) {
            constexpr char digits[] = "0123456789abcdef";
            result += "\\u00"; result += digits[c >> 4]; result += digits[c & 15];
        } else result += static_cast<char>(c);
    }
    return result + '"';
}
void write(const std::wstring &file, const std::string &bytes)
{
    checked_build_path(file);
    std::ofstream output(std::filesystem::path(file), std::ios::binary | std::ios::trunc);
    require(static_cast<bool>(output), "Could not open result file");
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    require(static_cast<bool>(output), "Could not write result file");
}
std::string read(const std::wstring &file)
{
    std::ifstream input(std::filesystem::path(file), std::ios::binary);
    require(static_cast<bool>(input), "Could not open child result");
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
std::wstring exe_path()
{
    std::vector<wchar_t> path(32768);
    const auto length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    require(length > 0 && length < path.size(), "Could not obtain fixture executable path");
    return {path.data(), length};
}
void verify_manifest()
{
    const auto resource = FindResourceW(nullptr, MAKEINTRESOURCEW(1), RT_MANIFEST);
    require(resource != nullptr, "Fixture manifest is missing");
    const auto loaded = LoadResource(nullptr, resource);
    const auto *data = static_cast<const char *>(LockResource(loaded));
    const DWORD length = SizeofResource(nullptr, resource);
    require(data != nullptr && length > 0, "Could not read fixture manifest");
    const std::string manifest(data, data + length);
    require(manifest.find("longPathAware") != std::string::npos && manifest.find(">false<") != std::string::npos,
        "Fixture must explicitly disable longPathAware");
}
HMODULE WINAPI prefixed_load_only(LPCWSTR path)
{ return LoadLibraryW(extended(path).c_str()); }

int child(const std::wstring &mode, const std::wstring &input, const std::wstring &report)
{
    verify_manifest();
    const auto canonical = checked_build_path(input);
    require(std::filesystem::path(canonical).filename().wstring() == leaf, "Only the inert fixture DLL leaf is permitted");
    const bool prefix = mode == L"extended-w" || mode == L"extended-ex" ||
        mode == L"extended-scan" || mode == L"thunk-extended";
    const auto load_path = prefix ? extended(canonical) : canonical;
    HMODULE module = nullptr;
    DWORD loader_error = ERROR_SUCCESS, result = ERROR_SUCCESS, initialization = ERROR_SUCCESS;
    LONG gate = 0;
    std::wstring observed, scanned_path;
    std::size_t scanned_candidates = 0;
    if (mode.rfind(L"thunk-", 0) == 0) {
        auto data = std::make_unique<participant_loading_data>();
        require(wcscpy_s(data->load_path, load_path.c_str()) == 0, "Fixture path exceeds native request capacity");
        require(wcscpy_s(data->request.run_directory, L"C:\\ego-long-path-fixture-route") == 0, "Fixture route overflow");
        std::memcpy(data->expected_build_id, build, sizeof(build));
        require(strcpy_s(data->expected_public_name, public_name) == 0, "Fixture public name overflow");
        require(strcpy_s(data->initializer_name, "ElectronGameOverlayActivatePreloadedMemberV1") == 0, "Fixture export overflow");
        data->load_library = mode == L"thunk-prefix-load-only" ? prefixed_load_only : LoadLibraryW;
        data->free_library = FreeLibrary;
        data->get_proc_address = GetProcAddress;
        data->get_last_error = GetLastError;
        data->get_module_handle_ex = GetModuleHandleExW;
        data->get_module_file_name = GetModuleFileNameW;
        data->compare_string_ordinal = CompareStringOrdinal;
        data->owned_preload_snapshot = 1;
        data->initial_adapter_gate = &gate;
        SetLastError(ERROR_SUCCESS);
        result = participant_loading_thread(data.get()); // Local direct call, never a remote thread.
        loader_error = GetLastError();
        initialization = data->initialization_error;
        module = data->loaded_module;
        observed = data->observed_module_path;
    } else if (mode == L"plain-scan" || mode == L"extended-scan") {
        // Use the same filesystem path and stock flags as ReShade's offline
        // peer scan, without loading ReShade or a real add-on implementation.
        for (const auto &entry : std::filesystem::directory_iterator(
            std::filesystem::path(load_path).parent_path())) {
            if (entry.path().filename().wstring() != leaf) continue;
            ++scanned_candidates;
            scanned_path = entry.path().wstring();
        }
        require(scanned_candidates == 1, "Stock-style inert scan did not find exactly one owned leaf");
        SetLastError(ERROR_SUCCESS);
        module = LoadLibraryExW(scanned_path.c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        loader_error = module != nullptr ? ERROR_SUCCESS : GetLastError();
        result = loader_error;
    } else {
        require(mode == L"plain-w" || mode == L"extended-w" || mode == L"plain-ex" || mode == L"extended-ex", "Unknown loader probe mode");
        SetLastError(ERROR_SUCCESS);
        module = mode == L"plain-ex" || mode == L"extended-ex"
            ? LoadLibraryExW(load_path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
            : LoadLibraryW(load_path.c_str());
        loader_error = module != nullptr ? ERROR_SUCCESS : GetLastError();
        result = loader_error;
    }
    DWORD module_path_error = ERROR_SUCCESS, inspected_path_error = ERROR_SUCCESS;
    std::wstring inspected;
    if (module != nullptr) {
        std::vector<wchar_t> path(32768);
        SetLastError(ERROR_SUCCESS);
        const DWORD length = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
        module_path_error = GetLastError();
        if (length != 0 && length < path.size()) observed.assign(path.data(), length);
        SetLastError(ERROR_SUCCESS);
        const DWORD inspected_length = K32GetModuleFileNameExW(GetCurrentProcess(), module,
            path.data(), static_cast<DWORD>(path.size()));
        inspected_path_error = GetLastError();
        if (inspected_length != 0 && inspected_length < path.size()) inspected.assign(path.data(), inspected_length);
    }
    require(forbidden_mutations == 0, "A forbidden remote mutation API was called");
    std::ostringstream output;
    output << "{\"mode\":" << json_quote(mode) << ",\"canonicalPath\":" << json_quote(canonical)
        << ",\"canonicalLength\":" << canonical.size() << ",\"loadPath\":" << json_quote(load_path)
        << ",\"loadLength\":" << load_path.size() << ",\"moduleLoaded\":" << (module ? "true" : "false")
        << ",\"result\":" << result << ",\"lastErrorAfterLoadOrThunk\":" << loader_error
        << ",\"initializationError\":" << initialization << ",\"adapterGate\":" << gate
        << ",\"scannedPath\":" << json_quote(scanned_path) << ",\"scannedCandidates\":" << scanned_candidates
        << ",\"observedModulePath\":" << json_quote(observed) << ",\"modulePathLastError\":" << module_path_error
        << ",\"inspectedModulePath\":" << json_quote(inspected) << ",\"inspectedPathLastError\":" << inspected_path_error
        << ",\"inspectedEqualsLoadPath\":" << (inspected == load_path ? "true" : "false")
        << ",\"observedEqualsLoadPath\":" << (observed == load_path ? "true" : "false")
        << ",\"explicitRemoteMutationCalls\":" << forbidden_mutations << '}';
    write(report, output.str());
    return 0; // Loader failures are observations, not failed fixture infrastructure.
}

std::wstring command_arg(const std::wstring &value)
{
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t c : value) {
        if (c == L'\\') { ++slashes; continue; }
        result.append(slashes * (c == L'"' ? 2 : 1), L'\\'); slashes = 0;
        if (c == L'"') result += L'\\';
        result += c;
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
}
void run_child(const std::wstring &mode, const std::wstring &dll, const std::wstring &report)
{
    const auto executable = exe_path();
    std::wstring command = command_arg(executable) + L" --case " + command_arg(mode) + L" " + command_arg(dll) + L" " + command_arg(report);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION information{};
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, nullptr, &startup, &information) != FALSE, "Could not start owned console probe child");
    const scoped_handle process(information.hProcess), thread(information.hThread);
    const DWORD wait = WaitForSingleObject(process, 10000);
    if (wait != WAIT_OBJECT_0) {
        TerminateProcess(process, ERROR_TIMEOUT); // This exact child was created above; no PID lookup.
        WaitForSingleObject(process, 5000);
        throw std::runtime_error("Owned console probe child timed out");
    }
    DWORD code = ERROR_GEN_FAILURE;
    require(GetExitCodeProcess(process, &code) != FALSE && code == 0, "Owned console probe child failed");
}
std::wstring option(int argc, wchar_t **argv, const wchar_t *key)
{
    for (int i = 1; i + 1 < argc; ++i) if (wcscmp(argv[i], key) == 0) return argv[i + 1];
    throw std::runtime_error("Required fixture option missing");
}
}

int wmain(int argc, wchar_t **argv)
{
    try {
        if (argc == 5 && wcscmp(argv[1], L"--case") == 0) return child(argv[2], argv[3], argv[4]);
        verify_manifest();
        const auto root = checked_build_path(option(argc, argv, L"--root"));
        const auto member = checked_build_path(option(argc, argv, L"--member"));
        const auto report = checked_build_path(option(argc, argv, L"--report"));
        require(within(root, report), "Report must stay inside the fresh owned fixture root");
        require(GetFileAttributesW(root.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND,
            "Owned fixture root already exists or is inaccessible");
        std::filesystem::create_directories(root);
        std::vector<std::string> results;
        for (const std::size_t length : {233u, 259u, 260u, 289u, 320u}) {
            const auto leaf_length = std::size(leaf) - 1;
            require(length > root.size() + leaf_length + 2, "Owned root is too long for requested boundary case");
            const std::size_t component = length - root.size() - leaf_length - 2;
            require(component < 255, "Fixture directory component would exceed the native component bound");
            const auto directory = root + L"\\" + std::wstring(component, L'x');
            std::filesystem::create_directory(directory);
            const auto dll = directory + L"\\" + leaf;
            require(dll.size() == length, "Fixture path length arithmetic changed");
            require(CopyFileW(extended(member).c_str(), extended(dll).c_str(), TRUE) != FALSE,
                "Could not copy identical inert fixture bytes to long path");
            for (const auto *mode : {L"plain-w", L"extended-w", L"plain-ex", L"extended-ex", L"plain-scan", L"extended-scan", L"thunk-plain", L"thunk-extended", L"thunk-prefix-load-only"}) {
                const auto item = root + L"\\" + std::to_wstring(length) + L"-" + mode + L".json";
                run_child(mode, dll, item);
                results.push_back(read(item));
            }
        }
        std::ostringstream output;
        output << "{\"schemaVersion\":1,\"status\":\"probe-completed\",\"scope\":\"Fresh local console children and identical inert DLL; no ReShade, real add-on, graphics or production injector entry\",\"longPathAware\":false,\"root\":"
            << json_quote(root) << ",\"memberSource\":" << json_quote(member) << ",\"cases\":[";
        for (std::size_t index = 0; index < results.size(); ++index) { if (index) output << ','; output << results[index]; }
        output << "],\"freshChildren\":" << results.size() << ",\"explicitRemoteMutationCalls\":0}";
        write(report, output.str());
        std::wcout << L"PRELOAD_LONG_PATH_PROBE_COMPLETED cases=" << results.size() << L" report=" << report << L'\n';
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "PRELOAD_LONG_PATH_PROBE_FAILED " << error.what() << " WindowsError=" << GetLastError() << '\n';
        return 1;
    }
}
