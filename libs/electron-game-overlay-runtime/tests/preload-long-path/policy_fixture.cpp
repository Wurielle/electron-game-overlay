// Local policy seam only. The production injector entry point is renamed and
// never invoked. Every file belongs to a freshly created SDK build-directory tree.
#include <Windows.h>
#include <Psapi.h>
#include <cstdint>
#include <exception>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef EGO_INJECTOR_SOURCE
#error Supply the exact candidate EGO_INJECTOR_SOURCE.
#endif
#ifndef EGO_ALLOWED_TEST_ROOT
#error Supply the SDK-owned build directory.
#endif

static volatile LONG forbidden_mutations = 0;
static LPVOID WINAPI forbidden_virtual_alloc(HANDLE, LPVOID, SIZE_T, DWORD, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return nullptr; }
static BOOL WINAPI forbidden_virtual_free(HANDLE, LPVOID, SIZE_T, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
static BOOL WINAPI forbidden_write(HANDLE, LPVOID, LPCVOID, SIZE_T, SIZE_T *)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
static HANDLE WINAPI forbidden_remote_thread(HANDLE, LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return nullptr; }
static BOOL WINAPI forbidden_duplicate(HANDLE, HANDLE, HANDLE, LPHANDLE, DWORD, BOOL, DWORD)
{ InterlockedIncrement(&forbidden_mutations); SetLastError(ERROR_ACCESS_DENIED); return FALSE; }

#define VirtualAllocEx forbidden_virtual_alloc
#define VirtualFreeEx forbidden_virtual_free
#define WriteProcessMemory forbidden_write
#define CreateRemoteThread forbidden_remote_thread
#define DuplicateHandle forbidden_duplicate
#define wmain ego_unused_production_policy_injector_entry
#include EGO_INJECTOR_SOURCE
#undef wmain
#undef DuplicateHandle
#undef CreateRemoteThread
#undef WriteProcessMemory
#undef VirtualFreeEx
#undef VirtualAllocEx

namespace
{
std::uint64_t assertions = 0;
struct observation { std::string name; DWORD error; bool accepted; };
std::vector<observation> observations;
std::vector<std::string> skips;
constexpr BYTE abc_sha256[32] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
};
constexpr wchar_t addon_leaf[] = L"ego-preload-0123456789abcdef0123456789abcdef-ABCDEF0123456789ABCDEF0123456789-ba7816bf8f01cfea.addon64";

void policy_require(bool condition, const std::string &message)
{
    ++assertions;
    if (!condition) throw std::runtime_error(message);
}

std::wstring canonical(const std::wstring &input)
{
    DWORD error = ERROR_SUCCESS;
    std::wstring result;
    policy_require(get_full_path(input, result, error), "Cannot canonicalize owned policy path");
    return result;
}

bool descendant(const std::wstring &parent, const std::wstring &path)
{
    return path.size() > parent.size() && path[parent.size()] == L'\\' &&
        CompareStringOrdinal(parent.c_str(), static_cast<int>(parent.size()),
            path.c_str(), static_cast<int>(parent.size()), TRUE) == CSTR_EQUAL;
}

std::string utf8(const std::wstring &text)
{
    if (text.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
        static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    policy_require(count > 0, "Cannot encode policy fixture UTF-8");
    std::string result(static_cast<std::size_t>(count), '\0');
    policy_require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
        static_cast<int>(text.size()), result.data(), count, nullptr, nullptr) == count,
        "Incomplete policy fixture UTF-8 encoding");
    return result;
}

std::string json_quote(const std::string &value)
{
    std::string result = "\"";
    for (const unsigned char c : value) {
        if (c == '\\' || c == '"') result += '\\';
        if (c < 0x20) {
            constexpr char digits[] = "0123456789abcdef";
            result += "\\u00"; result += digits[c >> 4]; result += digits[c & 15];
        } else result += static_cast<char>(c);
    }
    return result + '"';
}

