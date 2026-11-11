// TEST ONLY: one asynchronous repaint request, never a Present or injection.
#include <Windows.h>
#include <cstdio>
#include <cwchar>
#include <cerrno>
#include <cstdint>
static bool parse(const wchar_t *s,unsigned long long &n,int base) {
  if(!s || !*s || *s==L'-' || *s==L'+') return false;
  wchar_t *end=nullptr; errno=0; n=wcstoull(s,&end,base); return errno==0 && end && *end==0 && n!=0;
}
int wmain(int argc,wchar_t **argv) {
  unsigned long long pid=0,birth=0,window=0,thread=0;
  if(argc!=5 || !parse(argv[1],pid,10) || pid>MAXDWORD || !parse(argv[2],birth,10) ||
    !parse(argv[3],window,0) || window>UINTPTR_MAX || !parse(argv[4],thread,10) || thread>MAXDWORD) return 64;
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(pid));
  if(!process) return 65;
  FILETIME created={},exited={},kernel={},user={}; ULARGE_INTEGER exact={};
  const bool times=GetProcessTimes(process,&created,&exited,&kernel,&user)!=FALSE;
  exact.LowPart=created.dwLowDateTime; exact.HighPart=created.dwHighDateTime;
  HWND hwnd=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(window));
  DWORD owner=0; const DWORD owner_thread=GetWindowThreadProcessId(hwnd,&owner);
  if(!times || exact.QuadPart!=birth || owner!=pid || owner_thread!=thread ||
    !IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd) || WaitForSingleObject(process,0)!=WAIT_TIMEOUT) {
    CloseHandle(process); std::fputs("Target identity or current window state differs; no repaint requested.\n",stderr); return 66;
  }
  // Recheck both authoritative identities immediately before the single call.
  owner=0;
  if(GetWindowThreadProcessId(hwnd,&owner)!=thread || owner!=pid || WaitForSingleObject(process,0)!=WAIT_TIMEOUT) {
    CloseHandle(process); return 67;
  }
  SetLastError(ERROR_SUCCESS); const BOOL accepted=InvalidateRect(hwnd,nullptr,FALSE); const DWORD error=accepted?0:GetLastError();
  std::printf("{\"kind\":\"test-only-exact-target-repaint\",\"pid\":%llu,\"creationTime100ns\":\"%llu\",\"hwnd\":\"0x%llx\",\"threadId\":%llu,\"accepted\":%s,\"win32Error\":%lu,\"forcedPresent\":false,\"injection\":false}\n",pid,birth,window,thread,accepted?"true":"false",error);
  CloseHandle(process); return accepted?0:68;
}
