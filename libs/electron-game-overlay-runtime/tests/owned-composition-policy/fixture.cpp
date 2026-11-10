#include "ego_owned_late_d3d11/owned_runtime_policy.hpp"
#include "ini_file.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>
#include "composition_lifecycle_fixture.hpp"

std::filesystem::path g_reshade_dll_path, g_reshade_base_path, g_target_executable_path;
static unsigned checks = 0;
static void check(bool condition, const char *message) {
    ++checks; if (!condition) throw std::runtime_error(message);
}
static HWND make_window() {
    HWND window=CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, L"STATIC", L"Owned offscreen policy fixture",
        WS_OVERLAPPEDWINDOW | WS_VISIBLE, -32000, -32000, 64, 64, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    // The console runner's STARTF_USESHOWWINDOW/SW_HIDE applies to its first
    // window. Explicitly show the owned offscreen window without activation.
    if(window) ShowWindow(window,SW_SHOWNOACTIVATE);
    return window;
}
static std::string read(const std::filesystem::path &file) {
    std::ifstream in(file, std::ios::binary); return {std::istreambuf_iterator<char>(in), {}};
}
struct child_process {
    PROCESS_INFORMATION value {};
    ~child_process() { if(value.hProcess) { if(WaitForSingleObject(value.hProcess,0)==WAIT_TIMEOUT) TerminateProcess(value.hProcess,9); WaitForSingleObject(value.hProcess,5000); CloseHandle(value.hProcess); CloseHandle(value.hThread); } }
};
static void start(std::wstring command, child_process &child, HANDLE output=nullptr) {
    STARTUPINFOW startup { sizeof(startup) }; startup.dwFlags=STARTF_USESHOWWINDOW; startup.wShowWindow=SW_HIDE;
    if(output) { startup.dwFlags |= STARTF_USESTDHANDLES; startup.hStdOutput=output; startup.hStdError=output; startup.hStdInput=GetStdHandle(STD_INPUT_HANDLE); }
    check(CreateProcessW(nullptr, command.data(), nullptr, nullptr, output!=nullptr, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child.value)!=FALSE,"create owned console process");
}
static std::pair<DWORD,std::string> query(const std::filesystem::path &manager, const std::wstring &args) {
    SECURITY_ATTRIBUTES security {sizeof(security),nullptr,TRUE}; HANDLE input=nullptr,output=nullptr;
    check(CreatePipe(&input,&output,&security,0)!=FALSE,"query pipe"); SetHandleInformation(input,HANDLE_FLAG_INHERIT,0);
    child_process child; start(L"\""+manager.wstring()+L"\" "+args,child,output); CloseHandle(output);
    std::string result; char buffer[4096]; DWORD count=0;
    while(ReadFile(input,buffer,sizeof(buffer),&count,nullptr)&&count) result.append(buffer,count);
    CloseHandle(input); check(WaitForSingleObject(child.value.hProcess,10000)==WAIT_OBJECT_0,"manager terminates");
    DWORD exit=0; GetExitCodeProcess(child.value.hProcess,&exit); return {exit,result};
}
int wmain(int argc,wchar_t **argv) try {
    if(argc==4 && std::wstring_view(argv[1])==L"--child") {
        HWND window=make_window(); HANDLE ready=OpenEventW(EVENT_MODIFY_STATE,FALSE,argv[2]),exit=OpenEventW(SYNCHRONIZE,FALSE,argv[3]);
        if(!window||!ready||!exit) return 2; SetEvent(ready); WaitForSingleObject(exit,15000); DestroyWindow(window); CloseHandle(ready); CloseHandle(exit); return 0;
    }
    check(argc==3,"manager and fixed owned fixture directory required");
    const std::filesystem::path manager=argv[1],base=argv[2]; std::filesystem::create_directories(base);
    const auto prefix=L"Local\\EGOOwnedPolicy"+std::to_wstring(GetCurrentProcessId());
    const auto ready_name=prefix+L"Ready",exit_name=prefix+L"Exit";
    HANDLE ready=CreateEventW(nullptr,TRUE,FALSE,ready_name.c_str()),exit=CreateEventW(nullptr,TRUE,FALSE,exit_name.c_str());
    wchar_t self[MAX_PATH]; check(GetModuleFileNameW(nullptr,self,MAX_PATH)!=0,"fixture image"); child_process child;
    start(L"\""+std::wstring(self)+L"\" --child "+ready_name+L" "+exit_name,child);
    check(WaitForSingleObject(ready,10000)==WAIT_OBJECT_0,"foreign PID offscreen window ready");
    using namespace ego_owned_runtime_policy;
    active=false; window_binding binding; check(binding.resolve()==nullptr,"foreign host does not bind");
    active=true; SetLastError(1234); check(binding.resolve()==nullptr && GetLastError()==1234,"foreign PID window refused and last error preserved");
    HWND first=make_window(); check(first!=nullptr,"owned offscreen window");
    if(binding.resolve()!=first) {
        std::cerr<<"binding diagnostic pid="<<GetCurrentProcessId()<<" first="<<first<<" visible="<<IsWindowVisible(first)<<" root="<<GetAncestor(first,GA_ROOT)<<" property="<<GetPropW(first,property_name)<<'\n';
        EnumWindows([](HWND w,LPARAM)->BOOL {DWORD pid=0;GetWindowThreadProcessId(w,&pid);if(pid==GetCurrentProcessId()) {wchar_t name[128]{};GetClassNameW(w,name,128);std::wcerr<<L"owned hwnd="<<w<<L" visible="<<IsWindowVisible(w)<<L" class="<<name<<L" root="<<GetAncestor(w,GA_ROOT)<<L'\n';}return TRUE;},0);
    }
    check(binding.resolve()==first,"unique exact PID visible window bound"); check(binding.resolve()==first,"stable binding");
    HWND second=make_window(); check(second!=nullptr,"second owned window"); check(binding.resolve()==nullptr,"ambiguous binding refuses");
    window_binding deferred; check(deferred.resolve()==nullptr,"initial ambiguity defers");
    ShowWindow(second,SW_HIDE); check(binding.resolve()==first && deferred.resolve()==first,"ambiguity resolves to original lifetime");
    RemovePropW(first,property_name); check(binding.resolve()==nullptr,"removed lifetime token refused");
    window_binding fresh; check(fresh.resolve()==first,"new swapchain can acquire new lifetime token"); check(binding.resolve()==nullptr,"old token remains refused");
    DestroyWindow(first); ShowWindow(second,SW_SHOWNOACTIVATE); check(fresh.resolve()==nullptr,"old binding cannot migrate to another HWND");
    window_binding recreated; check(recreated.resolve()==second,"recreated swapchain can bind current unique window");
    ShowWindow(second,SW_HIDE); check(recreated.resolve()==nullptr,"hidden window refuses"); ShowWindow(second,SW_SHOWNOACTIVATE);
    check(recreated.resolve()==second,"same visible lifetime resumes"); DestroyWindow(second);
    checks+=run_composition_lifecycle_contract();

    // Actual production ini_file implementation: global TutorialProgress written
    // by a secondary runtime can remain dirty after that runtime's local flush.
    g_reshade_base_path=std::filesystem::absolute(base/L"stage"); std::filesystem::create_directories(g_reshade_base_path);
    const auto ini=g_reshade_base_path/L"ReShade.ini"; {std::ofstream file(ini); file<<"[OVERLAY]\nTutorialProgress=0\n";}
    const auto original=read(ini); HANDLE guard=CreateFileW(ini.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr);
    check(guard!=INVALID_HANDLE_VALUE,"read-only sharing guard");
    auto cross_runtime=[&](bool owned) {
        reshade::ini_file::clear_cache(); active=owned;
        reshade::global_config().set("OVERLAY","TutorialProgress",4);
        const auto local_path=g_reshade_base_path/L"ReShade2.ini";
        reshade::ini_file::load_cache(local_path).set("OVERLAY","ShowClock",true);
        check(reshade::ini_file::flush_cache(local_path),"secondary local save completes");
        Sleep(1100); return reshade::ini_file::flush_cache();
    };
    check(!cross_runtime(false),"stock global dirty flush reproduces denied-write failure");
    const auto secondary=g_reshade_base_path/L"ReShade2.ini"; const auto secondary_before=read(secondary);
    check(cross_runtime(true),"owned global dirty flush succeeds in memory");
    check(read(ini)==original && read(secondary)==secondary_before,"owned INI bytes unchanged");
    DWORD access=0; HANDLE denied=CreateFileW(ini.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr); access=GetLastError();
    check(denied==INVALID_HANDLE_VALUE && access==ERROR_SHARING_VIOLATION,"write guard remains enforced");
    for(const auto *name:{L"ReShadePreset.ini",L"ReShadeVR.ini",L"ReShade100.ini",L"ego-late-1234abcd-01234567.ini"}) {
        const auto file=g_reshade_base_path/name; reshade::ini_file::load_cache(file).set("TEST","value",1);
        check(reshade::ini_file::flush_cache(file) && !std::filesystem::exists(file),"reserved owned config remains in memory");
    }
    for(const auto *name:{L"foreign.ini",L"ReShade0.ini",L"ReShade01.ini",L"ReShade101.ini",L"ego-late-invalid.ini"}) {
        const auto file=g_reshade_base_path/name; reshade::ini_file::load_cache(file).set("TEST","value",1);
        check(reshade::ini_file::flush_cache(file) && std::filesystem::exists(file),"non-reserved stock persistence unchanged");
    }
    const auto outside=std::filesystem::absolute(base/L"ReShade.ini"); reshade::ini_file::load_cache(outside).set("TEST","value",1);
    check(reshade::ini_file::flush_cache(outside)&&std::filesystem::exists(outside),"outside owned stage persistence unchanged");
    CloseHandle(guard); reshade::ini_file::clear_cache(); active=false;

    FILETIME creation {},ended {},kernel {},user {}; check(GetProcessTimes(child.value.hProcess,&creation,&ended,&kernel,&user)!=FALSE,"owned child birth");
    const auto birth=(std::uint64_t(creation.dwHighDateTime)<<32)|creation.dwLowDateTime;
    const auto args=L"--query-process-incarnation "+std::to_wstring(child.value.dwProcessId)+L" "+std::to_wstring(birth);
    auto live=query(manager,args); check(live.first==0 && live.second.find("\"state\":\"alive\"")!=std::string::npos,"live incarnation preserved");
    auto reused=query(manager,L"--query-process-incarnation "+std::to_wstring(child.value.dwProcessId)+L" "+std::to_wstring(birth+1));
    check(reused.first==0 && reused.second.find("\"state\":\"reused\"")!=std::string::npos,"different birth identified");
    SetEvent(exit); check(WaitForSingleObject(child.value.hProcess,10000)==WAIT_OBJECT_0,"child authoritative exit");
    auto image=query(manager,L"--query-process-image "+std::to_wstring(child.value.dwProcessId));
    check(image.first==5 && image.second.find("\"windowsError\":31")!=std::string::npos,"retained exited object reproduces image error 31");
    auto exited=query(manager,args); check(exited.first==0 && exited.second.find("\"state\":\"exited\"")!=std::string::npos && exited.second.find(std::to_string(birth))!=std::string::npos,"retained handle exact incarnation is signaled");
    auto absent=query(manager,L"--query-process-incarnation 4294967295 1"); check(absent.first==0 && absent.second.find("\"state\":\"absent\"")!=std::string::npos,"absent PID");
    for(const auto *invalid:{L"--query-process-incarnation 01 1",L"--query-process-incarnation 1 0",L"--query-process-incarnation 4294967296 1",L"--query-process-incarnation 1 18446744073709551616"}) check(query(manager,invalid).first!=0,"invalid identity rejected");
    CloseHandle(ready); CloseHandle(exit);
    std::cout<<"{\"status\":\"passed\",\"assertions\":"<<checks<<",\"retainedExitedImageError\":31,\"scope\":\"owned offscreen windows, production lifecycle branches and INI cache, read-only owned-child process queries; no graphics, injection, game or input acceptance\"}\n";
    return 0;
} catch(const std::exception &error) {std::cerr<<error.what()<<'\n';return 1;}
