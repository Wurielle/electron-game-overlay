// Directly compile the candidate's policy functions. Its renamed entry point is
// never called: this fixture does not inspect or mutate any other process.
#ifndef EGO_INJECTOR_SOURCE
#error Supply the exact candidate EGO_INJECTOR_SOURCE.
#endif
#define wmain ego_unused_preloaded_injector_entry
#include EGO_INJECTOR_SOURCE
#undef wmain

#include <exception>
#include <iostream>
#include <iterator>
#include <stdexcept>

// Data-only fixture exports permit real PE/export/module inspection. No runtime
// or add-on library is loaded and no production callback is registered.
extern "C" __declspec(dllexport) const char *ReShadeVersion = "fixture-only";
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeReadyV1 = 0;
extern "C" __declspec(dllexport) volatile LONG ElectronGameOverlayCooperativeAdapterReadyV1 = 1;

namespace
{
std::uint64_t assertions = 0;
SIZE_T member_thunk_bytes = 0, runtime_thunk_bytes = 0;
constexpr char fixture_build[33] = "ABCDEF0123456789ABCDEF0123456789";
constexpr BYTE abc_sha256[32] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
};

void require(bool condition, const char *message)
{
    ++assertions;
    if (!condition) throw std::runtime_error(message);
}

std::wstring valid_leaf()
{
    return std::wstring(L"ego-preload-0123456789abcdef0123456789abcdef-") +
        L"ABCDEF0123456789ABCDEF0123456789-ba7816bf8f01cfea" +
#ifdef _WIN64
        L".addon64";
#else
        L".addon32";
#endif
}

void test_filename_grammar()
{
    const std::wstring leaf = valid_leaf();
    require(valid_preloaded_addon_leaf(leaf), "valid architecture-specific preload leaf rejected");
    for (const std::wstring &invalid : {
        std::wstring(), std::wstring(L"electron_game_overlay.addon64"),
        std::wstring(L"ego-preload-"), L"..\\" + leaf, L"C:\\" + leaf,
        leaf + L".dll", leaf + L" ", leaf + L".", leaf + L":stream",
        leaf.substr(0, leaf.size() - 1)})
        require(!valid_preloaded_addon_leaf(invalid), "malformed preload leaf accepted");
    for (std::size_t index = 0; index != leaf.size(); ++index)
    {
        std::wstring invalid = leaf;
        invalid[index] = L'!';
        require(!valid_preloaded_addon_leaf(invalid), "unchecked filename byte accepted");
        invalid[index] = L'\0';
        require(!valid_preloaded_addon_leaf(invalid), "embedded null accepted");
        invalid[index] = L'\u00e9';
        require(!valid_preloaded_addon_leaf(invalid), "non-ASCII filename byte accepted");
    }
    auto invalid = leaf;
    invalid[12] = L'A';
    require(valid_preloaded_addon_leaf(invalid), "uppercase app digest rejected");
    invalid = leaf;
    invalid[78] = L'A';
    require(valid_preloaded_addon_leaf(invalid), "uppercase SHA prefix rejected");
    invalid = leaf;
    invalid.back() = invalid.back() == L'4' ? L'2' : L'4';
    require(!valid_preloaded_addon_leaf(invalid), "other architecture extension accepted");
}

void test_filename_content_binding()
{
    const std::wstring leaf = valid_leaf();
    require(bind_preloaded_addon_leaf(leaf, fixture_build, abc_sha256),
        "valid build/SHA binding rejected");
    char changed_build[33] = {};
    std::copy(std::begin(fixture_build), std::end(fixture_build), changed_build);
    changed_build[0] = '0';
    require(!bind_preloaded_addon_leaf(leaf, changed_build, abc_sha256),
        "different build accepted");
    changed_build[0] = fixture_build[0];
    changed_build[32] = '0';
    require(!bind_preloaded_addon_leaf(leaf, changed_build, abc_sha256),
        "unterminated build accepted");
    BYTE changed_hash[32] = {};
    std::copy(std::begin(abc_sha256), std::end(abc_sha256), changed_hash);
    for (std::size_t index = 0; index != 8; ++index)
    {
        changed_hash[index] ^= 1;
        require(!bind_preloaded_addon_leaf(leaf, fixture_build, changed_hash),
            "changed named SHA prefix byte accepted");
        changed_hash[index] ^= 1;
    }
    // The filename advertises only eight SHA bytes. Full file equality is a
    // separate required check, rather than a false 256-bit filename claim.
    changed_hash[31] ^= 1;
    require(bind_preloaded_addon_leaf(leaf, fixture_build, changed_hash),
        "filename incorrectly interpreted as a full SHA-256 commitment");
    auto mixed_case_leaf = leaf;
    for (auto &value : mixed_case_leaf)
        if (value >= L'a' && value <= L'f') value = static_cast<wchar_t>(value - L'a' + L'A');
    // Prefix and extension remain exact even though identity hex digits accept
    // case variants. Do not accidentally test a different filename grammar.
    mixed_case_leaf.replace(0, 12, L"ego-preload-");
    mixed_case_leaf.replace(94, 8, leaf.substr(94));
    require(bind_preloaded_addon_leaf(mixed_case_leaf, fixture_build, abc_sha256),
        "case-insensitive identity hex binding rejected");
}

