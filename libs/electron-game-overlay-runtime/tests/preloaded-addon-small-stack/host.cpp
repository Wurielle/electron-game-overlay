#include <Windows.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <string>
#include <system_error>

namespace
{
volatile LONG registration_count = 0;
volatile LONG event_count = 0;
alignas(void *) unsigned char inert_imgui_table[sizeof(void *)] = {};

struct worker_context
{
    volatile LONG entered = 0;
    std::uint64_t allocation_base = 0;
    std::uint64_t stack_address = 0;
};

DWORD WINAPI small_stack_worker(void *opaque)
{
    auto &context = *static_cast<worker_context *>(opaque);
    // DLL_THREAD_ATTACH has already run for the actual candidate DLL before
    // Windows calls this entry point. The fixture never calls DllMain itself.
    unsigned char stack_marker = 0;
    MEMORY_BASIC_INFORMATION information = {};
    if (VirtualQuery(&stack_marker, &information, sizeof(information)) == 0)
        return GetLastError();
    context.allocation_base = reinterpret_cast<std::uintptr_t>(information.AllocationBase);
    context.stack_address = reinterpret_cast<std::uintptr_t>(&stack_marker);
    InterlockedExchange(&context.entered, 1);
    return ERROR_SUCCESS;
}

int fail(const char *phase, DWORD error)
{
    std::fprintf(stderr,
        "preloaded add-on small-stack fixture failed: phase=%s win32Error=%lu\n",
        phase, static_cast<unsigned long>(error));
    return 1;
}
} // namespace

// This executable is an inert API-18 host shim. It supplies only the exports
// needed by the candidate's process-attach path; it has no graphics device,
// runtime, callback dispatch, input hook, producer, or transport implementation.
extern "C" __declspec(dllexport) bool ReShadeRegisterAddon(void *module, std::uint32_t version)
{
    if (module == nullptr || version != 18)
        return false;
    InterlockedIncrement(&registration_count);
    return true;
}
extern "C" __declspec(dllexport) void ReShadeUnregisterAddon(void *) {}
extern "C" __declspec(dllexport) void ReShadeRegisterEvent(std::uint32_t, void *callback)
{
    if (callback != nullptr)
        InterlockedIncrement(&event_count);
}
extern "C" __declspec(dllexport) void ReShadeUnregisterEvent(std::uint32_t, void *) {}
extern "C" __declspec(dllexport) const void *ReShadeGetImGuiFunctionTable(std::uint32_t)
{
    // No function in this table is invoked: no event callback is dispatched.
    return inert_imgui_table;
}
extern "C" __declspec(dllexport) void ReShadeLogMessage(void *, int, const char *) {}

#if defined(_M_IX86)
#pragma comment(linker, "/EXPORT:ReShadeRegisterAddon=_ReShadeRegisterAddon")
#pragma comment(linker, "/EXPORT:ReShadeUnregisterAddon=_ReShadeUnregisterAddon")
#pragma comment(linker, "/EXPORT:ReShadeRegisterEvent=_ReShadeRegisterEvent")
#pragma comment(linker, "/EXPORT:ReShadeUnregisterEvent=_ReShadeUnregisterEvent")
#pragma comment(linker, "/EXPORT:ReShadeGetImGuiFunctionTable=_ReShadeGetImGuiFunctionTable")
#pragma comment(linker, "/EXPORT:ReShadeLogMessage=_ReShadeLogMessage")
#endif

