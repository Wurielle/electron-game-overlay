// Controlled public-COM capability probe. It does not load ReShade or install hooks.
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <array>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

namespace
{
    std::string utf8(const std::wstring &value)
    {
        if (value.empty()) return {};
        const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
        if (size <= 0) throw std::runtime_error("UTF-8 conversion failed");
        std::string result(static_cast<size_t>(size), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size)
            throw std::runtime_error("UTF-8 conversion failed");
        return result;
    }

    std::string quoted(const std::string &value)
    {
        std::ostringstream out;
        out << '"';
        for (const unsigned char c : value)
        {
            switch (c)
            {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 0x20)
                    out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c) << std::dec;
                else
                    out << c;
            }
        }
        out << '"';
        return out.str();
    }

    std::string boolean(bool value) { return value ? "true" : "false"; }
    std::string hr_json(HRESULT value)
    {
        std::ostringstream out;
        out << "\"0x" << std::uppercase << std::hex << std::setw(8) << std::setfill('0')
            << static_cast<uint32_t>(value) << "\"";
        return out.str();
    }

    struct json_object
    {
        std::map<std::string, std::string> fields;
        void set(const std::string &key, const std::string &raw_json) { fields[key] = raw_json; }
        void text(const std::string &key, const std::string &value) { set(key, quoted(value)); }
        void flag(const std::string &key, bool value) { set(key, boolean(value)); }
        void hr(const std::string &key, HRESULT value) { set(key, hr_json(value)); }
        std::string str() const
        {
            std::ostringstream out;
            out << '{';
            bool first = true;
            for (const auto &field : fields)
            {
                if (!first) out << ',';
                first = false;
                out << quoted(field.first) << ':' << field.second;
            }
            out << '}';
            return out.str();
        }
    };

    std::string json_array(const std::vector<std::string> &values)
    {
        std::ostringstream out;
        out << '[';
        for (size_t i = 0; i < values.size(); ++i)
        {
            if (i != 0) out << ',';
            out << values[i];
        }
        out << ']';
        return out.str();
    }

    struct failed_step : std::runtime_error
    {
        HRESULT result;
        failed_step(const char *phase, HRESULT value) : std::runtime_error(phase), result(value) {}
    };

    void check(HRESULT hr, const char *phase)
    {
        if (FAILED(hr)) throw failed_step(phase, hr);
    }

    struct win_handle
    {
        HANDLE value = nullptr;
        ~win_handle() { if (value != nullptr && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    };

    fs::path executable_path()
    {
        std::wstring path(32768, L'\0');
        const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        if (length == 0 || length >= path.size())
            throw failed_step("GetModuleFileNameW(executable)", HRESULT_FROM_WIN32(GetLastError()));
        path.resize(length);
        return fs::canonical(fs::path(path));
    }

    std::string module_path(const wchar_t *name)
    {
        const HMODULE module = GetModuleHandleW(name);
        if (module == nullptr) return {};
        std::wstring path(32768, L'\0');
        const DWORD length = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
        if (length == 0 || length >= path.size()) return {};
        path.resize(length);
        return utf8(path);
    }

    json_object identity_comparison(IUnknown *actual, IUnknown *expected)
    {
        json_object result;
        result.flag("actualNonNull", actual != nullptr);
        result.flag("expectedNonNull", expected != nullptr);
        ComPtr<IUnknown> actual_identity;
        ComPtr<IUnknown> expected_identity;
        const HRESULT actual_hr = actual == nullptr ? E_POINTER : actual->QueryInterface(IID_PPV_ARGS(&actual_identity));
        const HRESULT expected_hr = expected == nullptr ? E_POINTER : expected->QueryInterface(IID_PPV_ARGS(&expected_identity));
        result.hr("actualIUnknownHr", actual_hr);
        result.hr("expectedIUnknownHr", expected_hr);
        result.flag("matches", SUCCEEDED(actual_hr) && SUCCEEDED(expected_hr) &&
            actual_identity != nullptr && actual_identity.Get() == expected_identity.Get());
        return result;
    }

    bool same_identity(IUnknown *actual, IUnknown *expected)
    {
        if (actual == nullptr || expected == nullptr) return false;
        ComPtr<IUnknown> a, b;
        return SUCCEEDED(actual->QueryInterface(IID_PPV_ARGS(&a))) &&
            SUCCEEDED(expected->QueryInterface(IID_PPV_ARGS(&b))) && a != nullptr && a.Get() == b.Get();
    }

    json_object inspect_queue(ID3D12CommandQueue *queue, ID3D12CommandQueue *known_queue, ID3D12Device *known_device)
    {
        json_object result;
        result.set("knownQueueIdentity", identity_comparison(queue, known_queue).str());
        if (queue == nullptr) return result;
        const D3D12_COMMAND_QUEUE_DESC desc = queue->GetDesc();
        result.set("type", std::to_string(static_cast<unsigned>(desc.Type)));
        result.flag("isDirect", desc.Type == D3D12_COMMAND_LIST_TYPE_DIRECT);
        result.set("nodeMask", std::to_string(desc.NodeMask));
        ComPtr<ID3D12Device> device;
        const HRESULT hr = queue->GetDevice(IID_PPV_ARGS(&device));
        result.hr("getDeviceHr", hr);
        result.set("knownDeviceIdentity", identity_comparison(SUCCEEDED(hr) ? device.Get() : nullptr, known_device).str());
        return result;
    }

    json_object inspect_assistant(ID3D12SwapChainAssistant *assistant, IDXGISwapChain3 *known_chain,
        ID3D12Resource *known_buffer, ID3D12CommandQueue *known_queue, ID3D12Device *known_device)
    {
        json_object result;
        result.flag("returnedNonNull", assistant != nullptr);
        if (assistant == nullptr) return result;

        // These are the only assistant methods this fixture calls. In particular,
        // InsertImplicitSync is never called and GetLUID is not used for inference.
        ComPtr<IUnknown> chain_object;
        const HRESULT object_hr = assistant->GetSwapChainObject(IID_PPV_ARGS(&chain_object));
        result.hr("getSwapChainObjectIUnknownHr", object_hr);
        result.set("knownChainIdentity", identity_comparison(SUCCEEDED(object_hr) ? chain_object.Get() : nullptr, known_chain).str());

        ComPtr<IDXGISwapChain> chain_interface;
        const HRESULT chain_hr = assistant->GetSwapChainObject(IID_PPV_ARGS(&chain_interface));
        result.hr("getSwapChainObjectIDXGISwapChainHr", chain_hr);
        result.set("knownChainInterfaceIdentity", identity_comparison(SUCCEEDED(chain_hr) ? chain_interface.Get() : nullptr, known_chain).str());

        ComPtr<ID3D12Resource> resource;
        ComPtr<ID3D12CommandQueue> queue;
        const HRESULT current_hr = assistant->GetCurrentResourceAndCommandQueue(
            IID_PPV_ARGS(&resource), IID_PPV_ARGS(&queue));
        result.hr("getCurrentResourceAndCommandQueueHr", current_hr);
        result.flag("resourceReturnedNonNull", resource != nullptr);
        result.flag("queueReturnedNonNull", queue != nullptr);
        result.set("knownCurrentBufferIdentity", identity_comparison(SUCCEEDED(current_hr) ? resource.Get() : nullptr, known_buffer).str());
        result.set("queue", inspect_queue(SUCCEEDED(current_hr) ? queue.Get() : nullptr, known_queue, known_device).str());

        ComPtr<ID3D12Device> queue_device;
        const bool queue_valid = SUCCEEDED(current_hr) && queue != nullptr &&
            queue->GetDesc().Type == D3D12_COMMAND_LIST_TYPE_DIRECT &&
            SUCCEEDED(queue->GetDevice(IID_PPV_ARGS(&queue_device))) && same_identity(queue_device.Get(), known_device);
        result.flag("allKnownGroundTruthMatches", SUCCEEDED(object_hr) &&
            same_identity(chain_object.Get(), known_chain) && SUCCEEDED(chain_hr) &&
            same_identity(chain_interface.Get(), known_chain) && SUCCEEDED(current_hr) &&
            same_identity(resource.Get(), known_buffer) && same_identity(queue.Get(), known_queue) && queue_valid);
        return result;
    }

    LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
    {
        if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
        if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
        return DefWindowProcW(window, message, wparam, lparam);
    }

    struct graphics_host
    {
        HWND window = nullptr;
        ComPtr<IDXGIFactory4> factory;
        ComPtr<IDXGIAdapter1> adapter;
        ComPtr<ID3D12Device> device;
        ComPtr<ID3D12CommandQueue> queue;
        ComPtr<IDXGISwapChain3> chain;
        ComPtr<ID3D12DescriptorHeap> rtv_heap;
        std::array<ComPtr<ID3D12Resource>, 2> buffers;
        ComPtr<ID3D12CommandAllocator> allocator;
        ComPtr<ID3D12GraphicsCommandList> list;
        ComPtr<ID3D12Fence> fence;
        win_handle fence_event;
        UINT rtv_stride = 0;
        UINT64 fence_value = 0;

        ~graphics_host()
        {
            if (window != nullptr && IsWindow(window)) DestroyWindow(window);
        }

        void initialize(bool warp, json_object &report)
        {
            check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)), "CreateDXGIFactory2");
            if (warp)
                check(factory->EnumWarpAdapter(IID_PPV_ARGS(&adapter)), "EnumWarpAdapter");
            else
            {
                for (UINT i = 0;; ++i)
                {
                    const HRESULT enum_hr = factory->EnumAdapters1(i, &adapter);
                    if (enum_hr == DXGI_ERROR_NOT_FOUND) break;
                    check(enum_hr, "EnumAdapters1");
                    DXGI_ADAPTER_DESC1 desc = {};
                    check(adapter->GetDesc1(&desc), "IDXGIAdapter1::GetDesc1");
                    if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0 &&
                        SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device))))
                        break;
                    adapter.Reset();
                }
                if (device == nullptr) throw failed_step("No hardware D3D12 adapter", DXGI_ERROR_UNSUPPORTED);
            }
            if (device == nullptr)
                check(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device)), "D3D12CreateDevice(WARP)");

            DXGI_ADAPTER_DESC1 adapter_desc = {};
            check(adapter->GetDesc1(&adapter_desc), "GetDesc1(selected adapter)");
            json_object adapter_report;
            adapter_report.text("description", utf8(adapter_desc.Description));
            adapter_report.set("vendorId", std::to_string(adapter_desc.VendorId));
            adapter_report.set("deviceId", std::to_string(adapter_desc.DeviceId));
            adapter_report.set("luidHighPart", std::to_string(adapter_desc.AdapterLuid.HighPart));
            adapter_report.set("luidLowPart", std::to_string(adapter_desc.AdapterLuid.LowPart));
            adapter_report.flag("warpRequested", warp);
            report.set("adapter", adapter_report.str());

            D3D12_COMMAND_QUEUE_DESC queue_desc = {};
            queue_desc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
            check(device->CreateCommandQueue(&queue_desc, IID_PPV_ARGS(&queue)), "CreateCommandQueue(DIRECT)");

            const HINSTANCE instance = GetModuleHandleW(nullptr);
            WNDCLASSW wc = {};
            wc.hInstance = instance;
            wc.lpfnWndProc = window_proc;
            wc.lpszClassName = L"EgoLateD3D12QueueQueryFixture";
            wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
            if (RegisterClassW(&wc) == 0)
                throw failed_step("RegisterClassW", HRESULT_FROM_WIN32(GetLastError()));
            RECT rect = { 0, 0, 640, 360 };
            if (!AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE))
                throw failed_step("AdjustWindowRect", HRESULT_FROM_WIN32(GetLastError()));
            window = CreateWindowExW(0, wc.lpszClassName, L"Owned D3D12 queue query probe",
                WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, rect.right - rect.left,
                rect.bottom - rect.top, nullptr, nullptr, instance, nullptr);
            if (window == nullptr)
                throw failed_step("CreateWindowExW", HRESULT_FROM_WIN32(GetLastError()));

            DXGI_SWAP_CHAIN_DESC1 desc = {};
            desc.Width = 640;
            desc.Height = 360;
            desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
            desc.SampleDesc.Count = 1;
            desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
            desc.BufferCount = static_cast<UINT>(buffers.size());
            desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
            ComPtr<IDXGISwapChain1> created_chain;
            check(factory->CreateSwapChainForHwnd(queue.Get(), window, &desc, nullptr, nullptr,
                &created_chain), "CreateSwapChainForHwnd(known DIRECT queue)");
            check(created_chain.As(&chain), "QueryInterface(IDXGISwapChain3)");
            check(factory->MakeWindowAssociation(window, DXGI_MWA_NO_ALT_ENTER), "MakeWindowAssociation");

            D3D12_DESCRIPTOR_HEAP_DESC heap_desc = {};
            heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
            heap_desc.NumDescriptors = static_cast<UINT>(buffers.size());
            check(device->CreateDescriptorHeap(&heap_desc, IID_PPV_ARGS(&rtv_heap)), "CreateDescriptorHeap(RTV)");
            rtv_stride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
            auto rtv = rtv_heap->GetCPUDescriptorHandleForHeapStart();
            for (UINT i = 0; i < buffers.size(); ++i)
            {
                check(chain->GetBuffer(i, IID_PPV_ARGS(&buffers[i])), "GetBuffer(initial)");
                device->CreateRenderTargetView(buffers[i].Get(), nullptr, rtv);
                rtv.ptr += rtv_stride;
            }
            check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocator)), "CreateCommandAllocator");
            check(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator.Get(),
                nullptr, IID_PPV_ARGS(&list)), "CreateCommandList");
            check(list->Close(), "Close(initial command list)");
            check(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)), "CreateFence");
            fence_event.value = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            if (fence_event.value == nullptr)
                throw failed_step("CreateEventW", HRESULT_FROM_WIN32(GetLastError()));
            ShowWindow(window, SW_SHOWNORMAL);
            UpdateWindow(window);
        }

        void wait_for_frame(json_object &frame)
        {
            const UINT64 value = ++fence_value;
            const HRESULT signal_hr = queue->Signal(fence.Get(), value);
            frame.hr("signalHr", signal_hr);
            check(signal_hr, "Signal(frame fence)");
            const HRESULT event_hr = fence->SetEventOnCompletion(value, fence_event.value);
            frame.hr("setEventHr", event_hr);
            check(event_hr, "SetEventOnCompletion");
            const DWORD wait = WaitForSingleObject(fence_event.value, 10000);
            frame.set("waitStatus", std::to_string(wait));
            if (wait != WAIT_OBJECT_0)
                throw failed_step("WaitForSingleObject(frame fence)", HRESULT_FROM_WIN32(wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError()));
            if (fence->GetCompletedValue() == UINT64_MAX)
                throw failed_step("Device removed during frame", device->GetDeviceRemovedReason());
        }

        void render(UINT frame_index, json_object &frame)
        {
            const UINT buffer_index = chain->GetCurrentBackBufferIndex();
            frame.set("bufferIndex", std::to_string(buffer_index));
            check(allocator->Reset(), "Reset(command allocator)");
            check(list->Reset(allocator.Get(), nullptr), "Reset(command list)");
            D3D12_RESOURCE_BARRIER barrier = {};
            barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            barrier.Transition.pResource = buffers.at(buffer_index).Get();
            barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
            barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
            list->ResourceBarrier(1, &barrier);
            auto rtv = rtv_heap->GetCPUDescriptorHandleForHeapStart();
            rtv.ptr += static_cast<SIZE_T>(buffer_index) * rtv_stride;
            const float color[4] = { 0.04f + 0.2f * static_cast<float>(frame_index % 60) / 60.0f, 0.08f, 0.18f, 1.0f };
            list->ClearRenderTargetView(rtv, color, 0, nullptr);
            std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
            list->ResourceBarrier(1, &barrier);
            check(list->Close(), "Close(frame command list)");
            ID3D12CommandList *const command_lists[] = { list.Get() };
            queue->ExecuteCommandLists(1, command_lists);
            const HRESULT present_hr = chain->Present(1, 0);
            frame.hr("presentHr", present_hr);
            // The clear was already submitted even if Present reports occlusion.
            // Fence it before rejecting that presentation and tearing down resources.
            wait_for_frame(frame);
            // An occluded/status-only presentation is not counted as a real completed frame.
            if (present_hr != S_OK) throw failed_step("Present did not return S_OK", present_hr);
        }

        void query(json_object &report)
        {
            json_object queries;
            const UINT index_before = chain->GetCurrentBackBufferIndex();
            queries.set("currentBufferIndexBefore", std::to_string(index_before));
            ComPtr<ID3D12Resource> current_buffer;
            const HRESULT buffer_hr = chain->GetBuffer(index_before, IID_PPV_ARGS(&current_buffer));
            queries.hr("getCurrentBufferHr", buffer_hr);
            check(buffer_hr, "GetBuffer(query ground truth)");
            queries.set("knownQueue", inspect_queue(queue.Get(), queue.Get(), device.Get()).str());

            ComPtr<ID3D12Device> returned_device;
            const HRESULT device_hr = chain->GetDevice(IID_PPV_ARGS(&returned_device));
            queries.hr("chainGetDeviceID3D12DeviceHr", device_hr);
            queries.set("chainKnownDeviceIdentity", identity_comparison(SUCCEEDED(device_hr) ? returned_device.Get() : nullptr, device.Get()).str());

            ComPtr<ID3D12CommandQueue> returned_queue;
            const HRESULT queue_hr = chain->GetDevice(IID_PPV_ARGS(&returned_queue));
            queries.hr("chainGetDeviceID3D12CommandQueueHr", queue_hr);
            queries.flag("chainGetDeviceQueueReturnedNonNull", returned_queue != nullptr);
            queries.set("chainGetDeviceQueue", inspect_queue(SUCCEEDED(queue_hr) ? returned_queue.Get() : nullptr, queue.Get(), device.Get()).str());

            ComPtr<ID3D12SwapChainAssistant> chain_assistant;
            const HRESULT chain_hr = chain.As(&chain_assistant);
            json_object chain_result = inspect_assistant(SUCCEEDED(chain_hr) ? chain_assistant.Get() : nullptr,
                chain.Get(), current_buffer.Get(), queue.Get(), device.Get());
            chain_result.hr("queryInterfaceHr", chain_hr);
            queries.set("chainAssistant", chain_result.str());

            ComPtr<ID3D12SwapChainAssistant> buffer_assistant;
            const HRESULT resource_hr = current_buffer.As(&buffer_assistant);
            json_object buffer_result = inspect_assistant(SUCCEEDED(resource_hr) ? buffer_assistant.Get() : nullptr,
                chain.Get(), current_buffer.Get(), queue.Get(), device.Get());
            buffer_result.hr("queryInterfaceHr", resource_hr);
            queries.set("currentBufferAssistant", buffer_result.str());
            const UINT index_after = chain->GetCurrentBackBufferIndex();
            queries.set("currentBufferIndexAfter", std::to_string(index_after));
            queries.flag("currentBufferIndexStableDuringQueries", index_before == index_after);
            report.set("queries", queries.str());
        }
    };
}

