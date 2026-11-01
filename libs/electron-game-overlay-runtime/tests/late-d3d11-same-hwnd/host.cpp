#include <Windows.h>
#include <shellapi.h>
#include <psapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#define RESHADE_OWNED_LATE_D3D11_ABI_ONLY
#include "../late-d3d11-adoption/owned-host-prototype/owned_late_d3d11_prototype.hpp"
#include "../../src/ego_cooperative_registry.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

constexpr wchar_t window_class[] = L"EgoLateD3D11SameHwnd";
constexpr wchar_t window_title[] = L"EGO late D3D11 same-HWND input lifetime proof";
constexpr std::uint64_t startup_timeout_ms = 60'000;
constexpr int test_virtual_key = 'A';

struct options
{
    fs::path stage_directory;
    fs::path reshade;
    fs::path addon;
    fs::path config;
    fs::path report;
    fs::path command_file;
    std::string case_name;
    std::uint64_t frames_before_load = 60;
    std::uint64_t resize_after_frames = 120;
    std::uint64_t lifetime_ms = 60'000;
    bool prototype = false;
};

struct polling_evidence
{
    std::uint64_t epoch = 0;
    bool active = false;
    std::uint64_t samples = 0;
    std::uint64_t async_down_samples = 0;
    std::uint64_t key_state_down_samples = 0;
    std::uint64_t keyboard_state_down_samples = 0;
    std::uint64_t errors = 0;
    std::uint64_t start_tick_ms = 0;
    std::uint64_t end_tick_ms = 0;
    std::uint64_t last_sample_tick_ms = 0;
    bool last_async_down = false;
    bool last_key_state_down = false;
    bool last_keyboard_state_down = false;
};

struct evidence
{
    std::string phase = "starting";
    std::string status = "running";
    std::string failure;
    std::string report_publication_operation;
    DWORD report_publication_last_error = ERROR_SUCCESS;
    std::uint64_t report_publication_retries = 0;
    std::uint64_t started_at = GetTickCount64();
    std::uint64_t loaded_at = 0;
    std::uint64_t frames_before_load = 0;
    std::uint64_t frames_after_load = 0;
    std::uint64_t frames_after_resize = 0;
    std::uint64_t native_present_calls = 0;
    std::uint64_t primary_frames_before_load = 0;
    std::uint64_t secondary_frames_before_load = 0;
    std::uint64_t primary_frames_after_load = 0;
    std::uint64_t secondary_frames_after_load = 0;
    std::uint64_t secondary_frames_after_lifecycle = 0;
    std::uint64_t primary_frames_at_pause = 0;
    std::uint64_t first_adopted_native = 0;
    std::string first_adopted_role;
    std::uint64_t command_sequence = 0;
    std::uint32_t completed_sampling_windows = 0;
    std::uint32_t completed_pre_lifecycle_windows = 0;
    std::uint32_t completed_post_lifecycle_windows = 0;
    bool lifecycle_applied = false;
    bool finish_requested = false;
    bool same_hwnd_verified = false;
    polling_evidence polling;
    std::uint64_t state_checks = 0;
    std::uint64_t state_mismatches = 0;
    std::uint32_t resize_attempts = 0;
    std::uint32_t resize_successes = 0;
    DWORD reshade_load_error = ERROR_SUCCESS;
    DWORD addon_load_error = ERROR_SUCCESS;
    DWORD member_initialize_result = ERROR_NOT_READY;
    DWORD bootstrap_initialize_result = ERROR_NOT_READY;
    std::uint32_t bootstrap_abi = 0;
    bool bootstrap_initializer_used_null_request = false;
    LONG addon_gate_observed = -1;
    bool addon_gate_claimed = false;
    bool addon_gate_registered = false;
    DWORD stats_query_result = ERROR_NOT_READY;
    ego_owned_late_d3d11_stats_v1 bootstrap_stats = {
        sizeof(ego_owned_late_d3d11_stats_v1), 1 };
    HRESULT last_resize_result = S_FALSE;
    HRESULT last_present_result = S_FALSE;
    D3D_FEATURE_LEVEL feature_level = D3D_FEATURE_LEVEL_9_1;
    bool used_warp = false;
    bool preexisting_runtime = false;
    bool chain_released_before_device_context = false;
    bool retired_before_device_context_release = false;
    bool native_swapchain_discovery_proven = false;
    std::uint64_t key_down_messages = 0;
    std::uint64_t key_up_messages = 0;
    std::uint64_t character_messages = 0;
    std::uint64_t pointer_down_messages = 0;
    std::uint64_t raw_key_down_messages = 0;
    std::uint64_t raw_key_up_messages = 0;
    std::uint64_t raw_pointer_down_messages = 0;
    std::uint64_t raw_input_errors = 0;
    bool raw_input_registered = false;
    bool registry_snapshot_valid = false;
    std::uint32_t registry_focus_window = 0;
    std::vector<std::uint32_t> registry_windows;
    std::vector<std::uint32_t> registry_ranks;
};

using initialize_member_fn = DWORD(WINAPI *)(void *);
using initialize_bootstrap_fn = DWORD(WINAPI *)(void *);
using initialize_prototype_fn = DWORD(WINAPI *)(const ego_owned_late_d3d11_initialize_v1 *);
using query_bootstrap_fn = DWORD(WINAPI *)(ego_owned_late_d3d11_stats_v1 *);

struct graphics
{
    HWND window = nullptr;
    UINT pending_width = 0;
    UINT pending_height = 0;
    UINT width = 800;
    UINT height = 600;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain> swapchain;
    ComPtr<ID3D11RenderTargetView> target;
    ComPtr<IDXGISwapChain> secondary_swapchain;
    ComPtr<ID3D11RenderTargetView> secondary_target;
    ComPtr<ID3D11RasterizerState> rasterizer;
    ComPtr<ID3D11BlendState> blend;
    ComPtr<ID3D11DepthStencilState> depth_stencil;
    HMODULE reshade_module = nullptr;
    HMODULE addon_module = nullptr;
    initialize_bootstrap_fn initialize_bootstrap = nullptr;
    initialize_prototype_fn initialize_prototype = nullptr;
    query_bootstrap_fn query_bootstrap = nullptr;
    bool bootstrap_active = false;
};

options g_options;
evidence g_evidence;
graphics g_graphics;
bool g_paths_validated = false;

struct owned_report_file_identity
{
    DWORD volume_serial = 0;
    DWORD index_high = 0;
    DWORD index_low = 0;
    bool valid = false;
};
owned_report_file_identity g_published_report_identity;

std::string utf8(const std::wstring &value)
{
    if (value.empty())
        return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
        value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (count <= 0)
        throw std::runtime_error("Invalid UTF-16 path.");
    std::string result(static_cast<std::size_t>(count), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), count, nullptr, nullptr) != count)
        throw std::runtime_error("Cannot encode path as UTF-8.");
    return result;
}

std::string json_string(const std::string &value)
{
    std::string result = "\"";
    for (const unsigned char character : value)
    {
        switch (character)
        {
        case '\\': result += "\\\\"; break;
        case '"': result += "\\\""; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default:
            if (character < 0x20)
            {
                char escaped[7] = {};
                sprintf_s(escaped, "\\u%04x", character);
                result += escaped;
            }
            else
                result += static_cast<char>(character);
        }
    }
    return result + '"';
}

void publish_message(const std::string &message)
{
    const std::string line = message + '\n';
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output != nullptr && output != INVALID_HANDLE_VALUE)
    {
        DWORD written = 0;
        static_cast<void>(WriteFile(output, line.data(),
            static_cast<DWORD>(line.size()), &written, nullptr));
    }
    OutputDebugStringA(line.c_str());
}

// Test-only read-only inspection of this exact process's frozen POD registry.
// Never create a mapping/participant or dereference an engine-owned pointer.
void refresh_registry_evidence()
{
    using namespace ego::cooperative;
    g_evidence.registry_snapshot_valid = false;
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return;
    const auto instance = (std::uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    wchar_t name[160]{}, mutex_name[176]{};
    swprintf_s(name, L"Local\\ElectronGameOverlay-Cooperative-v1-%lu-%016llx-%u",
        GetCurrentProcessId(), static_cast<unsigned long long>(instance), unsigned(sizeof(void *) * 8));
    swprintf_s(mutex_name, L"%s-lock", name);
    const HANDLE mutex = OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, FALSE, mutex_name);
    if (mutex == nullptr) return;
    const HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, name);
    if (mapping == nullptr) { CloseHandle(mutex); return; }
    const auto *state = static_cast<const detail::shared_state *>(
        MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(detail::shared_state)));
    const DWORD acquired = state == nullptr ? WAIT_FAILED : WaitForSingleObject(mutex, 100);
    if (acquired == WAIT_OBJECT_0 && state->magic == detail::magic &&
        state->version == abi_version && state->bytes == sizeof(detail::shared_state) &&
        state->pointer_bits == sizeof(void *) * 8)
    {
        g_evidence.registry_windows.clear();
        g_evidence.registry_ranks.clear();
        for (const auto &slot : state->windows)
            if (slot.key.participant != 0) g_evidence.registry_windows.push_back(slot.key.window_id);
        for (const auto &slot : state->ranks)
            if (slot.key.participant != 0) g_evidence.registry_ranks.push_back(slot.key.window_id);
        g_evidence.registry_focus_window = state->focus.window_id;
        g_evidence.registry_snapshot_valid = true;
    }
    if (acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED) ReleaseMutex(mutex);
    if (state != nullptr) UnmapViewOfFile(state);
    CloseHandle(mapping);
    CloseHandle(mutex);
}

