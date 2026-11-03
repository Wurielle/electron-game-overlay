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
#include <winioctl.h>

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

std::wstring marker_string(const std::wstring &value)
{
    std::wstring quoted = L"\"";
    for (const wchar_t character : value)
    {
        if (character == L'"' || character == L'\\') quoted += L'\\';
        quoted += character;
    }
    return quoted + L'"';
}

std::wstring marker_document(const std::wstring &stage_leaf)
{
    return L"{\"schemaVersion\":1,\"kind\":\"electron-game-overlay-reshade-run\","
        L"\"runId\":\"01234567-89ab-4def-8abc-0123456789ab\",\"directoryName\":" +
        marker_string(stage_leaf) + L",\"createdAt\":\"2026-11-02T00:12:34.567Z\"}";
}

std::wstring replace_marker_token(std::wstring document,
    const std::wstring &token, const std::wstring &replacement)
{
    const size_t offset = document.find(token);
    require(offset != std::wstring::npos, "marker test mutation token missing");
    document.replace(offset, token.size(), replacement);
    return document;
}

void test_owned_run_marker_grammar()
{
    const std::wstring leaf = L"game.exe-testStage";
    const std::wstring valid = marker_document(leaf);
    require(valid_owned_run_marker(valid, leaf), "valid owned run marker rejected");
    require(!valid_owned_run_marker(marker_document(L""), L""), "empty stage filename accepted");
    require(valid_owned_run_marker(L" \t\r\n" + valid + L"\n\t ", leaf),
        "JSON whitespace rejected");
    require(valid_owned_run_marker(
        L"{\"createdAt\":\"2026-11-02T00:12:34.567Z\",\"directoryName\":\"game.exe-testStage\","
        L"\"runId\":\"01234567-89ab-4def-8abc-0123456789ab\","
        L"\"kind\":\"electron-game-overlay-reshade-run\",\"schemaVersion\":1}", leaf),
        "valid reordered fields rejected");
    const std::wstring escaped_leaf = L"stage-\"quote\\back/slash-\u00e9-\U0001f642";
    auto escaped_document = marker_document(escaped_leaf);
    escaped_document = replace_marker_token(escaped_document, L"/slash", L"\\/slash");
    require(valid_owned_run_marker(escaped_document, escaped_leaf),
        "allowed JSON quote/backslash/slash or decoded Unicode rejected");
    require(!valid_owned_run_marker(valid, L"game.exe-teststage"),
        "directory leaf was compared without exact case");
    for (const auto &bad : {
        std::wstring(), std::wstring(L"{}"), std::wstring(L"[]"),
        std::wstring(L"null"), valid + L"x", L"x" + valid, L"[" + valid + L"]",
        L"/*comment*/" + valid, L"\u00a0" + valid,
        valid.substr(0, valid.size() - 1), valid.substr(0, valid.size() - 1) + L",}"})
        require(!valid_owned_run_marker(bad, leaf), "incomplete or non-object marker accepted");
    const std::pair<std::wstring, std::wstring> fields[] = {
        {L"schemaVersion", L"1"},
        {L"kind", L"\"electron-game-overlay-reshade-run\""},
        {L"runId", L"\"01234567-89ab-4def-8abc-0123456789ab\""},
        {L"directoryName", L"\"game.exe-testStage\""},
        {L"createdAt", L"\"2026-11-02T00:12:34.567Z\""}
    };
    for (const auto &field : fields)
    {
        const std::wstring pair = marker_string(field.first) + L":" + field.second;
        require(!valid_owned_run_marker(valid.substr(0, valid.size() - 1) + L"," + pair + L"}", leaf),
            "duplicate marker field accepted");
        require(!valid_owned_run_marker(replace_marker_token(valid, marker_string(field.first),
            marker_string(L"unknown")), leaf), "unknown or missing required marker field accepted");
        for (const std::wstring &wrong_type : {L"null", L"false", L"[]", L"{}"})
            require(!valid_owned_run_marker(replace_marker_token(valid, pair,
                marker_string(field.first) + L":" + wrong_type), leaf), "wrong marker field type accepted");
    }
    for (const std::wstring &wrong_schema : {L"0", L"2", L"-1", L"01", L"1.0", L"1e0", L"\"1\""})
        require(!valid_owned_run_marker(replace_marker_token(valid, L"\"schemaVersion\":1",
            L"\"schemaVersion\":" + wrong_schema), leaf), "noncanonical marker schema accepted");
    require(!valid_owned_run_marker(replace_marker_token(valid, L"electron-game-overlay-reshade-run",
        L"electron-game-overlay-addon-preload-registry"), leaf), "different marker kind accepted");
    for (const std::wstring &escape : {L"\\n", L"\\r", L"\\t", L"\\b", L"\\f", L"\\u0061", L"\\x61", L"\\q"})
        require(!valid_owned_run_marker(replace_marker_token(valid, leaf, escape), escape),
            "unsupported JSON escape accepted");
    auto control = valid;
    control[control.find(leaf)] = L'\0';
    require(!valid_owned_run_marker(control, leaf), "raw JSON null character accepted");
    control[control.find(L'\0')] = L'\n';
    require(!valid_owned_run_marker(control, leaf), "raw JSON control character accepted");
    const std::wstring uuid = L"01234567-89ab-4def-8abc-0123456789ab";
    for (size_t index = 0; index != uuid.size(); ++index)
    {
        auto invalid = uuid;
        invalid[index] = L'!';
        require(!valid_owned_run_marker(replace_marker_token(valid, uuid, invalid), leaf),
            "malformed UUID character accepted");
    }
    require(!valid_owned_run_marker(replace_marker_token(valid, uuid,
        L"01234567-89Ab-4def-8abc-0123456789ab"), leaf), "uppercase UUID accepted");
    require(!valid_owned_run_marker(replace_marker_token(valid, uuid,
        L"01234567-89ab-5def-8abc-0123456789ab"), leaf), "non-v4 UUID accepted");
    require(!valid_owned_run_marker(replace_marker_token(valid, uuid,
        L"01234567-89ab-4def-cabc-0123456789ab"), leaf), "non-variant UUID accepted");
    for (const wchar_t variant : {L'8', L'9', L'a', L'b'})
    {
        auto accepted = uuid;
        accepted[19] = variant;
        require(valid_owned_run_marker(replace_marker_token(valid, uuid, accepted), leaf),
            "valid UUID variant rejected");
    }
    const std::wstring iso = L"2026-11-02T00:12:34.567Z";
    for (size_t index = 0; index != iso.size(); ++index)
    {
        auto invalid = iso;
        invalid[index] = L'!';
        require(!valid_owned_run_marker(replace_marker_token(valid, iso, invalid), leaf),
            "malformed ISO shape accepted");
    }
    // Match the existing native contract's shape validation rather than silently
    // adding calendar interpretation to only one ownership parser.
    require(valid_owned_run_marker(replace_marker_token(valid, iso,
        L"2026-99-99T99:99:99.999Z"), leaf), "existing ISO-shape semantics changed");
}

