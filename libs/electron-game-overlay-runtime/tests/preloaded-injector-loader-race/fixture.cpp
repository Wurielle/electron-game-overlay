#ifndef EGO_INJECTOR_SOURCE
#error Supply the exact candidate EGO_INJECTOR_SOURCE.
#endif
#define wmain unused_injector_entry
#include EGO_INJECTOR_SOURCE
#undef wmain

#include <filesystem>
#include <iostream>
#include <stdexcept>

namespace {
std::uint64_t assertions = 0;
constexpr char expected_build[33] = ADDON_BUILD_ID;
void require(bool condition, const char *message)
{
    ++assertions;
    if (!condition) throw std::runtime_error(message);
}
std::wstring quote(const std::wstring &value)
{
    require(value.find(L'"') == std::wstring::npos, "unquotable owned argument");
    return L"\"" + value + L"\"";
}
std::wstring executable_path()
{
    wchar_t path[32768] = {};
    const DWORD length = GetModuleFileNameW(nullptr, path, ARRAYSIZE(path));
    require(length != 0 && length < ARRAYSIZE(path), "cannot find console fixture executable");
    return std::wstring(path, length);
}
struct owned_child {
    HANDLE process = nullptr;
    HANDLE main_thread = nullptr;
    HANDLE stop = nullptr;
    ~owned_child()
    {
        if (process != nullptr)
        {
            if (stop != nullptr) SetEvent(stop);
            if (WaitForSingleObject(process, 2000) != WAIT_OBJECT_0)
            {
                TerminateProcess(process, 99); // Only our retained CreateProcess child.
                WaitForSingleObject(process, 2000);
            }
            CloseHandle(process);
        }
        if (main_thread != nullptr) CloseHandle(main_thread);
    }
};
LONG exported_long(HANDLE process, HMODULE module, const char *name)
{
    DWORD error = ERROR_SUCCESS;
    uintptr_t address = 0;
    LONG value = -1;
    require(remote_module_export_address(process, module, name, address, error) == module_export_inspection::present,
        "fixture data export missing");
    require(read_remote_bytes(process, address, &value, sizeof(value), error), "cannot read fixture data export");
    return value;
}
std::string exported_name(HANDLE process, HMODULE module)
{
    DWORD error = ERROR_SUCCESS;
    uintptr_t address = 0, pointer = 0;
    require(remote_module_export_address(process, module, "NAME", address, error) == module_export_inspection::present,
        "NAME data export missing");
    require(read_remote_bytes(process, address, &pointer, sizeof(pointer), error), "cannot read NAME pointer");
    std::string result;
    for (unsigned index = 0; index != 160; ++index)
    {
        char character = 0;
        require(read_remote_bytes(process, pointer + index, &character, 1, error), "cannot read NAME bytes");
        if (character == '\0') return result;
        result.push_back(character);
    }
    throw std::runtime_error("unbounded fixture NAME");
}

void run_case(const std::filesystem::path &root, const std::filesystem::path &source,
    const wchar_t *mode, DWORD expected_error, SIZE_T code_size)
{
    const auto directory = root / mode;
    require(CreateDirectoryW(directory.c_str(), nullptr) != FALSE, "cannot create owned case directory");
    const auto stage = directory / L"private-stage";
    require(CreateDirectoryW(stage.c_str(), nullptr) != FALSE, "cannot create owned private stage");
    BYTE hash[32] = {};
    scoped_handle source_guard;
    require(hash_immutable_native_file(source.wstring(), source_guard, hash) == ERROR_SUCCESS, "cannot hash inert source image");
    std::wstring leaf = L"ego-preload-0123456789abcdef0123456789abcdef-";
    for (const char character : std::string(expected_build)) leaf += static_cast<wchar_t>(character);
    leaf += L'-';
    constexpr wchar_t hex[] = L"0123456789abcdef";
    for (unsigned index = 0; index != 8; ++index)
    {
        leaf += hex[hash[index] >> 4];
        leaf += hex[hash[index] & 15];
    }
#ifdef _WIN64
    leaf += L".addon64";
#else
    leaf += L".addon32";
#endif
    require(bind_preloaded_addon_leaf(leaf, expected_build, hash), "fixture leaf does not bind to bytes/build");
    const auto addon = directory / leaf;
    require(CopyFileW(source.c_str(), addon.c_str(), TRUE) != FALSE, "cannot copy inert owned preload image");
    const std::wstring event_base = L"Local\\ego-preload-race-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
        std::to_wstring(GetTickCount64()) + L"-" + mode;
    const auto entered_name = event_base + L"-entered";
    const auto release_name = event_base + L"-release";
    const auto stop_name = event_base + L"-stop";
    scoped_handle entered = CreateEventW(nullptr, TRUE, FALSE, entered_name.c_str());
    scoped_handle release = CreateEventW(nullptr, TRUE, FALSE, release_name.c_str());
    scoped_handle stop = CreateEventW(nullptr, TRUE, FALSE, stop_name.c_str());
    require(entered != nullptr && release != nullptr && stop != nullptr, "cannot create owned fixture events");
    std::wstring command = quote(executable_path()) + L" --target " + quote(addon.wstring()) + L" " +
        quote(entered_name) + L" " + quote(release_name) + L" " + quote(stop_name) + L" " + quote(stage.wstring()) + L" " + quote(mode);
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION created{};
    require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, directory.c_str(), &startup, &created) != FALSE, "cannot create owned console target");
    owned_child child{created.hProcess, created.hThread, stop};
    require(WaitForSingleObject(entered, 5000) == WAIT_OBJECT_0, "inert DLL did not enter held DllMain");
    HMODULE mapped = nullptr;
    DWORD error = find_preloaded_addon(child.process, leaf, mapped);
    require(error == ERROR_SUCCESS && mapped != nullptr, "OS snapshot did not expose initializing module");
    require(exported_name(child.process, mapped) == "Electron Game Overlay Runtime", "DLL NAME was not held before publication");
    require(exported_long(child.process, mapped, "FixtureDllMainCompleted") == 0, "DllMain completed before race inspection");
    std::wstring verified_path;
    scoped_handle preload_guard;
    require(validate_mapped_preloaded_addon(child.process, mapped, leaf, expected_build, hash,
        verified_path, preload_guard) == ERROR_SUCCESS, "immutable valid image rejected while DllMain held generic NAME");
    require(_wcsicmp(verified_path.c_str(), addon.c_str()) == 0, "preflight selected wrong module path");
    participant_loading_data data;
    wcscpy_s(data.load_path, addon.c_str());
    wcscpy_s(data.request.run_directory, stage.c_str());
    strcpy_s(data.initializer_name, "ElectronGameOverlayActivatePreloadedMemberV1");
    std::string public_name = "Electron Game Overlay Runtime ";
    for (const wchar_t character : leaf) public_name += static_cast<char>(character);
    strcpy_s(data.expected_public_name, public_name.c_str());
    memcpy(data.expected_build_id, expected_build, sizeof(expected_build));
    data.preloaded_module = mapped;
    uintptr_t load_trap = 0, free_trap = 0;
    require(remote_module_export_address(child.process, mapped, "FixtureLoadLibraryTrap", load_trap, error) == module_export_inspection::present &&
        remote_module_export_address(child.process, mapped, "FixtureFreeLibraryTrap", free_trap, error) == module_export_inspection::present,
        "fixture loader-call traps missing");
    data.load_library = reinterpret_cast<decltype(&LoadLibraryW)>(load_trap);
    data.free_library = reinterpret_cast<decltype(&FreeLibrary)>(free_trap);
    data.get_proc_address = GetProcAddress;
    data.get_last_error = GetLastError;
    data.get_module_handle_ex = GetModuleHandleExW;
    data.get_module_file_name = GetModuleFileNameW;
    data.compare_string_ordinal = CompareStringOrdinal;
    BYTE *allocation = static_cast<BYTE *>(VirtualAllocEx(child.process, nullptr, sizeof(data) + code_size,
        MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE));
    require(allocation != nullptr, "cannot allocate copied thunk in owned child");
    require(WriteProcessMemory(child.process, allocation, &data, sizeof(data), nullptr) != FALSE &&
        WriteProcessMemory(child.process, allocation + sizeof(data), reinterpret_cast<const void *>(participant_loading_thread), code_size, nullptr) != FALSE &&
        FlushInstructionCache(child.process, allocation + sizeof(data), code_size) != FALSE,
        "cannot publish copied thunk in owned child");
    scoped_handle thread = CreateRemoteThread(child.process, nullptr, 0,
        reinterpret_cast<LPTHREAD_START_ROUTINE>(allocation + sizeof(data)), allocation, 0, nullptr);
    require(thread != nullptr, "cannot start copied thunk in owned child");
    require(WaitForSingleObject(thread, 100) == WAIT_TIMEOUT, "activation escaped held target DLL initialization");
    require(exported_long(child.process, mapped, "FixtureActivationCount") == 0, "activation happened before DLL initialization completed");
    require(SetEvent(release) != FALSE, "cannot release held owned DllMain");
    require(WaitForSingleObject(thread, 5000) == WAIT_OBJECT_0, "copied thunk did not finish after DLL initialization");
    DWORD exit = ERROR_GEN_FAILURE;
    require(GetExitCodeThread(thread, &exit) != FALSE, "cannot inspect copied thunk exit code");
    require(read_remote_bytes(child.process, reinterpret_cast<uintptr_t>(allocation), &data, sizeof(data), error), "cannot inspect copied thunk result");
    require(VirtualFreeEx(child.process, allocation, 0, MEM_RELEASE) != FALSE, "cannot retire completed owned thunk allocation");
    require(exit == expected_error && data.initialization_error == expected_error, "copied thunk returned wrong structured status");
    require(data.loaded_module == mapped && data.preloaded_module == mapped, "copied thunk changed selected module identity");
    require(exported_long(child.process, mapped, "FixtureDllMainCompleted") == 1, "DLL initialization did not complete");
    const bool wrong_name = wcscmp(mode, L"wrong-name") == 0;
    require(exported_long(child.process, mapped, "FixtureActivationCount") == (wrong_name ? 0 : 1), "wrong metadata activated or valid activation repeated");
    require(exported_long(child.process, mapped, "FixtureRouteAccepted") == (wrong_name ? 0 : 1), "explicit staged route was lost or accepted before metadata proof");
    require(exported_long(child.process, mapped, "FixtureLoadLibraryCalls") == 0, "preloaded activation called LoadLibrary");
    require(exported_long(child.process, mapped, "FixtureFreeLibraryCalls") == 0, "preloaded activation called FreeLibrary");
    require(SetEvent(stop) != FALSE && WaitForSingleObject(child.process, 5000) == WAIT_OBJECT_0, "owned child did not exit cleanly");
    DWORD child_exit = 99;
    require(GetExitCodeProcess(child.process, &child_exit) != FALSE && child_exit == 0, "owned child failed normal exit");
}
}

