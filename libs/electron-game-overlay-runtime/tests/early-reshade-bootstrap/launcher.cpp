// Isolated proof: starts only the fixed copied host beside this launcher.
// The existing owned ReShade is the first import; the second import only
// restores the original in-memory PE headers. No ReShade bytes are modified.
#include <windows.h>
#include "detours.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <limits>
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
        LPSTARTUPINFOW startup, LPPROCESS_INFORMATION information)
    {
        // Detours' fallback helper would CALL ordinal 1. ReShade's ordinal 1
        // is a factory export, not a helper entry point. Never create that
        // helper, even when a same-architecture direct import update fails.
        if (InterlockedIncrement(&create_calls) != 1)
        {
            SetLastError(ERROR_NOT_SUPPORTED);
            return FALSE;
        }
        return CreateProcessW(application, command, process_attributes, thread_attributes,
            inherit_handles, flags, environment, current_directory, startup, information);
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

    struct input_image
    {
        HANDLE file = INVALID_HANDLE_VALUE;
        std::vector<unsigned char> bytes;
        explicit input_image(const fs::path &path)
        {
            // Retain an owned regular input without permitting writes/rename
            // while it is being validated and used as an import.
            file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot retain owned PE input");
            try
            {
                FILE_ATTRIBUTE_TAG_INFO tag = {};
                LARGE_INTEGER length = {};
                if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
                    (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
                    !GetFileSizeEx(file, &length) || length.QuadPart <= 0 || length.QuadPart > 64 * 1024 * 1024)
                    throw std::runtime_error("Owned PE input is not a bounded regular file");
                bytes.resize(static_cast<size_t>(length.QuadPart));
                DWORD read = 0;
                if (!ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) ||
                    read != bytes.size())
                    throw std::runtime_error("Cannot read complete owned PE input");
            }
            catch (...) { CloseHandle(file); file = INVALID_HANDLE_VALUE; throw; }
        }
        input_image(const input_image &) = delete;
        input_image &operator=(const input_image &) = delete;
        ~input_image() { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); }
        template <typename T> T value(size_t offset) const
        {
            if (offset > bytes.size() || sizeof(T) > bytes.size() - offset)
                throw std::runtime_error("Truncated PE input");
            T result;
            std::memcpy(&result, bytes.data() + offset, sizeof(result));
            return result;
        }
    };

    struct ordinal_metadata { DWORD rva = 0; std::string name; };

    ordinal_metadata inspect_ordinal_one(const input_image &image)
    {
        const IMAGE_DOS_HEADER dos = image.value<IMAGE_DOS_HEADER>(0);
        if (dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < sizeof(dos))
            throw std::runtime_error("Invalid DOS header");
        const size_t nt = static_cast<size_t>(dos.e_lfanew);
        if (image.value<DWORD>(nt) != IMAGE_NT_SIGNATURE)
            throw std::runtime_error("Invalid PE signature");
        const IMAGE_FILE_HEADER file = image.value<IMAGE_FILE_HEADER>(nt + sizeof(DWORD));
#ifdef _WIN64
        constexpr WORD expected_machine = IMAGE_FILE_MACHINE_AMD64;
        constexpr WORD expected_magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC;
        using optional_header = IMAGE_OPTIONAL_HEADER64;
#else
        constexpr WORD expected_machine = IMAGE_FILE_MACHINE_I386;
        constexpr WORD expected_magic = IMAGE_NT_OPTIONAL_HDR32_MAGIC;
        using optional_header = IMAGE_OPTIONAL_HEADER32;
#endif
        if (file.Machine != expected_machine || file.NumberOfSections == 0 || file.NumberOfSections > 96 ||
            (file.Characteristics & IMAGE_FILE_DLL) == 0 || file.SizeOfOptionalHeader < sizeof(optional_header))
            throw std::runtime_error("Owned import has the wrong PE architecture or layout");
        const size_t optional_offset = nt + sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER);
        const optional_header optional = image.value<optional_header>(optional_offset);
        if (optional.Magic != expected_magic || optional.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_EXPORT ||
            optional.SizeOfHeaders > image.bytes.size())
            throw std::runtime_error("Invalid owned import optional header");
        const size_t sections_offset = optional_offset + file.SizeOfOptionalHeader;
        std::vector<IMAGE_SECTION_HEADER> sections;
        for (unsigned index = 0; index < file.NumberOfSections; ++index)
            sections.push_back(image.value<IMAGE_SECTION_HEADER>(sections_offset + index * sizeof(IMAGE_SECTION_HEADER)));
        const auto raw_offset = [&](std::uint64_t rva, size_t required) -> size_t {
            if (rva > std::numeric_limits<DWORD>::max() || rva >= optional.SizeOfImage)
                throw std::runtime_error("PE RVA exceeds mapped image");
            if (rva < optional.SizeOfHeaders)
            {
                if (required > optional.SizeOfHeaders - rva || required > image.bytes.size() - size_t(rva))
                    throw std::runtime_error("Truncated header RVA");
                return static_cast<size_t>(rva);
            }
            for (const auto &section : sections)
            {
                if (rva < section.VirtualAddress) continue;
                const std::uint64_t delta = rva - section.VirtualAddress;
                if (delta >= std::max(section.Misc.VirtualSize, section.SizeOfRawData)) continue;
                const std::uint64_t raw = std::uint64_t(section.PointerToRawData) + delta;
                if (delta > section.SizeOfRawData || required > section.SizeOfRawData - delta ||
                    raw > image.bytes.size() || required > image.bytes.size() - size_t(raw))
                    throw std::runtime_error("Truncated section RVA");
                return static_cast<size_t>(raw);
            }
            throw std::runtime_error("Unmapped PE RVA");
        };
        const IMAGE_DATA_DIRECTORY exports = optional.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
        if (exports.VirtualAddress == 0 || exports.Size < sizeof(IMAGE_EXPORT_DIRECTORY) ||
            std::uint64_t(exports.VirtualAddress) + exports.Size > optional.SizeOfImage)
            throw std::runtime_error("Owned import has no valid export directory");
        const IMAGE_EXPORT_DIRECTORY table = image.value<IMAGE_EXPORT_DIRECTORY>(
            raw_offset(exports.VirtualAddress, sizeof(IMAGE_EXPORT_DIRECTORY)));
        if (table.Base > 1 || table.NumberOfFunctions == 0 || table.NumberOfFunctions > 65536 ||
            table.NumberOfNames > 65536 || 1 - table.Base >= table.NumberOfFunctions)
            throw std::runtime_error("Owned import has no ordinal 1");
        const DWORD ordinal_index = 1 - table.Base;
        ordinal_metadata result;
        result.rva = image.value<DWORD>(raw_offset(
            std::uint64_t(table.AddressOfFunctions) + ordinal_index * sizeof(DWORD), sizeof(DWORD)));
        if (result.rva == 0 || (result.rva >= exports.VirtualAddress &&
            std::uint64_t(result.rva) < std::uint64_t(exports.VirtualAddress) + exports.Size))
            throw std::runtime_error("Owned ordinal 1 is absent or forwarded");
        raw_offset(result.rva, 1);
        bool executable = false;
        for (const auto &section : sections)
            if (result.rva >= section.VirtualAddress &&
                std::uint64_t(result.rva) - section.VirtualAddress < std::max(section.Misc.VirtualSize, section.SizeOfRawData) &&
                (section.Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0)
                executable = true;
        if (!executable) throw std::runtime_error("Owned ordinal 1 is not in executable image data");
        for (DWORD index = 0; index < table.NumberOfNames; ++index)
        {
            const WORD named_ordinal = image.value<WORD>(raw_offset(
                std::uint64_t(table.AddressOfNameOrdinals) + index * sizeof(WORD), sizeof(WORD)));
            if (named_ordinal != ordinal_index) continue;
            const DWORD name_rva = image.value<DWORD>(raw_offset(
                std::uint64_t(table.AddressOfNames) + index * sizeof(DWORD), sizeof(DWORD)));
            for (unsigned offset = 0; offset != 512; ++offset)
            {
                const char c = image.value<char>(raw_offset(std::uint64_t(name_rva) + offset, 1));
                if (c == '\0') return result;
                if (static_cast<unsigned char>(c) < 32 || static_cast<unsigned char>(c) > 126)
                    throw std::runtime_error("Invalid export name encoding");
                result.name.push_back(c);
            }
            throw std::runtime_error("Unbounded export name");
        }
        return result; // A valid NONAME ordinal needs no symbolic name.
    }

    bool regular(const fs::path &path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        return attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
    }
    std::string utf8(const std::wstring &value)
    {
        if (value.empty()) return {};
        const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
        if (length <= 0) throw std::runtime_error("UTF-8 report conversion failed");
        std::string result(static_cast<size_t>(length), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
            result.data(), length, nullptr, nullptr) != length)
            throw std::runtime_error("UTF-8 report conversion failed");
        return result;
    }
    std::string import_path_ansi(const std::wstring &value)
    {
        // PE import strings use the process ANSI code page. An arbitrary UTF-8
        // byte string is not a general Unicode DLL-path solution.
        const UINT code_page = GetACP();
        const DWORD flags = code_page == CP_UTF8 ? WC_ERR_INVALID_CHARS : WC_NO_BEST_FIT_CHARS;
        BOOL used_default = FALSE;
        LPBOOL default_pointer = code_page == CP_UTF8 ? nullptr : &used_default;
        const int length = WideCharToMultiByte(CP_ACP, flags, value.data(), static_cast<int>(value.size()),
            nullptr, 0, nullptr, default_pointer);
        if (length <= 0 || used_default) throw std::runtime_error("Import path is not exactly ANSI-representable");
        std::string result(static_cast<size_t>(length), '\0');
        if (WideCharToMultiByte(CP_ACP, flags, value.data(), static_cast<int>(value.size()), result.data(),
            length, nullptr, default_pointer) != length || used_default)
            throw std::runtime_error("Import path ANSI conversion changed characters");
        const int wide_length = MultiByteToWideChar(CP_ACP, MB_ERR_INVALID_CHARS, result.data(), length, nullptr, 0);
        if (wide_length <= 0) throw std::runtime_error("Import path ANSI round-trip decoding failed");
        std::wstring round_trip(static_cast<size_t>(wide_length), L'\0');
        if (MultiByteToWideChar(CP_ACP, MB_ERR_INVALID_CHARS, result.data(), length,
            round_trip.data(), wide_length) != wide_length || round_trip != value)
            throw std::runtime_error("Import path does not round-trip through the ANSI code page");
        return result;
    }
    std::string quote(const std::string &value)
    {
        std::ostringstream text;
        text << '"';
        for (unsigned char c : value)
        {
            if (c == '"' || c == '\\') text << '\\' << c;
            else if (c < 32) text << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c) << std::dec;
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
    const fs::path host = directory / L"early_reshade_bootstrap_host.exe";
#ifdef _WIN64
    const fs::path reshade = directory / L"ReShade64.dll";
    const fs::path restore = directory / L"early_reshade_restore64.dll";
#else
    const fs::path reshade = directory / L"ReShade32.dll";
    const fs::path restore = directory / L"early_reshade_restore32.dll";
#endif
    const fs::path original = directory / L"early_original_graphics.dll";
    const fs::path marker = directory / L"owned-run.txt";
    const fs::path trace = directory / L"trace.ndjson";
    if (!regular(host) || !regular(reshade) || !regular(restore) || !regular(original) ||
        !regular(marker) || !regular(trace)) return 3;
    std::ifstream marker_input(marker, std::ios::binary);
    const std::string marker_value((std::istreambuf_iterator<char>(marker_input)), {});
    if (marker_value != "EGO_EARLY_RESHADE_BOOTSTRAP_V1\n") return 4;

    process_handles child;
    DWORD error = ERROR_SUCCESS, exit_code = STILL_ACTIVE, previous_suspend_count = DWORD(-1);
    ULONGLONG creation_time = 0;
    bool identity_verified = false, job_bound = false, resumed = false, timed_out = false;
    bool terminated_owned_child = false, passed = false, ansi_verified = false, restore_ordinal_verified = false;
    ordinal_metadata ordinal;
    std::string phase = "validate-owned-imports", failure;
    const auto write_report = [&]() -> bool {
        const fs::path temporary = directory / L"launcher-result.json.tmp";
        std::ofstream report(temporary, std::ios::binary | std::ios::trunc);
        report << "{\"schemaVersion\":1,\"scope\":\"isolated-first-import-reshade-controlled-host-proof\","
            << "\"passed\":" << (passed ? "true" : "false") << ",\"phase\":" << quote(phase)
            << ",\"pid\":" << child.info.dwProcessId
            << ",\"creationTime100ns\":" << quote(std::to_string(creation_time))
            << ",\"targetPath\":" << quote(utf8(host.wstring()))
            << ",\"reshadePath\":" << quote(utf8(reshade.wstring()))
            << ",\"restorePath\":" << quote(utf8(restore.wstring()))
            << ",\"identityVerified\":" << (identity_verified ? "true" : "false")
            << ",\"ownedChildJobBound\":" << (job_bound ? "true" : "false")
            << ",\"createProcessCalls\":" << create_calls
            << ",\"helperCreationRejected\":" << (create_calls > 1 ? "true" : "false")
            << ",\"resumed\":" << (resumed ? "true" : "false")
            << ",\"previousSuspendCount\":" << previous_suspend_count
            << ",\"timedOut\":" << (timed_out ? "true" : "false")
            << ",\"terminatedOwnedChild\":" << (terminated_owned_child ? "true" : "false")
            << ",\"errorCode\":" << error << ",\"childExitCode\":" << exit_code
            << ",\"failure\":" << quote(failure)
            << ",\"firstImportDllCount\":2,\"ordinal1Name\":" << quote(ordinal.name)
            << ",\"ordinal1Rva\":" << ordinal.rva
            << ",\"restoreOrdinal1Validated\":" << (restore_ordinal_verified ? "true" : "false")
            << ",\"ansiCodePage\":" << GetACP()
            << ",\"ansiPathsRoundTripVerified\":" << (ansi_verified ? "true" : "false")
            << ",\"loadsReShade\":true,\"productionActivation\":false}\n";
        report.flush();
        if (!report.good()) return false;
        report.close();
        return MoveFileExW(temporary.c_str(), (directory / L"launcher-result.json").c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    };
    try
    {
        input_image runtime_input(reshade), restore_input(restore);
        ordinal = inspect_ordinal_one(runtime_input);
        inspect_ordinal_one(restore_input);
        restore_ordinal_verified = true;
        const std::string reshade_ansi = import_path_ansi(reshade.wstring());
        const std::string restore_ansi = import_path_ansi(restore.wstring());
        ansi_verified = true;
        LPCSTR imports[] = { reshade_ansi.c_str(), restore_ansi.c_str() };
        phase = "create-owned-child-first-import";
        child.job = CreateJobObjectW(nullptr, nullptr);
        if (!child.job) { error = GetLastError(); throw std::runtime_error("Owned job creation failed"); }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(child.job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        { error = GetLastError(); throw std::runtime_error("Owned job limit failed"); }
        STARTUPINFOEXW startup = {};
        startup.StartupInfo.cb = sizeof(startup);
        SIZE_T attribute_bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
        if (attribute_bytes == 0) { error = GetLastError(); throw std::runtime_error("Job attribute size failed"); }
        std::vector<unsigned char> attribute_storage(attribute_bytes);
        startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes))
        { error = GetLastError(); throw std::runtime_error("Job attribute initialization failed"); }
        struct attribute_cleanup
        {
            LPPROC_THREAD_ATTRIBUTE_LIST value;
            ~attribute_cleanup() { DeleteProcThreadAttributeList(value); }
        } attributes{ startup.lpAttributeList };
        if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
            &child.job, sizeof(child.job), nullptr, nullptr))
        { error = GetLastError(); throw std::runtime_error("Owned job startup attribute failed"); }
        std::wstring command = L"\"" + host.wstring() + L"\" --lifetime-ms 180000 --resize-after-frames 0";
        if (!DetourCreateProcessWithDllsW(host.c_str(), command.data(), nullptr, nullptr, FALSE,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            nullptr, directory.c_str(), &startup.StartupInfo, &child.info,
            ARRAYSIZE(imports), imports, create_only_owned_target))
        {
            error = GetLastError();
            // On FALSE Detours may already have closed both output handles.
            child.info = {};
            throw std::runtime_error("First-import process creation failed");
        }
        BOOL in_job = FALSE;
        if (!IsProcessInJob(child.info.hProcess, child.job, &in_job) || !in_job)
        { error = GetLastError(); throw std::runtime_error("Owned child job binding failed"); }
        job_bound = true;
        phase = "verify-owned-child-identity";
        wchar_t image[32768] = {};
        DWORD image_length = ARRAYSIZE(image);
        FILETIME created = {}, exited = {}, kernel = {}, user = {};
        if (!QueryFullProcessImageNameW(child.info.hProcess, 0, image, &image_length) ||
            !GetProcessTimes(child.info.hProcess, &created, &exited, &kernel, &user))
        { error = GetLastError(); throw std::runtime_error("Owned child identity query failed"); }
        creation_time = (ULONGLONG(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        identity_verified = creation_time != 0 && GetProcessId(child.info.hProcess) == child.info.dwProcessId &&
            _wcsicmp(fs::canonical(fs::path(image)).c_str(), host.c_str()) == 0;
        if (!identity_verified) { error = ERROR_INVALID_DATA; throw std::runtime_error("Owned child identity mismatch"); }
        phase = "resume-owned-child";
        if (!write_report()) { error = GetLastError(); throw std::runtime_error("Cannot publish initial owned child journal"); }
        previous_suspend_count = ResumeThread(child.info.hThread);
        if (previous_suspend_count != 1)
        {
            error = previous_suspend_count == DWORD(-1) ? GetLastError() : ERROR_INVALID_STATE;
            throw std::runtime_error("Unexpected initial suspend count");
        }
        resumed = true;
        phase = "wait-owned-child";
        if (!write_report()) { error = GetLastError(); throw std::runtime_error("Cannot publish resumed child journal"); }
        const DWORD wait = WaitForSingleObject(child.info.hProcess, 210000);
        timed_out = wait == WAIT_TIMEOUT;
        if (wait != WAIT_OBJECT_0)
        {
            error = timed_out ? WAIT_TIMEOUT : GetLastError();
            throw std::runtime_error("Owned child exceeded its completion bound");
        }
        if (!GetExitCodeProcess(child.info.hProcess, &exit_code))
        { error = GetLastError(); throw std::runtime_error("Owned child exit query failed"); }
        phase = "complete";
        passed = exit_code == 0;
    }
    catch (const std::exception &exception)
    {
        failure = exception.what();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        if (child.info.hProcess && WaitForSingleObject(child.info.hProcess, 0) == WAIT_TIMEOUT)
        {
            terminated_owned_child = TerminateProcess(child.info.hProcess, 124) != FALSE;
            if (terminated_owned_child) WaitForSingleObject(child.info.hProcess, 5000);
        }
        if (child.info.hProcess) GetExitCodeProcess(child.info.hProcess, &exit_code);
    }
    return write_report() && passed ? 0 : 1;
}
