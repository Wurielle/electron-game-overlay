// Compile the complete production injector; call only its read-only inspection
// seam. The target is this owned console executable, with no graphics imports.
#define wmain production_injector_main
#include EGO_INJECTOR_SOURCE
#undef wmain

static int require(bool condition, const char *message)
{
    if (!condition) { fprintf(stderr, "%s\n", message); return 1; }
    return 0;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 3 && wcscmp(argv[1], L"--target") == 0)
    {
        HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[2]);
        if (ready == nullptr || !SetEvent(ready)) return 2;
        CloseHandle(ready);
        Sleep(INFINITE);
        return 0;
    }
    wchar_t executable[32768] = {};
    if (GetModuleFileNameW(nullptr, executable, ARRAYSIZE(executable)) == 0) return 3;
    for (int cycle = 0; cycle < 3; ++cycle)
    {
        const std::wstring name = L"Local\\EGO-inspection-console-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(cycle);
        scoped_handle ready_event(CreateEventW(nullptr, TRUE, FALSE, name.c_str()));
        std::wstring command = L"\"" + std::wstring(executable) + L"\" --target " + name;
        STARTUPINFOW startup = { sizeof(startup) };
        PROCESS_INFORMATION child = {};
        if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 4;
        scoped_handle process(child.hProcess), thread(child.hThread);
        bool pinned = false, host_ready = false, participant = false;
        HMODULE runtime = nullptr;
        owned_late_d3d11_host late;
        initial_module_inspection_observation observation;
        const DWORD suspended_error = inspect_initial_host_readonly(process, child.dwProcessId, pinned, runtime, host_ready, participant, late, observation);
        int failed = require(suspended_error == ERROR_PARTIAL_COPY, "Suspended loader must fail with 299") |
            require(observation.elapsed_ms >= 250 && observation.elapsed_ms < 2000, "Original bounded budget must remain unchanged") |
            require(wcscmp(observation.phase, L"module-enumeration") == 0, "Expected module enumeration failure") |
            require(runtime == nullptr && !pinned && !host_ready && !participant, "Failure must clear ownership outputs");
        write_initial_module_inspection_summary(observation);
        write_target_inspection_context(process, child.dwProcessId);
        if (ResumeThread(thread) == static_cast<DWORD>(-1) || WaitForSingleObject(ready_event, 5000) != WAIT_OBJECT_0) failed = 1;
        const DWORD resumed_error = inspect_initial_host_readonly(process, child.dwProcessId, pinned, runtime, host_ready, participant, late, observation);
        failed |= require(resumed_error == ERROR_SUCCESS && runtime == nullptr && !participant && !pinned, "Same handle must recover after owned loader initialization");
        write_target_inspection_context(process, child.dwProcessId);
        TerminateProcess(process, 0);
        if (WaitForSingleObject(process, 5000) != WAIT_OBJECT_0) failed = 1;
        const DWORD exited_error = inspect_initial_host_readonly(process, child.dwProcessId, pinned, runtime, host_ready, participant, late, observation);
        failed |= require(exited_error == ERROR_PROCESS_ABORTED, "Exited retained handle must fail closed");
        if (failed) return 5;
    }
    printf("EGO_INSPECTION_CONSOLE_PASSED cycles=3 graphics=false injection=false\n");
    return 0;
}
