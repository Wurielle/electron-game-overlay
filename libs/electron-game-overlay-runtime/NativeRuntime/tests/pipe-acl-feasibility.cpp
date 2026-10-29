// Test-only, one-shot helper. No broker endpoints, impersonation or privilege changes.
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cstdint>
#include <cwchar>
#include <string>
#include <vector>
#include <memory>
#include <stdexcept>

namespace {
constexpr DWORD kRights = READ_CONTROL | WRITE_DAC;
struct Failure { const char* stage; DWORD code; };
void require(bool condition, const char* stage, DWORD code = ERROR_INVALID_DATA) {
  if (!condition) throw Failure{stage, code};
}
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
struct Descriptor {
  PSECURITY_DESCRIPTOR value = nullptr;
  ~Descriptor() { if (value) LocalFree(value); }
};
uint64_t integer(const wchar_t* text) {
  require(text && *text && *text != L'0', "arguments");
  uint64_t n = 0;
  for (const wchar_t* p = text; *p; ++p) {
    require(*p >= L'0' && *p <= L'9', "arguments");
    unsigned digit = *p - L'0';
    require(n <= (UINT64_MAX - digit) / 10, "arguments");
    n = n * 10 + digit;
  }
  return n;
}
DWORD parentPid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  require(snapshot.value != INVALID_HANDLE_VALUE, "parent-snapshot", GetLastError());
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  BOOL ok = Process32FirstW(snapshot.value, &entry);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok != FALSE, "parent-first", error);
  do { if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.value, &entry));
  throw Failure{"parent-missing", ERROR_NOT_FOUND};
}
uint64_t creation(HANDLE process) {
  FILETIME start{}, exit{}, kernel{}, user{};
  BOOL ok = GetProcessTimes(process, &start, &exit, &kernel, &user);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok != FALSE, "process-times", error);
  return (uint64_t(start.dwHighDateTime) << 32) | start.dwLowDateTime;
}
std::vector<BYTE> information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0;
  BOOL ok = GetTokenInformation(token, kind, nullptr, 0, &size);
  DWORD error = GetLastError();
  require(!ok && error == ERROR_INSUFFICIENT_BUFFER && size && size <= 16384,
    "token-size", error);
  std::vector<BYTE> data(size);
  ok = GetTokenInformation(token, kind, data.data(), size, &size);
  error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok && size <= data.size(), "token-query", error);
  return data;
}
bool sameSid(PSID a, PSID b) {
  return a && b && IsValidSid(a) && IsValidSid(b) && EqualSid(a, b);
}
void validName(const std::wstring& name, DWORD pid) {
  const std::wstring prefix = L"\\\\.\\pipe\\ego-acl-fixture-" + std::to_wstring(pid) + L"-";
  require(name.size() == prefix.size() + 36 && name.compare(0, prefix.size(), prefix) == 0,
    "private-name");
  for (size_t i = 0; i < 36; ++i) {
    wchar_t c = name[prefix.size() + i];
    bool dash = i == 8 || i == 13 || i == 18 || i == 23;
    require(dash ? c == L'-' : ((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f')),
      "private-name");
  }
}
HANDLE openClient(const wchar_t* name, const char* stage) {
  const ULONGLONG deadline = GetTickCount64() + 300;
  for (;;) {
    HANDLE pipe = CreateFileW(name, kRights, 0, nullptr, OPEN_EXISTING,
      SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    DWORD error = pipe == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    if (error != ERROR_PIPE_BUSY || GetTickCount64() >= deadline) throw Failure{stage, error};
    Sleep(5); // Same rights only; permit the Node event loop to replenish an instance.
  }
}
void checkPipe(HANDLE pipe, DWORD expected) {
  ULONG pid = 0;
  BOOL ok = GetNamedPipeServerProcessId(pipe, &pid);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok != FALSE, "kernel-server-pid", error);
  require(pid == expected, "server-pid-match");
}
void readDescriptor(HANDLE pipe, Descriptor& out, PSID& owner, PSID& group, PACL& acl) {
  DWORD error = GetSecurityInfo(pipe, SE_KERNEL_OBJECT,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, &group, &acl, nullptr, &out.value);
  require(error == ERROR_SUCCESS, "get-security", error);
}
bool ownerOnly(PSECURITY_DESCRIPTOR sd, PSID caller) {
  BOOL present = FALSE, defaulted = FALSE; PACL acl = nullptr;
  BOOL ok = GetSecurityDescriptorDacl(sd, &present, &acl, &defaulted);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok != FALSE, "get-dacl", error);
  if (!present || !acl || !IsValidAcl(acl) || acl->AceCount != 1) return false;
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  ok = GetSecurityDescriptorControl(sd, &control, &revision);
  error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok != FALSE, "get-control", error);
  if (!(control & SE_DACL_PROTECTED)) return false;
  void* raw = nullptr;
  ok = GetAce(acl, 0, &raw);
  error = ok ? ERROR_SUCCESS : GetLastError();
  require(ok != FALSE, "get-ace", error);
  const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
  return ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0 &&
    ace->Mask == FILE_ALL_ACCESS && sameSid(const_cast<DWORD*>(&ace->SidStart), caller);
}
}
int wmain(int argc, wchar_t** argv) {
  const char* operation = "invalid";
  try {
    require(argc == 3 || argc == 5, "arguments");
    bool identity = wcscmp(argv[1], L"identity") == 0;
    bool apply = wcscmp(argv[1], L"apply") == 0;
    bool inspect = wcscmp(argv[1], L"inspect") == 0;
    bool verify = wcscmp(argv[1], L"verify") == 0;
    require((identity && argc == 3) || ((apply || inspect || verify) && argc == 5), "arguments");
    operation = identity ? "identity" : apply ? "apply" : inspect ? "inspect" : "verify";
    uint64_t requestedPid = integer(argv[2]);
    require(requestedPid <= MAXDWORD && requestedPid == parentPid(), "own-parent-only");
    DWORD pid = static_cast<DWORD>(requestedPid);
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    require(process.value != nullptr, "open-server-process", GetLastError());
    uint64_t start = creation(process.value);
    Handle callerToken; Handle serverToken;
    BOOL ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &callerToken.value);
    DWORD error = ok ? ERROR_SUCCESS : GetLastError();
    require(ok != FALSE, "caller-token", error);
    ok = OpenProcessToken(process.value, TOKEN_QUERY, &serverToken.value);
    error = ok ? ERROR_SUCCESS : GetLastError();
    require(ok != FALSE, "server-token", error);
    auto caller = information(callerToken.value, TokenUser);
    auto server = information(serverToken.value, TokenUser);
    PSID user = reinterpret_cast<TOKEN_USER*>(caller.data())->User.Sid;
    require(sameSid(user, reinterpret_cast<TOKEN_USER*>(server.data())->User.Sid), "server-account-match");
    if (identity) {
      auto integrity = information(serverToken.value, TokenIntegrityLevel);
      auto elevation = information(serverToken.value, TokenElevation);
      auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(integrity.data());
      require(IsValidSid(label->Label.Sid) != FALSE, "integrity-sid");
      BYTE count = *GetSidSubAuthorityCount(label->Label.Sid);
      require(count > 0, "integrity-rid");
      DWORD rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
      bool elevated = reinterpret_cast<TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated != 0;
      std::printf("{\"schemaVersion\":1,\"nativeExecuted\":true,\"status\":\"passed\",\"stage\":\"identity\",\"serverPid\":%lu,\"creationTime\":\"%llu\",\"hostToken\":{\"integrityRid\":%lu,\"elevated\":%s}}\n",
        pid, static_cast<unsigned long long>(start), rid, elevated ? "true" : "false");
      return 0;
    }
    require(integer(argv[3]) == start, "server-creation-match");
    validName(argv[4], pid);
    Handle pipe(openClient(argv[4], "open-client-exact-rights"));
    checkPipe(pipe.value, pid);
    require(creation(process.value) == start, "creation-before-set");
    Descriptor before; PSID owner = nullptr, group = nullptr; PACL oldAcl = nullptr;
    readDescriptor(pipe.value, before, owner, group, oldAcl);
    require(sameSid(owner, user), "object-owner-match");
    // Retain six distinct client instances before narrowing, exceeding libuv's four pending accepts.
    std::vector<std::unique_ptr<Handle>> existing;
    if (apply) {
      for (unsigned i = 0; i < 5; ++i) {
        auto extra = std::make_unique<Handle>();
        extra->value = openClient(argv[4], "existing-instance-open");
        checkPipe(extra->value, pid);
        Descriptor original; PSID extraOwner = nullptr, extraGroup = nullptr; PACL extraAcl = nullptr;
        readDescriptor(extra->value, original, extraOwner, extraGroup, extraAcl);
        require(sameSid(extraOwner, user), "existing-instance-owner");
        existing.push_back(std::move(extra));
      }
      checkPipe(pipe.value, pid);
      require(creation(process.value) == start, "creation-immediately-before-set");
      DWORD length = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(user);
      std::vector<BYTE> storage(length); PACL acl = reinterpret_cast<PACL>(storage.data());
      ok = InitializeAcl(acl, length, ACL_REVISION);
      error = ok ? ERROR_SUCCESS : GetLastError(); require(ok != FALSE, "initialize-acl", error);
      ok = AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, user);
      error = ok ? ERROR_SUCCESS : GetLastError(); require(ok != FALSE, "add-owner-ace", error);
      // Select DACL only: owner, group, SACL and mandatory-integrity label are not changed.
      error = SetSecurityInfo(pipe.value, SE_KERNEL_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, acl, nullptr);
      require(error == ERROR_SUCCESS, "set-security-same-handle", error);
    }
    Descriptor after; PSID ownerAfter = nullptr, groupAfter = nullptr; PACL aclAfter = nullptr;
    readDescriptor(pipe.value, after, ownerAfter, groupAfter, aclAfter);
    require(sameSid(ownerAfter, owner) && sameSid(groupAfter, group), "owner-group-preserved");
    bool restricted = ownerOnly(after.value, user);
    if (apply || verify) require(restricted, "owner-only-dacl-readback");
    for (const auto& extra : existing) {
      checkPipe(extra->value, pid);
      Descriptor observed; PSID extraOwner = nullptr, extraGroup = nullptr; PACL extraAcl = nullptr;
      readDescriptor(extra->value, observed, extraOwner, extraGroup, extraAcl);
      require(sameSid(extraOwner, user) && sameSid(extraGroup, group) && ownerOnly(observed.value, user),
        "existing-instance-dacl-readback");
    }
    checkPipe(pipe.value, pid);
    require(creation(process.value) == start, "creation-after-readback");
    std::printf("{\"schemaVersion\":1,\"nativeExecuted\":true,\"status\":\"passed\",\"stage\":\"%s\",\"requestedRights\":393216,\"ownerOnlyProtectedDacl\":%s,\"sameHandleReadback\":true,\"serverInstanceMatched\":true,\"existingInstanceReadbacks\":%u}\n",
      operation, restricted ? "true" : "false", static_cast<unsigned>(existing.size() + 1));
    return 0;
  } catch (const Failure& error) {
    std::printf("{\"schemaVersion\":1,\"nativeExecuted\":true,\"status\":\"failed\",\"operation\":\"%s\",\"stage\":\"%s\",\"requestedRights\":393216,\"win32Error\":%lu}\n", operation, error.stage, error.code);
    return 1;
  } catch (...) {
    std::puts("{\"schemaVersion\":1,\"nativeExecuted\":true,\"status\":\"failed\",\"stage\":\"allocation-or-unexpected\",\"requestedRights\":393216}");
    return 1;
  }
}