struct owned_tree
{
    std::wstring root;
    void check(const std::wstring &path) const
    {
        policy_require(descendant(root, path) && _wcsicmp(canonical(path).c_str(), path.c_str()) == 0,
            "Policy operation escaped its canonical fresh owned root");
    }
    std::wstring directory(const std::wstring &parent, const std::wstring &leaf) const
    {
        const auto path = parent + L"\\" + leaf;
        check(path);
        policy_require(CreateDirectoryW(make_extended_length_path(path).c_str(), nullptr) != FALSE,
            "Cannot exclusively create policy-owned directory");
        return path;
    }
    void write(const std::wstring &path, const std::string &bytes, DWORD disposition) const
    {
        check(path);
        const scoped_handle file(CreateFileW(make_extended_length_path(path).c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        policy_require(file != INVALID_HANDLE_VALUE, "Cannot open policy-owned output");
        BY_HANDLE_FILE_INFORMATION info{};
        policy_require(GetFileInformationByHandle(file, &info) != FALSE &&
            (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) == 0,
            "Policy-owned output unexpectedly became a reparse point/directory");
        DWORD written = 0;
        policy_require(WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) != FALSE &&
            written == bytes.size(), "Incomplete policy-owned write");
    }
    std::wstring file(const std::wstring &parent, const wchar_t *leaf, const std::string &contents) const
    {
        const auto path = parent + L"\\" + leaf;
        write(path, contents, CREATE_NEW);
        return path;
    }
    void remove_file(const std::wstring &path) const
    {
        check(path);
        policy_require(DeleteFileW(make_extended_length_path(path).c_str()) != FALSE,
            "Cannot remove exact policy-owned file");
    }
};

std::string marker_document(const std::wstring &stage_leaf)
{
    return "{\"schemaVersion\":1,\"kind\":\"electron-game-overlay-reshade-run\","
        "\"runId\":\"01234567-89ab-4def-8abc-0123456789ab\",\"directoryName\":" +
        json_quote(utf8(stage_leaf)) + ",\"createdAt\":\"2026-11-02T00:12:34.567Z\"}";
}

bool optional_symlink(const owned_tree &owned, const std::wstring &link,
    const std::wstring &target, bool directory, const std::string &label)
{
    owned.check(link); owned.check(target);
    const DWORD flags = directory ? SYMBOLIC_LINK_FLAG_DIRECTORY : 0;
    BOOLEAN linked = CreateSymbolicLinkW(make_extended_length_path(link).c_str(),
        make_extended_length_path(target).c_str(), flags | 0x2);
    if (!linked && GetLastError() == ERROR_INVALID_PARAMETER)
        linked = CreateSymbolicLinkW(make_extended_length_path(link).c_str(),
            make_extended_length_path(target).c_str(), flags);
    if (linked) return true;
    const DWORD error = GetLastError();
    policy_require(error == ERROR_PRIVILEGE_NOT_HELD || error == ERROR_ACCESS_DENIED ||
        error == ERROR_NOT_SUPPORTED || error == ERROR_INVALID_PARAMETER,
        "Unexpected owned symlink creation failure " + std::to_string(error));
    skips.push_back(label + ": standard-user symlink creation unavailable, Win32 error " + std::to_string(error));
    return false;
}

void test_snapshot(const owned_tree &owned, const std::wstring &target,
    const std::wstring &other, std::size_t selected_length)
{
    const std::wstring suffix = std::wstring(L"\\preloaded-addons\\") + addon_leaf;
    policy_require(selected_length > owned.root.size() + 1 + suffix.size(),
        "Fresh policy root is too long for requested path boundary");
    const std::wstring stage_leaf(selected_length - owned.root.size() - 1 - suffix.size(), L's');
    policy_require(stage_leaf.size() < 255, "Policy stage component exceeds native bound");
    const auto stage = owned.directory(owned.root, stage_leaf);
    const auto snapshot = owned.directory(stage, L"preloaded-addons");
    const auto runtime = owned.file(stage, target_reshade_runtime_file, "fixture runtime bytes");
    const auto selected_file = owned.file(snapshot, addon_leaf, "abc");
    policy_require(selected_file.size() == selected_length, "Policy path length arithmetic changed");
    const auto source_file = owned.file(stage, L"regular-copy.dll", "abc");
    const std::string ascii = "ELECTRON_GAME_OVERLAY_OWNED_RUNTIME_STAGE_V1\n";
    const auto ascii_marker = owned.file(stage, L"electron-game-overlay-owned-runtime-v1.marker", ascii);
    const std::string json = marker_document(stage_leaf);
    const auto run_marker = owned.file(stage, L".electron-game-overlay-run.json", json);
    const auto config = owned.file(stage, L"ReShade.ini", "[ADDON]\r\nAddonPath=" + utf8(snapshot) + "\r\n");
    const auto tag = std::to_string(selected_length) + "/";

    const auto expect = [&](bool accept, const std::string &name, const std::wstring &stage_path,
        const std::wstring &target_path, const std::wstring &runtime_path,
        const target_effective_reshade_settings &settings, const BYTE (&hash)[32], bool guards = false) {
        std::wstring selected;
        owned_preload_snapshot_guard guard;
        const DWORD error = validate_first_host_preload_snapshot(stage_path, target_path,
            runtime_path, settings, addon_leaf, hash, selected, guard);
        observations.push_back({tag + name, error, accept});
        policy_require((error == ERROR_SUCCESS) == accept,
            tag + name + " unexpected selector result " + std::to_string(error));
        if (!accept) return;
        policy_require(_wcsicmp(selected.c_str(), selected_file.c_str()) == 0,
            "Selector changed the exact ordinary selected-file representation");
        if (!guards) return;
        for (const auto &path : {stage, snapshot}) {
            const scoped_handle deletion(CreateFileW(make_extended_length_path(path).c_str(), DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS, nullptr));
            policy_require(deletion == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
                "Selector directory guard allowed replacement access");
        }
        const scoped_handle writer(CreateFileW(make_extended_length_path(selected_file).c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL, nullptr));
        policy_require(writer == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
            "Selector file guard allowed content mutation");
        policy_require(DeleteFileW(make_extended_length_path(selected_file).c_str()) == FALSE &&
            GetLastError() == ERROR_SHARING_VIOLATION, "Selector file guard allowed deletion");
    };

    for (const bool prefix : {false, true}) {
        const std::string form = prefix ? "extended/" : "ordinary/";
        target_effective_reshade_settings settings;
        settings.reshade_base_path = stage;
        settings.addon_directory_path = prefix ? make_extended_length_path(snapshot) : snapshot;
        const auto configuration = "[ADDON]\r\nAddonPath=" + utf8(settings.addon_directory_path) + "\r\n";
        owned.write(config, configuration, TRUNCATE_EXISTING);
        const auto check = [&](bool accept, const std::string &name,
            const target_effective_reshade_settings &effective, bool guards = false) {
            expect(accept, form + name, stage, target, runtime, effective, abc_sha256, guards);
        };
        const auto reject_both_forms = [&](const std::wstring &path, const std::string &name) {
            auto wrong = settings;
            wrong.addon_directory_path = path;
            check(false, name, wrong);
        };
        check(true, "canonical", settings, true);
        for (const auto &path : {stage, snapshot}) {
            const scoped_handle deletion(CreateFileW(make_extended_length_path(path).c_str(), DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS, nullptr));
            policy_require(deletion != INVALID_HANDLE_VALUE, "Selector directory guard did not release");
        }
        auto wrong = settings;
        wrong.reshade_base_path = other;
        check(false, "foreign-base", wrong);
        const std::wstring external = prefix ? make_extended_length_path(other) : other;
        reject_both_forms(external, "external-addon-directory");
        reject_both_forms(L"preloaded-addons", "relative-addon-directory");
        reject_both_forms(L".\\preloaded-addons", "relative-dot-addon-directory");
        const std::wstring dot = stage + L"\\.\\preloaded-addons";
        const std::wstring dot_dot = stage + L"\\preloaded-addons\\..\\preloaded-addons";
        reject_both_forms(prefix ? make_extended_length_path(dot) : dot, "dot-alias");
        reject_both_forms(prefix ? make_extended_length_path(dot_dot) : dot_dot, "dot-dot-alias");
        reject_both_forms(settings.addon_directory_path + L"\\", "trailing-separator");
        reject_both_forms(settings.addon_directory_path + L".", "trailing-dot");
        auto forward_slashes = settings.addon_directory_path;
        for (auto &c : forward_slashes) if (c == L'\\') c = L'/';
        reject_both_forms(forward_slashes, "forward-slash-alias");
        reject_both_forms(L"\\\\?\\" + make_extended_length_path(snapshot), "double-extended-prefix");
        reject_both_forms(L"\\\\.\\" + snapshot, "device-prefix");
        expect(false, form + "wrong-runtime-leaf", stage, target, source_file, settings, abc_sha256);
        expect(false, form + "runtime-outside-stage", stage, target,
            other + L"\\" + target_reshade_runtime_file, settings, abc_sha256);
        expect(false, form + "target-inside-stage", stage, stage + L"\\game.exe", runtime, settings, abc_sha256);
        BYTE wrong_hash[32];
        memcpy(wrong_hash, abc_sha256, sizeof(wrong_hash));
        wrong_hash[31] ^= 1;
        expect(false, form + "different-final-hash-byte", stage, target, runtime, settings, wrong_hash);
        owned.write(ascii_marker, ascii + "\r\n", TRUNCATE_EXISTING);
        check(false, "nonexact-ascii-marker", settings);
        owned.write(ascii_marker, ascii, TRUNCATE_EXISTING);
        owned.write(run_marker, marker_document(L"other"), TRUNCATE_EXISTING);
        check(false, "wrong-json-directory", settings);
        owned.write(run_marker, json.substr(0, json.size() - 1) + ",\"unknown\":\"x\"}", TRUNCATE_EXISTING);
        check(false, "unknown-json-field", settings);
        owned.write(run_marker, std::string("\xef\xbb\xbf") + json, TRUNCATE_EXISTING);
        check(false, "bom-json-marker", settings);
        owned.write(run_marker, json, TRUNCATE_EXISTING);
        for (const auto &path : {ascii_marker, run_marker, config, selected_file}) {
            owned.remove_file(path);
            check(false, "missing-" + utf8(path.substr(path.find_last_of(L'\\') + 1)), settings);
            const std::string contents = path == ascii_marker ? ascii : path == run_marker ? json :
                path == selected_file ? std::string("abc") : configuration;
            owned.write(path, contents, CREATE_NEW);
        }
        owned.write(selected_file, "abd", TRUNCATE_EXISTING);
        check(false, "altered-payload", settings);
        owned.write(selected_file, "abc", TRUNCATE_EXISTING);
        owned.remove_file(selected_file);
        if (optional_symlink(owned, selected_file, source_file, false, tag + form + "reparse-leaf")) {
            check(false, "reparse-leaf", settings);
            owned.remove_file(selected_file);
        }
        owned.write(selected_file, "abc", CREATE_NEW);
        const auto alias = owned.root + L"\\alias-" + std::to_wstring(selected_length) + (prefix ? L"-e" : L"-o");
        if (optional_symlink(owned, alias, stage, true, tag + form + "reparse-stage")) {
            wrong = settings;
            wrong.reshade_base_path = alias;
            const auto alias_snapshot = alias + L"\\preloaded-addons";
            wrong.addon_directory_path = prefix ? make_extended_length_path(alias_snapshot) : alias_snapshot;
            expect(false, form + "reparse-stage", alias, target,
                alias + L"\\" + target_reshade_runtime_file, wrong, abc_sha256);
            policy_require(RemoveDirectoryW(make_extended_length_path(alias).c_str()) != FALSE,
                "Cannot retire exact owned stage symlink");
        }
        // Move only this owned snapshot, and point its original name back to it.
        // Identical contents must not make a reparse directory admissible.
        const auto moved = stage + L"\\snapshot-held";
        owned.check(moved);
        policy_require(MoveFileW(make_extended_length_path(snapshot).c_str(),
            make_extended_length_path(moved).c_str()) != FALSE, "Cannot move owned snapshot for symlink control");
        if (optional_symlink(owned, snapshot, moved, true, tag + form + "reparse-snapshot")) {
            check(false, "reparse-snapshot", settings);
            policy_require(RemoveDirectoryW(make_extended_length_path(snapshot).c_str()) != FALSE,
                "Cannot retire exact owned snapshot symlink");
        }
        policy_require(MoveFileW(make_extended_length_path(moved).c_str(),
            make_extended_length_path(snapshot).c_str()) != FALSE, "Cannot restore owned snapshot directory");
        check(true, "valid-after-rejections", settings, true);
    }
}

std::string summary(const owned_tree &owned)
{
    std::ostringstream output;
    output << "{\"schemaVersion\":1,\"status\":\"passed\",\"scope\":\"Owned local snapshot selector policy; no production entry, remote mutation, ReShade or graphics\",\"root\":"
        << json_quote(utf8(owned.root)) << ",\"assertions\":" << assertions << ",\"cases\":[";
    for (std::size_t i = 0; i < observations.size(); ++i) {
        if (i) output << ',';
        output << "{\"name\":" << json_quote(observations[i].name) << ",\"error\":" << observations[i].error
            << ",\"expectedAccepted\":" << (observations[i].accepted ? "true" : "false") << '}';
    }
    output << "],\"skipped\":[";
    for (std::size_t i = 0; i < skips.size(); ++i) { if (i) output << ','; output << json_quote(skips[i]); }
    output << "],\"explicitRemoteMutationCalls\":" << forbidden_mutations << '}';
    return output.str();
}
}

