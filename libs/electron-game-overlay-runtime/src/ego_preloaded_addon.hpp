#pragma once

#include <array>
#include <cstddef>
#include <string_view>

namespace ego::preloaded_addon
{
enum class preload_filename_kind
{
    ordinary,
    valid,
    invalid,
};

struct filename_identity
{
    preload_filename_kind kind = preload_filename_kind::ordinary;
    // Stock ReShade requires each folder-loaded module to have a distinct NAME.
    // The validated ASCII leaf also gives an offline add-on a stable name.
    std::array<char, 160> public_name = {};
};

namespace detail
{
inline constexpr wchar_t ascii_lower(wchar_t value) noexcept
{
    return value >= L'A' && value <= L'Z'
        ? static_cast<wchar_t>(value + (L'a' - L'A')) : value;
}

inline constexpr bool is_lower_hex(wchar_t value) noexcept
{
    return (value >= L'0' && value <= L'9') ||
        (value >= L'a' && value <= L'f');
}

inline constexpr bool is_hex(wchar_t value) noexcept
{
    return is_lower_hex(ascii_lower(value));
}
} // namespace detail

// The filename is a dormancy marker, not proof of its file's contents. Callers
// must still validate the expected module/build identity before activation.
// A case variant of the reserved prefix is invalid too: Windows filename case
// aliases must never turn an intended dormant add-on into an ordinary member.
inline constexpr filename_identity classify_filename(
    std::wstring_view leaf,
    std::string_view expected_build_id,
    bool is_64_bit) noexcept
{
    constexpr std::wstring_view prefix = L"ego-preload-";
    constexpr std::size_t app_begin = prefix.size();
    constexpr std::size_t app_size = 32;
    constexpr std::size_t build_begin = app_begin + app_size + 1;
    constexpr std::size_t build_size = 32;
    constexpr std::size_t hash_begin = build_begin + build_size + 1;
    constexpr std::size_t hash_size = 16;
    constexpr std::size_t suffix_begin = hash_begin + hash_size;
    constexpr std::wstring_view suffix_64 = L".addon64";
    constexpr std::wstring_view suffix_32 = L".addon32";
    constexpr std::size_t leaf_size = suffix_begin + suffix_64.size();
    constexpr std::string_view public_name_prefix = "Electron Game Overlay Runtime ";
    static_assert(public_name_prefix.size() + leaf_size + 1 <=
        filename_identity{}.public_name.size());

    filename_identity result;
    if (leaf.size() < prefix.size())
        return result;
    for (std::size_t index = 0; index < prefix.size(); ++index)
    {
        if (detail::ascii_lower(leaf[index]) != prefix[index])
            return result;
    }

    result.kind = preload_filename_kind::invalid;
    if (leaf.size() != leaf_size || expected_build_id.size() != build_size ||
        leaf.substr(0, prefix.size()) != prefix ||
        leaf[app_begin + app_size] != L'-' ||
        leaf[build_begin + build_size] != L'-' ||
        leaf.substr(suffix_begin) != (is_64_bit ? suffix_64 : suffix_32))
    {
        return result;
    }
    for (std::size_t index = 0; index < app_size; ++index)
    {
        if (!detail::is_lower_hex(leaf[app_begin + index]))
            return result;
    }
    for (std::size_t index = 0; index < build_size; ++index)
    {
        const wchar_t actual = leaf[build_begin + index];
        const wchar_t expected = static_cast<unsigned char>(expected_build_id[index]);
        if (!detail::is_hex(actual) || !detail::is_hex(expected) ||
            detail::ascii_lower(actual) != detail::ascii_lower(expected))
        {
            return result;
        }
    }
    for (std::size_t index = 0; index < hash_size; ++index)
    {
        if (!detail::is_lower_hex(leaf[hash_begin + index]))
            return result;
    }

    for (std::size_t index = 0; index < public_name_prefix.size(); ++index)
        result.public_name[index] = public_name_prefix[index];
    for (std::size_t index = 0; index < leaf_size; ++index)
        result.public_name[public_name_prefix.size() + index] = static_cast<char>(leaf[index]);
    result.kind = preload_filename_kind::valid;
    return result;
}
} // namespace ego::preloaded_addon