int wmain(int argc, wchar_t **argv)
{
    fs::path report_path;
    bool warp = false;
    UINT requested_frames = 60;
    for (int i = 1; i < argc; ++i)
    {
        const std::wstring argument = argv[i];
        if (argument == L"--report" && i + 1 < argc) report_path = argv[++i];
        else if (argument == L"--warp") warp = true;
        else if (argument == L"--frames" && i + 1 < argc)
        {
            try
            {
                const std::wstring value = argv[++i];
                size_t parsed = 0;
                const unsigned long count = std::stoul(value, &parsed);
                if (parsed != value.size() || count < 60 || count > 3600) throw std::out_of_range("frames");
                requested_frames = static_cast<UINT>(count);
            }
            catch (...) { std::cerr << "--frames requires an integer from 60 to 3600\n"; return 2; }
        }
        else
        {
            std::cerr << "Usage: late_d3d12_queue_query_host --report <absolute new JSON path beside this executable> [--warp] [--frames 60..3600]\n";
            return argument == L"--help" ? 0 : 2;
        }
    }

    json_object report;
    win_handle report_file;
    try
    {
        const fs::path executable = executable_path();
        if (!report_path.is_absolute() || report_path.filename().empty() ||
            fs::canonical(report_path.parent_path()) != executable.parent_path())
            throw std::runtime_error("--report must be an absolute new file in this owned executable's directory");
        report_path = executable.parent_path() / report_path.filename();
        report_file.value = CreateFileW(report_path.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
            nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (report_file.value == INVALID_HANDLE_VALUE)
            throw failed_step("CreateFileW(report, CREATE_NEW)", HRESULT_FROM_WIN32(GetLastError()));
        report.set("schemaVersion", "1");
        report.text("scope", "controlled-public-COM-capability-probe");
        report.text("executablePath", utf8(executable.wstring()));
        report.text("reportPath", utf8(report_path.wstring()));
        report.text("architecture", sizeof(void *) == 8 ? "x64" : "Win32");
        report.flag("fixtureLoadsReShade", false);
        report.flag("fixtureInstallsHooks", false);
        report.flag("callsInsertImplicitSync", false);
        report.set("requestedFramesBeforeQueries", std::to_string(requested_frames));
    }
    catch (const std::exception &error)
    {
        std::cerr << "Report setup failed: " << error.what() << '\n';
        return 2;
    }

    int exit_code = 0;
    UINT completed_frames = 0;
    std::vector<std::string> frames;
    graphics_host host;
    try
    {
        host.initialize(warp, report);
        for (UINT i = 0; i < requested_frames; ++i)
        {
            MSG message;
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
            {
                if (message.message == WM_QUIT) throw failed_step("Window closed before queries", E_ABORT);
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            json_object frame;
            frame.set("frame", std::to_string(i + 1));
            try { host.render(i, frame); }
            catch (...) { frames.push_back(frame.str()); throw; }
            frames.push_back(frame.str());
            ++completed_frames;
        }
        host.query(report);
        report.flag("probeCompleted", true);
        report.text("interpretation", "HRESULTs and known-identity comparisons describe only this exact run; unsupported queries are a completed probe, not a runtime failure or a universal support claim.");
    }
    catch (const failed_step &error)
    {
        report.flag("probeCompleted", false);
        report.text("failedStep", error.what());
        report.hr("failureHr", error.result);
        exit_code = 1;
    }
    catch (const std::exception &error)
    {
        report.flag("probeCompleted", false);
        report.text("failedStep", error.what());
        exit_code = 1;
    }
    report.set("completedFramesBeforeQueries", std::to_string(completed_frames));
    report.set("frames", json_array(frames));
    json_object modules;
    modules.text("d3d12", module_path(L"d3d12.dll"));
    modules.text("d3d12core", module_path(L"d3d12core.dll"));
    modules.text("dxgi", module_path(L"dxgi.dll"));
    report.set("graphicsModulePaths", modules.str());
    const std::string payload = report.str() + "\n";
    DWORD written = 0;
    if (!WriteFile(report_file.value, payload.data(), static_cast<DWORD>(payload.size()), &written, nullptr) ||
        written != payload.size() || !FlushFileBuffers(report_file.value))
    {
        std::cerr << "Could not write complete report\n";
        return 3;
    }
    std::cout << "Report: " << utf8(report_path.wstring()) << "\nCompleted frames: " << completed_frames
        << "\nProbe completed: " << (exit_code == 0 ? "true" : "false") << '\n';
    return exit_code;
}
