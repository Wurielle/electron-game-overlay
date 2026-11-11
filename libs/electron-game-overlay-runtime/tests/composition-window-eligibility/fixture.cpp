// Owned offscreen windows/native tooltip only; no target/game, activation or
// keyboard/pointer injection. Tooltip setup messages go only to our own control.
#include <Windows.h>
#include <commctrl.h>
#include <cstdio>
#include <stdexcept>
#include EGO_POLICY_HEADER
static unsigned assertions=0;
static void check(bool ok,const char *message){++assertions;if(!ok)throw std::runtime_error(message);}
static HWND make_window(DWORD style,DWORD extended,HWND owner=nullptr,bool tooltip=false,HWND tool_target=nullptr){
 HWND window=CreateWindowExW(extended,tooltip?TOOLTIPS_CLASSW:L"STATIC",tooltip?nullptr:L"Owned window eligibility probe",style,-32000,-32000,160,40,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
 check(window!=nullptr,"create owned window");if(extended&WS_EX_LAYERED)check(SetLayeredWindowAttributes(window,0,255,LWA_ALPHA)!=FALSE,"layered owned window");
 if(tooltip){TOOLINFOW info{};info.cbSize=TTTOOLINFOW_V1_SIZE;info.uFlags=TTF_TRACK|TTF_ABSOLUTE;info.hwnd=tool_target;info.uId=1;info.rect={0,0,160,40};info.lpszText=const_cast<wchar_t *>(L"Owned native tooltip");check(SendMessageW(window,TTM_ADDTOOLW,0,reinterpret_cast<LPARAM>(&info))!=FALSE,"native tooltip registration");SendMessageW(window,TTM_TRACKPOSITION,0,MAKELPARAM(-32000,-32000));SendMessageW(window,TTM_TRACKACTIVATE,TRUE,reinterpret_cast<LPARAM>(&info));}
 ShowWindow(window,SW_SHOWNOACTIVATE);check(IsWindowVisible(window)!=FALSE,"owned window visible");return window;
}
int main()try{
 using namespace ego_owned_runtime_policy;INITCOMMONCONTROLSEX controls{sizeof(controls),ICC_WIN95_CLASSES};check(InitCommonControlsEx(&controls)!=FALSE,"native tooltip class initialization");
 const HWND foreground=GetForegroundWindow();active=true;
 HWND early=make_window(WS_POPUP|WS_BORDER|WS_CLIPSIBLINGS,WS_EX_TOOLWINDOW|WS_EX_TOPMOST|WS_EX_LAYERED);window_binding early_binding;
 const bool initial_rejected=early_binding.resolve()==nullptr;check(initial_rejected==(CURRENT_ELIGIBILITY!=0),"baseline reproduces binding an auxiliary alone; current refuses");DestroyWindow(early);
 HWND main=make_window(WS_OVERLAPPEDWINDOW,WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE);window_binding binding;check(binding.resolve()==main,"captioned sole tool remains a presenter");const HANDLE cookie=GetPropW(main,property_name);
 struct case_info{const char *name;DWORD style,extended;bool owned,tooltip,auxiliary;};
 const case_info cases[]={
  {"captured-tooltip-attributes",WS_POPUP|WS_BORDER|WS_CLIPSIBLINGS,WS_EX_TOOLWINDOW|WS_EX_TOPMOST|WS_EX_LAYERED,false,false,true},
  {"owned-nonactivating-tool",WS_POPUP,WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,true,false,true},
  {"unowned-nonactivating-tool",WS_POPUP,WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,false,false,true},
  {"native-tooltip-control",WS_POPUP|TTS_ALWAYSTIP|TTS_NOPREFIX,WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TOPMOST|WS_EX_LAYERED,false,true,true},
  {"captioned-tool-popup",WS_POPUP|WS_CAPTION,WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,false,false,false},
  {"owned-captioned-tool",WS_POPUP|WS_CAPTION,WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,true,false,false},
  {"plain-frameless-tool",WS_POPUP,WS_EX_TOOLWINDOW,false,false,false},
  {"explicit-application-tool",WS_POPUP,WS_EX_TOOLWINDOW|WS_EX_APPWINDOW|WS_EX_NOACTIVATE|WS_EX_TOPMOST|WS_EX_LAYERED,false,false,false},
  {"ordinary-frameless-peer",WS_POPUP,WS_EX_NOACTIVATE,false,false,false},
  {"normal-peer",WS_OVERLAPPEDWINDOW,WS_EX_NOACTIVATE,false,false,false},
 };
 unsigned ignored=0,refused_peers=0;
 for(const auto &c:cases){HWND popup=make_window(c.style,c.extended,c.owned?main:nullptr,c.tooltip,main);const bool expected=CURRENT_ELIGIBILITY&&c.auxiliary;
  SetLastError(0x6835);const bool retained=binding.resolve()==main;check(retained==expected&&GetLastError()==0x6835,"binding eligibility and last error");
  window_binding admission;check((admission.resolve()==main)==expected,"new binding while popup visible");
  for(unsigned n=0;n!=16;++n){check((binding.resolve()==main)==expected,"stable repeated popup eligibility");ShowWindow(popup,SW_HIDE);check(binding.resolve()==main,"same binding survives hiding peer");ShowWindow(popup,SW_SHOWNOACTIVATE);check(IsWindowVisible(popup)!=FALSE,"popup shown without activation");}
  check(GetPropW(main,property_name)==cookie&&GetForegroundWindow()==foreground,"lifetime token and activation unchanged");
  if(c.auxiliary&&retained)++ignored;if(!c.auxiliary&&!retained)++refused_peers;
  std::printf("{\"name\":\"%s\",\"auxiliary\":%s,\"boundDuringPopup\":%s,\"visible\":true,\"style\":%lu,\"extendedStyle\":%lu}\n",c.name,c.auxiliary?"true":"false",retained?"true":"false",static_cast<DWORD>(GetWindowLongPtrW(popup,GWL_STYLE)),static_cast<DWORD>(GetWindowLongPtrW(popup,GWL_EXSTYLE)));
  DestroyWindow(popup);check(binding.resolve()==main,"original presenter resumes after peer destruction");
 }
 check(ignored==(CURRENT_ELIGIBILITY?4u:0u)&&refused_peers==6,"auxiliary filtering and strict peer ambiguity");
 DestroyWindow(main);check(binding.resolve()==nullptr,"window lifetime retirement still refuses");
 for(const auto &c:cases)if(!c.auxiliary&&!c.owned){HWND sole=make_window(c.style,c.extended);window_binding sole_binding;check(sole_binding.resolve()==sole,"legitimate sole styled/frameless windows retained");DestroyWindow(sole);}
 active=false;HWND foreign=make_window(WS_OVERLAPPEDWINDOW,WS_EX_NOACTIVATE);window_binding inactive;check(inactive.resolve()==nullptr,"foreign/inactive policy unchanged");DestroyWindow(foreign);
 std::printf("{\"status\":\"passed\",\"current\":%s,\"assertions\":%u,\"cases\":10,\"ignoredAuxiliaries\":%u,\"refusedRealPeers\":%u,\"initialAuxiliaryRefused\":%s,\"soleStyledWindowsPreserved\":true,\"foregroundUnchanged\":true,\"actualGame\":false,\"input\":false}\n",CURRENT_ELIGIBILITY?"true":"false",assertions,ignored,refused_peers,initial_rejected?"true":"false");return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s after %u assertions\n",error.what(),assertions);return 1;}
