// Run the complete production selector/entrypoint with exactly one controlled
// seam: deny its full-access OpenProcess for this fixture's own retained child.
// This never reaches injection and does not target any external executable.
#include <windows.h>
#include <cstdio>
#include <thread>
#include <atomic>
static HANDLE armed_event, created_event, child_process;
static std::atomic<DWORD> owned_pid{0};
static std::atomic<unsigned> full_opens{0};
static bool exit_before_full_open;
static HANDLE WINAPI fixture_open_process(DWORD access, BOOL inherit, DWORD pid);
static int fixture_flush(FILE *file);
#define OpenProcess fixture_open_process
#define fflush fixture_flush
#define wmain production_injector_main
#include EGO_INJECTOR_SOURCE
#undef wmain
#undef fflush
#undef OpenProcess

static int fixture_flush(FILE *file)
{
    const int result = fflush(file);
    if (file == stdout && armed_event != nullptr) SetEvent(armed_event);
    return result;
}
static HANDLE WINAPI fixture_open_process(DWORD access, BOOL inherit, DWORD pid)
{
    if ((access & (PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_CREATE_THREAD | PROCESS_DUP_HANDLE)) == 0)
        return OpenProcess(access, inherit, pid);
    if (WaitForSingleObject(created_event, 5000) != WAIT_OBJECT_0 || pid != owned_pid.load()) {
        SetLastError(ERROR_ACCESS_DENIED); return nullptr;
    }
    ++full_opens;
    if (exit_before_full_open) {
        if (!TerminateProcess(child_process, 0) || WaitForSingleObject(child_process, 5000) != WAIT_OBJECT_0) {
            SetLastError(ERROR_GEN_FAILURE); return nullptr;
        }
        SetLastError(ERROR_INVALID_PARAMETER);
    } else SetLastError(ERROR_ACCESS_DENIED);
    return nullptr;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 2 && wcscmp(argv[1], L"--owned-child") == 0) { Sleep(INFINITE); return 0; }
    wchar_t executable[32768]{};
    if (!GetModuleFileNameW(nullptr, executable, ARRAYSIZE(executable))) return 1;
    const std::wstring image(executable), directory = image.substr(0, image.find_last_of(L'\\'));
    const std::wstring policy_file = directory + L"\\owned-refusal-policy-" + std::to_wstring(GetCurrentProcessId()) + L".txt";
    const std::wstring document = L"EGO_PROCESS_POLICY_V1\nA\t" + policy_normalize(image) + L"\n";
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, document.data(), static_cast<int>(document.size()), nullptr, 0, nullptr, nullptr);
    std::string utf8(bytes, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, document.data(), static_cast<int>(document.size()), utf8.data(), bytes, nullptr, nullptr);
    {
        const scoped_handle file = CreateFileW(policy_file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD written = 0;
        if (file == INVALID_HANDLE_VALUE || !WriteFile(file, utf8.data(), bytes, &written, nullptr) || written != bytes) return 2;
    }
    for (const bool fast_exit : {false, true}) {
        exit_before_full_open = fast_exit; full_opens = 0; owned_pid = 0;
        scoped_handle armed(CreateEventW(nullptr, TRUE, FALSE, nullptr)), created(CreateEventW(nullptr, TRUE, FALSE, nullptr)), done(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        armed_event = armed; created_event = created;
        scoped_handle job(CreateJobObjectW(nullptr, nullptr));
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (job == nullptr || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 3;
        std::wstring fragment = directory, policy = policy_file;
        wchar_t program[] = L"owned-injector", option[] = L"--path-contains", policy_option[] = L"--policy-file";
        wchar_t *arguments[] = {program, option, fragment.data(), policy_option, policy.data()};
        int result = -1;
        std::thread worker([&] { result = production_injector_main(5, arguments); SetEvent(done); });
        if (WaitForSingleObject(armed, 5000) != WAIT_OBJECT_0) ExitProcess(4);
        std::wstring command = L"\"" + image + L"\" --owned-child";
        STARTUPINFOW startup{sizeof(startup)}; PROCESS_INFORMATION child{};
        if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) ExitProcess(5);
        scoped_handle process(child.hProcess), thread(child.hThread);
        if (!AssignProcessToJobObject(job, process)) { TerminateProcess(process, 1); ExitProcess(6); }
        child_process = process; owned_pid = child.dwProcessId;
        FILETIME birth{}, end{}, kernel{}, user{};
        if (!GetProcessTimes(process, &birth, &end, &kernel, &user)) ExitProcess(7);
        const uint64_t creation = (static_cast<uint64_t>(birth.dwHighDateTime) << 32) | birth.dwLowDateTime;
        SetEvent(created);
        if (WaitForSingleObject(done, 10000) != WAIT_OBJECT_0) ExitProcess(8);
        worker.join();
        if (!fast_exit && (!TerminateProcess(process, 0) || WaitForSingleObject(process, 5000) != WAIT_OBJECT_0)) return 9;
        if (result != (fast_exit ? ERROR_INVALID_PARAMETER : ERROR_ACCESS_DENIED) || full_opens != 1 || WaitForSingleObject(process, 0) != WAIT_OBJECT_0) return 10;
        printf("EGO_OPEN_REFUSAL_CASE {\"pid\":%lu,\"creationTime100ns\":\"%llu\",\"fastExit\":%s,\"fullOpenAttempts\":%u,\"windowsError\":%d,\"injection\":false,\"authoritativeExit\":true}\n", child.dwProcessId, static_cast<unsigned long long>(creation), fast_exit ? "true" : "false", full_opens.load(), result);
        fflush(stdout);
        armed_event = nullptr; created_event = nullptr; child_process = nullptr;
    }
    DeleteFileW(policy_file.c_str());
    printf("EGO_OPEN_REFUSAL_PASSED cases=2 graphics=false injection=false\n");
    return 0;
}
