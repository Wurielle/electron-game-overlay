// Isolated actual-ReShade first-import proof. The launcher supplies the owned
// ReShade DLL as an in-memory first import. This host never calls LoadLibrary,
// never changes game files, and does not prove generic late attachment.
#include "../early-process-bootstrap/original-graphics.h"
#include "../early-process-bootstrap/trace.hpp"
#include "restore.h"

#include <dxgi1_6.h>
#include <psapi.h>
#include <wrl/client.h>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

using Microsoft::WRL::ComPtr;

namespace
{
#if defined(_WIN64)
    constexpr wchar_t owned_reshade_name[] = L"ReShade64.dll";
    constexpr wchar_t owned_restorer_name[] = L"early_reshade_restore64.dll";
#else
    constexpr wchar_t owned_reshade_name[] = L"ReShade32.dll";
    constexpr wchar_t owned_restorer_name[] = L"early_reshade_restore32.dll";
#endif
    wchar_t g_image_path[32768] = {};
    wchar_t g_reshade_path[32768] = {};
    wchar_t g_restorer_path[32768] = {};
    bool g_reshade_present_before_crt = false;
    bool g_reshade_from_stage_before_crt = false;
    bool g_reshade_exports_valid_before_crt = false;
    std::uint32_t g_reshade_module_count_before_crt = 0;
    bool g_reshade_module_enumeration_complete_before_crt = false;
    bool g_restore_state_verified = false;
    EarlyReShadeRestoreStateV1 g_restore_state = {};
    bool g_pre_main_initializer_returned = false;
    bool g_pre_main_initializer_okay = false;

    bool verify_single_mapped_reshade(HMODULE expected) noexcept
    {
        // Fixed bounds and two matching complete enumerations prevent a
        // truncated/changing module list from being accepted as one host.
        HMODULE modules[2048] = {};
        HMODULE verified[2048] = {};
        DWORD bytes = 0;
        if (!K32EnumProcessModules(GetCurrentProcess(), modules,
            static_cast<DWORD>(sizeof(modules)), &bytes) || bytes == 0 ||
            bytes > sizeof(modules) || bytes % sizeof(HMODULE) != 0)
            return false;
        const DWORD count = bytes / static_cast<DWORD>(sizeof(HMODULE));
        HMODULE detected = nullptr;
        for (DWORD i = 0; i < count; ++i)
        {
            if (GetProcAddress(modules[i], "ReShadeVersion") != nullptr)
            {
                ++g_reshade_module_count_before_crt;
                detected = modules[i];
            }
        }
        DWORD verified_bytes = 0;
        if (!K32EnumProcessModules(GetCurrentProcess(), verified,
            static_cast<DWORD>(sizeof(verified)), &verified_bytes) ||
            verified_bytes != bytes || verified_bytes > sizeof(verified))
            return false;
        for (DWORD i = 0; i < count; ++i)
            if (verified[i] != modules[i]) return false;
        g_reshade_module_enumeration_complete_before_crt = true;
        return g_reshade_module_count_before_crt == 1 && detected == expected;
    }

    bool capture_pre_main_host() noexcept
    {
        const DWORD image_length = GetModuleFileNameW(nullptr, g_image_path,
            static_cast<DWORD>(std::size(g_image_path)));
        if (image_length == 0 || image_length >= std::size(g_image_path)) return false;
        const HMODULE module = GetModuleHandleW(owned_reshade_name);
        g_reshade_present_before_crt = module != nullptr;
        if (module == nullptr) return false;
        const DWORD module_length = GetModuleFileNameW(module, g_reshade_path,
            static_cast<DWORD>(std::size(g_reshade_path)));
        if (module_length == 0 || module_length >= std::size(g_reshade_path)) return false;

        wchar_t expected_path[32768] = {};
        if (wcscpy_s(expected_path, g_image_path) != 0) return false;
        wchar_t *last_separator = wcsrchr(expected_path, L'\\');
        if (last_separator == nullptr) return false;
        *(last_separator + 1) = L'\0';
        if (wcscat_s(expected_path, owned_reshade_name) != 0) return false;
        g_reshade_from_stage_before_crt = _wcsicmp(expected_path, g_reshade_path) == 0;

        const auto host_abi = reinterpret_cast<const unsigned int *>(
            GetProcAddress(module, "ElectronGameOverlayReShadeHostAbi"));
        g_reshade_exports_valid_before_crt =
            host_abi != nullptr && *host_abi == 1 &&
            GetProcAddress(module, "ElectronGameOverlayReShadeAddonGate") != nullptr &&
            GetProcAddress(module, "ReShadeRegisterAddon") != nullptr &&
            GetProcAddress(module, "ReShadeGetImGuiFunctionTable") != nullptr &&
            GetProcAddress(module, "ReShadeCreateEffectRuntime") != nullptr &&
            GetProcAddress(module, "ReShadeUpdateAndPresentEffectRuntime") != nullptr &&
            GetProcAddress(module, "ReShadeDestroyEffectRuntime") != nullptr;
        const bool single_host = verify_single_mapped_reshade(module);
        return g_reshade_from_stage_before_crt && g_reshade_exports_valid_before_crt && single_host;
    }

