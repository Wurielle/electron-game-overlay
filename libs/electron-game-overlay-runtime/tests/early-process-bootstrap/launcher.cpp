// Starts only the fixed controlled host beside this owned launcher.
// No process discovery, existing-process attachment, registry or game writes.
#include <windows.h>
#include "detours.h"
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
namespace
{
    volatile LONG create_calls = 0;
    BOOL WINAPI create_only_owned_target(LPCWSTR application, LPWSTR command,
        LPSECURITY_ATTRIBUTES process_attributes, LPSECURITY_ATTRIBUTES thread_attributes,
        BOOL inherit_handles, DWORD flags, LPVOID environment, LPCWSTR current_directory,
        LPSTARTUPINFOW startup, LPPROCESS_INFORMATION process_information)
    {
        // Detours can otherwise start an unbound rundll32 fallback helper and
        // wait indefinitely for it. This matching-architecture proof needs only
        // the first controlled target. Every fallback is a failed proof.
        if (InterlockedIncrement(&create_calls) != 1)
        {
            SetLastError(ERROR_NOT_SUPPORTED);
            return FALSE;
        }
        return CreateProcessW(application, command, process_attributes, thread_attributes,
            inherit_handles, flags, environment, current_directory, startup, process_information);
    }
    struct process_handles
    {
        PROCESS_INFORMATION info = {};
        HANDLE job = nullptr;
        ~process_handles()
        {
            if (job) CloseHandle(job);
            if (info.hThread) CloseHandle(info.hThread);
            if (info.hProcess) CloseHandle(info.hProcess);
        }
    };
    bool regular(const fs::path &path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        return attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
    }
    std::string utf8(const std::wstring &value)
    {
        const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
            value.data(), int(value.size()), nullptr, 0, nullptr, nullptr);
        if (length <= 0) throw std::runtime_error("UTF-8 conversion");
        std::string result(size_t(length), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), int(value.size()),
            result.data(), length, nullptr, nullptr) != length)
            throw std::runtime_error("UTF-8 conversion");
        return result;
    }
    std::string quote(const std::string &value)
    {
        std::ostringstream text;
        text << '"';
        for (unsigned char c : value)
        {
            if (c == '"' || c == '\\') text << '\\' << c;
            else if (c < 32) text << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c);
            else text << c;
        }
        return text.str() + '"';
    }
}

