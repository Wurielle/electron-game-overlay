// Console-only actual-ReShade regression. No HWND, swap chain, private host
// layouts, GPU fault injection, or game-directory mutation is used.
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <reshade_api_device.hpp>
#include <reshade_events.hpp>
#include "../../src/ego_initial_texture_upload.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace api = reshade::api;
namespace fs = std::filesystem;

namespace
{
constexpr std::uint32_t width = 67, height = 3, source_stride = 280;
constexpr std::uint32_t row_bytes = width * 4;
constexpr std::uint32_t readback_pitch = (row_bytes + 255u) & ~255u;
constexpr GUID device_marker = {0x602578f9, 0x6a9f, 0x48a4, {0x9b, 0xa9, 0xa8, 0x32, 0x6c, 0x05, 0x53, 0xe5}};
constexpr GUID queue_marker = {0x8a2ff434, 0x18df, 0x4660, {0xb4, 0xa8, 0x1a, 0xa7, 0x76, 0xc2, 0xb5, 0x0c}};
constexpr std::uint64_t device_value = 0xbef841e3927a6641ull;
constexpr std::uint64_t queue_a_value = 0xa71883988a0d59d1ull;
constexpr std::uint64_t queue_b_value = 0xb6394f977038aca2ull;

std::mutex observed_mutex;
std::vector<api::device *> observed_devices;
std::vector<api::command_queue *> observed_queues;

void on_init_device(api::device *device)
{
    const std::scoped_lock lock(observed_mutex);
    observed_devices.push_back(device);
}
void on_init_queue(api::command_queue *queue)
{
    const std::scoped_lock lock(observed_mutex);
    observed_queues.push_back(queue);
}

void require(bool condition, const char *message)
{
    if (!condition) throw std::runtime_error(message);
}
void check(HRESULT result, const char *phase)
{
    if (FAILED(result))
    {
        std::ostringstream message;
        message << phase << ": HRESULT=0x" << std::hex << std::setw(8)
                << std::setfill('0') << static_cast<std::uint32_t>(result);
        throw std::runtime_error(message.str());
    }
}
std::string utf8(const std::wstring &value)
{
    if (value.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    require(count > 0, "UTF-8 path conversion failed");
    std::string result(static_cast<std::size_t>(count), '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), count, nullptr, nullptr) == count,
        "UTF-8 path conversion failed");
    return result;
}
std::string quoted(const std::string &value)
{
    std::ostringstream out;
    out << '"';
    for (unsigned char c : value)
    {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 0x20) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c) << std::dec;
        else out << c;
    }
    out << '"';
    return out.str();
}
struct report
{
    std::map<std::string, std::string> values;
    void text(const std::string &key, const std::string &value) { values[key] = quoted(value); }
    void number(const std::string &key, std::uint64_t value) { values[key] = std::to_string(value); }
    void flag(const std::string &key, bool value) { values[key] = value ? "true" : "false"; }
    void write(const fs::path &file) const
    {
        std::ofstream out(file, std::ios::binary | std::ios::trunc);
        require(out.good(), "Cannot open the owned evidence report");
        out << "{\n";
        bool first = true;
        for (const auto &[key, value] : values)
        {
            if (!first) out << ",\n";
            first = false;
            out << "  " << quoted(key) << ": " << value;
        }
        out << "\n}\n";
        out.flush();
        require(out.good(), "Cannot flush the owned evidence report");
    }
};

struct options
{
    fs::path runtime, report_file;
    bool legacy = false, warp = false;
};
options parse(int argc, wchar_t **argv)
{
    options result;
    for (int i = 1; i < argc; ++i)
    {
        const std::wstring argument = argv[i];
        if (argument == L"--legacy-device-upload") result.legacy = true;
        else if (argument == L"--warp") result.warp = true;
        else if (argument == L"--runtime" && i + 1 < argc && result.runtime.empty()) result.runtime = argv[++i];
        else if (argument == L"--report" && i + 1 < argc && result.report_file.empty()) result.report_file = argv[++i];
        else throw std::runtime_error("Unknown, duplicate, or incomplete fixture option");
    }
    require(result.runtime.is_absolute() && result.report_file.is_absolute(), "Absolute runtime/report paths are required");
    result.runtime = fs::canonical(result.runtime);
    require(fs::is_regular_file(result.runtime), "The owned staged runtime is not a regular file");
    require(fs::is_directory(result.report_file.parent_path()), "The owned report directory does not exist");
    return result;
}

