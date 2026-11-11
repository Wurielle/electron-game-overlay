#include <Windows.h>
#include <dxgi1_2.h>
using present_fn = HRESULT(STDMETHODCALLTYPE *)(void *, UINT, UINT);
using present1_fn = HRESULT(STDMETHODCALLTYPE *)(void *, UINT, UINT, const DXGI_PRESENT_PARAMETERS *);
static present_fn original;
static present1_fn original1;
static unsigned calls;
extern "C" __declspec(dllexport) void WINAPI ConfigureSnapshotForeign(void *p, void *p1) {
    original = reinterpret_cast<present_fn>(p); original1 = reinterpret_cast<present1_fn>(p1);
}
extern "C" __declspec(dllexport) HRESULT STDMETHODCALLTYPE SnapshotForeignPresent(void *chain, UINT interval, UINT flags) {
    ++calls; return original(chain, interval, flags);
}
extern "C" __declspec(dllexport) HRESULT STDMETHODCALLTYPE SnapshotForeignPresent1(void *chain, UINT interval, UINT flags, const DXGI_PRESENT_PARAMETERS *parameters) {
    ++calls; return original1(chain, interval, flags, parameters);
}
extern "C" __declspec(dllexport) unsigned WINAPI SnapshotForeignCalls() { return calls; }
#if defined(_M_IX86)
#pragma comment(linker, "/EXPORT:ConfigureSnapshotForeign=_ConfigureSnapshotForeign@8")
#pragma comment(linker, "/EXPORT:SnapshotForeignPresent=_SnapshotForeignPresent@12")
#pragma comment(linker, "/EXPORT:SnapshotForeignPresent1=_SnapshotForeignPresent1@16")
#pragma comment(linker, "/EXPORT:SnapshotForeignCalls=_SnapshotForeignCalls@0")
#endif
