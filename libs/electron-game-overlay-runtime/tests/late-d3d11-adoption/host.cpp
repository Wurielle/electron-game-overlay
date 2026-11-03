#include <Windows.h>
#include <shellapi.h>
#include <psapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#include "reshade_api.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

constexpr wchar_t window_class[] = L"EgoGenuineLateD3D11Adoption";
constexpr wchar_t window_title[] = L"EGO genuine late D3D11 adoption prototype";
constexpr std::uint64_t startup_timeout_ms = 60'000;

struct options
{
    fs::path stage_directory;
    fs::path reshade;
    fs::path addon;
    fs::path config;
    fs::path report;
    std::uint64_t frames_before_load = 60;
    std::uint64_t resize_after_frames = 120;
    std::uint64_t lifetime_ms = 20'000;
};

struct evidence
{
    std::string phase = "starting";
    std::string status = "running";
    std::string failure;
    std::uint64_t started_at = GetTickCount64();
    std::uint64_t loaded_at = 0;
    std::uint64_t frames_before_load = 0;
    std::uint64_t frames_after_load = 0;
    std::uint64_t frames_after_resize = 0;
    std::uint64_t render_calls = 0;
    std::uint64_t native_present_calls = 0;
    std::uint64_t state_checks = 0;
    std::uint64_t state_mismatches = 0;
    std::uint32_t create_attempts = 0;
    std::uint32_t create_successes = 0;
    std::uint32_t destroy_calls = 0;
    std::uint32_t resize_attempts = 0;
    std::uint32_t resize_successes = 0;
    DWORD reshade_load_error = ERROR_SUCCESS;
    DWORD addon_load_error = ERROR_SUCCESS;
    DWORD member_initialize_result = ERROR_NOT_READY;
    HRESULT last_resize_result = S_FALSE;
    HRESULT last_present_result = S_FALSE;
    D3D_FEATURE_LEVEL feature_level = D3D_FEATURE_LEVEL_9_1;
    bool used_warp = false;
    bool preexisting_runtime = false;
    bool automatic_resize_requested = false;
    bool automatic_resize_completed = false;
    bool manual_destroyed_before_graphics = false;
    std::uint64_t key_down_messages = 0;
    std::uint64_t character_messages = 0;
    std::uint64_t pointer_down_messages = 0;
};

using create_runtime_fn = bool (*)(reshade::api::device_api, void *, void *, void *,
                                  const char *, reshade::api::effect_runtime **);
using destroy_runtime_fn = void (*)(reshade::api::effect_runtime *);
using update_runtime_fn = void (*)(reshade::api::effect_runtime *);
using initialize_member_fn = DWORD(WINAPI *)(void *);

struct graphics
{
    HWND window = nullptr;
    UINT pending_width = 0;
    UINT pending_height = 0;
    UINT width = 800;
    UINT height = 600;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain> swapchain;
    ComPtr<ID3D11RenderTargetView> target;
    ComPtr<ID3D11RasterizerState> rasterizer;
    ComPtr<ID3D11BlendState> blend;
    ComPtr<ID3D11DepthStencilState> depth_stencil;
    HMODULE reshade_module = nullptr;
    HMODULE addon_module = nullptr;
    create_runtime_fn create_runtime = nullptr;
    destroy_runtime_fn destroy_runtime = nullptr;
    update_runtime_fn update_runtime = nullptr;
    reshade::api::effect_runtime *runtime = nullptr;
};

options g_options;
evidence g_evidence;
graphics g_graphics;
bool g_paths_validated = false;

std::string utf8(const std::wstring &value)
{
    if (value.empty())
        return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
        value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (count <= 0)
        throw std::runtime_error("Invalid UTF-16 path.");
    std::string result(static_cast<std::size_t>(count), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), result.data(), count, nullptr, nullptr) != count)
        throw std::runtime_error("Cannot encode path as UTF-8.");
    return result;
}

std::string json_string(const std::string &value)
{
    std::string result = "\"";
    for (const unsigned char character : value)
    {
        switch (character)
        {
        case '\\': result += "\\\\"; break;
        case '"': result += "\\\""; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default:
            if (character < 0x20)
            {
                char escaped[7] = {};
                sprintf_s(escaped, "\\u%04x", character);
                result += escaped;
            }
            else
                result += static_cast<char>(character);
        }
    }
    return result + '"';
}

