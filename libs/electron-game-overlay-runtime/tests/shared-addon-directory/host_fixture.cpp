// The complete initializer below is extracted from the exact candidate source.
// Its graphics and scanner dependencies are inert seams. No ReShade, native EGO
// add-on, application, graphics device or other process is opened or loaded.
#include <Windows.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <stdexcept>

struct ego_owned_late_d3d11_initialize_v1
{
    std::uint32_t struct_size = sizeof(ego_owned_late_d3d11_initialize_v1);
    std::uint32_t abi_version = 1;
    std::uint32_t flags = 0;
    std::uint32_t reserved = 0;
};
extern "C" volatile LONG ElectronGameOverlayReShadeAddonGate = 2;

namespace fixture
{
    bool adapter_ready = true;
    bool scan_succeeds = true;
    DWORD stage_error = ERROR_SUCCESS;
    DWORD d3d11_error = ERROR_SUCCESS;
    DWORD discovery_error = ERROR_SUCCESS;
    DWORD hook_error = ERROR_SUCCESS;
    unsigned scan_calls = 0, hook_calls = 0, warnings = 0;
    unsigned cases = 0, assertions = 0;
    void require(bool value, const char *message)
    {
        ++assertions;
        if (!value) throw std::runtime_error(message);
    }
}
namespace reshade
{
    bool addon_all_loaded = true;
    void load_addons()
    {
        ++fixture::scan_calls;
        addon_all_loaded = fixture::scan_succeeds;
    }
    namespace log
    {
        enum class level { warning };
        void message(level, const char *) { ++fixture::warnings; }
    }
}
namespace ego_owned_late_d3d11
{
    constexpr unsigned abi_version = 1;
    constexpr LONG addon_gate_registered = 2, addon_gate_closed = 3;
    std::mutex install_mutex;
    std::atomic<DWORD> status{0}, last_error{ERROR_SUCCESS};
    bool retained_addon_reference = false;
    DWORD validate_owned_stage(HMODULE) { return fixture::stage_error; }
    bool cooperative_adapter_ready() { return fixture::adapter_ready; }
    DWORD loaded_d3d11(HMODULE &module)
    {
        module = reinterpret_cast<HMODULE>(1);
        return fixture::d3d11_error;
    }
    DWORD discover_native_methods(HMODULE, HMODULE, std::array<void *, 4> &)
    {
        return fixture::discovery_error;
    }
    DWORD install_native_methods(const std::array<void *, 4> &)
    {
        ++fixture::hook_calls;
        return fixture::hook_error;
    }
}

#include "candidate-owned-initializer.inl"