int wmain(int argc, wchar_t *argv[])
{
    if (argc == 8 && wcscmp(argv[1], L"--target") == 0)
    {
        if (!SetEnvironmentVariableW(L"EGO_RACE_ENTERED_EVENT", argv[3]) ||
            !SetEnvironmentVariableW(L"EGO_RACE_RELEASE_EVENT", argv[4]) ||
            !SetEnvironmentVariableW(L"EGO_RACE_EXPECTED_ROUTE", argv[6]) ||
            !SetEnvironmentVariableW(L"EGO_RACE_MODE", argv[7])) return 81;
        const HMODULE module = LoadLibraryW(argv[2]);
        if (module == nullptr) return 82;
        scoped_handle stop = OpenEventW(SYNCHRONIZE, FALSE, argv[5]);
        return stop != nullptr && WaitForSingleObject(stop, 15000) == WAIT_OBJECT_0 ? 0 : 83;
    }
    try
    {
        require(argc == 2, "usage: preload_loader_race <owned inert fixture DLL>");
        SIZE_T member_size = 0, runtime_size = 0;
        require(participant_loading_thread_size(member_size) && member_size <= 4096, "copied member thunk is not bounded");
        require(get_loading_thread_func_size(runtime_size) && runtime_size <= 4096, "copied runtime thunk is not bounded");
        const auto root = std::filesystem::current_path() / (L"owned-race-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
        require(CreateDirectoryW(root.c_str(), nullptr) != FALSE, "cannot create unique owned run root");
        const auto source = std::filesystem::absolute(argv[1]);
        run_case(root, source, L"success", ERROR_SUCCESS, member_size);
        run_case(root, source, L"wrong-name", ERROR_REVISION_MISMATCH, member_size);
        run_case(root, source, L"assigned", ERROR_ALREADY_ASSIGNED, member_size);
        run_case(root, source, L"denied", ERROR_ACCESS_DENIED, member_size);
        std::cout << "{\"status\":\"PASS\",\"cases\":4,\"assertions\":" << assertions
            << ",\"memberThunkBytes\":" << member_size << ",\"runtimeThunkBytes\":" << runtime_size << "}\n";
        return 0;
    }
    catch (const std::exception &error)
    {
        std::cerr << "preload loader race fixture FAIL after " << assertions << " assertions: " << error.what()
            << " (Win32 " << GetLastError() << ")\n";
        return 1;
    }
}
