#include <Windows.h>
#include <shellapi.h>

#include <d3d11.h>
#include <dxgi.h>
#include <dxgi1_2.h>
#include <dcomp.h>
#include <wrl/client.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <cmath>
#include <cwchar>
#include <limits>
#include <string>

#include "input_oracle.hpp"

namespace
{
using Microsoft::WRL::ComPtr;

#pragma comment(lib, "Shell32.lib")
#pragma comment(lib, "dcomp.lib")

constexpr wchar_t kWindowClassName[] = L"ElectronGameOverlayD3D11TestHost";
constexpr wchar_t kWindowTitle[] = L"Controlled D3D11 overlay test host";
constexpr wchar_t kSecondaryWindowTitle[] =
    L"Controlled D3D11 overlay test host B";
constexpr wchar_t kInjectedRuntimeWaitMarker[] = L"reshade-injection-wait.enabled";
constexpr wchar_t kStartupBarrierMarker[] =
    L"electron-game-overlay-startup-barrier.enabled";
// Opt-in controlled-demo instrumentation only; no production attach path.
HMODULE g_test_external_runtime = nullptr;
bool g_test_present_ack_enabled = false;
unsigned g_test_successful_presents = 0;
constexpr wchar_t kDestroyFinalSurfaceRequestMarker[] =
    L"electron-game-overlay-destroy-final-surface.request";
constexpr wchar_t kDestroyPrimarySurfaceRequestMarker[] =
    L"electron-game-overlay-destroy-primary-surface.request";
constexpr wchar_t kFinalSurfaceDestroyedAckMarker[] =
    L"electron-game-overlay-final-surface-destroyed.ack";
constexpr wchar_t kRecreateSurfacesRequestMarker[] =
    L"electron-game-overlay-recreate-surfaces.request";

struct graphics_state
{
    HWND window = nullptr;
    HWND secondary_window = nullptr;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain> swap_chain;
    ComPtr<ID3D11RenderTargetView> render_target;
    ComPtr<IDXGISwapChain> secondary_swap_chain;
    ComPtr<ID3D11RenderTargetView> secondary_render_target;
    ComPtr<IDCompositionDevice> composition_device;
    ComPtr<IDCompositionTarget> composition_target, secondary_composition_target;
    ComPtr<IDCompositionVisual> composition_visual, secondary_composition_visual;
    std::uint64_t primary_present_count = 0;
    std::uint64_t secondary_present_count = 0;
};

struct host_options
{
    bool composition = false;
    bool multi_swapchain = false;
    bool release_primary = false;
    bool defer_secondary_present_until_primary_release = false;
    bool allow_surface_recreation = false;
    ULONGLONG release_primary_after_ms = 0;
};

graphics_state g_graphics;
bool g_composition = false;
input_oracle g_input_oracle;

// Controlled-host evidence only. The default path performs no extra DXGI
// queries, timing calls or logging around Present.
struct present_diagnostic_state
{
    std::uint64_t calls = 0;
    unsigned samples = 0;
    ULONGLONG next_sample_ms = 0;
    HRESULT previous_result = E_PENDING;
};
bool g_present_diagnostic_enabled = false;
present_diagnostic_state g_primary_present_diagnostic;
present_diagnostic_state g_secondary_present_diagnostic;
constexpr unsigned kPresentDiagnosticMaximumSamplesPerSurface = 64;
constexpr ULONGLONG kPresentDiagnosticIntervalMs = 1'000;
struct present_diagnostic_log
{
    HANDLE file = INVALID_HANDLE_VALUE;
    ~present_diagnostic_log()
    {
        if (file != INVALID_HANDLE_VALUE)
            CloseHandle(file);
    }
} g_present_diagnostic_log;

bool module_sibling_path(const wchar_t *name, std::wstring &path);

void publish_stdout_marker(const char *format, ...)
{
    char marker[1024] = {};
    va_list arguments;
    va_start(arguments, format);
    const int length = vsprintf_s(marker, format, arguments);
    va_end(arguments);
    if (length <= 0)
        return;

    std::size_t marker_length = static_cast<std::size_t>(length);
    if (marker_length + 1 < sizeof(marker))
    {
        marker[marker_length++] = '\n';
        marker[marker_length] = '\0';
    }

    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output != nullptr && output != INVALID_HANDLE_VALUE)
    {
        DWORD written = 0;
        static_cast<void>(WriteFile(
            output,
            marker,
            static_cast<DWORD>(marker_length),
            &written,
            nullptr));
    }
    OutputDebugStringA(marker);
    constexpr char present_prefix[] = "EGO_CONTROLLED_PRESENT_V1 ";
    if (g_present_diagnostic_log.file != INVALID_HANDLE_VALUE &&
        std::strncmp(marker, present_prefix, sizeof(present_prefix) - 1) == 0)
    {
        DWORD written = 0;
        if (WriteFile(
                g_present_diagnostic_log.file,
                marker,
                static_cast<DWORD>(marker_length),
                &written,
                nullptr) == FALSE || written != marker_length)
        {
            CloseHandle(g_present_diagnostic_log.file);
            g_present_diagnostic_log.file = INVALID_HANDLE_VALUE;
        }
    }
}

