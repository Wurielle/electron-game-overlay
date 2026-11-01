#pragma once

#include <windows.h>
#include <d3d12.h>

// This owned fixture ABI transfers the two COM references exactly once after
// the loader has completed DLL initialization. No C++ ownership crosses it.
struct EarlyOriginalGraphicsV1
{
    UINT struct_size;
    HRESULT device_result;
    HRESULT queue_result;
    BOOL original_dll_attach_entered;
    BOOL original_dll_attach_returned;
    BOOL initializer_entered;
    BOOL initializer_returned;
    BOOL trace_okay;
    ID3D12Device *device;
    ID3D12CommandQueue *queue;
};

#if defined(EARLY_ORIGINAL_GRAPHICS_EXPORTS)
#define EARLY_ORIGINAL_GRAPHICS_API __declspec(dllexport)
#else
#define EARLY_ORIGINAL_GRAPHICS_API __declspec(dllimport)
#endif

extern "C" EARLY_ORIGINAL_GRAPHICS_API BOOL WINAPI
EarlyOriginalGraphicsTakeV1(EarlyOriginalGraphicsV1 *output);

// Called by the executable's CRT initializer after DLL loader initialization,
// before wmain. DllMain itself only records its attach boundary.
extern "C" EARLY_ORIGINAL_GRAPHICS_API BOOL WINAPI
EarlyOriginalGraphicsInitializeV1();
