// Full unchanged EGO feature/transport on an isolated, never-switched desktop.
#include <Windows.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <filesystem>
#include <fstream>
#include <cstdio>
#include <stdexcept>
#include <string>
using Microsoft::WRL::ComPtr;
static unsigned keys=0,chars=0,frames=0; static bool dirty=false;
static void require(bool ok,const char *what) { if(!ok) throw std::runtime_error(what); }
static LRESULT CALLBACK procedure(HWND w,UINT m,WPARAM p,LPARAM l) {
  if(m==WM_KEYDOWN) { ++keys; dirty=true; return 0; }
  if(m==WM_CHAR) { ++chars; dirty=true; return 0; }
  if(m==WM_PAINT) { PAINTSTRUCT ps; BeginPaint(w,&ps); EndPaint(w,&ps); dirty=true; return 0; }
  return DefWindowProcW(w,m,p,l);
}
int wmain(int argc,wchar_t **argv) {
  try {
    require(argc==4 || (argc==5 && std::wstring(argv[4])==L"visible"),"runtime addon evidence-directory [visible] arguments required");
    const bool private_desktop=argc==4;
    const auto directory=std::filesystem::path(argv[3]);
    const auto desktop_name=L"EgoOwnedInputProbe"+std::to_wstring(GetCurrentProcessId());
    if(private_desktop) {
      HDESK desktop=CreateDesktopW(desktop_name.c_str(),nullptr,nullptr,0,GENERIC_ALL,nullptr);
      require(desktop!=nullptr,"CreateDesktop"); require(SetThreadDesktop(desktop)!=FALSE,"SetThreadDesktop");
    }
    // Never SwitchDesktop: no window is shown on the user's desktop.
    SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE",argv[3]);
    require(LoadLibraryW(argv[1])!=nullptr,"load host");
    HMODULE addon=LoadLibraryExW(argv[2],nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
    require(addon!=nullptr,"load EGO add-on");
    auto initialize=reinterpret_cast<DWORD(WINAPI*)(void*)>(GetProcAddress(addon,"ElectronGameOverlayInitializeMember"));
    require(initialize && initialize(nullptr)==ERROR_SUCCESS,"initialize unchanged EGO member");
    WNDCLASSW wc={}; wc.hInstance=GetModuleHandleW(nullptr); wc.lpfnWndProc=procedure; wc.lpszClassName=L"EgoOwnedFullTransport";
    require(RegisterClassW(&wc)!=0,"RegisterClass");
    HWND window=CreateWindowW(wc.lpszClassName,L"Owned transport probe",WS_OVERLAPPEDWINDOW|WS_VISIBLE,0,0,680,540,nullptr,nullptr,wc.hInstance,nullptr);
    require(window!=nullptr,"CreateWindow"); SetForegroundWindow(window); SetFocus(window);
    require(GetForegroundWindow()==window,"private desktop foreground unavailable");
    DXGI_SWAP_CHAIN_DESC desc={}; desc.BufferDesc.Width=640; desc.BufferDesc.Height=480; desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count=1; desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT; desc.BufferCount=2; desc.OutputWindow=window; desc.Windowed=TRUE; desc.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
    ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context; ComPtr<IDXGISwapChain> chain;
    require(SUCCEEDED(D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&chain,&device,nullptr,&context)),"create graphics");
    ComPtr<ID3D11Texture2D> buffer; require(SUCCEEDED(chain->GetBuffer(0,IID_PPV_ARGS(&buffer))),"buffer");
    ComPtr<ID3D11RenderTargetView> target; require(SUCCEEDED(device->CreateRenderTargetView(buffer.Get(),nullptr,&target)),"RTV");
    D3D11_TEXTURE2D_DESC td={}; buffer->GetDesc(&td); td.Usage=D3D11_USAGE_STAGING; td.BindFlags=0; td.CPUAccessFlags=D3D11_CPU_ACCESS_READ; td.MiscFlags=0;
    ComPtr<ID3D11Texture2D> staging; require(SUCCEEDED(device->CreateTexture2D(&td,nullptr,&staging)),"staging");
    unsigned red_pixels=0; bool continuous=true, repaint_on_input=false; unsigned sequence=0;
    FILETIME birth={},exited={},kernel={},user={}; GetProcessTimes(GetCurrentProcess(),&birth,&exited,&kernel,&user);
    ULARGE_INTEGER creation={}; creation.LowPart=birth.dwLowDateTime; creation.HighPart=birth.dwHighDateTime;
    const auto started=GetTickCount64(); auto last_report=started;
    auto present=[&] {
      const float color[]={0,0,0.2f,1}; context->ClearRenderTargetView(target.Get(),color);
      require(SUCCEEDED(chain->Present(0,0)),"Present"); ++frames; dirty=false;
      context->CopyResource(staging.Get(),buffer.Get()); D3D11_MAPPED_SUBRESOURCE mapped={};
      require(SUCCEEDED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped)),"readback");
      const auto pixel=static_cast<const unsigned char*>(mapped.pData)+80*mapped.RowPitch+60*4;
      if(pixel[0]>150 && pixel[1]<90 && pixel[2]<90) ++red_pixels;
      context->Unmap(staging.Get(),0);
    };
    while(GetTickCount64()-started<60000) {
      { std::ifstream command(directory/L"host-command.txt"); unsigned next=0; std::string action; command>>next>>action;
        if(command && next>sequence) { sequence=next;
          if(action=="exit") break;
          if(action=="pause") continuous=false;
          if(action=="continuous") continuous=true;
          if(action=="redraw") require(InvalidateRect(window,nullptr,FALSE)!=FALSE,"InvalidateRect");
          if(action=="frames") { present(); present(); present(); }
          if(action=="key") { PostMessageW(window,WM_KEYDOWN,'A',1); PostMessageW(window,WM_KEYUP,'A',0xc0000001); }
          if(action=="wake-input") repaint_on_input=true;
        }
      }
      MSG message; unsigned count=0;
      while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
        require(++count<4096,"message pump budget");
        // Optional TEST-ONLY wake after native suppression, not a production fix.
        if(repaint_on_input && message.message==WM_NULL && message.hwnd==window) InvalidateRect(window,nullptr,FALSE);
        TranslateMessage(&message); DispatchMessageW(&message);
      }
      if(continuous || dirty) present();
      if(GetTickCount64()-last_report>=40) {
        last_report=GetTickCount64(); const auto temp=directory/L"host-state.tmp";
        { std::ofstream state(temp); state<<"{\"pid\":"<<GetCurrentProcessId()<<",\"creationTime100ns\":\""<<creation.QuadPart<<"\",\"hwnd\":\"0x"<<std::hex<<reinterpret_cast<std::uintptr_t>(window)<<std::dec<<"\",\"threadId\":"<<GetCurrentThreadId()<<",\"foreground\":"<<(GetForegroundWindow()==window?"true":"false")<<",\"frames\":"<<frames<<",\"redReadbacks\":"<<red_pixels<<",\"appKeys\":"<<keys<<",\"appChars\":"<<chars<<",\"sequence\":"<<sequence<<",\"continuous\":"<<(continuous?"true":"false")<<"}"; }
        require(MoveFileExW(temp.c_str(),(directory/L"host-state.json").c_str(),MOVEFILE_REPLACE_EXISTING)!=FALSE,"publish state");
      }
      Sleep(5);
    }
    std::printf("{\"status\":\"completed\",\"frames\":%u,\"redReadbacks\":%u,\"appKeys\":%u,\"privateDesktop\":%s}\n",frames,red_pixels,keys,private_desktop?"true":"false");
    return 0;
  } catch(const std::exception &e) { std::fprintf(stderr,"%s (Win32=%lu)\n",e.what(),GetLastError()); return 3; }
}