void configure_present_diagnostic()
{
    wchar_t enabled[2] = {};
    g_present_diagnostic_enabled =
        GetEnvironmentVariableW(
            L"ELECTRON_GAME_OVERLAY_CONTROLLED_PRESENT_DIAGNOSTIC",
            enabled,
            static_cast<DWORD>(sizeof(enabled) / sizeof(enabled[0]))) == 1 &&
        enabled[0] == L'1';
    if (!g_present_diagnostic_enabled)
        return;

    // The exact controlled-host image chooses this fixed sibling filename.
    // CREATE_NEW never replaces an earlier log or follows an existing link.
    std::wstring log_path;
    if (module_sibling_path(
            L"electron-game-overlay-present-v1.log", log_path))
    {
        g_present_diagnostic_log.file = CreateFileW(
            log_path.c_str(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            nullptr,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            nullptr);
    }
}

void observe_present_result(
    IDXGISwapChain *swap_chain,
    HRESULT result,
    const LARGE_INTEGER &qpc_before,
    const LARGE_INTEGER &qpc_after)
{
    auto &state = swap_chain == g_graphics.secondary_swap_chain.Get()
        ? g_secondary_present_diagnostic
        : g_primary_present_diagnostic;
    ++state.calls;
    if (state.samples >= kPresentDiagnosticMaximumSamplesPerSurface)
        return;
    const ULONGLONG now = GetTickCount64();
    if (state.samples != 0 && now < state.next_sample_ms &&
        state.previous_result == result)
        return;
    state.previous_result = result;
    state.next_sample_ms = now + kPresentDiagnosticIntervalMs;
    ++state.samples;

    DXGI_SWAP_CHAIN_DESC description = {};
    const HRESULT description_result = swap_chain->GetDesc(&description);
    UINT last_present_count = 0;
    const HRESULT count_result =
        swap_chain->GetLastPresentCount(&last_present_count);
    const HRESULT removal_reason =
        g_graphics.device->GetDeviceRemovedReason();
    FILETIME utc = {};
    GetSystemTimeAsFileTime(&utc);
    const std::uint64_t utc_100ns =
        (static_cast<std::uint64_t>(utc.dwHighDateTime) << 32) |
        utc.dwLowDateTime;
    LARGE_INTEGER frequency = {};
    const bool has_frequency = QueryPerformanceFrequency(&frequency) != FALSE;
    publish_stdout_marker(
        "EGO_CONTROLLED_PRESENT_V1 sample=%u/%u pid=%lu tid=%lu "
        "utc100ns=%llu tickMs=%llu surface=%s chain=0x%llx hwnd=0x%llx "
        "calls=%llu presentHr=0x%08lx occluded=%s failed=%s "
        "qpcBefore=%lld qpcAfter=%lld qpcFrequency=%lld "
        "descHr=0x%08lx windowed=%s swapEffect=%u "
        "lastPresentCountHr=0x%08lx lastPresentCount=%u "
        "deviceRemovedReason=0x%08lx foregroundHwnd=0x%llx "
        "scope=api-return-not-display-proof",
        state.samples,
        kPresentDiagnosticMaximumSamplesPerSurface,
        static_cast<unsigned long>(GetCurrentProcessId()),
        static_cast<unsigned long>(GetCurrentThreadId()),
        static_cast<unsigned long long>(utc_100ns),
        static_cast<unsigned long long>(now),
        &state == &g_secondary_present_diagnostic ? "secondary" : "primary",
        static_cast<unsigned long long>(
            reinterpret_cast<std::uintptr_t>(swap_chain)),
        static_cast<unsigned long long>(
            reinterpret_cast<std::uintptr_t>(description.OutputWindow)),
        static_cast<unsigned long long>(state.calls),
        static_cast<unsigned long>(result),
        result == DXGI_STATUS_OCCLUDED ? "true" : "false",
        FAILED(result) ? "true" : "false",
        static_cast<long long>(qpc_before.QuadPart),
        static_cast<long long>(qpc_after.QuadPart),
        has_frequency ? static_cast<long long>(frequency.QuadPart) : 0LL,
        static_cast<unsigned long>(description_result),
        SUCCEEDED(description_result) && description.Windowed ? "true" : "false",
        static_cast<unsigned>(description.SwapEffect),
        static_cast<unsigned long>(count_result),
        last_present_count,
        static_cast<unsigned long>(removal_reason),
        static_cast<unsigned long long>(
            reinterpret_cast<std::uintptr_t>(GetForegroundWindow())));
}

bool parse_positive_milliseconds(
    const wchar_t *text,
    ULONGLONG &milliseconds) noexcept
{
    if (text == nullptr || *text == L'\0' || *text == L'-')
        return false;

    wchar_t *end = nullptr;
    const unsigned long long parsed = std::wcstoull(text, &end, 10);
    if (end == text || *end != L'\0' || parsed == 0 ||
        parsed > static_cast<unsigned long long>(
                     std::numeric_limits<std::int64_t>::max()))
    {
        return false;
    }

    milliseconds = static_cast<ULONGLONG>(parsed);
    return true;
}

bool parse_host_options(host_options &options)
{
    int argument_count = 0;
    wchar_t **const arguments =
        CommandLineToArgvW(GetCommandLineW(), &argument_count);
    if (arguments == nullptr)
        return false;

    constexpr wchar_t release_prefix[] = L"--release-primary-after-ms=";
    constexpr std::size_t release_prefix_length =
        (sizeof(release_prefix) / sizeof(release_prefix[0])) - 1;

    bool valid = true;
    for (int index = 1; index < argument_count; ++index)
    {
        const wchar_t *const argument = arguments[index];
        if (std::wcscmp(argument, L"--multi-swapchain") == 0)
        {
            options.multi_swapchain = true;
        }
        else if (std::wcscmp(argument, L"--composition-swapchain") == 0)
        {
            options.composition = true;
        }
        else if (std::wcscmp(
                     argument,
                     L"--defer-secondary-present-until-primary-release") == 0)
        {
            options.defer_secondary_present_until_primary_release = true;
        }
        else if (std::wcscmp(argument, L"--allow-surface-recreation") == 0)
        {
            options.allow_surface_recreation = true;
        }
        else if (std::wcsncmp(
                     argument,
                     release_prefix,
                     release_prefix_length) == 0)
        {
            valid = parse_positive_milliseconds(
                argument + release_prefix_length,
                options.release_primary_after_ms);
            options.release_primary = valid;
        }
        else if (std::wcscmp(argument, L"--release-primary-after-ms") == 0)
        {
            valid = index + 1 < argument_count &&
                parse_positive_milliseconds(
                    arguments[++index],
                    options.release_primary_after_ms);
            options.release_primary = valid;
        }

        if (!valid)
            break;
    }

    LocalFree(arguments);
    return valid &&
        (!options.release_primary || options.multi_swapchain) &&
        (!options.defer_secondary_present_until_primary_release ||
         options.multi_swapchain);
}

bool activate_controlled_window(HWND window)
{
    if (window == nullptr || IsWindow(window) == FALSE)
        return false;

    const DWORD current_thread = GetCurrentThreadId();
    const HWND previous_foreground = GetForegroundWindow();
    const DWORD foreground_thread = previous_foreground != nullptr
        ? GetWindowThreadProcessId(previous_foreground, nullptr)
        : 0;
    const bool attached_foreground = foreground_thread != 0 &&
        foreground_thread != current_thread &&
        AttachThreadInput(current_thread, foreground_thread, TRUE) != FALSE;

    ShowWindow(window, SW_RESTORE);
    static_cast<void>(BringWindowToTop(window));
    static_cast<void>(SetForegroundWindow(window));
    static_cast<void>(SetActiveWindow(window));
    static_cast<void>(SetFocus(window));

    if (attached_foreground)
        static_cast<void>(AttachThreadInput(
            current_thread,
            foreground_thread,
            FALSE));
    return GetForegroundWindow() == window;
}

bool module_sibling_path(const wchar_t *name, std::wstring &path)
{
    path.assign(32'768, L'\0');
    const DWORD length = GetModuleFileNameW(
        nullptr,
        path.data(),
        static_cast<DWORD>(path.size()));
    if (length == 0 || length >= static_cast<DWORD>(path.size()))
        return false;

    path.resize(length);
    const std::size_t separator = path.find_last_of(L"\\/");
    if (separator == std::wstring::npos)
        return false;
    path.resize(separator + 1);
    path += name;
    return true;
}

bool write_preload_test_file(
    const wchar_t *name,
    const std::string &contents,
    DWORD creation_disposition)
{
    std::wstring path;
    if (!module_sibling_path(name, path))
        return false;
    const HANDLE file = CreateFileW(
        path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
        creation_disposition, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return false;
    DWORD written = 0;
    const bool succeeded = WriteFile(
        file, contents.data(), static_cast<DWORD>(contents.size()),
        &written, nullptr) != FALSE && written == contents.size() &&
        FlushFileBuffers(file) != FALSE;
    const DWORD error = succeeded ? ERROR_SUCCESS : GetLastError();
    CloseHandle(file);
    SetLastError(error);
    return succeeded;
}

bool report_preload_test_failure(const char *phase, DWORD error)
{
    char message[256] = {};
    std::snprintf(
        message, sizeof(message),
        "EGO_TEST_EXTERNAL_SELF_LOAD_V1 failed phase=%s win32Error=%lu\n",
        phase, static_cast<unsigned long>(error));
    std::fputs(message, stderr);
    OutputDebugStringA(message);
    write_preload_test_file(
        L"electron-game-overlay-preload-runtime.log", message, CREATE_ALWAYS);
    return false;
}

std::string preload_test_utf8(const std::wstring &value)
{
    if (value.empty())
        return {};
    const int length = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (length == 0)
        return {};
    std::string result(static_cast<std::size_t>(length), '\0');
    if (WideCharToMultiByte(
            CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), length,
            nullptr, nullptr) != length)
        return {};
    return result;
}

// This explicit test-only marker models an external ReShade installation. It
// is not an injector path and never writes a proxy or configuration into the
// demo directory. Its LoadLibrary reference intentionally lasts to exit.
bool load_test_external_runtime()
{
    std::wstring marker;
    if (!module_sibling_path(
            L"electron-game-overlay-demo-present.enabled", marker))
        return report_preload_test_failure("present-marker-path", ERROR_BAD_PATHNAME);
    g_test_present_ack_enabled =
        GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES;

    if (!module_sibling_path(
            L"electron-game-overlay-preload-runtime.path", marker))
        return report_preload_test_failure("runtime-marker-path", ERROR_BAD_PATHNAME);
    const HANDLE file = CreateFileW(
        marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE)
    {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
            ? true : report_preload_test_failure("open-marker", error);
    }
    BY_HANDLE_FILE_INFORMATION information = {};
    LARGE_INTEGER size = {};
    bool valid = GetFileInformationByHandle(file, &information) != FALSE &&
        (information.dwFileAttributes &
            (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
        GetFileSizeEx(file, &size) != FALSE &&
        size.QuadPart > 0 && size.QuadPart <= 131'072;
    std::string bytes;
    if (valid)
    {
        bytes.resize(static_cast<std::size_t>(size.QuadPart));
        DWORD read = 0;
        valid = ReadFile(
            file, bytes.data(), static_cast<DWORD>(bytes.size()), &read,
            nullptr) != FALSE && read == bytes.size();
    }
    CloseHandle(file);
    if (!valid)
        return report_preload_test_failure("read-marker", ERROR_INVALID_DATA);
    if (bytes.size() >= 3 &&
        static_cast<unsigned char>(bytes[0]) == 0xef &&
        static_cast<unsigned char>(bytes[1]) == 0xbb &&
        static_cast<unsigned char>(bytes[2]) == 0xbf)
        bytes.erase(0, 3);
    if (!bytes.empty() && bytes.back() == '\n')
    {
        bytes.pop_back();
        if (!bytes.empty() && bytes.back() == '\r')
            bytes.pop_back();
    }
    if (bytes.empty() || bytes.find_first_of("\r\n") != std::string::npos ||
        bytes.find('\0') != std::string::npos)
        return report_preload_test_failure("single-line-marker", ERROR_INVALID_DATA);
    const int length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
        static_cast<int>(bytes.size()), nullptr, 0);
    if (length <= 0 || length >= 32'768)
        return report_preload_test_failure("utf8-marker", ERROR_INVALID_DATA);
    std::wstring path(static_cast<std::size_t>(length), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
            static_cast<int>(bytes.size()), path.data(), length) != length)
        return report_preload_test_failure("decode-marker", ERROR_INVALID_DATA);
    const bool drive_path = path.size() > 3 &&
        ((path[0] >= L'A' && path[0] <= L'Z') ||
         (path[0] >= L'a' && path[0] <= L'z')) &&
        path[1] == L':' && path[2] == L'\\';
    const bool unc_path = path.size() > 4 && path[0] == L'\\' &&
        path[1] == L'\\' && path[2] != L'?' && path[2] != L'.';
    std::wstring full_path(32'768, L'\0');
    const DWORD full_length = GetFullPathNameW(
        path.c_str(), static_cast<DWORD>(full_path.size()),
        full_path.data(), nullptr);
    if ((!drive_path && !unc_path) || full_length == 0 ||
        full_length >= full_path.size())
        return report_preload_test_failure("absolute-runtime-path", ERROR_BAD_PATHNAME);
    full_path.resize(full_length);
    const std::size_t separator = full_path.find_last_of(L"\\/");
    if (_wcsicmp(full_path.c_str(), path.c_str()) != 0 ||
        separator == std::wstring::npos ||
        _wcsicmp(full_path.c_str() + separator + 1, L"ReShade64.dll") != 0)
        return report_preload_test_failure("canonical-runtime-path", ERROR_BAD_PATHNAME);
    const DWORD attributes = GetFileAttributesW(full_path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        return report_preload_test_failure("runtime-file", ERROR_INVALID_DATA);
    if (GetModuleHandleW(L"ReShade64.dll") != nullptr)
        return report_preload_test_failure("already-loaded-runtime", ERROR_ALREADY_EXISTS);
    const std::wstring base_path = full_path.substr(0, separator + 1);
    if (!SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE", base_path.c_str()))
        return report_preload_test_failure("target-base-path", GetLastError());
    g_test_external_runtime = LoadLibraryExW(
        full_path.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (g_test_external_runtime == nullptr)
        return report_preload_test_failure("load-runtime", GetLastError());
    g_test_present_ack_enabled = true;
    // Match the controlled host's pre-armed injection wait: the hook worker
    // must finish before this deliberately fast demo creates its device.
    Sleep(750);
    const std::string message =
        "EGO_TEST_EXTERNAL_SELF_LOAD_V1 loaded\nruntimePath=" +
        preload_test_utf8(full_path) + "\n";
    if (!write_preload_test_file(
            L"electron-game-overlay-preload-runtime.log", message, CREATE_ALWAYS))
        return report_preload_test_failure("runtime-log", GetLastError());
    return true;
}

bool observe_test_preload_present(HRESULT result)
{
    if (!g_test_present_ack_enabled || result != S_OK ||
        g_test_successful_presents >= 8)
        return true;
    if (++g_test_successful_presents != 8)
        return true;
    FILETIME creation = {}, exit = {}, kernel = {}, user = {};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user))
        return report_preload_test_failure("present-process-identity", GetLastError());
    ULARGE_INTEGER creation_value = {};
    creation_value.LowPart = creation.dwLowDateTime;
    creation_value.HighPart = creation.dwHighDateTime;
    std::wstring runtime_path(32'768, L'\0');
    const HMODULE runtime = GetModuleHandleW(L"ReShade64.dll");
    const DWORD length = runtime == nullptr ? 0 : GetModuleFileNameW(
        runtime, runtime_path.data(), static_cast<DWORD>(runtime_path.size()));
    if (length == 0 || length >= runtime_path.size())
        return report_preload_test_failure("present-runtime-path", ERROR_MOD_NOT_FOUND);
    runtime_path.resize(length);
    const std::string message =
        "EGO_CONTROLLED_PRESENT_V1\npid=" + std::to_string(GetCurrentProcessId()) +
        "\ncreationFileTime=" + std::to_string(creation_value.QuadPart) +
        "\nsuccessfulPresents=" + std::to_string(g_test_successful_presents) +
        "\nruntimePath=" + preload_test_utf8(runtime_path) + "\n";
    if (!write_preload_test_file(
            L"electron-game-overlay-demo-present.ready", message, CREATE_NEW))
        return report_preload_test_failure("present-ready-file", GetLastError());
    return true;
}

bool marker_present(const wchar_t *name)
{
    std::wstring path;
    if (!module_sibling_path(name, path))
        return false;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool consume_marker(const wchar_t *name)
{
    std::wstring path;
    if (!module_sibling_path(name, path))
        return false;
    if (DeleteFileW(path.c_str()) != FALSE)
        return true;
    return GetLastError() == ERROR_FILE_NOT_FOUND;
}

bool publish_final_surface_destroyed_ack()
{
    std::wstring path;
    if (!module_sibling_path(kFinalSurfaceDestroyedAckMarker, path))
        return false;

    const HANDLE file = CreateFileW(
        path.c_str(),
        GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (file == INVALID_HANDLE_VALUE)
        return false;

    constexpr char acknowledgement[] = "graphics-destroyed\n";
    constexpr DWORD acknowledgement_size =
        static_cast<DWORD>(sizeof(acknowledgement) - 1);
    DWORD written = 0;
    const bool succeeded =
        WriteFile(
            file,
            acknowledgement,
            acknowledgement_size,
            &written,
            nullptr) != FALSE &&
        written == acknowledgement_size &&
        FlushFileBuffers(file) != FALSE;
    CloseHandle(file);
    return succeeded;
}

bool enable_per_monitor_v2_awareness()
{
    SetLastError(ERROR_SUCCESS);
    const bool request_succeeded =
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE;
    const DWORD request_error = request_succeeded ? ERROR_SUCCESS : GetLastError();
    const DPI_AWARENESS_CONTEXT context = GetThreadDpiAwarenessContext();
    if (AreDpiAwarenessContextsEqual(
            context,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
        return true;

    if (!request_succeeded)
    {
        wchar_t message[256] = {};
        swprintf_s(
            message,
            L"Unable to establish Per-Monitor-V2 DPI awareness before creating the controlled "
            L"host window. SetProcessDpiAwarenessContext failed with Win32 error %lu.",
            request_error);
        OutputDebugStringW(message);
        MessageBoxW(nullptr, message, kWindowTitle, MB_OK | MB_ICONERROR);
        return false;
    }

    constexpr wchar_t message[] =
        L"Windows accepted the DPI-awareness request, but the controlled host thread is not "
        L"running as Per-Monitor-V2.";
    OutputDebugStringW(message);
    MessageBoxW(nullptr, message, kWindowTitle, MB_OK | MB_ICONERROR);
    return false;
}

bool wait_for_test_startup_barrier()
{
    std::wstring marker;
    if (!module_sibling_path(kStartupBarrierMarker, marker))
        return false;
    if (GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES)
        return true;

    const ULONGLONG deadline = GetTickCount64() + 60'000;
    while (GetTickCount64() < deadline)
    {
        if (GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES)
            return true;
        Sleep(10);
    }

    MessageBoxW(
        nullptr,
        L"The controlled host timed out at its test-only startup barrier.",
        kWindowTitle,
        MB_OK | MB_ICONERROR);
    return false;
}

bool wait_for_injected_runtime(
    ULONGLONG timeout_milliseconds,
    const wchar_t *timeout_message)
{
    const ULONGLONG deadline = GetTickCount64() + timeout_milliseconds;
    while (GetTickCount64() < deadline)
    {
        if (GetModuleHandleW(L"ReShade64.dll") != nullptr)
        {
            // This deliberately fast host must let ReShade finish installing
            // its D3D11 hooks after LoadLibrary publishes the module.
            Sleep(750);
            return true;
        }
        Sleep(10);
    }

    MessageBoxW(
        nullptr,
        timeout_message,
        kWindowTitle,
        MB_OK | MB_ICONERROR);
    return false;
}

bool wait_for_prearmed_injected_runtime()
{
    std::wstring marker;
    if (!module_sibling_path(kInjectedRuntimeWaitMarker, marker))
        return false;
    if (GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES)
        return true;

    return wait_for_injected_runtime(
        15'000,
        L"The controlled host timed out waiting for the pre-armed ReShade runtime.");
}

void report_graphics_failure(const wchar_t *message)
{
    if (g_test_present_ack_enabled)
        write_preload_test_file(
            L"electron-game-overlay-demo-failure.log",
            "EGO_CONTROLLED_GRAPHICS_FAILURE_V1\nmessage=" +
                preload_test_utf8(message) + "\n",
            CREATE_ALWAYS);
    OutputDebugStringW(message);
    MessageBoxW(g_graphics.window, message, kWindowTitle, MB_OK | MB_ICONERROR);
    PostQuitMessage(1);
}

DXGI_SWAP_CHAIN_DESC swap_chain_description(HWND window)
{
    DXGI_SWAP_CHAIN_DESC description = {};
    description.BufferCount = 2;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.OutputWindow = window;
    description.SampleDesc.Count = 1;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    return description;
}

bool create_render_target(
    IDXGISwapChain *swap_chain,
    ComPtr<ID3D11RenderTargetView> &render_target)
{
    if (swap_chain == nullptr)
        return false;

    ComPtr<ID3D11Texture2D> back_buffer;
    if (FAILED(swap_chain->GetBuffer(0, IID_PPV_ARGS(&back_buffer))))
        return false;

    return SUCCEEDED(g_graphics.device->CreateRenderTargetView(
        back_buffer.Get(),
        nullptr,
        &render_target));
}

HRESULT create_composition_swap_chain(HWND window, ComPtr<IDXGISwapChain> &chain,
    ComPtr<IDCompositionTarget> &target, ComPtr<IDCompositionVisual> &visual)
{
    ComPtr<IDXGIDevice> dxgi_device;
    HRESULT result = g_graphics.device.As(&dxgi_device);
    if (FAILED(result)) return result;
    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(result = dxgi_device->GetAdapter(&adapter))) return result;
    ComPtr<IDXGIFactory2> factory;
    if (FAILED(result = adapter->GetParent(IID_PPV_ARGS(&factory)))) return result;
    RECT client {};
    if (!GetClientRect(window, &client) || client.right <= client.left || client.bottom <= client.top) return E_INVALIDARG;
    DXGI_SWAP_CHAIN_DESC1 desc {};
    desc.Width = static_cast<UINT>(client.right - client.left); desc.Height = static_cast<UINT>(client.bottom - client.top);
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; desc.BufferCount = 2;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    ComPtr<IDXGISwapChain1> composition;
    if (FAILED(result = factory->CreateSwapChainForComposition(g_graphics.device.Get(), &desc, nullptr, &composition))) return result;
    DXGI_SWAP_CHAIN_DESC observed {}; HWND queried_window = nullptr;
    if (FAILED(composition->GetDesc(&observed)) || observed.OutputWindow != nullptr ||
        SUCCEEDED(composition->GetHwnd(&queried_window))) return E_UNEXPECTED;
    if (FAILED(result = composition.As(&chain))) return result;
    if (!g_graphics.composition_device && FAILED(result = DCompositionCreateDevice(dxgi_device.Get(), IID_PPV_ARGS(&g_graphics.composition_device)))) return result;
    if (FAILED(result = g_graphics.composition_device->CreateTargetForHwnd(window, TRUE, &target)) ||
        FAILED(result = g_graphics.composition_device->CreateVisual(&visual)) ||
        FAILED(result = visual->SetContent(chain.Get())) || FAILED(result = target->SetRoot(visual.Get())) ||
        FAILED(result = g_graphics.composition_device->Commit())) return result;
    write_preload_test_file(L"electron-game-overlay-composition-host.log",
        "EGO_CONTROLLED_COMPOSITION_HOST_V1\noutputWindowNull=true\ngetHwndUnsupported=true\nactualDCompositionTarget=true\n", CREATE_ALWAYS);
    return S_OK;
}

HRESULT create_device_with_driver(D3D_DRIVER_TYPE driver_type)
{
    DXGI_SWAP_CHAIN_DESC swap_chain_desc =
        swap_chain_description(g_graphics.window);

    D3D_FEATURE_LEVEL feature_level = {};
    if (g_composition)
    {
        const HRESULT result = D3D11CreateDevice(nullptr, driver_type, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
            &g_graphics.device, &feature_level, &g_graphics.context);
        if (FAILED(result)) return result;
        return create_composition_swap_chain(g_graphics.window, g_graphics.swap_chain,
            g_graphics.composition_target, g_graphics.composition_visual);
    }
    return D3D11CreateDeviceAndSwapChain(
        nullptr,
        driver_type,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &swap_chain_desc,
        &g_graphics.swap_chain,
        &g_graphics.device,
        &feature_level,
        &g_graphics.context);
}

bool create_graphics_device()
{
    HRESULT result = create_device_with_driver(D3D_DRIVER_TYPE_HARDWARE);
    const HRESULT hardware_result = result;
    bool warp_attempted = false;
    if (FAILED(result))
    {
        warp_attempted = true;
        g_graphics.composition_visual.Reset(); g_graphics.secondary_composition_visual.Reset();
        g_graphics.composition_target.Reset(); g_graphics.secondary_composition_target.Reset();
        g_graphics.composition_device.Reset();
        g_graphics.swap_chain.Reset();
        g_graphics.context.Reset();
        g_graphics.device.Reset();
        result = create_device_with_driver(D3D_DRIVER_TYPE_WARP);
    }

    const bool render_target_ready = SUCCEEDED(result) && create_render_target(
        g_graphics.swap_chain.Get(),
        g_graphics.render_target);
    if (g_test_present_ack_enabled)
    {
        char diagnostic[512] = {};
        sprintf_s(
            diagnostic,
            "EGO_CONTROLLED_GRAPHICS_RESULT_V1\nbackend=d3d11\n"
            "hardwareResult=0x%08lx\nwarpAttempted=%s\n"
            "finalDeviceResult=0x%08lx\nrenderTargetReady=%s\n",
            static_cast<unsigned long>(hardware_result),
            warp_attempted ? "true" : "false",
            static_cast<unsigned long>(result),
            render_target_ready ? "true" : "false");
        write_preload_test_file(
            L"electron-game-overlay-demo-graphics.log", diagnostic, CREATE_ALWAYS);
    }
    return render_target_ready;
}

bool create_secondary_swap_chain()
{
    if (g_graphics.device == nullptr ||
        g_graphics.secondary_window == nullptr)
    {
        return false;
    }
    if (g_composition)
        return SUCCEEDED(create_composition_swap_chain(g_graphics.secondary_window,
            g_graphics.secondary_swap_chain, g_graphics.secondary_composition_target,
            g_graphics.secondary_composition_visual)) &&
            create_render_target(g_graphics.secondary_swap_chain.Get(), g_graphics.secondary_render_target);

    ComPtr<IDXGIDevice> dxgi_device;
    if (FAILED(g_graphics.device.As(&dxgi_device)))
        return false;

    ComPtr<IDXGIAdapter> adapter;
    if (FAILED(dxgi_device->GetAdapter(&adapter)))
        return false;

    ComPtr<IDXGIFactory> factory;
    if (FAILED(adapter->GetParent(IID_PPV_ARGS(&factory))))
        return false;

    DXGI_SWAP_CHAIN_DESC description =
        swap_chain_description(g_graphics.secondary_window);
    if (FAILED(factory->CreateSwapChain(
            g_graphics.device.Get(),
            &description,
            &g_graphics.secondary_swap_chain)))
    {
        return false;
    }

    return create_render_target(
        g_graphics.secondary_swap_chain.Get(),
        g_graphics.secondary_render_target);
}

void destroy_primary_graphics()
{
    if (g_graphics.composition_visual)
    {
        g_graphics.composition_visual->SetContent(nullptr);
        g_graphics.composition_device->Commit();
        g_graphics.composition_device->WaitForCommitCompletion();
        g_graphics.composition_visual.Reset(); g_graphics.composition_target.Reset();
    }
    if (g_graphics.context != nullptr)
    {
        g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
        g_graphics.context->Flush();
    }
    g_graphics.render_target.Reset();
    g_graphics.swap_chain.Reset();
}

void destroy_graphics_device()
{
    if (g_graphics.composition_device)
    {
        if (g_graphics.composition_visual) g_graphics.composition_visual->SetContent(nullptr);
        if (g_graphics.secondary_composition_visual) g_graphics.secondary_composition_visual->SetContent(nullptr);
        g_graphics.composition_device->Commit();
        g_graphics.composition_device->WaitForCommitCompletion();
        g_graphics.composition_visual.Reset(); g_graphics.secondary_composition_visual.Reset();
        g_graphics.composition_target.Reset(); g_graphics.secondary_composition_target.Reset();
        g_graphics.composition_device.Reset();
    }
    if (g_graphics.context != nullptr)
    {
        g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
        g_graphics.context->Flush();
    }
    g_graphics.render_target.Reset();
    g_graphics.swap_chain.Reset();
    g_graphics.secondary_render_target.Reset();
    g_graphics.secondary_swap_chain.Reset();
    g_graphics.context.Reset();
    g_graphics.device.Reset();
}

void resize_swap_chain(
    ComPtr<IDXGISwapChain> &swap_chain,
    ComPtr<ID3D11RenderTargetView> &render_target,
    UINT width,
    UINT height)
{
    if (swap_chain == nullptr || width == 0 || height == 0)
        return;

    g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
    render_target.Reset();

    if (FAILED(swap_chain->ResizeBuffers(
            0,
            width,
            height,
            DXGI_FORMAT_UNKNOWN,
            0)))
    {
        // DXGI keeps the old buffers on failure. Reacquire their RTV so all
        // resources have a valid lifetime while the controlled host exits.
        create_render_target(swap_chain.Get(), render_target);
        report_graphics_failure(L"IDXGISwapChain::ResizeBuffers failed.");
        return;
    }

    if (!create_render_target(swap_chain.Get(), render_target))
        report_graphics_failure(L"Unable to recreate the D3D11 render target after a resize.");
}

HRESULT render_surface(
    IDXGISwapChain *swap_chain,
    ID3D11RenderTargetView *render_target,
    const float clear_color[4])
{
    if (swap_chain == nullptr || render_target == nullptr)
        return S_FALSE;

    g_graphics.context->OMSetRenderTargets(1, &render_target, nullptr);
    g_graphics.context->ClearRenderTargetView(render_target, clear_color);
    if (!g_present_diagnostic_enabled)
    {
        const HRESULT result = swap_chain->Present(1, 0);
        return observe_test_preload_present(result) ? result : E_FAIL;
    }

    LARGE_INTEGER qpc_before = {}, qpc_after = {};
    QueryPerformanceCounter(&qpc_before);
    const HRESULT result = swap_chain->Present(1, 0);
    QueryPerformanceCounter(&qpc_after);
    observe_present_result(swap_chain, result, qpc_before, qpc_after);
    return observe_test_preload_present(result) ? result : E_FAIL;
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w_param, LPARAM l_param)
{
    g_input_oracle.observe_window_message(window, message, w_param, l_param);

    switch (message)
    {
    case WM_DPICHANGED:
    {
        const auto *const suggested_rect = reinterpret_cast<const RECT *>(l_param);
        if (suggested_rect == nullptr ||
            !SetWindowPos(
                window,
                nullptr,
                suggested_rect->left,
                suggested_rect->top,
                suggested_rect->right - suggested_rect->left,
                suggested_rect->bottom - suggested_rect->top,
                SWP_NOACTIVATE | SWP_NOZORDER))
        {
            report_graphics_failure(L"Unable to apply the WM_DPICHANGED suggested window bounds.");
        }
        return 0;
    }

    case WM_SIZE:
        if (w_param != SIZE_MINIMIZED)
        {
            if (window == g_graphics.window)
            {
                resize_swap_chain(
                    g_graphics.swap_chain,
                    g_graphics.render_target,
                    LOWORD(l_param),
                    HIWORD(l_param));
            }
            else if (window == g_graphics.secondary_window)
            {
                resize_swap_chain(
                    g_graphics.secondary_swap_chain,
                    g_graphics.secondary_render_target,
                    LOWORD(l_param),
                    HIWORD(l_param));
            }
        }
        return 0;

    case WM_KEYDOWN:
        if (w_param == VK_ESCAPE)
        {
            DestroyWindow(window);
            return 0;
        }
        break;

    case WM_DESTROY:
        g_input_oracle.shutdown();
        PostQuitMessage(0);
        return 0;
    }

    return DefWindowProcW(window, message, w_param, l_param);
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show_command)
{
    host_options options;
    if (!parse_host_options(options))
    {
        constexpr wchar_t message[] =
            L"Invalid controlled-host options. --release-primary-after-ms requires "
            L"--multi-swapchain and a positive integer delay; "
            L"--defer-secondary-present-until-primary-release also requires "
            L"--multi-swapchain.";
        OutputDebugStringW(message);
        MessageBoxW(nullptr, message, kWindowTitle, MB_OK | MB_ICONERROR);
        return 1;
    }
    if (!enable_per_monitor_v2_awareness())
        return 1;
#ifdef EGO_TEST_COMPOSITION_DEFAULT
    options.composition = true;
#endif
    g_composition = options.composition;
    configure_present_diagnostic();
    if (!load_test_external_runtime())
        return 1;
    if (!wait_for_test_startup_barrier())
        return 1;
    if (!wait_for_prearmed_injected_runtime())
        return 1;

    WNDCLASSEXW window_class = {};
    window_class.cbSize = sizeof(window_class);
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.lpfnWndProc = window_proc;
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_class.lpszClassName = kWindowClassName;

    if (RegisterClassExW(&window_class) == 0)
        return 1;

    RECT window_rect = { 0, 0, 1280, 720 };
    const UINT initial_dpi = GetDpiForSystem();
    if (!AdjustWindowRectExForDpi(
            &window_rect,
            WS_OVERLAPPEDWINDOW,
            FALSE,
            0,
            initial_dpi))
    {
        report_graphics_failure(
            L"Unable to calculate the initial Per-Monitor-V2 host window bounds.");
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }

    g_graphics.window = CreateWindowExW(
        0,
        kWindowClassName,
        kWindowTitle,
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        window_rect.right - window_rect.left,
        window_rect.bottom - window_rect.top,
        nullptr,
        nullptr,
        instance,
        nullptr);

    if (g_graphics.window == nullptr)
        return 1;

    if (g_input_oracle.registration_before_injection_requested())
    {
        if (GetModuleHandleW(L"ReShade64.dll") != nullptr)
        {
            report_graphics_failure(
                L"ReShade was already loaded before the controlled raw-input registration.");
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }
        if (!g_input_oracle.initialize(g_graphics.window))
        {
            report_graphics_failure(
                L"Unable to register controlled raw input before injection.");
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }
        const bool null_target =
            g_input_oracle.raw_registration_uses_null_target();
        wchar_t raw_registration_ready_title[256] = {};
        swprintf_s(
            raw_registration_ready_title,
            L"%s | raw registration ready before injection | target=%s hwndTarget=%s",
            kWindowTitle,
            g_input_oracle.raw_registration_target_name(),
            null_target ? L"NULL" : L"window");
        SetWindowTextW(g_graphics.window, raw_registration_ready_title);
        publish_stdout_marker(
            "EGO_CONTROLLED_HOST_RAW_REGISTRATION_READY backend=d3d11 "
            "pid=%lu windowHwnd=0x%llx target=%s hwndTarget=0x%llx "
            "beforeInjection=true",
            static_cast<unsigned long>(GetCurrentProcessId()),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(g_graphics.window)),
            null_target ? "null-focus" : "explicit-hwnd",
            null_target
                ? 0ULL
                : static_cast<unsigned long long>(
                      reinterpret_cast<std::uintptr_t>(g_graphics.window)));
        ShowWindow(g_graphics.window, SW_SHOWNOACTIVATE);
        UpdateWindow(g_graphics.window);
        if (!wait_for_injected_runtime(
                120'000,
                L"The controlled host timed out waiting for ReShade after its raw-input registration."))
        {
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }
    }

    if (!create_graphics_device())
    {
        if (g_test_present_ack_enabled)
            write_preload_test_file(
                L"electron-game-overlay-demo-failure.log",
                "EGO_CONTROLLED_GRAPHICS_FAILURE_V1\nphase=initial-device-or-render-target\n",
                CREATE_ALWAYS);
        MessageBoxW(
            g_graphics.window,
            L"Unable to create a D3D11 device. See the debugger output for details.",
            kWindowTitle,
            MB_OK | MB_ICONERROR);
        return 1;
    }

    if (options.multi_swapchain)
    {
        RECT secondary_window_rect = { 0, 0, 960, 540 };
        if (!AdjustWindowRectExForDpi(
                &secondary_window_rect,
                WS_OVERLAPPEDWINDOW,
                FALSE,
                0,
                initial_dpi))
        {
            report_graphics_failure(
                L"Unable to calculate the secondary controlled-host window bounds.");
            destroy_graphics_device();
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }

        g_graphics.secondary_window = CreateWindowExW(
            0,
            kWindowClassName,
            kSecondaryWindowTitle,
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            secondary_window_rect.right - secondary_window_rect.left,
            secondary_window_rect.bottom - secondary_window_rect.top,
            nullptr,
            nullptr,
            instance,
            nullptr);
        if (g_graphics.secondary_window == nullptr ||
            !create_secondary_swap_chain())
        {
            report_graphics_failure(
                L"Unable to create the secondary D3D11 swap chain.");
            destroy_graphics_device();
            if (g_graphics.secondary_window != nullptr)
                DestroyWindow(g_graphics.secondary_window);
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }
    }

    ShowWindow(g_graphics.window, show_command);
    UpdateWindow(g_graphics.window);
    if (g_graphics.secondary_window != nullptr)
    {
        ShowWindow(g_graphics.secondary_window, SW_SHOWNOACTIVATE);
        UpdateWindow(g_graphics.secondary_window);
        const bool primary_foreground =
            activate_controlled_window(g_graphics.window);
        publish_stdout_marker(
            "EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_READY backend=d3d11 "
            "pid=%lu primaryHwnd=0x%llx secondaryHwnd=0x%llx "
            "releasePrimaryAfterMs=%llu foregroundHwnd=0x%llx "
            "primaryForeground=%s",
            static_cast<unsigned long>(GetCurrentProcessId()),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(g_graphics.window)),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(
                    g_graphics.secondary_window)),
            static_cast<unsigned long long>(
                options.release_primary_after_ms),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(GetForegroundWindow())),
            primary_foreground ? "true" : "false");
    }
    if (!g_input_oracle.initialize(g_graphics.window))
        report_graphics_failure(L"Unable to initialize the controlled raw/pointer-input oracle.");

    auto start_time = std::chrono::steady_clock::now();
    MSG message = {};
    bool final_surface_destroyed_for_test = false;
    bool final_surface_ack_published_for_test = false;
    bool primary_released_for_test = false;
    bool both_presenting_reported = false;
    bool remaining_present_reported = false;
    bool deferred_secondary_ready_reported = false;
    std::uint64_t secondary_presents_at_primary_release = 0;

    while (message.message != WM_QUIT)
    {
        if (options.allow_surface_recreation &&
            final_surface_destroyed_for_test &&
            marker_present(kRecreateSurfacesRequestMarker))
        {
            if (IsWindow(g_graphics.window) == FALSE ||
                (options.multi_swapchain &&
                 IsWindow(g_graphics.secondary_window) == FALSE))
            {
                report_graphics_failure(
                    L"The controlled host cannot recreate surfaces after a window was destroyed.");
                message.wParam = 1;
                break;
            }
            if (!consume_marker(kDestroyPrimarySurfaceRequestMarker) ||
                !consume_marker(kDestroyFinalSurfaceRequestMarker) ||
                !consume_marker(kRecreateSurfacesRequestMarker))
            {
                report_graphics_failure(
                    L"Unable to consume the controlled surface recreation request markers.");
                message.wParam = 1;
                break;
            }
            if (!create_graphics_device() ||
                (options.multi_swapchain && !create_secondary_swap_chain()))
            {
                destroy_graphics_device();
                report_graphics_failure(
                    L"Unable to recreate the controlled D3D11 graphics surfaces.");
                message.wParam = 1;
                break;
            }
            final_surface_destroyed_for_test = false;
            primary_released_for_test = false;
            both_presenting_reported = false;
            remaining_present_reported = false;
            deferred_secondary_ready_reported = false;
            g_graphics.primary_present_count = 0;
            g_graphics.secondary_present_count = 0;
            secondary_presents_at_primary_release = 0;
            start_time = std::chrono::steady_clock::now();
            static_cast<void>(activate_controlled_window(g_graphics.window));
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_SURFACES_RECREATED backend=d3d11 "
                "primaryHwnd=0x%llx secondaryHwnd=0x%llx "
                "sameWindows=true processAlive=true",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(g_graphics.window)),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(
                        g_graphics.secondary_window)));
            continue;
        }

        if (!final_surface_destroyed_for_test &&
            marker_present(kDestroyFinalSurfaceRequestMarker))
        {
            destroy_graphics_device();
            final_surface_destroyed_for_test = true;
            // Preserve the first acknowledgement as evidence across opt-in
            // recreation cycles; later releases have their own stdout marker.
            if (!final_surface_ack_published_for_test)
            {
                if (!publish_final_surface_destroyed_ack())
                {
                    report_graphics_failure(
                        L"Unable to publish the controlled final-surface destruction acknowledgement.");
                }
                else
                {
                    final_surface_ack_published_for_test = true;
                }
            }
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_FINAL_GRAPHICS_RELEASED backend=d3d11 "
                "primaryHwnd=0x%llx secondaryHwnd=0x%llx "
                "primaryHwndAlive=%s secondaryHwndAlive=%s processAlive=true",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(g_graphics.window)),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(
                        g_graphics.secondary_window)),
                IsWindow(g_graphics.window) != FALSE ? "true" : "false",
                IsWindow(g_graphics.secondary_window) != FALSE
                    ? "true"
                    : "false");
            continue;
        }

        if (g_input_oracle.peek_next_message(message))
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }

        if (g_graphics.render_target == nullptr &&
            g_graphics.secondary_render_target == nullptr)
        {
            g_input_oracle.sample_and_publish(g_graphics.window, kWindowTitle);
            Sleep(10);
            continue;
        }

        const float seconds = std::chrono::duration<float>(
            std::chrono::steady_clock::now() - start_time)
                                  .count();
        const float primary_clear_color[4] = {
            0.05f + 0.025f * (std::sin(seconds * 0.7f) + 1.0f),
            0.07f + 0.025f * (std::sin(seconds * 1.1f) + 1.0f),
            0.11f + 0.035f * (std::sin(seconds * 0.5f) + 1.0f),
            1.0f,
        };
        const float secondary_clear_color[4] = {
            0.11f + 0.035f * (std::sin(seconds * 0.4f) + 1.0f),
            0.05f + 0.025f * (std::sin(seconds * 0.9f) + 1.0f),
            0.07f + 0.025f * (std::sin(seconds * 1.3f) + 1.0f),
            1.0f,
        };

        if (g_graphics.swap_chain != nullptr)
        {
            if (FAILED(render_surface(
                    g_graphics.swap_chain.Get(),
                    g_graphics.render_target.Get(),
                    primary_clear_color)))
            {
                report_graphics_failure(
                    L"The controlled D3D11 primary swap chain failed to present.");
            }
            else
            {
                ++g_graphics.primary_present_count;
            }
        }
        if (g_graphics.secondary_swap_chain != nullptr &&
            (!options.defer_secondary_present_until_primary_release ||
             primary_released_for_test))
        {
            if (FAILED(render_surface(
                    g_graphics.secondary_swap_chain.Get(),
                    g_graphics.secondary_render_target.Get(),
                    secondary_clear_color)))
            {
                report_graphics_failure(
                    L"The controlled D3D11 secondary swap chain failed to present.");
            }
            else
            {
                ++g_graphics.secondary_present_count;
            }
        }

        if (options.defer_secondary_present_until_primary_release &&
            !deferred_secondary_ready_reported &&
            !primary_released_for_test &&
            g_graphics.primary_present_count >= 3 &&
            g_graphics.secondary_present_count == 0 &&
            g_graphics.secondary_swap_chain != nullptr)
        {
            deferred_secondary_ready_reported = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_DEFERRED_SECONDARY_READY backend=d3d11 "
                "primaryPresentCount=%llu secondaryPresentCount=0 "
                "secondarySwapchainAlive=true",
                static_cast<unsigned long long>(
                    g_graphics.primary_present_count));
        }

        if (options.multi_swapchain && !both_presenting_reported &&
            g_graphics.primary_present_count != 0 &&
            g_graphics.secondary_present_count != 0)
        {
            both_presenting_reported = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_PRESENTING backend=d3d11 "
                "primaryPresentCount=%llu secondaryPresentCount=%llu "
                "foregroundHwnd=0x%llx primaryForeground=%s",
                static_cast<unsigned long long>(
                    g_graphics.primary_present_count),
                static_cast<unsigned long long>(
                    g_graphics.secondary_present_count),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(GetForegroundWindow())),
                GetForegroundWindow() == g_graphics.window
                    ? "true"
                    : "false");
        }

        const auto elapsed_ms = std::chrono::duration_cast<
            std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start_time)
                                    .count();
        const bool primary_release_marker_present =
            options.multi_swapchain && !primary_released_for_test &&
            marker_present(kDestroyPrimarySurfaceRequestMarker);
        const bool primary_release_delay_elapsed =
            !primary_released_for_test && options.release_primary &&
            elapsed_ms >= static_cast<std::int64_t>(
                options.release_primary_after_ms);
        const bool deferred_primary_release_ready =
            options.defer_secondary_present_until_primary_release &&
            primary_release_marker_present &&
            g_graphics.primary_present_count != 0 &&
            g_graphics.secondary_swap_chain != nullptr;
        if (options.multi_swapchain && !primary_released_for_test &&
            !final_surface_destroyed_for_test &&
            ((both_presenting_reported &&
              (primary_release_marker_present ||
               primary_release_delay_elapsed)) ||
             deferred_primary_release_ready))
        {
            secondary_presents_at_primary_release =
                g_graphics.secondary_present_count;
            destroy_primary_graphics();
            const bool secondary_foreground =
                activate_controlled_window(g_graphics.secondary_window);
            primary_released_for_test = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_PRIMARY_GRAPHICS_RELEASED backend=d3d11 "
                "primaryHwnd=0x%llx secondaryHwnd=0x%llx "
                "primaryPresentCount=%llu secondaryPresentCount=%llu "
                "primaryHwndAlive=%s secondaryHwndAlive=%s "
                "sharedDeviceAlive=%s sharedContextAlive=%s processAlive=true "
                "foregroundHwnd=0x%llx secondaryForeground=%s trigger=%s",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(g_graphics.window)),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(
                        g_graphics.secondary_window)),
                static_cast<unsigned long long>(
                    g_graphics.primary_present_count),
                static_cast<unsigned long long>(
                    g_graphics.secondary_present_count),
                IsWindow(g_graphics.window) != FALSE ? "true" : "false",
                IsWindow(g_graphics.secondary_window) != FALSE
                    ? "true"
                    : "false",
                g_graphics.device != nullptr ? "true" : "false",
                g_graphics.context != nullptr ? "true" : "false",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(GetForegroundWindow())),
                secondary_foreground ? "true" : "false",
                primary_release_marker_present ? "request" : "delay");
        }

        if (primary_released_for_test && !remaining_present_reported &&
            g_graphics.secondary_present_count >=
                secondary_presents_at_primary_release + 3)
        {
            remaining_present_reported = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_REMAINING_PRESENT backend=d3d11 "
                "remaining=secondary hwnd=0x%llx presentCount=%llu "
                "presentsAfterPrimaryRelease=%llu primarySwapchainAlive=false "
                "secondarySwapchainAlive=true sharedDeviceAlive=true "
                "sharedContextAlive=true processAlive=true "
                "foregroundHwnd=0x%llx secondaryForeground=%s",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(
                        g_graphics.secondary_window)),
                static_cast<unsigned long long>(
                    g_graphics.secondary_present_count),
                static_cast<unsigned long long>(
                    g_graphics.secondary_present_count -
                    secondary_presents_at_primary_release),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(GetForegroundWindow())),
                GetForegroundWindow() == g_graphics.secondary_window
                    ? "true"
                    : "false");
        }
        g_input_oracle.sample_and_publish(g_graphics.window, kWindowTitle);
    }

    destroy_graphics_device();
    g_input_oracle.shutdown();

    if (g_graphics.secondary_window != nullptr &&
        IsWindow(g_graphics.secondary_window) != FALSE)
    {
        DestroyWindow(g_graphics.secondary_window);
    }
    if (g_graphics.window != nullptr && IsWindow(g_graphics.window) != FALSE)
        DestroyWindow(g_graphics.window);

    UnregisterClassW(kWindowClassName, instance);
    return static_cast<int>(message.wParam);
}