std::string json_ids(const std::vector<std::uint32_t> &ids)
{
    std::string result = "[";
    for (const auto id : ids)
    {
        if (result.size() != 1) result += ',';
        result += std::to_string(id);
    }
    return result + ']';
}

bool identify_owned_report_file(HANDLE file, const fs::path &expected_path,
                               owned_report_file_identity &identity)
{
    BY_HANDLE_FILE_INFORMATION information = {};
    if (GetFileType(file) != FILE_TYPE_DISK ||
        !GetFileInformationByHandle(file, &information))
        return false;
    if ((information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
            FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_READONLY)) != 0 ||
        information.nNumberOfLinks != 1)
    {
        SetLastError(ERROR_FILE_INVALID);
        return false;
    }
    const DWORD required = GetFinalPathNameByHandleW(file, nullptr, 0,
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (required == 0 || required > 32768)
        return false;
    std::wstring actual(required, L'\0');
    const DWORD length = GetFinalPathNameByHandleW(file, actual.data(), required,
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0 || length >= required)
        return false;
    actual.resize(length);
    if (actual.rfind(L"\\\\?\\UNC\\", 0) == 0)
        actual = L"\\\\" + actual.substr(8);
    else if (actual.rfind(L"\\\\?\\", 0) == 0)
        actual.erase(0, 4);
    if (_wcsicmp(actual.c_str(), expected_path.c_str()) != 0)
    {
        SetLastError(ERROR_FILE_INVALID);
        return false;
    }
    identity = { information.dwVolumeSerialNumber, information.nFileIndexHigh,
        information.nFileIndexLow, true };
    return true;
}

