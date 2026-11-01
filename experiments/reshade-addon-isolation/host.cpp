#include <Windows.h>
#include <Psapi.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
using counter = std::uint64_t (*)();

namespace
{
void require(bool condition, const char *message)
{
    if (!condition)
        throw std::runtime_error(message);
}

HMODULE load(const std::filesystem::path &path)
{
    return LoadLibraryExW(path.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
}

counter read_counter(HMODULE module, const char *name)
{
    auto result = reinterpret_cast<counter>(GetProcAddress(module, name));
    require(result != nullptr, "Probe counter export missing");
    return result;
}

bool initialize_addon(HMODULE addon, HMODULE runtime)
{
    using initialize = bool (*)(HMODULE, HMODULE);
    auto function = reinterpret_cast<initialize>(GetProcAddress(addon, "AddonInit"));
    require(function != nullptr, "Public AddonInit export missing");
    return function(addon, runtime);
}

unsigned runtime_count()
{
    HMODULE modules[1024];
    DWORD bytes = 0;
    require(K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &bytes) &&
        bytes <= sizeof(modules), "Could not enumerate complete module set");
    unsigned count = 0;
    for (DWORD i = 0; i < bytes / sizeof(HMODULE); ++i)
        if (GetProcAddress(modules[i], "ReShadeVersion"))
            ++count;
    return count;
}
}

