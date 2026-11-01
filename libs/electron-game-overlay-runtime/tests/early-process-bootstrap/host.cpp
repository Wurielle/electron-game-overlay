// Owned controlled host. Its CRT initializer calls the statically imported
// graphics DLL after DLL loader initialization and before wmain. No ReShade is
// loaded here and the bootstrap ordering is independently checked by the runner.
#include "original-graphics.h"
#include "trace.hpp"

#include <dxgi1_6.h>
#include <wrl/client.h>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

using Microsoft::WRL::ComPtr;

namespace
{
    bool g_pre_main_initializer_returned = false;
    bool g_pre_main_initializer_okay = false;

    struct pre_main_graphics_initializer
    {
        pre_main_graphics_initializer() noexcept
        {
            const bool entry_recorded = early_proof::trace(GetModuleHandleW(nullptr),
                "host-crt-initializer-entry");
            const BOOL initialized = EarlyOriginalGraphicsInitializeV1();
            const HRESULT result = entry_recorded && initialized ? S_OK : E_FAIL;
            const bool return_recorded = early_proof::trace(GetModuleHandleW(nullptr),
                "host-crt-initializer-return", result);
            g_pre_main_initializer_returned = true;
            g_pre_main_initializer_okay = entry_recorded && initialized && return_recorded;
        }
    } g_pre_main_graphics_initializer;

    struct failure : std::runtime_error
    {
        HRESULT result;
        failure(const char *step, HRESULT hr) : std::runtime_error(step), result(hr) {}
    };

    void check(HRESULT result, const char *step)
    {
        if (FAILED(result)) throw failure(step, result);
    }

    std::string hex_result(HRESULT value)
    {
        std::ostringstream stream;
        stream << "0x" << std::uppercase << std::hex << std::setw(8)
            << std::setfill('0') << static_cast<std::uint32_t>(value);
        return stream.str();
    }

    std::string json_string(const std::string &value)
    {
        std::ostringstream stream;
        stream << '"';
        for (unsigned char c : value)
        {
            if (c == '"' || c == '\\') stream << '\\' << static_cast<char>(c);
            else if (c < 0x20) stream << "\\u" << std::hex << std::setw(4)
                << std::setfill('0') << static_cast<unsigned>(c) << std::dec;
            else stream << static_cast<char>(c);
        }
        stream << '"';
        return stream.str();
    }

