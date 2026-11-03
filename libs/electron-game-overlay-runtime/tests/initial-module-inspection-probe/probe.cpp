// Exact native inspection only. The production injector entry is never called.
// Every observed process is a fresh owned instance of this inert console binary.
#include <Windows.h>
#include <Psapi.h>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct inspection_metrics
{
    unsigned enum_calls = 0, read_calls = 0;
    DWORD enum_error = ERROR_SUCCESS, enum_needed = 0;
    DWORD failed_read_error = ERROR_SUCCESS;
    SIZE_T failed_read_expected = 0, failed_read_actual = 0;
};
static inspection_metrics *active_inspection = nullptr;
static volatile LONG forbidden_mutations = 0;
static BOOL WINAPI observed_enum(HANDLE process, HMODULE *modules, DWORD bytes, LPDWORD needed)
{
    const BOOL result = K32EnumProcessModules(process, modules, bytes, needed);
    const DWORD error = result ? ERROR_SUCCESS : GetLastError();
    if (active_inspection != nullptr)
    {
        ++active_inspection->enum_calls;
        active_inspection->enum_error = error;
        active_inspection->enum_needed = needed == nullptr ? 0 : *needed;
    }
    SetLastError(error);
    return result;
}
static BOOL WINAPI observed_read(HANDLE process, LPCVOID address, LPVOID buffer, SIZE_T size, SIZE_T *read)
{
    const BOOL result = ReadProcessMemory(process, address, buffer, size, read);
    const DWORD error = result ? ERROR_SUCCESS : GetLastError();
    if (active_inspection != nullptr)
    {
        ++active_inspection->read_calls;
        if (!result || (read != nullptr && *read != size))
        {
            active_inspection->failed_read_error = error != ERROR_SUCCESS ? error : ERROR_PARTIAL_COPY;
            active_inspection->failed_read_expected = size;
            active_inspection->failed_read_actual = read == nullptr ? 0 : *read;
        }
    }
    SetLastError(error);
    return result;
}
static LPVOID WINAPI forbidden_alloc(HANDLE, LPVOID, SIZE_T, DWORD, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return nullptr; }
static BOOL WINAPI forbidden_free(HANDLE, LPVOID, SIZE_T, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
static BOOL WINAPI forbidden_write(HANDLE, LPVOID, LPCVOID, SIZE_T, SIZE_T *)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
static HANDLE WINAPI forbidden_thread(HANDLE, LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return nullptr; }
static BOOL WINAPI forbidden_duplicate(HANDLE, HANDLE, HANDLE, LPHANDLE, DWORD, BOOL, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
#define K32EnumProcessModules observed_enum
#define ReadProcessMemory observed_read
#define VirtualAllocEx forbidden_alloc
#define VirtualFreeEx forbidden_free
#define WriteProcessMemory forbidden_write
#define CreateRemoteThread forbidden_thread
#define DuplicateHandle forbidden_duplicate
#define wmain unused_production_injector_entry
#include EGO_INJECTOR_SOURCE
#undef wmain
#undef DuplicateHandle
#undef CreateRemoteThread
#undef WriteProcessMemory
#undef VirtualFreeEx
#undef VirtualAllocEx
#undef ReadProcessMemory
#undef K32EnumProcessModules

namespace
{
namespace fs = std::filesystem;
void require(bool value, const char *message)
{ if (!value) throw std::runtime_error(message); }
struct handle
{
    HANDLE value = nullptr;
    handle() = default;
    handle(const handle &) = delete;
    handle &operator=(const handle &) = delete;
    ~handle() { if (value != nullptr && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::uint64_t file_time(FILETIME value)
{ return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
std::uint64_t creation_time(HANDLE process)
{
    FILETIME creation = {}, exit = {}, kernel = {}, user = {};
    require(GetProcessTimes(process, &creation, &exit, &kernel, &user) != FALSE, "Could not read owned process creation time");
    return file_time(creation);
}
std::wstring image_path(HANDLE process)
{
    std::wstring result(32768, L'\0'); DWORD size = static_cast<DWORD>(result.size());
    require(QueryFullProcessImageNameW(process, 0, result.data(), &size) != FALSE, "Could not query owned process image");
    result.resize(size); return result;
}
std::wstring self_path()
{
    std::wstring result(32768, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, result.data(), static_cast<DWORD>(result.size()));
    require(size != 0 && size < result.size(), "Could not resolve probe executable");
    result.resize(size); return result;
}
std::string utf8(const std::wstring &input)
{
    if (input.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
    require(size > 0, "Invalid UTF-16 probe text");
    std::string result(size, '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), result.data(), size, nullptr, nullptr) == size, "UTF-8 conversion failed");
    return result;
}
std::string quote(const std::wstring &input)
{
    std::string result = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (const unsigned char c : utf8(input))
    {
        if (c == '\\' || c == '"') { result += '\\'; result += static_cast<char>(c); }
        else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
        else result += static_cast<char>(c);
    }
    return result + '"';
}
std::uint64_t microseconds()
{
    LARGE_INTEGER now = {}, frequency = {};
    QueryPerformanceCounter(&now); QueryPerformanceFrequency(&frequency);
    return static_cast<std::uint64_t>(now.QuadPart / frequency.QuadPart) * 1000000 +
        static_cast<std::uint64_t>((now.QuadPart % frequency.QuadPart) * 1000000 / frequency.QuadPart);
}
struct child_process
{
    handle process, thread, read_process, started, stop, churn_stop, churn_boundary;
    DWORD pid = 0;
    std::uint64_t creation = 0, began = 0;
    std::wstring expected_image;
    bool suspended = false, closed = false;
    explicit child_process(bool start_suspended, const std::wstring &churn_member = {})
    {
        SECURITY_ATTRIBUTES security = { sizeof(security), nullptr, TRUE };
        started.value = CreateEventW(&security, TRUE, FALSE, nullptr);
        stop.value = CreateEventW(&security, TRUE, FALSE, nullptr);
        churn_stop.value = CreateEventW(&security, TRUE, FALSE, nullptr);
        churn_boundary.value = CreateEventW(&security, TRUE, FALSE, nullptr);
        require(started.value != nullptr && stop.value != nullptr && churn_stop.value != nullptr && churn_boundary.value != nullptr,
            "Could not create owned child events");
        expected_image = self_path();
        std::wstring command = L"\"" + expected_image + L"\" --child " +
            std::to_wstring(reinterpret_cast<std::uintptr_t>(started.value)) + L" " +
            std::to_wstring(reinterpret_cast<std::uintptr_t>(stop.value)) + L" " +
            std::to_wstring(reinterpret_cast<std::uintptr_t>(churn_stop.value)) + L" " +
            std::to_wstring(reinterpret_cast<std::uintptr_t>(churn_boundary.value)) + L" \"" +
            (churn_member.empty() ? L"-" : churn_member) + L"\"";
        STARTUPINFOW startup = {}; startup.cb = sizeof(startup);
        PROCESS_INFORMATION information = {};
        began = microseconds();
        require(CreateProcessW(expected_image.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | (start_suspended ? CREATE_SUSPENDED : 0), nullptr, nullptr, &startup, &information) != FALSE,
            "Could not create fresh owned console child");
        process.value = information.hProcess; thread.value = information.hThread; pid = information.dwProcessId;
        suspended = start_suspended;
        try
        {
            read_process.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
            require(read_process.value != nullptr, "Could not acquire read-only child inspection handle");
            creation = creation_time(read_process.value);
            require(creation == creation_time(process.value), "Read-only handle refers to a different process instance");
            verify_identity();
        }
        catch (...) { cleanup(); throw; }
    }
    ~child_process() { cleanup(); }
    void cleanup() noexcept
    {
        if (process.value == nullptr || closed) return;
        if (suspended) ResumeThread(thread.value);
        SetEvent(stop.value);
        if (WaitForSingleObject(process.value, 3000) != WAIT_OBJECT_0)
        {
            // Only the retained handle returned by our CreateProcessW is used.
            TerminateProcess(process.value, ERROR_TIMEOUT);
            WaitForSingleObject(process.value, 3000);
        }
        closed = true;
    }
    void verify_identity() const
    {
        require(GetProcessId(read_process.value) == pid && creation_time(read_process.value) == creation,
            "Retained process identity changed");
        const auto actual = image_path(read_process.value);
        require(CompareStringOrdinal(actual.c_str(), -1, expected_image.c_str(), -1, TRUE) == CSTR_EQUAL,
            "Retained process image changed");
    }
    void resume()
    {
        require(suspended, "Only an owned suspended primary thread may be resumed");
        require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "Could not resume owned child thread");
        suspended = false;
    }
    void close()
    {
        if (suspended) resume();
        require(SetEvent(stop.value) != FALSE, "Could not release owned child");
        require(WaitForSingleObject(process.value, 3000) == WAIT_OBJECT_0, "Owned child failed to exit");
        DWORD exit = 0;
        require(GetExitCodeProcess(process.value, &exit) != FALSE && exit == 0, "Owned child returned failure");
        closed = true;
    }
};
struct observation
{
    std::uint64_t elapsed_us = 0;
    DWORD error = 0;
    bool started = false, alive = false;
    inspection_metrics metrics;
};
observation observe(child_process &child)
{
    child.verify_identity();
    observation result;
    result.elapsed_us = microseconds() - child.began;
    result.started = WaitForSingleObject(child.started.value, 0) == WAIT_OBJECT_0;
    result.alive = WaitForSingleObject(child.read_process.value, 0) == WAIT_TIMEOUT;
    HMODULE runtime = nullptr; bool ready = false, present = false, adapter = false;
    active_inspection = &result.metrics;
    result.error = inspect_cooperative_host(child.read_process.value, runtime, ready, &present, &adapter);
    active_inspection = nullptr;
    require(runtime == nullptr && !ready && !present && !adapter, "Inert child unexpectedly exposes a cooperative host");
    require(forbidden_mutations == 0, "A forbidden remote mutation operation was attempted");
    return result;
}
std::string serialize(const observation &value)
{
    std::ostringstream output;
    output << "{\"elapsedUs\":" << value.elapsed_us << ",\"identityVerified\":true,\"alive\":" << (value.alive ? "true" : "false")
        << ",\"childMainReached\":" << (value.started ? "true" : "false") << ",\"inspectionError\":" << value.error
        << ",\"enumCalls\":" << value.metrics.enum_calls << ",\"enumError\":" << value.metrics.enum_error
        << ",\"moduleBytes\":" << value.metrics.enum_needed << ",\"remoteReadCalls\":" << value.metrics.read_calls
        << ",\"failedReadError\":" << value.metrics.failed_read_error << ",\"failedReadExpected\":" << value.metrics.failed_read_expected
        << ",\"failedReadActual\":" << value.metrics.failed_read_actual << ",\"explicitRemoteMutationCalls\":0}";
    return output.str();
}
struct scenario
{
    std::wstring mode;
    DWORD pid = 0;
    std::uint64_t creation = 0;
    unsigned suspended_observations = 0;
    std::vector<observation> observations;
    bool eventually_ready = false, exited = false;
};
scenario run(const std::wstring &mode, unsigned suspended_ms)
{
    child_process child(mode != L"immediate");
    scenario result; result.mode = mode; result.pid = child.pid; result.creation = child.creation;
    if (child.suspended)
    {
        const ULONGLONG hold_until = GetTickCount64() + suspended_ms;
        do { result.observations.push_back(observe(child)); ++result.suspended_observations; Sleep(1); }
        while (GetTickCount64() < hold_until);
        child.resume();
    }
    const ULONGLONG deadline = GetTickCount64() + 1000;
    do
    {
        result.observations.push_back(observe(child));
        const auto &last = result.observations.back();
        if (last.error == ERROR_SUCCESS && last.metrics.enum_needed >= sizeof(HMODULE) && last.started)
        { result.eventually_ready = true; break; }
        require(last.alive, "Owned child exited during read-only inspection");
        Sleep(1);
    } while (GetTickCount64() < deadline);
    require(result.eventually_ready, "Owned console child did not reach a nonempty inspectable module list");
    child.close(); result.exited = true;
    require(WaitForSingleObject(child.read_process.value, 0) == WAIT_OBJECT_0, "Authoritative exit was not observed");
    return result;
}
scenario run_churn(const std::wstring &member)
{
    child_process child(false, member);
    scenario result; result.mode = L"local-module-churn"; result.pid = child.pid; result.creation = child.creation;
    require(WaitForSingleObject(child.churn_boundary.value, 1000) == WAIT_OBJECT_0, "Owned child did not begin local module churn");
    const ULONGLONG until = GetTickCount64() + 150;
    do { result.observations.push_back(observe(child)); } while (GetTickCount64() < until);
    require(ResetEvent(child.churn_boundary.value) != FALSE, "Could not reset owned churn boundary");
    require(SetEvent(child.churn_stop.value) != FALSE, "Could not stop owned local module churn");
    require(WaitForSingleObject(child.churn_boundary.value, 1000) == WAIT_OBJECT_0, "Owned module churn did not settle");
    result.observations.push_back(observe(child));
    const auto &last = result.observations.back();
    result.eventually_ready = last.error == ERROR_SUCCESS && last.metrics.enum_needed >= sizeof(HMODULE) && last.started;
    require(result.eventually_ready, "Owned child was not inspectable after local churn settled");
    child.close(); result.exited = true;
    return result;
}
#if EGO_HAS_INITIAL_RECOVERY
std::string run_recovery(const std::wstring &mode, const std::wstring &member = {}, bool *recovered_churn = nullptr)
{
    const bool steady = mode == L"steady";
    const bool churn = mode == L"churn-during-recovery";
    child_process child(!steady && !churn, churn ? member : std::wstring());
    if (steady) require(WaitForSingleObject(child.started.value, 1000) == WAIT_OBJECT_0, "Steady child did not reach main");
    if (churn) require(WaitForSingleObject(child.churn_boundary.value, 1000) == WAIT_OBJECT_0, "Recovery child did not begin local churn");
    auto before = observe(child);
    if (churn)
    {
        const ULONGLONG until = GetTickCount64() + 100;
        while (before.error != ERROR_PARTIAL_COPY && GetTickCount64() < until) before = observe(child);
        require(before.error == ERROR_PARTIAL_COPY, "No real read-only module-churn partial copy was observed");
        require(ResetEvent(child.churn_boundary.value) != FALSE, "Could not reset recovery churn boundary");
    }
    std::atomic<DWORD> controller_error { ERROR_SUCCESS };
    std::thread controller;
    struct joiner { std::thread &value; ~joiner() { if (value.joinable()) value.join(); } } guard { controller };
    if (mode == L"resume-during-recovery")
        controller = std::thread([&]() {
            Sleep(100);
            if (ResumeThread(child.thread.value) == static_cast<DWORD>(-1)) controller_error.store(GetLastError());
        });
    else if (mode == L"exit-during-recovery")
        controller = std::thread([&]() {
            Sleep(25);
            if (!TerminateProcess(child.process.value, ERROR_PROCESS_ABORTED)) controller_error.store(GetLastError());
        });
    else if (churn)
        controller = std::thread([&]() {
            Sleep(75);
            if (!SetEvent(child.churn_stop.value)) controller_error.store(GetLastError());
        });
    bool pinned = true, ready = true, present = true;
    HMODULE runtime = reinterpret_cast<HMODULE>(static_cast<std::uintptr_t>(1));
    owned_late_d3d11_host owned_late; owned_late.initializer = 1;
    initial_module_inspection_observation native;
    inspection_metrics metrics;
    child.verify_identity();
    active_inspection = &metrics;
    const DWORD error = inspect_initial_host_readonly(child.read_process.value, child.pid,
        pinned, runtime, ready, present, owned_late, native);
    active_inspection = nullptr;
    if (controller.joinable()) controller.join();
    require(controller_error.load() == ERROR_SUCCESS, "Owned controller operation failed");
    if (churn) require(WaitForSingleObject(child.churn_boundary.value, 1000) == WAIT_OBJECT_0, "Recovery churn did not settle");
    if (mode == L"resume-during-recovery") child.suspended = false;
    const bool clear = !pinned && runtime == nullptr && !ready && !present &&
        owned_late.initializer == 0 && owned_late.gate_address == 0 && owned_late.gate == -1;
    require(clear, "Recovery retained partial or sentinel host observations");
    if (mode == L"exit-during-recovery")
    {
        require(error == ERROR_PROCESS_ABORTED && WaitForSingleObject(child.read_process.value, 0) == WAIT_OBJECT_0,
            "Authoritative owned child exit did not stop recovery");
        child.closed = true;
    }
    else
    {
        require(error == (mode == L"persistent-suspended" ? ERROR_PARTIAL_COPY : ERROR_SUCCESS), "Unexpected real recovery result");
        if (child.suspended) child.resume();
        require(WaitForSingleObject(child.started.value, 1000) == WAIT_OBJECT_0, "Owned child did not reach main for cleanup");
        child.close();
    }
    require(forbidden_mutations == 0, "Recovery invoked a forbidden mutation operation");
    if (recovered_churn != nullptr) *recovered_churn = error == ERROR_SUCCESS && native.first_error == ERROR_PARTIAL_COPY;
    std::ostringstream output;
    output << "{\"mode\":" << quote(mode) << ",\"pid\":" << child.pid << ",\"creationTime100ns\":\"" << child.creation
        << "\",\"initialObservation\":" << serialize(before) << ",\"returnedError\":" << error
        << ",\"phase\":" << quote(native.phase) << ",\"attempts\":" << native.attempts << ",\"elapsedMs\":" << native.elapsed_ms
        << ",\"firstError\":" << native.first_error << ",\"lastError\":" << native.last_error
        << ",\"enumCalls\":" << metrics.enum_calls << ",\"lastEnumError\":" << metrics.enum_error
        << ",\"lastModuleBytes\":" << metrics.enum_needed << ",\"remoteReadCalls\":" << metrics.read_calls
        << ",\"partialOutputsCleared\":true,\"ownedChildExited\":true,\"ownedControlTermination\":"
        << (mode == L"exit-during-recovery" ? "true" : "false") << ",\"explicitRemoteMutationCalls\":0}";
    return output.str();
}
#endif
std::string serialize(const scenario &value)
{
    std::ostringstream output;
    output << "{\"mode\":" << quote(value.mode) << ",\"pid\":" << value.pid << ",\"creationTime100ns\":\"" << value.creation
        << "\",\"suspendedObservations\":" << value.suspended_observations << ",\"eventuallyInspectable\":" << (value.eventually_ready ? "true" : "false")
        << ",\"ownedChildExited\":" << (value.exited ? "true" : "false") << ",\"observations\":[";
    for (std::size_t i = 0; i < value.observations.size(); ++i) { if (i) output << ','; output << serialize(value.observations[i]); }
    return output.str() + "]}";
}
}
int wmain(int argc, wchar_t **argv)
{
    try
    {
        if (argc == 7 && std::wstring(argv[1]) == L"--child")
        {
            HANDLE started = reinterpret_cast<HANDLE>(std::stoull(argv[2]));
            HANDLE stop = reinterpret_cast<HANDLE>(std::stoull(argv[3]));
            HANDLE churn_stop = reinterpret_cast<HANDLE>(std::stoull(argv[4]));
            HANDLE boundary = reinterpret_cast<HANDLE>(std::stoull(argv[5]));
            require(SetEvent(started) != FALSE, "Inherited ready event failed");
            if (std::wstring(argv[6]) != L"-")
            {
                const fs::path member = fs::canonical(argv[6]);
                require(member.parent_path() == fs::canonical(fs::path(self_path()).parent_path()) &&
                    member.filename() == L"initial_module_churn_member.dll", "Only the adjacent inert churn member is allowed");
                bool announced = false;
                while (WaitForSingleObject(churn_stop, 0) == WAIT_TIMEOUT && WaitForSingleObject(stop, 0) == WAIT_TIMEOUT)
                {
                    const auto module = LoadLibraryW(member.c_str());
                    require(module != nullptr, "Owned child could not load its inert churn DLL");
                    if (!announced) { SetEvent(boundary); announced = true; }
                    require(FreeLibrary(module) != FALSE, "Owned child could not release its inert churn DLL");
                }
                require(SetEvent(boundary) != FALSE, "Owned child could not announce stable module state");
            }
            require(WaitForSingleObject(stop, 10000) == WAIT_OBJECT_0, "Owned child stop wait failed");
            return 0;
        }
        require((argc == 3 || argc == 5) && std::wstring(argv[1]) == L"--root" &&
            (argc == 3 || std::wstring(argv[3]) == L"--churn-member"),
            "Usage: --root <fresh immediate build/im-probe-* directory> [--churn-member <adjacent inert DLL>]");
        const fs::path build = fs::canonical(EGO_ALLOWED_BUILD), requested = fs::absolute(argv[2]);
        require(fs::canonical(requested.parent_path()) == build && requested.filename().wstring().rfind(L"im-probe-", 0) == 0,
            "Evidence root must be an immediate owned im-probe-* child of the SDK build directory");
        require(!fs::exists(requested), "Evidence root must not exist");
        fs::create_directory(requested);
        std::vector<scenario> cases;
        cases.push_back(run(L"suspended-then-resumed", 8));
        cases.push_back(run(L"persistent-suspended-then-resumed", 250));
        for (unsigned iteration = 0; iteration != 32; ++iteration) cases.push_back(run(L"immediate", 0));
        if (argc == 5)
        {
            const fs::path member = fs::canonical(argv[4]);
            require(member.parent_path() == fs::canonical(fs::path(self_path()).parent_path()) &&
                member.filename() == L"initial_module_churn_member.dll", "Churn member must be the adjacent owned inert DLL");
            for (unsigned iteration = 0; iteration != 4; ++iteration) cases.push_back(run_churn(member.wstring()));
        }
        std::vector<std::string> recovery;
#if EGO_HAS_INITIAL_RECOVERY
        for (const auto *mode : { L"steady", L"resume-during-recovery", L"persistent-suspended", L"exit-during-recovery" })
            recovery.push_back(run_recovery(mode));
        if (argc == 5)
        {
            bool recovered = false;
            for (unsigned attempt = 0; attempt != 16 && !recovered; ++attempt)
                recovery.push_back(run_recovery(L"churn-during-recovery", fs::canonical(argv[4]).wstring(), &recovered));
            require(recovered, "No actual partial-copy recovery was observed during bounded owned module churn");
        }
#endif
        require(forbidden_mutations == 0, "A remote mutation trap was invoked");
        std::ofstream output(requested / L"report.json", std::ios::binary);
        require(static_cast<bool>(output), "Could not write owned evidence report");
        output << "{\"schemaVersion\":1,\"status\":\"probe-completed\",\"architecture\":\""
#ifdef _WIN64
            << "x64"
#else
            << "x86"
#endif
            << "\",\"pointerBytes\":" << sizeof(void *) << ",\"sourceRawSha256\":\"" << EGO_SOURCE_RAW_SHA
            << "\",\"sourceNormalizedSha256\":\"" << EGO_SOURCE_NORMALIZED_SHA
            << "\",\"scope\":\"Exact inspect_cooperative_host against retained read-only handles to fresh owned console processes; no injection, ReShade, graphics or consumer application\",\"cases\":[";
        for (std::size_t i = 0; i < cases.size(); ++i) { if (i) output << ','; output << serialize(cases[i]); }
        output << "],\"recoveryCases\":[";
        for (std::size_t i = 0; i < recovery.size(); ++i) { if (i) output << ','; output << recovery[i]; }
        output << "],\"explicitRemoteMutationCalls\":0,\"ownedChildrenRemaining\":0}\n";
        require(static_cast<bool>(output), "Could not finish evidence report");
        std::cout << "PROBE_COMPLETED cases=" << cases.size() << " report=" << utf8((requested / L"report.json").wstring()) << '\n';
        return 0;
    }
    catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