bool verify_owned_report_file(const fs::path &path,
                             const owned_report_file_identity &expected,
                             DWORD desired_access = FILE_READ_ATTRIBUTES)
{
    if (!expected.valid)
    {
        SetLastError(ERROR_FILE_INVALID);
        return false;
    }
    const HANDLE file = CreateFileW(path.c_str(), desired_access,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return false;
    owned_report_file_identity actual;
    const bool identified = identify_owned_report_file(file, path, actual);
    const DWORD identification_error = identified ? ERROR_SUCCESS : GetLastError();
    const bool closed = CloseHandle(file) != FALSE;
    if (!identified || !closed)
    {
        if (!identified) SetLastError(identification_error);
        return false;
    }
    const bool same = actual.volume_serial == expected.volume_serial &&
        actual.index_high == expected.index_high && actual.index_low == expected.index_low;
    if (!same) SetLastError(ERROR_FILE_INVALID);
    return same;
}

bool verify_owned_report_delete_access(const fs::path &path,
                                      const owned_report_file_identity &expected)
{
    if (verify_owned_report_file(path, expected, DELETE | FILE_READ_ATTRIBUTES))
        return true;
    // A sharing denial on a DELETE open is the documented transient condition
    // this retry handles. An ACL/access denial remains a permanent failure;
    // rechecking read attributes must still prove the exact owned file.
    return GetLastError() == ERROR_SHARING_VIOLATION &&
        verify_owned_report_file(path, expected);
}

bool verify_atomic_report_files(const fs::path &temporary,
                                const owned_report_file_identity &temporary_identity,
                                bool require_existing_destination)
{
    if (!verify_owned_report_file(temporary, temporary_identity))
        return false;
    if (g_published_report_identity.valid)
    {
        if (!verify_owned_report_file(g_options.report, g_published_report_identity))
            return false;
        return !require_existing_destination ||
            (verify_owned_report_delete_access(temporary, temporary_identity) &&
             verify_owned_report_delete_access(g_options.report, g_published_report_identity));
    }
    if (require_existing_destination)
    {
        SetLastError(ERROR_FILE_INVALID);
        return false;
    }
    // The first publication may only create a previously absent report. A
    // preexisting file is not proof of ownership merely because it is in stage.
    const DWORD attributes = GetFileAttributesW(g_options.report.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND)
        return true;
    SetLastError(ERROR_FILE_INVALID);
    return false;
}

bool write_report()
{
    if (!g_paths_validated || g_options.report.empty())
        return false;
    std::ostringstream report;
    report << "{\n"
        << "  \"schemaVersion\": 1,\n"
        << "  \"fixture\": \"late-d3d11-same-hwnd-input-lifetime\",\n"
        << "  \"case\": " << json_string(g_options.case_name) << ",\n"
        << "  \"bootstrapMode\": " << json_string(g_options.prototype ? "prototype" : "production-owned") << ",\n"
        << "  \"bootstrapAbi\": " << g_evidence.bootstrap_abi << ",\n"
        << "  \"bootstrapInitializerUsedNullRequest\": " << (g_evidence.bootstrap_initializer_used_null_request ? "true" : "false") << ",\n"
        << "  \"addonGateObserved\": " << g_evidence.addon_gate_observed << ",\n"
        << "  \"addonGateClaimed\": " << (g_evidence.addon_gate_claimed ? "true" : "false") << ",\n"
        << "  \"addonGateRegistered\": " << (g_evidence.addon_gate_registered ? "true" : "false") << ",\n"
        << "  \"automaticDiscoveryProven\": false,\n"
        << "  \"nativeInputAcceptanceProven\": false,\n"
        << "  \"sameHwnd\": " << (g_evidence.same_hwnd_verified ? "true" : "false") << ",\n"
        << "  \"primaryLive\": " << (g_graphics.swapchain != nullptr ? "true" : "false") << ",\n"
        << "  \"primaryPaused\": " << (g_options.case_name == "primary-paused" && g_evidence.lifecycle_applied ? "true" : "false") << ",\n"
        << "  \"primaryFramesAtPause\": " << g_evidence.primary_frames_at_pause << ",\n"
        << "  \"primarySwapchainNative\": " << json_string(std::to_string(reinterpret_cast<std::uintptr_t>(g_graphics.swapchain.Get()))) << ",\n"
        << "  \"secondarySwapchainNative\": " << json_string(std::to_string(reinterpret_cast<std::uintptr_t>(g_graphics.secondary_swapchain.Get()))) << ",\n"
        << "  \"firstAdoptedRole\": " << json_string(g_evidence.first_adopted_role) << ",\n"
        << "  \"firstAdoptedNative\": " << json_string(std::to_string(g_evidence.first_adopted_native)) << ",\n"
        << "  \"secondaryLive\": " << (g_graphics.secondary_swapchain != nullptr ? "true" : "false") << ",\n"
        << "  \"lifecycleApplied\": " << (g_evidence.lifecycle_applied ? "true" : "false") << ",\n"
        << "  \"commandSequence\": " << g_evidence.command_sequence << ",\n"
        << "  \"completedSamplingWindows\": " << g_evidence.completed_sampling_windows << ",\n"
        << "  \"completedPreLifecycleSamplingWindows\": " << g_evidence.completed_pre_lifecycle_windows << ",\n"
        << "  \"completedPostLifecycleSamplingWindows\": " << g_evidence.completed_post_lifecycle_windows << ",\n"
        << "  \"graphicsPointersSuppliedToBootstrap\": false,\n"
        << "  \"nativeSwapchainDiscoveryProven\": " << (g_evidence.native_swapchain_discovery_proven ? "true" : "false") << ",\n"
        << "  \"renderedOverlayPixelsProven\": false,\n"
        << "  \"pid\": " << GetCurrentProcessId() << ",\n"
        << "  \"windowHandle\": " << json_string(std::to_string(
            reinterpret_cast<std::uintptr_t>(g_graphics.window))) << ",\n"
        << "  \"phase\": " << json_string(g_evidence.phase) << ",\n"
        << "  \"status\": " << json_string(g_evidence.status) << ",\n"
        << "  \"failure\": " << json_string(g_evidence.failure) << ",\n"
        << "  \"reportPublicationOperation\": " << json_string(g_evidence.report_publication_operation) << ",\n"
        << "  \"reportPublicationLastError\": " << g_evidence.report_publication_last_error << ",\n"
        << "  \"reportPublicationRetries\": " << g_evidence.report_publication_retries << ",\n"
        << "  \"elapsedMs\": " << GetTickCount64() - g_evidence.started_at << ",\n"
        << "  \"elapsedAfterLoadMs\": " << (g_evidence.loaded_at == 0 ? 0 :
            GetTickCount64() - g_evidence.loaded_at) << ",\n"
        << "  \"requiredFramesBeforeLoad\": " << g_options.frames_before_load << ",\n"
        << "  \"resizeAfterFrames\": " << g_options.resize_after_frames << ",\n"
        << "  \"requestedLifetimeMs\": " << g_options.lifetime_ms << ",\n"
        << "  \"framesBeforeLoad\": " << g_evidence.frames_before_load << ",\n"
        << "  \"framesAfterLoad\": " << g_evidence.frames_after_load << ",\n"
        << "  \"framesAfterResize\": " << g_evidence.frames_after_resize << ",\n"
        << "  \"primaryFramesBeforeLoad\": " << g_evidence.primary_frames_before_load << ",\n"
        << "  \"secondaryFramesBeforeLoad\": " << g_evidence.secondary_frames_before_load << ",\n"
        << "  \"primaryFramesAfterLoad\": " << g_evidence.primary_frames_after_load << ",\n"
        << "  \"secondaryFramesAfterLoad\": " << g_evidence.secondary_frames_after_load << ",\n"
        << "  \"secondaryFramesAfterLifecycle\": " << g_evidence.secondary_frames_after_lifecycle << ",\n"
        << "  \"nativePresentCalls\": " << g_evidence.native_present_calls << ",\n"
        << "  \"stateChecks\": " << g_evidence.state_checks << ",\n"
        << "  \"stateMismatches\": " << g_evidence.state_mismatches << ",\n"
        << "  \"resizeAttempts\": " << g_evidence.resize_attempts << ",\n"
        << "  \"resizeSuccesses\": " << g_evidence.resize_successes << ",\n"
        << "  \"lastResizeHresult\": " << static_cast<std::uint32_t>(g_evidence.last_resize_result) << ",\n"
        << "  \"lastPresentHresult\": " << static_cast<std::uint32_t>(g_evidence.last_present_result) << ",\n"
        << "  \"reshadeLoadError\": " << g_evidence.reshade_load_error << ",\n"
        << "  \"addonLoadError\": " << g_evidence.addon_load_error << ",\n"
        << "  \"memberInitializeResult\": " << g_evidence.member_initialize_result << ",\n"
        << "  \"bootstrapInitializeResult\": " << g_evidence.bootstrap_initialize_result << ",\n"
        << "  \"bootstrapStatsQueryResult\": " << g_evidence.stats_query_result << ",\n"
        << "  \"featureLevel\": " << static_cast<std::uint32_t>(g_evidence.feature_level) << ",\n"
        << "  \"usedWarp\": " << (g_evidence.used_warp ? "true" : "false") << ",\n"
        << "  \"preexistingRuntime\": " << (g_evidence.preexisting_runtime ? "true" : "false") << ",\n"
        << "  \"chainReleasedBeforeDeviceContext\": " << (g_evidence.chain_released_before_device_context ? "true" : "false") << ",\n"
        << "  \"retiredBeforeDeviceContextRelease\": " << (g_evidence.retired_before_device_context_release ? "true" : "false") << ",\n"
        << "  \"keyDownMessages\": " << g_evidence.key_down_messages << ",\n"
        << "  \"keyUpMessages\": " << g_evidence.key_up_messages << ",\n"
        << "  \"characterMessages\": " << g_evidence.character_messages << ",\n"
        << "  \"pointerDownMessages\": " << g_evidence.pointer_down_messages << ",\n"
        << "  \"rawInputRegistered\": " << (g_evidence.raw_input_registered ? "true" : "false") << ",\n"
        << "  \"rawKeyDownMessages\": " << g_evidence.raw_key_down_messages << ",\n"
        << "  \"rawKeyUpMessages\": " << g_evidence.raw_key_up_messages << ",\n"
        << "  \"rawPointerDownMessages\": " << g_evidence.raw_pointer_down_messages << ",\n"
        << "  \"rawInputErrors\": " << g_evidence.raw_input_errors << ",\n"
        << "  \"registrySnapshotValid\": " << (g_evidence.registry_snapshot_valid ? "true" : "false") << ",\n"
        << "  \"registryFocusWindowId\": " << g_evidence.registry_focus_window << ",\n"
        << "  \"registryWindowIds\": " << json_ids(g_evidence.registry_windows) << ",\n"
        << "  \"registryRankWindowIds\": " << json_ids(g_evidence.registry_ranks) << ",\n"
        << "  \"polling\": {\n"
        << "    \"virtualKey\": " << test_virtual_key << ",\n"
        << "    \"epoch\": " << g_evidence.polling.epoch << ",\n"
        << "    \"active\": " << (g_evidence.polling.active ? "true" : "false") << ",\n"
        << "    \"samples\": " << g_evidence.polling.samples << ",\n"
        << "    \"asyncDownSamples\": " << g_evidence.polling.async_down_samples << ",\n"
        << "    \"keyStateDownSamples\": " << g_evidence.polling.key_state_down_samples << ",\n"
        << "    \"keyboardStateDownSamples\": " << g_evidence.polling.keyboard_state_down_samples << ",\n"
        << "    \"errors\": " << g_evidence.polling.errors << ",\n"
        << "    \"startTickMs\": " << g_evidence.polling.start_tick_ms << ",\n"
        << "    \"endTickMs\": " << g_evidence.polling.end_tick_ms << ",\n"
        << "    \"lastSampleTickMs\": " << g_evidence.polling.last_sample_tick_ms << ",\n"
        << "    \"lastAsyncDown\": " << (g_evidence.polling.last_async_down ? "true" : "false") << ",\n"
        << "    \"lastKeyStateDown\": " << (g_evidence.polling.last_key_state_down ? "true" : "false") << ",\n"
        << "    \"lastKeyboardStateDown\": " << (g_evidence.polling.last_keyboard_state_down ? "true" : "false") << "\n"
        << "  },\n"
        << "  \"bootstrapStats\": {\n"
        << "    \"structSize\": " << g_evidence.bootstrap_stats.struct_size << ",\n"
        << "    \"abiVersion\": " << g_evidence.bootstrap_stats.abi_version << ",\n"
        << "    \"status\": " << g_evidence.bootstrap_stats.status << ",\n"
        << "    \"lastWin32Error\": " << g_evidence.bootstrap_stats.last_win32_error << ",\n"
        << "    \"lastHresult\": " << g_evidence.bootstrap_stats.last_hresult << ",\n"
        << "    \"presentCalls\": " << g_evidence.bootstrap_stats.present_calls << ",\n"
        << "    \"adoptionAttempts\": " << g_evidence.bootstrap_stats.adoption_attempts << ",\n"
        << "    \"adoptionSuccesses\": " << g_evidence.bootstrap_stats.adoption_successes << ",\n"
        << "    \"notifierRejections\": " << g_evidence.bootstrap_stats.notifier_rejections << ",\n"
        << "    \"automaticProxySkips\": " << g_evidence.bootstrap_stats.automatic_proxy_skips << ",\n"
        << "    \"resizeCalls\": " << g_evidence.bootstrap_stats.resize_calls << ",\n"
        << "    \"resizeSuccesses\": " << g_evidence.bootstrap_stats.resize_successes << ",\n"
        << "    \"retirements\": " << g_evidence.bootstrap_stats.retirements << ",\n"
        << "    \"quarantines\": " << g_evidence.bootstrap_stats.quarantines << ",\n"
        << "    \"renderFailures\": " << g_evidence.bootstrap_stats.render_failures << "\n"
        << "  },\n"
        << "  \"reshadePath\": " << json_string(utf8(g_options.reshade.native())) << ",\n"
        << "  \"addonPath\": " << json_string(utf8(g_options.addon.native())) << ",\n"
        << "  \"configPath\": " << json_string(utf8(g_options.config.native())) << "\n"
        << "}\n";

    fs::path temporary = g_options.report;
    temporary += L".tmp." + std::to_wstring(GetCurrentProcessId());
    const HANDLE output = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (output == INVALID_HANDLE_VALUE)
    {
        g_evidence.report_publication_operation = "create-temporary";
        g_evidence.report_publication_last_error = GetLastError();
        return false;
    }
    const std::string content = report.str();
    owned_report_file_identity temporary_identity;
    if (!identify_owned_report_file(output, temporary, temporary_identity))
    {
        g_evidence.report_publication_operation = "identify-temporary";
        g_evidence.report_publication_last_error = GetLastError();
        static_cast<void>(CloseHandle(output));
        return false;
    }
    DWORD written = 0;
    const bool wrote = WriteFile(output, content.data(),
        static_cast<DWORD>(content.size()), &written, nullptr) != FALSE;
    const DWORD write_error = !wrote ? GetLastError() :
        written != content.size() ? ERROR_WRITE_FAULT : ERROR_SUCCESS;
    const bool closed = CloseHandle(output) != FALSE;
    const DWORD close_error = closed ? ERROR_SUCCESS : GetLastError();
    if (write_error != ERROR_SUCCESS || close_error != ERROR_SUCCESS)
    {
        g_evidence.report_publication_operation = write_error != ERROR_SUCCESS ? "write-temporary" : "close-temporary";
        g_evidence.report_publication_last_error = write_error != ERROR_SUCCESS ? write_error : close_error;
        static_cast<void>(DeleteFileW(temporary.c_str()));
        return false;
    }
    // A diagnostic reader may briefly deny delete sharing and Windows can
    // report that contention as ACCESS_DENIED. Identity, path and regular-file
    // checks distinguish this narrow case from a foreign/read-only target.
    for (unsigned attempt = 0; attempt != 26; ++attempt)
    {
        if (!verify_atomic_report_files(temporary, temporary_identity, false))
        {
            g_evidence.report_publication_operation = "verify-atomic-files";
            g_evidence.report_publication_last_error = GetLastError();
            break;
        }
        if (MoveFileExW(temporary.c_str(), g_options.report.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE)
        {
            g_published_report_identity = temporary_identity;
            return true;
        }
        const DWORD error = GetLastError();
        g_evidence.report_publication_last_error = error;
        g_evidence.report_publication_operation = "atomic-replace";
        const bool verified_access_contention = error == ERROR_ACCESS_DENIED &&
            verify_atomic_report_files(temporary, temporary_identity, true);
        if ((error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION &&
                !verified_access_contention) || attempt == 25)
            break;
        ++g_evidence.report_publication_retries;
        Sleep(2);
    }
    if (verify_owned_report_file(temporary, temporary_identity))
        static_cast<void>(DeleteFileW(temporary.c_str()));
    return false;
}

bool fail(const std::string &reason)
{
    if (g_evidence.failure.empty())
        g_evidence.failure = reason;
    g_evidence.status = "failed";
    publish_message("EGO_GENERIC_LATE_D3D11_FAILED " + reason);
    static_cast<void>(write_report());
    return false;
}

bool path_within(const fs::path &path, const fs::path &directory)
{
    std::wstring prefix = directory.native();
    while (prefix.size() > 3 && (prefix.back() == L'\\' || prefix.back() == L'/'))
        prefix.pop_back();
    const std::wstring candidate = path.native();
    return candidate.size() > prefix.size() &&
        _wcsnicmp(candidate.c_str(), prefix.c_str(), prefix.size()) == 0 &&
        (candidate[prefix.size()] == L'\\' || candidate[prefix.size()] == L'/');
}

bool same_path(const fs::path &left, const fs::path &right)
{
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool parse_number(const std::wstring &text, std::uint64_t minimum,
                  std::uint64_t maximum, std::uint64_t &destination)
{
    if (text.empty() || text.front() == L'-' || text.front() == L'+')
        return false;
    wchar_t *end = nullptr;
    const unsigned long long value = std::wcstoull(text.c_str(), &end, 10);
    if (*end != L'\0' || value < minimum || value > maximum)
        return false;
    destination = value;
    return true;
}

bool parse_options()
{
    int count = 0;
    wchar_t **const raw = CommandLineToArgvW(GetCommandLineW(), &count);
    if (raw == nullptr)
        return false;
    std::vector<std::wstring> arguments(raw, raw + count);
    LocalFree(raw);
    for (int index = 1; index < count; ++index)
    {
        std::wstring key = arguments[static_cast<std::size_t>(index)];
        if (key == L"--prototype")
        {
            if (g_options.prototype) return false;
            g_options.prototype = true;
            continue;
        }
        const std::size_t equals = key.find(L'=');
        std::wstring value;
        if (equals != std::wstring::npos)
        {
            value = key.substr(equals + 1);
            key.resize(equals);
        }
        else if (index + 1 < count)
            value = arguments[static_cast<std::size_t>(++index)];
        else
            return false;

        if (key == L"--stage-directory") g_options.stage_directory = value;
        else if (key == L"--reshade") g_options.reshade = value;
        else if (key == L"--addon") g_options.addon = value;
        else if (key == L"--config") g_options.config = value;
        else if (key == L"--report") g_options.report = value;
        else if (key == L"--command-file") g_options.command_file = value;
        else if (key == L"--case")
        {
            g_options.case_name = utf8(value);
            if (g_options.case_name != "primary-resize" &&
                g_options.case_name != "primary-final-destroy" &&
                g_options.case_name != "primary-paused")
                return false;
        }
        else if (key == L"--frames-before-load")
        {
            if (!parse_number(value, 60, 100'000, g_options.frames_before_load)) return false;
        }
        else if (key == L"--resize-after-frames")
        {
            if (!parse_number(value, 1, 100'000, g_options.resize_after_frames)) return false;
        }
        else if (key == L"--lifetime-ms")
        {
            if (!parse_number(value, 1'000, 600'000, g_options.lifetime_ms)) return false;
        }
        else
            return false;
    }

    if (!g_options.prototype)
    {
        // Production accepts no caller-controlled configuration path.
        if (!g_options.config.empty()) return false;
        g_options.config = g_options.stage_directory / L"ReShade.ini";
    }
    if (g_options.command_file.empty())
        g_options.command_file = g_options.stage_directory / L"same-hwnd-command.txt";
    if (g_options.case_name.empty() || !g_options.command_file.is_absolute() ||
        !g_options.stage_directory.is_absolute() || !g_options.reshade.is_absolute() ||
        !g_options.addon.is_absolute() || !g_options.config.is_absolute() ||
        !g_options.report.is_absolute())
        return false;
    g_options.stage_directory = fs::canonical(g_options.stage_directory);
    g_options.reshade = fs::canonical(g_options.reshade);
    g_options.addon = fs::canonical(g_options.addon);
    g_options.config = fs::weakly_canonical(g_options.config);
    g_options.report = fs::weakly_canonical(g_options.report);
    g_options.command_file = fs::weakly_canonical(g_options.command_file);

    wchar_t executable[32'768] = {};
    const DWORD length = GetModuleFileNameW(nullptr, executable, ARRAYSIZE(executable));
    if (length == 0 || length >= ARRAYSIZE(executable))
        return false;
    const fs::path executable_directory = fs::canonical(fs::path(executable).parent_path());
    if (same_path(g_options.stage_directory, executable_directory) ||
        path_within(g_options.stage_directory, executable_directory))
        return false;
    for (const fs::path *const path : { &g_options.reshade, &g_options.addon,
                                       &g_options.config, &g_options.report, &g_options.command_file })
    {
        if (!path_within(*path, g_options.stage_directory))
            return false;
    }
    fs::path temporary_report = g_options.report;
    temporary_report += L".tmp." + std::to_wstring(GetCurrentProcessId());
    const bool valid = fs::is_directory(g_options.stage_directory) &&
        fs::is_regular_file(g_options.reshade) && fs::is_regular_file(g_options.addon) &&
        fs::is_directory(g_options.config.parent_path()) &&
        fs::is_directory(g_options.report.parent_path()) &&
        same_path(g_options.config.parent_path(), g_options.stage_directory) &&
        (g_options.prototype
            ? (g_options.config.extension() == L".ini" &&
               g_options.config.filename().wstring().rfind(L"ego-late-d3d11-", 0) == 0 &&
               !fs::exists(g_options.config))
            : (g_options.config.filename() == L"ReShade.ini" && fs::is_regular_file(g_options.config) &&
               fs::is_regular_file(g_options.stage_directory / L".electron-game-overlay-run.json") &&
               fs::is_regular_file(g_options.stage_directory / L"electron-game-overlay-owned-runtime-v1.marker"))) &&
        !same_path(g_options.config, g_options.report) &&
        !same_path(g_options.config, g_options.reshade) &&
        !same_path(g_options.config, g_options.addon) &&
        !same_path(g_options.report, g_options.reshade) &&
        !same_path(g_options.report, g_options.addon) &&
        !same_path(g_options.command_file, g_options.report) &&
        !same_path(g_options.command_file, g_options.config) &&
        !same_path(g_options.command_file, g_options.reshade) &&
        !same_path(g_options.command_file, g_options.addon) &&
        !same_path(g_options.command_file, temporary_report) &&
        !same_path(temporary_report, g_options.config) &&
        !same_path(temporary_report, g_options.reshade) &&
        !same_path(temporary_report, g_options.addon);
    g_paths_validated = valid;
    return valid;
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    switch (message)
    {
    case WM_SIZE:
        if (wparam != SIZE_MINIMIZED)
        {
            g_graphics.pending_width = LOWORD(lparam);
            g_graphics.pending_height = HIWORD(lparam);
        }
        return 0;
    case WM_KEYDOWN: ++g_evidence.key_down_messages; break;
    case WM_KEYUP: ++g_evidence.key_up_messages; break;
    case WM_CHAR: ++g_evidence.character_messages; break;
    case WM_LBUTTONDOWN: ++g_evidence.pointer_down_messages; break;
    case WM_INPUT:
    {
        RAWINPUT input = {};
        UINT size = sizeof(input);
        const UINT copied = GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam), RID_INPUT,
            &input, &size, sizeof(RAWINPUTHEADER));
        if (copied == UINT(-1) || copied < sizeof(RAWINPUTHEADER))
            ++g_evidence.raw_input_errors;
        else if (input.header.dwType == RIM_TYPEKEYBOARD)
        {
            if ((input.data.keyboard.Flags & RI_KEY_BREAK) != 0) ++g_evidence.raw_key_up_messages;
            else ++g_evidence.raw_key_down_messages;
        }
        else if (input.header.dwType == RIM_TYPEMOUSE &&
            (input.data.mouse.usButtonFlags & RI_MOUSE_LEFT_BUTTON_DOWN) != 0)
            ++g_evidence.raw_pointer_down_messages;
        break;
    }
    case WM_CLOSE: DestroyWindow(window); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

bool create_target()
{
    ComPtr<ID3D11Texture2D> back_buffer;
    return SUCCEEDED(g_graphics.swapchain->GetBuffer(0, IID_PPV_ARGS(&back_buffer))) &&
        SUCCEEDED(g_graphics.device->CreateRenderTargetView(back_buffer.Get(), nullptr,
            &g_graphics.target));
}

bool create_graphics()
{
    RECT client = {};
    if (!GetClientRect(g_graphics.window, &client))
        return fail("GetClientRect failed.");
    g_graphics.width = static_cast<UINT>(client.right);
    g_graphics.height = static_cast<UINT>(client.bottom);
    DXGI_SWAP_CHAIN_DESC description = {};
    description.BufferDesc.Width = g_graphics.width;
    description.BufferDesc.Height = g_graphics.height;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.BufferCount = 2;
    description.OutputWindow = g_graphics.window;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    HRESULT result = E_FAIL;
    for (const D3D_DRIVER_TYPE driver : { D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP })
    {
        result = D3D11CreateDeviceAndSwapChain(nullptr, driver, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
            &description, &g_graphics.swapchain, &g_graphics.device,
            &g_evidence.feature_level, &g_graphics.context);
        if (SUCCEEDED(result))
        {
            g_evidence.used_warp = driver == D3D_DRIVER_TYPE_WARP;
            break;
        }
        g_graphics.swapchain.Reset();
        g_graphics.context.Reset();
        g_graphics.device.Reset();
    }
    if (FAILED(result) || !create_target())
        return fail("Cannot create the raw D3D11 device, swapchain, and render target.");

    D3D11_RASTERIZER_DESC rasterizer = {};
    rasterizer.FillMode = D3D11_FILL_SOLID;
    rasterizer.CullMode = D3D11_CULL_NONE;
    rasterizer.DepthClipEnable = TRUE;
    rasterizer.ScissorEnable = TRUE;
    D3D11_BLEND_DESC blend = {};
    for (auto &render_target : blend.RenderTarget)
    {
        render_target.SrcBlend = D3D11_BLEND_ONE;
        render_target.DestBlend = D3D11_BLEND_ZERO;
        render_target.BlendOp = D3D11_BLEND_OP_ADD;
        render_target.SrcBlendAlpha = D3D11_BLEND_ONE;
        render_target.DestBlendAlpha = D3D11_BLEND_ZERO;
        render_target.BlendOpAlpha = D3D11_BLEND_OP_ADD;
    }
    blend.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    D3D11_DEPTH_STENCIL_DESC depth_stencil = {};
    depth_stencil.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
    depth_stencil.DepthFunc = D3D11_COMPARISON_ALWAYS;
    depth_stencil.StencilReadMask = D3D11_DEFAULT_STENCIL_READ_MASK;
    depth_stencil.StencilWriteMask = D3D11_DEFAULT_STENCIL_WRITE_MASK;
    depth_stencil.FrontFace.StencilFailOp = D3D11_STENCIL_OP_KEEP;
    depth_stencil.FrontFace.StencilDepthFailOp = D3D11_STENCIL_OP_KEEP;
    depth_stencil.FrontFace.StencilPassOp = D3D11_STENCIL_OP_KEEP;
    depth_stencil.FrontFace.StencilFunc = D3D11_COMPARISON_ALWAYS;
    depth_stencil.BackFace = depth_stencil.FrontFace;
    if (FAILED(g_graphics.device->CreateRasterizerState(&rasterizer, &g_graphics.rasterizer)) ||
        FAILED(g_graphics.device->CreateBlendState(&blend, &g_graphics.blend)) ||
        FAILED(g_graphics.device->CreateDepthStencilState(&depth_stencil, &g_graphics.depth_stencil)))
        return fail("Cannot create D3D11 sentinel pipeline states.");
    g_graphics.pending_width = g_graphics.pending_height = 0;
    return true;
}

bool create_secondary_target()
{
    ComPtr<ID3D11Texture2D> buffer;
    return SUCCEEDED(g_graphics.secondary_swapchain->GetBuffer(0, IID_PPV_ARGS(&buffer))) &&
        SUCCEEDED(g_graphics.device->CreateRenderTargetView(buffer.Get(), nullptr,
            &g_graphics.secondary_target));
}

bool create_secondary_graphics()
{
    ComPtr<IDXGIDevice> dxgi_device;
    ComPtr<IDXGIAdapter> adapter;
    ComPtr<IDXGIFactory> factory;
    DXGI_SWAP_CHAIN_DESC description = {};
    if (FAILED(g_graphics.device.As(&dxgi_device)) ||
        FAILED(dxgi_device->GetAdapter(&adapter)) ||
        FAILED(adapter->GetParent(IID_PPV_ARGS(&factory))) ||
        FAILED(g_graphics.swapchain->GetDesc(&description)))
        return fail("Cannot resolve the raw device factory for a same-HWND peer chain.");
    if (description.SwapEffect != DXGI_SWAP_EFFECT_DISCARD ||
        description.OutputWindow != g_graphics.window)
        return fail("The controlled same-HWND case requires a raw discard primary chain.");
    if (FAILED(factory->CreateSwapChain(g_graphics.device.Get(), &description,
            &g_graphics.secondary_swapchain)) || !create_secondary_target())
        return fail("Cannot create the second raw D3D11 discard swapchain on the same HWND.");
    DXGI_SWAP_CHAIN_DESC secondary_description = {};
    g_evidence.same_hwnd_verified =
        SUCCEEDED(g_graphics.secondary_swapchain->GetDesc(&secondary_description)) &&
        secondary_description.OutputWindow == description.OutputWindow &&
        secondary_description.OutputWindow == g_graphics.window;
    return g_evidence.same_hwnd_verified || fail("The two native chains do not share the exact HWND.");
}

bool no_existing_runtime()
{
    HMODULE modules[1'024] = {};
    DWORD needed = 0;
    if (!K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &needed) ||
        needed > sizeof(modules))
        return fail("Cannot prove that no ReShade host was already loaded.");
    for (DWORD index = 0; index < needed / sizeof(HMODULE); ++index)
    {
        if (GetProcAddress(modules[index], "ReShadeRegisterAddon") != nullptr)
        {
            g_evidence.preexisting_runtime = true;
            return fail("A ReShade host already exists; the prototype will not load another.");
        }
    }
    return true;
}

bool query_bootstrap_stats()
{
    if (g_graphics.query_bootstrap == nullptr)
        return fail("The owned bootstrap statistics export is unavailable.");
    ego_owned_late_d3d11_stats_v1 snapshot = { sizeof(snapshot), 1 };
    g_evidence.stats_query_result = g_graphics.query_bootstrap(&snapshot);
    if (g_evidence.stats_query_result != ERROR_SUCCESS ||
        snapshot.struct_size != sizeof(snapshot) || snapshot.abi_version != 1)
        return fail("Cannot query the fixed-layout owned bootstrap statistics.");
    g_evidence.bootstrap_stats = snapshot;
    if (snapshot.status != 2 || snapshot.quarantines != 0 || snapshot.render_failures != 0)
        return fail("The owned discovery bootstrap became passive, quarantined, or reported a render failure.");
    return true;
}

bool load_and_adopt()
{
    g_evidence.phase = "loading-after-existing-presents";
    if (!write_report())
        return fail("Cannot publish the pre-load evidence report.");
    if (!no_existing_runtime())
        return false;
    g_graphics.reshade_module = LoadLibraryExW(g_options.reshade.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (g_graphics.reshade_module == nullptr)
    {
        g_evidence.reshade_load_error = GetLastError();
        return fail("Cannot load the supplied owned ReShade DLL.");
    }
    if (g_options.prototype)
    {
        g_graphics.initialize_prototype = reinterpret_cast<initialize_prototype_fn>(
            GetProcAddress(g_graphics.reshade_module, "ReShadeInitializeOwnedLateD3D11V1"));
        g_graphics.query_bootstrap = reinterpret_cast<query_bootstrap_fn>(
            GetProcAddress(g_graphics.reshade_module, "ReShadeQueryOwnedLateD3D11V1"));
        if (g_graphics.initialize_prototype == nullptr || g_graphics.query_bootstrap == nullptr)
            return fail("The explicitly selected prototype host lacks its exact exports.");
    }
    else
    {
        const auto capability = reinterpret_cast<const std::uint32_t *>(
            GetProcAddress(g_graphics.reshade_module, "ElectronGameOverlayOwnedLateD3D11AbiV1"));
        if (capability == nullptr || *capability != 1)
            return fail("The production host lacks the exact owned late D3D11 capability ABI.");
        g_evidence.bootstrap_abi = *capability;
        g_graphics.initialize_bootstrap = reinterpret_cast<initialize_bootstrap_fn>(
            GetProcAddress(g_graphics.reshade_module, "ElectronGameOverlayInitializeOwnedLateD3D11V1"));
        g_graphics.query_bootstrap = reinterpret_cast<query_bootstrap_fn>(
            GetProcAddress(g_graphics.reshade_module, "ElectronGameOverlayQueryOwnedLateD3D11V1"));
        if (g_graphics.initialize_bootstrap == nullptr || g_graphics.query_bootstrap == nullptr)
            return fail("The production owned host lacks its exact late D3D11 exports.");
    }

    volatile LONG *addon_gate = nullptr;
    if (!g_options.prototype)
    {
        const auto host_abi = reinterpret_cast<const std::uint32_t *>(
            GetProcAddress(g_graphics.reshade_module, "ElectronGameOverlayReShadeHostAbi"));
        addon_gate = reinterpret_cast<volatile LONG *>(
            GetProcAddress(g_graphics.reshade_module, "ElectronGameOverlayReShadeAddonGate"));
        if (host_abi == nullptr || *host_abi != 1 || addon_gate == nullptr)
            return fail("The production host lacks the exact adapter registration gate ABI.");
        g_evidence.addon_gate_observed = InterlockedCompareExchange(addon_gate, 1, 0);
        if (g_evidence.addon_gate_observed != 0)
            return fail("The controlled self-loader did not acquire an OPEN adapter gate; it will not race or replace another adapter.");
        g_evidence.addon_gate_claimed = true;
    }
    g_graphics.addon_module = LoadLibraryExW(g_options.addon.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (g_graphics.addon_module == nullptr)
    {
        g_evidence.addon_load_error = GetLastError();
        // Only our failed, unpublished load can reopen our LOADING claim.
        if (addon_gate != nullptr)
            static_cast<void>(InterlockedCompareExchange(addon_gate, 0, 1));
        return fail("Cannot load the supplied private cooperative add-on.");
    }
    if (addon_gate != nullptr)
    {
        // Successful LoadLibrary has completed the initial adapter's DllMain.
        // Never fabricate REGISTERED if somebody changed our LOADING claim.
        if (InterlockedCompareExchange(addon_gate, 2, 1) != 1)
            return fail("The production adapter gate changed during our successful add-on load.");
        g_evidence.addon_gate_registered = true;
    }
    const auto initialize = reinterpret_cast<initialize_member_fn>(GetProcAddress(
        g_graphics.addon_module, "ElectronGameOverlayInitializeMember"));
    if (initialize == nullptr)
        return fail("The supplied add-on lacks ElectronGameOverlayInitializeMember.");
    g_evidence.member_initialize_result = initialize(nullptr);
    if (g_evidence.member_initialize_result != ERROR_SUCCESS)
        return fail("The private cooperative add-on initializer failed.");
    if (g_options.prototype)
    {
        // The old diagnostic ABI alone accepts a new owned config path.
        ego_owned_late_d3d11_initialize_v1 request = { sizeof(request), 1 };
        if (g_options.config.native().size() >= ARRAYSIZE(request.owned_config_path) ||
            wcscpy_s(request.owned_config_path, g_options.config.c_str()) != 0)
            return fail("The new prototype configuration path is too long.");
        if (fs::exists(g_options.config))
            return fail("The prototype requires a new nonexistent configuration file.");
        g_evidence.bootstrap_initialize_result = g_graphics.initialize_prototype(&request);
    }
    else
    {
        g_evidence.bootstrap_initialize_result = g_graphics.initialize_bootstrap(nullptr);
        g_evidence.bootstrap_initializer_used_null_request = true;
    }
    if (g_evidence.bootstrap_initialize_result != ERROR_SUCCESS)
        return fail("The explicitly selected owned D3D11 initializer returned failure.");
    g_graphics.bootstrap_active = true;
    if (!query_bootstrap_stats())
        return false;
    g_evidence.loaded_at = GetTickCount64();
    g_evidence.phase = "generic-discovery-hooks-active";
    publish_message("EGO_GENERIC_LATE_D3D11_HOOKS_ACTIVE");
    return write_report() || fail("Cannot publish the owned discovery bootstrap report.");
}

bool resize_graphics(UINT width, UINT height)
{
    const bool observed = g_graphics.bootstrap_active;
    if (observed)
    {
        g_evidence.phase = "raw-native-resize-through-discovery-hook";
        ++g_evidence.resize_attempts;
    }
    g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
    g_graphics.target.Reset();
    g_graphics.context->Flush();
    g_evidence.last_resize_result = g_graphics.swapchain->ResizeBuffers(
        0, width, height, DXGI_FORMAT_UNKNOWN, 0);
    const bool resized = SUCCEEDED(g_evidence.last_resize_result);
    // Failed DXGI resize retains the old buffers. Reacquire them before cleanup.
    if (!create_target())
        return fail("Cannot reacquire the render target after ResizeBuffers.");
    if (observed && !query_bootstrap_stats())
        return false;
    if (!resized)
        return fail("IDXGISwapChain::ResizeBuffers failed.");
    g_graphics.width = width;
    g_graphics.height = height;
    if (observed)
    {
        ++g_evidence.resize_successes;
        g_evidence.frames_after_resize = 0;
        g_evidence.phase = "generic-runtime-resized-by-bootstrap";
        publish_message("EGO_GENERIC_LATE_D3D11_RESIZE_COMPLETED");
        return write_report() || fail("Cannot publish the resize report.");
    }
    return true;
}

bool check_pipeline_state(const D3D11_VIEWPORT &expected_viewport,
                          const D3D11_RECT &expected_scissor,
                          ID3D11RenderTargetView *expected_target)
{
    ++g_evidence.state_checks;
    D3D11_PRIMITIVE_TOPOLOGY topology = {};
    g_graphics.context->IAGetPrimitiveTopology(&topology);
    ComPtr<ID3D11RasterizerState> rasterizer;
    g_graphics.context->RSGetState(&rasterizer);
    UINT viewport_count = 1;
    D3D11_VIEWPORT viewport = {};
    g_graphics.context->RSGetViewports(&viewport_count, &viewport);
    UINT scissor_count = 1;
    D3D11_RECT scissor = {};
    g_graphics.context->RSGetScissorRects(&scissor_count, &scissor);
    ComPtr<ID3D11RenderTargetView> target;
    g_graphics.context->OMGetRenderTargets(1, &target, nullptr);
    ComPtr<ID3D11BlendState> blend;
    float factors[4] = {};
    UINT sample_mask = 0;
    g_graphics.context->OMGetBlendState(&blend, factors, &sample_mask);
    ComPtr<ID3D11DepthStencilState> depth_stencil;
    UINT stencil_reference = 0;
    g_graphics.context->OMGetDepthStencilState(&depth_stencil, &stencil_reference);
    const bool matched = topology == D3D11_PRIMITIVE_TOPOLOGY_LINELIST &&
        rasterizer.Get() == g_graphics.rasterizer.Get() && viewport_count == 1 &&
        viewport.TopLeftX == expected_viewport.TopLeftX &&
        viewport.TopLeftY == expected_viewport.TopLeftY &&
        viewport.Width == expected_viewport.Width && viewport.Height == expected_viewport.Height &&
        viewport.MinDepth == expected_viewport.MinDepth && viewport.MaxDepth == expected_viewport.MaxDepth &&
        scissor_count == 1 && scissor.left == expected_scissor.left &&
        scissor.top == expected_scissor.top && scissor.right == expected_scissor.right &&
        scissor.bottom == expected_scissor.bottom && target.Get() == expected_target &&
        blend.Get() == g_graphics.blend.Get() && factors[0] == 0.125f &&
        factors[1] == 0.25f && factors[2] == 0.5f && factors[3] == 1.0f &&
        sample_mask == 0x5a5a5a5a && depth_stencil.Get() == g_graphics.depth_stencil.Get() &&
        stencil_reference == 37;
    if (!matched)
    {
        ++g_evidence.state_mismatches;
        return fail("The hooked native Present did not preserve sampled D3D11 pipeline state.");
    }
    return true;
}

bool render_chain(IDXGISwapChain *chain, ID3D11RenderTargetView *target, bool primary)
{
    const float clear[4] = { 0.08f, 0.12f, 0.20f, 1.0f };
    const float blend_factors[4] = { 0.125f, 0.25f, 0.5f, 1.0f };
    const D3D11_VIEWPORT viewport = { 7.0f, 11.0f,
        static_cast<float>(g_graphics.width) - 14.0f,
        static_cast<float>(g_graphics.height) - 22.0f, 0.125f, 0.875f };
    const D3D11_RECT scissor = { 13, 17, static_cast<LONG>(g_graphics.width) - 13,
        static_cast<LONG>(g_graphics.height) - 17 };
    g_graphics.context->OMSetRenderTargets(1, &target, nullptr);
    g_graphics.context->ClearRenderTargetView(target, clear);
    g_graphics.context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_LINELIST);
    g_graphics.context->RSSetState(g_graphics.rasterizer.Get());
    g_graphics.context->RSSetViewports(1, &viewport);
    g_graphics.context->RSSetScissorRects(1, &scissor);
    g_graphics.context->OMSetBlendState(g_graphics.blend.Get(), blend_factors, 0x5a5a5a5a);
    g_graphics.context->OMSetDepthStencilState(g_graphics.depth_stencil.Get(), 37);
    const bool observed = g_graphics.bootstrap_active;
    const auto adoptions_before = g_evidence.bootstrap_stats.adoption_successes;
    ++g_evidence.native_present_calls;
    g_evidence.last_present_result = chain->Present(1, 0);
    if (FAILED(g_evidence.last_present_result))
        return fail("Raw IDXGISwapChain::Present failed.");
    if (observed)
    {
        // Native Present is the only presentation call. The owned host must
        // discover/adopt/render from its hook; this caller passes no pointers.
        // Do not restore context state here or conceal a hook/runtime defect.
        if (!check_pipeline_state(viewport, scissor, target) || !query_bootstrap_stats())
            return false;
        if (g_evidence.bootstrap_stats.adoption_successes != adoptions_before)
        {
            if (g_evidence.bootstrap_stats.adoption_successes != adoptions_before + 1)
                return fail("One native Present changed adoption count by more than one.");
            if (adoptions_before == 0)
            {
                g_evidence.first_adopted_role = primary ? "primary" : "secondary";
                g_evidence.first_adopted_native = reinterpret_cast<std::uintptr_t>(chain);
            }
        }
    }
    if (g_evidence.last_present_result == S_OK)
    {
        if (!observed)
        {
            if (primary) ++g_evidence.primary_frames_before_load;
            else ++g_evidence.secondary_frames_before_load;
            g_evidence.frames_before_load = (std::min)(
                g_evidence.primary_frames_before_load, g_evidence.secondary_frames_before_load);
        }
        else
        {
            if (primary)
            {
                ++g_evidence.primary_frames_after_load;
                if (g_evidence.resize_successes != 0) ++g_evidence.frames_after_resize;
            }
            else
            {
                ++g_evidence.secondary_frames_after_load;
                if (g_evidence.lifecycle_applied) ++g_evidence.secondary_frames_after_lifecycle;
            }
            if (primary || g_graphics.swapchain == nullptr ||
                (g_options.case_name == "primary-paused" && g_evidence.lifecycle_applied))
                ++g_evidence.frames_after_load;
        }
    }
    else
        Sleep(10); // Occlusion is not counted as an actual successful presentation.
    return true;
}

bool render_frame()
{
    // The first post-bootstrap cycle presents A first so that A is the original
    // ReShade input consumer. Thereafter A is presented last while it lives, so
    // EGO's chosen primary surface remains visible on this shared HWND.
    const bool primary_first = !g_graphics.bootstrap_active ||
        g_evidence.bootstrap_stats.adoption_successes < 2;
    const bool primary_paused = g_options.case_name == "primary-paused" && g_evidence.lifecycle_applied;
    if (primary_first && g_graphics.swapchain != nullptr && !primary_paused &&
        !render_chain(g_graphics.swapchain.Get(), g_graphics.target.Get(), true))
        return false;
    if (!render_chain(g_graphics.secondary_swapchain.Get(),
            g_graphics.secondary_target.Get(), false))
        return false;
    return primary_first || g_graphics.swapchain == nullptr || primary_paused ||
        render_chain(g_graphics.swapchain.Get(), g_graphics.target.Get(), true);
}

bool wait_for_retirements(std::uint64_t expected)
{
    if (g_graphics.context == nullptr)
        return fail("Cannot observe retirement after releasing the native context.");
    const auto deadline = GetTickCount64() + 5000;
    do
    {
        g_graphics.context->Flush();
        if (!query_bootstrap_stats()) return false;
        if (g_evidence.bootstrap_stats.retirements == expected) return true;
        if (g_evidence.bootstrap_stats.retirements > expected)
            return fail("Unexpected extra raw-chain retirement was observed.");
        Sleep(1);
    } while (GetTickCount64() < deadline);
    return fail("Native final release did not produce its actual retirement notification within five seconds.");
}

bool apply_lifecycle_case()
{
    if (!g_graphics.bootstrap_active || g_evidence.lifecycle_applied ||
        g_evidence.polling.active || g_evidence.completed_pre_lifecycle_windows < 1 ||
        g_evidence.bootstrap_stats.adoption_successes != 2 ||
        g_graphics.swapchain == nullptr || g_graphics.secondary_swapchain == nullptr)
        return fail("The lifecycle command requires two adopted live chains and no active polling window.");
    if (g_options.case_name == "primary-resize")
    {
        // This is a real ResizeBuffers call and runtime reset/reinitialization.
        // Retain the client/buffer dimensions to isolate ownership from scaling.
        if (!resize_graphics(g_graphics.width, g_graphics.height))
            return false;
        if (g_evidence.bootstrap_stats.resize_calls != 1 ||
            g_evidence.bootstrap_stats.resize_successes != 1 ||
            g_evidence.bootstrap_stats.retirements != 0)
            return fail("Primary ResizeBuffers did not produce exactly one reset while both chains survived.");
        g_evidence.phase = "primary-resized-peer-live";
    }
    else if (g_options.case_name == "primary-paused")
    {
        g_evidence.primary_frames_at_pause = g_evidence.primary_frames_after_load;
        g_evidence.phase = "primary-alive-paused-peer-presenting";
    }
    else
    {
        g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
        g_graphics.target.Reset();
        g_graphics.context->Flush();
        g_graphics.swapchain.Reset();
        if (!wait_for_retirements(1) ||
            g_evidence.bootstrap_stats.adoption_successes != 2)
            return fail("Primary final release did not retire one chain while its same-HWND peer survived.");
        g_evidence.phase = "primary-retired-peer-live";
    }
    g_evidence.lifecycle_applied = true;
    g_evidence.secondary_frames_after_lifecycle = 0;
    return true;
}

bool process_control_command()
{
    const HANDLE file = CreateFileW(g_options.command_file.c_str(), GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return GetLastError() == ERROR_FILE_NOT_FOUND || fail("Cannot read the owned lifecycle command file.");
    char bytes[512] = {};
    DWORD length = 0;
    const bool read = ReadFile(file, bytes, sizeof(bytes), &length, nullptr) != FALSE;
    const bool closed = CloseHandle(file) != FALSE;
    if (!read || !closed || length == 0 || length >= sizeof(bytes))
        return fail("The owned lifecycle command is unreadable or exceeds its fixed bound.");
    std::istringstream command(std::string(bytes, bytes + length));
    std::string magic;
    std::string action;
    std::string extra;
    std::uint64_t sequence = 0;
    if (!(command >> magic >> sequence >> action) || command >> extra ||
        magic != "EGO_SAME_HWND_COMMAND_V1" || sequence == 0)
        return fail("The owned lifecycle command has an invalid schema.");
    if (sequence <= g_evidence.command_sequence)
        return true;
    if (!g_graphics.bootstrap_active || g_evidence.bootstrap_stats.adoption_successes != 2)
        return fail("Controller commands cannot run before both raw chains are adopted.");
    if (action == "sample-begin")
    {
        if (g_evidence.polling.active)
            return fail("A polling window is already active.");
        g_evidence.polling = {};
        g_evidence.polling.epoch = sequence;
        g_evidence.polling.active = true;
        g_evidence.polling.start_tick_ms = GetTickCount64();
    }
    else if (action == "sample-end")
    {
        if (!g_evidence.polling.active || g_evidence.polling.samples == 0)
            return fail("No nonempty polling window is active.");
        g_evidence.polling.active = false;
        g_evidence.polling.end_tick_ms = GetTickCount64();
        ++g_evidence.completed_sampling_windows;
        if (g_evidence.lifecycle_applied) ++g_evidence.completed_post_lifecycle_windows;
        else ++g_evidence.completed_pre_lifecycle_windows;
    }
    else if (action == "apply-lifecycle")
    {
        if (!apply_lifecycle_case())
            return false;
    }
    else if (action == "finish")
    {
        if (g_evidence.polling.active || !g_evidence.lifecycle_applied ||
            g_evidence.secondary_frames_after_lifecycle < 60 ||
            g_evidence.completed_pre_lifecycle_windows < 1 ||
            g_evidence.completed_post_lifecycle_windows < 2)
            return fail("Finish requires the lifecycle case, 60 survivor frames, and three completed polling windows.");
        g_evidence.finish_requested = true;
    }
    else
        return fail("The owned lifecycle command action is unsupported.");
    g_evidence.command_sequence = sequence;
    return write_report() || fail("Cannot acknowledge the owned lifecycle command.");
}

bool sample_native_key_polling()
{
    auto &polling = g_evidence.polling;
    if (!polling.active)
        return true;
    BYTE keyboard[256] = {};
    const SHORT async_state = GetAsyncKeyState(test_virtual_key);
    const SHORT queue_state = GetKeyState(test_virtual_key);
    const BOOL keyboard_ok = GetKeyboardState(keyboard);
    ++polling.samples;
    polling.last_sample_tick_ms = GetTickCount64();
    polling.last_async_down = (async_state & 0x8000) != 0;
    polling.last_key_state_down = (queue_state & 0x8000) != 0;
    polling.last_keyboard_state_down = keyboard_ok && (keyboard[test_virtual_key] & 0x80) != 0;
    if (polling.last_async_down) ++polling.async_down_samples;
    if (polling.last_key_state_down) ++polling.key_state_down_samples;
    if (polling.last_keyboard_state_down) ++polling.keyboard_state_down_samples;
    if (!keyboard_ok)
    {
        ++polling.errors;
        return fail("The native GetKeyboardState polling call failed.");
    }
    return true;
}

void cleanup_graphics()
{
    if (g_graphics.context != nullptr)
    {
        g_graphics.context->ClearState();
        g_graphics.context->Flush();
    }
    g_graphics.target.Reset();
    g_graphics.secondary_target.Reset();
    if (g_graphics.context != nullptr)
        g_graphics.context->Flush();
    if (g_graphics.swapchain != nullptr)
        g_graphics.swapchain.Reset();
    if (g_graphics.secondary_swapchain != nullptr)
        g_graphics.secondary_swapchain.Reset();
    g_evidence.chain_released_before_device_context =
        g_graphics.context != nullptr && g_graphics.device != nullptr;
    if (g_graphics.bootstrap_active && g_graphics.context != nullptr)
        g_evidence.retired_before_device_context_release = wait_for_retirements(2);
    g_graphics.rasterizer.Reset();
    g_graphics.blend.Reset();
    g_graphics.depth_stencil.Reset();
    g_graphics.context.Reset();
    g_graphics.device.Reset();
    // ReShade/add-on modules intentionally stay mapped until process exit.
}

int run(HINSTANCE instance)
{
    if (!parse_options())
    {
        publish_message("Usage: late_d3d11_same_hwnd_host --stage-directory <absolute external stage> "
            "--reshade <absolute staged DLL> --addon <absolute staged addon> "
            "--report <absolute staged JSON> [--prototype --config <new staged ego-late-d3d11-*.ini>] "
            "--case <primary-resize|primary-final-destroy|primary-paused> [--command-file <absolute staged text>] "
            "[--frames-before-load 60+] [--lifetime-ms 60000]");
        return 2;
    }
    if (!write_report())
        return fail("Cannot create the owned evidence report.") ? 0 : 1;
    WNDCLASSEXW window_type = { sizeof(window_type) };
    window_type.lpfnWndProc = window_proc;
    window_type.hInstance = instance;
    window_type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_type.lpszClassName = window_class;
    if (!RegisterClassExW(&window_type))
        return fail("RegisterClassExW failed.") ? 0 : 1;
    RECT bounds = { 0, 0, 800, 600 };
    if (!AdjustWindowRectEx(&bounds, WS_OVERLAPPEDWINDOW, FALSE, 0))
        return fail("AdjustWindowRectEx failed.") ? 0 : 1;
    g_graphics.window = CreateWindowExW(0, window_class, window_title,
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left,
        bounds.bottom - bounds.top, nullptr, nullptr, instance, nullptr);
    if (g_graphics.window == nullptr || !create_graphics() || !create_secondary_graphics())
        return fail("Cannot create the controlled D3D11 window/graphics.") ? 0 : 1;
    if (g_options.case_name == "primary-paused")
    {
        RAWINPUTDEVICE devices[] = {{1, 2, 0, g_graphics.window}, {1, 6, 0, g_graphics.window}};
        if (!RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE)))
            return fail("Cannot register the paused-primary foreground WM_INPUT oracle.") ? 0 : 1;
        g_evidence.raw_input_registered = true;
    }
    ShowWindow(g_graphics.window, SW_SHOW);
    UpdateWindow(g_graphics.window);
    g_evidence.phase = "raw-swapchain-presenting-before-load";
    publish_message("EGO_GENERIC_LATE_D3D11_RAW_PRESENTS_STARTED");
    std::uint64_t last_report_at = 0;
    bool completed = false;
    while (g_evidence.failure.empty())
    {
        MSG message = {};
        bool quit = false;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            if (message.message == WM_QUIT)
            {
                quit = true;
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if (quit)
        {
            fail("Window closed before the timed lifecycle completed.");
            break;
        }
        if (g_graphics.pending_width != 0 && g_graphics.pending_height != 0)
        {
            const UINT width = g_graphics.pending_width;
            const UINT height = g_graphics.pending_height;
            g_graphics.pending_width = g_graphics.pending_height = 0;
            if (width != g_graphics.width || height != g_graphics.height)
            {
                fail("An external window resize invalidated the controlled same-HWND input case.");
                break;
            }
        }
        if (!render_frame())
            break;
        if (g_evidence.loaded_at == 0 &&
            g_evidence.frames_before_load >= g_options.frames_before_load && !load_and_adopt())
            break;
        if (!process_control_command())
            break;
        if (g_evidence.finish_requested)
        {
            completed = true;
            break;
        }
        if (!sample_native_key_polling())
            break;
        const std::uint64_t now = GetTickCount64();
        if (g_evidence.loaded_at == 0 && now - g_evidence.started_at >= startup_timeout_ms)
        {
            fail("Not enough real pre-load Present calls completed within the startup timeout.");
            break;
        }
        if (g_evidence.loaded_at != 0 && now - g_evidence.loaded_at >= g_options.lifetime_ms)
        {
            fail("The controller did not finish the same-HWND input case before its bounded lifetime.");
            break;
        }
        if (now - last_report_at >= 100)
        {
            refresh_registry_evidence();
            if (!write_report())
            {
                fail("Cannot refresh the owned evidence report.");
                break;
            }
            last_report_at = now;
        }
    }
    cleanup_graphics();
    if (IsWindow(g_graphics.window))
        DestroyWindow(g_graphics.window);
    if (completed && g_evidence.failure.empty())
    {
        const std::uint64_t expected_resizes = g_options.case_name == "primary-resize" ? 1 : 0;
        if (!g_evidence.same_hwnd_verified || g_evidence.frames_before_load < 60 ||
            g_evidence.primary_frames_before_load < 60 || g_evidence.secondary_frames_before_load < 60 ||
            g_evidence.resize_attempts != expected_resizes || g_evidence.resize_successes != expected_resizes ||
            !g_evidence.lifecycle_applied || g_evidence.secondary_frames_after_lifecycle < 60 ||
            g_evidence.completed_pre_lifecycle_windows < 1 ||
            g_evidence.completed_post_lifecycle_windows < 2 || g_evidence.polling.active ||
            g_evidence.state_checks == 0 || g_evidence.state_mismatches != 0 ||
            g_evidence.first_adopted_role != "primary" || g_evidence.first_adopted_native == 0 ||
            (g_options.case_name == "primary-paused" &&
                (g_evidence.primary_frames_after_load != g_evidence.primary_frames_at_pause ||
                 !g_evidence.raw_input_registered || g_evidence.raw_input_errors != 0)) ||
            !g_evidence.chain_released_before_device_context ||
            !g_evidence.retired_before_device_context_release ||
            g_evidence.bootstrap_initialize_result != ERROR_SUCCESS ||
            g_evidence.stats_query_result != ERROR_SUCCESS ||
            g_evidence.bootstrap_stats.status != 2 ||
            g_evidence.bootstrap_stats.adoption_successes != 2 ||
            g_evidence.bootstrap_stats.resize_calls != expected_resizes ||
            g_evidence.bootstrap_stats.resize_successes != expected_resizes ||
            g_evidence.bootstrap_stats.retirements != 2 ||
            g_evidence.bootstrap_stats.quarantines != 0 ||
            g_evidence.bootstrap_stats.render_failures != 0)
            fail("The controlled run did not complete both same-HWND raw lifetimes and all polling windows.");
        else
        {
            g_evidence.status = "passed";
            g_evidence.phase = "complete";
            g_evidence.native_swapchain_discovery_proven = true;
            publish_message("EGO_GENERIC_LATE_D3D11_DISCOVERY_LIFECYCLE_PASSED");
        }
    }
    refresh_registry_evidence();
    if (!write_report())
    {
        publish_message("EGO_GENERIC_LATE_D3D11_FAILED Cannot publish the final evidence report.");
        return 1;
    }
    return g_evidence.status == "passed" ? 0 : 1;
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int)
{
    try
    {
        return run(instance);
    }
    catch (const std::exception &error)
    {
        fail(error.what());
        cleanup_graphics();
        static_cast<void>(write_report());
        return 1;
    }
}