    std::string utf8(const wchar_t *value)
    {
        const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value,
            -1, nullptr, 0, nullptr, nullptr);
        if (size <= 0) throw failure("WideCharToMultiByte(size)", HRESULT_FROM_WIN32(GetLastError()));
        std::string result(static_cast<std::size_t>(size), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
            result.data(), size, nullptr, nullptr) != size)
            throw failure("WideCharToMultiByte(value)", HRESULT_FROM_WIN32(GetLastError()));
        result.pop_back();
        return result;
    }

    struct event_handle
    {
        HANDLE value = nullptr;
        ~event_handle() { if (value != nullptr) CloseHandle(value); }
    };

    LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
    {
        if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
        if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
        return DefWindowProcW(window, message, wparam, lparam);
    }

    struct graphics_host
    {
        HWND window = nullptr;
        ComPtr<ID3D12Device> device;
        ComPtr<ID3D12CommandQueue> queue;
        ComPtr<IDXGIFactory4> factory;
        ComPtr<IDXGIAdapter1> adapter;
        ComPtr<IDXGISwapChain3> chain;
        ComPtr<ID3D12DescriptorHeap> rtv_heap;
        std::array<ComPtr<ID3D12Resource>, 2> buffers;
        ComPtr<ID3D12CommandAllocator> allocator;
        ComPtr<ID3D12GraphicsCommandList> list;
        ComPtr<ID3D12Fence> fence;
        event_handle fence_event;
        UINT rtv_stride = 0;
        UINT64 fence_value = 0;
        DXGI_ADAPTER_DESC1 adapter_description = {};
        bool queue_device_matches = false;

        ~graphics_host()
        {
            for (auto &buffer : buffers) buffer.Reset();
            chain.Reset();
            if (window != nullptr && IsWindow(window)) DestroyWindow(window);
        }

        void initialize(EarlyOriginalGraphicsV1 &original)
        {
            // Attach consumes exactly the references transferred by the DLL.
            device.Attach(original.device);
            queue.Attach(original.queue);
            original.device = nullptr;
            original.queue = nullptr;
            if (device == nullptr || queue == nullptr)
                throw failure("Initializer did not transfer device and queue", E_POINTER);
            if (queue->GetDesc().Type != D3D12_COMMAND_LIST_TYPE_DIRECT)
                throw failure("Initializer queue is not DIRECT", E_UNEXPECTED);
            ComPtr<ID3D12Device> queue_device;
            check(queue->GetDevice(IID_PPV_ARGS(&queue_device)), "Queue::GetDevice");
            ComPtr<IUnknown> actual_identity, expected_identity;
            check(queue_device.As(&actual_identity), "Queue device IUnknown");
            check(device.As(&expected_identity), "Initializer device IUnknown");
            queue_device_matches = actual_identity.Get() == expected_identity.Get();
            if (!queue_device_matches) throw failure("Initializer queue device identity mismatch", E_UNEXPECTED);

            check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)), "CreateDXGIFactory2");
            check(factory->EnumAdapterByLuid(device->GetAdapterLuid(),
                IID_PPV_ARGS(&adapter)), "EnumAdapterByLuid(initializer device)");
            check(adapter->GetDesc1(&adapter_description), "GetDesc1(initializer adapter)");
            if ((adapter_description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0)
                throw failure("Initializer selected software adapter", DXGI_ERROR_UNSUPPORTED);

            const HINSTANCE instance = GetModuleHandleW(nullptr);
            WNDCLASSW wc = {};
            wc.hInstance = instance;
            wc.lpfnWndProc = window_proc;
            wc.lpszClassName = L"EgoEarlyProcessBootstrapFixture";
            wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
            if (RegisterClassW(&wc) == 0)
                throw failure("RegisterClassW", HRESULT_FROM_WIN32(GetLastError()));
            RECT rect = { 0, 0, 800, 600 };
            if (!AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE))
                throw failure("AdjustWindowRect", HRESULT_FROM_WIN32(GetLastError()));
            window = CreateWindowExW(0, wc.lpszClassName, L"Owned first-import D3D12 proof",
                WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
                rect.right - rect.left, rect.bottom - rect.top,
                nullptr, nullptr, instance, nullptr);
            if (window == nullptr)
                throw failure("CreateWindowExW", HRESULT_FROM_WIN32(GetLastError()));

            DXGI_SWAP_CHAIN_DESC1 desc = {};
            desc.Width = 800;
            desc.Height = 600;
            desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
            desc.SampleDesc.Count = 1;
            desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
            desc.BufferCount = static_cast<UINT>(buffers.size());
            desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
            ComPtr<IDXGISwapChain1> created_chain;
            check(factory->CreateSwapChainForHwnd(queue.Get(), window, &desc,
                nullptr, nullptr, &created_chain), "CreateSwapChainForHwnd(initializer queue)");
            check(created_chain.As(&chain), "QueryInterface(IDXGISwapChain3)");
            check(factory->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER), "MakeWindowAssociation");

            D3D12_DESCRIPTOR_HEAP_DESC heap = {};
            heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
            heap.NumDescriptors = static_cast<UINT>(buffers.size());
            check(device->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&rtv_heap)), "CreateDescriptorHeap(RTV)");
            rtv_stride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
            auto rtv = rtv_heap->GetCPUDescriptorHandleForHeapStart();
            for (UINT i = 0; i < buffers.size(); ++i)
            {
                check(chain->GetBuffer(i, IID_PPV_ARGS(&buffers[i])), "GetBuffer");
                device->CreateRenderTargetView(buffers[i].Get(), nullptr, rtv);
                rtv.ptr += rtv_stride;
            }
            check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                IID_PPV_ARGS(&allocator)), "CreateCommandAllocator");
            check(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT,
                allocator.Get(), nullptr, IID_PPV_ARGS(&list)), "CreateCommandList");
            check(list->Close(), "Close(initial command list)");
            check(device->CreateFence(0, D3D12_FENCE_FLAG_NONE,
                IID_PPV_ARGS(&fence)), "CreateFence");
            fence_event.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            if (fence_event.value == nullptr)
                throw failure("CreateEventW", HRESULT_FROM_WIN32(GetLastError()));
            ShowWindow(window, SW_SHOWNORMAL);
            UpdateWindow(window);
        }

        void render(UINT frame)
        {
            const UINT index = chain->GetCurrentBackBufferIndex();
            check(allocator->Reset(), "Reset(command allocator)");
            check(list->Reset(allocator.Get(), nullptr), "Reset(command list)");
            D3D12_RESOURCE_BARRIER barrier = {};
            barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            barrier.Transition.pResource = buffers.at(index).Get();
            barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
            barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
            list->ResourceBarrier(1, &barrier);
            auto rtv = rtv_heap->GetCPUDescriptorHandleForHeapStart();
            rtv.ptr += static_cast<SIZE_T>(index) * rtv_stride;
            const float color[4] = { 0.04f, 0.08f + 0.2f * static_cast<float>(frame % 60) / 60.0f, 0.18f, 1.0f };
            list->ClearRenderTargetView(rtv, color, 0, nullptr);
            std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
            list->ResourceBarrier(1, &barrier);
            check(list->Close(), "Close(frame command list)");
            ID3D12CommandList *const submitted[] = { list.Get() };
            queue->ExecuteCommandLists(1, submitted);
            const HRESULT presented = chain->Present(1, 0);
            const UINT64 value = ++fence_value;
            check(queue->Signal(fence.Get(), value), "Signal(frame fence)");
            check(fence->SetEventOnCompletion(value, fence_event.value), "SetEventOnCompletion(frame fence)");
            const DWORD wait = WaitForSingleObject(fence_event.value, 10000);
            if (wait != WAIT_OBJECT_0)
                throw failure("WaitForSingleObject(frame fence)",
                    HRESULT_FROM_WIN32(wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError()));
            if (fence->GetCompletedValue() == UINT64_MAX)
                throw failure("Device removed during frame", device->GetDeviceRemovedReason());
            // Drain submitted work before rejecting occlusion/status-only results.
            if (presented != S_OK) throw failure("Present did not return S_OK", presented);
        }
    };

    std::filesystem::path own_report_path()
    {
        std::wstring path(32768, L'\0');
        const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        if (size == 0 || size >= path.size())
            throw failure("GetModuleFileNameW(host)", HRESULT_FROM_WIN32(GetLastError()));
        path.resize(size);
        return std::filesystem::path(path).parent_path() / L"host-result.json";
    }
}