namespace fixture
{
    void reset()
    {
        adapter_ready = true;
        scan_succeeds = true;
        stage_error = d3d11_error = discovery_error = hook_error = ERROR_SUCCESS;
        scan_calls = hook_calls = warnings = 0;
        reshade::addon_all_loaded = true;
        ego_owned_late_d3d11::status.store(0);
        ego_owned_late_d3d11::last_error.store(ERROR_SUCCESS);
        ego_owned_late_d3d11::retained_addon_reference = false;
        InterlockedExchange(&ElectronGameOverlayReShadeAddonGate, 2);
        ++cases;
    }
    DWORD initialize() { return ElectronGameOverlayInitializeOwnedLateD3D11V1(nullptr); }
    void before_scan_failure(DWORD expected)
    {
        require(initialize() == expected, "pre-scan rejection lost its exact error");
        require(scan_calls == 0 && hook_calls == 0, "pre-scan rejection executed scanner or hooks");
        require(!ego_owned_late_d3d11::retained_addon_reference, "pre-scan rejection retained an add-on reference");
    }
    void run()
    {
        for (const bool foreign_succeeds : {true, false})
        {
            reset();
            scan_succeeds = foreign_succeeds;
            require(initialize() == ERROR_SUCCESS, "ready EGO host was blocked by a foreign add-on failure");
            require(ego_owned_late_d3d11::status.load() == 2, "ready EGO host did not become active");
            require(ego_owned_late_d3d11::last_error.load() == ERROR_SUCCESS, "foreign failure became EGO error state");
            require(scan_calls == 1 && hook_calls == 1, "ready EGO host skipped scanner or hooks");
            require(ego_owned_late_d3d11::retained_addon_reference, "ready EGO host released its retained reference");
            require(warnings == (foreign_succeeds ? 0u : 1u), "foreign scanner diagnostic was lost");
            require(initialize() == ERROR_SUCCESS && scan_calls == 1 && hook_calls == 1,
                "repeated successful initialization repeated hooks or scan");

            reset();
            scan_succeeds = foreign_succeeds;
            adapter_ready = false;
            before_scan_failure(ERROR_NOT_READY);

            reset();
            scan_succeeds = foreign_succeeds;
            hook_error = ERROR_ACCESS_DENIED;
            require(initialize() == ERROR_ACCESS_DENIED, "own hook error was suppressed with foreign isolation");
            require(ego_owned_late_d3d11::status.load() == 3 &&
                ego_owned_late_d3d11::last_error.load() == ERROR_ACCESS_DENIED, "own hook error was not retained");
            require(scan_calls == 1 && hook_calls == 1 && ego_owned_late_d3d11::retained_addon_reference,
                "failed hooks lost consumed scan ownership");
            require(initialize() == ERROR_ACCESS_DENIED && scan_calls == 1 && hook_calls == 1,
                "failed initialization repeated consumed work");
        }
        for (const LONG gate : {0L, 1L, 4L})
        {
            reset();
            InterlockedExchange(&ElectronGameOverlayReShadeAddonGate, gate);
            before_scan_failure(gate == 1 ? ERROR_BUSY : ERROR_NOT_READY);
        }
        reset();
        InterlockedExchange(&ElectronGameOverlayReShadeAddonGate, 3);
        scan_succeeds = false;
        require(initialize() == ERROR_SUCCESS && scan_calls == 1 && hook_calls == 1,
            "closed gate with actual readiness was rejected");
        reset();
        stage_error = ERROR_INVALID_DATA;
        before_scan_failure(ERROR_INVALID_DATA);
        for (unsigned invalid_field = 0; invalid_field != 4; ++invalid_field)
        {
            reset();
            ego_owned_late_d3d11_initialize_v1 request;
            if (invalid_field == 0) --request.struct_size;
            if (invalid_field == 1) ++request.abi_version;
            if (invalid_field == 2) ++request.flags;
            if (invalid_field == 3) ++request.reserved;
            require(ElectronGameOverlayInitializeOwnedLateD3D11V1(&request) == ERROR_INVALID_PARAMETER,
                "malformed host request was accepted");
            require(scan_calls == 0 && hook_calls == 0, "malformed request reached native work");
        }
        reset();
        d3d11_error = ERROR_MOD_NOT_FOUND;
        require(initialize() == ERROR_SUCCESS && ego_owned_late_d3d11::status.load() == 4 &&
            scan_calls == 0 && hook_calls == 0, "non-D3D11 outcome changed");
        reset();
        discovery_error = ERROR_PROC_NOT_FOUND;
        require(initialize() == ERROR_SUCCESS && ego_owned_late_d3d11::status.load() == 4 &&
            scan_calls == 0 && hook_calls == 0, "unavailable adoption outcome changed");
        reset();
        ego_owned_late_d3d11::status.store(3);
        before_scan_failure(ERROR_INVALID_STATE);
    }
}

int wmain()
{
    try
    {
        fixture::run();
        std::cout << "{\"status\":\"passed\",\"cases\":" << fixture::cases
            << ",\"assertions\":" << fixture::assertions << ",\"pointerBytes\":" << sizeof(void *)
            << ",\"sourceRawSha256\":\"" << EGO_SOURCE_RAW_SHA256
            << "\",\"sourceNormalizedSha256\":\"" << EGO_SOURCE_NORMALIZED_SHA256
            << "\",\"explicitRemoteMutationCalls\":0,\"scope\":\"exact owned host initializer with inert scanner and graphics seams\"}\n";
        return 0;
    }
    catch (const std::exception &error)
    {
        std::cerr << "inert shared add-on host fixture failed: " << error.what() << '\n';
        return 1;
    }
}
