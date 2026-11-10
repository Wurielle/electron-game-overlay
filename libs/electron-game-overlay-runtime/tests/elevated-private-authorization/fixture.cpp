// Complete pinned production source; its entrypoint is never called. Only
// token queries, pure authorization and private-stage inspection run here.
#define wmain production_injector_main
#include EGO_INJECTOR_SOURCE
#undef wmain
#include <stdexcept>
static unsigned assertions=0,cases=0;
static void require(bool condition){++assertions;if(!condition)throw std::runtime_error("authorization assertion failed");}
static void policy(attachment_token_context caller,attachment_token_context target,DWORD expected,const wchar_t *phase){const wchar_t *observed=L"unset";require(authorize_attachment_tokens(caller,target,observed)==expected);require(wcscmp(observed,phase)==0);++cases;}
int wmain(int argc,wchar_t **argv){
  if(argc==2&&wcscmp(argv[1],L"--owned-child")==0){Sleep(INFINITE);return 0;}
  try{
    wchar_t executable[32768]{};require(GetModuleFileNameW(nullptr,executable,ARRAYSIZE(executable))>0);
    STARTUPINFOW startup{sizeof(startup)};PROCESS_INFORMATION child{};std::wstring command=L"\""+std::wstring(executable)+L"\" --owned-child";
    require(CreateProcessW(executable,command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&child)!=FALSE);
    scoped_handle process(child.hProcess),thread(child.hThread),job(CreateJobObjectW(nullptr,nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))||!AssignProcessToJobObject(job,process)){TerminateProcess(process,1);throw std::runtime_error("owned job failed");}
    attachment_token_context caller,target;
    const DWORD caller_error=read_attachment_token(GetCurrentProcess(),caller);
    if(caller_error)fwprintf(stderr,L"caller token phase=%ls error=%lu\n",caller.phase,caller_error);
    require(caller_error==ERROR_SUCCESS);
    const DWORD target_error=read_attachment_token(process,target);
    if(target_error)fwprintf(stderr,L"target token phase=%ls error=%lu\n",target.phase,target_error);
    require(target_error==ERROR_SUCCESS);
    const wchar_t *phase=L"unset";require(authorize_attachment_tokens(caller,target,phase)==ERROR_SUCCESS);
    require(write_attachment_authorization(child.dwProcessId,process,caller,target,0,phase));
    auto medium=caller;medium.known=true;medium.elevated=false;medium.integrity=SECURITY_MANDATORY_MEDIUM_RID;
    auto high=medium;high.elevated=true;high.integrity=SECURITY_MANDATORY_HIGH_RID;
    policy(medium,medium,0,L"allowed");policy(high,medium,0,L"allowed-private-elevated");policy(high,high,0,L"allowed-private-elevated");
    policy(medium,high,ERROR_ACCESS_DENIED,L"target-integrity-above-caller");
    auto low=medium;low.integrity=SECURITY_MANDATORY_LOW_RID;
    policy(low,medium,ERROR_ACCESS_DENIED,L"target-integrity-above-caller");policy(medium,low,0,L"allowed");
    auto other=medium;other.user_sid.push_back(0);policy(high,other,ERROR_ACCESS_DENIED,L"user-mismatch");
    other=medium;++other.session;policy(high,other,ERROR_ACCESS_DENIED,L"interactive-session-mismatch");
    other=medium;other.session=0;auto zero=high;zero.session=0;policy(zero,other,ERROR_ACCESS_DENIED,L"interactive-session-mismatch");
    other=high;other.integrity=SECURITY_MANDATORY_SYSTEM_RID;policy(high,other,ERROR_ACCESS_DENIED,L"unsupported-integrity");
    policy(other,high,ERROR_ACCESS_DENIED,L"unsupported-integrity");
    other=medium;other.elevated=true;policy(high,other,ERROR_ACCESS_DENIED,L"unsupported-integrity");
    other=high;other.elevated=false;policy(high,other,ERROR_ACCESS_DENIED,L"unsupported-integrity");
    other=medium;other.integrity=SECURITY_MANDATORY_MEDIUM_RID+0x100;policy(high,other,ERROR_ACCESS_DENIED,L"unsupported-integrity");
    other=medium;other.known=false;policy(high,other,ERROR_INVALID_DATA,L"token-context-incomplete");
    other=medium;other.user_sid.clear();policy(high,other,ERROR_INVALID_DATA,L"token-context-incomplete");
    attachment_token_context invalid;require(read_attachment_token(nullptr,invalid)!=ERROR_SUCCESS);require(!invalid.known);++cases;
    {
      private_elevated_stage_guard guard;
      BYTE expected_runtime[32]{},expected_addon[32]{},expected_ini[32]{};
      if(caller.elevated){std::wstring addon;require(staged_participant_path(addon)==0);scoped_handle addon_guard,runtime_guard,ini_guard;require(hash_immutable_native_file(addon,addon_guard,expected_addon)==0);require(hash_immutable_native_file(addon.substr(0,addon.find_last_of(L'\\'))+L"\\"+target_reshade_runtime_file,runtime_guard,expected_runtime)==0);require(hash_immutable_native_file(addon.substr(0,addon.find_last_of(L'\\'))+L"\\ReShade.ini",ini_guard,expected_ini)==0);}
      const DWORD error=validate_private_elevated_stage(guard,caller,expected_runtime,expected_addon,expected_ini);
      if(caller.elevated){require(error==ERROR_SUCCESS);
        // Every alias of each about-to-be-consumed image is write-locked.
        std::wstring addon;require(staged_participant_path(addon)==0);
        scoped_handle write(CreateFileW(addon.c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,0,nullptr));
        require(write==INVALID_HANDLE_VALUE);require(GetLastError()==ERROR_SHARING_VIOLATION||GetLastError()==ERROR_ACCESS_DENIED);
      }else require(error!=ERROR_SUCCESS);
      ++cases;
    }
    require(TerminateProcess(process,0)!=FALSE);require(WaitForSingleObject(process,5000)==WAIT_OBJECT_0);
    printf("EGO_ELEVATED_PRIVATE_AUTHORIZATION_PASSED {\"cases\":%u,\"assertions\":%u,\"actualCallerElevated\":%s,\"actualCallerIntegrity\":%lu,\"ownedTargetExited\":true,\"graphics\":false,\"injection\":false,\"targetThreadResumed\":false}\n",cases,assertions,caller.elevated?"true":"false",caller.integrity);
    return 0;
  }catch(const std::exception &error){fprintf(stderr,"%s assertions=%u\n",error.what(),assertions);return 1;}
}
