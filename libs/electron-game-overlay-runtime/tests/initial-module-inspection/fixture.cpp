// Deterministic local API seams around exact source functions. No production
// entrypoint, target memory mutation, process launch, DLL or graphics is used.
#include <Windows.h>
#include <Psapi.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include "types.hpp"

namespace fixture
{
constexpr std::uintptr_t host_value = 0x1100, member_value = 0x2200, unrelated_value = 0x3300;
const HANDLE expected_process = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(0x4567));
constexpr DWORD expected_pid = 7654;
HMODULE host() { return reinterpret_cast<HMODULE>(host_value); }
HMODULE member() { return reinterpret_cast<HMODULE>(member_value); }
HMODULE unrelated() { return reinterpret_cast<HMODULE>(unrelated_value); }
enum class export_id : std::uintptr_t { reshade = 1, host_abi, gate, cooperative, adapter, owned_abi, initializer };
std::uintptr_t token(HMODULE module, export_id id) { return reinterpret_cast<std::uintptr_t>(module) + static_cast<std::uintptr_t>(id); }
struct context
{
    ULONGLONG now = 0;
    unsigned claim_calls = 0, enumeration_calls = 0, export_calls = 0, read_calls = 0, waits = 0, sleeps = 0, official_calls = 0;
    DWORD claim_error = 0, export_error = ERROR_PARTIAL_COPY, read_error = ERROR_PARTIAL_COPY;
    bool pinned = false, advance_wait = true;
    std::vector<bool> pinned_results;
    std::vector<DWORD> enum_errors, wait_results;
    std::vector<std::vector<HMODULE>> module_lists { { unrelated() } };
    bool override_bytes = false;
    DWORD reported_bytes = 0;
    std::string export_fault_name;
    HMODULE export_fault_module = nullptr;
    unsigned export_failures = 0, read_failures = 0, path_failures = 0;
    export_id read_fault_id = export_id::cooperative;
    unsigned host_abi = 1, owned_abi = 1;
    LONG ready = 1, adapter = 1, gate = 2;
    bool has_owned_abi = true, has_host_abi = true;
    target_preflight_result official_result = target_preflight_result::official_addon;
    std::vector<target_preflight_result> official_results;
};
context state;
unsigned assertions = 0;
void expect(bool condition, const std::string &message)
{
    ++assertions;
    if (!condition) throw std::runtime_error(message);
}
template<typename T> T scripted(const std::vector<T> &values, unsigned index, T fallback)
{ return values.empty() ? fallback : values[std::min<std::size_t>(index, values.size() - 1)]; }
void process(HANDLE value) { expect(value == expected_process, "The bound process handle changed"); }
ULONGLONG WINAPI clock() { return state.now; }
DWORD WINAPI wait(HANDLE value, DWORD milliseconds)
{
    process(value);
    const unsigned index = state.waits++;
    const DWORD result = scripted(state.wait_results, index, static_cast<DWORD>(WAIT_TIMEOUT));
    if (milliseconds != 0) {
        expect(milliseconds <= 25, "Unexpected recovery wait duration");
        ++state.sleeps;
        if (state.advance_wait && result == WAIT_TIMEOUT) state.now += milliseconds;
    }
    if (result == WAIT_FAILED) SetLastError(ERROR_INVALID_HANDLE);
    return result;
}
BOOL WINAPI enumerate(HANDLE value, HMODULE *modules, DWORD capacity, LPDWORD needed)
{
    process(value);
    const unsigned index = state.enumeration_calls++;
    const DWORD error = scripted(state.enum_errors, index, static_cast<DWORD>(ERROR_SUCCESS));
    if (error != ERROR_SUCCESS) { SetLastError(error == MAXDWORD ? 0 : error); return FALSE; }
    const auto &selected = state.module_lists[std::min<std::size_t>(index, state.module_lists.size() - 1)];
    *needed = state.override_bytes ? state.reported_bytes : static_cast<DWORD>(selected.size() * sizeof(HMODULE));
    const std::size_t count = std::min<std::size_t>(capacity / sizeof(HMODULE), selected.size());
    std::copy_n(selected.data(), count, modules);
    return TRUE;
}
const char *name(export_id id)
{
    switch (id) {
    case export_id::reshade: return "ReShadeVersion";
    case export_id::host_abi: return "ElectronGameOverlayReShadeHostAbi";
    case export_id::gate: return "ElectronGameOverlayReShadeAddonGate";
    case export_id::cooperative: return "ElectronGameOverlayCooperativeReadyV1";
    case export_id::adapter: return "ElectronGameOverlayCooperativeAdapterReadyV1";
    case export_id::owned_abi: return "ElectronGameOverlayOwnedLateD3D11AbiV1";
    case export_id::initializer: return "ElectronGameOverlayInitializeOwnedLateD3D11V1";
    }
    return "";
}
}