int wmain(int argc, wchar_t **argv)
{
    try
    {
        require(argc == 2 && (std::wstring(argv[1]) == L"a-first" ||
            std::wstring(argv[1]) == L"b-first"), "Expected a-first or b-first");
        const bool a_first = std::wstring(argv[1]) == L"a-first";
        wchar_t executable[MAX_PATH];
        const auto executable_length = GetModuleFileNameW(nullptr, executable, MAX_PATH);
        require(executable_length != 0 && executable_length < MAX_PATH,
            "Could not resolve controlled host path");
        const auto directory = std::filesystem::path(executable).parent_path();
        HMODULE runtime = GetModuleHandleW(L"d3d11.dll");
        require(runtime != nullptr, "Could not load supplied official full-add-on runtime");
        require(GetProcAddress(runtime, "ElectronGameOverlayReShadeHostAbi") == nullptr,
            "Expected an official runtime without EGO's private host extension");
        require(GetProcAddress(runtime, "ReShadeVersion") != nullptr &&
            GetProcAddress(runtime, "ReShadeRegisterAddon") != nullptr,
            "Supplied DLL is not a full-add-on ReShade runtime");
        wchar_t runtime_path[MAX_PATH]{};
        const auto runtime_path_length = GetModuleFileNameW(runtime, runtime_path, MAX_PATH);
        require(runtime_path_length != 0 && runtime_path_length < MAX_PATH &&
            std::filesystem::equivalent(runtime_path, directory / L"d3d11.dll"),
            "ReShade proxy was not loaded from the controlled stage");
        const auto version = reinterpret_cast<const char *const *>(GetProcAddress(runtime, "ReShadeVersion"));
        require(*version != nullptr && std::strcmp(*version, "6.7.3") == 0,
            "This probe was designed for official ReShade 6.7.3");
        HMODULE early = load(directory / (a_first ? L"probe_a.dll" : L"probe_b.dll"));
        require(early != nullptr && initialize_addon(early, runtime), "Startup add-on registration failed");
        const auto early_frames = read_counter(early, "ProbeFrames");
        const auto early_inits = read_counter(early, "ProbeSwapchainInits");

        const wchar_t *class_name = L"EGOReShadeAddonIsolationProbe";
        WNDCLASSW window_class{};
        window_class.lpfnWndProc = DefWindowProcW;
        window_class.hInstance = GetModuleHandleW(nullptr);
        window_class.lpszClassName = class_name;
        require(RegisterClassW(&window_class) != 0, "Window class registration failed");
        HWND window = CreateWindowExW(0, class_name, L"ReShade add-on isolation research probe",
            WS_OVERLAPPEDWINDOW, 0, 0, 640, 480, nullptr, nullptr, window_class.hInstance, nullptr);
        require(window != nullptr, "Controlled window creation failed");

        DXGI_SWAP_CHAIN_DESC desc{};
        desc.BufferDesc.Width = 640;
        desc.BufferDesc.Height = 480;
        desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        desc.BufferCount = 2;
        desc.OutputWindow = window;
        desc.Windowed = TRUE;
        desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        ComPtr<IDXGISwapChain> swapchain;
        D3D_FEATURE_LEVEL level;
        const auto created = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
            D3D11_SDK_VERSION, &desc, &swapchain, &device, &level, &context);
        require(SUCCEEDED(created), "Controlled D3D11 device creation failed");
        ComPtr<ID3D11Texture2D> backbuffer;
        ComPtr<ID3D11RenderTargetView> target;
        require(SUCCEEDED(swapchain->GetBuffer(0, IID_PPV_ARGS(&backbuffer))) &&
            SUCCEEDED(device->CreateRenderTargetView(backbuffer.Get(), nullptr, &target)),
            "Controlled render target creation failed");
        const auto present_frames = [&]() {
            for (int i = 0; i != 8; ++i)
            {
                MSG message;
                while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
                {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                const float color[] = {0.04f, 0.08f, 0.16f, 1.0f};
                context->ClearRenderTargetView(target.Get(), color);
                require(SUCCEEDED(swapchain->Present(0, 0)), "Controlled Present failed");
            }
        };
        present_frames();
        require(early_frames() > 0 && early_inits() > 0,
            "Startup add-on did not receive frame and swapchain initialization callbacks");
        const auto startup_frames = early_frames();
        const auto startup_inits = early_inits();

        HMODULE late = load(directory / (a_first ? L"probe_b.dll" : L"probe_a.dll"));
        require(late != nullptr && late != early && initialize_addon(late, runtime), "Late add-on registration failed");
        const auto late_frames = read_counter(late, "ProbeFrames");
        const auto late_inits = read_counter(late, "ProbeSwapchainInits");
        present_frames();
        require(early_frames() > startup_frames && late_frames() > 0,
            "Both independent add-ons must receive future frame callbacks");
        require(late_inits() == 0, "Late registration unexpectedly replayed swapchain initialization");
        const auto concurrent_early_frames = early_frames();
        const auto concurrent_late_frames = late_frames();

        HMODULE duplicate = load(directory / L"probe_duplicate.dll");
        require(duplicate != nullptr && duplicate != early && duplicate != late,
            "Duplicate-name fixture did not map as an independent module");
        require(!initialize_addon(duplicate, runtime), "Duplicate exported add-on NAME was unexpectedly accepted");
        require(FreeLibrary(duplicate) != FALSE, "Could not unload rejected duplicate fixture");
        HMODULE second_runtime = load(directory / L"second-runtime.dll");
        const DWORD second_error = second_runtime ? ERROR_SUCCESS : GetLastError();
        require(second_runtime == nullptr, "Second runtime copy was unexpectedly accepted");
        require(runtime_count() == 1, "Expected exactly one mapped ReShade runtime");

        // All loading/unloading occurs on the only rendering thread between Presents.
        // This deliberately does not claim arbitrary concurrent hot-unload safety.
        require(FreeLibrary(early) != FALSE, "Could not unload the startup add-on");
        require(GetModuleHandleW(a_first ? L"probe_a.dll" : L"probe_b.dll") == nullptr,
            "Startup add-on remained mapped after explicit unload");
        present_frames();
        const auto survivor_frames = late_frames();
        require(survivor_frames > concurrent_late_frames,
            "Surviving add-on stopped after peer unloaded");
        require(runtime_count() == 1, "Peer unload changed runtime ownership");
        std::printf("{\"schemaVersion\":1,\"order\":\"%s\",\"runtimeVersion\":\"6.7.3\",\"runtimeCount\":1,"
            "\"startupFrames\":%llu,\"startupSwapchainInits\":%llu,"
            "\"concurrentEarlyFrames\":%llu,\"concurrentLateFrames\":%llu,"
            "\"lateSwapchainInits\":%llu,\"survivorFrames\":%llu,"
            "\"duplicateNameRegistrationRejected\":true,\"secondRuntimeWin32Error\":%lu}\n",
            a_first ? "a-first" : "b-first", startup_frames, startup_inits,
            concurrent_early_frames, concurrent_late_frames, late_inits(), survivor_frames,
            second_error);
        require(FreeLibrary(late) != FALSE, "Could not unload late add-on");
        target.Reset();
        backbuffer.Reset();
        swapchain.Reset();
        context.Reset();
        device.Reset();
        DestroyWindow(window);
        // Keep ReShade mapped until process exit; no runtime hot-unload is tested.
        return 0;
    }
    catch (const std::exception &error)
    {
        std::fprintf(stderr, "Research probe failed: %s (Win32 %lu)\n", error.what(), GetLastError());
        return 1;
    }
}