struct watchdog
{
    HANDLE cancel = nullptr;
    ComPtr<ID3D12Fence> gate;
    std::atomic<bool> released{false};
    std::atomic<HRESULT> release_result{S_FALSE};
    std::thread worker;
    explicit watchdog(ID3D12Fence *fence) : gate(fence)
    {
        cancel = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        require(cancel != nullptr, "Cannot create watchdog cancellation event");
        worker = std::thread([this] {
            if (WaitForSingleObject(cancel, 3000) == WAIT_TIMEOUT)
            {
                released.store(true, std::memory_order_release);
                release_result.store(gate->Signal(1), std::memory_order_release);
            }
        });
    }
    void stop()
    {
        if (worker.joinable()) { SetEvent(cancel); worker.join(); }
    }
    ~watchdog()
    {
        stop();
        // Even an assertion failure must unblock the fixture-owned queue.
        gate->Signal(1);
        if (cancel != nullptr) CloseHandle(cancel);
    }
};

std::uint64_t read_marker(ID3D12Object *object, REFGUID guid)
{
    std::uint64_t value = 0;
    UINT length = sizeof(value);
    check(object->GetPrivateData(guid, &length, &value), "Read native identity marker");
    require(length == sizeof(value), "Native identity marker changed size");
    return value;
}

struct api_resources
{
    api::device *device = nullptr;
    api::command_queue *queue = nullptr;
    api::resource texture{}, readback{};
    ~api_resources()
    {
        if (queue != nullptr && (texture.handle != 0 || readback.handle != 0)) queue->wait_idle();
        if (device != nullptr && readback.handle != 0) device->destroy_resource(readback);
        if (device != nullptr && texture.handle != 0) device->destroy_resource(texture);
    }
};
} // namespace

