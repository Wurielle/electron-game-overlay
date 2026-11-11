// Frozen production source; its injection entrypoint is never called.
#define wmain production_injector_main
#include EGO_INJECTOR_SOURCE
#undef wmain
#include <stdexcept>
static unsigned assertions = 0;
static void require(bool condition) { ++assertions; if (!condition) throw std::runtime_error("private diagnostic assertion failed"); }
int wmain(int argc, wchar_t **argv)
{
    if (argc != 2) return 64; // one fixed, fixture-owned data file
    try {
        attachment_token_context caller;
        require(read_attachment_token(GetCurrentProcess(), caller) == ERROR_SUCCESS);
        {
            const scoped_handle output(CreateFileW(argv[1], GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
            require(output != INVALID_HANDLE_VALUE);
            constexpr char data[] = "owned diagnostic fixture data";
            DWORD written = 0;
            require(WriteFile(output, data, sizeof(data), &written, nullptr) && written == sizeof(data));
        }
        BYTE hash[32] = {};
        {
            const scoped_handle writer(CreateFileW(argv[1], GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
            require(writer != INVALID_HANDLE_VALUE);
            scoped_handle guard;
            const wchar_t *operation = L"unset";
            const DWORD error = hash_immutable_native_file(argv[1], guard, hash, &operation);
            require(error == ERROR_SHARING_VIOLATION);
            require(std::wstring(operation) == L"open-native-read-guard");
            require(report_private_elevated_stage_failure(L"fixture-owned-data", operation, error) == error);
            require(GetLastError() == error);
        }
        {
            scoped_handle guard;
            const wchar_t *operation = L"unset";
            require(hash_immutable_native_file(argv[1], guard, hash, &operation) == ERROR_SUCCESS);
            const scoped_handle writer(CreateFileW(argv[1], GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
            require(writer == INVALID_HANDLE_VALUE);
            require(GetLastError() == ERROR_SHARING_VIOLATION);
        }
        { // Guard expiry releases the lock; the diagnostic adds no retained handle.
            const scoped_handle writer(CreateFileW(argv[1], GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
            require(writer != INVALID_HANDLE_VALUE);
        }
        std::wstring addon;
        require(staged_participant_path(addon) == ERROR_SUCCESS);
        const std::wstring directory = addon.substr(0, addon.find_last_of(L'\\'));
        {
            const scoped_handle writer(CreateFileW(directory.c_str(), FILE_ADD_FILE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
            require(writer != INVALID_HANDLE_VALUE);
            private_elevated_stage_guard guard;
            const DWORD error = validate_private_elevated_stage(guard, caller, hash, hash, hash);
            require(error == ERROR_SHARING_VIOLATION);
            require(GetLastError() == error);
        }
        require(DeleteFileW(argv[1]) != FALSE);
        std::printf("EGO_PRIVATE_STAGE_DIAGNOSTICS_FIXTURE {\"status\":\"passed\",\"assertions\":%u,\"actualCallerElevated\":%s,\"actualCallerIntegrity\":%lu,\"injection\":false,\"graphics\":false,\"privatePolicyBypassed\":false}\n",
            assertions, caller.elevated ? "true" : "false", caller.integrity);
        return 0;
    } catch (const std::exception &error) { std::fprintf(stderr, "%s assertions=%u\n", error.what(), assertions); return 1; }
}
