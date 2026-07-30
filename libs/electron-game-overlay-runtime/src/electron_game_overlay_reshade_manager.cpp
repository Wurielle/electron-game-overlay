// Copyright (c) Nature Heart Software.
//
// Ownership-safe file transaction helper for an official ReShade installation.
//
// This program intentionally does not discover ReShade or interpret ReShade.ini.
// Its caller must already have resolved and validated the exact add-on directory.
// The helper accepts only that directory, a staged source, and exact hashes. It
// owns exactly these names inside the directory:
//
//   electron_game_overlay.addon64
//   .electron-game-overlay-addon.json
//   .electron-game-overlay-addon.transaction.json
//   .electron-game-overlay-addon.<32 hex nonce>.(addon|marker).(tmp|bak)
//
// It never mutates a ReShade DLL or INI path. Every command opens the exact
// caller-supplied ReShade module read-only, verifies its hash and single-link
// regular-file identity, and holds that handle through recovery and mutation.
//
// CLI protocol (UTF-16 Windows argv):
//
//   electron_game_overlay_reshade_manager.exe prepare
//     --directory <absolute-existing-directory>
//     --source <absolute-existing-file>
//     --source-sha256 <64-uppercase-hex>
//     --reshade-module <absolute-existing-file>
//     --reshade-module-sha256 <64-uppercase-hex>
//
//   electron_game_overlay_reshade_manager.exe remove
//     --directory <absolute-existing-directory>
//     --reshade-module <absolute-existing-file>
//     --reshade-module-sha256 <64-uppercase-hex>
//
//   electron_game_overlay_reshade_manager.exe inspect
//     --directory <absolute-existing-directory>
//     --source <absolute-staged-addon>
//     --source-sha256 <64-uppercase-hex>
//     --reshade-module <absolute-existing-file>
//     --reshade-module-sha256 <64-uppercase-hex>
//
// Options may appear in any order, exactly once. No other option is accepted.
// Success exits 0. Invalid requests exit 2, preserved foreign/integrity state
// exits 3, transaction races/busy state exit 4, and operating-system I/O errors
// exit 5.
//
// Stdout is exactly one UTF-8 JSON line and stderr is unused:
//
//   {
//     "schemaVersion":1,
//     "kind":"electron-game-overlay-reshade-addon-manager-result",
//     "operation":"prepare"|"remove"|"inspect",
//     "status":"installed"|"already-current"|"updated"|
//              "removed"|"not-installed"|"update-required"|
//              "foreign-collision"|"owned-tampered"|
//              "transaction-pending",
//     "addonPath":"...",
//     "markerPath":"...",
//     "reshadeModulePath":"...",
//     "addonSha256":"<hash>"|null,
//     "expectedAddonSha256":"<hash>"|null,
//     "previousAddonSha256":"<hash>"|null,
//     "reshadeModuleSha256":"<hash>",
//     "recoveredTransaction":true|false,
//     "restartRequired":true|false
//   }
//
// Errors use this exact top-level schema:
//
//   {
//     "schemaVersion":1,
//     "kind":"electron-game-overlay-reshade-addon-manager-result",
//     "operation":"prepare"|"remove"|"inspect"|null,
//     "status":"error",
//     "code":"<stable-code>",
//     "message":"...",
//     "windowsError":<positive integer>|null
//   }
//
// All child opens use NtCreateFile with the held directory as RootDirectory,
// OBJ_DONT_REPARSE, FILE_OPEN_REPARSE_POINT, and a single fixed leaf name.
// Existing files are kept open without write/delete sharing until their exact
// handle is renamed or dispositioned. Publication is a handle-relative rename
// with ReplaceIfExists=FALSE. A flushed, append-only transaction journal names
// unique staged and backup leaves before the first mutation. Recovery validates
// every surviving artifact by content and marker schema, then either resumes a
// uniquely provable transaction or preserves everything and fails closed. If
// the verified ReShade runtime changed while a transaction was pending,
// preparation first appends a durable deletion-only suffix and removes the
// incomplete project generation before installing against the current runtime.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <Windows.h>
#include <bcrypt.h>
#include <winternl.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif

namespace
{
constexpr wchar_t addon_leaf[] = L"electron_game_overlay.addon64";
constexpr wchar_t marker_leaf[] = L".electron-game-overlay-addon.json";
constexpr wchar_t journal_leaf[] =
    L".electron-game-overlay-addon.transaction.json";

constexpr char result_kind[] =
    "electron-game-overlay-reshade-addon-manager-result";
constexpr char marker_kind[] = "electron-game-overlay-reshade-addon";
constexpr char transaction_kind[] =
    "electron-game-overlay-reshade-addon-transaction";
constexpr char runtime_change_removal_started_phase[] =
    "runtime-change-removal-started";
constexpr char runtime_change_removal_completed_phase[] =
    "runtime-change-removal-completed";

constexpr std::uint64_t max_addon_size = 64ull * 1024ull * 1024ull;
constexpr std::uint64_t max_marker_size = 64ull * 1024ull;
constexpr std::uint64_t max_journal_size = 64ull * 1024ull;
constexpr FILE_INFORMATION_CLASS file_rename_information =
    static_cast<FILE_INFORMATION_CLASS>(10);

enum class exit_category : int
{
    success = 0,
    invalid_request = 2,
    preserved_state = 3,
    transaction_race = 4,
    io_failure = 5,
};

class manager_error final : public std::runtime_error
{
public:
    manager_error(
        std::string code,
        std::string message,
        exit_category category,
        std::optional<DWORD> windows_error = std::nullopt)
        : std::runtime_error(std::move(message)),
          code_(std::move(code)),
          category_(category),
          windows_error_(windows_error)
    {
    }

    [[nodiscard]] const std::string &code() const noexcept
    {
        return code_;
    }

    [[nodiscard]] exit_category category() const noexcept
    {
        return category_;
    }

    [[nodiscard]] std::optional<DWORD> windows_error() const noexcept
    {
        return windows_error_;
    }

private:
    std::string code_;
    exit_category category_;
    std::optional<DWORD> windows_error_;
};

[[noreturn]] void throw_windows(
    const char *code,
    const std::string &message,
    exit_category category,
    DWORD error = GetLastError())
{
    throw manager_error(code, message, category, error == 0 ? 1 : error);
}

class unique_handle
{
public:
    unique_handle() noexcept = default;
    explicit unique_handle(HANDLE value) noexcept : value_(value)
    {
    }

    ~unique_handle()
    {
        reset();
    }

    unique_handle(const unique_handle &) = delete;
    unique_handle &operator=(const unique_handle &) = delete;

    unique_handle(unique_handle &&other) noexcept
        : value_(std::exchange(other.value_, INVALID_HANDLE_VALUE))
    {
    }

    unique_handle &operator=(unique_handle &&other) noexcept
    {
        if (this != &other)
        {
            reset();
            value_ = std::exchange(other.value_, INVALID_HANDLE_VALUE);
        }
        return *this;
    }

    [[nodiscard]] HANDLE get() const noexcept
    {
        return value_;
    }

    [[nodiscard]] explicit operator bool() const noexcept
    {
        return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
    }

    HANDLE release() noexcept
    {
        return std::exchange(value_, INVALID_HANDLE_VALUE);
    }

    void reset(HANDLE replacement = INVALID_HANDLE_VALUE) noexcept
    {
        if (*this)
            CloseHandle(value_);
        value_ = replacement;
    }

private:
    HANDLE value_ = INVALID_HANDLE_VALUE;
};

std::string utf8_from_wide(std::wstring_view value)
{
    if (value.empty())
        return {};
    if (value.size() >
        static_cast<std::size_t>((std::numeric_limits<int>::max)()))
    {
        throw manager_error(
            "invalid-request",
            "A path is too large to encode.",
            exit_category::invalid_request);
    }
    const int length = WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr);
    if (length <= 0)
        throw_windows(
            "invalid-request",
            "A path is not valid Unicode.",
            exit_category::invalid_request);
    std::string result(static_cast<std::size_t>(length), '\0');
    if (WideCharToMultiByte(
            CP_UTF8,
            WC_ERR_INVALID_CHARS,
            value.data(),
            static_cast<int>(value.size()),
            result.data(),
            length,
            nullptr,
            nullptr) != length)
    {
        throw_windows(
            "invalid-request",
            "A path could not be encoded as UTF-8.",
            exit_category::invalid_request);
    }
    return result;
}

std::wstring wide_from_utf8(std::string_view value, const char *error_code)
{
    if (value.empty())
        return {};
    if (value.size() >
        static_cast<std::size_t>((std::numeric_limits<int>::max)()))
    {
        throw manager_error(
            error_code,
            "A JSON string is too large.",
            exit_category::preserved_state);
    }
    const int length = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0);
    if (length <= 0)
    {
        throw manager_error(
            error_code,
            "A JSON string is not valid UTF-8.",
            exit_category::preserved_state);
    }
    std::wstring result(static_cast<std::size_t>(length), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8,
            MB_ERR_INVALID_CHARS,
            value.data(),
            static_cast<int>(value.size()),
            result.data(),
            length) != length)
    {
        throw manager_error(
            error_code,
            "A JSON string could not be decoded.",
            exit_category::preserved_state);
    }
    return result;
}

std::string json_escape_utf8(std::string_view value)
{
    static constexpr char hex[] = "0123456789ABCDEF";
    std::string result;
    result.reserve(value.size() + 16);
    for (const unsigned char character : value)
    {
        switch (character)
        {
        case '"':
            result += "\\\"";
            break;
        case '\\':
            result += "\\\\";
            break;
        case '\b':
            result += "\\b";
            break;
        case '\f':
            result += "\\f";
            break;
        case '\n':
            result += "\\n";
            break;
        case '\r':
            result += "\\r";
            break;
        case '\t':
            result += "\\t";
            break;
        default:
            if (character < 0x20)
            {
                result += "\\u00";
                result.push_back(hex[(character >> 4) & 0x0F]);
                result.push_back(hex[character & 0x0F]);
            }
            else
            {
                result.push_back(static_cast<char>(character));
            }
            break;
        }
    }
    return result;
}

std::string json_string(std::string_view value)
{
    return "\"" + json_escape_utf8(value) + "\"";
}

std::string json_string(std::wstring_view value)
{
    return json_string(utf8_from_wide(value));
}

bool is_absolute_windows_path(std::wstring_view path)
{
    if (path.size() >= 3 &&
        ((path[0] >= L'A' && path[0] <= L'Z') ||
         (path[0] >= L'a' && path[0] <= L'z')) &&
        path[1] == L':' &&
        (path[2] == L'\\' || path[2] == L'/'))
    {
        return true;
    }
    return path.size() >= 2 &&
           (path[0] == L'\\' || path[0] == L'/') &&
           (path[1] == L'\\' || path[1] == L'/');
}

std::wstring strip_extended_prefix(std::wstring value)
{
    if (value.size() >= 8 &&
        _wcsnicmp(value.c_str(), L"\\\\?\\UNC\\", 8) == 0)
    {
        return L"\\\\" + value.substr(8);
    }
    if (value.size() >= 4 &&
        _wcsnicmp(value.c_str(), L"\\\\?\\", 4) == 0)
    {
        return value.substr(4);
    }
    return value;
}

std::wstring normalize_absolute_path(
    std::wstring value,
    const char *error_code,
    exit_category category)
{
    if (value.empty() || !is_absolute_windows_path(value))
    {
        throw manager_error(
            error_code,
            "Every filesystem path must be absolute.",
            category);
    }
    std::replace(value.begin(), value.end(), L'/', L'\\');
    value = strip_extended_prefix(std::move(value));

    const DWORD required =
        GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
    if (required == 0)
        throw_windows(
            error_code,
            "An absolute path could not be normalized.",
            category);
    std::wstring result(static_cast<std::size_t>(required), L'\0');
    const DWORD written = GetFullPathNameW(
        value.c_str(),
        required,
        result.data(),
        nullptr);
    if (written == 0 || written >= required)
        throw_windows(
            error_code,
            "An absolute path changed while it was normalized.",
            category);
    result.resize(written);

    while (result.size() > 3 && result.back() == L'\\')
        result.pop_back();
    return result;
}

bool paths_equal(std::wstring_view left, std::wstring_view right)
{
    if (left.size() > static_cast<std::size_t>((std::numeric_limits<int>::max)()) ||
        right.size() > static_cast<std::size_t>((std::numeric_limits<int>::max)()))
    {
        return false;
    }
    return CompareStringOrdinal(
               left.data(),
               static_cast<int>(left.size()),
               right.data(),
               static_cast<int>(right.size()),
               TRUE) == CSTR_EQUAL;
}

std::wstring append_leaf(
    const std::wstring &directory,
    std::wstring_view leaf)
{
    if (directory.empty())
        return std::wstring(leaf);
    if (directory.back() == L'\\')
        return directory + std::wstring(leaf);
    return directory + L"\\" + std::wstring(leaf);
}

std::wstring final_path_for_handle(
    HANDLE handle,
    const char *error_code,
    exit_category category)
{
    const DWORD required = GetFinalPathNameByHandleW(
        handle,
        nullptr,
        0,
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (required == 0)
        throw_windows(
            error_code,
            "A filesystem handle could not be canonicalized.",
            category);
    std::wstring result(static_cast<std::size_t>(required), L'\0');
    const DWORD written = GetFinalPathNameByHandleW(
        handle,
        result.data(),
        required,
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (written == 0 || written >= required)
        throw_windows(
            error_code,
            "A filesystem handle changed while it was canonicalized.",
            category);
    result.resize(written);
    result = strip_extended_prefix(std::move(result));
    while (result.size() > 3 && result.back() == L'\\')
        result.pop_back();
    return result;
}

void verify_regular_non_reparse_handle(
    HANDLE handle,
    const std::wstring &expected_path,
    const char *error_code,
    exit_category category,
    bool require_single_link = true)
{
    FILE_ATTRIBUTE_TAG_INFO attributes = {};
    if (!GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            &attributes,
            sizeof(attributes)))
    {
        throw_windows(
            error_code,
            "A file handle could not be inspected.",
            category);
    }
    if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
        (attributes.FileAttributes & FILE_ATTRIBUTE_DEVICE) != 0)
    {
        throw manager_error(
            "path-reparse-point",
            "A managed file is a directory, device, or reparse point.",
            exit_category::preserved_state);
    }

    FILE_STANDARD_INFO standard = {};
    if (!GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &standard,
            sizeof(standard)))
    {
        throw_windows(
            error_code,
            "A file identity could not be inspected.",
            category);
    }
    if (standard.Directory || standard.DeletePending)
    {
        throw manager_error(
            error_code,
            "A managed file is not a stable regular file.",
            category);
    }
    if (require_single_link && standard.NumberOfLinks != 1)
    {
        throw manager_error(
            "path-identity-invalid",
            "A managed file has aliases and cannot prove exclusive ownership.",
            exit_category::preserved_state);
    }

    const std::wstring final_path =
        final_path_for_handle(handle, error_code, category);
    if (!paths_equal(final_path, expected_path))
    {
        throw manager_error(
            "path-not-canonical",
            "A managed file resolved to a different path.",
            exit_category::preserved_state);
    }
}

