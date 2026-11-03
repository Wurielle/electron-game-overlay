// Pure-console regression of the exact pinned stock INI serializer.
#include <Windows.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <share.h>
#include <stdexcept>
#include <string>

// Include the stock implementation, not a substitute serializer or a ReShade DLL.
#include EGO_PINNED_INI_CPP

std::filesystem::path g_reshade_dll_path;
std::filesystem::path g_reshade_base_path;
std::filesystem::path g_target_executable_path;

namespace fs = std::filesystem;
namespace
{
    void require(bool condition, const char *message)
    {
        if (!condition) throw std::runtime_error(message);
    }

    std::string read_bytes(const fs::path &path)
    {
        std::ifstream file(path, std::ios::binary);
        require(file.good(), "Cannot read fixture file.");
        return { std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>() };
    }

    void write_new(const fs::path &path, const std::string &bytes)
    {
        const HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
            CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        require(file != INVALID_HANDLE_VALUE, "Cannot create new owned fixture file.");
        struct close_handle { HANDLE value; ~close_handle() { CloseHandle(value); } } close { file };
        require(bytes.size() <= MAXDWORD, "Fixture file too large.");
        DWORD written = 0;
        require(WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
            written == bytes.size() && FlushFileBuffers(file), "Cannot write owned fixture bytes.");
    }

    const char *boolean(bool value) { return value ? "true" : "false"; }
}

int wmain(int argc, wchar_t **argv)
{
    if (argc != 3)
    {
        std::cerr << "Usage: ini_canonicalization_probe <canonical-source-ReShade.ini> <absolute-NEW-owned-build-stage>\n";
        return 2;
    }
    try
    {
        const fs::path source = fs::canonical(argv[1]);
        const fs::path stage = argv[2];
        const DWORD source_attributes = GetFileAttributesW(source.c_str());
        require(source_attributes != INVALID_FILE_ATTRIBUTES &&
            (source_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0,
            "Source must be a regular template file.");
        require(stage.is_absolute() && !fs::exists(stage) && fs::is_directory(stage.parent_path()),
            "Stage must be absolute, new, and below an existing owned build directory.");
        const std::string canonical = read_bytes(source);
        require(canonical.size() >= 4 && canonical.compare(canonical.size() - 4, 4, "\r\n\r\n") == 0,
            "Canonical source must end with a CRLF section separator.");
        // Recreate the exact former formatting defect without editing the source.
        const std::string legacy = canonical.substr(0, canonical.size() - 2);
        require(CreateDirectoryW(stage.c_str(), nullptr) != FALSE, "Cannot reserve new owned stage.");
        const fs::path config_path = stage / L"ReShade.ini";
        write_new(config_path, legacy);
        write_new(stage / L"canonical-source.bin", canonical);
        write_new(stage / L"legacy.bin", legacy);
        g_reshade_base_path = stage;

        unsigned progress = 0;
        require(reshade::global_config().get("OVERLAY", "TutorialProgress", progress) && progress == 4,
            "Source TutorialProgress must already be 4.");
        // runtime::save_config_gui writes this global value even when unchanged.
        reshade::global_config().set("OVERLAY", "TutorialProgress", 4);
        require(reshade::ini_file::flush_cache(config_path), "First stock INI save failed.");
        const std::string first = read_bytes(config_path);
        write_new(stage / L"first-save.bin", first);

        reshade::ini_file::clear_cache(config_path);
        reshade::global_config().set("OVERLAY", "TutorialProgress", 4);
        require(reshade::ini_file::flush_cache(config_path), "Second stock INI save failed.");
        const std::string second = read_bytes(config_path);
        write_new(stage / L"second-save.bin", second);

        const bool adds_only_separator = first == legacy + "\r\n";
        const bool exact_source = first == canonical;
        const bool idempotent = second == first && second == canonical;
        const bool source_unchanged = read_bytes(source) == canonical;
        const bool passed = adds_only_separator && exact_source && idempotent && source_unchanged;
        const std::string report = "{\"schemaVersion\":1,\"loadsReShadeRuntime\":false,\"runsGraphics\":false," +
            std::string("\"canonicalSourceBytes\":") + std::to_string(canonical.size()) +
            ",\"legacyBytes\":" + std::to_string(legacy.size()) +
            ",\"firstSaveBytes\":" + std::to_string(first.size()) +
            ",\"secondSaveBytes\":" + std::to_string(second.size()) +
            ",\"firstSaveAddsOnlyOneCrlf\":" + boolean(adds_only_separator) +
            ",\"firstSaveMatchesCanonicalSourceExactly\":" + boolean(exact_source) +
            ",\"secondSaveIsByteIdentical\":" + boolean(idempotent) +
            ",\"sourceTemplateUnchanged\":" + boolean(source_unchanged) +
            ",\"passed\":" + boolean(passed) + "}\n";
        write_new(stage / L"report.json", report);
        std::cout << report;
        return passed ? 0 : 1;
    }
    catch (const std::exception &error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
