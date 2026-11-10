#include <Windows.h>
#include <algorithm>
#include <vector>
#include <cstdio>
#include <stdexcept>
#include "readiness-types.hpp"
struct sample {initial_loader_state state;DWORD error=0;};
static std::vector<sample> samples;
static unsigned reads=0,waits=0;
static ULONGLONG clock_ms=0;
static bool frozen=false,exited=false,exit_after_wait=false,invalid=false;
static initial_loader_state test_inspect(HANDLE,DWORD &error){const auto &s=samples[(std::min)(reads++,static_cast<unsigned>(samples.size()-1))];error=s.error;return s.state;}
static ULONGLONG test_clock(){return clock_ms;}
static DWORD test_wait(HANDLE,DWORD milliseconds){++waits;if(invalid){SetLastError(ERROR_INVALID_HANDLE);return WAIT_FAILED;}if(exited)return WAIT_OBJECT_0;if(milliseconds){if(exit_after_wait)return WAIT_OBJECT_0;if(!frozen)clock_ms+=milliseconds;}return WAIT_TIMEOUT;}
#define inspect_initial_loader test_inspect
#define GetTickCount64 test_clock
#define WaitForSingleObject test_wait
#include "readiness-wait.hpp"
#undef inspect_initial_loader
#undef GetTickCount64
#undef WaitForSingleObject
static unsigned assertions=0,cases=0;
static void require(bool value){++assertions;if(!value)throw std::runtime_error("readiness assertion failed");}
static initial_loader_readiness_observation run(std::vector<sample> input,DWORD expected){samples=std::move(input);reads=waits=0;clock_ms=0;initial_loader_readiness_observation observation;require(wait_for_initial_loader(reinterpret_cast<HANDLE>(1),observation)==expected);++cases;return observation;}
int main(){try{
    using state=initial_loader_state;
    auto observation=run({{state::ready}},0);require(!observation.waited&&observation.attempts==1&&clock_ms==0);
    observation=run({{state::unavailable,ERROR_ACCESS_DENIED}},0);require(!observation.waited&&observation.windows_error==ERROR_ACCESS_DENIED&&observation.attempts==1&&clock_ms==0);
    for(auto pending:{state::not_created,state::not_initialized}){observation=run({{pending},{state::ready}},0);require(observation.waited&&observation.attempts==2&&clock_ms==10);}
    observation=run({{state::not_created},{state::unavailable,299}},299);require(observation.waited&&observation.attempts==2&&clock_ms==10);
    observation=run({{state::not_initialized},{state::unavailable,0}},ERROR_GEN_FAILURE);require(observation.waited&&observation.windows_error==ERROR_GEN_FAILURE);
    observation=run({{state::not_created}},ERROR_TIMEOUT);require(clock_ms==3000&&observation.waited&&observation.attempts<=320);
    frozen=true;observation=run({{state::not_initialized}},ERROR_TIMEOUT);require(observation.attempts==320&&clock_ms==0);frozen=false;
    exited=true;observation=run({{state::ready}},ERROR_PROCESS_ABORTED);require(observation.attempts==0&&reads==0);exited=false;
    exit_after_wait=true;observation=run({{state::not_created}},ERROR_PROCESS_ABORTED);require(observation.attempts==1&&reads==1);exit_after_wait=false;
    invalid=true;observation=run({{state::ready}},ERROR_INVALID_HANDLE);require(observation.attempts==0&&reads==0);invalid=false;
    printf("EGO_STARTUP_READINESS_SEAMS_PASSED cases=%u assertions=%u graphics=false injection=false processReopens=0\n",cases,assertions);return 0;
}catch(const std::exception &error){fprintf(stderr,"%s after %u assertions\n",error.what(),assertions);return 1;}}
