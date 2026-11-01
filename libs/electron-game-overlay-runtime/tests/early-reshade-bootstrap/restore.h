#pragma once
#include <windows.h>
#include <cstdint>

// Private isolated proof ABI. Fixed layout and opaque mapped-module identity;
// no private ReShade/C++ layout or allocator ownership crosses this boundary.
struct EarlyReShadeRestoreStateV1
{
    std::uint32_t struct_size;
    std::uint32_t abi_version;
    std::uint32_t process_id;
    std::uint32_t thread_id;
    std::uint64_t creation_time_100ns;
    std::uint32_t restored_imports;
    std::uint32_t owned_host_present;
    std::uintptr_t reshade_module;
};
using EarlyReShadeRestoreQueryV1Fn = BOOL(WINAPI *)(EarlyReShadeRestoreStateV1 *);
