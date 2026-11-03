#ifndef PRELOADED_ADDON_HEADER
#error Supply the exact PRELOADED_ADDON_HEADER under test.
#endif
#include PRELOADED_ADDON_HEADER

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <initializer_list>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace
{
using ego::preloaded_addon::classify_filename;
using ego::preloaded_addon::filename_identity;
using kind = ego::preloaded_addon::preload_filename_kind;

// Synthetic policy input, deliberately independent of production build IDs.
constexpr std::string_view build_id = "ABCDEF0123456789ABCDEF0123456789";
constexpr std::string_view lower_build_id = "abcdef0123456789abcdef0123456789";
constexpr std::string_view public_name_prefix = "Electron Game Overlay Runtime ";
constexpr std::wstring_view filename_64 =
    L"ego-preload-0123456789abcdef0123456789abcdef-"
    L"ABCDEF0123456789ABCDEF0123456789-0123456789abcdef.addon64";
constexpr std::wstring_view filename_32 =
    L"ego-preload-0123456789abcdef0123456789abcdef-"
    L"ABCDEF0123456789ABCDEF0123456789-0123456789abcdef.addon32";

static_assert(classify_filename(filename_64, build_id, true).kind == kind::valid);
static_assert(classify_filename(filename_32, build_id, false).kind == kind::valid);
static_assert(classify_filename(L"ordinary.addon64", build_id, true).kind == kind::ordinary);
static_assert(classify_filename(L"ego-preload-", build_id, true).kind == kind::invalid);

std::uint64_t assertions = 0;

void require(bool condition, const std::string &message)
{
    ++assertions;
    if (!condition)
        throw std::runtime_error(message);
}

void require_empty_name(const filename_identity &identity, const std::string &message)
{
    require(std::all_of(identity.public_name.begin(), identity.public_name.end(),
        [](char value) { return value == '\0'; }), message);
}

void expect_invalid(std::wstring_view leaf, std::string_view expected_build_id = build_id,
    bool is_64_bit = true)
{
    const auto identity = classify_filename(leaf, expected_build_id, is_64_bit);
    require(identity.kind == kind::invalid, "reserved malformed filename was accepted");
    require_empty_name(identity, "invalid filename published a partial public name");
}

void test_valid_names_and_architectures()
{
    for (const bool is_64_bit : {false, true})
    {
        const auto leaf = is_64_bit ? filename_64 : filename_32;
        const auto identity = classify_filename(leaf, build_id, is_64_bit);
        require(identity.kind == kind::valid, "matching architecture rejected");
        const auto public_name_size = public_name_prefix.size() + leaf.size();
        require(identity.public_name[public_name_size] == '\0', "public name was not terminated");
        require(std::string_view(identity.public_name.data()).size() == public_name_size,
            "public name length changed");
        require(std::string_view(identity.public_name.data(), public_name_prefix.size()) ==
            public_name_prefix, "public name prefix changed");
        for (std::size_t index = 0; index < leaf.size(); ++index)
            require(identity.public_name[public_name_prefix.size() + index] == leaf[index],
                "public name changed its exact leaf");
        require(std::all_of(identity.public_name.begin() + public_name_size, identity.public_name.end(),
            [](char value) { return value == '\0'; }), "public name has nonzero tail bytes");
        require(classify_filename(leaf, lower_build_id, is_64_bit).kind == kind::valid,
            "lowercase expected build ID rejected");
        expect_invalid(leaf, build_id, !is_64_bit);
    }

    auto lowercase_native_id = std::wstring(filename_64);
    for (std::size_t index = 45; index < 77; ++index)
    {
        auto &value = lowercase_native_id[index];
        if (value >= L'A' && value <= L'F')
            value += L'a' - L'A';
    }
    const auto identity = classify_filename(lowercase_native_id, build_id, true);
    require(identity.kind == kind::valid, "lowercase native filename build ID rejected");
    require(identity.public_name[public_name_prefix.size() + 45] == 'a',
        "public NAME normalized immutable leaf bytes");
}

void test_reserved_malformed_names_fail_closed()
{
    expect_invalid(L"ego-preload-");
    expect_invalid(std::wstring(filename_64) + L".dll");
    expect_invalid(filename_64.substr(0, filename_64.size() - 1));
    expect_invalid(std::wstring(filename_64) + L" ");

    // Every byte after the reserved prefix belongs to a checked field.
    for (std::size_t index = 12; index < filename_64.size(); ++index)
    {
        auto mutated = std::wstring(filename_64);
        mutated[index] = L'!';
        expect_invalid(mutated);
    }
    for (const std::size_t index : {std::size_t{12}, std::size_t{45}, std::size_t{78}})
    {
        auto mutated = std::wstring(filename_64);
        mutated[index] = L'\0';
        expect_invalid(mutated);
        mutated[index] = L'\u00e9';
        expect_invalid(mutated);
        mutated[index] = L'/';
        expect_invalid(mutated);
        mutated[index] = L'\\';
        expect_invalid(mutated);
        mutated[index] = L':';
        expect_invalid(mutated);
    }

    auto uppercase_app = std::wstring(filename_64);
    uppercase_app[22] = L'A';
    expect_invalid(uppercase_app);
    auto uppercase_hash = std::wstring(filename_64);
    uppercase_hash[88] = L'A';
    expect_invalid(uppercase_hash);
    auto wrong_build_id = std::wstring(filename_64);
    wrong_build_id[45] = L'0';
    expect_invalid(wrong_build_id);
    auto uppercase_extension = std::wstring(filename_64);
    uppercase_extension[95] = L'A';
    expect_invalid(uppercase_extension);

    // The Windows filesystem is case-insensitive; reserved prefix aliases
    // cannot opt an offline add-on back into ordinary automatic binding.
    for (std::size_t index = 0; index < 12; ++index)
    {
        auto mutated = std::wstring(filename_64);
        auto &value = mutated[index];
        if (value >= L'a' && value <= L'z')
        {
            value -= L'a' - L'A';
            expect_invalid(mutated);
        }
    }
}

void test_expected_build_id_validation()
{
    expect_invalid(filename_64, "");
    expect_invalid(filename_64, build_id.substr(1));
    expect_invalid(filename_64, std::string(build_id) + "0");
    for (std::size_t index = 0; index < build_id.size(); ++index)
    {
        auto malformed = std::string(build_id);
        malformed[index] = 'g';
        expect_invalid(filename_64, malformed);
        malformed[index] = '\0';
        expect_invalid(filename_64, malformed);
        malformed[index] = static_cast<char>(0xff);
        expect_invalid(filename_64, malformed);
    }
}

void test_ordinary_names_are_unaffected()
{
    for (const std::wstring_view leaf : {
        L"", L"electron-game-overlay.addon64", L"ordinary.addon32", L"ego-preload",
        L"ego-preloaded-app.addon64", L"prefix-ego-preload-.addon64", L"foreign\u00e9.addon64"})
    {
        const auto identity = classify_filename(leaf, "invalid expected build", true);
        require(identity.kind == kind::ordinary, "unreserved filename changed ordinary behavior");
        require_empty_name(identity, "ordinary filename published a preload name");
    }
}

void test_different_registration_names()
{
    auto other_app = std::wstring(filename_64);
    other_app[12] = L'f';
    auto other_addon_hash = std::wstring(filename_64);
    other_addon_hash[78] = L'f';
    const auto original = classify_filename(filename_64, build_id, true);
    for (const auto &leaf : {other_app, other_addon_hash})
    {
        const auto identity = classify_filename(leaf, build_id, true);
        require(identity.kind == kind::valid, "independent app/hash identity rejected");
        require(identity.public_name != original.public_name, "independent registrations collided");
    }
}
} // namespace

int main()
{
    try
    {
        test_valid_names_and_architectures();
        test_reserved_malformed_names_fail_closed();
        test_expected_build_id_validation();
        test_ordinary_names_are_unaffected();
        test_different_registration_names();
        std::cout << "{\"status\":\"passed\",\"cases\":5,\"assertions\":" << assertions << "}\n";
        return 0;
    }
    catch (const std::exception &error)
    {
        std::cerr << "preloaded add-on policy fixture failed: " << error.what() << '\n';
        return 1;
    }
}
