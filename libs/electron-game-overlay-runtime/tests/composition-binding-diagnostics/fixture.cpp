#include <Windows.h>
#include <cstdio>
#include <cstdarg>
#include <stdexcept>
#include <new>
#include <string>
#include <vector>
static bool fail_enumeration=false;
static BOOL WINAPI fixture_enum_windows(WNDENUMPROC callback,LPARAM state){if(fail_enumeration){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}return ::EnumWindows(callback,state);}
#define EnumWindows fixture_enum_windows
#include EGO_BINDING_HEADER
#undef EnumWindows
static unsigned assertions=0;
static void check(bool ok){++assertions;if(!ok)throw std::runtime_error("binding observer contract");}
#if !BASELINE_CONTROL
static bool throw_logger=false;
static unsigned attempts=0;
static std::vector<std::string> records;
namespace reshade::log {enum class level {info};void message(level,const char *format,...){++attempts;if(throw_logger)throw std::bad_alloc();char text[4096]{};va_list args;va_start(args,format);const int size=vsnprintf(text,sizeof(text),format,args);va_end(args);if(size<=0||size>=sizeof(text))throw std::runtime_error("observer output overflow");records.emplace_back(text);SetLastError(0xBAD);}}
#include EGO_BINDING_LOGGER
#include EGO_RESET_HEADER
#endif
static HWND make_window(){HWND w=CreateWindowExW(WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW,L"STATIC",L"Owned observer console fixture",WS_POPUP|WS_VISIBLE,-32000,-32000,64,64,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);if(w)ShowWindow(w,SW_SHOWNOACTIVATE);return w;}
int main()try{
 using namespace ego_owned_runtime_policy;
#if !BASELINE_CONTROL
 records.reserve(24);observer.store(&observe_composition_binding,std::memory_order_release);
#endif
 std::vector<bool> decisions;window_binding binding;
 const auto decide=[&](bool expected){SetLastError(0x3579);const bool result=binding.resolve()!=nullptr;decisions.push_back(result);check(result==expected&&GetLastError()==0x3579);};
 active=false;decide(false);active=true;decide(false);
 HWND main=make_window();check(main!=nullptr);decide(true);const HANDLE cookie=GetPropW(main,property_name);
 HWND peer=make_window();check(peer!=nullptr);decide(false);
#if !BASELINE_CONTROL
 check(attempts==1);
#endif
 for(unsigned i=0;i!=20;++i)decide(false);
#if !BASELINE_CONTROL
 check(attempts==1);
#endif
 ShowWindow(peer,SW_HIDE);decide(true);ShowWindow(main,SW_HIDE);decide(false);ShowWindow(main,SW_SHOWNOACTIVATE);decide(true);
 RemovePropW(main,property_name);decide(false);check(SetPropW(main,property_name,cookie)!=FALSE);decide(true);
 const DWORD original_thread=binding.thread;binding.thread=original_thread+1;decide(false);binding.thread=original_thread;decide(true);
 ShowWindow(main,SW_HIDE);ShowWindow(peer,SW_SHOWNOACTIVATE);decide(false);ShowWindow(peer,SW_HIDE);ShowWindow(main,SW_SHOWNOACTIVATE);decide(true);
 fail_enumeration=true;decide(false);fail_enumeration=false;decide(true);
#if !BASELINE_CONTROL
 throw_logger=true;
#endif
 ShowWindow(peer,SW_SHOWNOACTIVATE);decide(false);
#if !BASELINE_CONTROL
 throw_logger=false;
#endif
 ShowWindow(peer,SW_HIDE);decide(true);
 for(unsigned i=0;i!=40;++i){ShowWindow(peer,SW_SHOWNOACTIVATE);decide(false);ShowWindow(peer,SW_HIDE);decide(true);}
#if !BASELINE_CONTROL
 check(attempts==24&&observation_count.load()==24&&records.size()==23);
 reset_fixture reset;reset._is_initialized=false;reset.observe_reset(false,"not-initialized");check(attempts==24);
 reset._is_initialized=true;active=false;reset.observe_reset(false,"foreign-host");check(attempts==24);active=true;
 SetLastError(0x2468);throw_logger=true;reset.observe_reset(false,"throwing-logger");throw_logger=false;check(GetLastError()==0x2468);
 for(unsigned i=0;i!=40;++i){SetLastError(0x1357);reset.observe_reset((i&1)!=0,"owned-console-reset");check(GetLastError()==0x1357);}
 check(attempts==48&&records.size()==46);
 for(const auto &record:records)std::puts(record.c_str());
#endif
 DestroyWindow(peer);DestroyWindow(main);decide(false);
 std::printf("{\"status\":\"passed\",\"baseline\":%s,\"assertions\":%u,\"decisions\":[",BASELINE_CONTROL?"true":"false",assertions);
 for(size_t i=0;i<decisions.size();++i)std::printf("%s%s",i?",":"",decisions[i]?"true":"false");std::puts("]}");return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s after %u assertions\n",error.what(),assertions);return 1;}
