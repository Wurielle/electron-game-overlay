#include <Windows.h>

#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <chrono>
#include <cmath>
#include <cwchar>

#include "input_oracle.hpp"

namespace
{
using Microsoft::WRL::ComPtr;

constexpr wchar_t kWindowClassName[] = L"AlternativeImguiOverlayPocHost";
constexpr wchar_t kWindowTitle[] = L"Controlled D3D11 overlay test host";

struct graphics_state
{
    HWND window = nullptr;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain> swap_chain;
    ComPtr<ID3D11RenderTargetView> render_target;
};

graphics_state g_graphics;
input_oracle g_input_oracle;

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

void report_graphics_failure(const wchar_t *message)
{
    OutputDebugStringW(message);
    MessageBoxW(g_graphics.window, message, kWindowTitle, MB_OK | MB_ICONERROR);
    PostQuitMessage(1);
}

bool create_render_target()
{
    ComPtr<ID3D11Texture2D> back_buffer;
    if (FAILED(g_graphics.swap_chain->GetBuffer(0, IID_PPV_ARGS(&back_buffer))))
        return false;

    return SUCCEEDED(g_graphics.device->CreateRenderTargetView(
        back_buffer.Get(),
        nullptr,
        &g_graphics.render_target));
}

HRESULT create_device_with_driver(D3D_DRIVER_TYPE driver_type)
{
    DXGI_SWAP_CHAIN_DESC swap_chain_desc = {};
    swap_chain_desc.BufferCount = 2;
    swap_chain_desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    swap_chain_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swap_chain_desc.OutputWindow = g_graphics.window;
    swap_chain_desc.SampleDesc.Count = 1;
    swap_chain_desc.Windowed = TRUE;
    swap_chain_desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

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

    return SUCCEEDED(result) && create_render_target();
}

void resize_swap_chain(UINT width, UINT height)
{
    if (g_graphics.swap_chain == nullptr || width == 0 || height == 0)
        return;

    g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
    g_graphics.render_target.Reset();

    if (FAILED(g_graphics.swap_chain->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0)))
    {
        // DXGI keeps the old buffers on failure. Reacquire their RTV so all
        // resources have a valid lifetime while the controlled host exits.
        create_render_target();
        report_graphics_failure(L"IDXGISwapChain::ResizeBuffers failed.");
        return;
    }

    if (!create_render_target())
        report_graphics_failure(L"Unable to recreate the D3D11 render target after a resize.");
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w_param, LPARAM l_param)
{
    g_input_oracle.observe_window_message(window, message, w_param);

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
            resize_swap_chain(LOWORD(l_param), HIWORD(l_param));
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
    if (!enable_per_monitor_v2_awareness())
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

    if (!create_graphics_device())
    {
        MessageBoxW(
            g_graphics.window,
            L"Unable to create a D3D11 device. See the debugger output for details.",
            kWindowTitle,
            MB_OK | MB_ICONERROR);
        return 1;
    }

    ShowWindow(g_graphics.window, show_command);
    UpdateWindow(g_graphics.window);
    if (!g_input_oracle.initialize(g_graphics.window))
        report_graphics_failure(L"Unable to register the controlled raw-input oracle.");

    const auto start_time = std::chrono::steady_clock::now();
    MSG message = {};

    while (message.message != WM_QUIT)
    {
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }

        if (g_graphics.render_target == nullptr)
        {
            Sleep(10);
            continue;
        }

        const float seconds = std::chrono::duration<float>(
            std::chrono::steady_clock::now() - start_time)
                                  .count();
        const float clear_color[4] = {
            0.05f + 0.025f * (std::sin(seconds * 0.7f) + 1.0f),
            0.07f + 0.025f * (std::sin(seconds * 1.1f) + 1.0f),
            0.11f + 0.035f * (std::sin(seconds * 0.5f) + 1.0f),
            1.0f,
        };

        ID3D11RenderTargetView *const render_target = g_graphics.render_target.Get();
        g_graphics.context->OMSetRenderTargets(1, &render_target, nullptr);
        g_graphics.context->ClearRenderTargetView(render_target, clear_color);
        g_graphics.swap_chain->Present(1, 0);
        g_input_oracle.sample_and_publish(g_graphics.window, kWindowTitle);
    }

    g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
    g_graphics.render_target.Reset();
    g_graphics.swap_chain.Reset();
    g_graphics.context.Reset();
    g_graphics.device.Reset();
    g_input_oracle.shutdown();

    UnregisterClassW(kWindowClassName, instance);
    return static_cast<int>(message.wParam);
}
