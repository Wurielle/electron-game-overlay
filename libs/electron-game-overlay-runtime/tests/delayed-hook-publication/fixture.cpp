// Production host, real LoadLibrary/D3D11 and two event-ordered owned threads.
// The sole fixture detour pauses a Win32 call made within the host's delayed
// scan; no private mutex/layout/address, Steam/game hook or production patch.
#include "contract.hpp"
#include <d3d11.h>
#include <wrl/client.h>
#include <MinHook.h>
#include <intrin.h>
#include <atomic>
#include <thread>
#include <string>
#include <cstdio>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
static std::atomic<unsigned> assertions {0};
static void check(bool value, const char *message) { ++assertions; if (!value) throw std::runtime_error(message); }
static void hr(HRESULT result, const char *message) { if (FAILED(result)) std::fprintf(stderr, "%s HRESULT=%08lx\n", message, result); check(SUCCEEDED(result), message); }
static std::uint64_t ticks() { FILETIME value{}; GetSystemTimePreciseAsFileTime(&value); return (std::uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
template<class T> static T symbol(HMODULE module, const char *name) { const auto result = reinterpret_cast<T>(GetProcAddress(module, name)); check(result != nullptr, name); return result; }
static HMODULE address_owner(void *address) { MEMORY_BASIC_INFORMATION info{}; return VirtualQuery(address, &info, sizeof(info)) ? static_cast<HMODULE>(info.AllocationBase) : nullptr; }
struct fixture_threads {
    HANDLE entered = CreateEventW(nullptr, TRUE, FALSE, nullptr), release = CreateEventW(nullptr, TRUE, FALSE, nullptr),
        device_ready = CreateEventW(nullptr, TRUE, FALSE, nullptr), published = CreateEventW(nullptr, TRUE, FALSE, nullptr),
        loader_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::thread loader, graphics;
    ~fixture_threads() {
        SetEvent(release); SetEvent(published);
        if (loader.joinable()) loader.join(); if (graphics.joinable()) graphics.join();
        for (HANDLE handle : {entered, release, device_ready, published, loader_done}) if (handle) CloseHandle(handle);
    }
};
static fixture_threads *sync_state = nullptr;
static HMODULE host_module = nullptr;
static std::atomic<DWORD> loader_thread {0};
static std::atomic<bool> armed {false}, claimed {false}, barrier_timeout {false};
static std::uint64_t entered_at = 0, released_at = 0;
static std::atomic<std::uint64_t> loader_done_at {0};
static std::uintptr_t barrier_return = 0;
static wchar_t scanned_path[512] {};
using module_query_fn = BOOL (WINAPI *)(DWORD, LPCWSTR, HMODULE *);
static module_query_fn original_query = nullptr;
static BOOL WINAPI controlled_module_query(DWORD flags, LPCWSTR name, HMODULE *result) {
    const auto caller = _ReturnAddress();
    if (armed.load() && GetCurrentThreadId() == loader_thread.load() &&
        (flags & (GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS)) == GET_MODULE_HANDLE_EX_FLAG_PIN &&
        name != nullptr && address_owner(caller) == host_module) {
        bool expected = false;
        if (claimed.compare_exchange_strong(expected, true)) {
            wcsncpy_s(scanned_path, name, _TRUNCATE); barrier_return = reinterpret_cast<std::uintptr_t>(caller);
            entered_at = ticks(); SetEvent(sync_state->entered);
            if (WaitForSingleObject(sync_state->release, 10000) != WAIT_OBJECT_0) barrier_timeout = true;
            released_at = ticks();
        }
    }
    return original_query(flags, name, result);
}
static void wait(HANDLE event, const char *message) { check(WaitForSingleObject(event, 10000) == WAIT_OBJECT_0, message); }
static device_counts_v1 counts(query_device_counts_fn query) { device_counts_v1 result; check(query(&result) == ERROR_SUCCESS, "public test counter query"); return result; }
static void readback(ID3D11Device *device, ID3D11DeviceContext *context) {
    D3D11_TEXTURE2D_DESC desc{}; desc.Width = desc.Height = 16; desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1; desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    ComPtr<ID3D11Texture2D> texture, staging; ComPtr<ID3D11RenderTargetView> view;
    hr(device->CreateTexture2D(&desc, nullptr, &texture), "real render texture");
    hr(device->CreateRenderTargetView(texture.Get(), nullptr, &view), "real render target");
    const float green[4] {0, 1, 0, 1}; context->ClearRenderTargetView(view.Get(), green);
    desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr(device->CreateTexture2D(&desc, nullptr, &staging), "real staging texture"); context->CopyResource(staging.Get(), texture.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{}; hr(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "real GPU readback");
    const auto pixel = static_cast<const BYTE *>(mapped.pData); const bool green_read = pixel[0] == 0 && pixel[1] == 255 && pixel[2] == 0 && pixel[3] == 255;
    context->Unmap(staging.Get(), 0); check(green_read, "green pixel from actual D3D11 device");
}
int wmain(int argc, wchar_t **argv) try {
    check(argc == 6, "HOST COUNTER TRIGGER STAGE serialized|contended required"); const bool contended = std::wcscmp(argv[5], L"contended") == 0;
    check(contended || std::wcscmp(argv[5], L"serialized") == 0, "known case");
    check(GetModuleHandleW(L"d3d11.dll") == nullptr && GetModuleHandleW(L"dxgi.dll") == nullptr, "no graphics preloaded by fixture imports");
    check(SetEnvironmentVariableW(L"SteamOverlayGameId", L"1") != FALSE, "owned environment selects production LoadLibrary lane");
    check(SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE", argv[4]) != FALSE, "owned stage override");
    host_module = LoadLibraryW(argv[1]); check(host_module != nullptr, "unmodified production host loaded");
    auto gate = symbol<volatile LONG *>(host_module, "ElectronGameOverlayReShadeAddonGate");
    check(InterlockedCompareExchange(gate, 1, 0) == 0, "test adapter registration gate");
    const HMODULE counter = LoadLibraryW(argv[2]); check(counter != nullptr, "actual public device counter registration");
    check(InterlockedCompareExchange(gate, 2, 1) == 1, "test adapter publication");
    const auto query = symbol<query_device_counts_fn>(counter, "QueryDeviceCountsV1");
    check(counts(query).initialized == 0 && GetModuleHandleW(L"d3d11.dll") == nullptr, "device creation still deferred");
    // Declare shared results before the joining guard, so an exceptional main
    // path releases/joins both workers before their referenced storage dies.
    std::string loader_error, graphics_error;
    DWORD graphics_tid = 0; std::uint64_t load_return_at = 0, first_device_at = 0, second_device_at = 0;
    std::uint64_t first_count = 0, second_count = 0; bool first_proxy = false, second_proxy = false, original_still_native = false;
    fixture_threads state; sync_state = &state;
    check(state.entered && state.release && state.device_ready && state.published && state.loader_done, "owned synchronization events");
    check(MH_Initialize() == MH_OK, "owned Win32 boundary detour initialize");
    check(MH_CreateHook(reinterpret_cast<void *>(&GetModuleHandleExW), reinterpret_cast<void *>(&controlled_module_query), reinterpret_cast<void **>(&original_query)) == MH_OK, "owned Win32 boundary detour create");
    check(MH_EnableHook(reinterpret_cast<void *>(&GetModuleHandleExW)) == MH_OK, "owned Win32 boundary detour enable");
    state.loader = std::thread([&] { try { loader_thread = GetCurrentThreadId(); armed = true; const HMODULE trigger = LoadLibraryW(argv[3]); check(trigger != nullptr, "real trigger library load"); loader_done_at = ticks(); } catch (const std::exception &error) { loader_error = error.what(); } SetEvent(state.loader_done); });
    const HANDLE entry_or_done[] {state.entered, state.loader_done}; check(WaitForMultipleObjects(2, entry_or_done, FALSE, 10000) == WAIT_OBJECT_0, "real host delayed scan entered controlled Win32 boundary");
    if (!contended) { SetEvent(state.release); wait(state.loader_done, "serialized scan returned before graphics load"); }
    state.graphics = std::thread([&] { try {
        graphics_tid = GetCurrentThreadId(); wchar_t system[MAX_PATH]{}; check(GetSystemDirectoryW(system, MAX_PATH) != 0, "exact system library directory");
        const std::wstring d3d_path = std::wstring(system) + L"\\d3d11.dll"; const HMODULE d3d = LoadLibraryW(d3d_path.c_str()); check(d3d != nullptr, "real graphics LoadLibrary returned"); load_return_at = ticks();
        const auto create = symbol<PFN_D3D11_CREATE_DEVICE>(d3d, "D3D11CreateDevice");
        ComPtr<ID3D11Device> first_device, second_device; ComPtr<ID3D11DeviceContext> first_context, second_context;
        hr(create(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &first_device, nullptr, &first_context), "first real hardware device");
        first_device_at = ticks(); first_count = counts(query).initialized;
        first_proxy = address_owner((*reinterpret_cast<void ***>(first_device.Get()))[3]) == host_module;
        readback(first_device.Get(), first_context.Get()); SetEvent(state.device_ready);
        wait(state.published, "late scan publication released second device");
        hr(create(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &second_device, nullptr, &second_context), "second real hardware device through same cached function pointer");
        second_device_at = ticks(); second_count = counts(query).initialized;
        second_proxy = address_owner((*reinterpret_cast<void ***>(second_device.Get()))[3]) == host_module;
        readback(second_device.Get(), second_context.Get());
        original_still_native = address_owner((*reinterpret_cast<void ***>(first_device.Get()))[3]) != host_module;
        readback(first_device.Get(), first_context.Get());
    } catch (const std::exception &error) { graphics_error = error.what(); SetEvent(state.device_ready); } });
    wait(state.device_ready, "first real device completed while scan ordering controlled");
    if (contended) { check(loader_done_at == 0, "scan still paused when first device succeeds"); SetEvent(state.release); wait(state.loader_done, "delayed scan installed loaded D3D11 after first device"); }
    SetEvent(state.published); state.loader.join(); state.graphics.join(); armed = false;
    check(loader_error.empty(), loader_error.empty() ? "loader thread completed" : loader_error.c_str());
    check(graphics_error.empty(), graphics_error.empty() ? "graphics thread completed" : graphics_error.c_str());
    check(!barrier_timeout.load(), "barrier completed without timeout");
    check(second_proxy && second_count >= 1, "published production hooks observe a subsequent real device");
    const bool missed = !first_proxy && first_count == 0;
    check(contended ? (missed && original_still_native && first_device_at < released_at) : (first_proxy && first_count == 1), "case establishes the intended production boundary");
    const auto final_counts = counts(query);
    check(MH_DisableHook(reinterpret_cast<void *>(&GetModuleHandleExW)) == MH_OK && MH_Uninitialize() == MH_OK, "owned detour removed");
    std::printf("{\"status\":\"%s\",\"case\":\"%s\",\"assertions\":%u,\"pid\":%lu,\"loaderThread\":%lu,\"graphicsThread\":%lu,\"firstDeviceObserved\":%s,\"firstDeviceInitCallbacks\":%llu,\"secondDeviceObserved\":%s,\"secondDeviceInitCallbacks\":%llu,\"firstDeviceRemainsNative\":%s,\"gpuGreenReadbacks\":3,\"finalDeviceDestroyCallbacks\":%llu,\"barrierReturnAddress\":\"0x%llx\",\"enteredUtc100ns\":\"%llu\",\"graphicsLoadReturnUtc100ns\":\"%llu\",\"firstDeviceUtc100ns\":\"%llu\",\"releasedUtc100ns\":\"%llu\",\"scanReturnedUtc100ns\":\"%llu\",\"secondDeviceUtc100ns\":\"%llu\",\"actualSteam\":false,\"actualGame\":false,\"windowsCreated\":false,\"input\":false,\"productionLockingChanged\":false}\n",
        missed ? "reproduced-device-hook-miss" : "passed", contended ? "contended" : "serialized", assertions.load(), GetCurrentProcessId(), loader_thread.load(), graphics_tid,
        first_proxy ? "true" : "false", static_cast<unsigned long long>(first_count), second_proxy ? "true" : "false", static_cast<unsigned long long>(second_count), original_still_native ? "true" : "false", static_cast<unsigned long long>(final_counts.destroyed), static_cast<unsigned long long>(barrier_return), static_cast<unsigned long long>(entered_at), static_cast<unsigned long long>(load_return_at), static_cast<unsigned long long>(first_device_at), static_cast<unsigned long long>(released_at), static_cast<unsigned long long>(loader_done_at.load()), static_cast<unsigned long long>(second_device_at));
    return missed ? 3 : 0;
} catch (const std::exception &error) { std::fprintf(stderr, "%s after %u assertions; Win32=%lu\n", error.what(), assertions.load(), GetLastError()); return 1; }
