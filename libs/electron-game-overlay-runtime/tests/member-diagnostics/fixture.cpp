// Exact production query/formatter functions; no injector entrypoint, DLL load,
// target VM operation, elevation request, impersonation or graphics is present.
#include <windows.h>
#include <string>
#include <vector>
#include <cstdio>
#include "handles.hpp"
#include "settings.hpp"
#include "json.hpp"
#include "writer.hpp"
enum class mode { actual, allowed, elevated, open_failed, elevation_failed, elevation_size, integrity_failed, integrity_size, integrity_sid, integrity_empty, integrity_high };
static mode selected_mode = mode::actual;
static unsigned opens = 0;
static BOOL WINAPI test_open_token(HANDLE process,DWORD access,PHANDLE token)
{
    ++opens;
    if(selected_mode==mode::open_failed){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}
    return OpenProcessToken(process,access,token);
}
static BOOL WINAPI test_token_information(HANDLE token,TOKEN_INFORMATION_CLASS kind,LPVOID data,DWORD capacity,PDWORD size)
{
    if(selected_mode==mode::actual)return GetTokenInformation(token,kind,data,capacity,size);
    if(kind==TokenElevation){
        if(selected_mode==mode::elevation_failed){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}
        *size=selected_mode==mode::elevation_size?1:sizeof(TOKEN_ELEVATION);
        reinterpret_cast<TOKEN_ELEVATION *>(data)->TokenIsElevated=selected_mode==mode::elevated?1:0;return TRUE;
    }
    if(selected_mode==mode::integrity_failed){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}
    *size=selected_mode==mode::integrity_size?1:sizeof(TOKEN_MANDATORY_LABEL)+SECURITY_MAX_SID_SIZE;
    auto label=reinterpret_cast<TOKEN_MANDATORY_LABEL *>(data);
    label->Label.Sid=selected_mode==mode::integrity_sid?nullptr:static_cast<BYTE *>(data)+sizeof(TOKEN_MANDATORY_LABEL);
    if(label->Label.Sid){SID_IDENTIFIER_AUTHORITY authority=SECURITY_MANDATORY_LABEL_AUTHORITY;InitializeSid(label->Label.Sid,&authority,selected_mode==mode::integrity_empty?0:1);if(selected_mode!=mode::integrity_empty)*GetSidSubAuthority(label->Label.Sid,0)=selected_mode==mode::integrity_high?SECURITY_MANDATORY_HIGH_RID:SECURITY_MANDATORY_MEDIUM_RID;}
    return TRUE;
}
#define OpenProcessToken test_open_token
#define GetTokenInformation test_token_information
#include "authorization.hpp"
#undef OpenProcessToken
#undef GetTokenInformation
int wmain(int argc,wchar_t **argv)
{
    if(argc==2&&wcscmp(argv[1],L"--owned-child")==0){Sleep(INFINITE);return 0;}
    wchar_t executable[32768]{};GetModuleFileNameW(nullptr,executable,ARRAYSIZE(executable));
    STARTUPINFOW startup{sizeof(startup)};PROCESS_INFORMATION child{};std::wstring command=L"\""+std::wstring(executable)+L"\" --owned-child";
    if(!CreateProcessW(executable,command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&child))return 1;
    scoped_handle process(child.hProcess),thread(child.hThread);
    preload_authorization_observation real_injector,real_target;
    DWORD real_error=require_unelevated_process(GetCurrentProcess(),&real_injector);
    if(real_error==ERROR_SUCCESS)real_error=require_unelevated_process(process,&real_target);
    write_preload_authorization_context(child.dwProcessId,process,real_injector,real_target);
    wprintf(L"EGO_AUTHORIZATION_REAL_RESULT {\"error\":%lu,\"uacRequested\":false,\"targetTokenChecked\":%s}\n",real_error,wcscmp(real_target.phase,L"not-checked")==0?L"false":L"true");
    const mode cases[]={mode::allowed,mode::elevated,mode::open_failed,mode::elevation_failed,mode::elevation_size,mode::integrity_failed,mode::integrity_size,mode::integrity_sid,mode::integrity_empty,mode::integrity_high};
    for(bool target_failure:{false,true})for(mode value:cases){
        preload_authorization_observation injector,target;opens=0;
        selected_mode=target_failure?mode::allowed:value;DWORD error=require_unelevated_process(GetCurrentProcess(),&injector);
        if(error==ERROR_SUCCESS){selected_mode=target_failure?value:mode::allowed;error=require_unelevated_process(process,&target);}
        if((error==ERROR_SUCCESS)!=(value==mode::allowed))return 2;
        if(!target_failure&&value!=mode::allowed&&(opens!=1||wcscmp(target.phase,L"not-checked")!=0))return 3;
        if(target_failure&&opens!=2)return 4;
        write_preload_authorization_context(child.dwProcessId,process,injector,target);
    }
    selected_mode=mode::actual;
    struct diagnostic_case {const wchar_t *code;DWORD error;bool preflight;bool postload;bool settings;bool module;};
    const diagnostic_case diagnostic_cases[]={
      {L"target-member-payload-invalid",2,true,true,false,false},{L"target-preloaded-member-selection-invalid",1306,true,true,false,false},
      {L"target-member-host-unavailable",1460,true,true,false,true},{L"target-member-disabled",1260,true,true,true,true},
      {L"target-preloaded-member-invalid",1306,true,true,false,false},{L"target-preloaded-member-elevation-rejected",5,true,false,false,false},
      {L"target-host-claim-failed",5,true,false,false,false},{L"target-first-host-preload-invalid",1306,false,true,false,false},
      {L"target-member-host-inspection-failed",299,false,true,false,false},{L"target-module-inspection-failed",299,true,true,false,true}};
    target_effective_reshade_settings settings;settings.reshade_base_path=L"C:\\owned\\host";settings.addon_directory_path=L"C:\\owned\\host\\addons";
    unsigned diagnostics=0;
    for(const auto &test:diagnostic_cases)for(bool after_load:{false,true}){
        if(after_load?!test.postload:!test.preflight)continue;
        if(!write_injector_diagnostic(test.code,4242,test.module?L"C:\\owned\\host\\dxgi.dll":L"",test.error,L"C:\\owned\\test.exe",test.settings?&settings:nullptr,after_load))return 5;
        ++diagnostics;
    }
    if(!TerminateProcess(process,0)||WaitForSingleObject(process,5000)!=WAIT_OBJECT_0)return 6;
    wprintf(L"EGO_MEMBER_DIAGNOSTICS_PASSED {\"authorizationSeamCases\":20,\"diagnosticCases\":%u,\"realQueries\":true,\"graphics\":false,\"injection\":false,\"ownedTargetExited\":true}\n",diagnostics);
    return 0;
}
