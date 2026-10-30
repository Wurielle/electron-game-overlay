"""Nonshipping portable seam: exact expanded production helpers, controlled WinAPI.
Usage: python process-instance-binding-unit.py EXPANDED_INJECTOR CXX [CXX_ARGS...]
This is not Windows injection, token or whole-injector build acceptance.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(sys.argv[1]).read_text()
helpers = source[source.index('// Exact process-instance binding helpers.'):source.index('static bool parse_process_id(')]
guard = source[source.index('\t// Bind the retained mutation handle'):source.index('\t// Check process architecture', source.index('int wmain'))]
main = source[source.index('int wmain'):]
assert main.count('OpenProcess(') == 1
assert main.index('QueryFullProcessImageNameW(') < main.index('Target process executable mismatch:') < main.index('check_process_creation_time(')
for operation in ['IsWow64Process(', 'acquire_injection_claim(', 'inspect_target_for_reshade(', 'update_acl_for_uwp(', 'VirtualAllocEx(', 'WriteProcessMemory(', 'CreateRemoteThread(']:
    assert main.index('check_process_creation_time(') < main.index(operation), operation
assert 'GetProcessTimes(process, &created, &exited, &kernel, &user)' in helpers
prefix = r'''
#include <cstdint>
#include <cstddef>
#include <cwchar>
#include <string>
#include <vector>
#include <cstdio>
#include <cstdlib>
using DWORD = uint32_t;
using HANDLE = void *;
struct FILETIME { DWORD dwLowDateTime, dwHighDateTime; };
constexpr DWORD ERROR_SUCCESS=0, ERROR_INVALID_DATA=13, ERROR_REVISION_MISMATCH=1306, ERROR_WRITE_FAULT=29;
static HANDLE owned = reinterpret_cast<HANDLE>(uintptr_t(42));
static uint64_t observed = 9007199254740993ULL;
static DWORD query_error = 0;
static bool query_ok = true, diagnostic_ok = true;
static int queries=0, errors=0, mutations=0, diagnostics=0, checks=0;
static bool expecting_error=false;
static std::wstring diagnostic_code;
#define CHECK(x) do { ++checks; if (!(x)) { std::fprintf(stderr,"check failed line %d: %s\n",__LINE__,#x); std::exit(1); } } while(0)
static bool GetProcessTimes(HANDLE h, FILETIME *c, FILETIME *e, FILETIME *k, FILETIME *u) {
 CHECK(h==owned); CHECK(!expecting_error); ++queries;
 CHECK(c->dwLowDateTime==0 && c->dwHighDateTime==0);
 CHECK(e->dwLowDateTime==0 && e->dwHighDateTime==0);
 CHECK(k->dwLowDateTime==0 && k->dwHighDateTime==0);
 CHECK(u->dwLowDateTime==0 && u->dwHighDateTime==0);
 if (!query_ok) { expecting_error=true; return false; }
 c->dwLowDateTime=DWORD(observed); c->dwHighDateTime=DWORD(observed>>32); return true;
}
static DWORD GetLastError() { CHECK(expecting_error); expecting_error=false; ++errors; return query_error; }
static bool write_injector_diagnostic(const wchar_t *code,DWORD pid,const std::wstring &module,DWORD error,const std::wstring &path) {
 CHECK(!expecting_error); CHECK(pid==71); CHECK(module.empty()); CHECK(error!=0); CHECK(path==L"C:\\owned\\fixture.exe"); ++diagnostics; diagnostic_code=code; return diagnostic_ok;
}
static void print_injection_not_started() { CHECK(!expecting_error); }
'''
wrapper = '''\nstatic int run(HANDLE remote_process, uint64_t expected_creation_time, bool process_instance_binding_requested) {
const DWORD pid=71;
const std::wstring selected_image_path=L"C:\\\\owned\\\\fixture.exe";
''' + guard + '''CHECK(remote_process==owned); ++mutations; return 0; }\n'''
tests = r'''
int main() {
 uint64_t value=0;
 CHECK(parse_creation_time_100ns(L"18446744073709551615",value) && value==UINT64_MAX);
 CHECK(parse_creation_time_100ns(L"9007199254740993",value) && value==9007199254740993ULL);
 CHECK(parse_creation_time_100ns(L"1",value) && value==1);
 CHECK(!parse_creation_time_100ns(nullptr,value));
 for (const wchar_t *bad : {L"",L"0",L"00",L"01",L"+1",L"-1",L" 1",L"1 ",L"1.0",L"1e3",L"18446744073709551616",L"999999999999999999999",L"１２",L"1x"}) CHECK(!parse_creation_time_100ns(bad,value));
 auto tail=[](std::vector<std::wstring> args,bool want_binding,bool want_wait) {
  std::vector<wchar_t *> argv; for(auto &arg:args) argv.push_back(arg.data());
  uint64_t expected=0; bool binding=false,wait=false; int index=0;
  bool ok=parse_exact_pid_tail(int(argv.size()),argv.data(),expected,binding,wait,index);
  if(ok) { CHECK(binding==want_binding); CHECK(wait==want_wait); if(binding) CHECK(expected==9007199254740993ULL); if(wait) CHECK(args[index]==L"50"); }
  return ok;
 };
 CHECK(tail({L"inject",L"fixture.exe",L"--pid",L"71"},false,false));
 CHECK(tail({L"inject",L"fixture.exe",L"--pid",L"71",L"--wait-for-official-addon",L"50"},false,true));
 CHECK(tail({L"inject",L"fixture.exe",L"--pid",L"71",L"--expected-creation-time-100ns",L"9007199254740993"},true,false));
 CHECK(tail({L"inject",L"fixture.exe",L"--pid",L"71",L"--expected-creation-time-100ns",L"9007199254740993",L"--wait-for-official-addon",L"50"},true,true));
 for(auto suffix : std::vector<std::vector<std::wstring>>{{L"--expected-creation-time-100ns"},{L"--expected-creation-time-100ns",L"0"},{L"--expected-creation-time-100ns",L"9007199254740993",L"tail"},{L"--expected-creation-time-100ns",L"9007199254740993",L"--expected-creation-time-100ns",L"1"},{L"--wait-for-official-addon",L"50",L"--expected-creation-time-100ns",L"1"}}) {
  std::vector<std::wstring> args={L"inject",L"fixture.exe",L"--pid",L"71"}; args.insert(args.end(),suffix.begin(),suffix.end()); CHECK(!tail(args,false,false));
 }
 CHECK(run(owned,observed,true)==0); CHECK(mutations==1);
 CHECK(run(owned,observed+1,true)==1306); CHECK(mutations==1); CHECK(diagnostic_code==L"target-process-instance-mismatch");
 query_ok=false; query_error=5;
 CHECK(run(owned,observed,true)==5); CHECK(errors==1 && !expecting_error); CHECK(mutations==1); CHECK(diagnostic_code==L"target-process-instance-query-failed");
 query_error=0; CHECK(run(owned,observed,true)==13); CHECK(errors==2 && !expecting_error);
 query_error=1306; CHECK(run(owned,observed,true)==1306); CHECK(diagnostic_code==L"target-process-instance-query-failed");
 query_ok=true; observed=0; CHECK(run(owned,1,true)==13); CHECK(mutations==1);
 observed=UINT64_MAX; CHECK(run(owned,UINT64_MAX,true)==0); CHECK(mutations==2);
 diagnostic_ok=false; CHECK(run(owned,1,true)==29); CHECK(mutations==2);
 const int before=queries; CHECK(run(owned,1,false)==0); CHECK(queries==before); CHECK(mutations==3);
 std::printf("{\"status\":\"passed\",\"nativeExecuted\":false,\"checks\":%d,\"queries\":%d,\"immediateErrorCaptures\":%d,\"controlledContinuationCount\":%d}\n",checks,queries,errors,mutations);
}
'''
with tempfile.TemporaryDirectory(prefix='binding-unit-') as temporary:
    path=Path(temporary); unit=path/'unit.cpp'; binary=path/'unit'; unit.write_text(prefix+helpers+wrapper+tests)
    subprocess.run([sys.argv[2],*sys.argv[3:],'-std=c++17',str(unit),'-o',str(binary)],check=True,timeout=90)
    result=subprocess.run([str(binary)],check=True,text=True,capture_output=True,timeout=10)
    print(result.stdout,end='')
print(json.dumps({'sourceOrderingProof':'passed','nativeExecuted':False,'scope':'actual production helper and guard extraction; controlled WinAPI; not whole native build'}))