void publish_message(const std::string &message)
{
    const std::string line = message + '\n';
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output != nullptr && output != INVALID_HANDLE_VALUE)
    {
        DWORD written = 0;
        static_cast<void>(WriteFile(output, line.data(),
            static_cast<DWORD>(line.size()), &written, nullptr));
    }
    OutputDebugStringA(line.c_str());
}

bool write_report()
{
    if (!g_paths_validated || g_options.report.empty())
        return false;
    std::ostringstream report;
    report << "{\n"
        << "  \"schemaVersion\": 1,\n"
        << "  \"fixture\": \"host-assisted-late-d3d11-adoption\",\n"
        << "  \"automaticDiscoveryProven\": false,\n"
        << "  \"renderedOverlayPixelsProven\": false,\n"
        << "  \"pid\": " << GetCurrentProcessId() << ",\n"
        << "  \"windowHandle\": " << json_string(std::to_string(
            reinterpret_cast<std::uintptr_t>(g_graphics.window))) << ",\n"
        << "  \"phase\": " << json_string(g_evidence.phase) << ",\n"
        << "  \"status\": " << json_string(g_evidence.status) << ",\n"
        << "  \"failure\": " << json_string(g_evidence.failure) << ",\n"
        << "  \"elapsedMs\": " << GetTickCount64() - g_evidence.started_at << ",\n"
        << "  \"elapsedAfterLoadMs\": " << (g_evidence.loaded_at == 0 ? 0 :
            GetTickCount64() - g_evidence.loaded_at) << ",\n"
        << "  \"requiredFramesBeforeLoad\": " << g_options.frames_before_load << ",\n"
        << "  \"resizeAfterFrames\": " << g_options.resize_after_frames << ",\n"
        << "  \"requestedLifetimeMs\": " << g_options.lifetime_ms << ",\n"
        << "  \"framesBeforeLoad\": " << g_evidence.frames_before_load << ",\n"
        << "  \"framesAfterLoad\": " << g_evidence.frames_after_load << ",\n"
        << "  \"framesAfterResize\": " << g_evidence.frames_after_resize << ",\n"
        << "  \"manualRenderCalls\": " << g_evidence.render_calls << ",\n"
        << "  \"nativePresentCalls\": " << g_evidence.native_present_calls << ",\n"
        << "  \"stateChecks\": " << g_evidence.state_checks << ",\n"
        << "  \"stateMismatches\": " << g_evidence.state_mismatches << ",\n"
        << "  \"manualCreateAttempts\": " << g_evidence.create_attempts << ",\n"
        << "  \"manualCreateSuccesses\": " << g_evidence.create_successes << ",\n"
        << "  \"manualDestroyCalls\": " << g_evidence.destroy_calls << ",\n"
        << "  \"resizeAttempts\": " << g_evidence.resize_attempts << ",\n"
        << "  \"resizeSuccesses\": " << g_evidence.resize_successes << ",\n"
        << "  \"lastResizeHresult\": " << static_cast<std::uint32_t>(g_evidence.last_resize_result) << ",\n"
        << "  \"lastPresentHresult\": " << static_cast<std::uint32_t>(g_evidence.last_present_result) << ",\n"
        << "  \"reshadeLoadError\": " << g_evidence.reshade_load_error << ",\n"
        << "  \"addonLoadError\": " << g_evidence.addon_load_error << ",\n"
        << "  \"memberInitializeResult\": " << g_evidence.member_initialize_result << ",\n"
        << "  \"featureLevel\": " << static_cast<std::uint32_t>(g_evidence.feature_level) << ",\n"
        << "  \"usedWarp\": " << (g_evidence.used_warp ? "true" : "false") << ",\n"
        << "  \"preexistingRuntime\": " << (g_evidence.preexisting_runtime ? "true" : "false") << ",\n"
        << "  \"automaticResizeRequested\": " << (g_evidence.automatic_resize_requested ? "true" : "false") << ",\n"
        << "  \"automaticResizeCompleted\": " << (g_evidence.automatic_resize_completed ? "true" : "false") << ",\n"
        << "  \"manualDestroyedBeforeGraphics\": " << (g_evidence.manual_destroyed_before_graphics ? "true" : "false") << ",\n"
        << "  \"keyDownMessages\": " << g_evidence.key_down_messages << ",\n"
        << "  \"characterMessages\": " << g_evidence.character_messages << ",\n"
        << "  \"pointerDownMessages\": " << g_evidence.pointer_down_messages << ",\n"
        << "  \"reshadePath\": " << json_string(utf8(g_options.reshade.native())) << ",\n"
        << "  \"addonPath\": " << json_string(utf8(g_options.addon.native())) << ",\n"
        << "  \"configPath\": " << json_string(utf8(g_options.config.native())) << "\n"
        << "}\n";

    fs::path temporary = g_options.report;
    temporary += L".tmp." + std::to_wstring(GetCurrentProcessId());
    const HANDLE output = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (output == INVALID_HANDLE_VALUE)
        return false;
    const std::string content = report.str();
    DWORD written = 0;
    const bool complete = WriteFile(output, content.data(),
        static_cast<DWORD>(content.size()), &written, nullptr) != FALSE &&
        written == content.size();
    const bool closed = CloseHandle(output) != FALSE;
    if (!complete || !closed)
    {
        static_cast<void>(DeleteFileW(temporary.c_str()));
        return false;
    }
    if (MoveFileExW(temporary.c_str(), g_options.report.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE)
        return true;
    static_cast<void>(DeleteFileW(temporary.c_str()));
    return false;
}

bool fail(const std::string &reason)
{
    if (g_evidence.failure.empty())
        g_evidence.failure = reason;
    g_evidence.status = "failed";
    publish_message("EGO_LATE_D3D11_FAILED " + reason);
    static_cast<void>(write_report());
    return false;
}

bool path_within(const fs::path &path, const fs::path &directory)
{
    std::wstring prefix = directory.native();
    while (prefix.size() > 3 && (prefix.back() == L'\\' || prefix.back() == L'/'))
        prefix.pop_back();
    const std::wstring candidate = path.native();
    return candidate.size() > prefix.size() &&
        _wcsnicmp(candidate.c_str(), prefix.c_str(), prefix.size()) == 0 &&
        (candidate[prefix.size()] == L'\\' || candidate[prefix.size()] == L'/');
}

bool same_path(const fs::path &left, const fs::path &right)
{
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool parse_number(const std::wstring &text, std::uint64_t minimum,
                  std::uint64_t maximum, std::uint64_t &destination)
{
    if (text.empty() || text.front() == L'-' || text.front() == L'+')
        return false;
    wchar_t *end = nullptr;
    const unsigned long long value = std::wcstoull(text.c_str(), &end, 10);
    if (*end != L'\0' || value < minimum || value > maximum)
        return false;
    destination = value;
    return true;
}

bool parse_options()
{
    int count = 0;
    wchar_t **const raw = CommandLineToArgvW(GetCommandLineW(), &count);
    if (raw == nullptr)
        return false;
    std::vector<std::wstring> arguments(raw, raw + count);
    LocalFree(raw);
    for (int index = 1; index < count; ++index)
    {
        std::wstring key = arguments[static_cast<std::size_t>(index)];
        const std::size_t equals = key.find(L'=');
        std::wstring value;
        if (equals != std::wstring::npos)
        {
            value = key.substr(equals + 1);
            key.resize(equals);
        }
        else if (index + 1 < count)
            value = arguments[static_cast<std::size_t>(++index)];
        else
            return false;

        if (key == L"--stage-directory") g_options.stage_directory = value;
        else if (key == L"--reshade") g_options.reshade = value;
        else if (key == L"--addon") g_options.addon = value;
        else if (key == L"--config") g_options.config = value;
        else if (key == L"--report") g_options.report = value;
        else if (key == L"--frames-before-load")
        {
            if (!parse_number(value, 60, 100'000, g_options.frames_before_load)) return false;
        }
        else if (key == L"--resize-after-frames")
        {
            if (!parse_number(value, 1, 100'000, g_options.resize_after_frames)) return false;
        }
        else if (key == L"--lifetime-ms")
        {
            if (!parse_number(value, 1'000, 600'000, g_options.lifetime_ms)) return false;
        }
        else
            return false;
    }

    if (!g_options.stage_directory.is_absolute() || !g_options.reshade.is_absolute() ||
        !g_options.addon.is_absolute() || !g_options.config.is_absolute() ||
        !g_options.report.is_absolute())
        return false;
    g_options.stage_directory = fs::canonical(g_options.stage_directory);
    g_options.reshade = fs::canonical(g_options.reshade);
    g_options.addon = fs::canonical(g_options.addon);
    g_options.config = fs::weakly_canonical(g_options.config);
    g_options.report = fs::weakly_canonical(g_options.report);

    wchar_t executable[32'768] = {};
    const DWORD length = GetModuleFileNameW(nullptr, executable, ARRAYSIZE(executable));
    if (length == 0 || length >= ARRAYSIZE(executable))
        return false;
    const fs::path executable_directory = fs::canonical(fs::path(executable).parent_path());
    if (same_path(g_options.stage_directory, executable_directory) ||
        path_within(g_options.stage_directory, executable_directory))
        return false;
    for (const fs::path *const path : { &g_options.reshade, &g_options.addon,
                                       &g_options.config, &g_options.report })
    {
        if (!path_within(*path, g_options.stage_directory))
            return false;
    }
    fs::path temporary_report = g_options.report;
    temporary_report += L".tmp." + std::to_wstring(GetCurrentProcessId());
    const bool valid = fs::is_directory(g_options.stage_directory) &&
        fs::is_regular_file(g_options.reshade) && fs::is_regular_file(g_options.addon) &&
        fs::is_directory(g_options.config.parent_path()) &&
        fs::is_directory(g_options.report.parent_path()) &&
        !same_path(g_options.config, g_options.report) &&
        !same_path(g_options.config, g_options.reshade) &&
        !same_path(g_options.config, g_options.addon) &&
        !same_path(g_options.report, g_options.reshade) &&
        !same_path(g_options.report, g_options.addon) &&
        !same_path(temporary_report, g_options.config) &&
        !same_path(temporary_report, g_options.reshade) &&
        !same_path(temporary_report, g_options.addon);
    g_paths_validated = valid;
    return valid;
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    switch (message)
    {
    case WM_SIZE:
        if (wparam != SIZE_MINIMIZED)
        {
            g_graphics.pending_width = LOWORD(lparam);
            g_graphics.pending_height = HIWORD(lparam);
        }
        return 0;
    case WM_KEYDOWN: ++g_evidence.key_down_messages; break;
    case WM_CHAR: ++g_evidence.character_messages; break;
    case WM_LBUTTONDOWN: ++g_evidence.pointer_down_messages; break;
    case WM_CLOSE: DestroyWindow(window); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

bool create_target()
{
    ComPtr<ID3D11Texture2D> back_buffer;
    return SUCCEEDED(g_graphics.swapchain->GetBuffer(0, IID_PPV_ARGS(&back_buffer))) &&
        SUCCEEDED(g_graphics.device->CreateRenderTargetView(back_buffer.Get(), nullptr,
            &g_graphics.target));
}

bool create_graphics()
{
    RECT client = {};
    if (!GetClientRect(g_graphics.window, &client))
        return fail("GetClientRect failed.");
    g_graphics.width = static_cast<UINT>(client.right);
    g_graphics.height = static_cast<UINT>(client.bottom);
    DXGI_SWAP_CHAIN_DESC description = {};
    description.BufferDesc.Width = g_graphics.width;
    description.BufferDesc.Height = g_graphics.height;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.BufferCount = 2;
    description.OutputWindow = g_graphics.window;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    HRESULT result = E_FAIL;
    for (const D3D_DRIVER_TYPE driver : { D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP })
    {
        result = D3D11CreateDeviceAndSwapChain(nullptr, driver, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
            &description, &g_graphics.swapchain, &g_graphics.device,
            &g_evidence.feature_level, &g_graphics.context);
        if (SUCCEEDED(result))
        {
            g_evidence.used_warp = driver == D3D_DRIVER_TYPE_WARP;
            break;
        }
        g_graphics.swapchain.Reset();
        g_graphics.context.Reset();
        g_graphics.device.Reset();
    }
    if (FAILED(result) || !create_target())
        return fail("Cannot create the raw D3D11 device, swapchain, and render target.");

    D3D11_RASTERIZER_DESC rasterizer = {};
    rasterizer.FillMode = D3D11_FILL_SOLID;
    rasterizer.CullMode = D3D11_CULL_NONE;
    rasterizer.DepthClipEnable = TRUE;
    rasterizer.ScissorEnable = TRUE;
    D3D11_BLEND_DESC blend = {};
    for (auto &render_target : blend.RenderTarget)
    {
        render_target.SrcBlend = D3D11_BLEND_ONE;
        render_target.DestBlend = D3D11_BLEND_ZERO;
        render_target.BlendOp = D3D11_BLEND_OP_ADD;
        render_target.SrcBlendAlpha = D3D11_BLEND_ONE;
        render_target.DestBlendAlpha = D3D11_BLEND_ZERO;
        render_target.BlendOpAlpha = D3D11_BLEND_OP_ADD;
    }
    blend.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    D3D11_DEPTH_STENCIL_DESC depth_stencil = {};
    depth_stencil.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
    depth_stencil.DepthFunc = D3D11_COMPARISON_ALWAYS;
    depth_stencil.StencilReadMask = D3D11_DEFAULT_STENCIL_READ_MASK;
    depth_stencil.StencilWriteMask = D3D11_DEFAULT_STENCIL_WRITE_MASK;
    depth_stencil.FrontFace.StencilFailOp = D3D11_STENCIL_OP_KEEP;
    depth_stencil.FrontFace.StencilDepthFailOp = D3D11_STENCIL_OP_KEEP;
    depth_stencil.FrontFace.StencilPassOp = D3D11_STENCIL_OP_KEEP;
    depth_stencil.FrontFace.StencilFunc = D3D11_COMPARISON_ALWAYS;
    depth_stencil.BackFace = depth_stencil.FrontFace;
    if (FAILED(g_graphics.device->CreateRasterizerState(&rasterizer, &g_graphics.rasterizer)) ||
        FAILED(g_graphics.device->CreateBlendState(&blend, &g_graphics.blend)) ||
        FAILED(g_graphics.device->CreateDepthStencilState(&depth_stencil, &g_graphics.depth_stencil)))
        return fail("Cannot create D3D11 sentinel pipeline states.");
    g_graphics.pending_width = g_graphics.pending_height = 0;
    return true;
}

bool no_existing_runtime()
{
    HMODULE modules[1'024] = {};
    DWORD needed = 0;
    if (!K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &needed) ||
        needed > sizeof(modules))
        return fail("Cannot prove that no ReShade host was already loaded.");
    for (DWORD index = 0; index < needed / sizeof(HMODULE); ++index)
    {
        if (GetProcAddress(modules[index], "ReShadeRegisterAddon") != nullptr)
        {
            g_evidence.preexisting_runtime = true;
            return fail("A ReShade host already exists; the prototype will not load another.");
        }
    }
    return true;
}

bool create_manual_runtime()
{
    ++g_evidence.create_attempts;
    const std::string config = utf8(g_options.config.native());
    if (!g_graphics.create_runtime(reshade::api::device_api::d3d11,
            g_graphics.device.Get(), g_graphics.context.Get(), g_graphics.swapchain.Get(),
            config.c_str(), &g_graphics.runtime) || g_graphics.runtime == nullptr)
        return fail("ReShadeCreateEffectRuntime returned failure.");
    ++g_evidence.create_successes;
    return true;
}

void destroy_manual_runtime()
{
    if (g_graphics.runtime != nullptr)
    {
        g_graphics.destroy_runtime(g_graphics.runtime);
        g_graphics.runtime = nullptr;
        ++g_evidence.destroy_calls;
    }
}

bool load_and_adopt()
{
    g_evidence.phase = "loading-after-existing-presents";
    if (!write_report())
        return fail("Cannot publish the pre-load evidence report.");
    if (!no_existing_runtime())
        return false;
    g_graphics.reshade_module = LoadLibraryExW(g_options.reshade.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (g_graphics.reshade_module == nullptr)
    {
        g_evidence.reshade_load_error = GetLastError();
        return fail("Cannot load the supplied owned ReShade DLL.");
    }
    g_graphics.create_runtime = reinterpret_cast<create_runtime_fn>(
        GetProcAddress(g_graphics.reshade_module, "ReShadeCreateEffectRuntime"));
    g_graphics.destroy_runtime = reinterpret_cast<destroy_runtime_fn>(
        GetProcAddress(g_graphics.reshade_module, "ReShadeDestroyEffectRuntime"));
    g_graphics.update_runtime = reinterpret_cast<update_runtime_fn>(
        GetProcAddress(g_graphics.reshade_module, "ReShadeUpdateAndPresentEffectRuntime"));
    if (g_graphics.create_runtime == nullptr || g_graphics.destroy_runtime == nullptr ||
        g_graphics.update_runtime == nullptr)
        return fail("The supplied host lacks the public manual-runtime exports.");

    g_graphics.addon_module = LoadLibraryExW(g_options.addon.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (g_graphics.addon_module == nullptr)
    {
        g_evidence.addon_load_error = GetLastError();
        return fail("Cannot load the supplied private cooperative add-on.");
    }
    const auto initialize = reinterpret_cast<initialize_member_fn>(GetProcAddress(
        g_graphics.addon_module, "ElectronGameOverlayInitializeMember"));
    if (initialize == nullptr)
        return fail("The supplied add-on lacks ElectronGameOverlayInitializeMember.");
    g_evidence.member_initialize_result = initialize(nullptr);
    if (g_evidence.member_initialize_result != ERROR_SUCCESS)
        return fail("The private cooperative add-on initializer failed.");
    if (!create_manual_runtime())
        return false;
    g_evidence.loaded_at = GetTickCount64();
    g_evidence.phase = "manual-runtime-live";
    publish_message("EGO_LATE_D3D11_MANUAL_RUNTIME_LIVE");
    return write_report() || fail("Cannot publish the manual-runtime report.");
}

bool resize_graphics(UINT width, UINT height)
{
    const bool was_manual = g_graphics.runtime != nullptr;
    if (was_manual)
    {
        g_evidence.phase = "destroying-manual-runtime-before-resize";
        destroy_manual_runtime();
        ++g_evidence.resize_attempts;
    }
    g_graphics.context->OMSetRenderTargets(0, nullptr, nullptr);
    g_graphics.target.Reset();
    g_graphics.context->Flush();
    g_evidence.last_resize_result = g_graphics.swapchain->ResizeBuffers(
        0, width, height, DXGI_FORMAT_UNKNOWN, 0);
    const bool resized = SUCCEEDED(g_evidence.last_resize_result);
    // Failed DXGI resize retains the old buffers. Reacquire them before cleanup.
    if (!create_target())
        return fail("Cannot reacquire the render target after ResizeBuffers.");
    if (was_manual && !create_manual_runtime())
        return false;
    if (!resized)
        return fail("IDXGISwapChain::ResizeBuffers failed.");
    g_graphics.width = width;
    g_graphics.height = height;
    if (was_manual)
    {
        ++g_evidence.resize_successes;
        g_evidence.frames_after_resize = 0;
        if (g_evidence.automatic_resize_requested && width == 960 && height == 640)
            g_evidence.automatic_resize_completed = true;
        g_evidence.phase = "manual-runtime-recreated-after-resize";
        publish_message("EGO_LATE_D3D11_RESIZE_RECREATED");
        return write_report() || fail("Cannot publish the resize report.");
    }
    return true;
}

bool check_pipeline_state(const D3D11_VIEWPORT &expected_viewport,
                          const D3D11_RECT &expected_scissor)
{
    ++g_evidence.state_checks;
    D3D11_PRIMITIVE_TOPOLOGY topology = {};
    g_graphics.context->IAGetPrimitiveTopology(&topology);
    ComPtr<ID3D11RasterizerState> rasterizer;
    g_graphics.context->RSGetState(&rasterizer);
    UINT viewport_count = 1;
    D3D11_VIEWPORT viewport = {};
    g_graphics.context->RSGetViewports(&viewport_count, &viewport);
    UINT scissor_count = 1;
    D3D11_RECT scissor = {};
    g_graphics.context->RSGetScissorRects(&scissor_count, &scissor);
    ComPtr<ID3D11RenderTargetView> target;
    g_graphics.context->OMGetRenderTargets(1, &target, nullptr);
    ComPtr<ID3D11BlendState> blend;
    float factors[4] = {};
    UINT sample_mask = 0;
    g_graphics.context->OMGetBlendState(&blend, factors, &sample_mask);
    ComPtr<ID3D11DepthStencilState> depth_stencil;
    UINT stencil_reference = 0;
    g_graphics.context->OMGetDepthStencilState(&depth_stencil, &stencil_reference);
    const bool matched = topology == D3D11_PRIMITIVE_TOPOLOGY_LINELIST &&
        rasterizer.Get() == g_graphics.rasterizer.Get() && viewport_count == 1 &&
        viewport.TopLeftX == expected_viewport.TopLeftX &&
        viewport.TopLeftY == expected_viewport.TopLeftY &&
        viewport.Width == expected_viewport.Width && viewport.Height == expected_viewport.Height &&
        viewport.MinDepth == expected_viewport.MinDepth && viewport.MaxDepth == expected_viewport.MaxDepth &&
        scissor_count == 1 && scissor.left == expected_scissor.left &&
        scissor.top == expected_scissor.top && scissor.right == expected_scissor.right &&
        scissor.bottom == expected_scissor.bottom && target.Get() == g_graphics.target.Get() &&
        blend.Get() == g_graphics.blend.Get() && factors[0] == 0.125f &&
        factors[1] == 0.25f && factors[2] == 0.5f && factors[3] == 1.0f &&
        sample_mask == 0x5a5a5a5a && depth_stencil.Get() == g_graphics.depth_stencil.Get() &&
        stencil_reference == 37;
    if (!matched)
    {
        ++g_evidence.state_mismatches;
        return fail("The public manual render call did not restore sampled D3D11 pipeline state.");
    }
    return true;
}

bool render_frame()
{
    ID3D11RenderTargetView *const target = g_graphics.target.Get();
    const float clear[4] = { 0.08f, 0.12f, 0.20f, 1.0f };
    const float blend_factors[4] = { 0.125f, 0.25f, 0.5f, 1.0f };
    const D3D11_VIEWPORT viewport = { 7.0f, 11.0f,
        static_cast<float>(g_graphics.width) - 14.0f,
        static_cast<float>(g_graphics.height) - 22.0f, 0.125f, 0.875f };
    const D3D11_RECT scissor = { 13, 17, static_cast<LONG>(g_graphics.width) - 13,
        static_cast<LONG>(g_graphics.height) - 17 };
    g_graphics.context->OMSetRenderTargets(1, &target, nullptr);
    g_graphics.context->ClearRenderTargetView(target, clear);
    g_graphics.context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_LINELIST);
    g_graphics.context->RSSetState(g_graphics.rasterizer.Get());
    g_graphics.context->RSSetViewports(1, &viewport);
    g_graphics.context->RSSetScissorRects(1, &scissor);
    g_graphics.context->OMSetBlendState(g_graphics.blend.Get(), blend_factors, 0x5a5a5a5a);
    g_graphics.context->OMSetDepthStencilState(g_graphics.depth_stencil.Get(), 37);
    const bool manual = g_graphics.runtime != nullptr;
    if (manual)
    {
        g_graphics.update_runtime(g_graphics.runtime);
        ++g_evidence.render_calls;
        // Do not restore state in this host: that would hide a manual-API failure.
        if (!check_pipeline_state(viewport, scissor))
            return false;
    }
    ++g_evidence.native_present_calls;
    g_evidence.last_present_result = g_graphics.swapchain->Present(1, 0);
    if (FAILED(g_evidence.last_present_result))
        return fail("Raw IDXGISwapChain::Present failed.");
    if (g_evidence.last_present_result == S_OK)
    {
        if (!manual)
            ++g_evidence.frames_before_load;
        else
        {
            ++g_evidence.frames_after_load;
            if (g_evidence.resize_successes != 0)
                ++g_evidence.frames_after_resize;
        }
    }
    else
        Sleep(10); // Occlusion is not counted as an actual successful presentation.
    return true;
}

bool request_automatic_resize()
{
    RECT bounds = { 0, 0, 960, 640 };
    if (!AdjustWindowRectEx(&bounds, WS_OVERLAPPEDWINDOW, FALSE, 0) ||
        !SetWindowPos(g_graphics.window, nullptr, 0, 0, bounds.right - bounds.left,
            bounds.bottom - bounds.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE))
        return fail("Cannot request the controlled resize.");
    g_evidence.automatic_resize_requested = true;
    return true;
}

void cleanup_graphics()
{
    destroy_manual_runtime();
    g_evidence.manual_destroyed_before_graphics = g_graphics.runtime == nullptr;
    if (g_graphics.context != nullptr)
    {
        g_graphics.context->ClearState();
        g_graphics.context->Flush();
    }
    g_graphics.target.Reset();
    g_graphics.rasterizer.Reset();
    g_graphics.blend.Reset();
    g_graphics.depth_stencil.Reset();
    g_graphics.swapchain.Reset();
    g_graphics.context.Reset();
    g_graphics.device.Reset();
    // ReShade/add-on modules intentionally stay mapped until process exit.
}

int run(HINSTANCE instance)
{
    if (!parse_options())
    {
        publish_message("Usage: late_d3d11_adoption_host --stage-directory <absolute external stage> "
            "--reshade <absolute staged DLL> --addon <absolute staged addon> "
            "--config <absolute staged INI> --report <absolute staged JSON> "
            "[--frames-before-load 60+] [--resize-after-frames 120] [--lifetime-ms 20000]");
        return 2;
    }
    if (!write_report())
        return fail("Cannot create the owned evidence report.") ? 0 : 1;
    WNDCLASSEXW window_type = { sizeof(window_type) };
    window_type.lpfnWndProc = window_proc;
    window_type.hInstance = instance;
    window_type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    window_type.lpszClassName = window_class;
    if (!RegisterClassExW(&window_type))
        return fail("RegisterClassExW failed.") ? 0 : 1;
    RECT bounds = { 0, 0, 800, 600 };
    if (!AdjustWindowRectEx(&bounds, WS_OVERLAPPEDWINDOW, FALSE, 0))
        return fail("AdjustWindowRectEx failed.") ? 0 : 1;
    g_graphics.window = CreateWindowExW(0, window_class, window_title,
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left,
        bounds.bottom - bounds.top, nullptr, nullptr, instance, nullptr);
    if (g_graphics.window == nullptr || !create_graphics())
        return fail("Cannot create the controlled D3D11 window/graphics.") ? 0 : 1;
    ShowWindow(g_graphics.window, SW_SHOW);
    UpdateWindow(g_graphics.window);
    g_evidence.phase = "raw-swapchain-presenting-before-load";
    publish_message("EGO_LATE_D3D11_RAW_PRESENTS_STARTED");
    std::uint64_t last_report_at = 0;
    bool completed = false;
    while (g_evidence.failure.empty())
    {
        MSG message = {};
        bool quit = false;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            if (message.message == WM_QUIT)
            {
                quit = true;
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if (quit)
        {
            fail("Window closed before the timed lifecycle completed.");
            break;
        }
        if (g_graphics.pending_width != 0 && g_graphics.pending_height != 0)
        {
            const UINT width = g_graphics.pending_width;
            const UINT height = g_graphics.pending_height;
            g_graphics.pending_width = g_graphics.pending_height = 0;
            if ((width != g_graphics.width || height != g_graphics.height) &&
                !resize_graphics(width, height))
                break;
        }
        if (!render_frame())
            break;
        if (g_evidence.loaded_at == 0 &&
            g_evidence.frames_before_load >= g_options.frames_before_load && !load_and_adopt())
            break;
        if (g_evidence.loaded_at != 0 && !g_evidence.automatic_resize_requested &&
            g_evidence.frames_after_load >= g_options.resize_after_frames &&
            !request_automatic_resize())
            break;
        const std::uint64_t now = GetTickCount64();
        if (g_evidence.loaded_at == 0 && now - g_evidence.started_at >= startup_timeout_ms)
        {
            fail("Not enough real pre-load Present calls completed within the startup timeout.");
            break;
        }
        if (g_evidence.loaded_at != 0 && now - g_evidence.loaded_at >= g_options.lifetime_ms)
        {
            completed = true;
            break;
        }
        if (now - last_report_at >= 1'000)
        {
            if (!write_report())
            {
                fail("Cannot refresh the owned evidence report.");
                break;
            }
            last_report_at = now;
        }
    }
    cleanup_graphics();
    if (IsWindow(g_graphics.window))
        DestroyWindow(g_graphics.window);
    if (completed && g_evidence.failure.empty())
    {
        if (g_evidence.frames_before_load < 60 || g_evidence.create_successes < 2 ||
            g_evidence.resize_successes == 0 || g_evidence.frames_after_resize < 60 ||
            !g_evidence.automatic_resize_requested || !g_evidence.automatic_resize_completed ||
            g_evidence.state_checks == 0 || g_evidence.state_mismatches != 0 ||
            g_evidence.destroy_calls != g_evidence.create_successes)
            fail("The timed run did not complete adoption, resize, 60 post-resize presents, and clean destruction.");
        else
        {
            g_evidence.status = "passed";
            g_evidence.phase = "complete";
            publish_message("EGO_LATE_D3D11_HOST_ASSISTED_LIFECYCLE_PASSED");
        }
    }
    if (!write_report())
    {
        publish_message("EGO_LATE_D3D11_FAILED Cannot publish the final evidence report.");
        return 1;
    }
    return g_evidence.status == "passed" ? 0 : 1;
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int)
{
    try
    {
        return run(instance);
    }
    catch (const std::exception &error)
    {
        fail(error.what());
        cleanup_graphics();
        static_cast<void>(write_report());
        return 1;
    }
}