void test_disabled_addon_policy()
{
    const std::wstring leaf = valid_leaf();
    const std::wstring name = L"Electron Game Overlay Runtime " + leaf;
    target_effective_reshade_settings settings;
    require(!preloaded_addon_disabled(settings, leaf), "empty disabled list blocked preload");
    for (const std::wstring &token : {name, L"@" + leaf, name + L"@" + leaf,
        L"OtherName@" + leaf})
    {
        settings.disabled_addons = {token};
        require(preloaded_addon_disabled(settings, leaf), "stock disabled token bypassed");
        auto uppercase = token;
        for (auto &value : uppercase) value = towupper(value);
        settings.disabled_addons = {uppercase};
        require(preloaded_addon_disabled(settings, leaf), "case alias bypassed preload disable");
    }
    settings.disabled_addons = {L"Another Add-on", L"foreign.addon64", leaf,
        L"Another Add-on@foreign.addon64", name + L"x", L"@" + leaf + L"x"};
    require(!preloaded_addon_disabled(settings, leaf), "unrelated disabled token blocked preload");
    settings.disabled_addons.clear();
    settings.disabled_addons = {std::wstring(L"OtherName@") + target_electron_overlay_addon_file};
    require(preloaded_addon_disabled(settings, leaf), "stock reserved filename disable was bypassed");
    settings.disabled_addons.clear();
    settings.electron_game_overlay_addon_disabled = true;
    require(preloaded_addon_disabled(settings, leaf), "base EGO disable was bypassed");
}

struct owned_test_files
{
    std::wstring directory;
    std::vector<std::wstring> files;
    ~owned_test_files()
    {
        for (const auto &file : files) DeleteFileW(file.c_str());
        if (!directory.empty()) RemoveDirectoryW(directory.c_str());
    }
    std::wstring path(const wchar_t *leaf)
    {
        files.push_back(directory + L"\\" + leaf);
        return files.back();
    }
};

void write_file_bytes(const std::wstring &path, const char *data, DWORD length, DWORD disposition)
{
    scoped_handle file(CreateFileW(path.c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        disposition, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(file != INVALID_HANDLE_VALUE, "cannot write fixture-owned file");
    DWORD written = 0;
    require(WriteFile(file, data, length, &written, nullptr) != FALSE && written == length,
        "fixture-owned write was incomplete");
}

void test_immutable_file_hashing()
{
    WCHAR current[32768] = {};
    const DWORD count = GetCurrentDirectoryW(ARRAYSIZE(current), current);
    require(count != 0 && count < ARRAYSIZE(current), "cannot resolve fixture working directory");
    owned_test_files owned;
    owned.directory = std::wstring(current) + L"\\preload-policy-owned-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    require(CreateDirectoryW(owned.directory.c_str(), nullptr) != FALSE,
        "cannot exclusively create fixture-owned directory");
    const std::wstring first = owned.path(L"first.dll");
    const std::wstring second = owned.path(L"second.dll");
    const std::wstring empty = owned.path(L"empty.dll");
    const std::wstring missing = owned.path(L"missing.dll");
    const std::wstring link = owned.path(L"reparse.dll");
    write_file_bytes(first, "abc", 3, CREATE_NEW);
    write_file_bytes(second, "abc", 3, CREATE_NEW);
    write_file_bytes(empty, "", 0, CREATE_NEW);
    {
        scoped_handle first_guard, second_guard;
        BYTE first_hash[32] = {}, second_hash[32] = {};
        require(hash_immutable_native_file(first, first_guard, first_hash) == ERROR_SUCCESS,
            "immutable regular file rejected");
        require(memcmp(first_hash, abc_sha256, sizeof(first_hash)) == 0,
            "SHA-256 known vector differs");
        require(hash_immutable_native_file(second, second_guard, second_hash) == ERROR_SUCCESS &&
            memcmp(first_hash, second_hash, sizeof(first_hash)) == 0,
            "matching files produced different full SHA-256 values");
        scoped_handle writer(CreateFileW(first.c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        require(writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
            "hash guard did not deny concurrent writes");
        require(DeleteFileW(first.c_str()) == FALSE && GetLastError() == ERROR_SHARING_VIOLATION,
            "hash guard did not deny deletion");
    }
    write_file_bytes(second, "abd", 3, TRUNCATE_EXISTING);
    {
        scoped_handle guard;
        BYTE changed_hash[32] = {};
        require(hash_immutable_native_file(second, guard, changed_hash) == ERROR_SUCCESS &&
            memcmp(changed_hash, abc_sha256, sizeof(changed_hash)) != 0,
            "changed file retained original full SHA-256");
    }
    for (const auto &path : {empty, missing, owned.directory})
    {
        scoped_handle guard;
        BYTE hash[32] = {};
        require(hash_immutable_native_file(path, guard, hash) != ERROR_SUCCESS,
            "empty, missing, or non-regular input accepted");
    }
    // Require an actual reparse object in the executed evidence; silently
    // skipping this case would not establish the production rejection rule.
    BOOLEAN created = CreateSymbolicLinkW(link.c_str(), first.c_str(), 0x2);
    if (!created && GetLastError() == ERROR_INVALID_PARAMETER)
        created = CreateSymbolicLinkW(link.c_str(), first.c_str(), 0);
    require(created != FALSE, "cannot create actual reparse case (enable Developer Mode or run fixture with symlink privilege)");
    {
        scoped_handle guard;
        BYTE hash[32] = {};
        require(hash_immutable_native_file(link, guard, hash) == ERROR_CANT_ACCESS_FILE,
            "reparse input was not explicitly rejected");
    }
    for (const auto &path : {first, second, empty, link})
        require(DeleteFileW(path.c_str()) != FALSE, "fixture-owned file was not released after guard lifetime");
    require(RemoveDirectoryW(owned.directory.c_str()) != FALSE,
        "fixture-owned directory could not retire");
    owned.files.clear();
    owned.directory.clear();
}

bool independently_unelevated_self()
{
    scoped_handle token;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != FALSE,
        "self token query failed");
    TOKEN_ELEVATION elevation{};
    DWORD bytes = 0;
    require(GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes) != FALSE &&
        bytes == sizeof(elevation), "self elevation query failed");
    DWORD needed = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &needed);
    require(needed != 0 && GetLastError() == ERROR_INSUFFICIENT_BUFFER,
        "self integrity size query failed");
    std::vector<BYTE> data(needed);
    require(GetTokenInformation(token, TokenIntegrityLevel, data.data(), needed, &bytes) != FALSE,
        "self integrity query failed");
    const auto label = reinterpret_cast<const TOKEN_MANDATORY_LABEL *>(data.data());
    require(IsValidSid(label->Label.Sid) != FALSE, "self integrity SID malformed");
    const UCHAR count = *GetSidSubAuthorityCount(label->Label.Sid);
    require(count != 0, "self integrity SID has no RID");
    return elevation.TokenIsElevated == 0 &&
        *GetSidSubAuthority(label->Label.Sid, count - 1) <= SECURITY_MANDATORY_MEDIUM_RID;
}

