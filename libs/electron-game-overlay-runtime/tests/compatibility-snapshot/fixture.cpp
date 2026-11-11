// Exact production observation helpers, actual owned foreign DLL and MinHook chain.
// No ReShade runtime, graphics device, HWND, COM invocation, input or injection.
#include <Windows.h>
#include <dxgi1_2.h>
#include <MinHook.h>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#include <new>
static bool log_throws;
static bool allocation_fails;
static std::vector<std::string> records;
namespace reshade::log {
enum class level { info };
void message(level, const char *format, ...) {
    if (allocation_fails) throw std::bad_alloc();
    if (log_throws) throw std::runtime_error("owned log failure");
    char output[4096] {}; va_list args; va_start(args, format);
    const int count = vsnprintf(output, sizeof(output), format, args); va_end(args);
    if (count <= 0 || count >= sizeof(output)) throw std::runtime_error("diagnostic overflow");
    records.emplace_back(output);
    SetLastError(0xBAD); // Observer must restore the caller's last error.
}
}
HMODULE g_module_handle;
#include EGO_SNAPSHOT_HEADER
using present_fn = HRESULT(STDMETHODCALLTYPE *)(void *, UINT, UINT);
using present1_fn = HRESULT(STDMETHODCALLTYPE *)(void *, UINT, UINT, const DXGI_PRESENT_PARAMETERS *);
static unsigned native_calls;
static void *observed_chain;
static UINT observed_interval, observed_flags;
static const DXGI_PRESENT_PARAMETERS *observed_parameters;
extern "C" __declspec(noinline) HRESULT STDMETHODCALLTYPE NativePresent(void *chain, UINT interval, UINT flags) {
    ++native_calls; observed_chain = chain; observed_interval = interval; observed_flags = flags;
    return DXGI_ERROR_WAS_STILL_DRAWING;
}
extern "C" __declspec(noinline) HRESULT STDMETHODCALLTYPE NativePresent1(void *chain, UINT interval, UINT flags, const DXGI_PRESENT_PARAMETERS *parameters) {
    ++native_calls; observed_chain = chain; observed_interval = interval; observed_flags = flags; observed_parameters = parameters;
    return DXGI_ERROR_DEVICE_REMOVED;
}
int wmain(int argc, wchar_t **argv) {
    unsigned assertions = 0;
    const auto check = [&](bool value) { ++assertions; if (!value) throw std::runtime_error("snapshot contract assertion"); };
    try {
        check(argc == 2); g_module_handle = GetModuleHandleW(nullptr);
        const HMODULE foreign = LoadLibraryW(argv[1]); check(foreign != nullptr);
        const auto replacement = reinterpret_cast<void *>(GetProcAddress(foreign, "SnapshotForeignPresent"));
        const auto replacement1 = reinterpret_cast<void *>(GetProcAddress(foreign, "SnapshotForeignPresent1"));
        const auto configure = reinterpret_cast<void(WINAPI *)(void *, void *)>(GetProcAddress(foreign, "ConfigureSnapshotForeign"));
        const auto foreign_calls = reinterpret_cast<unsigned(WINAPI *)()>(GetProcAddress(foreign, "SnapshotForeignCalls"));
        check(replacement && replacement1 && configure && foreign_calls);
        check(MH_Initialize() == MH_OK);
        void *saved = nullptr, *saved1 = nullptr;
        check(MH_CreateHook(reinterpret_cast<void *>(&NativePresent), replacement, &saved) == MH_OK);
        check(MH_CreateHook(reinterpret_cast<void *>(&NativePresent1), replacement1, &saved1) == MH_OK);
        configure(saved, saved1); check(MH_EnableHook(MH_ALL_HOOKS) == MH_OK);
        using namespace ego_compatibility_snapshot;
        check(std::strcmp(owner(replacement), "other-image") == 0);
        check(std::strcmp(owner(reinterpret_cast<void *>(&NativePresent)), "reshade-host") == 0);
        check(std::strcmp(owner(saved), "private-code") == 0);
        const auto detour = observe_entry_jump(reinterpret_cast<void *>(&NativePresent));
        check(std::strcmp(detour.owner, "other-image") == 0 && detour.hops > 0 && detour.hops <= 2);
        check(observe_entry_jump(nullptr).hops == 0);
        SetLastError(0x369A);
        check(std::strcmp(observe_entry_jump(reinterpret_cast<void *>(1)).owner, "unreadable") == 0 && GetLastError() == 0x369A);
        const unsigned char unsupported[6] { 0x90, 0x90, 0x90, 0x90, 0x90, 0x90 };
        const auto unknown_entry = observe_entry_jump(unsupported);
        check(unknown_entry.hops == 0 && std::strcmp(unknown_entry.owner, "unknown-entry") == 0);
#ifdef EGO_SNAPSHOT_DESTINATIONS
        // Proposed address-only diagnostic: independently known module/range and
        // deliberately malformed jump controls. None of these bytes are executed.
        check(detour.destination == replacement && detour.first != nullptr);
        check(detour.hops == 1 ? detour.second == nullptr : detour.second == replacement);
        const auto foreign_range = observe_allocation(detour.destination);
        check(foreign_range.base == foreign);
        check(foreign_range.offset == reinterpret_cast<std::uintptr_t>(replacement) - reinterpret_cast<std::uintptr_t>(foreign));
        MEMORY_BASIC_INFORMATION saved_memory {};
        check(VirtualQuery(saved, &saved_memory, sizeof(saved_memory)) == sizeof(saved_memory));
        check(observe_allocation(saved).base == saved_memory.AllocationBase);
        const auto absent = observe_entry_jump(nullptr), inaccessible = observe_entry_jump(reinterpret_cast<void *>(1));
        check(absent.destination == nullptr && absent.first == nullptr && absent.second == nullptr);
        check(inaccessible.destination == reinterpret_cast<void *>(1) && inaccessible.hops == 0);
        check(observe_allocation(nullptr).base == nullptr && observe_allocation(reinterpret_cast<void *>(1)).base == nullptr);
        check(unknown_entry.destination == unsupported && unknown_entry.first == nullptr && unknown_entry.second == nullptr);
        auto *bytes = static_cast<unsigned char *>(VirtualAlloc(nullptr, 8192, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        check(bytes != nullptr);
        bytes[0] = bytes[16] = 0xE9;
        const std::int32_t forward = 11, backward = -21;
        std::memcpy(bytes + 1, &forward, 4); std::memcpy(bytes + 17, &backward, 4);
        const auto cycle = observe_entry_jump(bytes);
        check(cycle.hops == 2 && cycle.first == bytes + 16 && cycle.second == bytes && cycle.destination == bytes);
        check(observe_allocation(cycle.destination).base == bytes && observe_allocation(cycle.destination).offset == 0);
        bytes[32] = 0xFF; bytes[33] = 0x25;
#ifdef _WIN64
        const std::int32_t displacement = 26; std::memcpy(bytes + 34, &displacement, 4);
#else
        const auto absolute = reinterpret_cast<std::uintptr_t>(bytes + 64); std::memcpy(bytes + 34, &absolute, 4);
#endif
        std::memcpy(bytes + 64, &replacement, sizeof(replacement));
        const auto indirect = observe_entry_jump(bytes + 32);
        check(indirect.hops == 1 && indirect.first == replacement && indirect.destination == replacement && indirect.second == nullptr);
        DWORD old = 0; check(VirtualProtect(bytes + 4096, 4096, PAGE_NOACCESS, &old) != FALSE);
        const auto boundary = observe_entry_jump(bytes + 4093);
        check(boundary.hops == 0 && boundary.destination == bytes + 4093 && std::strcmp(boundary.owner, "unreadable") == 0);
        check(VirtualFree(bytes, 0, MEM_RELEASE) != FALSE);
        check(native_calls == 0 && foreign_calls() == 0);
#endif
        SetLastError(0x2468); loader(true, true, {true, false}); check(GetLastError() == 0x2468);
        loader(false, true, {false, false}); check(records.size() == 1);
        for (unsigned scenario = 0; scenario != 3; ++scenario) {
            unsigned ticket = 0;
            if (scenario == 0) { const discovery_scope discovery; ticket = factory_begin(0x80000000u, true); check(discovery_depth == 1); check(factory_begin(0x80000000u, true) == 0); }
            else ticket = factory_begin(0, scenario == 1);
            check(ticket != 0); check(discovery_depth == 0);
            factory_result(ticket, S_OK, saved, replacement, saved, replacement);
        }
        callbacks("native-registration", "fixture", "Present", nullptr, nullptr, nullptr, replacement, reinterpret_cast<void *>(&NativePresent), saved, false);
        callbacks("native-registration", "fixture", "Present1", nullptr, nullptr, nullptr, replacement1, reinterpret_cast<void *>(&NativePresent1), saved1, false);
        check(native_calls == 0 && foreign_calls() == 0);
        struct owned_identity { LONG references = 1; } identity;
        DXGI_PRESENT_PARAMETERS parameters {};
        for (bool proxy : {true, false}) for (bool extended : {false, true}) {
            check(!claim_present(proxy, extended, DXGI_PRESENT_TEST));
            for (unsigned repeat = 0; repeat != 2; ++repeat) {
                const bool first = claim_present(proxy, extended, 0); check(first == (repeat == 0));
                if (first) callbacks("present-entry", proxy ? "proxy" : "raw", extended ? "Present1" : "Present", &identity, &identity, nullptr, extended ? replacement1 : replacement, extended ? reinterpret_cast<void *>(&NativePresent1) : reinterpret_cast<void *>(&NativePresent), extended ? saved1 : saved, false);
                HRESULT hr;
                if (extended) { present1_fn volatile call = &NativePresent1; hr = call(&identity, 3, DXGI_PRESENT_DO_NOT_WAIT, &parameters); }
                else { present_fn volatile call = &NativePresent; hr = call(&identity, 3, DXGI_PRESENT_DO_NOT_WAIT); }
                if (first) present_end(proxy, extended, hr);
                check(hr == (extended ? DXGI_ERROR_DEVICE_REMOVED : DXGI_ERROR_WAS_STILL_DRAWING));
                check(observed_chain == &identity && observed_interval == 3 && observed_flags == DXGI_PRESENT_DO_NOT_WAIT);
                if (extended) check(observed_parameters == &parameters);
                check(identity.references == 1); // The observer performs no reference operations.
            }
        }
        check(native_calls == 8 && foreign_calls() == 8); check(records.size() == 17);
        SetLastError(0x9876);
        for (bool proxy : {true, false}) for (bool extended : {false, true}) check(!claim_present(proxy, extended, 0));
        check(factory_begin(0, false) == 0 && factory_begin(0, true) == 0);
        { const discovery_scope discovery; check(factory_begin(0, true) == 0); }
        loader(true, true, {true, true}); check(GetLastError() == 0x9876 && records.size() == 17);
        log_throws = true; SetLastError(0x1357);
        callbacks("owned-log-failure", "fixture", "Present", nullptr, nullptr, nullptr, replacement, saved, saved, false);
        check(GetLastError() == 0x1357 && records.size() == 17);
        allocation_fails = true; SetLastError(0x157A);
        callbacks("owned-allocation-failure", "fixture", "Present", nullptr, nullptr, nullptr, replacement, saved, saved, false);
        check(GetLastError() == 0x157A && records.size() == 17);
        present_fn volatile exhausted_call = &NativePresent;
        check(exhausted_call(&identity, 3, DXGI_PRESENT_DO_NOT_WAIT) == DXGI_ERROR_WAS_STILL_DRAWING);
        check(native_calls == 9 && foreign_calls() == 9 && identity.references == 1);
        check(MH_DisableHook(MH_ALL_HOOKS) == MH_OK); check(MH_Uninitialize() == MH_OK);
        for (const auto &record : records) std::puts(record.c_str());
        std::printf("{\"status\":\"passed\",\"assertions\":%u,\"records\":17,\"nativeCalls\":%u,\"foreignCalls\":%u,\"referenceCount\":1,\"graphics\":false,\"input\":false,\"actualSteam\":false}\n", assertions, native_calls, foreign_calls());
        FreeLibrary(foreign); return 0;
    } catch (const std::exception &error) { std::fprintf(stderr, "%s after %u assertions\n", error.what(), assertions); return 1; }
}