static DWORD host_claim_is_pinned(HANDLE process, DWORD pid, bool &pinned)
{
    fixture::process(process); fixture::expect(pid == fixture::expected_pid, "The bound PID changed");
    const unsigned index = fixture::state.claim_calls++;
    pinned = fixture::scripted(fixture::state.pinned_results, index, fixture::state.pinned);
    return fixture::state.claim_error;
}
static module_export_inspection remote_module_export_address(HANDLE process, HMODULE module,
    const char *requested, uintptr_t &address, DWORD &error)
{
    using namespace fixture;
    fixture::process(process); ++state.export_calls;
    address = 0; error = 0;
    if (state.export_failures != 0 && requested == state.export_fault_name &&
        (state.export_fault_module == nullptr || module == state.export_fault_module)) {
        --state.export_failures; error = state.export_error; return module_export_inspection::failed;
    }
    for (const export_id id : { export_id::reshade, export_id::host_abi, export_id::gate,
        export_id::cooperative, export_id::adapter, export_id::owned_abi, export_id::initializer }) {
        if (std::strcmp(requested, name(id)) != 0) continue;
        const bool on_host = module == host() && (id == export_id::reshade || (id == export_id::host_abi && state.has_host_abi) ||
            id == export_id::gate || id == export_id::initializer || (id == export_id::owned_abi && state.has_owned_abi));
        const bool on_member = module == member() && (id == export_id::cooperative || id == export_id::adapter);
        if (on_host || on_member) { address = token(module, id); return module_export_inspection::present; }
    }
    return module_export_inspection::not_present;
}
static bool read_remote_bytes(HANDLE process, uintptr_t address, void *destination, SIZE_T size, DWORD &error)
{
    using namespace fixture;
    fixture::process(process); ++state.read_calls;
    const auto id = static_cast<export_id>(address & 0xff);
    if (state.read_failures != 0 && id == state.read_fault_id) { --state.read_failures; error = state.read_error; return false; }
    expect(size == sizeof(DWORD), "Unexpected read size at the deterministic seam");
    DWORD value = 0;
    switch (id) {
    case export_id::host_abi: value = state.host_abi; break;
    case export_id::owned_abi: value = state.owned_abi; break;
    case export_id::gate: value = static_cast<DWORD>(state.gate); break;
    case export_id::cooperative: value = static_cast<DWORD>(state.ready); break;
    case export_id::adapter: value = static_cast<DWORD>(state.adapter); break;
    default: throw std::runtime_error("Unexpected exported-data read");
    }
    std::memcpy(destination, &value, size); error = 0; return true;
}
static bool remote_module_path(HANDLE process, HMODULE module, std::wstring &path, DWORD &error)
{
    fixture::process(process); fixture::expect(module == fixture::host(), "Unexpected module path query");
    if (fixture::state.path_failures != 0) { --fixture::state.path_failures; path = L"partial-path"; error = ERROR_PARTIAL_COPY; return false; }
    path = L"C:\\controlled\\ReShade.dll"; error = 0; return true;
}
static target_preflight_result inspect_target_for_official_addon(HANDLE process,
    const std::vector<HMODULE> &, size_t, reusable_runtime_info &, DWORD &error)
{
    fixture::process(process); error = 0;
    return fixture::scripted(fixture::state.official_results, fixture::state.official_calls++, fixture::state.official_result);
}