struct owned_test_files
{
    std::wstring directory;
    std::vector<std::wstring> files;
    ~owned_test_files()
    {
        for (const auto &file : files) DeleteFileW(make_extended_length_path(file).c_str());
        if (!directory.empty()) RemoveDirectoryW(make_extended_length_path(directory).c_str());
    }
    std::wstring path(const wchar_t *leaf)
    {
        files.push_back(directory + L"\\" + leaf);
        return files.back();
    }
};

void write_file_bytes(const std::wstring &path, const char *data, DWORD length, DWORD disposition)
{
    scoped_handle file(CreateFileW(make_extended_length_path(path).c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        disposition, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file == INVALID_HANDLE_VALUE)
        throw std::runtime_error("cannot write fixture-owned file; Win32 error " +
            std::to_string(GetLastError()) + "; path characters " + std::to_string(path.size()));
    require(true, "fixture-owned file opened");
    DWORD written = 0;
    require(WriteFile(file, data, length, &written, nullptr) != FALSE && written == length,
        "fixture-owned write was incomplete");
}

struct owned_selector_tree
{
    std::wstring root;
    std::vector<std::wstring> files, directories;
    ~owned_selector_tree()
    {
        for (auto it = files.rbegin(); it != files.rend(); ++it) DeleteFileW(make_extended_length_path(*it).c_str());
        for (auto it = directories.rbegin(); it != directories.rend(); ++it) RemoveDirectoryW(make_extended_length_path(*it).c_str());
        if (!root.empty()) RemoveDirectoryW(make_extended_length_path(root).c_str());
    }
    std::wstring directory(const std::wstring &parent, const wchar_t *leaf)
    {
        const std::wstring path = parent + L"\\" + leaf;
        require(CreateDirectoryW(make_extended_length_path(path).c_str(), nullptr) != FALSE,
            "cannot exclusively create selector-owned directory");
        directories.push_back(path);
        return path;
    }
    std::wstring file(const std::wstring &parent, const wchar_t *leaf,
        const std::string &contents)
    {
        const std::wstring path = parent + L"\\" + leaf;
        write_file_bytes(path, contents.data(), static_cast<DWORD>(contents.size()), CREATE_NEW);
        files.push_back(path);
        return path;
    }
};

std::string utf8_marker(const std::wstring &document)
{
    const int needed = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
        document.data(), static_cast<int>(document.size()), nullptr, 0, nullptr, nullptr);
    require(needed > 0, "cannot encode selector fixture marker");
    std::string result(static_cast<size_t>(needed), '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, document.data(),
        static_cast<int>(document.size()), result.data(), needed, nullptr, nullptr) == needed,
        "selector fixture marker encoding was incomplete");
    return result;
}

