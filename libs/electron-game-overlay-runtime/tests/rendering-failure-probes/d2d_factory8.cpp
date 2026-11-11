// Actual COM calls against the supplied unchanged host. No HWND or Present.
#include <Windows.h>
#include <d3d11.h>
#include <d2d1_3.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstdio>
#include <cwchar>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
static constexpr GUID unwrapped = {0x7f2c9a11,0x3b4e,0x4d6a,{0x81,0x2f,0x5e,0x9c,0xd3,0x7a,0x1b,0x42}};
static void check(HRESULT hr, const char *name) {
  if (FAILED(hr)) { std::fprintf(stderr,"%s: %08lx\n",name,hr); throw std::runtime_error(name); }
}
int wmain(int argc, wchar_t **argv) {
  try {
    if(argc != 5) return 64; // runtime or -, owned config, factory 7|8, proxy|original|warp
    SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE",argv[2]);
    const bool hooked = wcscmp(argv[1],L"-") != 0;
    if(hooked && !LoadLibraryW(argv[1])) return 65;
    const bool warp = wcscmp(argv[4],L"warp") == 0;
    ComPtr<ID3D11Device> device;
    check(D3D11CreateDevice(nullptr,warp ? D3D_DRIVER_TYPE_WARP : D3D_DRIVER_TYPE_HARDWARE,
      nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,nullptr),"D3D11CreateDevice");
    ComPtr<ID3D11Device> original;
    const bool wrapped = SUCCEEDED(device->QueryInterface(unwrapped,&original));
    if(hooked && !warp && !wrapped) throw std::runtime_error("production device hook inactive");
    ComPtr<IDXGIDevice> dxgi;
    check((wcscmp(argv[4],L"original")==0 && original ? original : device).As(&dxgi),"IDXGIDevice");
    ComPtr<ID2D1Factory1> factory;
    check(D2D1CreateFactory(D2D1_FACTORY_TYPE_MULTI_THREADED,IID_PPV_ARGS(&factory)),"D2D1CreateFactory");
    HRESULT hr = E_FAIL, context_hr = E_FAIL, bitmap_hr=E_FAIL, draw_hr=E_FAIL;
    ComPtr<ID2D1DeviceContext> drawing;
    if(wcscmp(argv[3],L"8")==0) {
      ComPtr<ID2D1Factory8> f; const HRESULT supported = factory.As(&f);
      if(FAILED(supported)) { std::printf("{\"status\":\"unsupported\",\"factory\":8,\"hresult\":%lu}\n",static_cast<unsigned long>(supported)); return 0; }
      ComPtr<ID2D1Device7> d; hr=f->CreateDevice(dxgi.Get(),&d);
      if(SUCCEEDED(hr)) { ComPtr<ID2D1DeviceContext7> c; context_hr=d->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE,&c); if(c) check(c.As(&drawing),"base context8"); }
    } else {
      ComPtr<ID2D1Factory7> f; check(factory.As(&f),"factory7");
      ComPtr<ID2D1Device6> d; hr=f->CreateDevice(dxgi.Get(),&d);
      if(SUCCEEDED(hr)) { ComPtr<ID2D1DeviceContext6> c; context_hr=d->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE,&c); if(c) check(c.As(&drawing),"base context7"); }
    }
    bool green=false;
    if(drawing) {
      ComPtr<IDXGIFactory2> swap_factory; check(CreateDXGIFactory1(IID_PPV_ARGS(&swap_factory)),"DXGI factory");
      DXGI_SWAP_CHAIN_DESC1 desc={}; desc.Width=desc.Height=16; desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc.Count=1; desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT; desc.BufferCount=2;
      desc.SwapEffect=DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL; desc.Scaling=DXGI_SCALING_STRETCH; desc.AlphaMode=DXGI_ALPHA_MODE_PREMULTIPLIED;
      ComPtr<IDXGISwapChain1> chain; check(swap_factory->CreateSwapChainForComposition(device.Get(),&desc,nullptr,&chain),"composition chain");
      ComPtr<IDXGISurface> surface; check(chain->GetBuffer(0,IID_PPV_ARGS(&surface)),"first composition buffer");
      D2D1_BITMAP_PROPERTIES1 properties={}; properties.pixelFormat={DXGI_FORMAT_B8G8R8A8_UNORM,D2D1_ALPHA_MODE_PREMULTIPLIED};
      properties.dpiX=properties.dpiY=96; properties.bitmapOptions=D2D1_BITMAP_OPTIONS_TARGET|D2D1_BITMAP_OPTIONS_CANNOT_DRAW;
      ComPtr<ID2D1Bitmap1> bitmap; bitmap_hr=drawing->CreateBitmapFromDxgiSurface(surface.Get(),&properties,&bitmap);
      if(SUCCEEDED(bitmap_hr)) {
        drawing->SetTarget(bitmap.Get()); drawing->BeginDraw(); const D2D1_COLOR_F color={0,1,0,1}; drawing->Clear(&color); draw_hr=drawing->EndDraw();
        drawing->SetTarget(nullptr);
        if(SUCCEEDED(draw_hr)) {
          ComPtr<ID3D11Texture2D> buffer; check(surface.As(&buffer),"buffer texture");
          D3D11_TEXTURE2D_DESC td={}; buffer->GetDesc(&td); td.Usage=D3D11_USAGE_STAGING; td.BindFlags=0; td.CPUAccessFlags=D3D11_CPU_ACCESS_READ; td.MiscFlags=0;
          ComPtr<ID3D11Texture2D> staging; check(device->CreateTexture2D(&td,nullptr,&staging),"staging texture");
          ComPtr<ID3D11DeviceContext> immediate; device->GetImmediateContext(&immediate); immediate->CopyResource(staging.Get(),buffer.Get());
          D3D11_MAPPED_SUBRESOURCE mapped={}; check(immediate->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped),"readback");
          auto pixel=static_cast<const unsigned char *>(mapped.pData); green=pixel[0]==0 && pixel[1]==255 && pixel[2]==0 && pixel[3]==255; immediate->Unmap(staging.Get(),0);
        }
      }
    }
    std::printf("{\"status\":\"observed\",\"factory\":%d,\"wrapped\":%s,\"createDeviceHresult\":%lu,\"createContextHresult\":%lu,\"bitmapHresult\":%lu,\"drawHresult\":%lu,\"greenReadback\":%s}\n",
      _wtoi(argv[3]),wrapped?"true":"false",static_cast<unsigned long>(hr),static_cast<unsigned long>(context_hr),static_cast<unsigned long>(bitmap_hr),static_cast<unsigned long>(draw_hr),green?"true":"false");
    return 0; // The runner compares failure and success controls; failure is evidence.
  } catch(const std::exception &e) { std::fprintf(stderr,"%s\n",e.what()); return 3; }
}