    bool capture_pre_main_restore() noexcept
    {
        const HMODULE module = GetModuleHandleW(owned_restorer_name);
        if (module == nullptr) return false;
        const DWORD length = GetModuleFileNameW(module, g_restorer_path,
            static_cast<DWORD>(std::size(g_restorer_path)));
        if (length == 0 || length >= std::size(g_restorer_path)) return false;
        wchar_t expected_path[32768] = {};
        if (wcscpy_s(expected_path, g_image_path) != 0) return false;
        wchar_t *last_separator = wcsrchr(expected_path, L'\\');
        if (last_separator == nullptr) return false;
        *(last_separator + 1) = L'\0';
        if (wcscat_s(expected_path, owned_restorer_name) != 0 ||
            _wcsicmp(expected_path, g_restorer_path) != 0) return false;
        const auto query = reinterpret_cast<BOOL (WINAPI *)(EarlyReShadeRestoreStateV1 *)>(
            GetProcAddress(module, "EarlyReShadeRestoreQueryV1"));
        if (query == nullptr) return false;
        g_restore_state.struct_size = static_cast<std::uint32_t>(sizeof(g_restore_state));
        g_restore_state.abi_version = 1;
        if (!query(&g_restore_state)) return false;
        FILETIME created = {}, exited = {}, kernel = {}, user = {};
        if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return false;
        const std::uint64_t creation_time =
            (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        g_restore_state_verified =
            g_restore_state.struct_size == static_cast<std::uint32_t>(sizeof(g_restore_state)) &&
            g_restore_state.abi_version == 1 &&
            g_restore_state.process_id == GetCurrentProcessId() &&
            g_restore_state.creation_time_100ns == creation_time &&
            g_restore_state.restored_imports == 1 &&
            g_restore_state.owned_host_present == 1 &&
            g_restore_state.reshade_module == reinterpret_cast<std::uintptr_t>(GetModuleHandleW(owned_reshade_name));
        return g_restore_state_verified;
    }

    struct pre_main_graphics_initializer
    {
        pre_main_graphics_initializer() noexcept
        {
            const bool entered = early_proof::trace(GetModuleHandleW(nullptr),
                "host-crt-initializer-entry");
            const bool host_valid = capture_pre_main_host();
            const bool host_recorded = early_proof::trace(GetModuleHandleW(nullptr),
                "actual-reshade-host-verified", host_valid ? S_OK : E_UNEXPECTED);
            const bool restore_valid = host_valid && capture_pre_main_restore();
            const bool restore_recorded = early_proof::trace(GetModuleHandleW(nullptr),
                "actual-reshade-restore-state-verified", restore_valid ? S_OK : E_UNEXPECTED);
            // The original DLL's attach already returned. Its exported graphics
            // initializer executes here outside DLL loader initialization.
            const BOOL initialized = host_valid && restore_valid ? EarlyOriginalGraphicsInitializeV1() : FALSE;
            const HRESULT result = entered && host_recorded && restore_recorded && initialized ? S_OK : E_FAIL;
            const bool returned = early_proof::trace(GetModuleHandleW(nullptr),
                "host-crt-initializer-return", result);
            g_pre_main_initializer_returned = true;
            g_pre_main_initializer_okay = entered && host_recorded && restore_recorded && initialized && returned;
        }
    } g_pre_main_graphics_initializer;

    struct input_counters
    {
        std::uint64_t key_down = 0;
        std::uint64_t character = 0;
        std::uint64_t pointer_down = 0;
        std::uint64_t wheel = 0;
        std::uint64_t horizontal_wheel = 0;
    } g_input;
    bool g_close_requested = false;
    bool g_window_destroyed = false;

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
        switch (message)
        {
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN: ++g_input.key_down; break;
        case WM_CHAR:
        case WM_SYSCHAR: ++g_input.character; break;
        case WM_UNICHAR:
            if (wparam == UNICODE_NOCHAR) return TRUE;
            ++g_input.character;
            break;
        case WM_LBUTTONDOWN:
        case WM_RBUTTONDOWN:
        case WM_MBUTTONDOWN:
        case WM_XBUTTONDOWN: ++g_input.pointer_down; break;
        case WM_MOUSEWHEEL: ++g_input.wheel; break;
        case WM_MOUSEHWHEEL: ++g_input.horizontal_wheel; break;
        case WM_CLOSE:
            // The main loop drains and releases graphics before DestroyWindow.
            g_close_requested = true;
            return 0;
        case WM_DESTROY:
            g_window_destroyed = true;
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(window, message, wparam, lparam);
    }

    constexpr DWORD host_window_style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;

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
        bool shutdown_completed = false;

        ~graphics_host()
        {
            try { shutdown(); } catch (...) {}
        }

        void create_views()
        {
            D3D12_DESCRIPTOR_HEAP_DESC heap = {};
            heap.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
            heap.NumDescriptors = static_cast<UINT>(buffers.size());
            check(device->CreateDescriptorHeap(&heap, IID_PPV_ARGS(&rtv_heap)), "CreateDescriptorHeap(RTV)");
            auto rtv = rtv_heap->GetCPUDescriptorHandleForHeapStart();
            for (UINT i = 0; i < buffers.size(); ++i)
            {
                check(chain->GetBuffer(i, IID_PPV_ARGS(&buffers[i])), "GetBuffer");
                device->CreateRenderTargetView(buffers[i].Get(), nullptr, rtv);
                rtv.ptr += rtv_stride;
            }
        }

        void initialize(EarlyOriginalGraphicsV1 &original)
        {
            device.Attach(original.device);
            queue.Attach(original.queue);
            original.device = nullptr;
            original.queue = nullptr;
            if (device == nullptr || queue == nullptr)
                throw failure("Pre-main initializer did not transfer device and queue", E_POINTER);
            if (queue->GetDesc().Type != D3D12_COMMAND_LIST_TYPE_DIRECT)
                throw failure("Pre-main queue is not DIRECT", E_UNEXPECTED);
            ComPtr<ID3D12Device> queue_device;
            check(queue->GetDevice(IID_PPV_ARGS(&queue_device)), "Queue::GetDevice");
            ComPtr<IUnknown> actual_identity, expected_identity;
            check(queue_device.As(&actual_identity), "Queue device IUnknown");
            check(device.As(&expected_identity), "Pre-main device IUnknown");
            queue_device_matches = actual_identity.Get() == expected_identity.Get();
            if (!queue_device_matches) throw failure("Pre-main queue device identity mismatch", E_UNEXPECTED);

            check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)), "CreateDXGIFactory2");
            check(factory->EnumAdapterByLuid(device->GetAdapterLuid(),
                IID_PPV_ARGS(&adapter)), "EnumAdapterByLuid(pre-main device)");
            check(adapter->GetDesc1(&adapter_description), "GetDesc1(pre-main adapter)");
            if ((adapter_description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0)
                throw failure("Pre-main initializer selected software adapter", DXGI_ERROR_UNSUPPORTED);

            const HINSTANCE instance = GetModuleHandleW(nullptr);
            WNDCLASSW wc = {};
            wc.hInstance = instance;
            wc.lpfnWndProc = window_proc;
            wc.lpszClassName = L"EgoEarlyActualReShadeD3D12Fixture";
            wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
            if (RegisterClassW(&wc) == 0)
                throw failure("RegisterClassW", HRESULT_FROM_WIN32(GetLastError()));
            RECT rect = { 0, 0, 800, 600 };
            if (!AdjustWindowRect(&rect, host_window_style, FALSE))
                throw failure("AdjustWindowRect", HRESULT_FROM_WIN32(GetLastError()));
            window = CreateWindowExW(0, wc.lpszClassName, L"Owned first-import ReShade D3D12 proof",
                host_window_style, CW_USEDEFAULT, CW_USEDEFAULT,
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
                nullptr, nullptr, &created_chain), "CreateSwapChainForHwnd(pre-main queue)");
            check(created_chain.As(&chain), "QueryInterface(IDXGISwapChain3)");
            check(factory->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER), "MakeWindowAssociation");
            rtv_stride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
            create_views();
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

        void wait_for_gpu()
        {
            if (queue == nullptr || fence == nullptr || fence_event.value == nullptr) return;
            const UINT64 value = ++fence_value;
            check(queue->Signal(fence.Get(), value), "Signal(frame fence)");
            check(fence->SetEventOnCompletion(value, fence_event.value), "SetEventOnCompletion(frame fence)");
            const DWORD wait = WaitForSingleObject(fence_event.value, 10000);
            if (wait != WAIT_OBJECT_0)
                throw failure("WaitForSingleObject(frame fence)",
                    HRESULT_FROM_WIN32(wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError()));
            if (fence->GetCompletedValue() == UINT64_MAX)
                throw failure("Device removed during frame", device->GetDeviceRemovedReason());
        }

        void render(std::uint64_t frame)
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
            // All application commands and the automatically hooked ReShade
            // presentation complete before reusing our allocator/resources.
            wait_for_gpu();
            if (presented != S_OK) throw failure("Present did not return S_OK", presented);
        }

        void resize()
        {
            wait_for_gpu();
            check(allocator->Reset(), "Reset(command allocator before resize)");
            check(list->Reset(allocator.Get(), nullptr), "Reset(command list before resize)");
            check(list->Close(), "Close(empty command list before resize)");
            for (auto &buffer : buffers) buffer.Reset();
            rtv_heap.Reset();
            RECT rect = { 0, 0, 960, 640 };
            if (!AdjustWindowRect(&rect, host_window_style, FALSE))
                throw failure("AdjustWindowRect(resize)", HRESULT_FROM_WIN32(GetLastError()));
            if (!SetWindowPos(window, nullptr, 0, 0, rect.right - rect.left,
                rect.bottom - rect.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE))
                throw failure("SetWindowPos(resize)", HRESULT_FROM_WIN32(GetLastError()));
            check(chain->ResizeBuffers(static_cast<UINT>(buffers.size()), 960, 640,
                DXGI_FORMAT_UNKNOWN, 0), "ResizeBuffers(960x640)");
            create_views();
        }

        void shutdown()
        {
            if (shutdown_completed) return;
            wait_for_gpu();
            list.Reset();
            allocator.Reset();
            for (auto &buffer : buffers) buffer.Reset();
            rtv_heap.Reset();
            chain.Reset();
            factory.Reset();
            adapter.Reset();
            fence.Reset();
            queue.Reset();
            device.Reset();
            if (window != nullptr && IsWindow(window))
            {
                if (!DestroyWindow(window))
                    throw failure("DestroyWindow(cleanup)", HRESULT_FROM_WIN32(GetLastError()));
            }
            shutdown_completed = true;
        }
    };

    struct evidence
    {
        std::filesystem::path report_path;
        std::string status = "running";
        std::string failure_message;
        std::string stop_reason;
        HRESULT result = E_PENDING;
        UINT64 creation_time = 0;
        UINT64 start_ticks = 0;
        UINT64 lifetime_ms = 180000;
        std::uint64_t resize_after_frames = 300;
        std::uint64_t native_presents = 0;
        UINT resize_successes = 0;
        std::uint64_t post_resize_frames = 0;
        HWND window = nullptr;
        bool cleanup_completed = false;
        bool resize_requested = false;
        bool queue_device_matches = false;
        BOOL references_transferred = FALSE;
        EarlyOriginalGraphicsV1 original = {};
        DXGI_ADAPTER_DESC1 adapter = {};

        void write() const
        {
            RECT client = {};
            const bool client_valid = window != nullptr && IsWindow(window) && GetClientRect(window, &client);
            const auto temporary = report_path.parent_path() / L"host-report.json.tmp";
            std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
            output << "{\"schemaVersion\":1,\"scope\":\"controlled-first-import-actual-ReShade-D3D12-pre-main-proof\","
                << "\"pid\":" << GetCurrentProcessId()
                << ",\"creationTime100ns\":\"" << creation_time << '"'
                << ",\"exactImagePath\":" << json_string(utf8(g_image_path))
                << ",\"windowHandle\":\"" << reinterpret_cast<UINT_PTR>(window) << '"'
                << ",\"status\":" << json_string(status)
                << ",\"failure\":" << json_string(failure_message)
                << ",\"resultHr\":" << json_string(hex_result(result))
                << ",\"elapsedMs\":" << (GetTickCount64() - start_ticks)
                << ",\"lifetimeMs\":" << lifetime_ms
                << ",\"resizeAfterFrames\":" << resize_after_frames
                << ",\"resizeRequested\":" << (resize_requested ? "true" : "false")
                << ",\"nativePresentSuccesses\":" << native_presents
                << ",\"resizeSuccesses\":" << resize_successes
                << ",\"framesAfterResize\":" << post_resize_frames
                << ",\"keyDownMessages\":" << g_input.key_down
                << ",\"characterMessages\":" << g_input.character
                << ",\"pointerDownMessages\":" << g_input.pointer_down
                << ",\"wheelMessages\":" << g_input.wheel
                << ",\"horizontalWheelMessages\":" << g_input.horizontal_wheel
                << ",\"originalDllAttachEntered\":" << (original.original_dll_attach_entered ? "true" : "false")
                << ",\"originalDllAttachReturned\":" << (original.original_dll_attach_returned ? "true" : "false")
                << ",\"graphicsInitializationPhase\":\"exe-crt-before-main\""
                << ",\"preMainInitializerReturned\":" << (g_pre_main_initializer_returned ? "true" : "false")
                << ",\"preMainInitializerOkay\":" << (g_pre_main_initializer_okay ? "true" : "false")
                << ",\"initializerEntered\":" << (original.initializer_entered ? "true" : "false")
                << ",\"initializerReturned\":" << (original.initializer_returned ? "true" : "false")
                << ",\"initializerTraceOkay\":" << (original.trace_okay ? "true" : "false")
                << ",\"initializerReferencesTransferred\":" << (references_transferred ? "true" : "false")
                << ",\"initializerDeviceHr\":" << json_string(hex_result(original.device_result))
                << ",\"initializerQueueHr\":" << json_string(hex_result(original.queue_result))
                << ",\"queueDeviceIdentityMatches\":" << (queue_device_matches ? "true" : "false")
                << ",\"reshadeModulePath\":" << json_string(utf8(g_reshade_path))
                << ",\"reshadePresentBeforeCrt\":" << (g_reshade_present_before_crt ? "true" : "false")
                << ",\"reshadeFromStageBeforeCrt\":" << (g_reshade_from_stage_before_crt ? "true" : "false")
                << ",\"reshadeExportsValidBeforeCrt\":" << (g_reshade_exports_valid_before_crt ? "true" : "false")
                << ",\"reshadeModuleCountBeforeCrt\":" << g_reshade_module_count_before_crt
                << ",\"reshadeModuleEnumerationCompleteBeforeCrt\":"
                << (g_reshade_module_enumeration_complete_before_crt ? "true" : "false")
                << ",\"restorerModulePath\":" << json_string(utf8(g_restorer_path))
                << ",\"restoreStateVerified\":" << (g_restore_state_verified ? "true" : "false")
                << ",\"restoreState\":{\"structSize\":" << g_restore_state.struct_size
                << ",\"abiVersion\":" << g_restore_state.abi_version
                << ",\"processId\":" << g_restore_state.process_id
                << ",\"threadId\":" << g_restore_state.thread_id
                << ",\"creationTime100ns\":\"" << g_restore_state.creation_time_100ns << '"'
                << ",\"restoredImports\":" << g_restore_state.restored_imports
                << ",\"ownedHostPresent\":" << g_restore_state.owned_host_present
                << ",\"reshadeModule\":\"" << g_restore_state.reshade_module << "\"}"
                << ",\"adapter\":{\"description\":" << json_string(utf8(adapter.Description))
                << ",\"vendorId\":" << adapter.VendorId << ",\"deviceId\":" << adapter.DeviceId
                << ",\"luidHighPart\":" << adapter.AdapterLuid.HighPart
                << ",\"luidLowPart\":" << adapter.AdapterLuid.LowPart << '}'
                << ",\"clientRectValid\":" << (client_valid ? "true" : "false")
                << ",\"clientWidth\":" << (client_valid ? client.right - client.left : 0)
                << ",\"clientHeight\":" << (client_valid ? client.bottom - client.top : 0)
                << ",\"closeRequested\":" << (g_close_requested ? "true" : "false")
                << ",\"windowDestroyed\":" << (g_window_destroyed ? "true" : "false")
                << ",\"cleanupCompleted\":" << (cleanup_completed ? "true" : "false")
                << ",\"stopReason\":" << json_string(stop_reason)
                << ",\"hostCallsLoadLibrary\":false,\"provesAutomaticAttachment\":false,"
                << "\"physicalKeyboardProven\":false}";
            output.flush();
            if (!output.good()) throw failure("Write host-report.json", E_FAIL);
            output.close();
            if (!MoveFileExW(temporary.c_str(), report_path.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                throw failure("Publish host-report.json", HRESULT_FROM_WIN32(GetLastError()));
        }
    };

    UINT64 parse_integer(const wchar_t *text, UINT64 minimum, UINT64 maximum)
    {
        wchar_t *end = nullptr;
        if (text == nullptr || *text < L'0' || *text > L'9')
            throw failure("Invalid numeric argument", E_INVALIDARG);
        const unsigned long long parsed = wcstoull(text, &end, 10);
        if (end == text || *end != L'\0' || parsed < minimum || parsed > maximum)
            throw failure("Numeric argument out of range", E_INVALIDARG);
        return parsed;
    }

    bool resize_requested(const std::filesystem::path &directory)
    {
        constexpr char token[] = "EGO_EARLY_RESHADE_RESIZE_V1\n";
        const auto path = directory / L"host-resize.request";
        HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (file == INVALID_HANDLE_VALUE)
        {
            const DWORD error = GetLastError();
            if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return false;
            throw failure("Open owned resize request", HRESULT_FROM_WIN32(error));
        }
        event_handle owned_file;
        owned_file.value = file;
        if (GetFileType(file) != FILE_TYPE_DISK)
            throw failure("Owned resize request is not a disk file", E_INVALIDARG);
        FILE_ATTRIBUTE_TAG_INFO attributes = {};
        FILE_STANDARD_INFO standard = {};
        if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
            !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)))
            throw failure("Inspect owned resize request", HRESULT_FROM_WIN32(GetLastError()));
        if ((attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
            standard.Directory || standard.EndOfFile.QuadPart != static_cast<LONGLONG>(sizeof(token) - 1))
            throw failure("Owned resize request is not the exact regular token file", E_INVALIDARG);
        char actual[sizeof(token)] = {};
        DWORD read = 0;
        if (!ReadFile(file, actual, static_cast<DWORD>(sizeof(token) - 1), &read, nullptr))
            throw failure("Read owned resize request", HRESULT_FROM_WIN32(GetLastError()));
        if (read != sizeof(token) - 1 || memcmp(actual, token, sizeof(token) - 1) != 0)
            throw failure("Owned resize request token mismatch", E_INVALIDARG);
        return true;
    }
}

