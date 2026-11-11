// Owned model of the documented Steam rule, not Valve code or Steam acceptance.
#include <Windows.h>
#include <dxgi1_2.h>
#include <MinHook.h>
#include <cstring>
struct state_v1 { unsigned size, factory_calls, installed, skipped, chain_calls; };
static state_v1 state{sizeof(state_v1)};
using create_factory_fn = HRESULT(WINAPI *)(REFIID, void **);
using create_chain_fn = HRESULT(STDMETHODCALLTYPE *)(IDXGIFactory *, IUnknown *, DXGI_SWAP_CHAIN_DESC *, IDXGISwapChain **);
static create_factory_fn original_factory;
static create_chain_fn original_chain;
static decltype(&LoadLibraryW) original_load;
static bool installing;
static HRESULT STDMETHODCALLTYPE chain_hook(IDXGIFactory *factory, IUnknown *device, DXGI_SWAP_CHAIN_DESC *desc, IDXGISwapChain **chain)
{ ++state.chain_calls; return original_chain(factory, device, desc, chain); }
static HRESULT WINAPI factory_hook(REFIID iid, void **out)
{
    const HRESULT hr = original_factory(iid, out);
    if (FAILED(hr)) return hr;
    ++state.factory_calls;
    auto table = *reinterpret_cast<void ***>(*out);
    if (table[10] == reinterpret_cast<void *>(&chain_hook)) return hr;
    HMODULE owner = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(table[10]), &owner);
    // Mirrors the upstream ReShade comment: skip a vtable belonging to another
    // module. The fixture never loads or modifies the real Steam overlay DLL.
    if (owner != GetModuleHandleW(L"dxgi.dll")) { ++state.skipped; return hr; }
    original_chain = reinterpret_cast<create_chain_fn>(table[10]);
    DWORD old = 0; VirtualProtect(table + 10, sizeof(void *), PAGE_READWRITE, &old);
    table[10] = reinterpret_cast<void *>(&chain_hook);
    VirtualProtect(table + 10, sizeof(void *), old, &old);
    ++state.installed;
    return hr;
}
static HMODULE WINAPI load_hook(LPCWSTR name)
{
    const HMODULE module = original_load(name);
    if (!installing && module && module == GetModuleHandleW(L"dxgi.dll") && original_factory == nullptr) {
        installing = true;
        const auto target = GetProcAddress(module, "CreateDXGIFactory1");
        if (MH_CreateHook(target, &factory_hook, reinterpret_cast<void **>(&original_factory)) == MH_OK)
            MH_EnableHook(target);
        installing = false;
    }
    return module;
}
extern "C" __declspec(dllexport) const state_v1 *SteamModelState() { return &state; }
extern "C" __declspec(dllexport) DWORD SteamModelStart()
{
    if (MH_Initialize() != MH_OK) return 1;
    if (MH_CreateHook(&LoadLibraryW, &load_hook, reinterpret_cast<void **>(&original_load)) != MH_OK) return 2;
    return MH_EnableHook(&LoadLibraryW) == MH_OK ? 0 : 3;
}