int wmain(int argc, wchar_t **argv)
{
    try {
        policy_require(argc == 5 && wcscmp(argv[1], L"--root") == 0 && wcscmp(argv[3], L"--report") == 0,
            "Usage: preload_long_path_policy_fixture --root <fresh SDK build child> --report <root/report.json>");
        owned_tree owned;
        owned.root = canonical(argv[2]);
        policy_require(_wcsicmp(owned.root.c_str(), argv[2]) == 0 && is_absolute_windows_path(owned.root),
            "Policy root must already be a canonical absolute path");
        const auto allowed = canonical(EGO_ALLOWED_TEST_ROOT);
        const auto separator = owned.root.find_last_of(L'\\');
        policy_require(separator != std::wstring::npos &&
            _wcsicmp(owned.root.substr(0, separator).c_str(), allowed.c_str()) == 0,
            "Fresh policy root must be a direct child of the SDK build directory");
        DWORD error = ERROR_SUCCESS;
        std::wstring final_allowed;
        policy_require(get_final_directory_path(allowed, final_allowed, error) &&
            _wcsicmp(allowed.c_str(), final_allowed.c_str()) == 0,
            "SDK build path must resolve to its exact canonical directory");
        const auto report = canonical(argv[4]);
        policy_require(_wcsicmp(report.c_str(), (owned.root + L"\\report.json").c_str()) == 0,
            "Policy report must be the exact fresh root/report.json path");
        policy_require(CreateDirectoryW(make_extended_length_path(owned.root).c_str(), nullptr) != FALSE,
            "Policy root already exists or cannot be exclusively created");
        const auto game = owned.directory(owned.root, L"game");
        const auto other = owned.directory(owned.root, L"other");
        const auto target = owned.file(game, L"game.exe", "fixture target bytes");
        owned.file(other, addon_leaf, "abc");
        for (const std::size_t length : {233u, 259u, 260u, 289u, 320u})
            test_snapshot(owned, target, other, length);
        policy_require(forbidden_mutations == 0, "A forbidden remote mutation API was called");
        const auto result = summary(owned);
        owned.write(report, result, CREATE_NEW);
        std::cout << result << '\n';
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "PRELOAD_LONG_PATH_POLICY_FAILED " << error.what() << " WindowsError=" << GetLastError()
            << " assertions=" << assertions << " completedCases=" << observations.size()
            << " explicitRemoteMutationCalls=" << forbidden_mutations << '\n';
        return 1;
    }
}