void rewrite_owned_file(const std::wstring &path, const std::string &contents)
{
    write_file_bytes(path, contents.data(), static_cast<DWORD>(contents.size()), TRUNCATE_EXISTING);
}

void make_owned_junction(const std::wstring &directory, const std::wstring &target)
{
    struct junction_buffer
    {
        DWORD tag;
        WORD data_length, reserved;
        WORD substitute_offset, substitute_length, print_offset, print_length;
        wchar_t paths[1];
    };
    static_assert(offsetof(junction_buffer, paths) == 16);
    const std::wstring substitute = L"\\??\\" + target;
    const size_t path_bytes = (substitute.size() + target.size() + 2) * sizeof(wchar_t);
    std::vector<BYTE> bytes(offsetof(junction_buffer, paths) + path_bytes);
    auto *const data = reinterpret_cast<junction_buffer *>(bytes.data());
    data->tag = IO_REPARSE_TAG_MOUNT_POINT;
    data->data_length = static_cast<WORD>(8 + path_bytes);
    data->substitute_length = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
    data->print_offset = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
    data->print_length = static_cast<WORD>(target.size() * sizeof(wchar_t));
    memcpy(data->paths, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
    memcpy(reinterpret_cast<BYTE *>(data->paths) + data->print_offset,
        target.c_str(), (target.size() + 1) * sizeof(wchar_t));
    scoped_handle handle(CreateFileW(make_extended_length_path(directory).c_str(), GENERIC_WRITE, 0, nullptr,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(handle != INVALID_HANDLE_VALUE, "cannot open owned junction directory");
    DWORD returned = 0;
    require(DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, data,
        static_cast<DWORD>(bytes.size()), nullptr, 0, &returned, nullptr) != FALSE,
        "cannot create actual selector ancestor junction");
}

void test_first_host_snapshot_selector()
{
    WCHAR current[32768] = {};
    const DWORD count = GetCurrentDirectoryW(ARRAYSIZE(current), current);
    require(count != 0 && count < ARRAYSIZE(current), "cannot resolve selector working directory");
    owned_selector_tree owned;
    owned.root = std::wstring(current) + L"\\preload-selector-owned-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    require(CreateDirectoryW(make_extended_length_path(owned.root).c_str(), nullptr) != FALSE,
        "cannot exclusively create selector-owned root");
    const std::wstring stage = owned.directory(owned.root, L"stage");
    // Registered add-ons remain in one stable directory outside every private
    // session stage. Unrelated ordinary ReShade add-ons are not EGO inventory.
    const std::wstring snapshot = owned.directory(owned.root, L"shared-addons");
    const std::wstring game = owned.directory(owned.root, L"game");
    const std::wstring other = owned.directory(owned.root, L"other");
    const std::wstring target = owned.file(game, L"game.exe", "fixture target bytes");
    const std::wstring runtime = owned.file(stage, target_reshade_runtime_file, "fixture runtime bytes");
    const std::wstring selected_leaf = valid_leaf();
    const std::wstring selected_file = owned.file(snapshot, selected_leaf.c_str(), "abc");
    owned.file(snapshot, L"independent-library.addon", "unrelated third-party bytes");
    owned.file(snapshot, L"broken-foreign.addon64", "not a PE image");
    const std::wstring source_file = owned.file(stage, L"regular-copy.dll", "abc");
    const std::string ascii = "ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1\n";
    const std::wstring ascii_marker = owned.file(stage,
        L"electron-game-overlay-owned-runtime-v1.marker", ascii);
    const std::string json = utf8_marker(marker_document(L"stage"));
    const std::wstring run_marker = owned.file(stage, L".electron-game-overlay-run.json", json);
    const std::string configuration = "[ADDON]\r\nAddonPath=" + utf8_marker(snapshot) + "\r\n\r\n";
    const std::wstring config = owned.file(stage, L"ReShade.ini", configuration);
    target_effective_reshade_settings settings;
    settings.reshade_base_path = stage;
    settings.addon_directory_path = snapshot;
    const auto expect_rejected = [&](const std::wstring &stage_path,
        const std::wstring &target_path, const std::wstring &runtime_path,
        const target_effective_reshade_settings &effective, const char *message) {
        std::wstring selected;
        owned_preload_snapshot_guard guard;
        require(validate_first_host_preload_snapshot(stage_path, target_path,
            runtime_path, effective, selected_leaf, abc_sha256, selected, guard) != ERROR_SUCCESS, message);
    };
    {
        std::wstring selected;
        owned_preload_snapshot_guard guard;
        require(validate_first_host_preload_snapshot(stage, target, runtime,
            settings, selected_leaf, abc_sha256, selected, guard) == ERROR_SUCCESS,
            "stable shared first-host directory rejected");
        require(_wcsicmp(selected.c_str(), selected_file.c_str()) == 0,
            "selector returned a different candidate file");
        for (const auto &directory : {stage, snapshot})
        {
            scoped_handle deletion(CreateFileW(make_extended_length_path(directory).c_str(), DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
            require(deletion == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
                "selector directory guard allowed replacement access");
        }
        scoped_handle writer(CreateFileW(make_extended_length_path(selected_file).c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        require(writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
            "selector file guard allowed content mutation");
        // A second installer may register independently while this request pins
        // its own selected payload; directory replacement is still forbidden.
        scoped_handle publisher(CreateFileW(make_extended_length_path(snapshot).c_str(), FILE_ADD_FILE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        require(publisher != INVALID_HANDLE_VALUE, "shared directory guard blocked independent publication");
        owned.file(snapshot, L"published-concurrently.addon", "another independent library");
    }
    {
        auto extended = settings;
        extended.addon_directory_path = make_extended_length_path(snapshot);
        std::wstring selected;
        owned_preload_snapshot_guard guard;
        require(validate_first_host_preload_snapshot(stage, target, runtime,
            extended, selected_leaf, abc_sha256, selected, guard) == ERROR_SUCCESS,
            "exact extended shared directory alias rejected");
        require(selected == selected_file, "extended alias changed canonical selected path");
    }
    for (const auto &directory : {stage, snapshot})
    {
        scoped_handle deletion(CreateFileW(make_extended_length_path(directory).c_str(), DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        require(deletion != INVALID_HANDLE_VALUE, "selector directory guard did not release");
    }
    auto wrong = settings;
    wrong.reshade_base_path = other;
    expect_rejected(stage, target, runtime, wrong, "foreign effective base accepted");
    wrong = settings;
    wrong.addon_directory_path = other;
    expect_rejected(stage, target, runtime, wrong, "shared folder missing selected payload accepted");
    wrong.addon_directory_path = L"shared-addons";
    expect_rejected(stage, target, runtime, wrong, "relative shared AddonPath accepted");
    wrong.addon_directory_path = snapshot + L"\\..\\shared-addons";
    expect_rejected(stage, target, runtime, wrong, "noncanonical shared AddonPath accepted");
    wrong.addon_directory_path = make_extended_length_path(snapshot + L"\\..\\shared-addons");
    expect_rejected(stage, target, runtime, wrong, "noncanonical extended shared AddonPath accepted");
    wrong.addon_directory_path = L"\\\\.\\" + snapshot;
    expect_rejected(stage, target, runtime, wrong, "device alias shared AddonPath accepted");
    owned.file(game, selected_leaf.c_str(), "abc");
    wrong.addon_directory_path = game;
    expect_rejected(stage, target, runtime, wrong, "shared directory in target game folder accepted");
    expect_rejected(stage, target, source_file, settings, "wrong runtime leaf accepted");
    expect_rejected(stage, target, other + L"\\" + target_reshade_runtime_file,
        settings, "runtime outside stage accepted");
    expect_rejected(stage, stage + L"\\game.exe", runtime, settings,
        "stage inside target game directory accepted");
    rewrite_owned_file(ascii_marker, ascii + "\r\n");
    expect_rejected(stage, target, runtime, settings, "nonexact ASCII marker accepted");
    rewrite_owned_file(ascii_marker, ascii);
    rewrite_owned_file(run_marker, utf8_marker(marker_document(L"other")));
    expect_rejected(stage, target, runtime, settings, "wrong JSON directory identity accepted");
    rewrite_owned_file(run_marker, json.substr(0, json.size() - 1) + ",\"unknown\":\"x\"}");
    expect_rejected(stage, target, runtime, settings, "malformed ownership marker accepted");
    rewrite_owned_file(run_marker, std::string("\xef\xbb\xbf") + json);
    expect_rejected(stage, target, runtime, settings, "BOM ownership marker accepted unlike native activation");
    rewrite_owned_file(run_marker, json);
    for (const auto &path : {ascii_marker, run_marker, config, selected_file})
    {
        require(DeleteFileW(make_extended_length_path(path).c_str()) != FALSE, "cannot remove owned missing-file case");
        expect_rejected(stage, target, runtime, settings, "missing required stage file accepted");
        const std::string contents = path == ascii_marker ? ascii : path == run_marker ? json :
            path == selected_file ? std::string("abc") : configuration;
        write_file_bytes(path, contents.data(), static_cast<DWORD>(contents.size()), CREATE_NEW);
    }
    rewrite_owned_file(selected_file, "abd");
    expect_rejected(stage, target, runtime, settings, "changed full candidate hash accepted");
    rewrite_owned_file(selected_file, "abc");
    require(DeleteFileW(make_extended_length_path(selected_file).c_str()) != FALSE, "cannot prepare selector reparse leaf");
    BOOLEAN linked = CreateSymbolicLinkW(make_extended_length_path(selected_file).c_str(), make_extended_length_path(source_file).c_str(), 0x2);
    if (!linked && GetLastError() == ERROR_INVALID_PARAMETER)
        linked = CreateSymbolicLinkW(make_extended_length_path(selected_file).c_str(), make_extended_length_path(source_file).c_str(), 0);
    require(linked != FALSE, "cannot create actual selector reparse leaf");
    expect_rejected(stage, target, runtime, settings, "reparse candidate leaf accepted");
    require(DeleteFileW(make_extended_length_path(selected_file).c_str()) != FALSE, "cannot retire selector reparse leaf");
    write_file_bytes(selected_file, "abc", 3, CREATE_NEW);
    const std::wstring junction = owned.directory(owned.root, L"stage-junction");
    make_owned_junction(junction, stage);
    wrong = settings;
    wrong.reshade_base_path = junction;
    wrong.addon_directory_path = junction + L"\\preloaded-addons";
    expect_rejected(junction, target, junction + L"\\" + target_reshade_runtime_file,
        wrong, "reparse ancestor junction accepted");
    const std::wstring shared_junction = owned.directory(owned.root, L"shared-junction");
    make_owned_junction(shared_junction, snapshot);
    wrong = settings;
    wrong.addon_directory_path = shared_junction;
    expect_rejected(stage, target, runtime, wrong, "shared directory junction accepted");
    const std::wstring shared_parent = owned.directory(owned.root, L"shared-parent");
    const std::wstring shared_child = owned.directory(shared_parent, L"addons");
    owned.file(shared_child, selected_leaf.c_str(), "abc");
    const std::wstring parent_junction = owned.directory(owned.root, L"parent-junction");
    make_owned_junction(parent_junction, shared_parent);
    wrong.addon_directory_path = parent_junction + L"\\addons";
    expect_rejected(stage, target, runtime, wrong, "shared directory ancestor junction accepted");
    // Successful admission remains possible after all failure cases; no helper
    // may quarantine, rewrite, or delete our valid stage on read-only rejection.
    {
        std::wstring selected;
        owned_preload_snapshot_guard guard;
        require(validate_first_host_preload_snapshot(stage, target, runtime,
            settings, selected_leaf, abc_sha256, selected, guard) == ERROR_SUCCESS,
            "rejected alternatives altered the valid snapshot");
    }
}

void test_immutable_file_hashing()
{
    WCHAR current[32768] = {};
    const DWORD count = GetCurrentDirectoryW(ARRAYSIZE(current), current);
    require(count != 0 && count < ARRAYSIZE(current), "cannot resolve fixture working directory");
    owned_test_files owned;
    owned.directory = std::wstring(current) + L"\\preload-policy-owned-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    require(CreateDirectoryW(make_extended_length_path(owned.directory).c_str(), nullptr) != FALSE,
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
        scoped_handle writer(CreateFileW(make_extended_length_path(first).c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
        require(writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
            "hash guard did not deny concurrent writes");
        require(DeleteFileW(make_extended_length_path(first).c_str()) == FALSE && GetLastError() == ERROR_SHARING_VIOLATION,
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
    BOOLEAN created = CreateSymbolicLinkW(make_extended_length_path(link).c_str(), make_extended_length_path(first).c_str(), 0x2);
    if (!created && GetLastError() == ERROR_INVALID_PARAMETER)
        created = CreateSymbolicLinkW(make_extended_length_path(link).c_str(), make_extended_length_path(first).c_str(), 0);
    require(created != FALSE, "cannot create actual reparse case (enable Developer Mode or run fixture with symlink privilege)");
    {
        scoped_handle guard;
        BYTE hash[32] = {};
        require(hash_immutable_native_file(link, guard, hash) == ERROR_CANT_ACCESS_FILE,
            "reparse input was not explicitly rejected");
    }
    for (const auto &path : {first, second, empty, link})
        require(DeleteFileW(make_extended_length_path(path).c_str()) != FALSE, "fixture-owned file was not released after guard lifetime");
    require(RemoveDirectoryW(make_extended_length_path(owned.directory).c_str()) != FALSE,
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
        test_owned_run_marker_grammar();
        test_immutable_file_hashing();
        test_first_host_snapshot_selector();
        test_process_token_guard();
        test_completed_adapter_inspection();
        test_copied_thunk_bounds();
        std::cout << "{\"schemaVersion\":1,\"status\":\"passed\",\"cases\":9,\"assertions\":"
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
