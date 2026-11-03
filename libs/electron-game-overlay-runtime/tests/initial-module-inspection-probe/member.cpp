// Inert module loaded and freed locally by an owned console child only.
#include <Windows.h>
extern "C" { __declspec(dllexport) unsigned int EgoInitialModuleProbeMarker = 1; }
BOOL WINAPI DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
