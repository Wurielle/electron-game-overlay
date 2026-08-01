#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <Windows.h>

#if defined(EGO_CONTROLLED_D3D9) == defined(EGO_CONTROLLED_D3D10)
#error "Select exactly one controlled legacy Direct3D backend."
#endif

#if defined(EGO_CONTROLLED_D3D9)
#include <d3d9.h>
#elif defined(EGO_CONTROLLED_D3D10)
#include <d3d10.h>
#include <dxgi.h>
#endif

#include <wrl/client.h>

#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <string>

#include "input_oracle.hpp"

using Microsoft::WRL::ComPtr;

namespace
{
#if defined(EGO_CONTROLLED_D3D9)
constexpr wchar_t kBackendName[] = L"D3D9";
constexpr char kBackendMarker[] = "d3d9";
constexpr wchar_t kWindowClassName[] =
    L"ElectronGameOverlayD3D9TestHost";
constexpr wchar_t kWindowTitle[] =
    L"Controlled D3D9 overlay test host";
#else
constexpr wchar_t kBackendName[] = L"D3D10";
constexpr char kBackendMarker[] = "d3d10";
constexpr wchar_t kWindowClassName[] =
    L"ElectronGameOverlayD3D10TestHost";
constexpr wchar_t kWindowTitle[] =
    L"Controlled D3D10 overlay test host";
#endif

#ifdef _WIN64
constexpr wchar_t kInjectedRuntimeName[] = L"ReShade64.dll";
#else
constexpr wchar_t kInjectedRuntimeName[] = L"ReShade32.dll";
#endif

constexpr wchar_t kInjectedRuntimeWaitMarker[] =
    L"reshade-injection-wait.enabled";
constexpr wchar_t kStartupBarrierMarker[] =
    L"electron-game-overlay-startup-barrier.enabled";

struct graphics_state
{
    HWND window = nullptr;
#if defined(EGO_CONTROLLED_D3D9)
    ComPtr<IDirect3D9> direct3d;
    ComPtr<IDirect3DDevice9> device;
    D3DPRESENT_PARAMETERS present_parameters = {};
#else
    ComPtr<ID3D10Device> device;
    ComPtr<IDXGISwapChain> swap_chain;
    ComPtr<ID3D10RenderTargetView> render_target;
#endif
    UINT pending_width = 0;
    UINT pending_height = 0;
};

graphics_state g_graphics;
input_oracle g_input_oracle;

void publish_stdout_marker(const char *format, ...)
{
    char message[1024] = {};
    va_list arguments;
    va_start(arguments, format);
    vsprintf_s(message, format, arguments);
    va_end(arguments);

    std::fputs(message, stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
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

void report_failure(const wchar_t *message)
{
    wchar_t decorated[512] = {};
    swprintf_s(
        decorated,
        L"%s: %s",
        kBackendName,
        message);
    OutputDebugStringW(decorated);
    MessageBoxW(
        g_graphics.window,
        decorated,
        kWindowTitle,
        MB_OK | MB_ICONERROR);
}

bool enable_per_monitor_v2_awareness()
{
    SetLastError(ERROR_SUCCESS);
    const bool request_succeeded =
        SetProcessDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE;
    const DWORD request_error =
        request_succeeded ? ERROR_SUCCESS : GetLastError();
    if (AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
    {
        return true;
    }

    wchar_t message[256] = {};
    swprintf_s(
        message,
        L"Unable to establish Per-Monitor-V2 DPI awareness (Win32 error %lu).",
        request_error);
    report_failure(message);
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

    report_failure(L"The test-only startup barrier timed out.");
    return false;
}

bool wait_for_injected_runtime(
    ULONGLONG timeout_milliseconds,
    const wchar_t *timeout_message)
{
    const ULONGLONG deadline = GetTickCount64() + timeout_milliseconds;
    while (GetTickCount64() < deadline)
    {
        if (GetModuleHandleW(kInjectedRuntimeName) != nullptr)
        {
            // Let the injected runtime finish installing API hooks before this
            // intentionally fast host creates its device.
            Sleep(750);
            return true;
        }
        Sleep(10);
    }

    report_failure(timeout_message);
    return false;
}

bool wait_for_prearmed_injected_runtime()
{
    if (!marker_present(kInjectedRuntimeWaitMarker))
        return true;
    return wait_for_injected_runtime(
        15'000,
        L"The host timed out waiting for the pre-armed ReShade runtime.");
}

#if defined(EGO_CONTROLLED_D3D9)
bool initialize_graphics(HWND window)
{
    g_graphics.direct3d.Attach(Direct3DCreate9(D3D_SDK_VERSION));
    if (g_graphics.direct3d == nullptr)
        return false;

    D3DPRESENT_PARAMETERS &parameters = g_graphics.present_parameters;
    parameters.BackBufferWidth = 0;
    parameters.BackBufferHeight = 0;
    parameters.BackBufferFormat = D3DFMT_UNKNOWN;
    parameters.BackBufferCount = 1;
    parameters.MultiSampleType = D3DMULTISAMPLE_NONE;
    parameters.SwapEffect = D3DSWAPEFFECT_DISCARD;
    parameters.hDeviceWindow = window;
    parameters.Windowed = TRUE;
    parameters.EnableAutoDepthStencil = FALSE;
    parameters.PresentationInterval = D3DPRESENT_INTERVAL_ONE;

    HRESULT result = g_graphics.direct3d->CreateDevice(
        D3DADAPTER_DEFAULT,
        D3DDEVTYPE_HAL,
        window,
        D3DCREATE_HARDWARE_VERTEXPROCESSING,
        &parameters,
        &g_graphics.device);
    if (FAILED(result))
    {
        result = g_graphics.direct3d->CreateDevice(
            D3DADAPTER_DEFAULT,
            D3DDEVTYPE_HAL,
            window,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING,
            &parameters,
            &g_graphics.device);
    }
    return SUCCEEDED(result);
}

HRESULT resize_graphics(UINT width, UINT height)
{
    if (g_graphics.device == nullptr || width == 0 || height == 0)
        return S_OK;

    g_graphics.present_parameters.BackBufferWidth = width;
    g_graphics.present_parameters.BackBufferHeight = height;
    return g_graphics.device->Reset(&g_graphics.present_parameters);
}

HRESULT render_graphics(float seconds)
{
    if (g_graphics.device == nullptr)
        return E_POINTER;

    const HRESULT cooperative = g_graphics.device->TestCooperativeLevel();
    if (cooperative == D3DERR_DEVICELOST)
        return S_FALSE;
    if (cooperative == D3DERR_DEVICENOTRESET)
        return g_graphics.device->Reset(&g_graphics.present_parameters);
    if (FAILED(cooperative))
        return cooperative;

    const auto pulse = static_cast<std::uint8_t>(
        24.0f + 16.0f * (std::sin(seconds * 0.7f) + 1.0f));
    const D3DCOLOR clear_color = D3DCOLOR_ARGB(255, pulse, 20, 36);
    HRESULT result = g_graphics.device->Clear(
        0,
        nullptr,
        D3DCLEAR_TARGET,
        clear_color,
        1.0f,
        0);
    if (FAILED(result))
        return result;
    result = g_graphics.device->BeginScene();
    if (SUCCEEDED(result))
        result = g_graphics.device->EndScene();
    if (FAILED(result))
        return result;
    return g_graphics.device->Present(nullptr, nullptr, nullptr, nullptr);
}

void destroy_graphics()
{
    g_graphics.device.Reset();
    g_graphics.direct3d.Reset();
}
#else
bool create_render_target()
{
    ComPtr<ID3D10Texture2D> back_buffer;
    if (g_graphics.device == nullptr ||
        g_graphics.swap_chain == nullptr ||
        FAILED(g_graphics.swap_chain->GetBuffer(
            0,
            IID_PPV_ARGS(&back_buffer))))
    {
        return false;
    }
    return SUCCEEDED(g_graphics.device->CreateRenderTargetView(
        back_buffer.Get(),
        nullptr,
        &g_graphics.render_target));
}

bool initialize_graphics(HWND window)
{
    DXGI_SWAP_CHAIN_DESC description = {};
    description.BufferCount = 2;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.OutputWindow = window;
    description.SampleDesc.Count = 1;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    const HRESULT result = D3D10CreateDeviceAndSwapChain(
        nullptr,
        D3D10_DRIVER_TYPE_HARDWARE,
        nullptr,
        0,
        D3D10_SDK_VERSION,
        &description,
        &g_graphics.swap_chain,
        &g_graphics.device);
    return SUCCEEDED(result) && create_render_target();
}

HRESULT resize_graphics(UINT width, UINT height)
{
    if (g_graphics.swap_chain == nullptr || width == 0 || height == 0)
        return S_OK;

    g_graphics.device->OMSetRenderTargets(0, nullptr, nullptr);
    g_graphics.render_target.Reset();
    const HRESULT result = g_graphics.swap_chain->ResizeBuffers(
        0,
        width,
        height,
        DXGI_FORMAT_UNKNOWN,
        0);
    if (FAILED(result))
        return result;
    return create_render_target() ? S_OK : E_FAIL;
}

HRESULT render_graphics(float seconds)
{
    if (g_graphics.device == nullptr ||
        g_graphics.swap_chain == nullptr ||
        g_graphics.render_target == nullptr)
    {
        return E_POINTER;
    }

    const float clear_color[4] = {
        0.05f + 0.025f * (std::sin(seconds * 0.7f) + 1.0f),
        0.07f,
        0.11f,
        1.0f,
    };
    g_graphics.device->ClearRenderTargetView(
        g_graphics.render_target.Get(),
        clear_color);
    return g_graphics.swap_chain->Present(1, 0);
}

void destroy_graphics()
{
    if (g_graphics.device != nullptr)
        g_graphics.device->OMSetRenderTargets(0, nullptr, nullptr);
    g_graphics.render_target.Reset();
    if (g_graphics.device != nullptr)
        g_graphics.device->Flush();
    g_graphics.swap_chain.Reset();
    g_graphics.device.Reset();
}
#endif

LRESULT CALLBACK window_proc(
    HWND window,
    UINT message,
    WPARAM w_param,
    LPARAM l_param)
{
    g_input_oracle.observe_window_message(
        window,
        message,
        w_param,
        l_param);

    switch (message)
    {
    case WM_DPICHANGED:
    {
        const auto *const suggested =
            reinterpret_cast<const RECT *>(l_param);
        if (suggested != nullptr)
        {
            SetWindowPos(
                window,
                nullptr,
                suggested->left,
                suggested->top,
                suggested->right - suggested->left,
                suggested->bottom - suggested->top,
                SWP_NOACTIVATE | SWP_NOZORDER);
        }
        return 0;
    }

    case WM_SIZE:
        if (w_param != SIZE_MINIMIZED)
        {
            g_graphics.pending_width = LOWORD(l_param);
            g_graphics.pending_height = HIWORD(l_param);
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
    if (!enable_per_monitor_v2_awareness() ||
        !wait_for_test_startup_barrier() ||
        !wait_for_prearmed_injected_runtime())
    {
        return 1;
    }

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
    if (!AdjustWindowRectExForDpi(
            &window_rect,
            WS_OVERLAPPEDWINDOW,
            FALSE,
            0,
            GetDpiForSystem()))
    {
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
    {
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }

    if (g_input_oracle.registration_before_injection_requested())
    {
        if (GetModuleHandleW(kInjectedRuntimeName) != nullptr ||
            !g_input_oracle.initialize(g_graphics.window))
        {
            report_failure(
                L"Raw input could not be registered before injection.");
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }

        const bool null_target =
            g_input_oracle.raw_registration_uses_null_target();
        wchar_t ready_title[256] = {};
        swprintf_s(
            ready_title,
            L"%s | raw registration ready before injection | target=%s hwndTarget=%s",
            kWindowTitle,
            g_input_oracle.raw_registration_target_name(),
            null_target ? L"NULL" : L"window");
        SetWindowTextW(g_graphics.window, ready_title);
        publish_stdout_marker(
            "EGO_CONTROLLED_HOST_RAW_REGISTRATION_READY backend=%s "
            "pid=%lu windowHwnd=0x%llx target=%s hwndTarget=0x%llx "
            "beforeInjection=true",
            kBackendMarker,
            static_cast<unsigned long>(GetCurrentProcessId()),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(g_graphics.window)),
            null_target ? "null-focus" : "explicit-hwnd",
            null_target
                ? 0ULL
                : static_cast<unsigned long long>(
                      reinterpret_cast<std::uintptr_t>(
                          g_graphics.window)));
        ShowWindow(g_graphics.window, SW_SHOWNOACTIVATE);
        UpdateWindow(g_graphics.window);
        if (!wait_for_injected_runtime(
                120'000,
                L"The host timed out waiting for ReShade after raw-input registration."))
        {
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }
    }

    if (!initialize_graphics(g_graphics.window))
    {
        report_failure(L"The controlled graphics device could not be created.");
        destroy_graphics();
        DestroyWindow(g_graphics.window);
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }
    // CreateWindow publishes an initial WM_SIZE before the graphics device
    // exists. The freshly created swap chain already has those dimensions, so
    // do not force an immediate D3D9 Reset (or redundant DXGI ResizeBuffers).
    g_graphics.pending_width = 0;
    g_graphics.pending_height = 0;

    ShowWindow(g_graphics.window, show_command);
    UpdateWindow(g_graphics.window);
    if (!g_input_oracle.initialize(g_graphics.window))
    {
        report_failure(L"The controlled input oracle could not be initialized.");
        destroy_graphics();
        DestroyWindow(g_graphics.window);
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }

    const auto start_time = std::chrono::steady_clock::now();
    bool runtime_failed = false;
    MSG message = {};
    while (message.message != WM_QUIT)
    {
        if (g_input_oracle.peek_next_message(message))
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }

        if (g_graphics.pending_width != 0 &&
            g_graphics.pending_height != 0)
        {
            const HRESULT resize_result = resize_graphics(
                g_graphics.pending_width,
                g_graphics.pending_height);
#if defined(EGO_CONTROLLED_D3D9)
            if (resize_result != D3DERR_DEVICELOST)
#endif
            {
                g_graphics.pending_width = 0;
                g_graphics.pending_height = 0;
            }
            if (FAILED(resize_result) &&
#if defined(EGO_CONTROLLED_D3D9)
                resize_result != D3DERR_DEVICELOST
#else
                true
#endif
            )
            {
                report_failure(L"The controlled swap chain could not resize.");
                runtime_failed = true;
                break;
            }
        }

        const float seconds = std::chrono::duration<float>(
            std::chrono::steady_clock::now() - start_time).count();
        const HRESULT render_result = render_graphics(seconds);
#if defined(EGO_CONTROLLED_D3D9)
        if (render_result == S_FALSE || render_result == D3DERR_DEVICELOST)
            Sleep(10);
#endif
        if (FAILED(render_result))
        {
#if defined(EGO_CONTROLLED_D3D9)
            if (render_result != D3DERR_DEVICELOST)
#endif
            {
                report_failure(L"The controlled frame could not be presented.");
                runtime_failed = true;
                break;
            }
        }

        g_input_oracle.sample_and_publish(
            g_graphics.window,
            kWindowTitle);
    }

    destroy_graphics();
    g_input_oracle.shutdown();
    if (g_graphics.window != nullptr &&
        IsWindow(g_graphics.window) != FALSE)
    {
        DestroyWindow(g_graphics.window);
    }
    UnregisterClassW(kWindowClassName, instance);
    return runtime_failed ? 1 : static_cast<int>(message.wParam);
}
