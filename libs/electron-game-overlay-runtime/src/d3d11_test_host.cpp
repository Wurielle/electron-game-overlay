#include <Windows.h>
#include <shellapi.h>

#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
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

constexpr wchar_t kWindowClassName[] = L"ElectronGameOverlayD3D11TestHost";
constexpr wchar_t kWindowTitle[] = L"Controlled D3D11 overlay test host";
constexpr wchar_t kSecondaryWindowTitle[] =
    L"Controlled D3D11 overlay test host B";
constexpr wchar_t kInjectedRuntimeWaitMarker[] = L"reshade-injection-wait.enabled";
constexpr wchar_t kStartupBarrierMarker[] =
    L"electron-game-overlay-startup-barrier.enabled";
constexpr wchar_t kDestroyFinalSurfaceRequestMarker[] =
    L"electron-game-overlay-destroy-final-surface.request";
constexpr wchar_t kDestroyPrimarySurfaceRequestMarker[] =
    L"electron-game-overlay-destroy-primary-surface.request";
constexpr wchar_t kFinalSurfaceDestroyedAckMarker[] =
    L"electron-game-overlay-final-surface-destroyed.ack";

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
    std::uint64_t primary_present_count = 0;
    std::uint64_t secondary_present_count = 0;
};

struct host_options
{
    bool multi_swapchain = false;
    bool release_primary = false;
    ULONGLONG release_primary_after_ms = 0;
};

graphics_state g_graphics;
input_oracle g_input_oracle;

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
    return valid && (!options.release_primary || options.multi_swapchain);
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

bool marker_present(const wchar_t *name)
{
    std::wstring path;
    if (!module_sibling_path(name, path))
        return false;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
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

HRESULT create_device_with_driver(D3D_DRIVER_TYPE driver_type)
{
    DXGI_SWAP_CHAIN_DESC swap_chain_desc =
        swap_chain_description(g_graphics.window);

    D3D_FEATURE_LEVEL feature_level = {};
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
    if (FAILED(result))
    {
        g_graphics.swap_chain.Reset();
        g_graphics.context.Reset();
        g_graphics.device.Reset();
        result = create_device_with_driver(D3D_DRIVER_TYPE_WARP);
    }

    return SUCCEEDED(result) && create_render_target(
        g_graphics.swap_chain.Get(),
        g_graphics.render_target);
}

bool create_secondary_swap_chain()
{
    if (g_graphics.device == nullptr ||
        g_graphics.secondary_window == nullptr)
    {
        return false;
    }

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
    return swap_chain->Present(1, 0);
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
            L"--multi-swapchain and a positive integer delay.";
        OutputDebugStringW(message);
        MessageBoxW(nullptr, message, kWindowTitle, MB_OK | MB_ICONERROR);
        return 1;
    }
    if (!enable_per_monitor_v2_awareness())
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

    const auto start_time = std::chrono::steady_clock::now();
    MSG message = {};
    bool final_surface_destroyed_for_test = false;
    bool primary_released_for_test = false;
    bool both_presenting_reported = false;
    bool remaining_present_reported = false;
    std::uint64_t secondary_presents_at_primary_release = 0;

    while (message.message != WM_QUIT)
    {
        if (!final_surface_destroyed_for_test &&
            marker_present(kDestroyFinalSurfaceRequestMarker))
        {
            destroy_graphics_device();
            final_surface_destroyed_for_test = true;
            if (!publish_final_surface_destroyed_ack())
            {
                report_graphics_failure(
                    L"Unable to publish the controlled final-surface destruction acknowledgement.");
            }
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
        if (g_graphics.secondary_swap_chain != nullptr)
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
        if (options.multi_swapchain && !primary_released_for_test &&
            !final_surface_destroyed_for_test && both_presenting_reported &&
            (primary_release_marker_present ||
             primary_release_delay_elapsed))
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
