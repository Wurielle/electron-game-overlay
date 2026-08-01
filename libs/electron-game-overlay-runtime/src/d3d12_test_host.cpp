#include <Windows.h>
#include <shellapi.h>

#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <array>
#include <cstdarg>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <limits>
#include <string>

#include "input_oracle.hpp"

namespace
{
using Microsoft::WRL::ComPtr;

#pragma comment(lib, "Shell32.lib")

constexpr wchar_t kWindowClassName[] = L"ElectronGameOverlayD3D12TestHost";
constexpr wchar_t kWindowTitle[] = L"Controlled D3D12 overlay test host";
constexpr wchar_t kSecondaryWindowTitle[] =
    L"Controlled D3D12 overlay test host B";
constexpr wchar_t kInjectedRuntimeWaitMarker[] = L"reshade-injection-wait.enabled";
constexpr wchar_t kStartupBarrierMarker[] =
    L"electron-game-overlay-startup-barrier.enabled";
constexpr wchar_t kDestroyFinalSurfaceRequestMarker[] =
    L"electron-game-overlay-destroy-final-surface.request";
constexpr wchar_t kDestroyPrimarySurfaceRequestMarker[] =
    L"electron-game-overlay-destroy-primary-surface.request";
constexpr wchar_t kFinalSurfaceDestroyedAckMarker[] =
    L"electron-game-overlay-final-surface-destroyed.ack";
constexpr UINT kFrameCount = 2;
constexpr DXGI_FORMAT kSwapChainFormat = DXGI_FORMAT_B8G8R8A8_UNORM;

struct frame_context
{
    ComPtr<ID3D12CommandAllocator> command_allocator;
    ComPtr<ID3D12Resource> render_target;
    D3D12_CPU_DESCRIPTOR_HANDLE render_target_view = {};
    std::uint64_t fence_value = 0;
};

struct secondary_surface_state
{
    HWND window = nullptr;
    ComPtr<IDXGISwapChain3> swap_chain;
    ComPtr<ID3D12DescriptorHeap> render_target_heap;
    std::array<frame_context, kFrameCount> frames;
    UINT render_target_descriptor_size = 0;
    std::uint64_t present_count = 0;
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
    std::uint64_t primary_present_count = 0;
    secondary_surface_state secondary;
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

bool wait_for_prearmed_injected_runtime()
{
    std::wstring marker;
    if (!module_sibling_path(kInjectedRuntimeWaitMarker, marker))
        return false;
    if (GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES)
        return true;

    const ULONGLONG deadline = GetTickCount64() + 15'000;
    while (GetTickCount64() < deadline)
    {
        if (GetModuleHandleW(L"ReShade64.dll") != nullptr)
        {
            // LoadLibrary has published the module, but ReShade still needs a
            // short bounded window to finish installing its graphics hooks
            // before this deliberately fast controlled host creates D3D12.
            Sleep(750);
            return true;
        }
        Sleep(10);
    }

    MessageBoxW(
        nullptr,
        L"The controlled host timed out waiting for the pre-armed ReShade runtime.",
        kWindowTitle,
        MB_OK | MB_ICONERROR);
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

HRESULT create_secondary_render_targets()
{
    D3D12_CPU_DESCRIPTOR_HANDLE descriptor =
        g_graphics.secondary.render_target_heap
            ->GetCPUDescriptorHandleForHeapStart();

    for (UINT index = 0; index < kFrameCount; ++index)
    {
        frame_context &frame = g_graphics.secondary.frames[index];
        const HRESULT result = g_graphics.secondary.swap_chain->GetBuffer(
            index,
            IID_PPV_ARGS(&frame.render_target));
        if (FAILED(result))
            return result;

        frame.render_target_view = descriptor;
        g_graphics.device->CreateRenderTargetView(
            frame.render_target.Get(),
            nullptr,
            descriptor);
        descriptor.ptr +=
            g_graphics.secondary.render_target_descriptor_size;
    }

    return S_OK;
}

HRESULT create_secondary_swap_chain(UINT width, UINT height)
{
    if (g_graphics.secondary.window == nullptr ||
        g_graphics.factory == nullptr || g_graphics.device == nullptr ||
        g_graphics.command_queue == nullptr)
    {
        return E_POINTER;
    }

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
    HRESULT result = g_graphics.factory->CreateSwapChainForHwnd(
        g_graphics.command_queue.Get(),
        g_graphics.secondary.window,
        &swap_chain_description,
        nullptr,
        nullptr,
        &swap_chain);
    if (FAILED(result))
        return result;

    result = g_graphics.factory->MakeWindowAssociation(
        g_graphics.secondary.window,
        DXGI_MWA_NO_ALT_ENTER);
    if (FAILED(result))
        return result;

    result = swap_chain.As(&g_graphics.secondary.swap_chain);
    if (FAILED(result))
        return result;

    D3D12_DESCRIPTOR_HEAP_DESC heap_description = {};
    heap_description.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    heap_description.NumDescriptors = kFrameCount;
    heap_description.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_NONE;
    heap_description.NodeMask = 0;
    result = g_graphics.device->CreateDescriptorHeap(
        &heap_description,
        IID_PPV_ARGS(&g_graphics.secondary.render_target_heap));
    if (FAILED(result))
        return result;

    g_graphics.secondary.render_target_descriptor_size =
        g_graphics.device->GetDescriptorHandleIncrementSize(
            D3D12_DESCRIPTOR_HEAP_TYPE_RTV);

    for (frame_context &frame : g_graphics.secondary.frames)
    {
        result = g_graphics.device->CreateCommandAllocator(
            D3D12_COMMAND_LIST_TYPE_DIRECT,
            IID_PPV_ARGS(&frame.command_allocator));
        if (FAILED(result))
            return result;
    }

    return create_secondary_render_targets();
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

HRESULT resize_secondary_swap_chain(UINT width, UINT height)
{
    if (g_graphics.secondary.swap_chain == nullptr ||
        width == 0 || height == 0)
    {
        return S_OK;
    }

    HRESULT result = signal_and_wait_for_gpu();
    if (FAILED(result))
        return result;

    for (frame_context &frame : g_graphics.secondary.frames)
    {
        frame.render_target.Reset();
        frame.render_target_view = {};
        frame.fence_value = 0;
    }

    result = g_graphics.secondary.swap_chain->ResizeBuffers(
        kFrameCount,
        width,
        height,
        kSwapChainFormat,
        0);
    if (FAILED(result))
        return result;

    return create_secondary_render_targets();
}

HRESULT render_surface(
    IDXGISwapChain3 *swap_chain,
    std::array<frame_context, kFrameCount> &frames,
    const float clear_color[4])
{
    if (swap_chain == nullptr)
        return S_FALSE;

    const UINT frame_index = swap_chain->GetCurrentBackBufferIndex();
    frame_context &frame = frames[frame_index];

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

    result = swap_chain->Present(1, 0);
    if (FAILED(result))
        return result;

    const std::uint64_t fence_value = g_graphics.next_fence_value++;
    result = g_graphics.command_queue->Signal(g_graphics.fence.Get(), fence_value);
    if (FAILED(result))
        return result;

    frame.fence_value = fence_value;
    return S_OK;
}

HRESULT render_frame(float seconds)
{
    const float clear_color[4] = {
        0.05f + 0.025f * (std::sin(seconds * 0.7f) + 1.0f),
        0.07f + 0.025f * (std::sin(seconds * 1.1f) + 1.0f),
        0.11f + 0.035f * (std::sin(seconds * 0.5f) + 1.0f),
        1.0f,
    };
    return render_surface(
        g_graphics.swap_chain.Get(),
        g_graphics.frames,
        clear_color);
}

HRESULT render_secondary_frame(float seconds)
{
    const float clear_color[4] = {
        0.11f + 0.035f * (std::sin(seconds * 0.4f) + 1.0f),
        0.05f + 0.025f * (std::sin(seconds * 0.9f) + 1.0f),
        0.07f + 0.025f * (std::sin(seconds * 1.3f) + 1.0f),
        1.0f,
    };
    return render_surface(
        g_graphics.secondary.swap_chain.Get(),
        g_graphics.secondary.frames,
        clear_color);
}

HRESULT destroy_primary_graphics()
{
    if (g_graphics.command_queue != nullptr && g_graphics.fence != nullptr)
    {
        const HRESULT result = signal_and_wait_for_gpu();
        if (FAILED(result))
            return result;
    }

    for (frame_context &frame : g_graphics.frames)
    {
        frame.render_target.Reset();
        frame.command_allocator.Reset();
        frame.render_target_view = {};
        frame.fence_value = 0;
    }
    g_graphics.render_target_heap.Reset();
    g_graphics.swap_chain.Reset();
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
    for (frame_context &frame : g_graphics.secondary.frames)
    {
        frame.render_target.Reset();
        frame.command_allocator.Reset();
        frame.render_target_view = {};
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
    g_graphics.secondary.render_target_heap.Reset();
    g_graphics.secondary.swap_chain.Reset();
    g_graphics.command_queue.Reset();
    g_graphics.fence.Reset();
    g_graphics.device.Reset();
    g_graphics.factory.Reset();
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
        {
            HRESULT result = S_OK;
            if (window == g_graphics.window &&
                g_graphics.swap_chain != nullptr)
            {
                result = resize_swap_chain(
                    LOWORD(l_param),
                    HIWORD(l_param));
            }
            else if (window == g_graphics.secondary.window &&
                     g_graphics.secondary.swap_chain != nullptr)
            {
                result = resize_secondary_swap_chain(
                    LOWORD(l_param),
                    HIWORD(l_param));
            }
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

        g_graphics.secondary.window = CreateWindowExW(
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
        RECT secondary_client_rect = {};
        if (g_graphics.secondary.window == nullptr ||
            !GetClientRect(
                g_graphics.secondary.window,
                &secondary_client_rect))
        {
            report_graphics_failure(
                L"Unable to create or query the secondary controlled-host window.");
            destroy_graphics_device();
            if (g_graphics.secondary.window != nullptr)
                DestroyWindow(g_graphics.secondary.window);
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }

        const HRESULT secondary_result = create_secondary_swap_chain(
            static_cast<UINT>(
                secondary_client_rect.right - secondary_client_rect.left),
            static_cast<UINT>(
                secondary_client_rect.bottom - secondary_client_rect.top));
        if (FAILED(secondary_result))
        {
            report_graphics_failure(
                L"Unable to create the secondary D3D12 swap chain.");
            destroy_graphics_device();
            DestroyWindow(g_graphics.secondary.window);
            DestroyWindow(g_graphics.window);
            UnregisterClassW(kWindowClassName, instance);
            return 1;
        }
    }

    ShowWindow(g_graphics.window, show_command);
    UpdateWindow(g_graphics.window);
    if (g_graphics.secondary.window != nullptr)
    {
        ShowWindow(g_graphics.secondary.window, SW_SHOWNOACTIVATE);
        UpdateWindow(g_graphics.secondary.window);
        const bool primary_foreground =
            activate_controlled_window(g_graphics.window);
        publish_stdout_marker(
            "EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_READY backend=d3d12 "
            "pid=%lu primaryHwnd=0x%llx secondaryHwnd=0x%llx "
            "releasePrimaryAfterMs=%llu foregroundHwnd=0x%llx "
            "primaryForeground=%s",
            static_cast<unsigned long>(GetCurrentProcessId()),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(g_graphics.window)),
            static_cast<unsigned long long>(
                reinterpret_cast<std::uintptr_t>(
                    g_graphics.secondary.window)),
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
    bool render_failed = false;
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
                render_failed = true;
            }
            continue;
        }

        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }

        if (g_graphics.swap_chain == nullptr &&
            g_graphics.secondary.swap_chain == nullptr)
        {
            g_input_oracle.sample_and_publish(g_graphics.window, kWindowTitle);
            Sleep(10);
            continue;
        }

        const bool primary_renderable =
            g_graphics.swap_chain != nullptr &&
            IsIconic(g_graphics.window) == FALSE;
        const bool secondary_renderable =
            g_graphics.secondary.swap_chain != nullptr &&
            IsIconic(g_graphics.secondary.window) == FALSE;
        if (!primary_renderable && !secondary_renderable)
        {
            g_input_oracle.sample_and_publish(g_graphics.window, kWindowTitle);
            Sleep(10);
            continue;
        }

        const float seconds = std::chrono::duration<float>(
            std::chrono::steady_clock::now() - start_time)
                                  .count();
        if (primary_renderable)
        {
            if (FAILED(render_frame(seconds)))
            {
                report_graphics_failure(
                    L"The controlled D3D12 primary swap chain failed to render a frame.");
                render_failed = true;
            }
            else
            {
                ++g_graphics.primary_present_count;
            }
        }
        if (secondary_renderable)
        {
            if (FAILED(render_secondary_frame(seconds)))
            {
                report_graphics_failure(
                    L"The controlled D3D12 secondary swap chain failed to render a frame.");
                render_failed = true;
            }
            else
            {
                ++g_graphics.secondary.present_count;
            }
        }

        if (options.multi_swapchain && !both_presenting_reported &&
            g_graphics.primary_present_count != 0 &&
            g_graphics.secondary.present_count != 0)
        {
            both_presenting_reported = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_MULTI_SWAPCHAIN_PRESENTING backend=d3d12 "
                "primaryPresentCount=%llu secondaryPresentCount=%llu "
                "foregroundHwnd=0x%llx primaryForeground=%s",
                static_cast<unsigned long long>(
                    g_graphics.primary_present_count),
                static_cast<unsigned long long>(
                    g_graphics.secondary.present_count),
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
                g_graphics.secondary.present_count;
            const HRESULT release_result = destroy_primary_graphics();
            if (FAILED(release_result))
            {
                report_graphics_failure(
                    L"Unable to idle the shared D3D12 queue before releasing "
                    L"the primary swap chain.");
                render_failed = true;
                continue;
            }
            const bool secondary_foreground =
                activate_controlled_window(g_graphics.secondary.window);
            primary_released_for_test = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_PRIMARY_GRAPHICS_RELEASED backend=d3d12 "
                "primaryHwnd=0x%llx secondaryHwnd=0x%llx "
                "primaryPresentCount=%llu secondaryPresentCount=%llu "
                "primaryHwndAlive=%s secondaryHwndAlive=%s "
                "sharedDeviceAlive=%s sharedQueueAlive=%s processAlive=true "
                "foregroundHwnd=0x%llx secondaryForeground=%s trigger=%s",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(g_graphics.window)),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(
                        g_graphics.secondary.window)),
                static_cast<unsigned long long>(
                    g_graphics.primary_present_count),
                static_cast<unsigned long long>(
                    g_graphics.secondary.present_count),
                IsWindow(g_graphics.window) != FALSE ? "true" : "false",
                IsWindow(g_graphics.secondary.window) != FALSE
                    ? "true"
                    : "false",
                g_graphics.device != nullptr ? "true" : "false",
                g_graphics.command_queue != nullptr ? "true" : "false",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(GetForegroundWindow())),
                secondary_foreground ? "true" : "false",
                primary_release_marker_present ? "request" : "delay");
        }