int wmain(int argc, wchar_t **argv)
{
    report evidence;
    fs::path report_file;
    evidence.number("schemaVersion", 1);
    evidence.text("scope", "Actual public ReShade API; console; one device/two exact graphics queues; no swapchain/game or GPU fault claim");
    evidence.flag("passed", false);
    try
    {
        const options args = parse(argc, argv);
        report_file = args.report_file;
        evidence.text("runtimePath", utf8(args.runtime.native()));
        evidence.flag("legacyDeviceUpload", args.legacy);
        evidence.flag("warpRequested", args.warp);
        evidence.number("processId", GetCurrentProcessId());
        FILETIME creation{}, exited{}, kernel{}, user{};
        require(GetProcessTimes(GetCurrentProcess(), &creation, &exited, &kernel, &user) != FALSE,
            "Cannot read exact process creation time");
        evidence.text("creationTime100ns", std::to_string((static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime));
        std::wstring image_path(32768, L'\0');
        const DWORD image_length = GetModuleFileNameW(nullptr, image_path.data(), static_cast<DWORD>(image_path.size()));
        require(image_length != 0 && image_length < image_path.size(), "Cannot read exact executable path");
        image_path.resize(image_length);
        evidence.text("executablePath", utf8(fs::canonical(image_path).native()));
        evidence.text("helperSha256", EGO_INITIAL_UPLOAD_HELPER_SHA256);
        evidence.number("width", width); evidence.number("height", height);
        evidence.number("sourceRowPitch", source_stride); evidence.number("gpuRowPitch", readback_pitch);

        HMODULE runtime = LoadLibraryExW(args.runtime.c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        require(runtime != nullptr, "Cannot load the supplied owned ReShade runtime");
        using register_addon_fn = bool (*)(void *, std::uint32_t);
        using register_event_fn = void (*)(reshade::addon_event, void *);
        const auto register_addon = reinterpret_cast<register_addon_fn>(GetProcAddress(runtime, "ReShadeRegisterAddon"));
        const auto register_event = reinterpret_cast<register_event_fn>(GetProcAddress(runtime, "ReShadeRegisterEvent"));
        require(register_addon != nullptr && register_event != nullptr, "The owned host lacks public add-on registration");
        require(register_addon(GetModuleHandleW(nullptr), 18), "Public ReShade API18 registration failed");
        register_event(reshade::addon_event::init_device, reinterpret_cast<void *>(&on_init_device));
        register_event(reshade::addon_event::init_command_queue, reinterpret_cast<void *>(&on_init_queue));

        ComPtr<IDXGIFactory4> factory;
        check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");
        ComPtr<IDXGIAdapter1> selected_adapter;
        if (args.warp) check(factory->EnumWarpAdapter(IID_PPV_ARGS(&selected_adapter)), "EnumWarpAdapter");
        ComPtr<ID3D12Device> native_device;
        check(D3D12CreateDevice(selected_adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&native_device)), "D3D12CreateDevice");
        check(native_device->SetPrivateData(device_marker, sizeof(device_value), &device_value), "Write device identity marker");
        ComPtr<IDXGIAdapter1> actual_adapter;
        check(factory->EnumAdapterByLuid(native_device->GetAdapterLuid(), IID_PPV_ARGS(&actual_adapter)), "EnumAdapterByLuid");
        DXGI_ADAPTER_DESC1 adapter_description{};
        check(actual_adapter->GetDesc1(&adapter_description), "GetDesc1");
        evidence.text("adapter", utf8(adapter_description.Description));
        evidence.flag("softwareAdapter", (adapter_description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0);
        require(args.warp || (adapter_description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0,
            "The default run requires a hardware adapter; use explicit --warp for software scope");

        D3D12_COMMAND_QUEUE_DESC desc{};
        desc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        ComPtr<ID3D12CommandQueue> native_a, native_b;
        check(native_device->CreateCommandQueue(&desc, IID_PPV_ARGS(&native_a)), "Create queue A");
        check(native_device->CreateCommandQueue(&desc, IID_PPV_ARGS(&native_b)), "Create queue B");
        check(native_a->SetPrivateData(queue_marker, sizeof(queue_a_value), &queue_a_value), "Write A identity marker");
        check(native_b->SetPrivateData(queue_marker, sizeof(queue_b_value), &queue_b_value), "Write B identity marker");

        api::device *device = nullptr;
        api::command_queue *queue_a = nullptr, *queue_b = nullptr;
        {
            const std::scoped_lock lock(observed_mutex);
            require(observed_devices.size() == 1, "Expected exactly one observed ReShade device");
            device = observed_devices.front();
            require(device->get_api() == api::device_api::d3d12, "The observed device is not D3D12");
            require(read_marker(reinterpret_cast<ID3D12Device *>(device->get_native()), device_marker) == device_value,
                "The observed device does not match the exact native device");
            require(observed_queues.size() == 2, "Expected exactly two observed ReShade queues");
            for (api::command_queue *queue : observed_queues)
            {
                require(queue->get_device() == device, "A callback queue belongs to another device");
                auto *raw = reinterpret_cast<ID3D12CommandQueue *>(queue->get_native());
                const auto marker = read_marker(raw, queue_marker);
                if (marker == queue_a_value) { require(queue_a == nullptr, "Duplicate A callback"); queue_a = queue; }
                else if (marker == queue_b_value) { require(queue_b == nullptr, "Duplicate B callback"); queue_b = queue; }
                else throw std::runtime_error("A callback queue has no exact fixture identity");
            }
        }
        require(queue_a != nullptr && queue_b != nullptr && queue_a != queue_b, "The two exact graphics queues were not observed");
        require(device->check_capability(api::device_caps::copy_buffer_to_texture), "Buffer/texture transfer capability is missing");
        evidence.flag("exactDeviceAndQueuesVerified", true);

        ComPtr<ID3D12Fence> gate, completion;
        check(native_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&gate)), "Create gate fence");
        check(native_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&completion)), "Create B completion fence");
        api_resources resources;
        resources.device = device; resources.queue = queue_a;
        // Establish the bounded release before any queue can become blocked.
        // Its destructor unblocks B before the resource guard can wait on A.
        watchdog watchdog_release(gate.Get());
        queue_b->flush_immediate_command_list(); // Deliberately prime ReShade's device-level TLS selector with B.
        check(native_b->Wait(gate.Get(), 1), "Block fixture-owned queue B");
        check(native_b->Signal(completion.Get(), 1), "Queue B completion marker");
        require(completion->GetCompletedValue() == 0, "Queue B was not blocked before upload");
        evidence.flag("foreignQueueInitiallyBlocked", true);

        std::array<std::uint8_t, source_stride * height> source;
        source.fill(0xa5);
        for (std::uint32_t y = 0; y < height; ++y)
            for (std::uint32_t x = 0; x < width; ++x)
            {
                const auto offset = y * source_stride + x * 4;
                source[offset] = static_cast<std::uint8_t>(17 + x * 3 + y);
                source[offset + 1] = static_cast<std::uint8_t>(29 + x + y * 61);
                source[offset + 2] = static_cast<std::uint8_t>(73 + x * 2 + y * 19);
                source[offset + 3] = static_cast<std::uint8_t>(255 - y);
            }
        const auto started = std::chrono::steady_clock::now();
        const api::resource_desc texture_desc(width, height, 1, 1, api::format::r8g8b8a8_unorm,
            1, api::memory_heap::gpu_only, api::resource_usage::shader_resource | api::resource_usage::copy_dest | api::resource_usage::copy_source);
        if (args.legacy)
        {
            const api::subresource_data initial{source.data(), source_stride, static_cast<std::uint32_t>(source.size())};
            require(device->create_resource(texture_desc, &initial, api::resource_usage::shader_resource, &resources.texture),
                "Legacy device-level initial upload failed");
        }
        else
        {
            require(device->create_resource(texture_desc, nullptr, api::resource_usage::copy_dest, &resources.texture),
                "Texture allocation without device-level initial upload failed");
            const api::subresource_data pixels{source.data(), source_stride, static_cast<std::uint32_t>(source.size())};
            require(ego::initial_texture_upload::upload_d3d12_rgba(device, queue_a, resources.texture,
                pixels, width, height), "Production exact-queue upload helper failed");
        }
        const auto upload_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
        evidence.number("uploadMilliseconds", static_cast<std::uint64_t>(upload_ms));
        evidence.flag("watchdogReleasedDuringUpload", watchdog_release.released.load(std::memory_order_acquire));

        require(device->create_resource(api::resource_desc(readback_pitch * height, api::memory_heap::gpu_to_cpu,
            api::resource_usage::copy_dest), nullptr, api::resource_usage::copy_dest, &resources.readback), "Readback allocation failed");
        api::command_list *commands = queue_a->get_immediate_command_list();
        require(commands != nullptr, "Queue A immediate command list is unavailable");
        commands->barrier(resources.texture, api::resource_usage::shader_resource, api::resource_usage::copy_source);
        commands->copy_texture_to_buffer(resources.texture, 0, nullptr, resources.readback, 0, width, height);
        commands->barrier(resources.texture, api::resource_usage::copy_source, api::resource_usage::shader_resource);
        queue_a->wait_idle();
        void *mapped = nullptr;
        require(device->map_buffer_region(resources.readback, 0, readback_pitch * height, api::map_access::read_only, &mapped), "Readback map failed");
        bool matches = mapped != nullptr;
        if (mapped != nullptr)
            for (std::uint32_t y = 0; y < height; ++y)
                matches = matches && std::memcmp(static_cast<const std::uint8_t *>(mapped) + y * readback_pitch,
                    source.data() + y * source_stride, row_bytes) == 0;
        device->unmap_buffer_region(resources.readback);
        require(matches, "Actual GPU readback differs from source pixels");
        evidence.flag("allGpuPixelsMatch", true);
        evidence.flag("pixelsMatch", true);
        const bool released = watchdog_release.released.load(std::memory_order_acquire);
        const auto foreign_completed = completion->GetCompletedValue();
        evidence.flag("watchdogReleasedGate", released);
        evidence.flag("uploadCompletedWhileForeignQueueBlocked", !released && foreign_completed == 0);
        evidence.number("foreignCompletionBeforeExplicitRelease", foreign_completed);
        if (args.legacy)
        {
            require(released && upload_ms >= 2500 && foreign_completed == 1,
                "The legacy negative control did not expose the blocked foreign queue");
            check(watchdog_release.release_result.load(std::memory_order_acquire), "Watchdog gate release");
            evidence.flag("negativeControlDetected", true);
        }
        else
        {
            require(!released && foreign_completed == 0,
                "The production upload depended on or waited for the blocked foreign queue");
            evidence.flag("completedWhileForeignQueueBlocked", true);
            evidence.flag("negativeControlDetected", false);
        }
        watchdog_release.stop();
        check(gate->Signal(1), "Release fixture-owned gate");
        queue_b->wait_idle();
        check(native_device->GetDeviceRemovedReason(), "Final D3D12 device health");
        evidence.flag("deviceHealthy", true);
        evidence.flag("completed", true);
        evidence.flag("passed", true);
        evidence.write(report_file);
        std::cout << "D3D12_INITIAL_UPLOAD_QUEUE_PASS " << utf8(report_file.native()) << '\n';
        return 0;
    }
    catch (const std::exception &error)
    {
        evidence.text("error", error.what());
        if (!report_file.empty()) { try { evidence.write(report_file); } catch (...) {} }
        std::cerr << error.what() << '\n';
        return 1;
    }
}