int wmain(int argc, wchar_t **argv)
{
    evidence report;
    report.start_ticks = GetTickCount64();
    report.original.struct_size = static_cast<UINT>(sizeof(report.original));
    report.original.device_result = E_PENDING;
    report.original.queue_result = E_PENDING;
    std::unique_ptr<graphics_host> graphics;
    bool report_ready = false;
    try
    {
        if (g_image_path[0] == L'\0')
        {
            const DWORD size = GetModuleFileNameW(nullptr, g_image_path,
                static_cast<DWORD>(std::size(g_image_path)));
            if (size == 0 || size >= std::size(g_image_path))
                throw failure("GetModuleFileNameW(host)", HRESULT_FROM_WIN32(GetLastError()));
        }
        report.report_path = std::filesystem::path(g_image_path).parent_path() / L"host-report.json";
        FILETIME created = {}, exited = {}, kernel = {}, user = {};
        if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user))
            throw failure("GetProcessTimes(host)", HRESULT_FROM_WIN32(GetLastError()));
        report.creation_time = (static_cast<UINT64>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        report_ready = true;
        for (int i = 1; i < argc; i += 2)
        {
            if (i + 1 >= argc) throw failure("Missing argument value", E_INVALIDARG);
            if (std::wstring(argv[i]) == L"--lifetime-ms")
                report.lifetime_ms = parse_integer(argv[i + 1], 1000, 180000);
            else if (std::wstring(argv[i]) == L"--resize-after-frames")
            {
                report.resize_after_frames = parse_integer(argv[i + 1], 0, 9000);
                if (report.resize_after_frames != 0 && report.resize_after_frames < 60)
                    throw failure("Automatic resize needs at least 60 initial presents", E_INVALIDARG);
            }
            else throw failure("Unknown argument", E_INVALIDARG);
        }
        const bool entry_recorded = early_proof::trace(GetModuleHandleW(nullptr), "host-entry");
        report.references_transferred = EarlyOriginalGraphicsTakeV1(&report.original);
        report.write();
        if (!entry_recorded || !g_pre_main_initializer_returned || !g_pre_main_initializer_okay ||
            !g_reshade_present_before_crt || !g_reshade_from_stage_before_crt ||
            !g_reshade_exports_valid_before_crt || !g_restore_state_verified || !report.references_transferred ||
            !report.original.original_dll_attach_entered || !report.original.original_dll_attach_returned ||
            !report.original.initializer_entered || !report.original.initializer_returned || !report.original.trace_okay)
            throw failure("Incomplete first-import/pre-main initializer evidence", E_UNEXPECTED);
        check(report.original.device_result, "D3D12CreateDevice(pre-main initializer)");
        check(report.original.queue_result, "CreateCommandQueue(pre-main initializer)");
        graphics = std::make_unique<graphics_host>();
        graphics->initialize(report.original);
        report.window = graphics->window;
        report.queue_device_matches = graphics->queue_device_matches;
        report.adapter = graphics->adapter_description;
        report.write();
        UINT64 last_report = GetTickCount64();
        while (!g_close_requested && !g_window_destroyed)
        {
            MSG message = {};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
            {
                if (message.message == WM_QUIT) { g_close_requested = true; break; }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if (g_close_requested || g_window_destroyed) break;
            if (GetTickCount64() - report.start_ticks >= report.lifetime_ms)
            {
                report.stop_reason = "lifetime-expired";
                break;
            }
            graphics->render(report.native_presents);
            ++report.native_presents;
            if (report.resize_successes != 0) ++report.post_resize_frames;
            const bool automatic_resize = report.resize_after_frames != 0 &&
                report.native_presents >= report.resize_after_frames;
            if (report.resize_successes == 0 && report.native_presents >= 60 &&
                (automatic_resize || resize_requested(report.report_path.parent_path())))
            {
                report.resize_requested = true;
                report.write();
                graphics->resize();
                ++report.resize_successes;
                report.post_resize_frames = 0;
                if (!early_proof::trace(GetModuleHandleW(nullptr), "host-resize-completed", S_OK, report.resize_successes))
                    throw failure("Resize trace append failed", E_FAIL);
                report.write();
                last_report = GetTickCount64();
            }
            else if (GetTickCount64() - last_report >= 50)
            {
                report.write();
                last_report = GetTickCount64();
            }
        }
        if (report.stop_reason.empty())
            report.stop_reason = g_window_destroyed ? "window-destroyed" : "close-requested";
        if (report.native_presents < 60 || report.resize_successes != 1 || report.post_resize_frames < 60)
            throw failure("Closed before required pre/post-resize presentations", HRESULT_FROM_WIN32(ERROR_CANCELLED));
        graphics->shutdown();
        report.cleanup_completed = graphics->shutdown_completed;
        if (!report.cleanup_completed || !g_window_destroyed)
            throw failure("Owned host cleanup incomplete", E_UNEXPECTED);
        if (!early_proof::trace(GetModuleHandleW(nullptr), "host-present-completed", S_OK,
            static_cast<unsigned long>(report.native_presents)))
            throw failure("Final trace append failed", E_FAIL);
        report.result = S_OK;
        report.status = "passed";
    }
    catch (const failure &error)
    {
        report.result = error.result;
        report.failure_message = std::string(error.what()) + ": " + hex_result(error.result);
        report.status = "failed";
    }
    catch (const std::exception &error)
    {
        report.result = E_FAIL;
        report.failure_message = error.what();
        report.status = "failed";
    }
    if (graphics != nullptr && !graphics->shutdown_completed)
    {
        try { graphics->shutdown(); report.cleanup_completed = graphics->shutdown_completed; }
        catch (const std::exception &error)
        {
            report.failure_message += std::string("; cleanup: ") + error.what();
            report.status = "failed";
        }
    }
    if (report.original.queue != nullptr) report.original.queue->Release();
    if (report.original.device != nullptr) report.original.device->Release();
    try { if (report_ready) report.write(); else return 3; }
    catch (...) { return 3; }
    return report.status == "passed" ? 0 : 1;
}