struct open_directory
{
    unique_handle handle;
    std::wstring canonical_path;
};

open_directory open_verified_directory(
    std::wstring requested,
    bool require_mutation_access)
{
    requested = normalize_absolute_path(
        std::move(requested),
        "invalid-request",
        exit_category::invalid_request);
    DWORD desired_access =
        FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if (require_mutation_access)
        desired_access |= FILE_ADD_FILE;
    unique_handle handle(CreateFileW(
        requested.c_str(),
        desired_access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    if (!handle)
    {
        throw_windows(
            "io-failed",
            "The add-on directory could not be opened.",
            exit_category::io_failure);
    }

    FILE_ATTRIBUTE_TAG_INFO attributes = {};
    if (!GetFileInformationByHandleEx(
            handle.get(),
            FileAttributeTagInfo,
            &attributes,
            sizeof(attributes)))
    {
        throw_windows(
            "io-failed",
            "The add-on directory could not be inspected.",
            exit_category::io_failure);
    }
    if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
    {
        throw manager_error(
            "path-reparse-point",
            "The add-on directory is not a non-reparse directory.",
            exit_category::preserved_state);
    }

    const std::wstring canonical = final_path_for_handle(
        handle.get(),
        "io-failed",
        exit_category::io_failure);
    if (!paths_equal(canonical, requested))
    {
        throw manager_error(
            "path-not-canonical",
            "The add-on directory traverses a reparse point or resolves elsewhere.",
            exit_category::preserved_state);
    }
    return {std::move(handle), canonical};
}

using nt_create_file_fn = NTSTATUS(NTAPI *)(
    PHANDLE,
    ACCESS_MASK,
    POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK,
    PLARGE_INTEGER,
    ULONG,
    ULONG,
    ULONG,
    ULONG,
    PVOID,
    ULONG);
using rtl_nt_status_to_dos_error_fn = ULONG(NTAPI *)(NTSTATUS);
using nt_set_information_file_fn = NTSTATUS(NTAPI *)(
    HANDLE,
    PIO_STATUS_BLOCK,
    PVOID,
    ULONG,
    FILE_INFORMATION_CLASS);

struct nt_api
{
    nt_create_file_fn create_file = nullptr;
    nt_set_information_file_fn set_information_file = nullptr;
    rtl_nt_status_to_dos_error_fn status_to_error = nullptr;
};

const nt_api &native_api()
{
    static const nt_api api = [] {
        const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        if (ntdll == nullptr)
        {
            throw_windows(
                "io-failed",
                "ntdll.dll is unavailable.",
                exit_category::io_failure);
        }
        nt_api value;
        value.create_file = reinterpret_cast<nt_create_file_fn>(
            GetProcAddress(ntdll, "NtCreateFile"));
        value.set_information_file =
            reinterpret_cast<nt_set_information_file_fn>(
                GetProcAddress(ntdll, "NtSetInformationFile"));
        value.status_to_error =
            reinterpret_cast<rtl_nt_status_to_dos_error_fn>(
                GetProcAddress(ntdll, "RtlNtStatusToDosError"));
        if (value.create_file == nullptr ||
            value.set_information_file == nullptr ||
            value.status_to_error == nullptr)
        {
            throw manager_error(
                "io-failed",
                "Required native filesystem entry points are unavailable.",
                exit_category::io_failure);
        }
        return value;
    }();
    return api;
}

struct relative_open_result
{
    unique_handle handle;
    bool missing = false;
};

relative_open_result nt_open_relative(
    HANDLE directory,
    std::wstring_view leaf,
    ACCESS_MASK access,
    ULONG sharing,
    ULONG disposition,
    bool write_through,
    const char *error_code,
    exit_category category)
{
    if (leaf.empty() ||
        leaf.find_first_of(L"\\/:\0", 0, 4) != std::wstring_view::npos ||
        leaf == L"." || leaf == L"..")
    {
        throw manager_error(
            "invalid-request",
            "A managed child name is not a single leaf.",
            exit_category::invalid_request);
    }
    if (leaf.size() >
        static_cast<std::size_t>((std::numeric_limits<USHORT>::max)() /
                                 sizeof(wchar_t)))
    {
        throw manager_error(
            "invalid-request",
            "A managed child name is too long.",
            exit_category::invalid_request);
    }

    UNICODE_STRING name = {};
    name.Buffer = const_cast<PWSTR>(leaf.data());
    name.Length = static_cast<USHORT>(leaf.size() * sizeof(wchar_t));
    name.MaximumLength = name.Length;
    OBJECT_ATTRIBUTES attributes = {};
    InitializeObjectAttributes(
        &attributes,
        &name,
        OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        directory,
        nullptr);
    IO_STATUS_BLOCK io = {};
    HANDLE raw = INVALID_HANDLE_VALUE;
    ULONG options =
        FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT |
        FILE_OPEN_REPARSE_POINT;
    if (write_through)
        options |= FILE_WRITE_THROUGH;
    const nt_api &api = native_api();
    const NTSTATUS status = api.create_file(
        &raw,
        access | SYNCHRONIZE,
        &attributes,
        &io,
        nullptr,
        FILE_ATTRIBUTE_NORMAL,
        sharing,
        disposition,
        options,
        nullptr,
        0);
    if (status >= 0)
        return {unique_handle(raw), false};

    const DWORD error = api.status_to_error(status);
    if (disposition == FILE_OPEN &&
        (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND))
    {
        return {{}, true};
    }
    throw manager_error(
        error_code,
        "A managed child could not be opened without following reparse points.",
        category,
        error == 0 ? 1 : error);
}

unique_handle open_absolute_readonly_file(
    const std::wstring &requested_path,
    const char *error_code,
    const char *open_error_message,
    bool require_single_link)
{
    unique_handle handle(CreateFileW(
        requested_path.c_str(),
        GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
            FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr));
    if (!handle)
    {
        throw_windows(
            error_code,
            open_error_message,
            exit_category::preserved_state);
    }
    verify_regular_non_reparse_handle(
        handle.get(),
        requested_path,
        error_code,
        exit_category::preserved_state,
        require_single_link);
    return handle;
}

std::string hash_handle(
    HANDLE handle,
    std::uint64_t maximum_size,
    const char *code);

struct held_reshade_module
{
    unique_handle handle;
    std::wstring path;
};

held_reshade_module open_held_reshade_module(
    const std::wstring &requested_path,
    std::string_view expected_hash)
{
    const std::wstring path = normalize_absolute_path(
        requested_path,
        "invalid-request",
        exit_category::invalid_request);
    unique_handle handle = open_absolute_readonly_file(
        path,
        "reshade-module-changed",
        "The exact ReShade module could not be opened.",
        true);
    const std::string actual_hash =
        hash_handle(handle.get(), max_addon_size, "reshade-module-changed");
    if (actual_hash != expected_hash)
    {
        throw manager_error(
            "reshade-module-changed",
            "The exact ReShade module does not match the requested SHA-256.",
            exit_category::preserved_state);
    }
    return {std::move(handle), path};
}

std::uint64_t file_size(HANDLE handle, const char *code)
{
    FILE_STANDARD_INFO info = {};
    if (!GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &info,
            sizeof(info)))
    {
        throw_windows(
            code,
            "A managed file size could not be inspected.",
            exit_category::io_failure);
    }
    if (info.EndOfFile.QuadPart < 0)
    {
        throw manager_error(
            code,
            "A managed file has an invalid size.",
            exit_category::preserved_state);
    }
    return static_cast<std::uint64_t>(info.EndOfFile.QuadPart);
}

void seek_start(HANDLE handle, const char *code)
{
    LARGE_INTEGER zero = {};
    if (!SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN))
    {
        throw_windows(
            code,
            "A managed file cursor could not be reset.",
            exit_category::io_failure);
    }
}

class sha256_state
{
public:
    sha256_state()
    {
        NTSTATUS status = BCryptOpenAlgorithmProvider(
            &algorithm_,
            BCRYPT_SHA256_ALGORITHM,
            nullptr,
            0);
        if (status < 0)
            throw manager_error(
                "io-failed",
                "Windows SHA-256 support is unavailable.",
                exit_category::io_failure,
                static_cast<DWORD>(status));

        DWORD object_length = 0;
        DWORD result_length = 0;
        status = BCryptGetProperty(
            algorithm_,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&object_length),
            sizeof(object_length),
            &result_length,
            0);
        if (status < 0 || result_length != sizeof(object_length))
            fail(status, "The SHA-256 object size could not be queried.");
        object_.resize(object_length);

        status = BCryptCreateHash(
            algorithm_,
            &hash_,
            object_.data(),
            static_cast<ULONG>(object_.size()),
            nullptr,
            0,
            0);
        if (status < 0)
            fail(status, "A SHA-256 operation could not be created.");
    }

    ~sha256_state()
    {
        if (hash_ != nullptr)
            BCryptDestroyHash(hash_);
        if (algorithm_ != nullptr)
            BCryptCloseAlgorithmProvider(algorithm_, 0);
    }

    sha256_state(const sha256_state &) = delete;
    sha256_state &operator=(const sha256_state &) = delete;

    void update(const std::uint8_t *bytes, std::size_t size)
    {
        if (size >
            static_cast<std::size_t>((std::numeric_limits<ULONG>::max)()))
        {
            throw manager_error(
                "io-failed",
                "A SHA-256 input chunk is too large.",
                exit_category::io_failure);
        }
        const NTSTATUS status = BCryptHashData(
            hash_,
            const_cast<PUCHAR>(bytes),
            static_cast<ULONG>(size),
            0);
        if (status < 0)
            fail(status, "A SHA-256 input chunk could not be hashed.");
    }

    std::string finish()
    {
        std::array<std::uint8_t, 32> digest = {};
        const NTSTATUS status = BCryptFinishHash(
            hash_,
            digest.data(),
            static_cast<ULONG>(digest.size()),
            0);
        if (status < 0)
            fail(status, "A SHA-256 digest could not be finalized.");

        static constexpr char hex[] = "0123456789ABCDEF";
        std::string result;
        result.reserve(64);
        for (const std::uint8_t byte : digest)
        {
            result.push_back(hex[byte >> 4]);
            result.push_back(hex[byte & 0x0F]);
        }
        return result;
    }

private:
    [[noreturn]] void fail(NTSTATUS status, const char *message)
    {
        throw manager_error(
            "io-failed",
            message,
            exit_category::io_failure,
            static_cast<DWORD>(status));
    }

    BCRYPT_ALG_HANDLE algorithm_ = nullptr;
    BCRYPT_HASH_HANDLE hash_ = nullptr;
    std::vector<std::uint8_t> object_;
};

std::string hash_handle(
    HANDLE handle,
    std::uint64_t maximum_size,
    const char *code)
{
    const std::uint64_t size = file_size(handle, code);
    if (size > maximum_size)
    {
        throw manager_error(
            code,
            "A managed file exceeds its bounded maximum size.",
            exit_category::preserved_state);
    }
    seek_start(handle, code);
    sha256_state hash;
    std::vector<std::uint8_t> buffer(64 * 1024);
    std::uint64_t consumed = 0;
    while (consumed < size)
    {
        const DWORD requested = static_cast<DWORD>(
            (std::min)(
                static_cast<std::uint64_t>(buffer.size()),
                size - consumed));
        DWORD read = 0;
        if (!ReadFile(handle, buffer.data(), requested, &read, nullptr))
        {
            throw_windows(
                code,
                "A managed file could not be hashed.",
                exit_category::io_failure);
        }
        if (read == 0)
        {
            throw manager_error(
                code,
                "A managed file ended while it was hashed.",
                exit_category::preserved_state);
        }
        hash.update(buffer.data(), read);
        consumed += read;
    }
    std::uint8_t extra = 0;
    DWORD extra_read = 0;
    if (!ReadFile(handle, &extra, 1, &extra_read, nullptr))
    {
        throw_windows(
            code,
            "A managed file could not be checked for growth.",
            exit_category::io_failure);
    }
    if (extra_read != 0)
    {
        throw manager_error(
            code,
            "A managed file grew while it was hashed.",
            exit_category::preserved_state);
    }
    seek_start(handle, code);
    return hash.finish();
}

std::vector<std::uint8_t> read_bounded(
    HANDLE handle,
    std::uint64_t maximum_size,
    const char *code)
{
    const std::uint64_t size = file_size(handle, code);
    if (size > maximum_size ||
        size > static_cast<std::uint64_t>(
                   (std::numeric_limits<std::size_t>::max)()))
    {
        throw manager_error(
            code,
            "A managed metadata file exceeds its bounded maximum size.",
            exit_category::preserved_state);
    }
    seek_start(handle, code);
    std::vector<std::uint8_t> result(static_cast<std::size_t>(size));
    std::size_t consumed = 0;
    while (consumed < result.size())
    {
        const DWORD requested = static_cast<DWORD>(
            (std::min)(
                result.size() - consumed,
                static_cast<std::size_t>(
                    (std::numeric_limits<DWORD>::max)())));
        DWORD read = 0;
        if (!ReadFile(
                handle,
                result.data() + consumed,
                requested,
                &read,
                nullptr))
        {
            throw_windows(
                code,
                "A managed metadata file could not be read.",
                exit_category::io_failure);
        }
        if (read == 0)
        {
            throw manager_error(
                code,
                "A managed metadata file ended while it was read.",
                exit_category::preserved_state);
        }
        consumed += read;
    }
    seek_start(handle, code);
    return result;
}

