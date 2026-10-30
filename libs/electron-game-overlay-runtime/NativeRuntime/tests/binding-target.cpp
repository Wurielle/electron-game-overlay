#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>

int wmain()
{
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user))
        return static_cast<int>(GetLastError());
    const unsigned long long stamp =
        (static_cast<unsigned long long>(created.dwHighDateTime) << 32) |
        created.dwLowDateTime;
    std::printf("READY %lu %llu\n", GetCurrentProcessId(), stamp);
    std::fflush(stdout);
    // The parent owns stdin and requests normal shutdown by closing it.
    while (std::getchar() != EOF) {}
    return 0;
}