int wmain(int argc, wchar_t **argv)
{
    if (argc != 3 || std::wstring(argv[1]) != L"--addon")
        return fail("arguments: --addon <absolute-preloaded-addon-path>", ERROR_INVALID_PARAMETER);
    const std::filesystem::path supplied(argv[2]);
    if (!supplied.is_absolute())
        return fail("absolute-addon-path", ERROR_BAD_PATHNAME);
    std::error_code error;
    const auto candidate = std::filesystem::canonical(supplied, error);
    if (error)
        return fail("canonical-addon-path", static_cast<DWORD>(error.value()));
    const auto leaf = candidate.filename().wstring();
#if defined(_WIN64)
    constexpr wchar_t extension[] = L".addon64";
#else
    constexpr wchar_t extension[] = L".addon32";
#endif
    // Native DllMain performs full filename/build validation. Requiring the
    // reserved prefix here ensures the test loads that preloaded code path.
    if (leaf.compare(0, 12, L"ego-preload-") != 0 || candidate.extension() != extension)
        return fail("architecture-specific-preload-filename", ERROR_INVALID_NAME);
    const DWORD attributes = GetFileAttributesW(candidate.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        return fail("regular-addon-file", ERROR_INVALID_DATA);

    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    // The source file is only read. The external controller supplies an owned
    // staged path; the fixture never copies files or writes any configuration.
    const HMODULE addon = LoadLibraryExW(candidate.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (addon == nullptr)
        return fail("load-actual-addon", GetLastError());
    using initialize = bool (*)(HMODULE, HMODULE);
    const auto addon_init = reinterpret_cast<initialize>(GetProcAddress(addon, "AddonInit"));
    if (addon_init == nullptr || !addon_init(addon, GetModuleHandleW(nullptr)))
        return fail("actual-addon-init", ERROR_DLL_INIT_FAILED);
    const auto ready = reinterpret_cast<volatile LONG *>(
        GetProcAddress(addon, "ElectronGameOverlayCooperativeReadyV1"));
    const auto adapter_ready = reinterpret_cast<volatile LONG *>(
        GetProcAddress(addon, "ElectronGameOverlayCooperativeAdapterReadyV1"));
    if (ready == nullptr || adapter_ready == nullptr ||
        InterlockedCompareExchange(ready, 0, 0) != 0 ||
        InterlockedCompareExchange(adapter_ready, 0, 0) != 1 ||
        InterlockedCompareExchange(&registration_count, 0, 0) != 1 ||
        InterlockedCompareExchange(&event_count, 0, 0) != 5)
        return fail("dormant-baseline-registration", ERROR_INVALID_STATE);

    constexpr std::array<SIZE_T, 3> requested_stacks = {16 * 1024, 32 * 1024, 64 * 1024};
    std::array<worker_context, requested_stacks.size()> workers = {};
    for (std::size_t index = 0; index < requested_stacks.size(); ++index)
    {
        const HANDLE thread = CreateThread(nullptr, requested_stacks[index], small_stack_worker,
            &workers[index], STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr);
        if (thread == nullptr)
            return fail("create-small-stack-thread", GetLastError());
        const DWORD waited = WaitForSingleObject(thread, 10000);
        const DWORD wait_error = waited == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
        DWORD exit_code = STILL_ACTIVE;
        const BOOL got_exit_code = GetExitCodeThread(thread, &exit_code);
        const DWORD exit_error = got_exit_code ? ERROR_SUCCESS : GetLastError();
        CloseHandle(thread);
        if (waited != WAIT_OBJECT_0)
            return fail("wait-small-stack-thread", wait_error);
        if (!got_exit_code)
            return fail("small-stack-thread-exit-code", exit_error);
        if (exit_code != ERROR_SUCCESS ||
            InterlockedCompareExchange(&workers[index].entered, 0, 0) != 1)
            return fail("worker-entry-and-detach", exit_code != ERROR_SUCCESS ? exit_code : ERROR_INVALID_STATE);
    }

    std::printf("{\"status\":\"passed\",\"scope\":\"actual-addon-dll-thread-notifications-in-inert-console-host\","
        "\"requestedStackBytes\":[16384,32768,65536],\"workerEntryAcks\":3,\"completedThreads\":3,"
        "\"registrations\":1,\"registeredEvents\":5,\"participantReady\":0,\"stacks\":[");
    for (std::size_t index = 0; index < workers.size(); ++index)
    {
        std::printf("%s{\"requestedBytes\":%llu,\"allocationBase\":%llu,\"workerStackAddress\":%llu}",
            index == 0 ? "" : ",", static_cast<unsigned long long>(requested_stacks[index]),
            static_cast<unsigned long long>(workers[index].allocation_base),
            static_cast<unsigned long long>(workers[index].stack_address));
    }
    std::puts("]}");
    // AddonInit intentionally PINs the actual baseline image until process
    // exit. No explicit FreeLibrary or manual notification is used here.
    return 0;
}