void write_all(HANDLE handle, const void *bytes, std::size_t size)
{
    const auto *cursor = static_cast<const std::uint8_t *>(bytes);
    std::size_t remaining = size;
    while (remaining != 0)
    {
        const DWORD chunk = static_cast<DWORD>(
            (std::min)(
                remaining,
                static_cast<std::size_t>(
                    (std::numeric_limits<DWORD>::max)())));
        DWORD written = 0;
        if (!WriteFile(handle, cursor, chunk, &written, nullptr))
        {
            throw_windows(
                "io-failed",
                "A transaction artifact could not be written.",
                exit_category::io_failure);
        }
        if (written == 0)
        {
            throw manager_error(
                "io-failed",
                "A transaction artifact accepted no write progress.",
                exit_category::io_failure);
        }
        cursor += written;
        remaining -= written;
    }
}

void flush_handle(HANDLE handle)
{
    if (!FlushFileBuffers(handle))
    {
        throw_windows(
            "io-failed",
            "A transaction artifact could not be flushed durably.",
            exit_category::io_failure);
    }
}

bool is_upper_sha256(std::string_view value)
{
    return value.size() == 64 &&
           std::all_of(value.begin(), value.end(), [](char character) {
               return (character >= '0' && character <= '9') ||
                      (character >= 'A' && character <= 'F');
           });
}

struct json_scalar
{
    enum class type
    {
        string,
        number,
    };
    type value_type = type::string;
    std::string string_value;
    std::uint64_t number_value = 0;
};

class flat_json_parser
{
public:
    flat_json_parser(std::string_view input, const char *error_code)
        : input_(input), error_code_(error_code)
    {
    }

    std::map<std::string, json_scalar> parse()
    {
        std::map<std::string, json_scalar> result;
        whitespace();
        expect('{');
        whitespace();
        if (consume('}'))
        {
            whitespace();
            finish();
            return result;
        }
        for (;;)
        {
            whitespace();
            const std::string key = parse_string();
            whitespace();
            expect(':');
            whitespace();
            json_scalar value;
            if (peek() == '"')
            {
                value.value_type = json_scalar::type::string;
                value.string_value = parse_string();
            }
            else
            {
                value.value_type = json_scalar::type::number;
                value.number_value = parse_number();
            }
            if (!result.emplace(key, std::move(value)).second)
                fail("A JSON object contains a duplicate key.");
            whitespace();
            if (consume('}'))
                break;
            expect(',');
        }
        whitespace();
        finish();
        return result;
    }

private:
    [[noreturn]] void fail(const char *message) const
    {
        throw manager_error(
            error_code_,
            message,
            exit_category::preserved_state);
    }

    char peek() const
    {
        return offset_ < input_.size() ? input_[offset_] : '\0';
    }

    bool consume(char expected)
    {
        if (peek() != expected)
            return false;
        ++offset_;
        return true;
    }

    void expect(char expected)
    {
        if (!consume(expected))
            fail("A JSON object has invalid syntax.");
    }

    void whitespace()
    {
        while (offset_ < input_.size())
        {
            const char character = input_[offset_];
            if (character != ' ' && character != '\t' &&
                character != '\r' && character != '\n')
            {
                break;
            }
            ++offset_;
        }
    }

    static void append_utf8(std::string &target, std::uint32_t code_point)
    {
        if (code_point <= 0x7F)
        {
            target.push_back(static_cast<char>(code_point));
        }
        else if (code_point <= 0x7FF)
        {
            target.push_back(static_cast<char>(0xC0 | (code_point >> 6)));
            target.push_back(
                static_cast<char>(0x80 | (code_point & 0x3F)));
        }
        else if (code_point <= 0xFFFF)
        {
            target.push_back(static_cast<char>(0xE0 | (code_point >> 12)));
            target.push_back(
                static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
            target.push_back(
                static_cast<char>(0x80 | (code_point & 0x3F)));
        }
        else
        {
            target.push_back(static_cast<char>(0xF0 | (code_point >> 18)));
            target.push_back(
                static_cast<char>(0x80 | ((code_point >> 12) & 0x3F)));
            target.push_back(
                static_cast<char>(0x80 | ((code_point >> 6) & 0x3F)));
            target.push_back(
                static_cast<char>(0x80 | (code_point & 0x3F)));
        }
    }

    std::uint16_t parse_hex_quad()
    {
        if (input_.size() - offset_ < 4)
            fail("A JSON Unicode escape is truncated.");
        std::uint16_t value = 0;
        for (int index = 0; index < 4; ++index)
        {
            const char character = input_[offset_++];
            value = static_cast<std::uint16_t>(value << 4);
            if (character >= '0' && character <= '9')
                value = static_cast<std::uint16_t>(
                    value | (character - '0'));
            else if (character >= 'A' && character <= 'F')
                value = static_cast<std::uint16_t>(
                    value | (character - 'A' + 10));
            else if (character >= 'a' && character <= 'f')
                value = static_cast<std::uint16_t>(
                    value | (character - 'a' + 10));
            else
                fail("A JSON Unicode escape contains a non-hex digit.");
        }
        return value;
    }

    std::string parse_string()
    {
        expect('"');
        std::string result;
        while (offset_ < input_.size())
        {
            const unsigned char character =
                static_cast<unsigned char>(input_[offset_++]);
            if (character == '"')
                return result;
            if (character < 0x20)
                fail("A JSON string contains an unescaped control byte.");
            if (character != '\\')
            {
                result.push_back(static_cast<char>(character));
                continue;
            }
            if (offset_ == input_.size())
                fail("A JSON escape is truncated.");
            const char escape = input_[offset_++];
            switch (escape)
            {
            case '"':
            case '\\':
            case '/':
                result.push_back(escape);
                break;
            case 'b':
                result.push_back('\b');
                break;
            case 'f':
                result.push_back('\f');
                break;
            case 'n':
                result.push_back('\n');
                break;
            case 'r':
                result.push_back('\r');
                break;
            case 't':
                result.push_back('\t');
                break;
            case 'u':
            {
                std::uint32_t code_point = parse_hex_quad();
                if (code_point >= 0xD800 && code_point <= 0xDBFF)
                {
                    if (input_.size() - offset_ < 6 ||
                        input_[offset_] != '\\' ||
                        input_[offset_ + 1] != 'u')
                    {
                        fail("A JSON high surrogate has no low surrogate.");
                    }
                    offset_ += 2;
                    const std::uint16_t low = parse_hex_quad();
                    if (low < 0xDC00 || low > 0xDFFF)
                        fail("A JSON surrogate pair is invalid.");
                    code_point = 0x10000 +
                                 ((code_point - 0xD800) << 10) +
                                 (low - 0xDC00);
                }
                else if (code_point >= 0xDC00 &&
                         code_point <= 0xDFFF)
                {
                    fail("A JSON low surrogate has no high surrogate.");
                }
                append_utf8(result, code_point);
                break;
            }
            default:
                fail("A JSON string contains an unknown escape.");
            }
        }
        fail("A JSON string is unterminated.");
    }

    std::uint64_t parse_number()
    {
        if (peek() < '0' || peek() > '9')
            fail("A JSON scalar must be a string or unsigned integer.");
        if (peek() == '0')
        {
            ++offset_;
            if (peek() >= '0' && peek() <= '9')
                fail("A JSON integer contains a leading zero.");
            return 0;
        }
        std::uint64_t value = 0;
        while (peek() >= '0' && peek() <= '9')
        {
            const std::uint64_t digit =
                static_cast<std::uint64_t>(input_[offset_++] - '0');
            if (value >
                ((std::numeric_limits<std::uint64_t>::max)() - digit) /
                    10)
            {
                fail("A JSON integer is out of range.");
            }
            value = value * 10 + digit;
        }
        return value;
    }

    void finish()
    {
        if (offset_ != input_.size())
            fail("A JSON object has trailing data.");
    }

    std::string_view input_;
    const char *error_code_;
    std::size_t offset_ = 0;
};

const json_scalar &require_json_field(
    const std::map<std::string, json_scalar> &object,
    const char *key,
    json_scalar::type type,
    const char *error_code)
{
    const auto entry = object.find(key);
    if (entry == object.end() || entry->second.value_type != type)
    {
        throw manager_error(
            error_code,
            "A managed JSON object has a missing or mistyped field.",
            exit_category::preserved_state);
    }
    return entry->second;
}

void require_exact_json_keys(
    const std::map<std::string, json_scalar> &object,
    std::initializer_list<const char *> expected,
    const char *error_code)
{
    if (object.size() != expected.size())
    {
        throw manager_error(
            error_code,
            "A managed JSON object has an unexpected schema.",
            exit_category::preserved_state);
    }
    for (const char *key : expected)
    {
        if (object.find(key) == object.end())
        {
            throw manager_error(
                error_code,
                "A managed JSON object has an unexpected schema.",
                exit_category::preserved_state);
        }
    }
}

struct marker_data
{
    std::string addon_sha256;
    // Installation provenance only. Compatibility is negotiated by the
    // loaded host and is never inferred from this hash.
    std::string reshade_module_sha256;
};

marker_data parse_marker(
    const std::vector<std::uint8_t> &bytes,
    const std::wstring &expected_addon_path,
    std::string_view,
    bool)
{
    const std::string_view text(
        reinterpret_cast<const char *>(bytes.data()),
        bytes.size());
    const auto object =
        flat_json_parser(text, "ownership-marker-invalid").parse();
    require_exact_json_keys(
        object,
        {"schemaVersion",
         "kind",
         "addonFileName",
         "addonPath",
         "addonSha256",
         "reshadeModuleSha256"},
        "ownership-marker-invalid");

    const auto &schema = require_json_field(
        object,
        "schemaVersion",
        json_scalar::type::number,
        "ownership-marker-invalid");
    const auto &kind = require_json_field(
        object,
        "kind",
        json_scalar::type::string,
        "ownership-marker-invalid");
    const auto &file_name = require_json_field(
        object,
        "addonFileName",
        json_scalar::type::string,
        "ownership-marker-invalid");
    const auto &addon_path = require_json_field(
        object,
        "addonPath",
        json_scalar::type::string,
        "ownership-marker-invalid");
    const auto &addon_hash = require_json_field(
        object,
        "addonSha256",
        json_scalar::type::string,
        "ownership-marker-invalid");
    const auto &reshade_hash = require_json_field(
        object,
        "reshadeModuleSha256",
        json_scalar::type::string,
        "ownership-marker-invalid");
    if (schema.number_value != 1 || kind.string_value != marker_kind ||
        file_name.string_value != utf8_from_wide(addon_leaf) ||
        !is_upper_sha256(addon_hash.string_value) ||
        !is_upper_sha256(reshade_hash.string_value))
    {
        throw manager_error(
            "ownership-marker-invalid",
            "The ownership marker does not match the exact managed schema.",
            exit_category::preserved_state);
    }
    std::wstring marker_addon_path = normalize_absolute_path(
        wide_from_utf8(
            addon_path.string_value,
            "ownership-marker-invalid"),
        "ownership-marker-invalid",
        exit_category::preserved_state);
    if (!paths_equal(marker_addon_path, expected_addon_path))
    {
        throw manager_error(
            "ownership-marker-invalid",
            "The ownership marker names a different add-on path.",
            exit_category::preserved_state);
    }
    return {addon_hash.string_value, reshade_hash.string_value};
}

std::string serialize_marker(
    const std::wstring &addon_path,
    std::string_view addon_hash,
    std::string_view reshade_hash)
{
    std::ostringstream stream;
    stream << "{\n"
           << "  \"schemaVersion\": 1,\n"
           << "  \"kind\": " << json_string(marker_kind) << ",\n"
           << "  \"addonFileName\": "
           << json_string(utf8_from_wide(addon_leaf)) << ",\n"
           << "  \"addonPath\": " << json_string(addon_path) << ",\n"
           << "  \"addonSha256\": " << json_string(addon_hash) << ",\n"
           << "  \"reshadeModuleSha256\": "
           << json_string(reshade_hash) << "\n"
           << "}\n";
    return stream.str();
}

struct managed_file
{
    unique_handle handle;
    std::wstring leaf;
    std::string hash;
    std::optional<marker_data> marker;
};

std::optional<managed_file> open_managed_file(
    const open_directory &directory,
    const std::wstring &leaf,
    std::uint64_t maximum_size,
    bool parse_as_marker,
    const std::wstring &expected_addon_path,
    std::string_view expected_reshade_hash,
    bool allow_reshade_hash_mismatch = false,
    ULONG sharing = FILE_SHARE_READ)
{
    relative_open_result opened = nt_open_relative(
        directory.handle.get(),
        leaf,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE,
        sharing,
        FILE_OPEN,
        false,
        "io-failed",
        exit_category::io_failure);
    if (opened.missing)
        return std::nullopt;

    const std::wstring expected_path =
        append_leaf(directory.canonical_path, leaf);
    verify_regular_non_reparse_handle(
        opened.handle.get(),
        expected_path,
        "io-failed",
        exit_category::io_failure);
    managed_file file;
    file.handle = std::move(opened.handle);
    file.leaf = leaf;
    file.hash = hash_handle(file.handle.get(), maximum_size, "io-failed");
    if (parse_as_marker)
    {
        file.marker = parse_marker(
            read_bounded(
                file.handle.get(),
                max_marker_size,
                "ownership-marker-invalid"),
            expected_addon_path,
            expected_reshade_hash,
            allow_reshade_hash_mismatch);
    }
    return file;
}

std::optional<managed_file> open_readonly_managed_file(
    const open_directory &directory,
    const std::wstring &leaf,
    std::uint64_t maximum_size,
    bool parse_as_marker,
    const std::wstring &expected_addon_path,
    std::string_view expected_reshade_hash,
    bool allow_reshade_hash_mismatch = false)
{
    relative_open_result opened = nt_open_relative(
        directory.handle.get(),
        leaf,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        FILE_OPEN,
        false,
        "io-failed",
        exit_category::io_failure);
    if (opened.missing)
        return std::nullopt;

    verify_regular_non_reparse_handle(
        opened.handle.get(),
        append_leaf(directory.canonical_path, leaf),
        "io-failed",
        exit_category::io_failure);
    managed_file file;
    file.handle = std::move(opened.handle);
    file.leaf = leaf;
    file.hash = hash_handle(file.handle.get(), maximum_size, "io-failed");
    if (parse_as_marker)
    {
        file.marker = parse_marker(
            read_bounded(
                file.handle.get(),
                max_marker_size,
                "ownership-marker-invalid"),
            expected_addon_path,
            expected_reshade_hash,
            allow_reshade_hash_mismatch);
    }
    return file;
}

struct installed_pair
{
    bool exists = false;
    std::string addon_hash;
    std::string marker_reshade_hash;
};

installed_pair inspect_installed_pair(
    const open_directory &directory,
    const std::wstring &expected_addon_path,
    std::string_view expected_reshade_hash,
    bool allow_reshade_hash_mismatch = false)
{
    auto addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        expected_addon_path,
        expected_reshade_hash);
    auto marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        expected_addon_path,
        expected_reshade_hash,
        allow_reshade_hash_mismatch);
    if (!addon && !marker)
        return {};
    if (!addon || !marker)
    {
        throw manager_error(
            "foreign-addon-collision",
            "Exactly one reserved add-on artifact exists; both were preserved.",
            exit_category::preserved_state);
    }
    if (addon->hash != marker->marker->addon_sha256)
    {
        throw manager_error(
            "owned-addon-tampered",
            "The installed add-on does not match its ownership marker.",
            exit_category::preserved_state);
    }
    return {
        true,
        addon->hash,
        marker->marker->reshade_module_sha256};
}

