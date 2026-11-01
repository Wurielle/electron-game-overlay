// Console-only test of the exact ownership helper and actual pinned INI cache.
#include <Windows.h>
#include <bcrypt.h>
#include <share.h>
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include EGO_OWNED_CONFIG_HEADER
// Deliberately include the stock implementation once, in this translation unit,
// so the fixture counts its actual s_ini_cache rather than a behavioral mock.
#include EGO_PINNED_INI_CPP

std::filesystem::path g_reshade_dll_path;
std::filesystem::path g_reshade_base_path;
std::filesystem::path g_target_executable_path;

namespace fs = std::filesystem;
using record = ego_owned_config::reserved_file;
namespace
{
    void require(bool condition, const char *step)
    {
        if (!condition) throw std::runtime_error(step);
    }
    void success(DWORD error, const char *step) { require(error == ERROR_SUCCESS, step); }
    std::string read(const fs::path &path)
    {
        std::ifstream stream(path, std::ios::binary);
        require(stream.good(), "read file");
        return std::string(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
    }
    void write_new(const fs::path &path, const std::string &bytes)
    {
        ego_owned_config::temporary_handle file;
        file.value = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        require(file.value != INVALID_HANDLE_VALUE, "write_new CREATE_NEW");
        success(ego_owned_config::write_seed(file.value, bytes), "write_new bytes");
    }
    std::string sha256(const std::string &bytes)
    {
        BCRYPT_ALG_HANDLE algorithm = nullptr;
        require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "BCryptOpenAlgorithmProvider");
        struct algorithm_guard { BCRYPT_ALG_HANDLE value; ~algorithm_guard() { BCryptCloseAlgorithmProvider(value, 0); } } close { algorithm };
        DWORD length = 0, actual = 0;
        require(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&length), sizeof(length), &actual, 0) >= 0,
            "BCryptGetProperty");
        std::vector<UCHAR> object(length);
        BCRYPT_HASH_HANDLE hash = nullptr;
        require(BCryptCreateHash(algorithm, &hash, object.data(), length, nullptr, 0, 0) >= 0, "BCryptCreateHash");
        struct hash_guard { BCRYPT_HASH_HANDLE value; ~hash_guard() { BCryptDestroyHash(value); } } destroy { hash };
        require(BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char *>(bytes.data())), static_cast<ULONG>(bytes.size()), 0) >= 0,
            "BCryptHashData");
        UCHAR digest[32] = {};
        require(BCryptFinishHash(hash, digest, sizeof(digest), 0) >= 0, "BCryptFinishHash");
        std::ostringstream out;
        for (const auto byte : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(byte);
        return out.str();
    }
    DWORD handles()
    {
        DWORD result = 0;
        require(GetProcessHandleCount(GetCurrentProcess(), &result) != FALSE, "GetProcessHandleCount");
        return result;
    }
    size_t cache_count()
    {
        const std::shared_lock<std::shared_mutex> lock(s_ini_cache_mutex);
        return s_ini_cache.size();
    }
    std::string quote(const std::string &value)
    {
        std::string result = "\"";
        for (const char c : value)
        {
            if (c == '\\' || c == '"') { result += '\\'; result += c; }
            else if (c == '\n') result += "\\n";
            else if (c == '\r') result += "\\r";
            else result += c;
        }
        return result + '"';
    }
    struct evidence
    {
        std::map<std::string, std::string> fields;
        void number(const std::string &name, size_t value) { fields[name] = std::to_string(value); }
        void flag(const std::string &name, bool value) { fields[name] = value ? "true" : "false"; }
        void text(const std::string &name, const std::string &value) { fields[name] = quote(value); }
        std::string json() const
        {
            std::string result = "{";
            bool first = true;
            for (const auto &entry : fields)
            {
                if (!first) result += ',';
                first = false;
                result += quote(entry.first) + ':' + entry.second;
            }
            return result + "}\n";
        }
    };
    void delete_fixture_file(const fs::path &path) { require(DeleteFileW(path.c_str()) != FALSE, "fixture cleanup"); }
}

