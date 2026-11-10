// Read-only exact-process window inventory. No injection, messages, input,
// activation, property mutation or game launch. Run beside the root-owned test.
#include <Windows.h>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <limits>
#include <sstream>
#include <string>
#include <vector>
#include <stdexcept>
static constexpr wchar_t property_name[]=L"ElectronGameOverlay.OwnedCompositionWindowV1";
static constexpr wchar_t auxiliary_property_name[]=L"ElectronGameOverlay.OwnedCompositionAuxiliaryV1";
struct window_record {HWND hwnd=nullptr,owner=nullptr;DWORD thread=0;LONG_PTR style=0,extended=0;HANDLE token=nullptr,auxiliary_token=nullptr;bool visible=false,root=false;std::wstring klass;};
struct inventory {DWORD pid=0;unsigned eligible=0;std::vector<window_record> windows;bool overflow=false;};
static std::uint64_t decimal(const wchar_t *text,std::uint64_t maximum){const std::wstring_view s(text);if(s.empty()||s[0]<L'1'||s[0]>L'9')throw std::runtime_error("canonical positive identity required");std::uint64_t value=0;for(const auto c:s){if(c<L'0'||c>L'9'||value>(maximum-unsigned(c-L'0'))/10)throw std::runtime_error("identity out of range");value=value*10+unsigned(c-L'0');}return value;}
static std::string escaped(const std::wstring &text){std::string result;for(const auto c:text){if(c==L'"'||c==L'\\'){result+='\\';result+=char(c);}else if(c>=32&&c<127)result+=char(c);else{char b[8];sprintf_s(b,"\\u%04x",unsigned(c));result+=b;}}return result;}
static std::string sample(DWORD pid){inventory result;result.pid=pid;SetLastError(0);
 const BOOL complete=EnumWindows([](HWND hwnd,LPARAM opaque)->BOOL{
  auto &all=*reinterpret_cast<inventory *>(opaque);DWORD pid=0;const auto thread=GetWindowThreadProcessId(hwnd,&pid);if(pid!=all.pid)return TRUE;
  if(all.windows.size()>=64){all.overflow=true;return FALSE;}
  window_record r;r.hwnd=hwnd;r.thread=thread;r.visible=IsWindowVisible(hwnd)!=FALSE;r.root=GetAncestor(hwnd,GA_ROOT)==hwnd;r.owner=GetWindow(hwnd,GW_OWNER);r.style=GetWindowLongPtrW(hwnd,GWL_STYLE);r.extended=GetWindowLongPtrW(hwnd,GWL_EXSTYLE);r.token=GetPropW(hwnd,property_name);r.auxiliary_token=GetPropW(hwnd,auxiliary_property_name);
  wchar_t klass[96]{};GetClassNameW(hwnd,klass,96);r.klass=klass;if(r.visible&&r.root)++all.eligible;all.windows.push_back(std::move(r));return TRUE;
 },reinterpret_cast<LPARAM>(&result));const auto error=GetLastError();
 std::ostringstream out;out<<"\"enumerationComplete\":"<<(complete?"true":"false")<<",\"enumerationError\":"<<(complete?0:error)<<",\"overflow\":"<<(result.overflow?"true":"false")<<",\"gen32EligibleCount\":"<<result.eligible<<",\"gen32UniquenessPass\":"<<(complete&&result.eligible==1?"true":"false")<<",\"windows\":[";
 bool comma=false;for(const auto &w:result.windows){if(comma)out<<',';comma=true;out<<"{\"hwnd\":\"0x"<<std::hex<<reinterpret_cast<std::uintptr_t>(w.hwnd)<<"\",\"owner\":\"0x"<<reinterpret_cast<std::uintptr_t>(w.owner)<<"\",\"compositionToken\":\"0x"<<reinterpret_cast<std::uintptr_t>(w.token)<<"\",\"auxiliaryToken\":\"0x"<<reinterpret_cast<std::uintptr_t>(w.auxiliary_token)<<"\",\"style\":\"0x"<<w.style<<"\",\"extendedStyle\":\"0x"<<w.extended<<"\",\"thread\":"<<std::dec<<w.thread<<",\"visible\":"<<(w.visible?"true":"false")<<",\"root\":"<<(w.root?"true":"false")<<",\"class\":\""<<escaped(w.klass)<<"\"}";}out<<']';return out.str();
}
int wmain(int argc,wchar_t **argv)try{
 if(argc!=5)throw std::runtime_error("Expected PID CREATION_TIME DURATION_MS NEW_ABSOLUTE_LOG_PATH");
 const auto pid=static_cast<DWORD>(decimal(argv[1],MAXDWORD));const auto expected=decimal(argv[2],(std::numeric_limits<std::uint64_t>::max)());const auto duration=decimal(argv[3],120000);
 const std::filesystem::path output=argv[4];if(!output.is_absolute())throw std::runtime_error("absolute new log path required");
 HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid);if(!process)throw std::runtime_error("read-only process query denied");
 struct close {HANDLE value;~close(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}} process_handle {process};
 FILETIME creation{},exit{},kernel{},user{};if(!GetProcessTimes(process,&creation,&exit,&kernel,&user)||((std::uint64_t(creation.dwHighDateTime)<<32)|creation.dwLowDateTime)!=expected)throw std::runtime_error("exact process creation identity mismatch");
 HANDLE log=CreateFileW(output.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);if(log==INVALID_HANDLE_VALUE)throw std::runtime_error("log must be a new writable file");close log_handle {log};
 const auto write=[&](const std::string &line){DWORD wrote=0;if(!WriteFile(log,line.data(),static_cast<DWORD>(line.size()),&wrote,nullptr)||wrote!=line.size())throw std::runtime_error("diagnostic write failed");};
 const auto started=GetTickCount64();unsigned records=0;std::string last;
 while(GetTickCount64()-started<duration&&records<96){const DWORD wait=WaitForSingleObject(process,0);if(wait==WAIT_OBJECT_0){write("{\"kind\":\"target-exited\"}\n");break;}if(wait!=WAIT_TIMEOUT)throw std::runtime_error("process exit signal unavailable");
  const auto current=sample(pid);if(current!=last){FILETIME utc{};GetSystemTimePreciseAsFileTime(&utc);const auto ticks=(std::uint64_t(utc.dwHighDateTime)<<32)|utc.dwLowDateTime;
   write("{\"schemaVersion\":1,\"kind\":\"ego-readonly-composition-window-inventory\",\"pid\":"+std::to_string(pid)+",\"creationTime100ns\":\""+std::to_string(expected)+"\",\"utcTime100ns\":\""+std::to_string(ticks)+"\",\"elapsedMs\":"+std::to_string(GetTickCount64()-started)+","+current+"}\n");last=current;++records;}
  Sleep(16);
 }
 write("{\"kind\":\"inventory-complete\",\"records\":"+std::to_string(records)+",\"budgetExhausted\":"+(records>=96?"true":"false")+"}\n");FlushFileBuffers(log);
 std::printf("{\"status\":\"passed\",\"records\":%u,\"readOnly\":true,\"input\":false,\"activation\":false}\n",records);return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}
