#define wmain production_injector_main
#include EGO_INJECTOR_SOURCE
#undef wmain
#include <thread>
struct owned_child {
    scoped_handle process,thread,job;
    DWORD pid=0;
    owned_child(){
        wchar_t image[32768]{};GetModuleFileNameW(nullptr,image,ARRAYSIZE(image));
        std::wstring command=L"\""+std::wstring(image)+L"\" --owned-child";
        STARTUPINFOW startup{sizeof(startup)};PROCESS_INFORMATION child{};
        if(!CreateProcessW(image,command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,nullptr,nullptr,&startup,&child))throw 1;
        process.handle=child.hProcess;thread.handle=child.hThread;pid=child.dwProcessId;
        job.handle=CreateJobObjectW(nullptr,nullptr);JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))||!AssignProcessToJobObject(job,process)){TerminateProcess(process,1);throw 2;}
    }
    ~owned_child(){if(WaitForSingleObject(process,0)!=WAIT_OBJECT_0){TerminateProcess(process,0);WaitForSingleObject(process,5000);}}
};
static DWORD strict_inspection(owned_child &child,initial_module_inspection_observation &observation){
    bool pinned=false,ready=false,participant=false;HMODULE runtime=nullptr;owned_late_d3d11_host late;
    return inspect_initial_host_readonly(child.process,child.pid,pinned,runtime,ready,participant,late,observation);
}
int wmain(int argc,wchar_t **argv){
    if(argc==2&&wcscmp(argv[1],L"--owned-child")==0){Sleep(INFINITE);return 0;}
    try{
        for(const bool negative_control:{true,false}){
            owned_child child;std::thread owner([&]{Sleep(800);ResumeThread(child.thread);});
            initial_module_inspection_observation inspection;DWORD before=0;
            if(negative_control)before=strict_inspection(child,inspection);
            initial_loader_readiness_observation readiness;const DWORD error=wait_for_initial_loader(child.process,readiness);
            const DWORD after=error==ERROR_SUCCESS?strict_inspection(child,inspection):error;owner.join();
            if((negative_control&&before!=ERROR_PARTIAL_COPY)||error!=ERROR_SUCCESS||after!=ERROR_SUCCESS||!readiness.waited||readiness.state!=initial_loader_state::ready) return 3;
            write_initial_loader_readiness(child.pid,readiness);
            printf("EGO_STARTUP_CASE {\"case\":\"owner-resumed-800ms\",\"negativeControl\":%s,\"oldInspectionError\":%lu,\"strictInspectionError\":%lu,\"sameHandle\":true,\"injection\":false}\n",negative_control?"true":"false",before,after);
        }
        {
            owned_child child;initial_loader_readiness_observation observation;
            const DWORD error=wait_for_initial_loader(child.process,observation);write_initial_loader_readiness(child.pid,observation);
            if(error!=ERROR_TIMEOUT||!observation.waited||observation.elapsed_ms<3000||observation.elapsed_ms>4500)return 4;
            printf("EGO_STARTUP_CASE {\"case\":\"forever-suspended\",\"windowsError\":%lu,\"injection\":false}\n",error);
        }
        {
            owned_child child;std::thread owner([&]{Sleep(100);TerminateProcess(child.process,0);});
            initial_loader_readiness_observation observation;DWORD error=wait_for_initial_loader(child.process,observation);owner.join();
            if(error!=ERROR_PROCESS_ABORTED||observation.elapsed_ms>1000)return 5;
            printf("EGO_STARTUP_CASE {\"case\":\"owner-exited\",\"windowsError\":%lu,\"injection\":false}\n",error);
        }
        {
            owned_child child;ResumeThread(child.thread);
            initial_loader_readiness_observation observation;DWORD error=wait_for_initial_loader(child.process,observation);
            initial_module_inspection_observation inspection;
            if(error!=ERROR_SUCCESS||strict_inspection(child,inspection)!=ERROR_SUCCESS)return 6;
            // An invalid handle exits before any loader query, rather than waiting.
            if(wait_for_initial_loader(nullptr,observation)==ERROR_SUCCESS||observation.attempts!=0)return 7;
        }
        printf("EGO_STARTUP_READINESS_PASSED cases=5 graphics=false injection=false ownerOnlyResume=true\n");return 0;
    }catch(int error){return 20+error;}
}