        if (primary_released_for_test && !remaining_present_reported &&
            g_graphics.secondary.present_count >=
                secondary_presents_at_primary_release + 3)
        {
            remaining_present_reported = true;
            publish_stdout_marker(
                "EGO_CONTROLLED_HOST_REMAINING_PRESENT backend=d3d12 "
                "remaining=secondary hwnd=0x%llx presentCount=%llu "
                "presentsAfterPrimaryRelease=%llu primarySwapchainAlive=false "
                "secondarySwapchainAlive=true sharedDeviceAlive=true "
                "sharedQueueAlive=true processAlive=true "
                "foregroundHwnd=0x%llx secondaryForeground=%s",
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(
                        g_graphics.secondary.window)),
                static_cast<unsigned long long>(
                    g_graphics.secondary.present_count),
                static_cast<unsigned long long>(
                    g_graphics.secondary.present_count -
                    secondary_presents_at_primary_release),
                static_cast<unsigned long long>(
                    reinterpret_cast<std::uintptr_t>(GetForegroundWindow())),
                GetForegroundWindow() == g_graphics.secondary.window
                    ? "true"
                    : "false");
        }
        g_input_oracle.sample_and_publish(g_graphics.window, kWindowTitle);
    }

    destroy_graphics_device();
    g_input_oracle.shutdown();
    if (g_graphics.secondary.window != nullptr &&
        IsWindow(g_graphics.secondary.window) != FALSE)
    {
        DestroyWindow(g_graphics.secondary.window);
    }
    if (g_graphics.window != nullptr && IsWindow(g_graphics.window) != FALSE)
        DestroyWindow(g_graphics.window);
    UnregisterClassW(kWindowClassName, instance);
    return render_failed ? 1 : static_cast<int>(message.wParam);
}
