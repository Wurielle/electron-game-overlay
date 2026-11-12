#include <windows.h>
#include <d3d11.h>
#include <cstdio>
#include <cstring>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

int main(int argc, char **argv)
{
    const bool headless = argc >= 2 && std::strcmp(argv[1], "--headless") == 0;
    const char *offline = argc >= 3 ? argv[2] : nullptr;
    const char *retired = argc >= 4 ? argv[3] : nullptr;
    const char *registered = argc >= 5 ? argv[4] : nullptr;
    const char *private_member = sizeof(void *) == 8 ? "electron_game_overlay.addon64" : "electron_game_overlay.addon32";
    WNDCLASSW wc{};
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpfnWndProc = DefWindowProcW;
    wc.lpszClassName = L"EgoVersionCacheProof";
    if (!RegisterClassW(&wc)) return 1;
    const HWND window = CreateWindowExW(headless ? 0 : WS_EX_TOPMOST, wc.lpszClassName, L"Electron Game Overlay cache test",
        WS_OVERLAPPEDWINDOW | (headless ? 0 : WS_VISIBLE), 55, 70, 450, 340, nullptr, nullptr, wc.hInstance, nullptr);
    if (window == nullptr) return 2;
    if (!headless)
    {
        ShowWindow(window, SW_SHOW);
        SetWindowPos(window, HWND_TOPMOST, 55, 70, 450, 340, SWP_SHOWWINDOW);
        SetForegroundWindow(window);
    }
    constexpr wchar_t barrier[] = L"electron-game-overlay-startup-barrier.enabled";
    if (GetFileAttributesW(barrier) != INVALID_FILE_ATTRIBUTES)
    {
        std::puts("before-device");
        std::fflush(stdout);
        const auto barrier_start = GetTickCount64();
        while (GetFileAttributesW(barrier) != INVALID_FILE_ATTRIBUTES)
        {
            if (GetTickCount64() - barrier_start > 35000) return 9;
            Sleep(10);
        }
    }
    DXGI_SWAP_CHAIN_DESC desc{};
    desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.OutputWindow = window;
    desc.Windowed = TRUE;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    ComPtr<IDXGISwapChain> chain;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    if (FAILED(D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        nullptr, 0, D3D11_SDK_VERSION, &desc, &chain, &device, nullptr, &context))) return 3;
    ComPtr<ID3D11Texture2D> surface;
    ComPtr<ID3D11RenderTargetView> view;
    if (FAILED(chain->GetBuffer(0, IID_PPV_ARGS(&surface))) ||
        FAILED(device->CreateRenderTargetView(surface.Get(), nullptr, &view))) return 4;
    surface.Reset();
    std::puts("ready");
    std::fflush(stdout);
    const float background[4] = { .03f, .05f, .15f, 1.f };
    const auto start = GetTickCount64();
    bool seen = false;
    bool offline_seen = false;
    while (GetTickCount64() - start < 30000)
    {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        context->ClearRenderTargetView(view.Get(), background);
        if (FAILED(chain->Present(1, 0))) return 5;
        if (retired != nullptr && GetModuleHandleA(retired) != nullptr) return 7;
        if (registered != nullptr && GetModuleHandleA(private_member) != nullptr) return 8;
        if (registered != nullptr && offline != nullptr && !offline_seen &&
            GetModuleHandleA(registered) != nullptr && GetModuleHandleA(offline) != nullptr)
        {
            offline_seen = true;
            std::puts("registered-and-offline-preloads");
            std::fflush(stdout);
        }
        if (headless) Sleep(10);
        else if (!seen)
        {
            POINT point { 50, 50 };
            ClientToScreen(window, &point);
            HDC screen = GetDC(nullptr);
            const auto pixel = GetPixel(screen, point.x, point.y);
            ReleaseDC(nullptr, screen);
            if (GetRValue(pixel) > 170 && GetGValue(pixel) < 60 && GetBValue(pixel) < 60)
            {
                seen = true;
                std::printf("pixel:%u,%u,%u\n", GetRValue(pixel), GetGValue(pixel), GetBValue(pixel));
                std::fflush(stdout);
            }
        }
    }
    return headless || seen ? 0 : 6;
}
