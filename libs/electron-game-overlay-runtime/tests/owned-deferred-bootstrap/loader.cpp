// Controlled nested load only. Never create a device or wait inside DllMain.
#include <Windows.h>
#include <cwchar>
static DWORD load_backend() {
    wchar_t system[MAX_PATH]{}, path[MAX_PATH]{};
    const UINT size=GetSystemDirectoryW(system,MAX_PATH);
    if (!size || size>=MAX_PATH) return ERROR_INSUFFICIENT_BUFFER;
    if (swprintf_s(path,L"%s\\d3d11.dll",system)<0) return ERROR_INSUFFICIENT_BUFFER;
    return LoadLibraryW(path) ? ERROR_SUCCESS : GetLastError();
}
extern "C" __declspec(dllexport) DWORD WINAPI LoadBackendV1() { return load_backend(); }
BOOL WINAPI DllMain(HMODULE, DWORD reason, LPVOID) {
#if defined(LOAD_IN_DLLMAIN)
    if (reason==DLL_PROCESS_ATTACH) return load_backend()==ERROR_SUCCESS;
#else
    (void)reason;
#endif
    return TRUE;
}
#if defined(_M_IX86)
#pragma comment(linker,"/EXPORT:LoadBackendV1=_LoadBackendV1@0")
#endif
