#include <Windows.h>
#if !defined(EGO_FIXTURE_NO_ABI)
extern "C" __declspec(dllexport) const unsigned int ElectronGameOverlayReShadeAddonAbi =
#if defined(EGO_FIXTURE_INVALID_ABI)
    2;
#else
    1;
#endif
#endif
extern "C" {
#if !defined(EGO_FIXTURE_LEGACY)
__declspec(dllexport) __declspec(align(4)) volatile LONG ElectronGameOverlayCooperativeAdapterReadyV1 = 1;
#endif
__declspec(dllexport) __declspec(align(4)) volatile LONG ElectronGameOverlayCooperativeReadyV1 = 1;
}
BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
