#include <Windows.h>
// Merely makes a real LoadLibrary return through the production host's hook.
BOOL WINAPI DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