// Any accidental mutation or process reopening in an extracted production
// function is a compilation error, rather than a fake successful operation.
#define VirtualAllocEx EGO_FORBIDDEN_REMOTE_MUTATION
#define VirtualFreeEx EGO_FORBIDDEN_REMOTE_MUTATION
#define WriteProcessMemory EGO_FORBIDDEN_REMOTE_MUTATION
#define CreateRemoteThread EGO_FORBIDDEN_REMOTE_MUTATION
#define CreateRemoteThreadEx EGO_FORBIDDEN_REMOTE_MUTATION
#define DuplicateHandle EGO_FORBIDDEN_REMOTE_MUTATION
#define CreateFileMappingW EGO_FORBIDDEN_REMOTE_MUTATION
#define OpenProcess EGO_FORBIDDEN_PROCESS_REOPEN
#define Sleep EGO_FORBIDDEN_UNBOUND_WAIT
#define LoadLibraryW EGO_FORBIDDEN_PAYLOAD_LOAD
#define LoadLibraryExW EGO_FORBIDDEN_PAYLOAD_LOAD
#define GetTickCount64 fixture::clock
#define WaitForSingleObject fixture::wait
#define K32EnumProcessModules fixture::enumerate
#include "transient.hpp"
#include "preflight.hpp"
#include "initial.hpp"
#include "wrapper.hpp"
#undef K32EnumProcessModules
#undef WaitForSingleObject
#undef GetTickCount64