void test_process_token_guard()
{
    const bool self_allowed = independently_unelevated_self();
    require((require_unelevated_process(GetCurrentProcess()) == ERROR_SUCCESS) == self_allowed,
        "production privilege guard disagrees with authoritative self token");
    require(require_unelevated_process(nullptr) != ERROR_SUCCESS,
        "missing target token query succeeded");
    scoped_handle event(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    require(event != nullptr && event != INVALID_HANDLE_VALUE,
        "cannot create owned non-process token-query case");
    require(require_unelevated_process(event) != ERROR_SUCCESS,
        "non-process target token query succeeded");
}

void test_completed_adapter_inspection()
{
    HMODULE runtime = nullptr;
    bool member_ready = true, adapter_ready = false, present = false;
    require(inspect_cooperative_host(GetCurrentProcess(), runtime, member_ready,
        &present, &adapter_ready) == ERROR_SUCCESS,
        "self module/export inspection failed");
    require(runtime == GetModuleHandleW(nullptr), "fixture runtime export was not discovered");
    require(present && !member_ready && adapter_ready,
        "dormant member plus completed adapter was not distinguished");
    InterlockedExchange(&ElectronGameOverlayCooperativeAdapterReadyV1, 0);
    InterlockedExchange(&ElectronGameOverlayCooperativeReadyV1, 1);
    require(inspect_cooperative_host(GetCurrentProcess(), runtime, member_ready,
        &present, &adapter_ready) == ERROR_SUCCESS && member_ready && !adapter_ready,
        "explicit unready adapter incorrectly inherited member readiness");
    InterlockedExchange(&ElectronGameOverlayCooperativeReadyV1, 0);
    InterlockedExchange(&ElectronGameOverlayCooperativeAdapterReadyV1, 1);
}

void test_copied_thunk_bounds()
{
    require(participant_loading_thread_size(member_thunk_bytes) &&
        member_thunk_bytes != 0 && member_thunk_bytes <= 4096,
        "compiled participant thunk exceeded its copied-code bound");
    require(get_loading_thread_func_size(runtime_thunk_bytes) &&
        runtime_thunk_bytes != 0 && runtime_thunk_bytes <= 4096,
        "compiled runtime thunk exceeded its copied-code bound");
}
} // namespace

int wmain()
{
    try
    {
        test_filename_grammar();
        test_filename_content_binding();
        test_disabled_addon_policy();
        test_immutable_file_hashing();
        test_process_token_guard();
        test_completed_adapter_inspection();
        test_copied_thunk_bounds();
        std::cout << "{\"schemaVersion\":1,\"status\":\"passed\",\"cases\":7,\"assertions\":"
            << assertions << ",\"memberThunkBytes\":" << member_thunk_bytes
            << ",\"runtimeThunkBytes\":" << runtime_thunk_bytes << "}\n";
        return 0;
    }
    catch (const std::exception &error)
    {
        std::cerr << "preloaded injector policy failed: " << error.what() << '\n';
        return 1;
    }
}