int wmain(int argc, wchar_t **argv)
{
    UINT requested_frames = 60;
    if (argc == 3 && std::wstring(argv[1]) == L"--frames")
    {
        wchar_t *end = nullptr;
        const unsigned long parsed = wcstoul(argv[2], &end, 10);
        if (end == argv[2] || *end != L'\0' || parsed < 60 || parsed > 3600) return 2;
        requested_frames = static_cast<UINT>(parsed);
    }
    else if (argc != 1) return 2;

    const bool entry_trace_okay = early_proof::trace(GetModuleHandleW(nullptr), "host-entry");
    EarlyOriginalGraphicsV1 original = {};
    original.struct_size = static_cast<UINT>(sizeof(original));
    original.device_result = E_PENDING;
    original.queue_result = E_PENDING;
    const BOOL transferred = EarlyOriginalGraphicsTakeV1(&original);
    FILETIME created = {}, exited = {}, kernel = {}, user = {};
    const BOOL times_okay = GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user);
    const UINT64 creation_time = (static_cast<UINT64>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    UINT completed_frames = 0;
    bool passed = false;
    bool queue_identity_matches = false;
    HRESULT final_result = E_FAIL;
    std::string failed_step;
    std::string adapter_name;
    UINT vendor = 0, adapter_device = 0;
    try
    {
        if (!g_pre_main_initializer_returned || !g_pre_main_initializer_okay ||
            !entry_trace_okay || !times_okay || !transferred ||
            !original.original_dll_attach_entered || !original.original_dll_attach_returned ||
            !original.initializer_entered || !original.initializer_returned || !original.trace_okay)
            throw failure("Incomplete initializer/identity/trace evidence", E_UNEXPECTED);
        check(original.device_result, "D3D12CreateDevice(pre-main initializer)");
        check(original.queue_result, "CreateCommandQueue(pre-main initializer)");
        graphics_host graphics;
        graphics.initialize(original);
        queue_identity_matches = graphics.queue_device_matches;
        adapter_name = utf8(graphics.adapter_description.Description);
        vendor = graphics.adapter_description.VendorId;
        adapter_device = graphics.adapter_description.DeviceId;
        for (UINT frame = 0; frame < requested_frames; ++frame)
        {
            MSG message = {};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
            {
                if (message.message == WM_QUIT)
                    throw failure("Owned fixture closed before required presents", HRESULT_FROM_WIN32(ERROR_CANCELLED));
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            graphics.render(frame);
            ++completed_frames;
        }
        if (!early_proof::trace(GetModuleHandleW(nullptr), "host-present-completed", S_OK, completed_frames))
            throw failure("Final trace append failed", E_FAIL);
        final_result = S_OK;
        passed = completed_frames == requested_frames;
    }
    catch (const failure &error) { final_result = error.result; failed_step = error.what(); }
    catch (const std::exception &error) { failed_step = error.what(); }
    if (original.queue != nullptr) original.queue->Release();
    if (original.device != nullptr) original.device->Release();

    try
    {
        const auto report = own_report_path();
        const auto temporary = report.parent_path() / L"host-result.json.tmp";
        std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
        output << "{\"schemaVersion\":1,\"scope\":\"controlled-first-import-D3D12-pre-main-proof\","
            << "\"processId\":" << GetCurrentProcessId()
            << ",\"creationTime100ns\":\"" << creation_time << '"'
            << ",\"passed\":" << (passed ? "true" : "false")
            << ",\"framesRequested\":" << requested_frames
            << ",\"framesCompleted\":" << completed_frames
            << ",\"originalDllAttachEntered\":" << (original.original_dll_attach_entered ? "true" : "false")
            << ",\"originalDllAttachReturned\":" << (original.original_dll_attach_returned ? "true" : "false")
            << ",\"graphicsInitializationPhase\":\"exe-crt-before-main\""
            << ",\"preMainInitializerReturned\":" << (g_pre_main_initializer_returned ? "true" : "false")
            << ",\"initializerEntered\":" << (original.initializer_entered ? "true" : "false")
            << ",\"initializerReturned\":" << (original.initializer_returned ? "true" : "false")
            << ",\"initializerTraceOkay\":" << (original.trace_okay ? "true" : "false")
            << ",\"initializerReferencesTransferred\":" << (transferred ? "true" : "false")
            << ",\"initializerDeviceHr\":" << json_string(hex_result(original.device_result))
            << ",\"initializerQueueHr\":" << json_string(hex_result(original.queue_result))
            << ",\"queueDeviceIdentityMatches\":" << (queue_identity_matches ? "true" : "false")
            << ",\"adapter\":{\"description\":" << json_string(adapter_name)
            << ",\"vendorId\":" << vendor << ",\"deviceId\":" << adapter_device << '}'
            << ",\"resultHr\":" << json_string(hex_result(final_result))
            << ",\"failedStep\":" << json_string(failed_step)
            << ",\"loadsReShade\":false,\"provesAutomaticAttachment\":false,"
            << "\"bootstrapOrderingValidatedByController\":false}";
        output.flush();
        if (!output.good()) return 3;
        output.close();
        if (!MoveFileExW(temporary.c_str(), report.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return 3;
    }
    catch (...) { return 3; }
    return passed ? 0 : 1;
}