std::wstring random_nonce()
{
    std::array<std::uint8_t, 16> bytes = {};
    const NTSTATUS status = BCryptGenRandom(
        nullptr,
        bytes.data(),
        static_cast<ULONG>(bytes.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    if (status < 0)
    {
        throw manager_error(
            "io-failed",
            "A transaction nonce could not be generated.",
            exit_category::io_failure,
            static_cast<DWORD>(status));
    }
    static constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring result;
    result.reserve(32);
    for (const std::uint8_t byte : bytes)
    {
        result.push_back(hex[byte >> 4]);
        result.push_back(hex[byte & 0x0F]);
    }
    return result;
}

bool is_nonce(std::wstring_view value)
{
    return value.size() == 32 &&
           std::all_of(value.begin(), value.end(), [](wchar_t character) {
               return (character >= L'0' && character <= L'9') ||
                      (character >= L'a' && character <= L'f');
           });
}

struct transaction
{
    std::string operation;
    std::wstring nonce;
    std::string new_addon_hash;
    std::string old_addon_hash;
    // Runtime hash recorded in the ownership marker being created or removed.
    std::string reshade_hash;
    // Exact runtime module whose handle was held by the initiating command.
    std::string held_reshade_hash;
    std::wstring addon_temp;
    std::wstring marker_temp;
    std::wstring addon_backup;
    std::wstring marker_backup;
    std::vector<std::string> phases;
    unique_handle journal;
    std::optional<std::uint64_t> torn_suffix_offset;
};

std::wstring transaction_leaf(
    std::wstring_view nonce,
    std::wstring_view role,
    std::wstring_view suffix)
{
    return L".electron-game-overlay-addon." + std::wstring(nonce) + L"." +
           std::wstring(role) + L"." + std::wstring(suffix);
}

std::string transaction_header(const transaction &value)
{
    std::ostringstream stream;
    stream << "{"
           << "\"schemaVersion\":1,"
           << "\"kind\":" << json_string(transaction_kind) << ","
           << "\"operation\":" << json_string(value.operation) << ","
           << "\"nonce\":" << json_string(value.nonce) << ","
           << "\"newAddonSha256\":"
           << json_string(value.new_addon_hash) << ","
           << "\"oldAddonSha256\":"
           << json_string(value.old_addon_hash) << ","
           << "\"reshadeModuleSha256\":"
           << json_string(value.reshade_hash) << ","
           << "\"heldReshadeModuleSha256\":"
           << json_string(value.held_reshade_hash) << ","
           << "\"addonTempName\":" << json_string(value.addon_temp)
           << ","
           << "\"markerTempName\":" << json_string(value.marker_temp)
           << ","
           << "\"addonBackupName\":"
           << json_string(value.addon_backup) << ","
           << "\"markerBackupName\":"
           << json_string(value.marker_backup)
           << "}\n";
    return stream.str();
}

void append_journal_line(transaction &value, const std::string &line)
{
    LARGE_INTEGER zero = {};
    if (!SetFilePointerEx(
            value.journal.get(),
            zero,
            nullptr,
            FILE_END))
    {
        throw_windows(
            "io-failed",
            "The transaction journal cursor could not be advanced.",
            exit_category::io_failure);
    }
    write_all(value.journal.get(), line.data(), line.size());
    flush_handle(value.journal.get());
}

void append_phase(transaction &value, std::string phase)
{
    std::ostringstream stream;
    stream << "{\"phase\":" << json_string(phase)
           << ",\"sequence\":" << (value.phases.size() + 1) << "}\n";
    append_journal_line(value, stream.str());
    value.phases.push_back(std::move(phase));
#if defined(ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_TEST_FAULTS)
    const std::string fault_point =
        value.operation + ":" + value.phases.back();
    std::array<wchar_t, 128> configured = {};
    const DWORD length = GetEnvironmentVariableW(
        L"ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_AFTER_PHASE",
        configured.data(),
        static_cast<DWORD>(configured.size()));
    if (length != 0 && length < configured.size() &&
        utf8_from_wide(
            std::wstring_view(configured.data(), length)) == fault_point)
    {
        // Test-only hard process termination deliberately skips C++ cleanup,
        // while preserving the already-flushed journal record.
        TerminateProcess(GetCurrentProcess(), 197);
    }
#endif
}

transaction make_transaction(
    std::string operation,
    std::string new_hash,
    std::string old_hash,
    std::string marker_reshade_hash,
    std::string held_reshade_hash)
{
    transaction value;
    value.operation = std::move(operation);
    value.nonce = random_nonce();
    value.new_addon_hash = std::move(new_hash);
    value.old_addon_hash = std::move(old_hash);
    value.reshade_hash = std::move(marker_reshade_hash);
    value.held_reshade_hash = std::move(held_reshade_hash);
    value.addon_temp =
        transaction_leaf(value.nonce, L"addon", L"tmp");
    value.marker_temp =
        transaction_leaf(value.nonce, L"marker", L"tmp");
    value.addon_backup =
        transaction_leaf(value.nonce, L"addon", L"bak");
    value.marker_backup =
        transaction_leaf(value.nonce, L"marker", L"bak");
    return value;
}

void validate_transaction_names(const transaction &value)
{
    if (!is_nonce(value.nonce) ||
        value.addon_temp !=
            transaction_leaf(value.nonce, L"addon", L"tmp") ||
        value.marker_temp !=
            transaction_leaf(value.nonce, L"marker", L"tmp") ||
        value.addon_backup !=
            transaction_leaf(value.nonce, L"addon", L"bak") ||
        value.marker_backup !=
            transaction_leaf(value.nonce, L"marker", L"bak"))
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal contains unmanaged artifact names.",
            exit_category::preserved_state);
    }
}

void validate_phase_prefix(const transaction &value)
{
    const std::vector<std::string> *expected = nullptr;
    static const std::vector<std::string> install = {
        "staged",
        "marker-published",
        "addon-published",
        "cleanup-started",
        "completed"};
    static const std::vector<std::string> update = {
        "staged",
        "addon-backed-up",
        "marker-backed-up",
        "marker-published",
        "addon-published",
        "cleanup-started",
        "completed"};
    static const std::vector<std::string> remove = {
        "addon-backed-up",
        "marker-backed-up",
        "cleanup-started",
        "completed"};
    if (value.operation == "install")
        expected = &install;
    else if (value.operation == "update")
        expected = &update;
    else if (value.operation == "remove")
        expected = &remove;
    else
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal contains an unknown operation.",
            exit_category::preserved_state);
    }
    const auto removal_started = std::find(
        value.phases.begin(),
        value.phases.end(),
        runtime_change_removal_started_phase);
    const std::size_t normal_phase_count =
        static_cast<std::size_t>(removal_started - value.phases.begin());
    if (normal_phase_count > expected->size() ||
        !std::equal(
            value.phases.begin(),
            removal_started,
            expected->begin()))
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal contains an invalid phase sequence.",
            exit_category::preserved_state);
    }
    if (removal_started == value.phases.end())
        return;

    const auto suffix_size =
        static_cast<std::size_t>(value.phases.end() - removal_started);
    if (suffix_size > 2 ||
        (suffix_size == 2 &&
         removal_started[1] != runtime_change_removal_completed_phase))
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal contains an invalid removal-cleanup suffix.",
            exit_category::preserved_state);
    }
}

transaction parse_transaction(
    unique_handle journal,
    const std::vector<std::uint8_t> &bytes)
{
    const std::string_view text(
        reinterpret_cast<const char *>(bytes.data()),
        bytes.size());
    const std::size_t header_end = text.find('\n');
    if (header_end == std::string_view::npos)
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal has no complete header.",
            exit_category::preserved_state);
    }
    const auto header = flat_json_parser(
                            text.substr(0, header_end),
                            "transaction-invalid")
                            .parse();
    require_exact_json_keys(
        header,
        {"schemaVersion",
         "kind",
         "operation",
         "nonce",
         "newAddonSha256",
         "oldAddonSha256",
         "reshadeModuleSha256",
         "heldReshadeModuleSha256",
         "addonTempName",
         "markerTempName",
         "addonBackupName",
         "markerBackupName"},
        "transaction-invalid");
    if (require_json_field(
            header,
            "schemaVersion",
            json_scalar::type::number,
            "transaction-invalid")
            .number_value != 1 ||
        require_json_field(
            header,
            "kind",
            json_scalar::type::string,
            "transaction-invalid")
                .string_value != transaction_kind)
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal header has an unknown schema.",
            exit_category::preserved_state);
    }

    transaction result;
    result.operation = require_json_field(
                           header,
                           "operation",
                           json_scalar::type::string,
                           "transaction-invalid")
                           .string_value;
    result.nonce = wide_from_utf8(
        require_json_field(
            header,
            "nonce",
            json_scalar::type::string,
            "transaction-invalid")
            .string_value,
        "transaction-invalid");
    result.new_addon_hash = require_json_field(
                                header,
                                "newAddonSha256",
                                json_scalar::type::string,
                                "transaction-invalid")
                                .string_value;
    result.old_addon_hash = require_json_field(
                                header,
                                "oldAddonSha256",
                                json_scalar::type::string,
                                "transaction-invalid")
                                .string_value;
    result.reshade_hash = require_json_field(
                              header,
                              "reshadeModuleSha256",
                              json_scalar::type::string,
                              "transaction-invalid")
                              .string_value;
    result.held_reshade_hash = require_json_field(
                                   header,
                                   "heldReshadeModuleSha256",
                                   json_scalar::type::string,
                                   "transaction-invalid")
                                   .string_value;
    result.addon_temp = wide_from_utf8(
        require_json_field(
            header,
            "addonTempName",
            json_scalar::type::string,
            "transaction-invalid")
            .string_value,
        "transaction-invalid");
    result.marker_temp = wide_from_utf8(
        require_json_field(
            header,
            "markerTempName",
            json_scalar::type::string,
            "transaction-invalid")
            .string_value,
        "transaction-invalid");
    result.addon_backup = wide_from_utf8(
        require_json_field(
            header,
            "addonBackupName",
            json_scalar::type::string,
            "transaction-invalid")
            .string_value,
        "transaction-invalid");
    result.marker_backup = wide_from_utf8(
        require_json_field(
            header,
            "markerBackupName",
            json_scalar::type::string,
            "transaction-invalid")
            .string_value,
        "transaction-invalid");
    result.journal = std::move(journal);

    if (!is_upper_sha256(result.reshade_hash) ||
        !is_upper_sha256(result.held_reshade_hash) ||
        // An update may preserve installation provenance from the existing
        // marker while the command holds a newer ReShade runtime generation.
        // Only a first install must record the exact held runtime as its
        // marker provenance.
        (result.operation == "install" &&
         result.reshade_hash != result.held_reshade_hash) ||
        (result.operation != "remove" &&
         !is_upper_sha256(result.new_addon_hash)) ||
        (result.operation == "remove" &&
         !result.new_addon_hash.empty()) ||
        (result.operation == "install" &&
         !result.old_addon_hash.empty()) ||
        (result.operation != "install" &&
         !is_upper_sha256(result.old_addon_hash)) ||
        (result.operation == "update" &&
         result.old_addon_hash == result.new_addon_hash))
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction journal contains invalid content hashes.",
            exit_category::preserved_state);
    }
    validate_transaction_names(result);

    std::size_t cursor = header_end + 1;
    std::uint64_t expected_sequence = 1;
    while (cursor < text.size())
    {
        const std::size_t line_end = text.find('\n', cursor);
        if (line_end == std::string_view::npos)
            break; // A torn final append is ignored conservatively.
        if (line_end == cursor)
        {
            throw manager_error(
                "transaction-invalid",
                "The transaction journal contains an empty record.",
                exit_category::preserved_state);
        }
        const auto phase_record = flat_json_parser(
                                      text.substr(
                                          cursor,
                                          line_end - cursor),
                                      "transaction-invalid")
                                      .parse();
        require_exact_json_keys(
            phase_record,
            {"phase", "sequence"},
            "transaction-invalid");
        const auto &phase = require_json_field(
            phase_record,
            "phase",
            json_scalar::type::string,
            "transaction-invalid");
        const auto &sequence = require_json_field(
            phase_record,
            "sequence",
            json_scalar::type::number,
            "transaction-invalid");
        if (sequence.number_value != expected_sequence++)
        {
            throw manager_error(
                "transaction-invalid",
                "The transaction journal phase sequence is discontinuous.",
                exit_category::preserved_state);
        }
        result.phases.push_back(phase.string_value);
        cursor = line_end + 1;
    }
    validate_phase_prefix(result);
    if (cursor < text.size())
    {
        result.torn_suffix_offset =
            static_cast<std::uint64_t>(cursor);
    }
    return result;
}

void discard_created_file_noexcept(unique_handle &handle) noexcept;

