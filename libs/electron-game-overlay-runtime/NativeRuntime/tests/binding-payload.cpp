#define WIN32_LEAN_AND_MEAN
#include <windows.h>

BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID)
{
    if (reason != DLL_PROCESS_ATTACH)
        return TRUE;
    wchar_t marker[32768]{};
    const DWORD length = GetEnvironmentVariableW(
        L"EGO_BINDING_FIXTURE_MARKER", marker, 32768);
    if (length == 0 || length >= 32768)
        return FALSE;
    const HANDLE file = CreateFileW(marker, GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return FALSE;
    const DWORD pid = GetCurrentProcessId();
    DWORD written = 0;
    const BOOL ok = WriteFile(file, &pid, sizeof(pid), &written, nullptr);
    CloseHandle(file);
    return ok && written == sizeof(pid);
}
