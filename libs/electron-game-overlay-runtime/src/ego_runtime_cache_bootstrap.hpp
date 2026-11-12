#pragma once

#include <Windows.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace ego::runtime_cache
{
    inline constexpr DWORD max_config_bytes = 64 * 1024;
    inline constexpr std::uint32_t bootstrap_magic = 0x31434745; // EGC1
    inline constexpr std::wstring_view version_store_suffix = L".sdk-versions-v1";

    inline std::wstring_view dos_path(std::wstring_view path) noexcept
    {
        if (path.substr(0, 4) == L"\\\\?\\") path.remove_prefix(4);
        return path;
    }

    inline bool is_version_directory(std::wstring_view path) noexcept
    {
        constexpr auto suffix = version_store_suffix;
        path = dos_path(path);
        if (path.size() < 4 + suffix.size() + 65 || path[1] != L':' || path[2] != L'\\')
            return false;
        const auto separator = path.find_last_of(L'\\');
        if (path.size() - separator != 65 || separator < suffix.size() ||
            path.substr(separator - suffix.size(), suffix.size()) != suffix)
            return false;
        const auto version_key = path.substr(separator + 1);
        return version_key.find_first_not_of(L"0123456789abcdef") == std::wstring_view::npos;
    }

    struct file_identity
    {
        std::uint32_t volume = 0;
        std::uint32_t index_high = 0;
        std::uint32_t index_low = 0;
    };

    struct bootstrap_header
    {
        std::uint32_t magic = bootstrap_magic;
        std::uint32_t version = 2;
        std::uint32_t struct_size = sizeof(bootstrap_header);
        std::uint32_t target_pid = 0;
        std::uint64_t target_creation_time = 0;
        file_identity runtime{};
        std::uint32_t config_bytes = 0;
        std::uint64_t log_handle = 0;
        file_identity log_file{};
        std::uint32_t reserved = 0;
    };
    static_assert(sizeof(bootstrap_header) == 64);
    static_assert(offsetof(bootstrap_header, target_creation_time) == 16);

    inline DWORD creation_time(HANDLE process, std::uint64_t &time) noexcept
    {
        FILETIME created{}, exited{}, kernel{}, user{};
        if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return GetLastError();
        time = (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        return time == 0 ? ERROR_INVALID_DATA : ERROR_SUCCESS;
    }

    inline std::wstring host_claim_name(DWORD pid, std::uint64_t birth)
    {
        return L"Local\\electron-game-overlay-host-v1-" + std::to_wstring(pid) + L"-" + std::to_wstring(birth);
    }

    inline DWORD read_identity(HANDLE file, file_identity &identity) noexcept
    {
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(file, &info)) return GetLastError();
        if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
            return ERROR_CANT_ACCESS_FILE;
        identity = { info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow };
        return ERROR_SUCCESS;
    }

    inline bool same_file(const file_identity &a, const file_identity &b) noexcept
    {
        return a.volume == b.volume && a.index_high == b.index_high && a.index_low == b.index_low;
    }

    inline bool valid_seed(std::string_view seed) noexcept
    {
        return !seed.empty() && seed.size() <= max_config_bytes && seed.find('\0') == std::string_view::npos;
    }

    inline DWORD write_bootstrap(HANDLE mapping, const bootstrap_header &header, std::string_view seed) noexcept
    {
        if (!valid_seed(seed) || header.config_bytes != seed.size()) return ERROR_INVALID_DATA;
        void *const view = MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, sizeof(header) + seed.size());
        if (view == nullptr) return GetLastError();
        memcpy(view, &header, sizeof(header));
        memcpy(static_cast<char *>(view) + sizeof(header), seed.data(), seed.size());
        UnmapViewOfFile(view);
        return ERROR_SUCCESS;
    }

    inline DWORD read_bootstrap(HANDLE mapping, DWORD pid, std::uint64_t birth,
        const file_identity &runtime, std::string &seed, HANDLE &log)
    {
        struct mapped_view
        {
            const void *value;
            ~mapped_view() { if (value != nullptr) UnmapViewOfFile(value); }
        };
        const mapped_view view { MapViewOfFile(mapping, FILE_MAP_READ, 0, 0,
            sizeof(bootstrap_header) + max_config_bytes) };
        if (view.value == nullptr) return GetLastError();
        bootstrap_header header;
        memcpy(&header, view.value, sizeof(header));
        if (header.magic != bootstrap_magic || header.version != 2 || header.struct_size != sizeof(header) ||
            header.target_pid != pid || header.target_creation_time != birth ||
            !same_file(header.runtime, runtime) || header.config_bytes == 0 || header.config_bytes > max_config_bytes ||
            header.log_handle > UINTPTR_MAX || header.reserved != 0)
            return ERROR_INVALID_DATA;
        const auto bytes = std::string_view(static_cast<const char *>(view.value) + sizeof(header), header.config_bytes);
        if (!valid_seed(bytes)) return ERROR_INVALID_DATA;
        const auto log_handle = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(header.log_handle));
        if (log_handle != nullptr)
        {
            file_identity log_identity;
            if (GetFileType(log_handle) != FILE_TYPE_DISK || read_identity(log_handle, log_identity) != ERROR_SUCCESS ||
                !same_file(log_identity, header.log_file)) return ERROR_INVALID_DATA;
        }
        seed.assign(bytes);
        log = log_handle;
        return ERROR_SUCCESS;
    }
}
