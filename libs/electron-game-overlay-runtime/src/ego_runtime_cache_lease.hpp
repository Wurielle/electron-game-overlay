#pragma once

#include <Windows.h>
#include <array>
#include <string>
#include <string_view>
#include "ego_runtime_cache_bootstrap.hpp"

namespace ego::runtime_cache
{
    inline constexpr std::wstring_view ownership_file = L".electron-game-overlay-payload.json";
    inline constexpr std::array<std::wstring_view, 13> payload_files = {
        L"inject.exe", L"inject32.exe",
        L"electron_game_overlay_reshade_manager.exe", L"electron_game_overlay_reshade_manager32.exe",
        L"ReShade64.dll", L"ReShade32.dll", L"ReShade64.build.json", L"ReShade32.build.json",
        L"electron_game_overlay_runtime.build.json", L"electron_game_overlay_runtime32.build.json",
        L"electron_game_overlay.addon64", L"electron_game_overlay.addon32", L"ReShade.ini",
    };

    class handle
    {
    public:
        handle() = default;
        handle(const handle &) = delete;
        handle &operator=(const handle &) = delete;
        ~handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
        HANDLE value = INVALID_HANDLE_VALUE;
    };

    inline DWORD open_pinned(const std::wstring &path, bool directory, handle &guard)
    {
        const std::wstring extended = L"\\\\?\\" + path;
        guard.value = CreateFileW(extended.c_str(), directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES : GENERIC_READ,
            FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT |
            (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
        if (guard.value == INVALID_HANDLE_VALUE) return GetLastError();

        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(guard.value, &info)) return GetLastError();
        if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
            ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
            (!directory && (info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) == 0))
            return ERROR_CANT_ACCESS_FILE;

        // Check the opened object, including ancestors, against the expected
        // DOS spelling. Never lease a cache reached through a junction.
        std::wstring actual(extended.size() + 1, L'\0');
        const DWORD length = GetFinalPathNameByHandleW(guard.value, actual.data(),
            static_cast<DWORD>(actual.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (length == 0) return GetLastError();
        if (length != extended.size() || CompareStringOrdinal(actual.data(), static_cast<int>(length),
            extended.data(), static_cast<int>(extended.size()), TRUE) != CSTR_EQUAL)
            return ERROR_CANT_ACCESS_FILE;
        return ERROR_SUCCESS;
    }

    inline DWORD create_log(const std::wstring &cache_directory, std::wstring_view argument, handle &log)
    {
        const auto cache = dos_path(cache_directory);
        const auto directory = dos_path(argument);
        if (!is_version_directory(cache)) return ERROR_INVALID_PARAMETER;
        const auto version_separator = cache.find_last_of(L'\\');
        const auto root = cache.substr(0, version_separator - version_store_suffix.size());
        const auto log_separator = directory.find_last_of(L'\\');
        if (log_separator != root.size() || CompareStringOrdinal(directory.data(), static_cast<int>(log_separator),
            root.data(), static_cast<int>(root.size()), TRUE) != CSTR_EQUAL) return ERROR_INVALID_NAME;
        const auto name = directory.substr(log_separator + 1);
        if (name.size() != 41 || name.substr(0, 5) != L"logs-" ||
            name.substr(5).find_first_not_of(L"0123456789abcdef-") != std::wstring_view::npos)
            return ERROR_INVALID_NAME;

        handle parent;
        const std::wstring canonical(directory);
        const DWORD error = open_pinned(canonical, true, parent);
        if (error != ERROR_SUCCESS) return error;
        log.value = CreateFileW((L"\\\\?\\" + canonical + L"\\ReShade.log").c_str(),
            GENERIC_WRITE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        return log.value == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    }

    class lease
    {
    public:
        // All immutable files are held through validation and loading. The
        // target retains the directory guard, which excludes collection's
        // initial atomic rename for the lifetime of the exact process.
        DWORD acquire(std::wstring_view path)
        {
            if (directory_.value != INVALID_HANDLE_VALUE || !is_version_directory(path))
                return ERROR_INVALID_PARAMETER;
            const std::wstring directory(dos_path(path));
            DWORD error = open_pinned(directory, true, directory_);
            if (error != ERROR_SUCCESS) return error;
            const auto prefix = directory + L'\\';
            error = open_pinned(prefix + std::wstring(ownership_file), false, marker_);
            if (error != ERROR_SUCCESS) return error;
            for (size_t index = 0; index != payload_files.size(); ++index)
            {
                error = open_pinned(prefix + std::wstring(payload_files[index]), false, files_[index]);
                if (error != ERROR_SUCCESS) return error;
            }
            acquired_ = true;
            return ERROR_SUCCESS;
        }

        DWORD retain_in_target(HANDLE process) const noexcept
        {
            if (!acquired_) return ERROR_INVALID_STATE;
            HANDLE target_guard = nullptr;
            if (!DuplicateHandle(GetCurrentProcess(), directory_.value, process, &target_guard,
                FILE_READ_ATTRIBUTES, FALSE, 0))
                return GetLastError();
            return ERROR_SUCCESS;
        }

        DWORD runtime_identity(bool is_x64, file_identity &identity) const noexcept
        {
            if (!acquired_) return ERROR_INVALID_STATE;
            return read_identity(files_[is_x64 ? 4 : 5].value, identity);
        }

        DWORD read_configuration(std::string &configuration) const
        {
            if (!acquired_) return ERROR_INVALID_STATE;
            const HANDLE file = files_.back().value;
            LARGE_INTEGER size{};
            if (!GetFileSizeEx(file, &size)) return GetLastError();
            if (size.QuadPart <= 0 || size.QuadPart > max_config_bytes) return ERROR_INVALID_DATA;
            configuration.resize(static_cast<size_t>(size.QuadPart));
            DWORD read = 0;
            if (!ReadFile(file, configuration.data(), static_cast<DWORD>(configuration.size()), &read, nullptr))
                return GetLastError();
            return read == configuration.size() && valid_seed(configuration) ? ERROR_SUCCESS : ERROR_INVALID_DATA;
        }

    private:
        handle directory_;
        handle marker_;
        std::array<handle, payload_files.size()> files_;
        bool acquired_ = false;
    };
}
