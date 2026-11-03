#pragma once

// Loader-time trace: fixed stack buffers, Kernel32 file/process calls only.
// The runner precreates trace.ndjson next to each owned module. No environment
// path, process enumeration, arbitrary target selection, or directory creation.
#include <windows.h>

namespace early_proof
{
    inline bool trace(HMODULE own_module, const char *event,
        long status = 0, unsigned long count = 0) noexcept
    {
        wchar_t path[32768] = {};
        const DWORD length = GetModuleFileNameW(own_module, path, 32768);
        if (length == 0 || length >= 32768) return false;
        DWORD leaf = length;
        while (leaf != 0 && path[leaf - 1] != L'\\' && path[leaf - 1] != L'/') --leaf;
        constexpr wchar_t name[] = L"trace.ndjson";
        if (leaf == 0 || leaf + sizeof(name) / sizeof(wchar_t) > 32768) return false;
        for (DWORD i = 0; i != sizeof(name) / sizeof(wchar_t); ++i) path[leaf + i] = name[i];

        const DWORD attributes = GetFileAttributesW(path);
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
            return false;
        HANDLE file = CreateFileW(path, GENERIC_WRITE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (file == INVALID_HANDLE_VALUE) return false;
        FILE_ATTRIBUTE_TAG_INFO tag = {};
        if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
            (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            CloseHandle(file);
            return false;
        }
        LARGE_INTEGER end = {};
        if (!SetFilePointerEx(file, end, nullptr, FILE_END))
        {
            CloseHandle(file);
            return false;
        }

        FILETIME created = {}, exited = {}, kernel = {}, user = {};
        LARGE_INTEGER qpc = {};
        if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) ||
            !QueryPerformanceCounter(&qpc))
        {
            CloseHandle(file);
            return false;
        }
        const ULONGLONG creation = (ULONGLONG(created.dwHighDateTime) << 32) | created.dwLowDateTime;
        char record[640] = {};
        DWORD used = 0;
        bool valid = true;
        const auto literal = [&](const char *text) {
            while (*text != '\0')
            {
                if (used == sizeof(record)) { valid = false; return; }
                record[used++] = *text++;
            }
        };
        const auto number = [&](ULONGLONG value) {
            char reverse[24] = {};
            DWORD digits = 0;
            do { reverse[digits++] = char('0' + value % 10); value /= 10; } while (value != 0);
            while (digits != 0)
            {
                if (used == sizeof(record)) { valid = false; return; }
                record[used++] = reverse[--digits];
            }
        };
        literal("{\"schemaVersion\":1,\"event\":\"");
        for (const char *c = event; *c != '\0'; ++c)
        {
            if (!((*c >= 'a' && *c <= 'z') || (*c >= '0' && *c <= '9') || *c == '-'))
            { valid = false; break; }
            if (used == sizeof(record)) { valid = false; break; }
            record[used++] = *c;
        }
        literal("\",\"pid\":"); number(GetCurrentProcessId());
        literal(",\"creationTime100ns\":\""); number(creation);
        literal("\",\"threadId\":"); number(GetCurrentThreadId());
        literal(",\"qpc\":\""); number(ULONGLONG(qpc.QuadPart));
        literal("\",\"statusCode\":\"0x");
        constexpr char hex[] = "0123456789ABCDEF";
        for (int shift = 28; shift >= 0; shift -= 4)
        {
            if (used == sizeof(record)) { valid = false; break; }
            record[used++] = hex[(DWORD(status) >> shift) & 15];
        }
        literal("\",\"count\":"); number(count); literal("}\n");
        DWORD written = 0;
        const bool result = valid && WriteFile(file, record, used, &written, nullptr) &&
            written == used && FlushFileBuffers(file);
        CloseHandle(file);
        return result;
    }
}