transaction create_transaction(
    const open_directory &directory,
    std::string operation,
    std::string new_hash,
    std::string old_hash,
    std::string marker_reshade_hash,
    std::string held_reshade_hash)
{
    transaction result = make_transaction(
        std::move(operation),
        std::move(new_hash),
        std::move(old_hash),
        std::move(marker_reshade_hash),
        std::move(held_reshade_hash));
    relative_open_result created = nt_open_relative(
        directory.handle.get(),
        journal_leaf,
        FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA |
            FILE_READ_ATTRIBUTES | DELETE,
        0,
        FILE_CREATE,
        true,
        "transaction-conflict",
        exit_category::transaction_race);
    result.journal = std::move(created.handle);
    try
    {
        verify_regular_non_reparse_handle(
            result.journal.get(),
            append_leaf(directory.canonical_path, journal_leaf),
            "transaction-conflict",
            exit_category::transaction_race);
        const std::string header = transaction_header(result);
        write_all(result.journal.get(), header.data(), header.size());
        flush_handle(result.journal.get());
    }
    catch (...)
    {
        discard_created_file_noexcept(result.journal);
        throw;
    }
    return result;
}

std::optional<transaction> open_transaction(
    const open_directory &directory)
{
    relative_open_result opened = nt_open_relative(
        directory.handle.get(),
        journal_leaf,
        FILE_READ_DATA | FILE_WRITE_DATA | FILE_APPEND_DATA |
            FILE_READ_ATTRIBUTES | DELETE,
        0,
        FILE_OPEN,
        true,
        "transaction-conflict",
        exit_category::transaction_race);
    if (opened.missing)
        return std::nullopt;
    verify_regular_non_reparse_handle(
        opened.handle.get(),
        append_leaf(directory.canonical_path, journal_leaf),
        "transaction-invalid",
        exit_category::preserved_state);
    const std::vector<std::uint8_t> bytes = read_bounded(
        opened.handle.get(),
        max_journal_size,
        "transaction-invalid");
    return parse_transaction(
        std::move(opened.handle),
        bytes);
}

unique_handle create_relative_file(
    const open_directory &directory,
    const std::wstring &leaf)
{
    relative_open_result created = nt_open_relative(
        directory.handle.get(),
        leaf,
        FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE,
        FILE_SHARE_READ,
        FILE_CREATE,
        true,
        "write-race",
        exit_category::transaction_race);
    try
    {
        verify_regular_non_reparse_handle(
            created.handle.get(),
            append_leaf(directory.canonical_path, leaf),
            "write-race",
            exit_category::transaction_race);
    }
    catch (...)
    {
        FILE_DISPOSITION_INFO disposition = {};
        disposition.DeleteFile = TRUE;
        SetFileInformationByHandle(
            created.handle.get(),
            FileDispositionInfo,
            &disposition,
            sizeof(disposition));
        throw;
    }
    return std::move(created.handle);
}

void discard_created_file_noexcept(unique_handle &handle) noexcept
{
    if (!handle)
        return;
    FILE_DISPOSITION_INFO disposition = {};
    disposition.DeleteFile = TRUE;
    SetFileInformationByHandle(
        handle.get(),
        FileDispositionInfo,
        &disposition,
        sizeof(disposition));
    handle.reset();
}

managed_file stage_bytes(
    const open_directory &directory,
    const std::wstring &leaf,
    const void *bytes,
    std::size_t size,
    std::string_view expected_hash,
    std::uint64_t maximum_size)
{
    managed_file result;
    result.handle = create_relative_file(directory, leaf);
    result.leaf = leaf;
    try
    {
        write_all(result.handle.get(), bytes, size);
        flush_handle(result.handle.get());
        result.hash =
            hash_handle(result.handle.get(), maximum_size, "write-race");
        if (result.hash != expected_hash)
        {
            throw manager_error(
                "write-race",
                "A staged transaction artifact did not retain its expected hash.",
                exit_category::transaction_race);
        }
        return result;
    }
    catch (...)
    {
        discard_created_file_noexcept(result.handle);
        throw;
    }
}

managed_file stage_source(
    const open_directory &directory,
    const std::wstring &leaf,
    HANDLE source,
    std::string_view expected_hash)
{
    managed_file result;
    result.handle = create_relative_file(directory, leaf);
    result.leaf = leaf;
    try
    {
        seek_start(source, "source-changed");
        const std::uint64_t source_size =
            file_size(source, "source-changed");
        if (source_size > max_addon_size)
        {
            throw manager_error(
                "source-changed",
                "The staged add-on source exceeds its bounded maximum size.",
                exit_category::preserved_state);
        }
        std::vector<std::uint8_t> buffer(64 * 1024);
        std::uint64_t copied = 0;
        while (copied < source_size)
        {
            const DWORD request = static_cast<DWORD>(
                (std::min)(
                    static_cast<std::uint64_t>(buffer.size()),
                    source_size - copied));
            DWORD read = 0;
            if (!ReadFile(source, buffer.data(), request, &read, nullptr) ||
                read == 0)
            {
                throw_windows(
                    "source-changed",
                    "The staged add-on source changed while it was copied.",
                    exit_category::preserved_state);
            }
            write_all(result.handle.get(), buffer.data(), read);
            copied += read;
        }
        flush_handle(result.handle.get());
        result.hash =
            hash_handle(result.handle.get(), max_addon_size, "write-race");
        if (result.hash != expected_hash ||
            hash_handle(source, max_addon_size, "source-changed") !=
                expected_hash)
        {
            throw manager_error(
                "source-changed",
                "The staged add-on source did not retain its expected hash.",
                exit_category::preserved_state);
        }
        return result;
    }
    catch (...)
    {
        discard_created_file_noexcept(result.handle);
        throw;
    }
}

void rename_no_replace(
    managed_file &file,
    const open_directory &directory,
    const std::wstring &new_leaf)
{
    const std::size_t bytes =
        sizeof(FILE_RENAME_INFO) +
        new_leaf.size() * sizeof(wchar_t);
    std::vector<std::uint8_t> storage(bytes, 0);
    auto *information =
        reinterpret_cast<FILE_RENAME_INFO *>(storage.data());
    information->ReplaceIfExists = FALSE;
    information->RootDirectory = directory.handle.get();
    information->FileNameLength =
        static_cast<ULONG>(new_leaf.size() * sizeof(wchar_t));
    std::copy(
        new_leaf.begin(),
        new_leaf.end(),
        information->FileName);
    IO_STATUS_BLOCK io = {};
    const nt_api &api = native_api();
    const NTSTATUS status = api.set_information_file(
        file.handle.get(),
        &io,
        information,
        static_cast<ULONG>(storage.size()),
        file_rename_information);
    if (status < 0)
    {
        const DWORD error = api.status_to_error(status);
        throw manager_error(
            "write-race",
            "A managed artifact could not be renamed without replacement.",
            exit_category::transaction_race,
            error == 0 ? 1 : error);
    }
    const std::wstring expected =
        append_leaf(directory.canonical_path, new_leaf);
    verify_regular_non_reparse_handle(
        file.handle.get(),
        expected,
        "write-race",
        exit_category::transaction_race);
    file.leaf = new_leaf;
}

void delete_exact(managed_file &file)
{
    FILE_DISPOSITION_INFO disposition = {};
    disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(
            file.handle.get(),
            FileDispositionInfo,
            &disposition,
            sizeof(disposition)))
    {
        throw_windows(
            "io-failed",
            "An exact owned transaction artifact could not be deleted.",
            exit_category::io_failure);
    }
    file.handle.reset();
}

void delete_journal(transaction &value)
{
    FILE_DISPOSITION_INFO disposition = {};
    disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(
            value.journal.get(),
            FileDispositionInfo,
            &disposition,
            sizeof(disposition)))
    {
        throw_windows(
            "io-failed",
            "The exact completed transaction journal could not be deleted.",
            exit_category::io_failure);
    }
    value.journal.reset();
}

void ensure_absent(
    const open_directory &directory,
    const std::wstring &leaf,
    const std::wstring &expected_addon_path,
    std::string_view reshade_hash)
{
    auto file = open_managed_file(
        directory,
        leaf,
        max_addon_size,
        false,
        expected_addon_path,
        reshade_hash);
    if (file)
    {
        throw manager_error(
            "transaction-invalid",
            "An unexpected transaction artifact was preserved.",
            exit_category::preserved_state);
    }
}

bool is_cleanup_started(const transaction &value)
{
    return std::find(
               value.phases.begin(),
               value.phases.end(),
               "cleanup-started") != value.phases.end();
}

bool is_runtime_change_removal_started(const transaction &value)
{
    return std::find(
               value.phases.begin(),
               value.phases.end(),
               runtime_change_removal_started_phase) != value.phases.end();
}

bool is_runtime_change_removal_completed(const transaction &value)
{
    return std::find(
               value.phases.begin(),
               value.phases.end(),
               runtime_change_removal_completed_phase) != value.phases.end();
}

const std::vector<std::string> &transaction_phase_order(
    const transaction &value)
{
    static const std::vector<std::string> install = {
        "staged",
        "marker-published",
        "addon-published",
        "cleanup-started",
        "completed"};
    static const std::vector<std::string> update = {
        "staged",
        "addon-backed-up",
        "marker-backed-up",
        "marker-published",
        "addon-published",
        "cleanup-started",
        "completed"};
    static const std::vector<std::string> remove = {
        "addon-backed-up",
        "marker-backed-up",
        "cleanup-started",
        "completed"};
    if (value.operation == "install")
        return install;
    if (value.operation == "update")
        return update;
    return remove;
}

void record_through(transaction &value, std::string_view phase)
{
    const auto &order = transaction_phase_order(value);
    const auto target = std::find(order.begin(), order.end(), phase);
    if (target == order.end())
    {
        throw manager_error(
            "transaction-invalid",
            "Recovery attempted to record an invalid transaction phase.",
            exit_category::preserved_state);
    }
    const std::size_t target_index =
        static_cast<std::size_t>(target - order.begin());
    if (value.phases.size() > target_index + 1)
        return;
    while (value.phases.size() <= target_index)
        append_phase(value, order[value.phases.size()]);
}

void discard_torn_journal_suffix(transaction &value)
{
    if (!value.torn_suffix_offset)
        return;
    if (*value.torn_suffix_offset >
        static_cast<std::uint64_t>((std::numeric_limits<LONGLONG>::max)()))
    {
        throw manager_error(
            "transaction-invalid",
            "The validated transaction journal length is invalid.",
            exit_category::preserved_state);
    }
    LARGE_INTEGER end = {};
    end.QuadPart = static_cast<LONGLONG>(*value.torn_suffix_offset);
    if (!SetFilePointerEx(
            value.journal.get(),
            end,
            nullptr,
            FILE_BEGIN) ||
        !SetEndOfFile(value.journal.get()))
    {
        throw_windows(
            "io-failed",
            "A torn transaction journal suffix could not be discarded.",
            exit_category::io_failure);
    }
    flush_handle(value.journal.get());
    value.torn_suffix_offset.reset();
}

void verify_addon_role(
    const std::optional<managed_file> &file,
    std::string_view expected_hash,
    const char *message)
{
    if (file && file->hash != expected_hash)
    {
        throw manager_error(
            "transaction-invalid",
            message,
            exit_category::preserved_state);
    }
}

void verify_marker_role(
    const std::optional<managed_file> &file,
    std::string_view expected_hash,
    const char *message)
{
    if (file &&
        (!file->marker ||
         file->marker->addon_sha256 != expected_hash))
    {
        throw manager_error(
            "transaction-invalid",
            message,
            exit_category::preserved_state);
    }
}

