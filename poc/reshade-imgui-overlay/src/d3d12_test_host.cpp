#include <Windows.h>

#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cwchar>

namespace
{
using Microsoft::WRL::ComPtr;

constexpr wchar_t kWindowClassName[] = L"AlternativeImguiOverlayPocD3D12Host";
constexpr wchar_t kWindowTitle[] = L"Controlled D3D12 overlay test host";
constexpr UINT kFrameCount = 2;
constexpr DXGI_FORMAT kSwapChainFormat = DXGI_FORMAT_B8G8R8A8_UNORM;

struct frame_context
{
    ComPtr<ID3D12CommandAllocator> command_allocator;
    ComPtr<ID3D12Resource> render_target;
    D3D12_CPU_DESCRIPTOR_HANDLE render_target_view = {};
    std::uint64_t fence_value = 0;
};

struct graphics_state
{
    HWND window = nullptr;
    ComPtr<IDXGIFactory4> factory;
    ComPtr<ID3D12Device> device;
    ComPtr<ID3D12CommandQueue> command_queue;
    ComPtr<IDXGISwapChain3> swap_chain;
    ComPtr<ID3D12DescriptorHeap> render_target_heap;
    ComPtr<ID3D12GraphicsCommandList> command_list;
    ComPtr<ID3D12Fence> fence;
    HANDLE fence_event = nullptr;
    std::array<frame_context, kFrameCount> frames;
    std::uint64_t next_fence_value = 1;
    UINT render_target_descriptor_size = 0;
};

graphics_state g_graphics;

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

D3D12_RESOURCE_BARRIER transition_barrier(
    ID3D12Resource *resource,
    D3D12_RESOURCE_STATES before,
    D3D12_RESOURCE_STATES after)
{
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Flags = D3D12_RESOURCE_BARRIER_FLAG_NONE;
    barrier.Transition.pResource = resource;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = before;
    barrier.Transition.StateAfter = after;
    return barrier;
}

HRESULT create_device()
{
    for (UINT adapter_index = 0;; ++adapter_index)
    {
        ComPtr<IDXGIAdapter1> adapter;
        const HRESULT enumerate_result =
            g_graphics.factory->EnumAdapters1(adapter_index, &adapter);
        if (enumerate_result == DXGI_ERROR_NOT_FOUND)
            break;
        if (FAILED(enumerate_result))
            return enumerate_result;

        DXGI_ADAPTER_DESC1 description = {};
        if (FAILED(adapter->GetDesc1(&description)) ||
            (description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0)
            continue;

        const HRESULT device_result = D3D12CreateDevice(
            adapter.Get(),
            D3D_FEATURE_LEVEL_11_0,
            IID_PPV_ARGS(&g_graphics.device));
        if (SUCCEEDED(device_result))
            return device_result;

        g_graphics.device.Reset();
    }

    ComPtr<IDXGIAdapter> warp_adapter;
    HRESULT result = g_graphics.factory->EnumWarpAdapter(IID_PPV_ARGS(&warp_adapter));
    if (FAILED(result))
        return result;

    result = D3D12CreateDevice(
        warp_adapter.Get(),
        D3D_FEATURE_LEVEL_11_0,
        IID_PPV_ARGS(&g_graphics.device));
    return result;
}

HRESULT create_render_targets()
{
    D3D12_CPU_DESCRIPTOR_HANDLE descriptor =
        g_graphics.render_target_heap->GetCPUDescriptorHandleForHeapStart();

    for (UINT index = 0; index < kFrameCount; ++index)
    {
        frame_context &frame = g_graphics.frames[index];
        const HRESULT result =
            g_graphics.swap_chain->GetBuffer(index, IID_PPV_ARGS(&frame.render_target));
        if (FAILED(result))
            return result;

        frame.render_target_view = descriptor;
        g_graphics.device->CreateRenderTargetView(
            frame.render_target.Get(),
            nullptr,
            descriptor);
        descriptor.ptr += g_graphics.render_target_descriptor_size;
    }

    return S_OK;
}

HRESULT create_graphics_device(UINT width, UINT height)
{
    HRESULT result = CreateDXGIFactory2(0, IID_PPV_ARGS(&g_graphics.factory));
    if (FAILED(result))
        return result;

    result = create_device();
    if (FAILED(result))
        return result;

    D3D12_COMMAND_QUEUE_DESC queue_description = {};
    queue_description.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    queue_description.Priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
    queue_description.Flags = D3D12_COMMAND_QUEUE_FLAG_NONE;
    queue_description.NodeMask = 0;
    result = g_graphics.device->CreateCommandQueue(
        &queue_description,
        IID_PPV_ARGS(&g_graphics.command_queue));
    if (FAILED(result))
        return result;

    DXGI_SWAP_CHAIN_DESC1 swap_chain_description = {};
    swap_chain_description.Width = width;
    swap_chain_description.Height = height;
    swap_chain_description.Format = kSwapChainFormat;
    swap_chain_description.Stereo = FALSE;
    swap_chain_description.SampleDesc.Count = 1;
    swap_chain_description.SampleDesc.Quality = 0;
    swap_chain_description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swap_chain_description.BufferCount = kFrameCount;
    swap_chain_description.Scaling = DXGI_SCALING_STRETCH;
    swap_chain_description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    swap_chain_description.AlphaMode = DXGI_ALPHA_MODE_UNSPECIFIED;
    swap_chain_description.Flags = 0;

    ComPtr<IDXGISwapChain1> swap_chain;
    result = g_graphics.factory->CreateSwapChainForHwnd(
        g_graphics.command_queue.Get(),
        g_graphics.window,
        &swap_chain_description,
        nullptr,
        nullptr,
        &swap_chain);
    if (FAILED(result))
        return result;

    result = g_graphics.factory->MakeWindowAssociation(
        g_graphics.window,
        DXGI_MWA_NO_ALT_ENTER);
    if (FAILED(result))
        return result;

    result = swap_chain.As(&g_graphics.swap_chain);
    if (FAILED(result))
        return result;

    D3D12_DESCRIPTOR_HEAP_DESC heap_description = {};
    heap_description.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    heap_description.NumDescriptors = kFrameCount;
    heap_description.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_NONE;
    heap_description.NodeMask = 0;
    result = g_graphics.device->CreateDescriptorHeap(
        &heap_description,
        IID_PPV_ARGS(&g_graphics.render_target_heap));
    if (FAILED(result))
        return result;

    g_graphics.render_target_descriptor_size =
        g_graphics.device->GetDescriptorHandleIncrementSize(
            D3D12_DESCRIPTOR_HEAP_TYPE_RTV);

    for (frame_context &frame : g_graphics.frames)
    {
        result = g_graphics.device->CreateCommandAllocator(
            D3D12_COMMAND_LIST_TYPE_DIRECT,
            IID_PPV_ARGS(&frame.command_allocator));
        if (FAILED(result))
            return result;
    }

    result = g_graphics.device->CreateCommandList(
        0,
        D3D12_COMMAND_LIST_TYPE_DIRECT,
        g_graphics.frames[0].command_allocator.Get(),
        nullptr,
        IID_PPV_ARGS(&g_graphics.command_list));
    if (FAILED(result))
        return result;

    result = g_graphics.command_list->Close();
    if (FAILED(result))
        return result;

    result = g_graphics.device->CreateFence(
        0,
        D3D12_FENCE_FLAG_NONE,
        IID_PPV_ARGS(&g_graphics.fence));
    if (FAILED(result))
        return result;

    g_graphics.fence_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (g_graphics.fence_event == nullptr)
        return HRESULT_FROM_WIN32(GetLastError());

    return create_render_targets();
}

HRESULT wait_for_fence(std::uint64_t fence_value)
{
    if (fence_value == 0 || g_graphics.fence->GetCompletedValue() >= fence_value)
        return S_OK;

    HRESULT result =
        g_graphics.fence->SetEventOnCompletion(fence_value, g_graphics.fence_event);
    if (FAILED(result))
        return result;

    const DWORD wait_result = WaitForSingleObject(g_graphics.fence_event, INFINITE);
    if (wait_result == WAIT_OBJECT_0)
        return S_OK;
    if (wait_result == WAIT_FAILED)
        return HRESULT_FROM_WIN32(GetLastError());
    return E_FAIL;
}

HRESULT signal_and_wait_for_gpu()
{
    const std::uint64_t fence_value = g_graphics.next_fence_value++;
    HRESULT result = g_graphics.command_queue->Signal(g_graphics.fence.Get(), fence_value);
    if (FAILED(result))
        return result;
    return wait_for_fence(fence_value);
}

HRESULT resize_swap_chain(UINT width, UINT height)
{
    if (g_graphics.swap_chain == nullptr || width == 0 || height == 0)
        return S_OK;

    HRESULT result = signal_and_wait_for_gpu();
    if (FAILED(result))
        return result;

    for (frame_context &frame : g_graphics.frames)
    {
        frame.render_target.Reset();
        frame.render_target_view = {};
        frame.fence_value = 0;
    }

    result = g_graphics.swap_chain->ResizeBuffers(
        kFrameCount,
        width,
        height,
        kSwapChainFormat,
        0);
    if (FAILED(result))
        return result;

    return create_render_targets();
}

HRESULT render_frame(float seconds)
{
    const UINT frame_index = g_graphics.swap_chain->GetCurrentBackBufferIndex();
    frame_context &frame = g_graphics.frames[frame_index];

    HRESULT result = wait_for_fence(frame.fence_value);
    if (FAILED(result))
        return result;

    result = frame.command_allocator->Reset();
    if (FAILED(result))
        return result;

    result = g_graphics.command_list->Reset(frame.command_allocator.Get(), nullptr);
    if (FAILED(result))
        return result;

    const D3D12_RESOURCE_BARRIER to_render_target = transition_barrier(
        frame.render_target.Get(),
        D3D12_RESOURCE_STATE_PRESENT,
        D3D12_RESOURCE_STATE_RENDER_TARGET);
    g_graphics.command_list->ResourceBarrier(1, &to_render_target);

    const float clear_color[4] = {
        0.05f + 0.025f * (std::sin(seconds * 0.7f) + 1.0f),
        0.07f + 0.025f * (std::sin(seconds * 1.1f) + 1.0f),
        0.11f + 0.035f * (std::sin(seconds * 0.5f) + 1.0f),
        1.0f,
    };
    g_graphics.command_list->OMSetRenderTargets(
        1,
        &frame.render_target_view,
        FALSE,
        nullptr);
    g_graphics.command_list->ClearRenderTargetView(
        frame.render_target_view,
        clear_color,
        0,
        nullptr);

    const D3D12_RESOURCE_BARRIER to_present = transition_barrier(
        frame.render_target.Get(),
        D3D12_RESOURCE_STATE_RENDER_TARGET,
        D3D12_RESOURCE_STATE_PRESENT);
    g_graphics.command_list->ResourceBarrier(1, &to_present);

    result = g_graphics.command_list->Close();
    if (FAILED(result))
        return result;

    ID3D12CommandList *command_lists[] = { g_graphics.command_list.Get() };
    g_graphics.command_queue->ExecuteCommandLists(1, command_lists);

    result = g_graphics.swap_chain->Present(1, 0);
    if (FAILED(result))
        return result;

    const std::uint64_t fence_value = g_graphics.next_fence_value++;
    result = g_graphics.command_queue->Signal(g_graphics.fence.Get(), fence_value);
    if (FAILED(result))
        return result;

    frame.fence_value = fence_value;
    return S_OK;
}

void destroy_graphics_device()
{
    if (g_graphics.command_queue != nullptr && g_graphics.fence != nullptr)
        signal_and_wait_for_gpu();

    for (frame_context &frame : g_graphics.frames)
    {
        frame.render_target.Reset();
        frame.command_allocator.Reset();
        frame.fence_value = 0;
    }

    if (g_graphics.fence_event != nullptr)
    {
        CloseHandle(g_graphics.fence_event);
        g_graphics.fence_event = nullptr;
    }

    g_graphics.command_list.Reset();
    g_graphics.render_target_heap.Reset();
    g_graphics.swap_chain.Reset();
    g_graphics.command_queue.Reset();
    g_graphics.fence.Reset();
    g_graphics.device.Reset();
    g_graphics.factory.Reset();
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w_param, LPARAM l_param)
{
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
        if (w_param != SIZE_MINIMIZED && g_graphics.swap_chain != nullptr)
        {
            const HRESULT result = resize_swap_chain(LOWORD(l_param), HIWORD(l_param));
            if (FAILED(result))
                report_graphics_failure(L"Unable to resize the D3D12 swap chain.");
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
    {
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }

    RECT client_rect = {};
    if (!GetClientRect(g_graphics.window, &client_rect))
    {
        report_graphics_failure(L"Unable to query the controlled host client bounds.");
        DestroyWindow(g_graphics.window);
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }

    const HRESULT graphics_result = create_graphics_device(
        static_cast<UINT>(client_rect.right - client_rect.left),
        static_cast<UINT>(client_rect.bottom - client_rect.top));
    if (FAILED(graphics_result))
    {
        report_graphics_failure(
            L"Unable to create the controlled D3D12 device and swap chain.");
        destroy_graphics_device();
        DestroyWindow(g_graphics.window);
        UnregisterClassW(kWindowClassName, instance);
        return 1;
    }

    ShowWindow(g_graphics.window, show_command);
    UpdateWindow(g_graphics.window);

    const auto start_time = std::chrono::steady_clock::now();
    MSG message = {};
    bool render_failed = false;

    while (message.message != WM_QUIT)
    {
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }

        if (IsIconic(g_graphics.window))
        {
            Sleep(10);
            continue;
        }

        const float seconds = std::chrono::duration<float>(
            std::chrono::steady_clock::now() - start_time)
                                  .count();
        if (FAILED(render_frame(seconds)))
        {
            report_graphics_failure(L"The controlled D3D12 host failed to render a frame.");
            render_failed = true;
        }
    }

    destroy_graphics_device();
    UnregisterClassW(kWindowClassName, instance);
    return render_failed ? 1 : static_cast<int>(message.wParam);
}