int wmain()
{
    wchar_t executable[32768] = {};
    const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
    if (length == 0 || length >= 32768) return 2;
    const fs::path directory = fs::canonical(fs::path(executable)).parent_path();
    const fs::path host = directory / L"early_process_bootstrap_host.exe";
#ifdef _WIN64
    const fs::path bootstrap = directory / L"early_process_bootstrap64.dll";
#else
    const fs::path bootstrap = directory / L"early_process_bootstrap32.dll";
#endif
    const fs::path original = directory / L"early_original_graphics.dll";
    const fs::path marker = directory / L"owned-run.txt";
    const fs::path trace = directory / L"trace.ndjson";
    if (!regular(host) || !regular(bootstrap) || !regular(original) ||
        !regular(marker) || !regular(trace)) return 3;
    std::ifstream marker_input(marker, std::ios::binary);
    const std::string marker_value((std::istreambuf_iterator<char>(marker_input)), {});
    if (marker_value != "EGO_EARLY_PROCESS_BOOTSTRAP_V1\n") return 4;

    process_handles child;
    DWORD error = ERROR_SUCCESS;
    DWORD exit_code = STILL_ACTIVE;
    DWORD previous_suspend_count = DWORD(-1);
    ULONGLONG creation_time = 0;
    bool identity_verified = false;
    bool job_bound = false;
    bool resumed = false;
    bool timed_out = false;
    bool terminated_owned_child = false;
    bool passed = false;
    std::string phase = "create-owned-child-first-import";
    try
    {
        child.job = CreateJobObjectW(nullptr, nullptr);
        if (!child.job) { error = GetLastError(); throw std::runtime_error("owned job create failed"); }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(child.job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        { error = GetLastError(); throw std::runtime_error("owned job limit failed"); }
        STARTUPINFOEXW startup = {};
        startup.StartupInfo.cb = sizeof(startup);
        SIZE_T attribute_bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
        if (attribute_bytes == 0) { error = GetLastError(); throw std::runtime_error("job attributes size failed"); }
        std::vector<unsigned char> attribute_storage(attribute_bytes);
        startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes))
        { error = GetLastError(); throw std::runtime_error("job attributes init failed"); }
        struct attribute_cleanup
        {
            LPPROC_THREAD_ATTRIBUTE_LIST value;
            ~attribute_cleanup() { DeleteProcThreadAttributeList(value); }
        } attributes{ startup.lpAttributeList };
        if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
            &child.job, sizeof(child.job), nullptr, nullptr))
        { error = GetLastError(); throw std::runtime_error("owned job attribute failed"); }
        std::wstring command = L"\"" + host.wstring() + L"\" --frames 60";
        const std::string bootstrap_utf8 = utf8(bootstrap.wstring());
        if (!DetourCreateProcessWithDllExW(host.c_str(), command.data(), nullptr, nullptr,
            FALSE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
                EXTENDED_STARTUPINFO_PRESENT, nullptr,
            directory.c_str(), &startup.StartupInfo, &child.info, bootstrap_utf8.c_str(), create_only_owned_target))
        {
            error = GetLastError();
            // Detours 4.0.1 closes these output handles itself when import
            // rewriting/helper setup fails, but leaves their values nonzero.
            // A FALSE return grants no valid process/thread output ownership.
            child.info = {};
            throw std::runtime_error("first-import create failed");
        }
        BOOL in_job = FALSE;
        if (!IsProcessInJob(child.info.hProcess, child.job, &in_job) || !in_job)
        { error = GetLastError(); throw std::runtime_error("owned child job binding failed"); }
        job_bound = true;
        phase = "verify-owned-child-identity";
        wchar_t image[32768] = {};
        DWORD image_length = 32768;
        FILETIME created = {}, exited = {}, kernel = {}, user = {};
        if (!QueryFullProcessImageNameW(child.info.hProcess, 0, image, &image_length) ||
            !GetProcessTimes(child.info.hProcess, &created, &exited, &kernel, &user))
        {
            error = GetLastError();
            throw std::runtime_error("child identity query failed");
        }
        creation_time = (ULONGLONG(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        identity_verified = creation_time != 0 &&
            GetProcessId(child.info.hProcess) == child.info.dwProcessId &&
            _wcsicmp(fs::canonical(fs::path(image)).c_str(), host.c_str()) == 0;
        if (!identity_verified) { error = ERROR_INVALID_DATA; throw std::runtime_error("child identity mismatch"); }
        phase = "resume-owned-child";
        previous_suspend_count = ResumeThread(child.info.hThread);
        if (previous_suspend_count != 1)
        {
            error = previous_suspend_count == DWORD(-1) ? GetLastError() : ERROR_INVALID_STATE;
            throw std::runtime_error("unexpected initial suspend count");
        }
        resumed = true;
        phase = "wait-owned-child";
        const DWORD wait = WaitForSingleObject(child.info.hProcess, 30000);
        timed_out = wait == WAIT_TIMEOUT;
        if (wait != WAIT_OBJECT_0)
        {
            error = timed_out ? WAIT_TIMEOUT : GetLastError();
            throw std::runtime_error("owned child did not complete");
        }
        if (!GetExitCodeProcess(child.info.hProcess, &exit_code))
        {
            error = GetLastError();
            throw std::runtime_error("child exit query failed");
        }
        phase = "complete";
        passed = exit_code == 0;
    }
    catch (const std::exception &)
    {
        // This is the sole process handle created by this launcher, never a
        // PID-reopened game or a watched process. A failed proof must not leave
        // its controlled suspended/deadlocked child behind.
        if (child.info.hProcess && WaitForSingleObject(child.info.hProcess, 0) == WAIT_TIMEOUT)
        {
            terminated_owned_child = TerminateProcess(child.info.hProcess, 124) != FALSE;
            if (terminated_owned_child) WaitForSingleObject(child.info.hProcess, 5000);
        }
        if (child.info.hProcess) GetExitCodeProcess(child.info.hProcess, &exit_code);
    }
    std::ofstream report(directory / L"launcher-result.json", std::ios::binary | std::ios::trunc);
    report << "{\"schemaVersion\":1,\"scope\":\"isolated-first-import-controlled-host-proof\","
        << "\"passed\":" << (passed ? "true" : "false")
        << ",\"phase\":" << quote(phase)
        << ",\"pid\":" << child.info.dwProcessId
        << ",\"creationTime100ns\":" << quote(std::to_string(creation_time))
        << ",\"targetPath\":" << quote(utf8(host.wstring()))
        << ",\"bootstrapPath\":" << quote(utf8(bootstrap.wstring()))
        << ",\"identityVerified\":" << (identity_verified ? "true" : "false")
        << ",\"ownedChildJobBound\":" << (job_bound ? "true" : "false")
        << ",\"createProcessCalls\":" << create_calls
        << ",\"helperCreationRejected\":" << (create_calls > 1 ? "true" : "false")
        << ",\"resumed\":" << (resumed ? "true" : "false")
        << ",\"previousSuspendCount\":" << previous_suspend_count
        << ",\"timedOut\":" << (timed_out ? "true" : "false")
        << ",\"terminatedOwnedChild\":" << (terminated_owned_child ? "true" : "false")
        << ",\"errorCode\":" << error << ",\"childExitCode\":" << exit_code
        << ",\"loadsReShade\":false,\"productionActivation\":false}\n";
    report.flush();
    return report.good() && passed ? 0 : 1;
}