namespace fixture
{
std::string quoted(const std::wstring &value)
{
    std::string result = "\"";
    for (const wchar_t c : value) {
        if (c == L'"' || c == L'\\') result += '\\';
        expect(c >= 0x20 && c <= 0x7e, "Non-ASCII phase string");
        result += static_cast<char>(c);
    }
    return result + '"';
}
struct output
{
    bool pinned = true, ready = true, cooperative = true;
    HMODULE runtime = reinterpret_cast<HMODULE>(static_cast<std::uintptr_t>(0xdead));
    owned_late_d3d11_host owned { 0xdead, 0xdead, 99 };
    initial_module_inspection_observation observation;
};
std::vector<std::string> results;
void cleared(const output &value)
{
    expect(!value.pinned && value.runtime == nullptr && !value.ready && !value.cooperative,
        "A failed or clean retry leaked partial host outputs");
    expect(value.owned.initializer == 0 && value.owned.gate_address == 0 && value.owned.gate == -1,
        "A failed or clean retry leaked owned-host outputs");
}
void run(const char *label, const std::function<void()> &setup, DWORD expected,
    const std::function<void(const output &)> &verify = {})
{
    state = {}; setup(); output value;
    const DWORD actual = inspect_initial_host_readonly(expected_process, expected_pid, value.pinned,
        value.runtime, value.ready, value.cooperative, value.owned, value.observation);
    expect(actual == expected, std::string(label) + ": unexpected error " + std::to_string(actual));
    expect(value.observation.last_error == actual, std::string(label) + ": observation error mismatch");
    if (actual != 0) cleared(value);
    if (verify) verify(value);
    std::ostringstream item;
    item << "{\"name\":\"" << label << "\",\"error\":" << actual
        << ",\"attempts\":" << value.observation.attempts << ",\"elapsedMs\":" << value.observation.elapsed_ms
        << ",\"firstError\":" << value.observation.first_error << ",\"lastError\":" << value.observation.last_error
        << ",\"phase\":" << quoted(value.observation.phase)
        << ",\"claimsRead\":" << state.claim_calls << ",\"enumerations\":" << state.enumeration_calls
        << ",\"exportsRead\":" << state.export_calls << ",\"dataReads\":" << state.read_calls
        << ",\"waitCalls\":" << state.waits << ",\"boundedWaits\":" << state.sleeps
        << ",\"pinned\":" << (value.pinned ? "true" : "false")
        << ",\"runtimePresent\":" << (value.runtime != nullptr ? "true" : "false") << '}';
    results.push_back(item.str());
}
void preflight(const char *label, DWORD bytes, target_preflight_result expected, DWORD expected_error)
{
    state = {}; state.override_bytes = true; state.reported_bytes = bytes;
    reusable_runtime_info runtime; DWORD error = 0;
    const auto result = inspect_target_for_reshade_once(expected_process, runtime, error);
    expect(result == expected && error == expected_error, std::string(label) + ": preflight result mismatch");
    expect(state.enumeration_calls == 1, "Preflight-once repeated an API call");
    results.push_back(std::string("{\"name\":\"") + label + "\",\"error\":" + std::to_string(error) + ",\"preflightOnce\":true}");
}
void wrapper(const char *label, DWORD official_wait, const std::function<void()> &setup,
    target_preflight_result expected, DWORD expected_error,
    const std::function<void(const reusable_runtime_info &, const initial_module_inspection_observation &)> &verify = {},
    bool previously_observed_host = false)
{
    state = {}; setup();
    reusable_runtime_info runtime; runtime.module_path = L"stale"; runtime.addon_module_path = L"stale";
    runtime.host_abi = 99; runtime.addon_abi = 99; runtime.addon_gate_address = 0xdead;
    DWORD error = 99; initial_module_inspection_observation observation;
    const auto result = inspect_target_for_reshade(expected_process, official_wait, runtime, error, &observation, previously_observed_host);
    expect(result == expected && error == expected_error, std::string(label) + ": wrapper result mismatch");
    expect(observation.last_error == error, std::string(label) + ": wrapper observation mismatch");
    if (result == target_preflight_result::inspection_failed || result == target_preflight_result::clear) {
        expect(runtime.module_path.empty() && runtime.addon_module_path.empty() && runtime.host_abi == 0 &&
            runtime.addon_abi == 0 && runtime.addon_gate_address == 0, "Failed/clear preflight leaked partial runtime evidence");
    }
    if (verify) verify(runtime, observation);
    std::ostringstream item;
    item << "{\"name\":\"" << label << "\",\"error\":" << error << ",\"preflightWrapper\":true"
        << ",\"attempts\":" << observation.attempts << ",\"elapsedMs\":" << observation.elapsed_ms
        << ",\"firstError\":" << observation.first_error << ",\"lastError\":" << observation.last_error
        << ",\"phase\":" << quoted(observation.phase) << ",\"officialWaitMs\":" << official_wait
        << ",\"enumerations\":" << state.enumeration_calls << ",\"waitCalls\":" << state.waits
        << ",\"boundedWaits\":" << state.sleeps << '}';
    results.push_back(item.str());
}
void tests()
{
    const auto clean = [](const output &value) { cleared(value); expect(value.observation.attempts == 1, "Clean path repeated"); expect(state.sleeps == 0, "Clean path waited"); };
    run("clean-no-host", [] {}, ERROR_SUCCESS, clean);
    run("transient-enumeration-299-recovers", [] { state.enum_errors = { ERROR_PARTIAL_COPY, 0 }; }, 0,
        [](const output &value) { cleared(value); expect(value.observation.attempts == 2 && state.sleeps == 1, "Transient enumeration did not recover once"); expect(value.observation.first_error == ERROR_PARTIAL_COPY, "First transient error lost"); expect(std::wstring(value.observation.phase) == L"module-enumeration", "Recovered enumeration phase lost"); });
    run("persistent-299-stops-at-deadline", [] { state.enum_errors = { ERROR_PARTIAL_COPY }; }, ERROR_PARTIAL_COPY,
        [](const output &value) { expect(value.observation.elapsed_ms == 250 && value.observation.attempts == 250, "Persistent failure escaped the 250 ms budget"); });
    run("frozen-clock-stops-at-attempt-limit", [] { state.enum_errors = { ERROR_PARTIAL_COPY }; state.advance_wait = false; }, ERROR_PARTIAL_COPY,
        [](const output &value) { expect(value.observation.attempts == 256 && state.sleeps == 255, "Attempt bound not enforced"); });
    run("process-already-exited", [] { state.wait_results = { WAIT_OBJECT_0 }; }, ERROR_PROCESS_ABORTED,
        [](const output &value) { expect(value.observation.attempts == 0 && state.claim_calls == 0 && state.enumeration_calls == 0, "Exited process was inspected"); expect(std::wstring(value.observation.phase) == L"process-liveness", "Exit phase lost"); });
    run("process-exits-after-transient", [] { state.enum_errors = { ERROR_PARTIAL_COPY }; state.wait_results = { WAIT_TIMEOUT, WAIT_OBJECT_0 }; }, ERROR_PROCESS_ABORTED,
        [](const output &value) { expect(value.observation.attempts == 1 && state.enumeration_calls == 1, "Exited process retried"); });
    run("bound-handle-wait-fails", [] { state.wait_results = { WAIT_FAILED }; }, ERROR_INVALID_HANDLE,
        [](const output &value) { expect(value.observation.attempts == 0 && state.enumeration_calls == 0, "Invalid bound handle was inspected"); });
    run("wait-fails-after-transient", [] { state.enum_errors = { ERROR_PARTIAL_COPY }; state.wait_results = { WAIT_TIMEOUT, WAIT_FAILED }; }, ERROR_INVALID_HANDLE);
    run("unexpected-wait-status", [] { state.wait_results = { WAIT_ABANDONED }; }, ERROR_GEN_FAILURE);
    run("access-denied-is-not-retried", [] { state.enum_errors = { ERROR_ACCESS_DENIED }; }, ERROR_ACCESS_DENIED,
        [](const output &value) { expect(value.observation.attempts == 1 && state.sleeps == 0, "Permanent error retried"); });
    run("claim-read-fails-closed", [] { state.claim_error = ERROR_ACCESS_DENIED; state.pinned = true; }, ERROR_ACCESS_DENIED,
        [](const output &) { expect(state.enumeration_calls == 0, "Modules read after failed claim lookup"); });
    run("already-pinned-claim-preserved", [] { state.pinned = true; }, 0,
        [](const output &value) { expect(value.pinned && value.runtime == nullptr, "Consumed ownership was forgotten"); expect(state.sleeps == 0, "Pinned success waited"); });
    run("observed-pinned-claim-survives-later-miss", [] { state.pinned_results = { true, false }; state.enum_errors = { ERROR_PARTIAL_COPY, 0 }; }, 0,
        [](const output &value) { expect(value.pinned && value.runtime == nullptr && value.observation.attempts == 2, "Observed consumed claim disappeared during retry"); });
    run("owned-host-and-ready-member-preserved", [] { state.module_lists = { { host(), member() } }; }, 0,
        [](const output &value) { expect(value.runtime == host() && value.ready && value.cooperative, "Cooperative host lost"); expect(value.owned.initializer != 0 && value.owned.gate == 2, "Owned host capability lost"); });
    run("conflicting-reshade-hosts-reject", [] { state.module_lists = { { host(), host() } }; }, ERROR_REVISION_MISMATCH,
        [](const output &value) { expect(value.observation.attempts == 1 && state.sleeps == 0, "Host conflict retried"); });
    run("owned-host-abi-mismatch-reject", [] { state.module_lists = { { host() } }; state.owned_abi = 2; }, ERROR_REVISION_MISMATCH);
    run("transient-export-error-recovers", [] { state.module_lists = { { host() } }; state.export_fault_module = host(); state.export_fault_name = "ReShadeVersion"; state.export_failures = 1; }, 0,
        [](const output &value) { expect(value.runtime == host() && value.observation.attempts == 2, "Export error did not recover"); expect(value.observation.first_error == ERROR_PARTIAL_COPY, "Export first error lost"); expect(std::wstring(value.observation.phase) == L"module-exports", "Recovered export phase lost"); });
    run("partial-readiness-is-fresh-after-retry", [] { state.pinned = true; state.module_lists = { { host(), member() }, { host() } }; state.read_fault_id = export_id::cooperative; state.read_failures = 1; }, 0,
        [](const output &value) { expect(value.pinned, "Read-only retry lost a real persistent claim"); expect(value.runtime == host() && !value.ready && !value.cooperative && value.owned.initializer != 0, "Partial readiness survived retry"); expect(value.observation.attempts == 2, "Partial read was not retried"); });
    run("observed-host-never-becomes-clear", [] { state.module_lists = { { host(), member() }, { unrelated() } }; state.read_fault_id = export_id::cooperative; state.read_failures = 1; }, ERROR_PARTIAL_COPY,
        [](const output &value) { expect(value.observation.elapsed_ms == 250 && std::wstring(value.observation.phase) == L"host-evidence-lost", "Observed host loss was treated as clear"); });
    run("observed-host-can-reappear-during-recovery", [] { state.module_lists = { { host(), member() }, { unrelated() }, { host(), member() } }; state.read_fault_id = export_id::cooperative; state.read_failures = 1; }, 0,
        [](const output &value) { expect(value.runtime == host() && value.ready && value.cooperative && value.observation.attempts == 3, "Reappearing known host did not recover"); });
    run("observed-cooperative-member-never-becomes-clear", [] { state.module_lists = { { member(), unrelated() }, { unrelated() } }; state.export_fault_module = unrelated(); state.export_fault_name = "ReShadeVersion"; state.export_failures = 1; }, ERROR_PARTIAL_COPY);
    run("transient-owned-capability-read-recovers", [] { state.module_lists = { { host() } }; state.read_fault_id = export_id::owned_abi; state.read_failures = 1; }, 0,
        [](const output &value) { expect(value.runtime == host() && value.owned.initializer != 0 && value.observation.attempts == 2, "Owned capability error did not recover"); expect(std::wstring(value.observation.phase) == L"owned-late-host", "Recovered capability phase lost"); });
    run("empty-module-list-fails-closed", [] { state.override_bytes = true; state.reported_bytes = 0; }, ERROR_PARTIAL_COPY);
    run("misaligned-module-list-fails-closed", [] { state.override_bytes = true; state.reported_bytes = sizeof(HMODULE) + 1; }, ERROR_BAD_LENGTH);
    run("truncated-module-list-fails-closed", [] { state.override_bytes = true; state.reported_bytes = 1025 * sizeof(HMODULE); }, ERROR_MORE_DATA,
        [](const output &value) { expect(value.observation.attempts == 1, "Permanent truncation retried"); });
    run("false-api-with-zero-error-fails-closed", [] { state.enum_errors = { MAXDWORD }; }, ERROR_PARTIAL_COPY);
    preflight("preflight-empty-list-rejected", 0, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY);
    preflight("preflight-misaligned-list-rejected", sizeof(HMODULE) + 1, target_preflight_result::inspection_failed, ERROR_BAD_LENGTH);
    preflight("preflight-truncated-list-rejected", 4097 * sizeof(HMODULE), target_preflight_result::inspection_failed, ERROR_INSUFFICIENT_BUFFER);
    preflight("preflight-valid-empty-host-search", sizeof(HMODULE), target_preflight_result::clear, ERROR_SUCCESS);
    wrapper("wrapper-clean-no-host", 0, [] {}, target_preflight_result::clear, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 1 && state.sleeps == 0, "Clean wrapper path waited"); });
    wrapper("wrapper-transient-299-recovers", 0, [] { state.enum_errors = { ERROR_PARTIAL_COPY, 0 }; }, target_preflight_result::clear, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 2 && observation.first_error == ERROR_PARTIAL_COPY && state.sleeps == 1, "Wrapper transient failure not recovered"); expect(std::wstring(observation.phase) == L"preflight-module-enumeration", "Wrapper recovered enumeration phase lost"); });
    wrapper("wrapper-persistent-299-deadline", 0, [] { state.enum_errors = { ERROR_PARTIAL_COPY }; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 250 && observation.attempts == 250, "Wrapper retry deadline not enforced"); });
    wrapper("wrapper-frozen-clock-attempt-limit", 0, [] { state.enum_errors = { ERROR_PARTIAL_COPY }; state.advance_wait = false; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 256 && state.sleeps == 255, "Wrapper attempt cap not enforced"); });
    wrapper("wrapper-official-deadline-caps-transient-budget", 7, [] { state.enum_errors = { ERROR_PARTIAL_COPY }; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 7 && observation.attempts == 7, "Explicit official deadline exceeded"); });
    wrapper("wrapper-pre-exited-process", 0, [] { state.wait_results = { WAIT_OBJECT_0 }; }, target_preflight_result::inspection_failed, ERROR_PROCESS_ABORTED,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 0 && state.enumeration_calls == 0, "Wrapper inspected exited process"); });
    wrapper("wrapper-exit-after-transient", 0, [] { state.enum_errors = { ERROR_PARTIAL_COPY }; state.wait_results = { WAIT_TIMEOUT, WAIT_OBJECT_0 }; }, target_preflight_result::inspection_failed, ERROR_PROCESS_ABORTED);
    wrapper("wrapper-access-denied-no-retry", 0, [] { state.enum_errors = { ERROR_ACCESS_DENIED }; }, target_preflight_result::inspection_failed, ERROR_ACCESS_DENIED,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 1 && state.sleeps == 0, "Wrapper retried permanent denial"); });
    wrapper("wrapper-observed-host-never-becomes-clear", 0, [] { state.module_lists = { { host() }, { unrelated() } }; state.export_fault_module = host(); state.export_fault_name = "ElectronGameOverlayReShadeAddonGate"; state.export_failures = 1; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 250 && std::wstring(observation.phase) == L"preflight-host-evidence-lost", "Wrapper forgot observed host"); });
    wrapper("wrapper-observed-host-can-reappear", 0, [] { state.module_lists = { { host() }, { unrelated() }, { host() } }; state.gate = 0; state.export_fault_module = host(); state.export_fault_name = "ElectronGameOverlayReShadeAddonGate"; state.export_failures = 1; }, target_preflight_result::reusable_runtime, 0,
        [](const reusable_runtime_info &runtime, const initial_module_inspection_observation &observation) { expect(observation.attempts == 3 && runtime.host_abi == 1 && !runtime.module_path.empty(), "Wrapper did not recover reappearing host"); });
    wrapper("wrapper-compatible-open-host-preserved", 0, [] { state.module_lists = { { host() } }; state.gate = 0; }, target_preflight_result::reusable_runtime, 0,
        [](const reusable_runtime_info &runtime, const initial_module_inspection_observation &observation) { expect(!runtime.module_path.empty() && runtime.host_abi == 1 && runtime.addon_gate_address != 0 && observation.attempts == 1, "Reusable host evidence lost"); });
    wrapper("wrapper-closed-host-refusal-preserved", 0, [] { state.module_lists = { { host() } }; state.gate = 2; }, target_preflight_result::runtime_reuse_too_late, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 1 && state.sleeps == 0, "Closed host refusal retried"); });
    wrapper("wrapper-incompatible-host-refusal-preserved", 0, [] { state.module_lists = { { host() } }; state.host_abi = 2; }, target_preflight_result::runtime_incompatible, 0);
    wrapper("wrapper-official-pending-no-wait-refused", 0, [] { state.module_lists = { { host() } }; state.has_host_abi = false; state.official_result = target_preflight_result::official_addon_pending; }, target_preflight_result::runtime_incompatible, 0);
    wrapper("wrapper-official-pending-to-ready", 100, [] { state.module_lists = { { host() } }; state.has_host_abi = false; state.official_results = { target_preflight_result::official_addon_pending, target_preflight_result::official_addon }; }, target_preflight_result::official_addon, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 2 && observation.elapsed_ms == 25 && state.official_calls == 2, "Official addon polling changed"); });
    wrapper("wrapper-official-pending-times-out-refused", 30, [] { state.module_lists = { { host() } }; state.has_host_abi = false; state.official_result = target_preflight_result::official_addon_pending; }, target_preflight_result::runtime_incompatible, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 30 && observation.attempts == 3, "Official pending timeout changed"); });
    wrapper("wrapper-official-clear-deadline-remains-clear", 30, [] {}, target_preflight_result::clear, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 30 && observation.attempts == 3, "Official clear wait changed"); });
    wrapper("wrapper-process-exit-during-official-poll", 100, [] { state.module_lists = { { host() } }; state.has_host_abi = false; state.official_result = target_preflight_result::official_addon_pending; state.wait_results = { WAIT_TIMEOUT, WAIT_OBJECT_0 }; }, target_preflight_result::inspection_failed, ERROR_PROCESS_ABORTED);
    wrapper("wrapper-false-api-zero-error-rejects", 0, [] { state.enum_errors = { MAXDWORD }; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY);
    wrapper("wrapper-empty-list-never-becomes-clear", 0, [] { state.override_bytes = true; state.reported_bytes = 0; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY);
    wrapper("wrapper-misaligned-list-never-becomes-clear", 0, [] { state.override_bytes = true; state.reported_bytes = sizeof(HMODULE) + 1; }, target_preflight_result::inspection_failed, ERROR_BAD_LENGTH);
    wrapper("wrapper-transient-module-path-error-recovers", 0, [] { state.module_lists = { { host() } }; state.gate = 0; state.path_failures = 1; }, target_preflight_result::reusable_runtime, 0,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.attempts == 2 && observation.first_error == ERROR_PARTIAL_COPY, "Module path read did not recover"); expect(std::wstring(observation.phase) == L"preflight-module-path", "Recovered module path phase lost"); });
    wrapper("wrapper-previous-group-host-fact-preserved", 0, [] {}, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 250 && std::wstring(observation.phase) == L"preflight-host-evidence-lost", "Prior inspection group host fact was lost"); }, true);
    wrapper("wrapper-official-poll-host-fact-preserved", 100, [] { state.module_lists = { { host() }, { unrelated() } }; state.has_host_abi = false; state.official_result = target_preflight_result::official_addon_pending; }, target_preflight_result::inspection_failed, ERROR_PARTIAL_COPY,
        [](const reusable_runtime_info &, const initial_module_inspection_observation &observation) { expect(observation.elapsed_ms == 100, "Official polling lost host evidence or deadline"); });
}
}

