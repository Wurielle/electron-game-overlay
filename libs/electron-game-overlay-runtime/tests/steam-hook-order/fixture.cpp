#include <Windows.h>
#include <dxgi1_2.h>
#include <cstdio>
#include <cwchar>
struct state_v1 { unsigned size, factory_calls, installed, skipped, chain_calls; };
int wmain(int argc, wchar_t **argv)
{
    if (argc != 7) return 64; // runtime, model, owned config, load order, expectation, environment key
    if (std::wcscmp(argv[6], L"present") != 0 && std::wcscmp(argv[6], L"absent") != 0) return 64;
    if (std::wcscmp(argv[5], L"match") != 0 && std::wcscmp(argv[5], L"mismatch") != 0) return 64;
    if (!SetEnvironmentVariableW(L"SteamOverlayGameId", std::wcscmp(argv[6], L"present") == 0 ? L"1" : nullptr) ||
        !SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE", argv[3])) return 65;
    HMODULE model = nullptr;
    const auto steam = [&] {
        model = LoadLibraryW(argv[2]);
        if (!model) return false;
        const auto start = reinterpret_cast<DWORD(*)()>(GetProcAddress(model, "SteamModelStart"));
        return start && start() == 0;
    };
    if (std::wcscmp(argv[4], L"steam-first") == 0) {
        if (!steam() || !LoadLibraryW(argv[1])) return 66;
    } else if (std::wcscmp(argv[4], L"reshade-first") == 0) {
        if (!LoadLibraryW(argv[1]) || !steam()) return 66;
    } else if (std::wcscmp(argv[4], L"no-model") == 0) {
        if (!LoadLibraryW(argv[1])) return 66;
    } else return 64;
    const auto dxgi = LoadLibraryW(L"dxgi.dll");
    if (!dxgi) return 67;
    const auto create = reinterpret_cast<HRESULT(WINAPI *)(REFIID,void **)>(GetProcAddress(dxgi,"CreateDXGIFactory1"));
    IDXGIFactory1 *factory = nullptr;
    if (!create || FAILED(create(IID_PPV_ARGS(&factory)))) return 68;
    // Exercise the actual resulting chain. No device, HWND, graphics or input.
    factory->CreateSwapChain(nullptr,nullptr,nullptr);
    factory->Release();
    if (!model) {
        std::puts("{\"status\":\"passed\",\"noModelFactoryCreated\":true,\"actualSteam\":false}");
        return 0;
    }
    const auto query = reinterpret_cast<const state_v1 *(*)()>(GetProcAddress(model, "SteamModelState"));
    const auto s = query ? query() : nullptr;
    if (!s || s->size != sizeof(state_v1)) return 69;
    const bool coexist = s->installed > 0 && s->skipped == 0;
    const bool expected = std::wcscmp(argv[5], L"match") == 0;
    std::printf("{\"status\":\"%s\",\"genericFactoryHookRegistration\":%s,\"factoryCalls\":%u,\"installed\":%u,\"skipped\":%u,\"chainCalls\":%u,\"actualSteam\":false}\n",
        coexist == expected ? "passed" : "failed",coexist ? "true" : "false",s->factory_calls,s->installed,s->skipped,s->chain_calls);
    return coexist == expected ? 0 : 2;
}