int wmain(int argc, wchar_t **argv)
{
    if (argc != 3 || std::wstring(argv[1]) != L"--directory")
    {
        std::cerr << "Usage: owned_config_retirement --directory <absolute NEW owned build-stage directory>\n";
        return 2;
    }
    const fs::path directory = argv[2];
    if (!directory.is_absolute() || fs::exists(directory) || !fs::is_directory(directory.parent_path()))
    {
        std::cerr << "Directory must be absolute, new, and below an existing owned build stage.\n";
        return 2;
    }
    if (!CreateDirectoryW(directory.c_str(), nullptr)) return 2;
    evidence report;
    report.number("schemaVersion", 1);
    report.text("scope", "console-only-owned-config-and-pinned-ini-cache");
    report.flag("loadsReShadeRuntime", false);
    report.flag("runsGraphics", false);
    report.flag("passed", false);
    std::unique_ptr<record> quarantine;
    int exit_code = 0;
    try
    {
        const std::string seed = "[INPUT]\nInputProcessing=2\n[OVERLAY]\nTutorialProgress=4\n";
        const fs::path template_path = directory / L"ReShade.ini";
        const fs::path unrelated_path = directory / L"unrelated.ini";
        write_new(template_path, seed);
        write_new(unrelated_path, "[Other]\nKeep=1\n");
        const std::string template_hash = sha256(read(template_path));
        const std::string unrelated_hash = sha256(read(unrelated_path));
        static_cast<void>(reshade::ini_file::load_cache(template_path));
        static_cast<void>(reshade::ini_file::load_cache(unrelated_path));
        const size_t baseline_cache = cache_count();
        const DWORD baseline_handles = handles();
        report.number("baselineCacheEntries", baseline_cache);
        report.number("baselineHandles", baseline_handles);
        report.text("templateSha256Before", template_hash);
        report.text("unrelatedSha256Before", unrelated_hash);
        size_t callbacks = 0, cycles = 0;
        DWORD peak_handles = baseline_handles;
        for (unsigned i = 0; i != 128; ++i)
        {
            record config;
            const fs::path path = directory / (L"owned-cycle-" + std::to_wstring(i) + L".ini");
            success(ego_owned_config::create_seeded(config, path, seed), "cycle create_seeded");
            require(sha256(read(path)) == template_hash, "seed hash differs");
            peak_handles = std::max(peak_handles, handles());
            success(ego_owned_config::verify_current(config), "verify live config");
            {
                auto &ini = reshade::ini_file::load_cache(path);
                ini.set("Fixture", "Cycle", i);
                require(reshade::ini_file::flush_cache(path), "actual CRT SH_DENYWR save with guard");
            }
            require(cache_count() == baseline_cache + 1, "cycle cache cardinality");
            success(ego_owned_config::verify_current(config), "verify after CRT save");
            success(ego_owned_config::retire(config, [&](const fs::path &exact) {
                require(exact == path, "wrong cache eviction path");
                ++callbacks;
                reshade::ini_file::clear_cache(exact);
            }), "cycle retire");
            require(!fs::exists(path) && reshade::ini_file::find_cache(path) == nullptr, "cycle resource not retired");
            require(cache_count() == baseline_cache, "cycle cache did not return to baseline");
            ++cycles;
        }
        report.number("retiredCycles", cycles);
        report.number("cycleCacheClearCallbacks", callbacks);
        report.number("peakHandlesDuringCycles", peak_handles);
        report.flag("actualCrtSaveCompatibleWithGuard", true);

        {
            record config;
            const auto path = directory / L"guard.ini";
            success(ego_owned_config::create_seeded(config, path, seed), "guard create");
            SetLastError(ERROR_SUCCESS);
            require(!MoveFileExW(path.c_str(), (directory / L"guard-moved.ini").c_str(), 0), "live guard allowed rename");
            report.number("liveGuardRenameError", GetLastError());
            require(fs::exists(path), "live guard path changed");
            success(ego_owned_config::retire(config, [](const fs::path &exact) { reshade::ini_file::clear_cache(exact); }), "guard retire");
        }

        unsigned protected_replacements = 0;
        for (const bool identical : { false, true })
        {
            const auto path = directory / (identical ? L"replacement-same.ini" : L"replacement-other.ini");
            const auto moved = directory / (identical ? L"original-same.ini" : L"original-other.ini");
            const std::string replacement_bytes = identical ? seed : "foreign replacement sentinel\n";
            const std::string expected_hash = sha256(replacement_bytes);
            {
                record config;
                success(ego_owned_config::create_seeded(config, path, seed), "replacement create");
                static_cast<void>(reshade::ini_file::load_cache(path));
                success(ego_owned_config::begin_retirement(config), "replacement begin_retirement");
                require(MoveFileExW(path.c_str(), moved.c_str(), 0) != FALSE, "rename during permitted handoff");
                write_new(path, replacement_bytes);
                ego_owned_config::temporary_handle replacement;
                replacement.value = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
                require(replacement.value != INVALID_HANDLE_VALUE, "inspect replacement open");
                ego_owned_config::identity replacement_id;
                success(ego_owned_config::inspect(replacement.value, replacement_id), "inspect replacement");
                // Original object remains pinned by begin_retirement's handoff
                // handle, so this check does not rely on file-ID reuse timing.
                require(!ego_owned_config::same(config.created, replacement_id), "replacement identity unexpectedly same");
                size_t wrong_callbacks = 0;
                require(ego_owned_config::retire(config, [&](const fs::path &) { ++wrong_callbacks; }) != ERROR_SUCCESS,
                    "replacement wrongly retired");
                require(wrong_callbacks == 0, "replacement evicted cache");
                require(sha256(read(path)) == expected_hash && sha256(read(moved)) == template_hash,
                    "replacement/original bytes changed");
                require(reshade::ini_file::find_cache(path) != nullptr, "uncertain replacement cache not retained");
            }
            reshade::ini_file::clear_cache(path); // Fixture teardown after all preservation assertions.
            delete_fixture_file(path);
            delete_fixture_file(moved);
            ++protected_replacements;
        }
        report.number("protectedReplacements", protected_replacements);
        report.flag("identicalBytesReplacementRejected", true);

        {
            record config;
            const auto path = directory / L"transient-flush.ini";
            success(ego_owned_config::create_seeded(config, path, seed), "transient flush create");
            static_cast<void>(reshade::ini_file::load_cache(path));
            ego_owned_config::temporary_handle ready, release;
            ready.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            release.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            require(ready.value != nullptr && release.value != nullptr, "transient flush events");
            std::atomic<DWORD> writer_error { ERROR_SUCCESS };
            std::thread writer([&] {
                FILE *const file = _wfsopen(path.c_str(), L"w", SH_DENYWR);
                if (file == nullptr) writer_error.store(ERROR_OPEN_FAILED);
                else if (fwrite(seed.data(), 1, seed.size(), file) != seed.size() || fflush(file) != 0)
                    writer_error.store(ERROR_WRITE_FAULT);
                SetEvent(ready.value);
                if (file != nullptr)
                {
                    if (WaitForSingleObject(release.value, 2000) != WAIT_OBJECT_0)
                        writer_error.store(ERROR_TIMEOUT);
                    Sleep(10); // Simulate the tail of an actual stock CRT flush.
                    if (fclose(file) != 0) writer_error.store(ERROR_WRITE_FAULT);
                }
            });
            struct join_writer
            {
                std::thread &thread;
                HANDLE release;
                ~join_writer() { SetEvent(release); if (thread.joinable()) thread.join(); }
            } join { writer, release.value };
            require(WaitForSingleObject(ready.value, 2000) == WAIT_OBJECT_0, "transient writer readiness");
            success(writer_error.load(), "transient writer open");
            success(ego_owned_config::begin_retirement(config), "transient handoff");
            // The live no-delete guard is gone; this error is caused by the
            // actual CRT writer, which stays open until the release event.
            ego_owned_config::temporary_handle blocked;
            blocked.value = CreateFileW(path.c_str(), DELETE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            const DWORD blocked_error = GetLastError();
            require(blocked.value == INVALID_HANDLE_VALUE && blocked_error == ERROR_SHARING_VIOLATION,
                "actual CRT writer did not deny deletion");
            SetEvent(release.value);
            size_t transient_callbacks = 0;
            const auto started = GetTickCount64();
            const DWORD result = ego_owned_config::retire(config, [&](const fs::path &exact) {
                require(exact == path, "transient wrong cache path");
                ++transient_callbacks;
                reshade::ini_file::clear_cache(exact);
            });
            const auto elapsed = GetTickCount64() - started;
            writer.join();
            success(writer_error.load(), "transient writer completion");
            success(result, "bounded transient sharing retry");
            require(transient_callbacks == 1 && !fs::exists(path) && reshade::ini_file::find_cache(path) == nullptr,
                "transient resources not retired exactly once");
            require(sha256(read(template_path)) == template_hash, "transient retry changed template");
            report.flag("transientCrtSharingRetryPassed", true);
            report.number("transientCrtSharingProbeError", blocked_error);
            report.number("transientCacheClearCallbacks", transient_callbacks);
            report.number("transientRetirementElapsedMs", static_cast<size_t>(elapsed));
        }

        {
            record config;
            const auto path = directory / L"seed-failure.ini";
            const DWORD result = ego_owned_config::create_seeded(config, path, seed,
                [](HANDLE file, const std::string &) { DWORD written = 0; WriteFile(file, "bad", 3, &written, nullptr); return ERROR_WRITE_FAULT; });
            require(result == ERROR_WRITE_FAULT && config.owned(), "seed failure lost ownership");
            success(ego_owned_config::retire(config, [](const fs::path &exact) { reshade::ini_file::clear_cache(exact); }), "seed failure cleanup");
            require(!fs::exists(path), "seed failure orphan");
        }
        {
            record config;
            const auto path = directory / L"encoding-failure.ini";
            success(ego_owned_config::create_seeded(config, path, seed), "encoding create");
            try { throw std::runtime_error("injected UTF-8 conversion failure before runtime"); }
            catch (const std::runtime_error &) {
                success(ego_owned_config::retire(config, [](const fs::path &exact) { reshade::ini_file::clear_cache(exact); }), "encoding cleanup");
            }
            require(!fs::exists(path), "encoding failure orphan");
        }
        report.flag("seedFailureRetired", true);
        report.flag("encodingFailureRetired", true);
        const DWORD normal_handles_end = handles();
        require(normal_handles_end == baseline_handles, "normal retirement handle imbalance");
        require(cache_count() == baseline_cache, "normal retirement cache imbalance");
        report.number("normalHandlesEnd", normal_handles_end);
        report.number("normalCacheEntriesEnd", cache_count());

        // Quarantine intentionally remains live through report creation/process
        // exit. It is not counted as an ordinary retirement or an undisclosed leak.
        quarantine = std::make_unique<record>();
        const auto quarantine_path = directory / L"quarantine.ini";
        success(ego_owned_config::create_seeded(*quarantine, quarantine_path, seed), "quarantine create");
        static_cast<void>(reshade::ini_file::load_cache(quarantine_path));
        require(sha256(read(quarantine_path)) == template_hash && quarantine->owned() &&
            cache_count() == baseline_cache + 1, "quarantine changed");
        report.flag("quarantinePreserved", true);
        report.number("intentionalQuarantinedConfigs", 1);
        report.number("cacheEntriesWithQuarantine", cache_count());
        report.number("handlesWithQuarantine", handles());
        const std::string template_after = sha256(read(template_path));
        const std::string unrelated_after = sha256(read(unrelated_path));
        require(template_after == template_hash && unrelated_after == unrelated_hash, "template or unrelated file changed");
        require(reshade::ini_file::find_cache(template_path) != nullptr &&
            reshade::ini_file::find_cache(unrelated_path) != nullptr, "unrelated cache evicted");
        report.text("templateSha256After", template_after);
        report.text("unrelatedSha256After", unrelated_after);
        report.flag("passed", true);
    }
    catch (const std::exception &error)
    {
        report.text("failure", error.what());
        exit_code = 1;
    }
    try { write_new(directory / L"report.json", report.json()); }
    catch (const std::exception &error) { std::cerr << "Report failed: " << error.what() << '\n'; return 3; }
    std::cout << report.json();
    return exit_code;
}