int wmain(int argc, wchar_t **argv)
{
    try {
        fixture::expect(argc == 3 && std::wstring(argv[1]) == L"--root", "Usage: --root <fresh direct child of SDK build>");
        const std::filesystem::path build = std::filesystem::canonical(EGO_ALLOWED_BUILD_ROOT);
        const std::filesystem::path root = std::filesystem::absolute(argv[2]).lexically_normal();
        fixture::expect(std::filesystem::canonical(root.parent_path()) == build, "Evidence must be a direct child of SDK build");
        fixture::expect(root.filename().wstring().rfind(L"ii-", 0) == 0 && !std::filesystem::exists(root), "Evidence root must be fresh and start ii-");
        if (!std::filesystem::create_directory(root)) throw std::runtime_error("Could not create fresh evidence directory");
        fixture::tests();
        std::ofstream report(root / L"report.json", std::ios::binary);
        if (!report.is_open()) throw std::runtime_error("Could not open owned evidence report");
        report << "{\"schemaVersion\":1,\"status\":\"passed\",\"scope\":\"Exact initial inspection functions with deterministic local API seams; no target, DLL loading, production injector entrypoint, remote execution or graphics\",\"architecture\":\""
#ifdef _WIN64
            << "x64"
#else
            << "x86"
#endif
            << "\",\"sourceRawSha256\":\"" << EGO_SOURCE_RAW_SHA << "\",\"sourceNormalizedSha256\":\"" << EGO_SOURCE_NORMALIZED_SHA
            << "\",\"extractedSourceSha256\":{\"types\":\"" << EGO_TYPES_SHA << "\",\"initial\":\"" << EGO_INITIAL_SHA
            << "\",\"transient\":\"" << EGO_TRANSIENT_SHA << "\",\"preflight\":\"" << EGO_PREFLIGHT_SHA
            << "\",\"wrapper\":\"" << EGO_WRAPPER_SHA << "\"},\"assertions\":" << fixture::assertions << ",\"explicitRemoteMutationCalls\":0,\"processReopens\":0,\"cases\":[";
        for (std::size_t index = 0; index < fixture::results.size(); ++index) { if (index) report << ','; report << fixture::results[index]; }
        report << "]}\n";
        report.flush();
        if (!report) throw std::runtime_error("Could not write owned evidence report");
        report.close();
        if (!report) throw std::runtime_error("Could not close owned evidence report");
        std::cout << "INITIAL_INSPECTION_FIXTURE_PASSED cases=" << fixture::results.size() << " assertions=" << fixture::assertions << '\n';
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
