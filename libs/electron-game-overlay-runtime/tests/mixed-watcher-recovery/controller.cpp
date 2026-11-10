#include <Windows.h>
#include <cstdio>
#include <cwchar>
#include <string>

int wmain(int argc, wchar_t **argv)
{
    if (argc != 3) return 1;
    const std::wstring image = argv[1], mode = argv[2];
    const wchar_t *leaf = wcsrchr(image.c_str(), L'\\');
    if (leaf == nullptr || (wcscmp(leaf + 1, L"owned_recovery_a.exe") != 0 &&
        wcscmp(leaf + 1, L"owned_recovery_b.exe") != 0)) return 2;
    const bool suspended = mode == L"suspended";
    if (!suspended && mode != L"normal") return 3;
    STARTUPINFOW startup = { sizeof(startup) };
    PROCESS_INFORMATION child = {};
    std::wstring command = L"\"" + image + L"\"";
    if (!CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE,
        suspended ? CREATE_SUSPENDED | CREATE_NO_WINDOW : 0, nullptr, nullptr, &startup, &child)) return 4;
    FILETIME created = {}, exited = {}, kernel = {}, user = {};
    if (!GetProcessTimes(child.hProcess, &created, &exited, &kernel, &user)) {
        TerminateProcess(child.hProcess, 1); CloseHandle(child.hThread); CloseHandle(child.hProcess); return 5;
    }
    const auto time = (static_cast<unsigned long long>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    printf("{\"pid\":%lu,\"creationTime100ns\":\"%llu\"}\n", child.dwProcessId, time); fflush(stdout);
    char input[32] = {};
    while (fgets(input, sizeof(input), stdin) != nullptr) {
        if (strncmp(input, "resume", 6) == 0 && suspended) ResumeThread(child.hThread);
        if (strncmp(input, "exit", 4) == 0) break;
    }
    // Always the handle returned by our own creation, never a reopened PID.
    if (WaitForSingleObject(child.hProcess, 0) != WAIT_OBJECT_0) TerminateProcess(child.hProcess, 0);
    const DWORD wait = WaitForSingleObject(child.hProcess, 5000);
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
    printf("{\"exited\":%s,\"pid\":%lu,\"creationTime100ns\":\"%llu\"}\n", wait == WAIT_OBJECT_0 ? "true" : "false", child.dwProcessId, time);
    return wait == WAIT_OBJECT_0 ? 0 : 6;
}
