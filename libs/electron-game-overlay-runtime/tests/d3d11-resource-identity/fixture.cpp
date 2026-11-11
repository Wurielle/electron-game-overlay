// Offscreen native boundary test: no HWND, Present, desktop input or game.
#include <Windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
static constexpr GUID unwrapped = {0x7f2c9a11, 0x3b4e, 0x4d6a, {0x81, 0x2f, 0x5e, 0x9c, 0xd3, 0x7a, 0x1b, 0x42}};
static void check(HRESULT hr, const char *operation)
{
    if (FAILED(hr)) { std::fprintf(stderr, "%s failed: %08lx\n", operation, hr); throw std::runtime_error(operation); }
}
static bool same_device(ID3D11Resource *resource, ID3D11Device *expected, const char *boundary)
{
    ComPtr<ID3D11Device> actual;
    resource->GetDevice(&actual);
    std::printf("{\"boundary\":\"%s\",\"expected\":\"%p\",\"actual\":\"%p\",\"equal\":%s}\n",
        boundary, expected, actual.Get(), actual.Get() == expected ? "true" : "false");
    return actual.Get() == expected;
}
int wmain(int argc, wchar_t **argv)
{
    try {
        if (argc != 5) return 64; // runtime DLL or '-', owned config directory, hardware|warp|video, expect-match|expect-mismatch
        const bool hooked = std::wcscmp(argv[1], L"-") != 0;
        const bool warp = std::wcscmp(argv[3], L"warp") == 0;
        const bool video = std::wcscmp(argv[3], L"video") == 0;
        if (std::wcscmp(argv[3], L"hardware") && !warp && !video) return 64;
        if (std::wcscmp(argv[4], L"expect-match") && std::wcscmp(argv[4], L"expect-mismatch")) return 64;
        const bool expect_match = std::wcscmp(argv[4], L"expect-match") == 0;
        if (!std::filesystem::path(argv[2]).is_absolute()) return 64;
        if (!SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE", argv[2])) return 65;
        // Imports are already loaded. Loading only this supplied ReShade installs
        // its real production hooks, without an injector or an application SDK.
        if (hooked && LoadLibraryW(argv[1]) == nullptr) return static_cast<int>(GetLastError());
        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | (video ? D3D11_CREATE_DEVICE_VIDEO_SUPPORT : 0);
        check(D3D11CreateDevice(nullptr, warp ? D3D_DRIVER_TYPE_WARP : D3D_DRIVER_TYPE_HARDWARE,
            nullptr, flags, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "D3D11CreateDevice");
        ComPtr<IUnknown> original;
        const bool wrapped = SUCCEEDED(device->QueryInterface(unwrapped, &original)) && original.Get() != device.Get();
        if (hooked && !warp && !wrapped) throw std::runtime_error("the real device hook was not active");
        ComPtr<ID3D11Device> expected;
        check(device.As(&expected), "QueryInterface(ID3D11Device)");
        // Preserve the existing Media Foundation exception for video devices.
        if (!video && expected.Get() != device.Get()) throw std::runtime_error("base device identity changed");
        ComPtr<IDXGIFactory2> factory;
        check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");
        DXGI_SWAP_CHAIN_DESC1 desc = {};
        desc.Width = 32; desc.Height = 32; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1; desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT | DXGI_USAGE_SHADER_INPUT;
        desc.BufferCount = 2; desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        desc.Scaling = DXGI_SCALING_STRETCH; desc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
        ComPtr<IDXGISwapChain1> chain;
        check(factory->CreateSwapChainForComposition(device.Get(), &desc, nullptr, &chain), "CreateSwapChainForComposition");
        bool all_match = true;
        { // This happens before any application CreateTexture2D call.
            ComPtr<ID3D11Texture2D> buffer;
            check(chain->GetBuffer(0, IID_PPV_ARGS(&buffer)), "GetBuffer(texture)");
            all_match &= same_device(buffer.Get(), expected.Get(), "composition-first-buffer");
        }
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = td.Height = 16; td.MipLevels = td.ArraySize = 1; td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        td.SampleDesc.Count = 1; td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        ComPtr<ID3D11Texture2D> texture;
        check(device->CreateTexture2D(&td, nullptr, &texture), "CreateTexture2D");
        all_match &= same_device(texture.Get(), expected.Get(), "device-created-texture");
        for (UINT index = 0; index != 2; ++index) {
            ComPtr<ID3D11Resource> resource;
            check(chain->GetBuffer(index, IID_PPV_ARGS(&resource)), "GetBuffer(resource)");
            all_match &= same_device(resource.Get(), expected.Get(), "composition-resource-interface");
            ComPtr<IUnknown> unknown;
            check(chain->GetBuffer(index, IID_PPV_ARGS(&unknown)), "GetBuffer(IUnknown)");
            ComPtr<ID3D11Texture2D> from_unknown;
            check(unknown.As(&from_unknown), "QueryInterface(texture)");
            all_match &= same_device(from_unknown.Get(), expected.Get(), "composition-IUnknown-query");
        }
        texture.Reset();
        check(chain->ResizeBuffers(2, 48, 48, DXGI_FORMAT_UNKNOWN, 0), "ResizeBuffers");
        {
            ComPtr<ID3D11Texture2D> buffer;
            check(chain->GetBuffer(0, IID_PPV_ARGS(&buffer)), "GetBuffer(resized)");
            const ULONG before = device->AddRef(); device->Release();
            for (int i = 0; i != 64; ++i) {
                ComPtr<ID3D11Device> observed; buffer->GetDevice(&observed);
                all_match &= observed.Get() == expected.Get();
            }
            const ULONG after = device->AddRef(); device->Release();
            if (before != after) throw std::runtime_error("GetDevice leaked or over-released device references");
            all_match &= same_device(buffer.Get(), expected.Get(), "composition-resized-buffer");
        }
        const bool passed = all_match == expect_match;
        std::printf("{\"status\":\"%s\",\"allMatch\":%s,\"wrapped\":%s,\"video\":%s,\"warp\":%s,\"offscreen\":true}\n",
            passed ? "passed" : "failed", all_match ? "true" : "false", wrapped ? "true" : "false", video ? "true" : "false", warp ? "true" : "false");
        return passed ? 0 : 2;
    } catch (const std::exception &error) { std::fprintf(stderr, "%s\n", error.what()); return 3; }
}