void recover_install(
    transaction &value,
    const open_directory &directory,
    const std::wstring &addon_path)
{
    ensure_absent(
        directory,
        value.addon_backup,
        addon_path,
        value.reshade_hash);
    ensure_absent(
        directory,
        value.marker_backup,
        addon_path,
        value.reshade_hash);

    auto final_addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto final_marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    auto temp_addon = open_managed_file(
        directory,
        value.addon_temp,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto temp_marker = open_managed_file(
        directory,
        value.marker_temp,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    verify_addon_role(
        final_addon,
        value.new_addon_hash,
        "The final add-on is not the journaled install artifact.");
    verify_addon_role(
        temp_addon,
        value.new_addon_hash,
        "The staged add-on is not the journaled install artifact.");
    verify_marker_role(
        final_marker,
        value.new_addon_hash,
        "The final marker is not the journaled install marker.");
    verify_marker_role(
        temp_marker,
        value.new_addon_hash,
        "The staged marker is not the journaled install marker.");

    if ((final_addon && temp_addon) ||
        (final_marker && temp_marker))
    {
        throw manager_error(
            "transaction-invalid",
            "An install transaction contains duplicate generations.",
            exit_category::preserved_state);
    }

    if (!final_addon && !final_marker &&
        (!temp_addon || !temp_marker))
    {
        // No public name was mutated. A crash may have interrupted staging;
        // deleting only verified nonce-bound temps is a safe rollback.
        if (temp_addon)
            delete_exact(*temp_addon);
        if (temp_marker)
            delete_exact(*temp_marker);
        delete_journal(value);
        return;
    }

    if ((!final_addon && !temp_addon) ||
        (!final_marker && !temp_marker))
    {
        throw manager_error(
            "transaction-invalid",
            "An install transaction is missing a required generation.",
            exit_category::preserved_state);
    }
    if (final_marker)
        record_through(value, "marker-published");
    if (final_addon)
    {
        if (!final_marker)
        {
            throw manager_error(
                "transaction-invalid",
                "The final install add-on exists without its published marker.",
                exit_category::preserved_state);
        }
        record_through(value, "addon-published");
    }
    if (!final_marker)
    {
        rename_no_replace(*temp_marker, directory, marker_leaf);
        final_marker = std::move(temp_marker);
        record_through(value, "marker-published");
    }
    if (!final_addon)
    {
        rename_no_replace(*temp_addon, directory, addon_leaf);
        final_addon = std::move(temp_addon);
        record_through(value, "addon-published");
    }
    if (!is_cleanup_started(value))
        record_through(value, "cleanup-started");
    record_through(value, "completed");
    delete_journal(value);
}

enum class final_generation
{
    absent,
    old_generation,
    new_generation,
};

final_generation addon_generation(
    const std::optional<managed_file> &file,
    const transaction &value)
{
    if (!file)
        return final_generation::absent;
    if (file->hash == value.old_addon_hash)
        return final_generation::old_generation;
    if (file->hash == value.new_addon_hash)
        return final_generation::new_generation;
    throw manager_error(
        "transaction-invalid",
        "A final add-on has neither journaled generation.",
        exit_category::preserved_state);
}

final_generation marker_generation(
    const std::optional<managed_file> &file,
    const transaction &value)
{
    if (!file)
        return final_generation::absent;
    if (!file->marker)
    {
        throw manager_error(
            "transaction-invalid",
            "A transaction marker was not parsed.",
            exit_category::preserved_state);
    }
    if (file->marker->addon_sha256 == value.old_addon_hash)
        return final_generation::old_generation;
    if (file->marker->addon_sha256 == value.new_addon_hash)
        return final_generation::new_generation;
    throw manager_error(
        "transaction-invalid",
        "A final marker has neither journaled generation.",
        exit_category::preserved_state);
}

void recover_update(
    transaction &value,
    const open_directory &directory,
    const std::wstring &addon_path)
{
    auto final_addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto final_marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    auto temp_addon = open_managed_file(
        directory,
        value.addon_temp,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto temp_marker = open_managed_file(
        directory,
        value.marker_temp,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    auto backup_addon = open_managed_file(
        directory,
        value.addon_backup,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto backup_marker = open_managed_file(
        directory,
        value.marker_backup,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);

    verify_addon_role(
        temp_addon,
        value.new_addon_hash,
        "The staged update add-on has an unexpected hash.");
    verify_marker_role(
        temp_marker,
        value.new_addon_hash,
        "The staged update marker has an unexpected hash.");
    verify_addon_role(
        backup_addon,
        value.old_addon_hash,
        "The backup add-on has an unexpected hash.");
    verify_marker_role(
        backup_marker,
        value.old_addon_hash,
        "The backup marker has an unexpected hash.");

    final_generation addon_state =
        addon_generation(final_addon, value);
    final_generation marker_state =
        marker_generation(final_marker, value);
    const bool cleanup = is_cleanup_started(value);

    if (addon_state == final_generation::new_generation &&
        marker_state != final_generation::new_generation)
    {
        throw manager_error(
            "transaction-invalid",
            "The new final add-on exists without the new final marker.",
            exit_category::preserved_state);
    }

    if (addon_state == final_generation::old_generation &&
        backup_addon)
    {
        throw manager_error(
            "transaction-invalid",
            "The update contains duplicate old add-on generations.",
            exit_category::preserved_state);
    }
    if (marker_state == final_generation::old_generation &&
        backup_marker)
    {
        throw manager_error(
            "transaction-invalid",
            "The update contains duplicate old marker generations.",
            exit_category::preserved_state);
    }
    if (addon_state == final_generation::new_generation &&
        temp_addon)
    {
        throw manager_error(
            "transaction-invalid",
            "The update contains duplicate new add-on generations.",
            exit_category::preserved_state);
    }
    if (marker_state == final_generation::new_generation &&
        temp_marker)
    {
        throw manager_error(
            "transaction-invalid",
            "The update contains duplicate new marker generations.",
            exit_category::preserved_state);
    }

    const bool old_pair_still_final =
        addon_state == final_generation::old_generation &&
        marker_state == final_generation::old_generation &&
        !backup_addon && !backup_marker;
    if (old_pair_still_final && (!temp_addon || !temp_marker))
    {
        // Staging did not complete, and no public name changed.
        if (temp_addon)
            delete_exact(*temp_addon);
        if (temp_marker)
            delete_exact(*temp_marker);
        delete_journal(value);
        return;
    }

    if (!cleanup)
    {
        if (addon_state != final_generation::new_generation &&
            !backup_addon &&
            addon_state != final_generation::old_generation)
        {
            throw manager_error(
                "transaction-invalid",
                "The old add-on generation disappeared before cleanup.",
                exit_category::preserved_state);
        }
        if (marker_state != final_generation::new_generation &&
            !backup_marker &&
            marker_state != final_generation::old_generation)
        {
            throw manager_error(
                "transaction-invalid",
                "The old marker generation disappeared before cleanup.",
                exit_category::preserved_state);
        }
    }

    if (backup_addon ||
        addon_state == final_generation::new_generation)
    {
        record_through(value, "addon-backed-up");
    }
    if (backup_marker ||
        marker_state == final_generation::new_generation)
    {
        record_through(value, "marker-backed-up");
    }
    if (marker_state == final_generation::new_generation)
        record_through(value, "marker-published");
    if (addon_state == final_generation::new_generation)
        record_through(value, "addon-published");

    if (addon_state == final_generation::old_generation)
    {
        rename_no_replace(*final_addon, directory, value.addon_backup);
        backup_addon = std::move(final_addon);
        addon_state = final_generation::absent;
        record_through(value, "addon-backed-up");
    }
    if (marker_state == final_generation::old_generation)
    {
        rename_no_replace(*final_marker, directory, value.marker_backup);
        backup_marker = std::move(final_marker);
        marker_state = final_generation::absent;
        record_through(value, "marker-backed-up");
    }
    if (marker_state == final_generation::absent)
    {
        if (!temp_marker)
        {
            throw manager_error(
                "transaction-invalid",
                "The new marker generation is missing.",
                exit_category::preserved_state);
        }
        rename_no_replace(*temp_marker, directory, marker_leaf);
        final_marker = std::move(temp_marker);
        marker_state = final_generation::new_generation;
        record_through(value, "marker-published");
    }
    if (addon_state == final_generation::absent)
    {
        if (!temp_addon)
        {
            throw manager_error(
                "transaction-invalid",
                "The new add-on generation is missing.",
                exit_category::preserved_state);
        }
        rename_no_replace(*temp_addon, directory, addon_leaf);
        final_addon = std::move(temp_addon);
        addon_state = final_generation::new_generation;
        record_through(value, "addon-published");
    }
    if (addon_state != final_generation::new_generation ||
        marker_state != final_generation::new_generation)
    {
        throw manager_error(
            "transaction-invalid",
            "The update could not establish the new owned pair.",
            exit_category::preserved_state);
    }

    if (!is_cleanup_started(value))
        record_through(value, "cleanup-started");
    if (backup_addon)
        delete_exact(*backup_addon);
    if (backup_marker)
        delete_exact(*backup_marker);
    record_through(value, "completed");
    delete_journal(value);
}

void recover_remove(
    transaction &value,
    const open_directory &directory,
    const std::wstring &addon_path)
{
    auto final_addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto final_marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    auto backup_addon = open_managed_file(
        directory,
        value.addon_backup,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto backup_marker = open_managed_file(
        directory,
        value.marker_backup,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    ensure_absent(
        directory,
        value.addon_temp,
        addon_path,
        value.reshade_hash);
    ensure_absent(
        directory,
        value.marker_temp,
        addon_path,
        value.reshade_hash);
    verify_addon_role(
        final_addon,
        value.old_addon_hash,
        "The final add-on is not the journaled removal generation.");
    verify_marker_role(
        final_marker,
        value.old_addon_hash,
        "The final marker is not the journaled removal generation.");
    verify_addon_role(
        backup_addon,
        value.old_addon_hash,
        "The backup add-on is not the journaled removal generation.");
    verify_marker_role(
        backup_marker,
        value.old_addon_hash,
        "The backup marker is not the journaled removal generation.");
    if ((final_addon && backup_addon) ||
        (final_marker && backup_marker))
    {
        throw manager_error(
            "transaction-invalid",
            "A removal transaction contains duplicate generations.",
            exit_category::preserved_state);
    }
    if (!is_cleanup_started(value) &&
        ((!final_addon && !backup_addon) ||
         (!final_marker && !backup_marker)))
    {
        throw manager_error(
            "transaction-invalid",
            "An owned removal artifact disappeared before cleanup.",
            exit_category::preserved_state);
    }
    if (backup_addon)
        record_through(value, "addon-backed-up");
    if (backup_marker)
        record_through(value, "marker-backed-up");
    if (final_addon)
    {
        rename_no_replace(*final_addon, directory, value.addon_backup);
        backup_addon = std::move(final_addon);
        record_through(value, "addon-backed-up");
    }
    if (final_marker)
    {
        rename_no_replace(*final_marker, directory, value.marker_backup);
        backup_marker = std::move(final_marker);
        record_through(value, "marker-backed-up");
    }
    if (!is_cleanup_started(value))
        record_through(value, "cleanup-started");
    if (backup_addon)
        delete_exact(*backup_addon);
    if (backup_marker)
        delete_exact(*backup_marker);
    record_through(value, "completed");
    delete_journal(value);
}

void verify_addon_role_one_of(
    const std::optional<managed_file> &file,
    std::string_view first_hash,
    std::string_view second_hash,
    const char *message)
{
    if (file &&
        file->hash != first_hash &&
        (second_hash.empty() || file->hash != second_hash))
    {
        throw manager_error(
            "transaction-invalid",
            message,
            exit_category::preserved_state);
    }
}

void verify_marker_role_one_of(
    const std::optional<managed_file> &file,
    std::string_view first_hash,
    std::string_view second_hash,
    const char *message)
{
    if (file &&
        (!file->marker ||
         (file->marker->addon_sha256 != first_hash &&
          (second_hash.empty() ||
           file->marker->addon_sha256 != second_hash))))
    {
        throw manager_error(
            "transaction-invalid",
            message,
            exit_category::preserved_state);
    }
}

void require_cleanup_role_absent(
    const std::optional<managed_file> &file,
    const char *message)
{
    if (file)
    {
        throw manager_error(
            "transaction-invalid",
            message,
            exit_category::preserved_state);
    }
}

void delete_if_present(std::optional<managed_file> &file)
{
    if (file)
        delete_exact(*file);
}

void cleanup_pending_transaction_for_remove(
    transaction &value,
    const open_directory &directory,
    const std::wstring &addon_path)
{
    const bool removal_started =
        is_runtime_change_removal_started(value);
    const bool removal_completed =
        is_runtime_change_removal_completed(value);

    auto final_addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto final_marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    auto temp_addon = open_managed_file(
        directory,
        value.addon_temp,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto temp_marker = open_managed_file(
        directory,
        value.marker_temp,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    auto backup_addon = open_managed_file(
        directory,
        value.addon_backup,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto backup_marker = open_managed_file(
        directory,
        value.marker_backup,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);

    if (value.operation == "install")
    {
        verify_addon_role(
            final_addon,
            value.new_addon_hash,
            "The final add-on is not the journaled install artifact.");
        verify_addon_role(
            temp_addon,
            value.new_addon_hash,
            "The staged add-on is not the journaled install artifact.");
        verify_marker_role(
            final_marker,
            value.new_addon_hash,
            "The final marker is not the journaled install marker.");
        verify_marker_role(
            temp_marker,
            value.new_addon_hash,
            "The staged marker is not the journaled install marker.");
        require_cleanup_role_absent(
            backup_addon,
            "An install transaction unexpectedly contains an add-on backup.");
        require_cleanup_role_absent(
            backup_marker,
            "An install transaction unexpectedly contains a marker backup.");

        if ((final_addon && temp_addon) ||
            (final_marker && temp_marker))
        {
            throw manager_error(
                "transaction-invalid",
                "An install transaction contains duplicate generations.",
                exit_category::preserved_state);
        }
        if (!removal_started &&
            (final_addon || final_marker) &&
            ((!final_addon && !temp_addon) ||
             (!final_marker && !temp_marker) ||
             (final_addon && !final_marker)))
        {
            throw manager_error(
                "transaction-invalid",
                "An install transaction has an incomplete published generation.",
                exit_category::preserved_state);
        }
    }
    else if (value.operation == "update")
    {
        verify_addon_role_one_of(
            final_addon,
            value.old_addon_hash,
            value.new_addon_hash,
            "The final update add-on has neither journaled generation.");
        verify_marker_role_one_of(
            final_marker,
            value.old_addon_hash,
            value.new_addon_hash,
            "The final update marker has neither journaled generation.");
        verify_addon_role(
            temp_addon,
            value.new_addon_hash,
            "The staged update add-on has an unexpected hash.");
        verify_marker_role(
            temp_marker,
            value.new_addon_hash,
            "The staged update marker has an unexpected hash.");
        verify_addon_role(
            backup_addon,
            value.old_addon_hash,
            "The backup add-on has an unexpected hash.");
        verify_marker_role(
            backup_marker,
            value.old_addon_hash,
            "The backup marker has an unexpected hash.");

        const final_generation addon_state =
            addon_generation(final_addon, value);
        const final_generation marker_state =
            marker_generation(final_marker, value);
        if (addon_state == final_generation::new_generation &&
            marker_state != final_generation::new_generation)
        {
            throw manager_error(
                "transaction-invalid",
                "The new final add-on exists without the new final marker.",
                exit_category::preserved_state);
        }
        if ((addon_state == final_generation::old_generation &&
             backup_addon) ||
            (marker_state == final_generation::old_generation &&
             backup_marker) ||
            (addon_state == final_generation::new_generation &&
             temp_addon) ||
            (marker_state == final_generation::new_generation &&
             temp_marker))
        {
            throw manager_error(
                "transaction-invalid",
                "An update transaction contains duplicate generations.",
                exit_category::preserved_state);
        }
        if (!removal_started && !is_cleanup_started(value))
        {
            if (addon_state != final_generation::new_generation &&
                !backup_addon &&
                addon_state != final_generation::old_generation)
            {
                throw manager_error(
                    "transaction-invalid",
                    "The old add-on generation disappeared before cleanup.",
                    exit_category::preserved_state);
            }
            if (marker_state != final_generation::new_generation &&
                !backup_marker &&
                marker_state != final_generation::old_generation)
            {
                throw manager_error(
                    "transaction-invalid",
                    "The old marker generation disappeared before cleanup.",
                    exit_category::preserved_state);
            }
        }
    }
    else if (value.operation == "remove")
    {
        verify_addon_role(
            final_addon,
            value.old_addon_hash,
            "The final add-on is not the journaled removal generation.");
        verify_marker_role(
            final_marker,
            value.old_addon_hash,
            "The final marker is not the journaled removal generation.");
        verify_addon_role(
            backup_addon,
            value.old_addon_hash,
            "The backup add-on is not the journaled removal generation.");
        verify_marker_role(
            backup_marker,
            value.old_addon_hash,
            "The backup marker is not the journaled removal generation.");
        require_cleanup_role_absent(
            temp_addon,
            "A removal transaction unexpectedly contains a staged add-on.");
        require_cleanup_role_absent(
            temp_marker,
            "A removal transaction unexpectedly contains a staged marker.");

        if ((final_addon && backup_addon) ||
            (final_marker && backup_marker))
        {
            throw manager_error(
                "transaction-invalid",
                "A removal transaction contains duplicate generations.",
                exit_category::preserved_state);
        }
        if (!removal_started &&
            !is_cleanup_started(value) &&
            ((!final_addon && !backup_addon) ||
             (!final_marker && !backup_marker)))
        {
            throw manager_error(
                "transaction-invalid",
                "An owned removal artifact disappeared before cleanup.",
                exit_category::preserved_state);
        }
    }
    else
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction operation is unsupported.",
            exit_category::preserved_state);
    }

    const bool any_artifact =
        final_addon || final_marker ||
        temp_addon || temp_marker ||
        backup_addon || backup_marker;
    if (removal_completed && any_artifact)
    {
        throw manager_error(
            "transaction-invalid",
            "A completed runtime-change removal contains a managed artifact.",
            exit_category::preserved_state);
    }

    if (!removal_started)
        append_phase(value, runtime_change_removal_started_phase);

    // Every surviving handle was opened and role-validated before the first
    // mutation. Delete binaries before their ownership markers and never
    // publish or restore an interrupted install/update generation.
    delete_if_present(final_addon);
    delete_if_present(temp_addon);
    delete_if_present(backup_addon);
    delete_if_present(final_marker);
    delete_if_present(temp_marker);
    delete_if_present(backup_marker);

    if (!removal_completed)
        append_phase(value, runtime_change_removal_completed_phase);
    delete_journal(value);
}

bool recover_if_present(
    const open_directory &directory,
    const std::wstring &addon_path,
    std::string_view held_reshade_hash)
{
    auto existing = open_transaction(directory);
    if (!existing)
        return false;
    discard_torn_journal_suffix(*existing);
    if (is_runtime_change_removal_started(*existing))
    {
        cleanup_pending_transaction_for_remove(
            *existing,
            directory,
            addon_path);
        return true;
    }
    if (existing->held_reshade_hash != held_reshade_hash)
    {
        throw manager_error(
            "transaction-runtime-mismatch",
            "The pending transaction belongs to a different exact ReShade module.",
            exit_category::preserved_state);
    }
    if (existing->operation == "install")
        recover_install(*existing, directory, addon_path);
    else if (existing->operation == "update")
        recover_update(*existing, directory, addon_path);
    else if (existing->operation == "remove")
        recover_remove(*existing, directory, addon_path);
    else
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction operation is unsupported.",
            exit_category::preserved_state);
    }
    return true;
}

bool recover_for_remove_if_present(
    const open_directory &directory,
    const std::wstring &addon_path,
    std::string_view held_reshade_hash)
{
    auto existing = open_transaction(directory);
    if (!existing)
        return false;
    discard_torn_journal_suffix(*existing);
    if (is_runtime_change_removal_started(*existing) ||
        existing->held_reshade_hash != held_reshade_hash)
    {
        cleanup_pending_transaction_for_remove(
            *existing,
            directory,
            addon_path);
        return true;
    }

    if (existing->operation == "install")
        recover_install(*existing, directory, addon_path);
    else if (existing->operation == "update")
        recover_update(*existing, directory, addon_path);
    else if (existing->operation == "remove")
        recover_remove(*existing, directory, addon_path);
    else
    {
        throw manager_error(
            "transaction-invalid",
            "The transaction operation is unsupported.",
            exit_category::preserved_state);
    }
    return true;
}

bool transaction_present_readonly(const open_directory &directory)
{
    try
    {
        relative_open_result opened = nt_open_relative(
            directory.handle.get(),
            journal_leaf,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            false,
            "io-failed",
            exit_category::io_failure);
        if (opened.missing)
            return false;
        verify_regular_non_reparse_handle(
            opened.handle.get(),
            append_leaf(directory.canonical_path, journal_leaf),
            "transaction-invalid",
            exit_category::preserved_state);
        const std::vector<std::uint8_t> bytes = read_bounded(
            opened.handle.get(),
            max_journal_size,
            "transaction-invalid");
        parse_transaction(
            std::move(opened.handle),
            bytes);
        return true;
    }
    catch (const manager_error &error)
    {
        if (error.windows_error() &&
            (*error.windows_error() == ERROR_SHARING_VIOLATION ||
             *error.windows_error() == ERROR_LOCK_VIOLATION))
        {
            return true;
        }
        throw;
    }
}

void discard_unpublished_transaction_noexcept(
    transaction &value,
    std::optional<managed_file> &staged_addon,
    std::optional<managed_file> &staged_marker) noexcept
{
    if (staged_marker)
        discard_created_file_noexcept(staged_marker->handle);
    if (staged_addon)
        discard_created_file_noexcept(staged_addon->handle);
    discard_created_file_noexcept(value.journal);
}

#if defined(ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_TEST_FAULTS)
void fail_uncommitted_stage_for_test(const transaction &value)
{
    std::array<wchar_t, 32> configured = {};
    const DWORD length = GetEnvironmentVariableW(
        L"ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_FAIL_UNCOMMITTED_STAGE",
        configured.data(),
        static_cast<DWORD>(configured.size()));
    if (length != 0 && length < configured.size() &&
        utf8_from_wide(
            std::wstring_view(configured.data(), length)) ==
            value.operation)
    {
        throw manager_error(
            "io-failed",
            "A test fault interrupted uncommitted add-on staging.",
            exit_category::io_failure);
    }
}
#endif

void run_install_transaction(
    transaction &value,
    const open_directory &directory,
    HANDLE source,
    const std::wstring &addon_path)
{
    std::optional<managed_file> staged_addon;
    std::optional<managed_file> staged_marker;
    try
    {
        staged_addon = stage_source(
            directory,
            value.addon_temp,
            source,
            value.new_addon_hash);
        const std::string marker_bytes = serialize_marker(
            addon_path,
            value.new_addon_hash,
            value.reshade_hash);
        const std::string marker_hash = [&] {
            sha256_state hash;
            hash.update(
                reinterpret_cast<const std::uint8_t *>(marker_bytes.data()),
                marker_bytes.size());
            return hash.finish();
        }();
        staged_marker = stage_bytes(
            directory,
            value.marker_temp,
            marker_bytes.data(),
            marker_bytes.size(),
            marker_hash,
            max_marker_size);
        staged_marker->marker =
            marker_data{value.new_addon_hash, value.reshade_hash};
#if defined(ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_TEST_FAULTS)
        fail_uncommitted_stage_for_test(value);
#endif
        append_phase(value, "staged");
    }
    catch (...)
    {
        discard_unpublished_transaction_noexcept(
            value,
            staged_addon,
            staged_marker);
        throw;
    }
    rename_no_replace(*staged_marker, directory, marker_leaf);
    append_phase(value, "marker-published");
    rename_no_replace(*staged_addon, directory, addon_leaf);
    append_phase(value, "addon-published");
    append_phase(value, "cleanup-started");
    append_phase(value, "completed");
    delete_journal(value);
}

void run_update_transaction(
    transaction &value,
    const open_directory &directory,
    HANDLE source,
    const std::wstring &addon_path)
{
    std::optional<managed_file> staged_addon;
    std::optional<managed_file> staged_marker;
    try
    {
        staged_addon = stage_source(
            directory,
            value.addon_temp,
            source,
            value.new_addon_hash);
        const std::string marker_bytes = serialize_marker(
            addon_path,
            value.new_addon_hash,
            value.reshade_hash);
        const std::string marker_hash = [&] {
            sha256_state hash;
            hash.update(
                reinterpret_cast<const std::uint8_t *>(marker_bytes.data()),
                marker_bytes.size());
            return hash.finish();
        }();
        staged_marker = stage_bytes(
            directory,
            value.marker_temp,
            marker_bytes.data(),
            marker_bytes.size(),
            marker_hash,
            max_marker_size);
        staged_marker->marker =
            marker_data{value.new_addon_hash, value.reshade_hash};
#if defined(ELECTRON_GAME_OVERLAY_RESHADE_MANAGER_TEST_FAULTS)
        fail_uncommitted_stage_for_test(value);
#endif
        append_phase(value, "staged");
    }
    catch (...)
    {
        discard_unpublished_transaction_noexcept(
            value,
            staged_addon,
            staged_marker);
        throw;
    }

    auto old_addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto old_marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    if (!old_addon || !old_marker ||
        old_addon->hash != value.old_addon_hash ||
        old_marker->marker->addon_sha256 != value.old_addon_hash)
    {
        throw manager_error(
            "write-race",
            "The owned add-on pair changed before update.",
            exit_category::transaction_race);
    }
    rename_no_replace(*old_addon, directory, value.addon_backup);
    append_phase(value, "addon-backed-up");
    rename_no_replace(*old_marker, directory, value.marker_backup);
    append_phase(value, "marker-backed-up");
    rename_no_replace(*staged_marker, directory, marker_leaf);
    append_phase(value, "marker-published");
    rename_no_replace(*staged_addon, directory, addon_leaf);
    append_phase(value, "addon-published");
    append_phase(value, "cleanup-started");
    delete_exact(*old_addon);
    delete_exact(*old_marker);
    append_phase(value, "completed");
    delete_journal(value);
}

void run_remove_transaction(
    transaction &value,
    const open_directory &directory,
    const std::wstring &addon_path)
{
    auto old_addon = open_managed_file(
        directory,
        addon_leaf,
        max_addon_size,
        false,
        addon_path,
        value.reshade_hash);
    auto old_marker = open_managed_file(
        directory,
        marker_leaf,
        max_marker_size,
        true,
        addon_path,
        value.reshade_hash);
    if (!old_addon || !old_marker ||
        old_addon->hash != value.old_addon_hash ||
        old_marker->marker->addon_sha256 != value.old_addon_hash)
    {
        throw manager_error(
            "write-race",
            "The owned add-on pair changed before removal.",
            exit_category::transaction_race);
    }
    rename_no_replace(*old_addon, directory, value.addon_backup);
    append_phase(value, "addon-backed-up");
    rename_no_replace(*old_marker, directory, value.marker_backup);
    append_phase(value, "marker-backed-up");
    append_phase(value, "cleanup-started");
    delete_exact(*old_addon);
    delete_exact(*old_marker);
    append_phase(value, "completed");
    delete_journal(value);
}

struct request
{
    std::string operation;
    std::wstring directory;
    std::wstring source;
    std::string source_hash;
    std::wstring reshade_module;
    std::string reshade_hash;
};

request parse_request(int argc, wchar_t **argv)
{
    if (argc < 2)
    {
        throw manager_error(
            "invalid-request",
            "An operation is required.",
            exit_category::invalid_request);
    }
    request result;
    if (wcscmp(argv[1], L"prepare") == 0)
        result.operation = "prepare";
    else if (wcscmp(argv[1], L"remove") == 0)
        result.operation = "remove";
    else if (wcscmp(argv[1], L"inspect") == 0)
        result.operation = "inspect";
    else
    {
        throw manager_error(
            "invalid-request",
            "The operation must be 'prepare', 'remove', or 'inspect'.",
            exit_category::invalid_request);
    }
    if ((argc - 2) % 2 != 0)
    {
        throw manager_error(
            "invalid-request",
            "Every option requires one value.",
            exit_category::invalid_request);
    }
    std::map<std::wstring, std::wstring> options;
    for (int index = 2; index < argc; index += 2)
    {
        std::wstring key(argv[index]);
        std::wstring value(argv[index + 1]);
        if (key.rfind(L"--", 0) != 0 || value.empty() ||
            !options.emplace(std::move(key), std::move(value)).second)
        {
            throw manager_error(
                "invalid-request",
                "An option is malformed or duplicated.",
                exit_category::invalid_request);
        }
    }
    const auto take = [&](const wchar_t *key) -> std::wstring {
        const auto entry = options.find(key);
        if (entry == options.end())
        {
            throw manager_error(
                "invalid-request",
                "A required option is missing.",
                exit_category::invalid_request);
        }
        return entry->second;
    };
    result.directory = take(L"--directory");
    result.reshade_module = take(L"--reshade-module");
    result.reshade_hash =
        utf8_from_wide(take(L"--reshade-module-sha256"));
    if (!is_upper_sha256(result.reshade_hash))
    {
        throw manager_error(
            "invalid-request",
            "The ReShade module SHA-256 must be 64 uppercase hex digits.",
            exit_category::invalid_request);
    }
    std::size_t expected_options = 3;
    if (result.operation == "prepare" ||
        result.operation == "inspect")
    {
        result.source = take(L"--source");
        result.source_hash =
            utf8_from_wide(take(L"--source-sha256"));
        if (!is_upper_sha256(result.source_hash))
        {
            throw manager_error(
                "invalid-request",
                "The source SHA-256 must be 64 uppercase hex digits.",
                exit_category::invalid_request);
        }
        expected_options = 5;
    }
    if (options.size() != expected_options)
    {
        throw manager_error(
            "invalid-request",
            "The request contains an unknown option.",
            exit_category::invalid_request);
    }
    return result;
}

struct command_result
{
    std::string operation;
    std::string status;
    std::wstring addon_path;
    std::wstring marker_path;
    std::wstring reshade_module_path;
    std::optional<std::string> addon_hash;
    std::optional<std::string> expected_hash;
    std::optional<std::string> previous_hash;
    std::string reshade_hash;
    bool recovered = false;
    bool restart_required = true;
};

command_result execute_prepare(const request &input)
{
    open_directory directory =
        open_verified_directory(input.directory, true);
    const std::wstring addon_path =
        append_leaf(directory.canonical_path, addon_leaf);
    const std::wstring marker_path =
        append_leaf(directory.canonical_path, marker_leaf);
    held_reshade_module reshade_module = open_held_reshade_module(
        input.reshade_module,
        input.reshade_hash);
    if (paths_equal(reshade_module.path, addon_path) ||
        paths_equal(reshade_module.path, marker_path))
    {
        throw manager_error(
            "invalid-request",
            "The ReShade module must be separate from managed destinations.",
            exit_category::invalid_request);
    }
    // A ReShade update is a supported host transition. If it happened during
    // an interrupted transaction, remove only the fully journaled project
    // artifacts before preparing the current generation. Same-runtime
    // transactions still follow their ordinary recovery path.
    const bool recovered =
        recover_for_remove_if_present(
            directory,
            addon_path,
            input.reshade_hash);

    const std::wstring source_path = normalize_absolute_path(
        input.source,
        "invalid-request",
        exit_category::invalid_request);
    if (paths_equal(source_path, addon_path) ||
        paths_equal(source_path, marker_path) ||
        paths_equal(source_path, reshade_module.path))
    {
        throw manager_error(
            "invalid-request",
            "The staged source must be separate from managed destinations.",
            exit_category::invalid_request);
    }
    unique_handle source = open_absolute_readonly_file(
        source_path,
        "source-changed",
        "The staged add-on source could not be opened.",
        false);
    const std::string actual_source_hash =
        hash_handle(source.get(), max_addon_size, "source-changed");
    if (actual_source_hash != input.source_hash)
    {
        throw manager_error(
            "source-changed",
            "The staged source does not match the exact requested hash.",
            exit_category::preserved_state);
    }

    const installed_pair existing = inspect_installed_pair(
        directory,
        addon_path,
        input.reshade_hash,
        true);
    if (existing.exists && existing.addon_hash == input.source_hash)
    {
        return {
            "prepare",
            "already-current",
            addon_path,
            marker_path,
            reshade_module.path,
            input.source_hash,
            input.source_hash,
            std::nullopt,
            input.reshade_hash,
            recovered,
            true};
    }

    if (!existing.exists)
    {
        transaction value = create_transaction(
            directory,
            "install",
            input.source_hash,
            "",
            input.reshade_hash,
            input.reshade_hash);
        run_install_transaction(
            value,
            directory,
            source.get(),
            addon_path);
        return {
            "prepare",
            "installed",
            addon_path,
            marker_path,
            reshade_module.path,
            input.source_hash,
            input.source_hash,
            std::nullopt,
            input.reshade_hash,
            recovered,
            true};
    }

    transaction value = create_transaction(
        directory,
        "update",
        input.source_hash,
        existing.addon_hash,
        existing.marker_reshade_hash,
        input.reshade_hash);
    run_update_transaction(
        value,
        directory,
        source.get(),
        addon_path);
    return {
        "prepare",
        "updated",
        addon_path,
        marker_path,
        reshade_module.path,
        input.source_hash,
        input.source_hash,
        existing.addon_hash,
        input.reshade_hash,
        recovered,
        true};
}

command_result execute_inspect(const request &input)
{
    open_directory directory =
        open_verified_directory(input.directory, false);
    const std::wstring addon_path =
        append_leaf(directory.canonical_path, addon_leaf);
    const std::wstring marker_path =
        append_leaf(directory.canonical_path, marker_leaf);
    held_reshade_module reshade_module = open_held_reshade_module(
        input.reshade_module,
        input.reshade_hash);
    if (paths_equal(reshade_module.path, addon_path) ||
        paths_equal(reshade_module.path, marker_path))
    {
        throw manager_error(
            "invalid-request",
            "The ReShade module must be separate from managed destinations.",
            exit_category::invalid_request);
    }

    const std::wstring source_path = normalize_absolute_path(
        input.source,
        "invalid-request",
        exit_category::invalid_request);
    if (paths_equal(source_path, addon_path) ||
        paths_equal(source_path, marker_path) ||
        paths_equal(source_path, reshade_module.path))
    {
        throw manager_error(
            "invalid-request",
            "The staged source must be separate from managed destinations.",
            exit_category::invalid_request);
    }
    unique_handle source = open_absolute_readonly_file(
        source_path,
        "source-changed",
        "The staged add-on source could not be opened.",
        false);
    const std::string actual_source_hash =
        hash_handle(source.get(), max_addon_size, "source-changed");
    if (actual_source_hash != input.source_hash)
    {
        throw manager_error(
            "source-changed",
            "The staged source does not match the exact requested hash.",
            exit_category::preserved_state);
    }

    bool transaction_pending = false;
    try
    {
        transaction_pending = transaction_present_readonly(directory);
    }
    catch (const manager_error &error)
    {
        if (error.code() == "transaction-invalid" ||
            error.code() == "path-reparse-point" ||
            error.code() == "path-not-canonical" ||
            error.code() == "path-identity-invalid")
        {
            return {
                "inspect",
                "foreign-collision",
                addon_path,
                marker_path,
                reshade_module.path,
                std::nullopt,
                input.source_hash,
                std::nullopt,
                input.reshade_hash,
                false,
                false};
        }
        throw;
    }
    if (transaction_pending)
    {
        return {
            "inspect",
            "transaction-pending",
            addon_path,
            marker_path,
            reshade_module.path,
            std::nullopt,
            input.source_hash,
            std::nullopt,
            input.reshade_hash,
            false,
            true};
    }

    std::optional<managed_file> addon;
    std::optional<managed_file> marker;
    bool reserved_path_invalid = false;
    try
    {
        addon = open_readonly_managed_file(
            directory,
            addon_leaf,
            max_addon_size,
            false,
            addon_path,
            input.reshade_hash);
    }
    catch (const manager_error &error)
    {
        if (error.code() == "path-reparse-point" ||
            error.code() == "path-not-canonical" ||
            error.code() == "path-identity-invalid")
        {
            reserved_path_invalid = true;
        }
        else
        {
            throw;
        }
    }
    try
    {
        marker = open_readonly_managed_file(
            directory,
            marker_leaf,
            max_marker_size,
            true,
            addon_path,
            input.reshade_hash,
            true);
    }
    catch (const manager_error &error)
    {
        if (error.code() == "ownership-marker-invalid" ||
            error.code() == "path-reparse-point" ||
            error.code() == "path-not-canonical" ||
            error.code() == "path-identity-invalid")
        {
            reserved_path_invalid = true;
        }
        else
        {
            throw;
        }
    }

    if (reserved_path_invalid || static_cast<bool>(addon) !=
                                     static_cast<bool>(marker))
    {
        return {
            "inspect",
            "foreign-collision",
            addon_path,
            marker_path,
            reshade_module.path,
            addon ? std::optional<std::string>(addon->hash)
                  : std::nullopt,
            input.source_hash,
            std::nullopt,
            input.reshade_hash,
            false,
            false};
    }
    if (!addon)
    {
        return {
            "inspect",
            "not-installed",
            addon_path,
            marker_path,
            reshade_module.path,
            std::nullopt,
            input.source_hash,
            std::nullopt,
            input.reshade_hash,
            false,
            false};
    }
    if (addon->hash != marker->marker->addon_sha256)
    {
        return {
            "inspect",
            "owned-tampered",
            addon_path,
            marker_path,
            reshade_module.path,
            addon->hash,
            input.source_hash,
            std::nullopt,
            input.reshade_hash,
            false,
            false};
    }
    const bool current = addon->hash == input.source_hash;
    return {
        "inspect",
        current ? "already-current" : "update-required",
        addon_path,
        marker_path,
        reshade_module.path,
        addon->hash,
        input.source_hash,
        std::nullopt,
        input.reshade_hash,
        false,
        !current};
}

command_result execute_remove(const request &input)
{
    open_directory directory =
        open_verified_directory(input.directory, true);
    const std::wstring addon_path =
        append_leaf(directory.canonical_path, addon_leaf);
    const std::wstring marker_path =
        append_leaf(directory.canonical_path, marker_leaf);
    held_reshade_module reshade_module = open_held_reshade_module(
        input.reshade_module,
        input.reshade_hash);
    if (paths_equal(reshade_module.path, addon_path) ||
        paths_equal(reshade_module.path, marker_path))
    {
        throw manager_error(
            "invalid-request",
            "The ReShade module must be separate from managed destinations.",
            exit_category::invalid_request);
    }
    const bool recovered =
        recover_for_remove_if_present(
            directory,
            addon_path,
            input.reshade_hash);
    const installed_pair existing = inspect_installed_pair(
        directory,
        addon_path,
        input.reshade_hash,
        true);
    if (!existing.exists)
    {
        return {
            "remove",
            "not-installed",
            addon_path,
            marker_path,
            reshade_module.path,
            std::nullopt,
            std::nullopt,
            std::nullopt,
            input.reshade_hash,
            recovered,
            true};
    }
    transaction value = create_transaction(
        directory,
        "remove",
        "",
        existing.addon_hash,
        existing.marker_reshade_hash,
        input.reshade_hash);
    run_remove_transaction(value, directory, addon_path);
    return {
        "remove",
        "removed",
        addon_path,
        marker_path,
        reshade_module.path,
        std::nullopt,
        std::nullopt,
        existing.addon_hash,
        input.reshade_hash,
        recovered,
        true};
}

void validate_success_result(const command_result &result)
{
    const auto fail = [] {
        throw manager_error(
            "internal-result-invalid",
            "The native manager produced an invalid success status shape.",
            exit_category::io_failure);
    };
    if (result.addon_path.empty() || result.marker_path.empty() ||
        result.reshade_module_path.empty() ||
        paths_equal(result.addon_path, result.marker_path) ||
        paths_equal(result.addon_path, result.reshade_module_path) ||
        paths_equal(result.marker_path, result.reshade_module_path) ||
        !is_upper_sha256(result.reshade_hash))
    {
        fail();
    }
    for (const auto *hash : {
             &result.addon_hash,
             &result.expected_hash,
             &result.previous_hash})
    {
        if (*hash && !is_upper_sha256(**hash))
            fail();
    }

    if (result.operation == "prepare")
    {
        if (!result.restart_required || !result.addon_hash ||
            !result.expected_hash ||
            *result.addon_hash != *result.expected_hash)
        {
            fail();
        }
        if (result.status == "updated")
        {
            if (!result.previous_hash ||
                *result.previous_hash == *result.expected_hash)
            {
                fail();
            }
        }
        else if (
            result.status == "installed" ||
            result.status == "already-current")
        {
            if (result.previous_hash)
                fail();
        }
        else
        {
            fail();
        }
        return;
    }

    if (result.operation == "inspect")
    {
        if (result.recovered || !result.expected_hash ||
            result.previous_hash)
        {
            fail();
        }
        if (result.status == "already-current")
        {
            if (!result.addon_hash ||
                *result.addon_hash != *result.expected_hash ||
                result.restart_required)
            {
                fail();
            }
        }
        else if (result.status == "update-required")
        {
            if (!result.addon_hash ||
                *result.addon_hash == *result.expected_hash ||
                !result.restart_required)
            {
                fail();
            }
        }
        else if (result.status == "not-installed")
        {
            if (result.addon_hash || result.restart_required)
                fail();
        }
        else if (result.status == "foreign-collision")
        {
            if (result.restart_required)
                fail();
        }
        else if (result.status == "owned-tampered")
        {
            if (!result.addon_hash || result.restart_required)
                fail();
        }
        else if (result.status == "transaction-pending")
        {
            if (result.addon_hash || !result.restart_required)
                fail();
        }
        else
        {
            fail();
        }
        return;
    }

    if (result.operation == "remove")
    {
        if (!result.restart_required || result.addon_hash ||
            result.expected_hash)
        {
            fail();
        }
        if (result.status == "removed")
        {
            if (!result.previous_hash)
                fail();
        }
        else if (result.status == "not-installed")
        {
            if (result.previous_hash)
                fail();
        }
        else
        {
            fail();
        }
        return;
    }
    fail();
}

std::string serialize_result(const command_result &result)
{
    validate_success_result(result);
    std::ostringstream stream;
    stream << "{"
           << "\"schemaVersion\":1,"
           << "\"kind\":" << json_string(result_kind) << ","
           << "\"operation\":" << json_string(result.operation) << ","
           << "\"status\":" << json_string(result.status) << ","
           << "\"addonPath\":" << json_string(result.addon_path) << ","
           << "\"markerPath\":" << json_string(result.marker_path) << ","
           << "\"reshadeModulePath\":"
           << json_string(result.reshade_module_path) << ","
           << "\"addonSha256\":";
    if (result.addon_hash)
        stream << json_string(*result.addon_hash);
    else
        stream << "null";
    stream << ",\"expectedAddonSha256\":";
    if (result.expected_hash)
        stream << json_string(*result.expected_hash);
    else
        stream << "null";
    stream << ",\"previousAddonSha256\":";
    if (result.previous_hash)
        stream << json_string(*result.previous_hash);
    else
        stream << "null";
    stream << ",\"reshadeModuleSha256\":"
           << json_string(result.reshade_hash) << ","
           << "\"recoveredTransaction\":"
           << (result.recovered ? "true" : "false") << ","
           << "\"restartRequired\":"
           << (result.restart_required ? "true" : "false")
           << "}\n";
    return stream.str();
}

std::string serialize_error(
    std::optional<std::string_view> operation,
    const manager_error &error)
{
    std::ostringstream stream;
    stream << "{"
           << "\"schemaVersion\":1,"
           << "\"kind\":" << json_string(result_kind) << ","
           << "\"operation\":";
    if (operation)
        stream << json_string(*operation);
    else
        stream << "null";
    stream << ",\"status\":\"error\","
           << "\"code\":" << json_string(error.code()) << ","
           << "\"message\":" << json_string(error.what()) << ","
           << "\"windowsError\":";
    if (error.windows_error())
        stream << *error.windows_error();
    else
        stream << "null";
    stream << "}\n";
    return stream.str();
}

void write_stdout(const std::string &text)
{
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE)
        return;
    const char *cursor = text.data();
    std::size_t remaining = text.size();
    while (remaining != 0)
    {
        const DWORD chunk = static_cast<DWORD>(
            (std::min)(
                remaining,
                static_cast<std::size_t>(
                    (std::numeric_limits<DWORD>::max)())));
        DWORD written = 0;
        if (!WriteFile(output, cursor, chunk, &written, nullptr) ||
            written == 0)
        {
            return;
        }
        cursor += written;
        remaining -= written;
    }
}
} // namespace

int wmain(int argc, wchar_t **argv)
{
    std::optional<std::string> operation;
    try
    {
        request input = parse_request(argc, argv);
        operation = input.operation;
        const command_result result =
            input.operation == "prepare"
                ? execute_prepare(input)
                : input.operation == "inspect"
                      ? execute_inspect(input)
                      : execute_remove(input);
        write_stdout(serialize_result(result));
        return static_cast<int>(exit_category::success);
    }
    catch (const manager_error &error)
    {
        write_stdout(serialize_error(
            operation
                ? std::optional<std::string_view>(*operation)
                : std::nullopt,
            error));
        return static_cast<int>(error.category());
    }
    catch (const std::exception &error)
    {
        manager_error wrapped(
            "io-failed",
            error.what(),
            exit_category::io_failure);
        write_stdout(serialize_error(
            operation
                ? std::optional<std::string_view>(*operation)
                : std::nullopt,
            wrapped));
        return static_cast<int>(wrapped.category());
    }
}
