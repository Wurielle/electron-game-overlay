// This test owner sets ONLY its own new process object's DACL, atomically at
// CreateProcess. Retained creation handles and a kill-on-close job own cleanup.
#include <windows.h>
#include <string>
#include <vector>
#include <cstdio>
struct handle {
    HANDLE value;
    explicit handle(HANDLE value = nullptr) : value(value) {}
    ~handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    handle(const handle &) = delete;
    operator HANDLE() const { return value; }
};
static std::string utf8(const std::wstring &value)
{
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}
static std::string escaped(const std::wstring &value)
{
    std::string result;
    for (const char ch : utf8(value)) { if (ch == '\\' || ch == '"') result += '\\'; result += ch; }
    return result;
}
static bool emit(const std::string &line)
{
    const std::string bytes = line + "\n"; DWORD written = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
}
int wmain(int argc, wchar_t **)
{
    if (argc != 1) { fprintf(stderr, "usage: owned_access_refusal_owner.exe (stdin: exit)\n"); return 1; }
    wchar_t module[32768]{};
    if (!GetModuleFileNameW(nullptr, module, ARRAYSIZE(module))) return 2;
    std::wstring target(module); target.resize(target.find_last_of(L'\\') + 1); target += L"owned_access_refused_target.exe";
    const DWORD attributes = GetFileAttributesW(target.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return 3;
    HANDLE raw_token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) return 4;
    handle token(raw_token); DWORD token_bytes = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &token_bytes);
    std::vector<BYTE> token_data(token_bytes);
    if (!GetTokenInformation(token, TokenUser, token_data.data(), token_bytes, &token_bytes)) return 5;
    const PSID user = reinterpret_cast<TOKEN_USER *>(token_data.data())->User.Sid;
    const DWORD sid_bytes = GetLengthSid(user);
    std::vector<BYTE> acl_data(sizeof(ACL) + 2 * (sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + sid_bytes));
    const auto acl = reinterpret_cast<PACL>(acl_data.data());
    const DWORD denied = PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_DUP_HANDLE;
    const DWORD allowed = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | READ_CONTROL;
    SECURITY_DESCRIPTOR descriptor{};
    if (!InitializeAcl(acl, static_cast<DWORD>(acl_data.size()), ACL_REVISION) ||
        !AddAccessDeniedAce(acl, ACL_REVISION, denied, user) || !AddAccessAllowedAce(acl, ACL_REVISION, allowed, user) ||
        !InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&descriptor, user, FALSE) || !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE)) return 6;
    handle job(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.value || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 7;
    SECURITY_ATTRIBUTES security{sizeof(security), &descriptor, FALSE};
    STARTUPINFOW startup{sizeof(startup)}; PROCESS_INFORMATION child{};
    std::wstring command = L"\"" + target + L"\"";
    if (!CreateProcessW(target.c_str(), command.data(), &security, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 8;
    handle process(child.hProcess), thread(child.hThread);
    if (!AssignProcessToJobObject(job, process)) { TerminateProcess(process, 9); return 9; }
    FILETIME created{}, ended{}, kernel{}, user_time{};
    if (!GetProcessTimes(process, &created, &ended, &kernel, &user_time)) return 10;
    const unsigned long long birth = (static_cast<unsigned long long>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    handle query(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, child.dwProcessId));
    wchar_t actual[32768]{}; DWORD length = ARRAYSIZE(actual);
    if (!query.value || !QueryFullProcessImageNameW(query, 0, actual, &length) || _wcsicmp(actual, target.c_str())) return 11;
    FILETIME queried{}, ignored_end{}, ignored_kernel{}, ignored_user{};
    if (!GetProcessTimes(query, &queried, &ignored_end, &ignored_kernel, &ignored_user) ||
        queried.dwHighDateTime != created.dwHighDateTime || queried.dwLowDateTime != created.dwLowDateTime) return 12;
    SetLastError(ERROR_SUCCESS);
    handle forbidden(OpenProcess(denied | PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, child.dwProcessId));
    const DWORD refusal = GetLastError();
    if (forbidden.value || refusal != ERROR_ACCESS_DENIED || ResumeThread(thread) == static_cast<DWORD>(-1)) return 13;
    const std::string identity = "\"pid\":" + std::to_string(child.dwProcessId) + ",\"creationTime100ns\":\"" + std::to_string(birth) + "\",\"executablePath\":\"" + escaped(target) + "\"";
    if (!emit("{\"kind\":\"EGO_OWNED_ACCESS_REFUSAL_V1\",\"ready\":true," + identity + ",\"ownerPid\":" + std::to_string(GetCurrentProcessId()) + ",\"readOnlyIdentityVerified\":true,\"fullAccessWindowsError\":5}")) return 14;
    std::string instruction; char ch = 0; DWORD read = 0;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &ch, 1, &read, nullptr) && read == 1 && ch != '\n' && instruction.size() < 16) instruction += ch;
    if (!instruction.empty() && instruction.back() == '\r') instruction.pop_back();
    if (!TerminateProcess(process, 0) || WaitForSingleObject(process, 5000) != WAIT_OBJECT_0) return 15;
    const bool requested = instruction == "exit";
    emit("{\"kind\":\"EGO_OWNED_ACCESS_REFUSAL_V1\",\"exited\":true," + identity + ",\"retainedHandle\":true,\"requested\":" + (requested ? "true" : "false") + "}");
    return requested || instruction.empty() ? 0 : 16;
}
